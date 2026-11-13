package vinted

import "vintrack-vinted/internal/session"

// CheckoutTransport is the HTTP surface a checkout client uses.
type CheckoutTransport = vintedHTTPClient

// NewClientWithTransport builds a client on a supplied transport. Handler
// tests use it with a synthetic transport so that the checkout chain runs
// without any network access; production code uses NewCheckoutClient.
func NewClientWithTransport(sess *session.VintedSession, transport CheckoutTransport) (*Client, error) {
	client, err := newClient(sess, nil)
	if err != nil {
		return nil, err
	}
	client.httpClient = transport
	return client, nil
}
