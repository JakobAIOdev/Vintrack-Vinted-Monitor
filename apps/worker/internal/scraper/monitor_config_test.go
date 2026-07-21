package scraper

import (
	"database/sql"
	"testing"

	"vintrack-worker/internal/model"
)

func TestMonitorConfigFingerprintIncludesRuntimeFilters(t *testing.T) {
	min := 10
	max := 50
	sizeID := "1,2"
	catalogIDs := "10,20"
	brandIDs := "30,40"
	colorIDs := "50,60"
	statusIDs := "1,4"
	allowedCountries := "de,fr"
	antiKeywords := "fake,replica"

	base := model.Monitor{
		ID:               7,
		Query:            "nike",
		AntiKeywords:     &antiKeywords,
		QueryDelayMs:     1500,
		PriceMin:         &min,
		PriceMax:         &max,
		SizeID:           &sizeID,
		CatalogIDs:       &catalogIDs,
		BrandIDs:         &brandIDs,
		ColorIDs:         &colorIDs,
		StatusIDs:        &statusIDs,
		Region:           "de",
		AllowedCountries: &allowedCountries,
		Proxies:          sql.NullString{Valid: true, String: "http://proxy-a:8080"},
		DiscordWebhook:   sql.NullString{Valid: true, String: "https://discord.test/webhook"},
		WebhookActive:    true,
		Status:           "active",
	}

	cases := []struct {
		name   string
		mutate func(*model.Monitor)
	}{
		{name: "query", mutate: func(m *model.Monitor) { m.Query = "adidas" }},
		{name: "anti keywords", mutate: func(m *model.Monitor) { v := "damaged"; m.AntiKeywords = &v }},
		{name: "query delay", mutate: func(m *model.Monitor) { m.QueryDelayMs = 2000 }},
		{name: "quiet hours", mutate: func(m *model.Monitor) {
			m.QuietHoursEnabled = true
			m.QuietHoursStartMinute = 1380
			m.QuietHoursEndMinute = 420
			m.QuietHoursMode = "pause"
			m.QuietHoursTimezone = "Europe/Berlin"
		}},
		{name: "price min", mutate: func(m *model.Monitor) { v := 11; m.PriceMin = &v }},
		{name: "price max", mutate: func(m *model.Monitor) { v := 51; m.PriceMax = &v }},
		{name: "size", mutate: func(m *model.Monitor) { v := "3,4"; m.SizeID = &v }},
		{name: "catalog", mutate: func(m *model.Monitor) { v := "11,21"; m.CatalogIDs = &v }},
		{name: "brand", mutate: func(m *model.Monitor) { v := "31,41"; m.BrandIDs = &v }},
		{name: "color", mutate: func(m *model.Monitor) { v := "51,61"; m.ColorIDs = &v }},
		{name: "status", mutate: func(m *model.Monitor) { v := "2,5"; m.StatusIDs = &v }},
		{name: "region", mutate: func(m *model.Monitor) { m.Region = "fr" }},
		{name: "allowed countries", mutate: func(m *model.Monitor) { v := "it"; m.AllowedCountries = &v }},
		{name: "proxies", mutate: func(m *model.Monitor) { m.Proxies = sql.NullString{Valid: true, String: "http://proxy-b:8080"} }},
	}

	original := monitorConfigFingerprint(base)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			updated := base
			tc.mutate(&updated)

			if got := monitorConfigFingerprint(updated); got == original {
				t.Fatalf("fingerprint did not change for %s", tc.name)
			}
		})
	}
}

func TestMonitorConfigFingerprintIgnoresWebhookState(t *testing.T) {
	base := model.Monitor{
		Query:   "nike",
		Region:  "de",
		Proxies: sql.NullString{Valid: true, String: "http://proxy-a:8080"},
	}

	updated := base
	updated.DiscordWebhook = sql.NullString{Valid: true, String: "https://discord.test/other"}
	updated.WebhookActive = true
	updated.TelegramChatID = sql.NullString{Valid: true, String: "-1001234567890"}
	updated.TelegramActive = true
	updated.Status = "paused"

	if got := monitorConfigFingerprint(updated); got != monitorConfigFingerprint(base) {
		t.Fatalf("fingerprint changed for non-runtime fields: %q vs %q", got, monitorConfigFingerprint(base))
	}
}
