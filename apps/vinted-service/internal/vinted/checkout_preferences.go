package vinted

import (
	"fmt"
	"regexp"
	"strings"
)

// These are account-level choices, not payment credentials. Wallet funds are
// applied by Vinted itself; we never initiate a payment or save a payment method.
type CheckoutPreferences struct {
	Shipping     string                  `json:"shipping"`
	Payment      string                  `json:"payment"`
	AutoCheckout *AutoCheckoutPreference `json:"autoCheckout,omitempty"`
}

type AutoCheckoutPreference struct {
	WarningVersion int    `json:"warningVersion"`
	MaxTotalMinor  int64  `json:"maxTotalMinor"`
	Currency       string `json:"currency"`
}

func (p CheckoutPreferences) Valid() bool {
	if p.AutoCheckout != nil && (p.Payment != "paypal" || p.AutoCheckout.WarningVersion != 1 || p.AutoCheckout.Currency != "EUR" || p.AutoCheckout.MaxTotalMinor <= 0 || p.AutoCheckout.MaxTotalMinor > 1_000_000) {
		return false
	}
	switch p.Payment {
	case "", "wallet", "vinted", "paypal", "card", "google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24":
		return p.Shipping == "" || p.Shipping == "home" || p.Shipping == "vinted"
	default:
		return false
	}
}

func (p CheckoutPreferences) Key() string {
	key := p.Shipping + ":" + p.Payment
	if p.AutoCheckout != nil {
		key += fmt.Sprintf(":auto:%d:%s:%d", p.AutoCheckout.WarningVersion, p.AutoCheckout.Currency, p.AutoCheckout.MaxTotalMinor)
	}
	return key
}

func autoCheckoutRegion(domain string) bool {
	return domain == "www.vinted.de" || domain == "www.vinted.at" || domain == "www.vinted.be"
}

func checkoutComponents(p CheckoutPreferences, payment map[string]interface{}) map[string]interface{} {
	components := map[string]interface{}{
		"additional_service":      map[string]interface{}{},
		"payment_method":          map[string]interface{}{},
		"shipping_address":        map[string]interface{}{},
		"shipping_pickup_options": map[string]interface{}{},
		"shipping_pickup_details": map[string]interface{}{},
	}
	// Observed in the native DE checkout: home delivery is pickup_type 1.
	// Keeping details empty lets Vinted choose a supported home-delivery rate.
	if p.Shipping == "home" {
		components["shipping_pickup_options"] = map[string]interface{}{"pickup_type": 1}
	}
	if payment != nil {
		components["payment_method"] = payment
	}
	return components
}

type checkoutSelection struct {
	PaymentSelected     bool
	HomeSelected        bool
	AddressSelected     bool
	RateSelected        bool
	PaymentsAvailable   bool
	Methods             map[string]map[string]interface{}
	SelectedPreference  string
	AutoTotalMinor      int64
	AutoAmountsVerified bool
}

var checkoutMethodCode = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)

// Read the provider value from Vinted's own offer rather than guessing method
// IDs shared across regions. Only PayPal has a verified legacy-code fallback.
func checkoutProvider(method map[string]interface{}) string {
	value, _ := method["payment_method"].(string)
	value = strings.ToLower(value)
	switch value {
	case "paypal", "card", "google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24":
		return value
	}
	code, _ := method["code"].(string)
	tokens := "_" + strings.ToUpper(code) + "_"
	for _, provider := range []string{"paypal", "google_pay", "klarna", "tink", "bancontact", "ideal", "blik", "przelewy24"} {
		if strings.Contains(tokens, "_"+strings.ToUpper(provider)+"_") {
			return provider
		}
	}
	if strings.Contains(tokens, "_WERO_") {
		return "ideal"
	}
	if strings.Contains(tokens, "_CARD_") {
		return "card"
	}
	return ""
}

func checkoutMap(raw map[string]interface{}, keys ...string) map[string]interface{} {
	for _, key := range keys {
		next, ok := raw[key].(map[string]interface{})
		if !ok {
			return nil
		}
		raw = next
	}
	return raw
}

func readCheckoutSelection(raw map[string]interface{}) checkoutSelection {
	components := checkoutMap(raw, "checkout", "components")
	payment := checkoutMap(components, "payment_method")
	selection := checkoutSelection{
		Methods:            make(map[string]map[string]interface{}),
		SelectedPreference: checkoutProvider(checkoutMap(payment, "selected_payment_method", "pay_in_method")),
		PaymentSelected:    checkoutMap(payment, "selected_payment_method") != nil,
		HomeSelected:       firstInt64Path(components, []string{"shipping_pickup_options", "selected_pickup_option"}) == 1,
		AddressSelected:    checkoutMap(components, "shipping_address", "address") != nil,
		RateSelected:       firstStringPath(components, []string{"shipping_pickup_details", "pickup_details", "selected_rate_uuid"}) != "",
	}
	selection.PaymentsAvailable, _ = checkoutMap(components, "pay_button_v2")["payments_available"].(bool)
	methods, _ := payment["pay_in_methods"].([]interface{})
	choices := make(map[string][]map[string]interface{})
	for _, method := range methods {
		m, _ := method.(map[string]interface{})
		provider := checkoutProvider(m)
		native, _ := m["payment_method"].(string)
		if native == "" && m["code"] == "MANGOPAY_PAYPAL" {
			native = "paypal"
		}
		readOnly, _ := m["read_only"].(bool)
		disabled := m["enabled"] == false
		if provider == "" || !checkoutMethodCode.MatchString(native) || readOnly || disabled {
			continue
		}
		choice := map[string]interface{}{"card_id": nil, "payment_method": native}
		if provider == "card" {
			selected := checkoutMap(payment, "selected_payment_method")
			cardID := firstInt64Path(selected, []string{"card_id"}, []string{"card", "id"})
			cards, _ := payment["cards"].([]interface{})
			if cardID <= 0 && len(cards) == 1 {
				card, _ := cards[0].(map[string]interface{})
				cardID = firstInt64Path(card, []string{"id"})
			}
			if cardID <= 0 {
				continue
			}
			choice["card_id"] = cardID
		}
		choices[provider] = append(choices[provider], choice)
	}
	selectedNative := firstStringPath(payment, []string{"selected_payment_method", "pay_in_method", "payment_method"})
	for provider, options := range choices {
		if len(options) == 1 {
			selection.Methods[provider] = options[0]
			continue
		}
		for _, option := range options {
			if option["payment_method"] == selectedNative {
				selection.Methods[provider] = option
				break
			}
		}
	}
	if selection.SelectedPreference == "card" && firstInt64Path(checkoutMap(payment, "selected_payment_method"), []string{"card_id"}, []string{"card", "id"}) <= 0 {
		selection.SelectedPreference = ""
	}
	selection.AutoTotalMinor, selection.AutoAmountsVerified = autoCheckoutTotal(components)
	return selection
}

func (s checkoutSelection) Ready() bool {
	// The observed response does not prove that a pickup point was selected.
	// Only advertise readiness for the verified home-delivery path.
	return s.PaymentSelected && s.HomeSelected && s.AddressSelected && s.RateSelected && s.PaymentsAvailable
}
