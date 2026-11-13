package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"vintrack-vinted/internal/checkoutagent"
)

func TestAgentKeepsPollingUnlessItsCredentialOrPairingIsGone(t *testing.T) {
	refusal := func(status int, code string) error {
		return &checkoutagent.CoordinatorError{Status: status, Code: code}
	}
	for _, tc := range []struct {
		name   string
		status int
		err    error
		fatal  bool
		wait   time.Duration
	}{
		{"revoked or expired credential", 401, refusal(401, ""), true, 0},
		{"pairing no longer matches the linked account", 409, refusal(409, checkoutagent.PairingMismatch), true, 0},
		{"a per-job conflict is not a pairing problem", 409, refusal(409, ""), false, 10 * time.Second},
		{"another conflict code", 409, refusal(409, "FULL_CHECKOUT_REQUIRED"), false, 10 * time.Second},
		{"module or consent switched off", 403, refusal(403, "FEATURE_UNAVAILABLE"), false, time.Minute},
		{"storage outage", 503, refusal(503, ""), false, 10 * time.Second},
		{"rate limited proxy", 429, refusal(429, ""), false, 10 * time.Second},
		{"network failure", 0, errors.New("synthetic network failure"), false, 10 * time.Second},
		{"a mismatch code on another status", 503, refusal(503, checkoutagent.PairingMismatch), false, 10 * time.Second},
	} {
		got := classifyPollFailure(tc.status, tc.err)
		if got.fatal != tc.fatal || got.wait != tc.wait || got.notice == "" || strings.Contains(got.notice, "synthetic") {
			t.Fatalf("%s: unexpected decision %+v", tc.name, got)
		}
	}
}

func TestAgentConfigPersistsOnlyScopedDeviceCredential(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent", "config.json")
	cfg := checkoutagent.Config{Server: "https://vintrack.example.test", Token: strings.Repeat("a", 64)}
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]string
	if json.Unmarshal(data, &fields) != nil || len(fields) != 2 || fields["token"] != cfg.Token || fields["server"] != cfg.Server {
		t.Fatal("unexpected config content")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("device credential permissions are too broad")
	}
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal("could not atomically replace device credential")
	}
}
