package publicurl

import "testing"

func clearURLSettings(t *testing.T) {
	t.Helper()
	for _, key := range []string{"APP_PUBLIC_URL", "AUTH_URL", "DASHBOARD_URL", "APP_ENV", "NODE_ENV", "ENVIRONMENT"} {
		t.Setenv(key, "")
	}
}

func TestResolveCanonicalPublicURL(t *testing.T) {
	clearURLSettings(t)
	t.Setenv("APP_PUBLIC_URL", "https://vintrack.jakobaio.dev/")
	health := Resolve()
	if !health.OK || health.Origin != "https://vintrack.jakobaio.dev" || health.Source != "APP_PUBLIC_URL" {
		t.Fatalf("unexpected health: %#v", health)
	}
	if got := Link("/price-watches?watch=24"); got != "https://vintrack.jakobaio.dev/price-watches?watch=24" {
		t.Fatalf("unexpected link: %s", got)
	}
}

func TestResolveRejectsConflictingSettings(t *testing.T) {
	clearURLSettings(t)
	t.Setenv("APP_PUBLIC_URL", "https://vintrack.jakobaio.dev")
	t.Setenv("DASHBOARD_URL", "https://old.example.test")
	if health := Resolve(); health.OK || health.Error == "" {
		t.Fatalf("expected conflicting configuration, got %#v", health)
	}
}

func TestResolveRejectsProductionTunnelAndLocalURL(t *testing.T) {
	for _, raw := range []string{"https://uncaring.ngrok-free.dev", "http://localhost:3000"} {
		t.Run(raw, func(t *testing.T) {
			clearURLSettings(t)
			t.Setenv("APP_ENV", "production")
			t.Setenv("APP_PUBLIC_URL", raw)
			if health := Resolve(); health.OK || Link("/dashboard") != "" {
				t.Fatalf("expected invalid production URL, got %#v", health)
			}
		})
	}
}

func TestResolveAllowsLocalDevelopmentFallback(t *testing.T) {
	clearURLSettings(t)
	t.Setenv("AUTH_URL", "http://localhost:3000")
	health := Resolve()
	if !health.OK || health.Origin != "http://localhost:3000" {
		t.Fatalf("unexpected local development result: %#v", health)
	}
}
