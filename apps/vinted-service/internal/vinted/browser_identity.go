package vinted

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/tls-client/profiles"
)

var chromiumVersion = regexp.MustCompile(`(?:Chrome|Chromium)/([0-9]{2,3})\.`)

func chromiumMajor(userAgent string) int {
	match := chromiumVersion.FindStringSubmatch(userAgent)
	if len(match) != 2 {
		return 0
	}
	major, _ := strconv.Atoi(match[1])
	return major
}

// Select from the captured profiles supported by the pinned transport library.
// A newer browser uses the nearest supported milestone; this is deterministic
// session compatibility, with no request-time profile rotation or retry.
func profileForUserAgent(userAgent string) profiles.ClientProfile {
	for major := chromiumMajor(userAgent); major >= 100; major-- {
		if profile, ok := profiles.MappedTLSClients[fmt.Sprintf("chrome_%d", major)]; ok {
			return profile
		}
	}
	return profiles.Chrome_152
}

// Client hints must describe the same browser as the User-Agent. Chromium
// sends them; other browsers send none, so none are invented for them.
func (c *Client) setClientHints(h http.Header) {
	agent := c.userAgent()
	if chromiumMajor(agent) == 0 {
		return
	}
	h.Set("Sec-Ch-Ua", c.clientHintBrands())
	h.Set("Sec-Ch-Ua-Mobile", mobileHintForUserAgent(agent))
	h.Set("Sec-Ch-Ua-Platform", `"`+platformForUserAgent(agent)+`"`)
}

func platformForUserAgent(userAgent string) string {
	switch {
	case strings.Contains(userAgent, "Android"):
		return "Android"
	case strings.Contains(userAgent, "CrOS"):
		return "Chrome OS"
	case strings.Contains(userAgent, "Windows"):
		return "Windows"
	case strings.Contains(userAgent, "Macintosh"), strings.Contains(userAgent, "Mac OS X"):
		return "macOS"
	case strings.Contains(userAgent, "Linux"), strings.Contains(userAgent, "X11"):
		return "Linux"
	default:
		return "macOS"
	}
}

func mobileHintForUserAgent(userAgent string) string {
	if strings.Contains(userAgent, "Android") && strings.Contains(userAgent, "Mobile") {
		return "?1"
	}
	return "?0"
}

func (c *Client) clientHintBrands() string {
	major := chromiumMajor(c.userAgent())
	if major == 0 {
		return defaultSecChUA
	}
	return fmt.Sprintf(`"Google Chrome";v="%d", "Chromium";v="%d", "Not_A Brand";v="99"`, major, major)
}
