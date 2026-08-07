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
	platformIDs := "1277,1278"
	allowedCountries := "de,fr"
	antiKeywords := "fake,replica"
	minSellerRating := 4.5
	minSellerRatingCount := 5

	base := model.Monitor{
		ID:                   7,
		Query:                "nike",
		AntiKeywords:         &antiKeywords,
		QueryDelayMs:         1500,
		PriceMin:             &min,
		PriceMax:             &max,
		SizeID:               &sizeID,
		CatalogIDs:           &catalogIDs,
		BrandIDs:             &brandIDs,
		ColorIDs:             &colorIDs,
		StatusIDs:            &statusIDs,
		VideoGamePlatformIDs: &platformIDs,
		Region:               "de",
		AllowedCountries:     &allowedCountries,
		MinSellerRating:      &minSellerRating,
		MinSellerRatingCount: &minSellerRatingCount,
		Proxies:              sql.NullString{Valid: true, String: "http://proxy-a:8080"},
		DiscordWebhook:       sql.NullString{Valid: true, String: "https://discord.test/webhook"},
		WebhookActive:        true,
		Status:               "active",
	}

	cases := []struct {
		name   string
		mutate func(*model.Monitor)
	}{
		{name: "query", mutate: func(m *model.Monitor) { m.Query = "adidas" }},
		{name: "title only", mutate: func(m *model.Monitor) { m.TitleOnly = true }},
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
		{name: "platform", mutate: func(m *model.Monitor) { v := "1280,1281"; m.VideoGamePlatformIDs = &v }},
		{name: "region", mutate: func(m *model.Monitor) { m.Region = "fr" }},
		{name: "allowed countries", mutate: func(m *model.Monitor) { v := "it"; m.AllowedCountries = &v }},
		{name: "minimum seller rating", mutate: func(m *model.Monitor) { v := 4.8; m.MinSellerRating = &v }},
		{name: "minimum seller rating count", mutate: func(m *model.Monitor) { v := 10; m.MinSellerRatingCount = &v }},
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
	updated.NotificationsEnabled = !base.NotificationsEnabled
	updated.Status = "paused"

	if got := monitorConfigFingerprint(updated); got != monitorConfigFingerprint(base) {
		t.Fatalf("fingerprint changed for non-runtime fields: %q vs %q", got, monitorConfigFingerprint(base))
	}
}

func TestNotificationPolicyRefreshDoesNotChangeMonitorFingerprint(t *testing.T) {
	engine := &Engine{notificationPolicies: make(map[int]notificationPolicy)}
	monitor := model.Monitor{
		ID:                   42,
		Query:                "nike",
		Region:               "de",
		NotificationsEnabled: true,
	}
	originalFingerprint := monitorConfigFingerprint(monitor)

	muted := monitor
	muted.NotificationsEnabled = false
	muted.TelegramMessageStyle = model.NotificationMessageStyleCompact
	muted.DiscordMessageStyle = model.NotificationMessageStyleCompact
	engine.SyncNotificationPolicies([]model.Monitor{muted})

	if engine.monitorNotificationsEnabled(monitor) {
		t.Fatal("notification policy refresh did not mute the monitor")
	}
	telegramStyle, discordStyle := engine.monitorNotificationMessageStyles(monitor)
	if telegramStyle != model.NotificationMessageStyleCompact || discordStyle != model.NotificationMessageStyleCompact {
		t.Fatalf("notification policy refresh did not update message styles: telegram=%q discord=%q", telegramStyle, discordStyle)
	}
	if monitorConfigFingerprint(muted) != originalFingerprint {
		t.Fatal("notification policy refresh should not restart the monitor")
	}
}

func TestDiscoveryStructuralKeyIncludesVideoGamePlatforms(t *testing.T) {
	firstPlatforms := "1277"
	secondPlatforms := "1278"
	base := model.Monitor{
		Region:               "de",
		VideoGamePlatformIDs: &firstPlatforms,
	}
	updated := base
	updated.VideoGamePlatformIDs = &secondPlatforms

	if discoveryStructuralKey(base) == discoveryStructuralKey(updated) {
		t.Fatal("discovery key did not change for video game platforms")
	}
}
