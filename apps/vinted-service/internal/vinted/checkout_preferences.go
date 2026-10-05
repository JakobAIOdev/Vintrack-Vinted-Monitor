package vinted

// These are account-level choices, not payment credentials. Wallet funds are
// applied by Vinted itself; we never initiate a payment or save a payment method.
type CheckoutPreferences struct {
	Shipping string `json:"shipping"`
	Payment  string `json:"payment"`
}

func (p CheckoutPreferences) Valid() bool {
	return (p.Shipping == "" || p.Shipping == "home" || p.Shipping == "vinted") &&
		(p.Payment == "" || p.Payment == "wallet" || p.Payment == "paypal" || p.Payment == "vinted")
}

func (p CheckoutPreferences) Key() string { return p.Shipping + ":" + p.Payment }

func checkoutComponents(p CheckoutPreferences, paypal bool) map[string]interface{} {
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
	if paypal {
		components["payment_method"] = map[string]interface{}{"card_id": nil, "payment_method": "paypal"}
	}
	return components
}

type checkoutSelection struct {
	PayPalAvailable   bool
	PayPalSelected    bool
	PaymentSelected   bool
	HomeSelected      bool
	AddressSelected   bool
	RateSelected      bool
	PaymentsAvailable bool
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
		PayPalSelected:  firstStringPath(components, []string{"payment_method", "selected_payment_method", "pay_in_method", "payment_method"}) == "paypal",
		PaymentSelected: checkoutMap(payment, "selected_payment_method") != nil,
		HomeSelected:    firstInt64Path(components, []string{"shipping_pickup_options", "selected_pickup_option"}) == 1,
		AddressSelected: checkoutMap(components, "shipping_address", "address") != nil,
		RateSelected:    firstStringPath(components, []string{"shipping_pickup_details", "pickup_details", "selected_rate_uuid"}) != "",
	}
	selection.PaymentsAvailable, _ = checkoutMap(components, "pay_button_v2")["payments_available"].(bool)
	methods, _ := payment["pay_in_methods"].([]interface{})
	for _, method := range methods {
		m, _ := method.(map[string]interface{})
		if m["code"] == "MANGOPAY_PAYPAL" {
			selection.PayPalAvailable = true
		}
	}
	return selection
}

func (s checkoutSelection) Ready() bool {
	// The observed response does not prove that a pickup point was selected.
	// Only advertise readiness for the verified home-delivery path.
	return s.PaymentSelected && s.HomeSelected && s.AddressSelected && s.RateSelected && s.PaymentsAvailable
}
