package vinted

import (
	"encoding/json"
	"io"
	"testing"

	"vintrack-vinted/internal/session"
)

func TestBuyConversationUsesObservedNumericTargetShape(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 200, body: `{"conversation":{"transaction":{"id":77}}}`})
	id, err := client.createBuyTransaction(12345678901, 456)
	if err != nil || id != 77 || len(transport.requests) != 1 {
		t.Fatalf("unexpected transaction result: %v", err)
	}
	req := transport.requests[0]
	if req.Method != "POST" || req.URL.Path != "/api/v2/conversations" {
		t.Fatal("wrong conversation endpoint")
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["initiator"] != "buy" || payload["item_id"] != float64(12345678901) || payload["opposite_user_id"] != float64(456) || len(payload) != 3 {
		t.Fatal("conversation request did not use numeric target IDs")
	}
}

func TestBuyConversationAcceptsOnlyExplicitSafeTransactionIDs(t *testing.T) {
	for _, tc := range []struct {
		body string
		want int64
	}{
		{`{"conversation":{"id":999,"transaction":{"id":77}}}`, 77},
		{`{"transaction":{"id":77}}`, 77},
		{`{"transaction":{"id":"77"}}`, 77},
		{`{"transaction":{"id":9007199254740991}}`, maxCheckoutSafeID},
		{`{"id":77}`, 0},
		{`{"conversation":{"id":77}}`, 0},
		{`{"nested":{"transaction":{"id":77}}}`, 0},
		{`{"conversation":{"transaction":{"id":0}}}`, 0},
		{`{"transaction":{"id":-1}}`, 0},
		{`{"transaction":{"id":77.5}}`, 0},
		{`{"transaction":{"id":9007199254740992}}`, 0},
		{`{"transaction":{"id":"9007199254740992"}}`, 0},
		{`{"transaction":{"id":"not-an-id"}}`, 0},
		{`{"transaction":{"id":"077"}}`, 0},
		{`{"transaction":{"id":"+77"}}`, 0},
		{`{"transaction":{"id":true}}`, 0},
		{`{"transaction":{"id":null}}`, 0},
		{`{"transaction":{"id":9223372036854775808}}`, 0},
		{`{"conversation":{"transaction":{"id":-1}},"transaction":{"id":77}}`, 0},
		{`<html>invalid</html>`, 0},
	} {
		t.Run(tc.body, func(t *testing.T) {
			client, transport := testClient(fakeHTTPResult{status: 200, body: tc.body})
			id, err := client.createBuyTransaction(123, 456)
			if tc.want > 0 {
				if err != nil || id != tc.want {
					t.Fatalf("explicit transaction not accepted: %v", err)
				}
			} else if err == nil || id != 0 {
				t.Fatal("invalid transaction ID accepted")
			}
			if len(transport.requests) != 1 {
				t.Fatal("unexpected extra request")
			}
		})
	}
}

func TestPrepareCheckoutNeverBuildsWithoutVerifiedTransactionID(t *testing.T) {
	for _, body := range []string{`{"conversation":{"id":77}}`, `{"transaction":{"id":77.5}}`, `{"conversation":{"transaction":{"id":9007199254740992}}}`} {
		client, transport := testClient(fakeHTTPResult{status: 200, body: body})
		var checkpoints []string
		_, err := client.PrepareCheckout(123, 456, func(link session.CheckoutLink) error { checkpoints = append(checkpoints, link.Status); return nil }, CheckoutPreferences{Shipping: "home", Payment: "paypal"})
		if err == nil || len(transport.requests) != 1 || len(checkpoints) != 1 || checkpoints[0] != "transaction_creating" {
			t.Fatal("checkout advanced without a verified transaction")
		}
	}
}

func TestBuyConversationRejectsUnsafeRequestIDsBeforeNetwork(t *testing.T) {
	for _, ids := range [][2]int64{{0, 456}, {123, -1}, {maxCheckoutSafeID + 1, 456}, {123, maxCheckoutSafeID + 1}} {
		client, transport := testClient()
		if _, err := client.createBuyTransaction(ids[0], ids[1]); err == nil || len(transport.requests) != 0 {
			t.Fatal("invalid target reached conversation endpoint")
		}
	}
}
