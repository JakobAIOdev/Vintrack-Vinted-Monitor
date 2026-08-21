package scraper

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"vintrack-worker/internal/model"
)

// TestRequiresSellerEnrichment pins exactly which monitor configurations are
// "strict" (must have seller data before an alert is allowed out) versus
// ordinary. Getting this wrong in either direction breaks one of the two
// load-bearing invariants: a strict monitor publishing before enrichment, or
// a non-strict monitor being needlessly gated on it.
func TestRequiresSellerEnrichment(t *testing.T) {
	countries := "DE,FR"
	blank := "   "
	rating := 4.5
	ratingCount := 10

	cases := []struct {
		name    string
		monitor model.Monitor
		want    bool
	}{
		{"no filters", model.Monitor{}, false},
		{"nil country pointer", model.Monitor{AllowedCountries: nil}, false},
		{"blank country filter", model.Monitor{AllowedCountries: &blank}, false},
		{"country filter set", model.Monitor{AllowedCountries: &countries}, true},
		{"min rating set", model.Monitor{MinSellerRating: &rating}, true},
		{"min rating count set", model.Monitor{MinSellerRatingCount: &ratingCount}, true},
		{"country and rating set", model.Monitor{AllowedCountries: &countries, MinSellerRating: &rating}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := requiresSellerEnrichment(tc.monitor); got != tc.want {
				t.Fatalf("requiresSellerEnrichment(%+v) = %v, want %v", tc.monitor, got, tc.want)
			}
		})
	}
}

// TestDetectedItemAlertPlan_StrictNeverPublishesBeforeEnrichment pins the
// first correctness invariant: whenever the monitor requires strict seller
// data (country or rating filters), detectedItemAlertPlan must never signal
// publishNow=true, regardless of notification configuration. Doing so would
// let an item reach the live feed / external alert before the required
// seller criteria are known and satisfied.
func TestDetectedItemAlertPlan_StrictNeverPublishesBeforeEnrichment(t *testing.T) {
	base := model.Monitor{
		WebhookActive:  true,
		DiscordWebhook: sql.NullString{String: "https://discord.example/webhook", Valid: true},
		TelegramActive: true,
		TelegramChatID: sql.NullString{String: "12345", Valid: true},
	}
	noAlerts := model.Monitor{}

	for _, notificationsEnabled := range []bool{true, false} {
		for _, monitor := range []model.Monitor{base, noAlerts} {
			publishNow, alertAfterEnrich := detectedItemAlertPlan(monitor, true, notificationsEnabled)
			if publishNow {
				t.Fatalf("strict monitor (notificationsEnabled=%v, hasChannels=%v) got publishNow=true, want false",
					notificationsEnabled, monitor.WebhookActive)
			}
			if !alertAfterEnrich {
				t.Fatalf("strict monitor (notificationsEnabled=%v) got alertAfterEnrich=false, want true so the strict live-feed publish still happens after enrichAndPersist resolves",
					notificationsEnabled)
			}
		}
	}
}

// TestDetectedItemAlertPlan_NonStrictNeverBlocked pins the second
// correctness invariant: a monitor without strict seller filters must always
// get publishNow=true so the live feed is never delayed waiting on
// enrichment, independent of whether external notifications are configured.
func TestDetectedItemAlertPlan_NonStrictNeverBlocked(t *testing.T) {
	withChannels := model.Monitor{
		WebhookActive:  true,
		DiscordWebhook: sql.NullString{String: "https://discord.example/webhook", Valid: true},
	}
	withoutChannels := model.Monitor{}

	cases := []struct {
		name                 string
		monitor              model.Monitor
		notificationsEnabled bool
		wantAlertAfterEnrich bool
	}{
		{"channels configured, notifications on", withChannels, true, true},
		{"channels configured, notifications off", withChannels, false, false},
		{"no channels, notifications on", withoutChannels, true, false},
		{"no channels, notifications off", withoutChannels, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			publishNow, alertAfterEnrich := detectedItemAlertPlan(tc.monitor, false, tc.notificationsEnabled)
			if !publishNow {
				t.Fatal("non-strict monitor got publishNow=false, want true (must never block the live feed on enrichment)")
			}
			if alertAfterEnrich != tc.wantAlertAfterEnrich {
				t.Fatalf("alertAfterEnrich = %v, want %v", alertAfterEnrich, tc.wantAlertAfterEnrich)
			}
		})
	}
}

// TestScheduleStrictSellerRetry_FollowsBoundedSchedule pins the documented
// 5s/20s/60s strict-retry backoff so a future change to this file cannot
// silently speed it up (wasting requests) or slow it down (missing the
// alert deadline) without a test failing.
func TestScheduleStrictSellerRetry_FollowsBoundedSchedule(t *testing.T) {
	scheduler := NewSellerEnrichmentScheduler(16, 1)
	engine := &Engine{enrichmentScheduler: scheduler}
	job := enrichmentJob{
		ctx: context.Background(), item: model.Item{ID: 1, FoundAt: time.Now()},
		requireSellerMatch: true, alertAfterEnrich: true,
	}

	wantDelays := []time.Duration{5 * time.Second, 20 * time.Second, 60 * time.Second}
	for i, want := range wantDelays {
		before := time.Now()
		engine.scheduleStrictSellerRetry(job, errors.New("still missing seller data"))
		select {
		case job = <-scheduler.input:
		case <-time.After(time.Second):
			t.Fatalf("attempt %d: retry was not submitted", i)
		}
		if job.strictAttempt != i+1 {
			t.Fatalf("attempt %d: strictAttempt = %d, want %d", i, job.strictAttempt, i+1)
		}
		gotDelay := job.readyAt.Sub(before)
		if gotDelay < want-500*time.Millisecond || gotDelay > want+500*time.Millisecond {
			t.Fatalf("attempt %d: readyAt delay = %v, want ~%v", i, gotDelay, want)
		}
	}
}
