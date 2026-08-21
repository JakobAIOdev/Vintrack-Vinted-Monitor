package scraper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"vintrack-worker/internal/model"

	http "github.com/bogdanfinn/fhttp"
)

const (
	defaultPriceWatchHTMLLimit = 3 * 1024 * 1024
	priceWatchRollingBytes     = 128 * 1024
	priceWatchFlightAfterBytes = 96 * 1024
	priceWatchJSONLDMaxBytes   = 128 * 1024
)

var vintedItemPathPattern = regexp.MustCompile(`^/items/(\d+)(?:-[^/]*)?/?$`)

var (
	flightPricePattern = regexp.MustCompile(`(?s)\\"price\\":\{\\"amount\\":\\"([0-9]+(?:\.[0-9]+)?)\\",\\"currency_code\\":\\"([A-Za-z]{3})\\"`)
	flightTitlePattern = regexp.MustCompile(`\\"title\\":\\"((?:\\\\.|[^"\\])*)\\"`)
	flightImagePattern = regexp.MustCompile(`(?s)\\"photos\\":\[\{.{0,1000}?\\"url\\":\\"((?:\\\\.|[^"\\])*)\\"`)
)

type PriceWatchPage struct {
	Title        string
	ImageURL     string
	CanonicalURL string
	PriceMinor   int64
	CurrencyCode string
	Available    bool
}

type PriceWatchFetchError struct {
	Code       string
	StatusCode int
	RetryAfter time.Duration
	Detail     string
}

func (e *PriceWatchFetchError) Error() string {
	if e == nil {
		return ""
	}
	if e.Detail != "" {
		return e.Detail
	}
	return e.Code
}

func fetchPriceWatchPage(ctx context.Context, client *Client, target model.PriceWatchTarget) (PriceWatchPage, error) {
	if client == nil {
		return PriceWatchPage{}, &PriceWatchFetchError{Code: "client_unavailable", Detail: "price watch client is unavailable"}
	}
	expectedHost := model.RegionDomain(target.Region)
	currentURL := target.CanonicalURL
	for redirects := 0; redirects < 3; redirects++ {
		if err := validatePriceWatchURL(currentURL, expectedHost, target.ItemID); err != nil {
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "invalid_item_url", Detail: err.Error()}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, currentURL, nil)
		if err != nil {
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "invalid_item_url", Detail: "create item page request"}
		}
		req.Header = newWarmupHeaders(expectedHost)
		req.Header.Set("Referer", fmt.Sprintf("https://%s/", expectedHost))

		resp, err := client.HttpClient.Do(req)
		if err != nil {
			client.FlushTrackedTraffic()
			code := "network_error"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				code = "network_timeout"
			}
			return PriceWatchPage{}, &PriceWatchFetchError{Code: code, Detail: "item page request failed"}
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
			resp.Body.Close()
			client.FlushTrackedTraffic()
			if location == "" {
				return PriceWatchPage{}, &PriceWatchFetchError{Code: "invalid_redirect", StatusCode: resp.StatusCode, Detail: "item page redirect is missing a location"}
			}
			nextURL, err := resolveRedirectURL(currentURL, location)
			if err != nil {
				return PriceWatchPage{}, &PriceWatchFetchError{Code: "invalid_redirect", Detail: "item page redirect is invalid"}
			}
			currentURL = nextURL
			continue
		}

		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
			resp.Body.Close()
			client.FlushTrackedTraffic()
			return PriceWatchPage{CanonicalURL: currentURL, Available: false}, nil
		}
		if resp.StatusCode != http.StatusOK {
			status := resp.StatusCode
			retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
			resp.Body.Close()
			client.FlushTrackedTraffic()
			code := "http_error"
			switch {
			case status == http.StatusTooManyRequests:
				code = "rate_limited"
			case status == http.StatusUnauthorized:
				code = "authentication_required"
			case status == http.StatusForbidden:
				code = "access_denied"
			case status >= 500:
				code = "upstream_5xx"
			}
			return PriceWatchPage{}, &PriceWatchFetchError{Code: code, StatusCode: status, RetryAfter: retryAfter, Detail: fmt.Sprintf("item page returned %d", status)}
		}

		limit := int64(getEnvInt("PRICE_WATCH_HTML_LIMIT_BYTES", defaultPriceWatchHTMLLimit))
		if limit < 256*1024 {
			limit = 256 * 1024
		}
		if limit > 8*1024*1024 {
			limit = 8 * 1024 * 1024
		}
		page, parseErr := parsePriceWatchHTML(io.LimitReader(resp.Body, limit+1), target.ItemID, limit)
		resp.Body.Close()
		client.FlushTrackedTraffic()
		if parseErr != nil {
			return PriceWatchPage{}, parseErr
		}
		page.CanonicalURL = currentURL
		return page, nil
	}
	return PriceWatchPage{}, &PriceWatchFetchError{Code: "too_many_redirects", Detail: "item page redirected too many times"}
}

func validatePriceWatchURL(rawURL string, expectedHost string, expectedItemID int64) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), expectedHost) {
		return errors.New("item URL does not match the configured Vinted region")
	}
	match := vintedItemPathPattern.FindStringSubmatch(parsed.EscapedPath())
	if len(match) != 2 {
		return errors.New("item URL path is invalid")
	}
	itemID, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || itemID != expectedItemID {
		return errors.New("item URL ID does not match the price watch target")
	}
	return nil
}

func parsePriceWatchHTML(reader io.Reader, expectedItemID int64, maximumBytes int64) (PriceWatchPage, error) {
	if maximumBytes <= 0 {
		maximumBytes = defaultPriceWatchHTMLLimit
	}
	buffer := make([]byte, 32*1024)
	rolling := make([]byte, 0, priceWatchRollingBytes)
	var flightCapture []byte
	flightAfter := 0
	var total int64
	internalNotFound := false

	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			total += int64(n)
			chunk := buffer[:n]
			rolling = appendRolling(rolling, chunk, priceWatchRollingBytes)
			if bytes.Contains(rolling, []byte("<title>404:")) {
				internalNotFound = true
			}
			if page, ok := parseProductJSONLD(rolling, expectedItemID); ok {
				return page, nil
			}

			if flightCapture == nil && bytes.Contains(rolling, []byte("currency_code")) {
				flightCapture = append([]byte(nil), rolling...)
				flightAfter = 0
			} else if flightCapture != nil {
				flightCapture = append(flightCapture, chunk...)
				flightAfter += len(chunk)
			}
			if flightCapture != nil {
				if page, ok := parseNextFlightItem(flightCapture, expectedItemID); ok {
					return page, nil
				}
				if flightAfter >= priceWatchFlightAfterBytes {
					return PriceWatchPage{}, &PriceWatchFetchError{Code: "item_schema_invalid", Detail: "item price data did not match the expected item"}
				}
			}
			if total > maximumBytes {
				return PriceWatchPage{}, &PriceWatchFetchError{Code: "response_too_large", Detail: "item page exceeded the configured scan limit"}
			}
		}

		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return PriceWatchPage{}, &PriceWatchFetchError{Code: "response_read_error", Detail: "item page response could not be read"}
		}
	}

	if flightCapture != nil {
		if page, ok := parseNextFlightItem(flightCapture, expectedItemID); ok {
			return page, nil
		}
	}
	if internalNotFound {
		return PriceWatchPage{Available: false}, nil
	}
	return PriceWatchPage{}, &PriceWatchFetchError{Code: "item_schema_missing", Detail: "item page did not contain supported price data"}
}

func appendRolling(existing []byte, incoming []byte, maximum int) []byte {
	if len(incoming) >= maximum {
		return append(existing[:0], incoming[len(incoming)-maximum:]...)
	}
	if extra := len(existing) + len(incoming) - maximum; extra > 0 {
		copy(existing, existing[extra:])
		existing = existing[:len(existing)-extra]
	}
	return append(existing, incoming...)
}

func parseProductJSONLD(window []byte, expectedItemID int64) (PriceWatchPage, bool) {
	marker := []byte("application/ld+json")
	markerIndex := bytes.LastIndex(window, marker)
	if markerIndex < 0 {
		return PriceWatchPage{}, false
	}
	startRelative := bytes.IndexByte(window[markerIndex:], '>')
	if startRelative < 0 {
		return PriceWatchPage{}, false
	}
	start := markerIndex + startRelative + 1
	endRelative := bytes.Index(window[start:], []byte("</script>"))
	if endRelative < 0 || endRelative > priceWatchJSONLDMaxBytes {
		return PriceWatchPage{}, false
	}

	var value any
	decoder := json.NewDecoder(bytes.NewReader(window[start : start+endRelative]))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return PriceWatchPage{}, false
	}
	product := findProductJSONLD(value)
	if product == nil {
		return PriceWatchPage{}, false
	}
	offers, _ := product["offers"].(map[string]any)
	if offers == nil {
		return PriceWatchPage{}, false
	}
	rawURL, _ := offers["url"].(string)
	if rawURL != "" && !strings.Contains(rawURL, fmt.Sprintf("/items/%d", expectedItemID)) {
		return PriceWatchPage{}, false
	}
	priceMinor, ok := priceValueToMinor(offers["price"])
	if !ok {
		return PriceWatchPage{}, false
	}
	currency, _ := offers["priceCurrency"].(string)
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if len(currency) != 3 {
		return PriceWatchPage{}, false
	}
	availability, _ := offers["availability"].(string)
	available := availability == "" || strings.HasSuffix(strings.ToLower(availability), "instock")
	title, _ := product["name"].(string)
	return PriceWatchPage{
		Title:        strings.TrimSpace(title),
		ImageURL:     firstJSONLDImage(product["image"]),
		CanonicalURL: rawURL,
		PriceMinor:   priceMinor,
		CurrencyCode: currency,
		Available:    available,
	}, true
}

func findProductJSONLD(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		if kind, _ := typed["@type"].(string); strings.EqualFold(kind, "Product") {
			return typed
		}
		for _, child := range typed {
			if product := findProductJSONLD(child); product != nil {
				return product
			}
		}
	case []any:
		for _, child := range typed {
			if product := findProductJSONLD(child); product != nil {
				return product
			}
		}
	}
	return nil
}

func firstJSONLDImage(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for _, item := range typed {
			if image, ok := item.(string); ok && strings.TrimSpace(image) != "" {
				return strings.TrimSpace(image)
			}
		}
	}
	return ""
}

func parseNextFlightItem(capture []byte, expectedItemID int64) (PriceWatchPage, bool) {
	itemPrefix := fmt.Sprintf(`\"id\":%d`, expectedItemID)
	searchFrom := 0
	var item []byte
	var priceMatch [][]byte
	for searchFrom < len(capture) {
		relativeIndex := bytes.Index(capture[searchFrom:], []byte(itemPrefix))
		if relativeIndex < 0 {
			break
		}
		itemIndex := searchFrom + relativeIndex
		candidateEnd := itemIndex + 4096
		if candidateEnd > len(capture) {
			candidateEnd = len(capture)
		}
		candidate := capture[itemIndex:candidateEnd]
		candidatePrice := flightPricePattern.FindSubmatch(candidate)
		if len(candidatePrice) == 3 {
			item = capture[itemIndex:]
			priceMatch = candidatePrice
			break
		}
		searchFrom = itemIndex + len(itemPrefix)
	}
	if len(priceMatch) != 3 {
		return PriceWatchPage{}, false
	}
	priceMinor, ok := decimalStringToMinor(string(priceMatch[1]))
	if !ok {
		return PriceWatchPage{}, false
	}
	titleMatch := flightTitlePattern.FindSubmatch(item)
	if len(titleMatch) != 2 {
		return PriceWatchPage{}, false
	}
	imageMatch := flightImagePattern.FindSubmatch(item)

	title := decodeFlightString(string(titleMatch[1]))
	imageURL := ""
	if len(imageMatch) == 2 {
		imageURL = decodeFlightString(string(imageMatch[1]))
	}
	available := true
	statusPattern := regexp.MustCompile(fmt.Sprintf(`(?s)\\"item_id\\":%d.{0,1000}?\\"can_buy\\":(true|false).{0,256}?\\"is_closed\\":(true|false)`, expectedItemID))
	for _, status := range statusPattern.FindAllSubmatch(capture, -1) {
		if len(status) == 3 && (string(status[1]) == "false" || string(status[2]) == "true") {
			available = false
		}
	}

	return PriceWatchPage{
		Title:        title,
		ImageURL:     imageURL,
		PriceMinor:   priceMinor,
		CurrencyCode: strings.ToUpper(string(priceMatch[2])),
		Available:    available,
	}, true
}

func decodeFlightString(value string) string {
	decoded := value
	for range 3 {
		next, err := strconv.Unquote(`"` + decoded + `"`)
		if err != nil || next == decoded {
			break
		}
		decoded = next
	}
	decoded = strings.ReplaceAll(decoded, `\/`, `/`)
	return strings.TrimSpace(decoded)
}

func priceValueToMinor(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		return decimalStringToMinor(typed.String())
	case float64:
		return decimalStringToMinor(strconv.FormatFloat(typed, 'f', -1, 64))
	case string:
		return decimalStringToMinor(typed)
	default:
		return 0, false
	}
}

func decimalStringToMinor(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) > 2 || len(parts) == 0 || parts[0] == "" {
		return 0, false
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole < 0 || whole > (1<<63-1)/100 {
		return 0, false
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	for len(fraction) > 2 && strings.HasSuffix(fraction, "0") {
		fraction = strings.TrimSuffix(fraction, "0")
	}
	if len(fraction) > 2 {
		return 0, false
	}
	fraction += strings.Repeat("0", 2-len(fraction))
	cents := int64(0)
	if fraction != "" {
		cents, err = strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			return 0, false
		}
	}
	return whole*100 + cents, true
}

func parseRetryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if parsed, err := http.ParseTime(value); err == nil {
		if delay := time.Until(parsed); delay > 0 {
			return delay
		}
	}
	return 0
}
