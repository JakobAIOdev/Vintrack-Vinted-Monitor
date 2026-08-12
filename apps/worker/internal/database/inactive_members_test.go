package database

import "testing"

func TestParseInactiveMemberPolicy(t *testing.T) {
	policy, err := parseInactiveMemberPolicy(`{"enabled":true,"revision":"r1","duration":2,"durationUnit":"weeks","monitorScope":"free_proxy","roles":["free"],"enabledAt":"2026-08-12T10:00:00Z"}`)
	if err != nil {
		t.Fatal(err)
	}
	if policy.DurationDays != 14 || !policy.Enabled {
		t.Fatalf("unexpected policy: %#v", policy)
	}
}

func TestParseInactiveMemberPolicyRejectsInvalidValues(t *testing.T) {
	cases := []string{
		`not-json`,
		`{"enabled":true,"revision":"r1","duration":0,"durationUnit":"days","monitorScope":"all","roles":["free"],"enabledAt":"2026-08-12T10:00:00Z"}`,
		`{"enabled":true,"revision":"r1","duration":1,"durationUnit":"hours","monitorScope":"all","roles":["free"],"enabledAt":"2026-08-12T10:00:00Z"}`,
		`{"enabled":true,"revision":"r1","duration":1,"durationUnit":"weeks","monitorScope":"all","roles":["admin"],"enabledAt":"2026-08-12T10:00:00Z"}`,
	}
	for _, value := range cases {
		if _, err := parseInactiveMemberPolicy(value); err == nil {
			t.Fatalf("expected %q to fail", value)
		}
	}
}
