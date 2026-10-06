package vinted

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	http "github.com/bogdanfinn/fhttp"
)

var checkoutDecimal = regexp.MustCompile(`^[0-9]{1,7}(\.[0-9]{1,2})?$`)

func checkoutMoneyMinor(raw map[string]interface{}) (int64, bool) {
	if raw["currency_code"] != "EUR" {
		return 0, false
	}
	var amount string
	switch v := raw["amount"].(type) {
	case string:
		amount = v
	case float64:
		amount = strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return 0, false
	}
	if !checkoutDecimal.MatchString(amount) {
		return 0, false
	}
	parts := strings.SplitN(amount, ".", 2)
	whole, _ := strconv.ParseInt(parts[0], 10, 64)
	fraction := int64(0)
	if len(parts) == 2 {
		fraction, _ = strconv.ParseInt((parts[1] + "00")[:2], 10, 64)
	}
	return whole*100 + fraction, true
}

// Exact fields consumed by Vinted's web checkout. Unknown pricing, currency
// conversion or wallet deductions require manual review, never a payment POST.
func autoCheckoutTotal(components map[string]interface{}) (int64, bool) {
	summary := checkoutMap(components, "order_summary_v2")
	if summary == nil || summary["currency_conversion"] != nil {
		return 0, false
	}
	deductions, ok := summary["deductions"].([]interface{})
	if !ok {
		return 0, false
	}
	for _, raw := range deductions {
		deduction, ok := raw.(map[string]interface{})
		if !ok || deduction["type"] != "order-summary-wallet-deduction" {
			return 0, false
		}
		amount, valid := checkoutMoneyMinor(checkoutMap(deduction, "price"))
		if !valid || amount != 0 {
			return 0, false
		}
	}
	total, valid := checkoutMoneyMinor(checkoutMap(components, "pay_button_v2", "total", "price"))
	return total, valid && total > 0
}

func validPayPalPaymentURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || (u.Host != "www.paypal.com" && u.Host != "paypal.com") || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Path == "/checkoutnow" || u.Path == "/webscr" || u.Path == "/cgi-bin/webscr"
}

// No refresh/retry, raw-response logs, persistent redirect tokens or payment
// polling. Card authentication stays in Vinted; external card URLs are not used.
type checkoutPaymentOutcome struct {
	Status, Reason, PaymentURL string
}

func readCardPaymentOutcome(raw map[string]interface{}) (checkoutPaymentOutcome, error) {
	if raw["errors"] != nil || raw["error"] != nil {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	action := firstStringPath(raw, []string{"action", "type"})
	if raw["action"] != nil && action == "" {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	if action != "" {
		switch action {
		case "sca_required", "sca_challenge", "sca_blocked", "payrails_cvv_resubmission", "native_adyen_card_3ds", "native_adyen_payment_3ds", "redirect":
			return checkoutPaymentOutcome{Status: "card_authentication_required", Reason: "Continue in Vinted to review or complete card authentication. A payment was already started; do not pay again."}, nil
		default:
			return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
		}
	}
	switch firstStringPath(raw, []string{"payment", "status"}) {
	case "success":
		return checkoutPaymentOutcome{Status: "card_payment_confirmed", Reason: "Vinted reports that the card payment succeeded. Check the order in Vinted; do not pay again."}, nil
	case "pending", "preparing":
		return checkoutPaymentOutcome{Status: "card_payment_pending", Reason: "The card payment is processing. Check its status in Vinted; do not pay again."}, nil
	case "failure":
		return checkoutPaymentOutcome{Status: "card_payment_failed", Reason: "Vinted reports a failed card payment. Review it in Vinted; no automatic retry will run."}, nil
	default:
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
}

func (c *Client) startCheckoutPayment(payment, purchaseID string, transactionID int64, checksum string) (checkoutPaymentOutcome, error) {
	payload := map[string]interface{}{"checksum": checksum, "payment_options": map[string]interface{}{"browser_info": defaultBrowserInfo(BrowserInfo{})}}
	body, _ := json.Marshal(payload)
	endpoint := fmt.Sprintf("https://%s/api/v2/purchases/%s/checkout/payment", c.session.Domain, url.PathEscape(purchaseID))
	req, err := http.NewRequest("POST", endpoint, strings.NewReader(string(body)))
	if err != nil {
		return checkoutPaymentOutcome{}, fmt.Errorf("could not create payment request")
	}
	req.Header = c.apiHeadersWithBody()
	req.Header.Set("Referer", fmt.Sprintf("https://%s/checkout?purchase_id=%s&order_id=%d&order_type=transaction", c.session.Domain, url.QueryEscape(purchaseID), transactionID))
	wasFollowing := c.httpClient.GetFollowRedirect()
	c.httpClient.SetFollowRedirect(false)
	defer c.httpClient.SetFollowRedirect(wasFollowing)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome is unknown")
	}
	defer resp.Body.Close()
	log.Printf("[vinted] checkout payment start -> %d", resp.StatusCode)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	data, err := readCheckoutResponse(resp.Body)
	if err != nil {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	var raw map[string]interface{}
	if json.Unmarshal(data, &raw) != nil {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	if payment == "card" {
		return readCardPaymentOutcome(raw)
	}
	if firstStringPath(raw, []string{"action", "type"}) != "redirect" {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	redirect := firstStringPath(raw, []string{"action", "parameters", "url"})
	if !validPayPalPaymentURL(redirect) {
		return checkoutPaymentOutcome{}, fmt.Errorf("payment outcome needs review")
	}
	return checkoutPaymentOutcome{Status: "paypal_redirect_ready", Reason: "Continue in PayPal to complete the payment.", PaymentURL: redirect}, nil
}
