package scraper

import (
	"context"
	"log"
	"strings"
	"time"

	"vintrack-worker/internal/discord"
	"vintrack-worker/internal/model"
	"vintrack-worker/internal/telegram"
)

type alertJob struct {
	ctx             context.Context
	item            model.Item
	monitor         model.Monitor
	proxySource     string
	publish         bool
	deliverExternal bool
}

type enrichmentJob struct {
	ctx                context.Context
	item               model.Item
	vintedItem         model.VintedItem
	monitor            model.Monitor
	proxySource        string
	enricher           *SellerEnricher
	publishUpdate      bool
	requireSellerMatch bool
	alertAfterEnrich   bool
}

func (e *Engine) startPipelines() {
	alertWorkers := getEnvInt("ALERT_WORKERS", 8)
	if alertWorkers < 1 {
		alertWorkers = 1
	}
	discordWorkers := getEnvInt("DISCORD_ALERT_WORKERS", 8)
	if discordWorkers < 1 {
		discordWorkers = 1
	}
	telegramWorkers := getEnvInt("TELEGRAM_ALERT_WORKERS", 16)
	if telegramWorkers < 1 {
		telegramWorkers = 1
	}
	enrichmentWorkers := getEnvInt("ENRICHMENT_WORKERS", 8)
	if enrichmentWorkers < 1 {
		enrichmentWorkers = 1
	}

	for i := 0; i < alertWorkers; i++ {
		e.jobsWG.Add(1)
		go e.alertWorker()
	}
	for i := 0; i < discordWorkers; i++ {
		e.jobsWG.Add(1)
		go e.discordAlertWorker()
	}
	for i := 0; i < telegramWorkers; i++ {
		e.jobsWG.Add(1)
		go e.telegramAlertWorker()
	}
	for i := 0; i < enrichmentWorkers; i++ {
		e.jobsWG.Add(1)
		go e.enrichmentWorker()
	}
}

func (e *Engine) Close() {
	e.jobsCancel()
	e.jobsWG.Wait()
}

func (e *Engine) enqueueItem(job enrichmentJob, publishNow bool) {
	// Once an item is atomically claimed, its alert and persistence must survive
	// a monitor config refresh that cancels the polling task context.
	job.ctx = e.jobsCtx
	if publishNow {
		e.enqueueAlert(alertJob{
			ctx: job.ctx, item: job.item, monitor: job.monitor, proxySource: job.proxySource,
			publish: true,
		}, true)
	}

	select {
	case e.enrichmentJobs <- job:
	case <-job.ctx.Done():
	case <-e.jobsCtx.Done():
	}
}

func (e *Engine) enqueueAlert(job alertJob, recordQueued bool) {
	job.ctx = e.jobsCtx
	if recordQueued {
		e.db.RecordDetectionAlertQueued(job.monitor.ID, job.item.ID, time.Now())
	}
	select {
	case e.alertJobs <- job:
	case <-job.ctx.Done():
	case <-e.jobsCtx.Done():
	}
}

func (e *Engine) alertWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job := <-e.alertJobs:
			e.deliverAlert(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) deliverAlert(job alertJob) {
	select {
	case <-job.ctx.Done():
		return
	default:
	}

	notificationsEnabled := e.monitorNotificationsEnabled(job.monitor)
	configuredDiscord, configuredTelegram := effectiveExternalAlerts(
		job.monitor,
		notificationsEnabled,
	)
	hasDiscord := job.deliverExternal && configuredDiscord
	hasTelegram := job.deliverExternal && configuredTelegram

	if job.publish {
		// Dashboard/SSE stays on the immediate path. Discord and Telegram can
		// wait for seller enrichment without delaying the live feed.
		if err := e.db.PublishItem(job.item); err != nil {
			log.Printf("[%d] publish error: %v", job.monitor.ID, err)
		} else if !hasDiscord && !hasTelegram {
			e.db.RecordDetectionAlertSent(job.monitor.ID, job.item.ID, time.Now())
		}
	}
	if !job.deliverExternal {
		return
	}

	if (hasDiscord || hasTelegram) && job.monitor.DedupeMonitorAlerts && !e.db.ClaimUserItemAlert(job.monitor.UserID, job.item.ID) {
		e.db.RecordAlertEvent(model.AlertEvent{
			UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
			Channel: "all", Status: "skipped", FailureReason: "duplicate_user_item_alert",
		})
		return
	}

	if hasDiscord {
		select {
		case e.discordJobs <- job:
		case <-job.ctx.Done():
		case <-e.jobsCtx.Done():
		}
	}
	if hasTelegram {
		select {
		case e.telegramJobs <- job:
		case <-job.ctx.Done():
		case <-e.jobsCtx.Done():
		}
	}
}

func (e *Engine) discordAlertWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job := <-e.discordJobs:
			e.deliverDiscordAlert(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) deliverDiscordAlert(job alertJob) {
	select {
	case <-job.ctx.Done():
		return
	default:
	}
	_, style := e.monitorNotificationMessageStyles(job.monitor)
	if err := discord.SendWebhook(job.monitor.DiscordWebhook.String, job.item, job.monitor.Name, job.proxySource, style); err != nil {
		e.db.RecordAlertEvent(model.AlertEvent{
			UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
			Channel: "discord", Status: "failed", FailureReason: err.Error(),
		})
		return
	}
	e.db.RecordDetectionAlertSent(job.monitor.ID, job.item.ID, time.Now())
	e.db.RecordAlertEvent(model.AlertEvent{
		UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
		Channel: "discord", Status: "sent",
	})
}

func (e *Engine) telegramAlertWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job := <-e.telegramJobs:
			e.deliverTelegramAlert(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) deliverTelegramAlert(job alertJob) {
	select {
	case <-job.ctx.Done():
		return
	default:
	}
	style, _ := e.monitorNotificationMessageStyles(job.monitor)
	if err := telegram.SendItem(job.monitor.TelegramChatID.String, job.item, job.monitor.Name, job.proxySource, style); err != nil {
		e.db.RecordAlertEvent(model.AlertEvent{
			UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
			Channel: "telegram", Status: "failed", FailureReason: err.Error(),
		})
		return
	}
	e.db.RecordDetectionAlertSent(job.monitor.ID, job.item.ID, time.Now())
	e.db.RecordAlertEvent(model.AlertEvent{
		UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
		Channel: "telegram", Status: "sent",
	})
}

func (e *Engine) enrichmentWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job := <-e.enrichmentJobs:
			e.enrichAndPersist(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) enrichAndPersist(job enrichmentJob) {
	if !job.requireSellerMatch {
		if err := e.db.SaveItem(job.item); err != nil {
			log.Printf("[%d] save item %d: %v", job.monitor.ID, job.item.ID, err)
		}
	}

	info := SellerInfo{
		Region:          job.item.Location,
		Rating:          job.item.Rating,
		RatingStars:     job.item.SellerRating,
		RatingCount:     job.item.SellerRatingCount,
		RatingAvailable: job.item.SellerRatingAvailable,
	}
	enriched := info.Region != "" || info.RatingAvailable
	if (e.enrichSeller || job.requireSellerMatch) && job.enricher != nil && job.vintedItem.User.ID > 0 {
		info := job.enricher.FetchSellerInfo(job.vintedItem.User.ID)
		if info.Region != "" && info.Region != "NaN" {
			job.item.Location = info.Region
			job.item.Rating = info.Rating
			job.item.SellerRating = info.RatingStars
			job.item.SellerRatingCount = info.RatingCount
			job.item.SellerRatingAvailable = info.RatingAvailable
			enriched = true
		}
	}
	if hasCountryFilter(job.monitor.AllowedCountries) && !sellerCountryAllowed(job.item.Location, job.monitor.AllowedCountries) {
		reason := "seller location unavailable"
		if strings.TrimSpace(job.item.Location) != "" {
			reason = "seller location mismatch"
		}
		log.Printf("[%d] item %d skipped after strict country check: %s", job.monitor.ID, job.item.ID, reason)
		return
	}
	if hasSellerQualityFilter(job.monitor) && !sellerQualityAllowed(job.item, job.monitor) {
		reason := "seller rating unavailable"
		if job.item.SellerRatingAvailable {
			reason = "seller quality below threshold"
		}
		log.Printf("[%d] item %d skipped after strict seller quality check: %s", job.monitor.ID, job.item.ID, reason)
		return
	}

	if job.requireSellerMatch || enriched {
		if err := e.db.SaveItem(job.item); err != nil {
			log.Printf("[%d] save enriched item %d: %v", job.monitor.ID, job.item.ID, err)
		}
	}

	if job.alertAfterEnrich {
		e.enqueueAlert(alertJob{
			ctx: job.ctx, item: job.item, monitor: job.monitor, proxySource: job.proxySource,
			publish: job.requireSellerMatch, deliverExternal: true,
		}, job.requireSellerMatch)
	}
	if job.publishUpdate && (job.item.Location != "" || job.item.Rating != "") {
		if err := e.db.PublishItem(job.item); err != nil {
			log.Printf("[%d] publish enrichment update: %v", job.monitor.ID, err)
		}
	}
}

func configuredExternalAlerts(monitor model.Monitor) (bool, bool) {
	hasDiscord := monitor.WebhookActive && monitor.DiscordWebhook.Valid && monitor.DiscordWebhook.String != ""
	hasTelegram := monitor.TelegramActive && monitor.TelegramChatID.Valid && monitor.TelegramChatID.String != ""
	return hasDiscord, hasTelegram
}

func effectiveExternalAlerts(
	monitor model.Monitor,
	notificationsEnabled bool,
) (bool, bool) {
	if !notificationsEnabled {
		return false, false
	}
	return configuredExternalAlerts(monitor)
}

func detectedItemAlertPlan(
	monitor model.Monitor,
	strictSellerGate bool,
	notificationsEnabled bool,
) (bool, bool) {
	hasDiscord, hasTelegram := configuredExternalAlerts(monitor)
	publishNow := !strictSellerGate
	alertAfterEnrich :=
		strictSellerGate || (notificationsEnabled && (hasDiscord || hasTelegram))
	return publishNow, alertAfterEnrich
}

func hasCountryFilter(allowedCountries *string) bool {
	return allowedCountries != nil && strings.TrimSpace(*allowedCountries) != ""
}

func hasSellerQualityFilter(monitor model.Monitor) bool {
	return monitor.MinSellerRating != nil || monitor.MinSellerRatingCount != nil
}

func requiresSellerEnrichment(monitor model.Monitor) bool {
	return hasCountryFilter(monitor.AllowedCountries) || hasSellerQualityFilter(monitor)
}

func sellerQualityAllowed(item model.Item, monitor model.Monitor) bool {
	if !hasSellerQualityFilter(monitor) {
		return true
	}
	if monitor.MinSellerRating == nil || monitor.MinSellerRatingCount == nil || !item.SellerRatingAvailable {
		return false
	}
	return item.SellerRating >= *monitor.MinSellerRating &&
		item.SellerRatingCount >= *monitor.MinSellerRatingCount
}

func sellerCountryAllowed(location string, allowedCountries *string) bool {
	if !hasCountryFilter(allowedCountries) || strings.TrimSpace(location) == "" {
		return false
	}

	location = strings.ToLower(location)
	for _, allowed := range strings.Split(*allowedCountries, ",") {
		allowed = strings.ToLower(strings.TrimSpace(allowed))
		if allowed != "" && strings.Contains(location, allowed) {
			return true
		}
	}
	return false
}
