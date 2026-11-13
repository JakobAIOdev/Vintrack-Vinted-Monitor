package vinted

import (
	"fmt"
	"strings"
	"testing"
)

func TestBrowserIdentityKeepsClientHintsAndSupportedTransportTogether(t *testing.T) {
	for _, tc := range []struct {
		major, supported int
	}{
		{146, 146}, {150, 150}, {152, 152}, {153, 152},
	} {
		t.Run(fmt.Sprint(tc.major), func(t *testing.T) {
			agent := fmt.Sprintf("Mozilla/5.0 Chrome/%d.0.0.0 Safari/537.36", tc.major)
			client, _ := testClient()
			client.session.UserAgent = agent
			if got := client.apiHeaders().Get("Sec-Ch-Ua"); !strings.Contains(got, fmt.Sprintf(`"Chromium";v="%d"`, tc.major)) {
				t.Fatalf("client hints do not match the supplied browser: %s", got)
			}
			if got := profileForUserAgent(agent).GetClientHelloId().Version; got != fmt.Sprint(tc.supported) {
				t.Fatalf("unsupported transport profile: %s", got)
			}
		})
	}
}
