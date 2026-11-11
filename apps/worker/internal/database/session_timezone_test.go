package database

import (
	"net/url"
	"testing"
)

func TestWithUTCSessionTimeZone(t *testing.T) {
	got := withUTCSessionTimeZone("postgres://user:p%40ss@db:5432/vintrack?sslmode=disable&search_path=wave")
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("timezone") != "UTC" || query.Get("sslmode") != "disable" || query.Get("search_path") != "wave" {
		t.Fatalf("query = %v", query)
	}
	if password, _ := parsed.User.Password(); password != "p@ss" || parsed.Host != "db:5432" || parsed.Path != "/vintrack" {
		t.Fatalf("connection target changed: %s", parsed.Redacted())
	}

	if got := withUTCSessionTimeZone("host=db dbname=vintrack"); got != "host=db dbname=vintrack timezone=UTC" {
		t.Fatalf("keyword form = %q", got)
	}
	for _, explicit := range []string{
		"postgres://db/vintrack?TimeZone=Europe%2FVienna",
		"host=db dbname=vintrack timezone=Europe/Vienna",
		"",
	} {
		if got := withUTCSessionTimeZone(explicit); got != explicit {
			t.Fatalf("explicit setting was overridden: %q -> %q", explicit, got)
		}
	}
}
