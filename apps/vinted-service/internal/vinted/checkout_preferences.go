package vinted

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// These are account-level choices, not payment credentials. Vinted applies
// wallet funds; payment starts only with a separate validated auto-checkout opt-in.
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
	warningVersion := 1
	if p.Payment == "card" {
		warningVersion = 2
	}
	if p.AutoCheckout != nil && ((p.Payment != "paypal" && p.Payment != "card") || p.AutoCheckout.WarningVersion != warningVersion || p.AutoCheckout.Currency != "EUR" || p.AutoCheckout.MaxTotalMinor <= 0 || p.AutoCheckout.MaxTotalMinor > 1_000_000) {
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

var checkoutDomainPattern = regexp.MustCompile(`^www\.vinted\.(at|be|co\.uk|com|cz|de|dk|es|fi|fr|hr|hu|ie|it|lt|lu|nl|pl|pt|ro|se|sk)$`)

func AutoCheckoutAllowed(domain, payment string) bool {
	return checkoutDomainPattern.MatchString(domain) && (payment == "card" || (payment == "paypal" && (domain == "www.vinted.de" || domain == "www.vinted.at" || domain == "www.vinted.be")))
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
	AddressVerified     bool
	RateSelected        bool
	PaymentsAvailable   bool
	Methods             map[string]map[string]interface{}
	SelectedPreference  string
	SelectedNative      string
	AutoTotalMinor      int64
	AutoAmountsVerified bool
	CardVerified        bool
	CardSignalsRequired bool
}

var checkoutMethodCode = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)

// Read the provider value from Vinted's own offer rather than guessing method
// IDs shared across regions. Only PayPal has a verified legacy-code fallback.
func checkoutProvider(method map[string]interface{}) string {
	value, _ := method["payment_method"].(string)
	value = strings.ToLower(value)
	if value == "credit_card" {
		return "card"
	}
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

// Card references are Vinted's existing identifiers, never card numbers/CVV.
// Native checkout returns selected_payment_method.credit_card.external_code.
func checkoutCardID(card map[string]interface{}, paths ...[]string) interface{} {
	if card["expired"] == true || checkoutMap(card, "credit_card")["expired"] == true || checkoutMap(card, "card")["expired"] == true {
		return nil
	}
	for _, path := range paths {
		parent := checkoutMap(card, path[:len(path)-1]...)
		switch value := parent[path[len(path)-1]].(type) {
		case string:
			if value != "0" && regexpCardReference.MatchString(value) {
				return value
			}
		case float64:
			if value > 0 && value <= 9007199254740991 && math.Trunc(value) == value {
				return int64(value)
			}
		case int, int64:
			if number := firstInt64Path(parent, []string{path[len(path)-1]}); number > 0 && number <= 9007199254740991 {
				return number
			}
		}
	}
	return nil
}

var regexpCardReference = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)

func selectedCheckoutCardID(payment map[string]interface{}) interface{} {
	return checkoutCardID(checkoutMap(payment, "selected_payment_method"), []string{"card_id"}, []string{"card", "id"}, []string{"credit_card", "external_code"})
}

func readCheckoutSelection(raw map[string]interface{}) checkoutSelection {
	components := checkoutMap(raw, "checkout", "components")
	payment := checkoutMap(components, "payment_method")
	address := checkoutMap(components, "shipping_address", "address")
	addressID, addressOK := int64AtPath(address, "id")
	if numeric, ok := address["id"].(float64); ok && math.Trunc(numeric) != numeric {
		addressOK = false
	}
	home, homeOK := checkoutMap(components, "shipping_pickup_options")["selected_pickup_option"].(float64)
	selection := checkoutSelection{
		Methods:            make(map[string]map[string]interface{}),
		SelectedPreference: checkoutProvider(checkoutMap(payment, "selected_payment_method", "pay_in_method")),
		PaymentSelected:    checkoutMap(payment, "selected_payment_method") != nil,
		HomeSelected:       homeOK && home == 1,
		AddressSelected:    checkoutMap(components, "shipping_address", "address") != nil,
		AddressVerified:    addressOK && addressID > 0 && addressID <= 9007199254740991,
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
			cardID := selectedCheckoutCardID(payment)
			cards, _ := payment["cards"].([]interface{})
			if cardID == nil && len(cards) == 1 && checkoutProvider(checkoutMap(payment, "selected_payment_method", "pay_in_method")) != "card" {
				card, _ := cards[0].(map[string]interface{})
				cardID = checkoutCardID(card, []string{"id"})
			}
			if cardID == nil {
				continue
			}
			for _, rawCard := range cards {
				card, _ := rawCard.(map[string]interface{})
				if card["expired"] == true && fmt.Sprint(card["id"]) == fmt.Sprint(cardID) {
					cardID = nil
					break
				}
			}
			if cardID == nil {
				continue
			}
			choice["card_id"] = cardID
		}
		choices[provider] = append(choices[provider], choice)
	}
	selectedNative := firstStringPath(payment, []string{"selected_payment_method", "pay_in_method", "payment_method"})
	selection.SelectedNative = selectedNative
	if selectedNative == "" && firstStringPath(payment, []string{"selected_payment_method", "pay_in_method", "code"}) == "MANGOPAY_PAYPAL" {
		selection.SelectedNative = "paypal"
	}
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
	if selection.SelectedPreference == "card" && selectedCheckoutCardID(payment) == nil {
		selection.SelectedPreference = ""
	}
	selection.CardVerified = selection.SelectedPreference == "card" && selection.Methods["card"] != nil && fmt.Sprint(selection.Methods["card"]["card_id"]) == fmt.Sprint(selectedCheckoutCardID(payment))
	selection.CardSignalsRequired = checkoutMap(raw, "checkout")["adyen_protect_signals_enabled"] == true || raw["adyen_protect_signals_enabled"] == true
	selection.AutoTotalMinor, selection.AutoAmountsVerified = autoCheckoutTotal(components)
	return selection
}

func (s checkoutSelection) Ready() bool {
	// The observed response does not prove that a pickup point was selected.
	// Only advertise readiness for the verified home-delivery path.
	return s.PaymentSelected && s.HomeSelected && s.AddressSelected && s.RateSelected && s.PaymentsAvailable
}

func (b *checkoutBuildResult) matchesReviewPreferences(p CheckoutPreferences) bool {
	// Reuse only this fresh build for normal review. Automatic payment always
	// obtains its final quote with the existing checkout update.
	if p.AutoCheckout != nil || p.Shipping != "home" || b.Checksum == "" ||
		!b.Selection.Ready() || !b.Selection.AddressVerified || b.Selection.SelectedPreference != p.Payment {
		return false
	}
	choice := b.Selection.Methods[p.Payment]
	return choice != nil && choice["payment_method"] == b.Selection.SelectedNative &&
		(p.Payment != "card" || b.Selection.CardVerified)
}
