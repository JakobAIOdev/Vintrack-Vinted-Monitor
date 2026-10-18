package vinted

import (
	"encoding/base64"
	"errors"
	"strings"

	http "github.com/bogdanfinn/fhttp"
	"testing"
)

func validationToken() string {
	return "synthetic." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"42"}`)) + ".signature"
}

func TestAccountValidationRequiresProtectedAccessBeforeProfile(t *testing.T) {
	for _, status := range []int{401, 403, 429, 500} {
		client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: status, body: `{"message":"synthetic-private-response"}`})
		client.session.AccessToken = validationToken()
		if client.ValidateSession() {
			t.Fatalf("HTTP %d accepted as authenticated", status)
		}
		if len(transport.requests) != 2 || transport.requests[1].URL.Path != "/api/v2/inbox" {
			t.Fatal("profile fallback or retry followed denied protected access")
		}
	}
}

func TestAccountValidationRejectsInvalidProtectedResponses(t *testing.T) {
	for _, body := range []string{`{}`, `{"conversations":null,"pagination":{}}`, `{"conversations":[],"pagination":null}`, `{"conversations":[],"pagination":{},"code":99}`, `<html>challenge</html>`, `{"conversations":[],"pagination":[]}`} {
		client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: body})
		client.session.AccessToken = validationToken()
		if client.ValidateSession() || len(transport.requests) != 2 {
			t.Fatal("malformed protected response accepted or followed by a profile request")
		}
	}
}

func TestAccountValidationAcceptsProtectedAccessAndMatchingProfile(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{"current_page":1}}`}, fakeHTTPResult{status: 200, body: `{"user":{"id":42,"login":"synthetic-buyer"}}`})
	client.session.AccessToken = validationToken()
	info, err := client.GetAccountInfo()
	if err != nil || info.ID != 42 || info.Login != "synthetic-buyer" || len(transport.requests) != 3 {
		t.Fatalf("valid session rejected: %v", err)
	}
}

func TestAccountValidationAcceptsNumericProfileReputation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		body   string
		rating float64
	}{
		{"wrapped decimal", `{"user":{"id":42,"login":"synthetic-buyer","feedback_reputation":0.97}}`, 0.97},
		{"wrapped zero", `{"user":{"id":42,"login":"synthetic-buyer","feedback_reputation":0}}`, 0},
		{"direct decimal", `{"id":42,"login":"synthetic-buyer","feedback_reputation":0.97}`, 0.97},
		{"direct integer", `{"id":42,"login":"synthetic-buyer","feedback_reputation":1}`, 1},
		{"wrapped null", `{"user":{"id":42,"login":"synthetic-buyer","feedback_reputation":null}}`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{}}`}, fakeHTTPResult{status: 200, body: tc.body})
			client.session.AccessToken = validationToken()
			info, err := client.GetAccountInfo()
			if err != nil {
				t.Fatalf("valid numeric profile rejected: %v", err)
			}
			if info.ID != 42 || info.Login != "synthetic-buyer" || info.GivenRating != tc.rating || len(transport.requests) != 3 {
				t.Fatal("unexpected validated profile or request count")
			}
		})
	}
}

func TestAccountValidationDoesNotUseClaimsAfterProfileFailure(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{}}`}, fakeHTTPResult{status: 500})
	client.session.AccessToken = validationToken()
	if client.ValidateSession() || len(transport.requests) != 3 {
		t.Fatal("profile failures became a JWT-only success")
	}
}

func TestAccountValidationRejectsIncompleteOrMismatchedProfiles(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"user":{"id":43,"login":"other"}}`, `{"id":42}`, `{"user":{"id":42,"login":"buyer"},"code":99}`, `{"id":42,"login":"buyer","code":1}`, `<html>denied</html>`} {
		client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{}}`}, fakeHTTPResult{status: 200, body: body})
		client.session.AccessToken = validationToken()
		if client.ValidateSession() || len(transport.requests) != 3 {
			t.Fatal("invalid profile accepted or retried")
		}
	}
}

func TestAccountValidationCurrentRouteFallbackIsBounded(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{"user":{"id":42,"login":"buyer"}}`, true},
		{`{"id":42,"login":"buyer"}`, true},
		{`{"id":43,"login":"other"}`, false},
	} {
		client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{}}`}, fakeHTTPResult{status: 404}, fakeHTTPResult{status: 200, body: tc.body})
		client.session.AccessToken = validationToken()
		if client.ValidateSession() != tc.valid || len(transport.requests) != 4 || transport.requests[3].URL.Path != "/api/v2/users/current" {
			t.Fatal("unexpected compatibility fallback result")
		}
	}
}

func TestAccountValidationStopsAfterWarmupDenial(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 403, body: `<html>challenge</html>`})
	if client.ValidateSession() || len(transport.requests) != 1 {
		t.Fatal("account request followed denied warmup")
	}
}

func TestRefreshNeverReplaysFailure(t *testing.T) {
	for _, tc := range []fakeHTTPResult{
		{status: 401}, {status: 403}, {status: 429}, {status: 503},
		{status: 403, body: `{"url":"https://geo.captcha-delivery.com/synthetic-secret"}`},
		{err: errors.New("synthetic response lost")},
	} {
		client, transport := testClient(fakeHTTPResult{status: 200}, tc)
		client.session.AccessToken = "synthetic-old-access"
		client.session.RefreshToken = "synthetic-refresh"
		if client.RefreshAccessToken() == nil || len(transport.requests) != 2 || transport.requests[1].URL.Path != "/web/api/auth/refresh" {
			t.Fatal("failed refresh replayed or accepted")
		}
		if client.session.AccessToken != "synthetic-old-access" {
			t.Fatal("failed refresh changed stored credentials")
		}
	}
}

func TestRefreshRequiresChangedAccessCookie(t *testing.T) {
	for _, tc := range []struct {
		cookies []*http.Cookie
		valid   bool
	}{
		{nil, false},
		{[]*http.Cookie{{Name: "access_token_web", Value: "synthetic-old-access"}}, false},
		{[]*http.Cookie{{Name: "access_token_web", Value: "synthetic-new-access"}, {Name: "refresh_token_web", Value: "synthetic-new-refresh"}}, true},
	} {
		client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{}`, cookies: tc.cookies})
		client.session.AccessToken = "synthetic-old-access"
		client.session.RefreshToken = "synthetic-refresh"
		err := client.RefreshAccessToken()
		if (err == nil) != tc.valid || len(transport.requests) != 2 {
			t.Fatalf("unexpected refresh result: %v", err)
		}
		if tc.valid && (client.session.AccessToken != "synthetic-new-access" || client.session.RefreshToken != "synthetic-new-refresh") {
			t.Fatal("rotated credentials were not retained")
		}
	}
}

func TestAccountProfileResponseIsBounded(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 200}, fakeHTTPResult{status: 200, body: `{"conversations":[],"pagination":{}}`}, fakeHTTPResult{status: 200, body: strings.Repeat("x", maxFilterSearchResponseBytes+1)})
	client.session.AccessToken = validationToken()
	if client.ValidateSession() || len(transport.requests) != 3 {
		t.Fatal("oversized profile accepted or retried")
	}
}

func TestAccountErrorsDoNotExposeUpstreamSecrets(t *testing.T) {
	for _, err := range []error{
		&AuthError{Step: "account validation", StatusCode: 403, Message: "synthetic-private-value"},
		&DataDomeChallengeError{Step: "account validation", StatusCode: 403, CaptchaURL: "https://example.test/synthetic-private-value"},
		&PaymentStateError{Step: "checkout payment", StatusCode: 400, Code: "phone_required", Message: "synthetic-private-value", Raw: "synthetic-private-value"},
	} {
		if strings.Contains(err.Error(), "synthetic-private-value") {
			t.Fatal("typed error string leaked private response data")
		}
	}
}

func TestRefreshStopsAfterWarmupDenial(t *testing.T) {
	client, transport := testClient(fakeHTTPResult{status: 403, body: `<html>challenge</html>`})
	client.session.RefreshToken = "synthetic-refresh"
	if client.RefreshAccessToken() == nil || len(transport.requests) != 1 {
		t.Fatal("refresh continued after denied warmup")
	}
}
