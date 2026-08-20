package scraper

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"vintrack-worker/internal/model"
)

type alertJob struct {
	ctx             context.Context
	item            model.Item
	monitor         model.Monitor
	proxySource     string
	deliverExternal bool
	enqueueAttempt  int
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
	cachedInfo         *SellerInfo
	backgroundOnly     bool
	strictAttempt      int
	enqueuedAt         time.Time
	readyAt            time.Time
	notificationTimer  *time.Timer
}

// alertDeliveryWorkerCount is the single source of truth for delivery
// concurrency. NewEngine sizes the claim buffer and the in-flight ceiling from
// it before startPipelines spawns the workers themselves.
func alertDeliveryWorkerCount() int {
	workers := getEnvInt("ALERT_DELIVERY_WORKERS", 16)
	if workers < 1 {
		workers = 1
	}
	if workers > 64 {
		workers = 64
	}
	return workers
}

func (e *Engine) startPipelines() {
	alertWorkers := getEnvInt("ALERT_WORKERS", 8)
	if alertWorkers < 1 {
		alertWorkers = 1
	}
	deliveryWorkers := alertDeliveryWorkerCount()
	enrichmentWorkers := getEnvInt("ENRICHMENT_WORKERS", 24)
	if enrichmentWorkers < 1 {
		enrichmentWorkers = 1
	}

	for i := 0; i < alertWorkers; i++ {
		e.jobsWG.Add(1)
		go e.alertWorker()
	}
	e.jobsWG.Add(1)
	go func() {
		defer e.jobsWG.Done()
		e.enrichmentScheduler.Run(e.jobsCtx)
	}()
	for i := 0; i < deliveryWorkers; i++ {
		e.jobsWG.Add(1)
		go e.alertDeliveryWorker()
	}
	e.jobsWG.Add(1)
	go e.alertDeliveryCoordinator()
	e.jobsWG.Add(1)
	go e.alertDeliveryListener()
	for _, task := range []func(){e.alertDeliveryLeaseRecovery, e.alertDeliveryExpiry, e.alertDeliveryHeartbeat} {
		e.jobsWG.Add(1)
		go task()
	}
	e.jobsWG.Add(1)
	go e.enrichmentMetricsHeartbeat()
	for i := 0; i < enrichmentWorkers; i++ {
		e.jobsWG.Add(1)
		go e.enrichmentWorker()
	}
	fastWorkers := min(4, enrichmentWorkers)
	for i := 0; i < fastWorkers; i++ {
		e.jobsWG.Add(1)
		go e.enrichmentFastWorker()
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
		// The browser live feed deliberately has no dependency on Postgres or the
		// durable external-delivery outbox.
		if err := e.db.PublishItem(job.monitor.UserID, job.item); err != nil {
			log.Printf("[%d] immediate live-feed publish error: %v", job.monitor.ID, err)
		} else {
			e.db.RecordDetectionAlertSent(job.monitor.ID, job.item.ID, time.Now())
		}
	}

	if job.enricher != nil && job.vintedItem.User.ID > 0 {
		cacheCtx, cancel := context.WithTimeout(job.ctx, 90*time.Millisecond)
		if info, ok := LookupCachedSellerInfo(cacheCtx, e.db, job.enricher.domain, job.vintedItem.User.ID, job.enricher.cacheTTL); ok && isSellerInfoComplete(info) {
			job.cachedInfo = &info
		}
		cancel()
		if e.enrichmentMetrics != nil {
			e.enrichmentMetrics.recordCache(job.cachedInfo != nil)
		}
	}
	if job.cachedInfo != nil {
		e.armNormalAlertDeadline(&job)
		select {
		case e.enrichmentFastJobs <- job:
		case <-job.ctx.Done():
		}
		return
	}
	e.armNormalAlertDeadline(&job)
	e.enrichmentScheduler.Submit(job.ctx, job)
}

func (e *Engine) armNormalAlertDeadline(job *enrichmentJob) {
	if job == nil || job.requireSellerMatch || !job.alertAfterEnrich || job.backgroundOnly || job.notificationTimer != nil {
		return
	}
	deadline := itemEnrichmentDeadline(job.item)
	delay := time.Until(deadline)
	if delay < 0 {
		delay = 0
	}
	fallback := alertJob{
		ctx: e.jobsCtx, item: job.item, monitor: job.monitor,
		proxySource: job.proxySource, deliverExternal: true,
	}
	job.notificationTimer = time.AfterFunc(delay, func() {
		e.enqueueAlert(fallback)
	})
}

func (e *Engine) enqueueAlert(job alertJob) {
	job.ctx = e.jobsCtx
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

	if !job.deliverExternal {
		return
	}

	if !hasDiscord && !hasTelegram {
		return
	}

	telegramStyle, discordStyle := e.monitorNotificationMessageStyles(job.monitor)
	deadline := itemAlertDeadline(job.item)
	if !deadline.After(time.Now()) {
		e.recordStaleItemAlert(job, "notification_enqueue_expired")
		return
	}
	request := model.AlertNotificationRequest{
		UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
		Kind: "item_match", IdempotencyKey: fmt.Sprintf("item:%d:%d", job.monitor.ID, job.item.ID),
		ExpiresAt: deadline, DedupeUserItem: job.monitor.DedupeMonitorAlerts,
		Payload: model.AlertNotificationPayload{
			Version: 1, Kind: "item_match", MonitorName: job.monitor.Name,
			ProxySource: job.proxySource, TelegramStyle: telegramStyle,
			DiscordStyle: discordStyle, Item: &job.item,
		},
	}
	if hasDiscord {
		request.DiscordTarget = job.monitor.DiscordWebhook.String
	}
	if hasTelegram {
		request.TelegramTarget = job.monitor.TelegramChatID.String
	}
	// The enqueue is the point where an alert becomes durable, so failing it
	// means the alert never existed. Budget generously against the two-minute
	// deadline instead of racing it: a tight budget turned every moment of
	// database contention into a retry loop that outlived the deadline.
	queueTimeout := min(2*time.Second, time.Until(deadline))
	queueCtx, cancel := context.WithTimeout(job.ctx, queueTimeout)
	created, err := e.db.EnqueueAlertNotification(queueCtx, request)
	cancel()
	if err != nil {
		log.Printf("[%d] enqueue item alert %d: %v", job.monitor.ID, job.item.ID, err)
		e.scheduleAlertEnqueueRetry(job)
		return
	}
	if created {
		e.db.RecordDetectionAlertQueued(job.monitor.ID, job.item.ID, time.Now())
	}
}

func (e *Engine) scheduleAlertEnqueueRetry(job alertJob) {
	deadline := itemAlertDeadline(job.item)
	if !deadline.After(time.Now()) {
		e.recordStaleItemAlert(job, "notification_enqueue_expired")
		return
	}
	attempt := job.enqueueAttempt
	if attempt > 4 {
		attempt = 4
	}
	// Linear, not exponential: the deadline is two minutes and doubling reaches
	// it while the contention that caused the failure has usually already passed.
	delay := time.Duration(attempt+1) * 250 * time.Millisecond
	if remaining := time.Until(deadline); delay > remaining {
		delay = remaining
	}
	job.enqueueAttempt++
	time.AfterFunc(delay, func() {
		e.enqueueAlert(job)
	})
}

func (e *Engine) enqueueStatusNotification(
	monitor model.Monitor,
	kind string,
	title string,
	message string,
	idempotencySuffix string,
) {
	if !e.monitorNotificationsEnabled(monitor) {
		return
	}
	discordEnabled, telegramEnabled := effectiveExternalAlerts(monitor, true)
	if !discordEnabled && !telegramEnabled {
		return
	}
	request := model.AlertNotificationRequest{
		UserID: monitor.UserID, MonitorID: monitor.ID, Kind: kind,
		IdempotencyKey: fmt.Sprintf("status:%s:%d:%s", kind, monitor.ID, idempotencySuffix),
		ExpiresAt:      time.Now().Add(time.Hour),
		Payload: model.AlertNotificationPayload{
			Version: 1, Kind: kind, MonitorName: monitor.Name, Title: title, Message: message,
		},
	}
	if discordEnabled {
		request.DiscordTarget = monitor.DiscordWebhook.String
	}
	if telegramEnabled {
		request.TelegramTarget = monitor.TelegramChatID.String
	}
	ctx, cancel := context.WithTimeout(e.jobsCtx, 5*time.Second)
	defer cancel()
	if _, err := e.db.EnqueueAlertNotification(ctx, request); err != nil {
		log.Printf("[%d] enqueue %s notification: %v", monitor.ID, kind, err)
	}
}

func (e *Engine) enrichmentWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job, ok := <-e.enrichmentScheduler.Work():
			if !ok {
				return
			}
			e.enrichAndPersist(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) enrichmentFastWorker() {
	defer e.jobsWG.Done()
	for {
		select {
		case job := <-e.enrichmentFastJobs:
			e.enrichAndPersist(job)
		case <-e.jobsCtx.Done():
			return
		}
	}
}

func (e *Engine) enrichAndPersist(job enrichmentJob) {
	if !itemAlertDeadline(job.item).After(time.Now()) {
		if job.alertAfterEnrich {
			e.recordStaleItemAlert(alertJob{item: job.item, monitor: job.monitor}, "seller_enrichment_stale")
		}
		return
	}
	info := SellerInfo{
		Region:          job.item.Location,
		Rating:          job.item.Rating,
		RatingStars:     job.item.SellerRating,
		RatingCount:     job.item.SellerRatingCount,
		RatingAvailable: job.item.SellerRatingAvailable,
	}
	var fetchErr error
	if job.cachedInfo != nil {
		info = *job.cachedInfo
	} else if (e.enrichSeller || job.requireSellerMatch) && job.enricher != nil && job.vintedItem.User.ID > 0 {
		enrichmentDeadline := itemEnrichmentDeadline(job.item)
		if job.strictAttempt > 0 || job.backgroundOnly {
			enrichmentDeadline = time.Now().Add(sellerEnrichmentTimeout())
		}
		if staleDeadline := itemAlertDeadline(job.item); enrichmentDeadline.After(staleDeadline) {
			enrichmentDeadline = staleDeadline
		}
		fetchCtx, cancel := context.WithDeadline(job.ctx, enrichmentDeadline)
		remoteStarted := time.Now()
		info, fetchErr = e.fetchSellerInfo(fetchCtx, job.enricher, job.vintedItem.User.ID)
		if e.enrichmentMetrics != nil {
			e.enrichmentMetrics.recordRemote(time.Since(remoteStarted), classifySellerFetchError(fetchErr))
		}
		cancel()
	}
	if info.Region != "" && info.Region != "NaN" {
		job.item.Location = info.Region
		job.item.Rating = info.Rating
		job.item.SellerRating = info.RatingStars
		job.item.SellerRatingCount = info.RatingCount
		job.item.SellerRatingAvailable = info.RatingAvailable
	}

	strictDataAvailable := (!hasCountryFilter(job.monitor.AllowedCountries) || strings.TrimSpace(job.item.Location) != "") &&
		(!hasSellerQualityFilter(job.monitor) || job.item.SellerRatingAvailable)
	if job.requireSellerMatch && !strictDataAvailable {
		e.scheduleStrictSellerRetry(job, fetchErr)
		return
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

	if job.requireSellerMatch {
		if err := e.db.PublishItem(job.monitor.UserID, job.item); err != nil {
			log.Printf("[%d] strict live-feed publish error: %v", job.monitor.ID, err)
		} else {
			e.db.RecordDetectionAlertSent(job.monitor.ID, job.item.ID, time.Now())
		}
	}

	if job.alertAfterEnrich {
		if job.notificationTimer != nil {
			job.notificationTimer.Stop()
		}
		e.enqueueAlert(alertJob{
			ctx: job.ctx, item: job.item, monitor: job.monitor, proxySource: job.proxySource,
			deliverExternal: true,
		})
	}
	if err := e.db.SaveItem(job.item); err != nil {
		log.Printf("[%d] save item %d: %v", job.monitor.ID, job.item.ID, err)
	}
	if fetchErr != nil && !job.requireSellerMatch && !job.backgroundOnly {
		background := job
		background.alertAfterEnrich = false
		background.backgroundOnly = true
		background.publishUpdate = true
		background.readyAt = time.Now().Add(5 * time.Second)
		background.enqueuedAt = time.Now()
		e.enrichmentScheduler.Submit(job.ctx, background)
	}
	if job.publishUpdate && !job.requireSellerMatch && (job.item.Location != "" || job.item.Rating != "") {
		if err := e.db.PublishItem(job.monitor.UserID, job.item); err != nil {
			log.Printf("[%d] publish enrichment update: %v", job.monitor.ID, err)
		}
	}
}

func (e *Engine) fetchSellerInfo(ctx context.Context, enricher *SellerEnricher, sellerID int64) (SellerInfo, error) {
	key := fmt.Sprintf("%s:%d", enricher.domain, sellerID)
	e.sellerFlightsMu.Lock()
	if e.sellerFlights == nil {
		e.sellerFlights = make(map[string]*sellerFetchFlight)
	}
	if flight, ok := e.sellerFlights[key]; ok {
		e.sellerFlightsMu.Unlock()
		select {
		case <-flight.done:
			return flight.info, flight.err
		case <-ctx.Done():
			return SellerInfo{}, ctx.Err()
		}
	}
	flight := &sellerFetchFlight{done: make(chan struct{})}
	e.sellerFlights[key] = flight
	e.sellerFlightsMu.Unlock()

	info, err := enricher.FetchSellerInfo(ctx, sellerID)
	e.sellerFlightsMu.Lock()
	flight.info, flight.err = info, err
	delete(e.sellerFlights, key)
	close(flight.done)
	e.sellerFlightsMu.Unlock()
	return info, err
}

func itemAlertDeadline(item model.Item) time.Time {
	foundAt := item.FoundAt
	if foundAt.IsZero() {
		foundAt = time.Now()
	}
	return foundAt.Add(2 * time.Minute)
}

func itemEnrichmentDeadline(item model.Item) time.Time {
	foundAt := item.FoundAt
	if foundAt.IsZero() {
		foundAt = time.Now()
	}
	return foundAt.Add(sellerEnrichmentTimeout())
}

func (e *Engine) scheduleStrictSellerRetry(job enrichmentJob, fetchErr error) {
	delays := [...]time.Duration{5 * time.Second, 20 * time.Second, 60 * time.Second}
	if job.strictAttempt >= len(delays) {
		job.strictAttempt++
		job.readyAt = itemAlertDeadline(job.item)
		job.enqueuedAt = time.Now()
		e.enrichmentScheduler.Submit(job.ctx, job)
		return
	}
	next := time.Now().Add(delays[job.strictAttempt])
	if !next.Before(itemAlertDeadline(job.item)) {
		if job.alertAfterEnrich {
			e.recordStaleItemAlert(alertJob{item: job.item, monitor: job.monitor}, "seller_enrichment_stale")
		}
		return
	}
	job.strictAttempt++
	job.readyAt = next
	job.enqueuedAt = time.Now()
	if fetchErr != nil {
		log.Printf("[%d] strict seller retry %d for item %d scheduled after enrichment error: %v", job.monitor.ID, job.strictAttempt, job.item.ID, fetchErr)
	}
	e.enrichmentScheduler.Submit(job.ctx, job)
}

func (e *Engine) recordStaleItemAlert(job alertJob, reason string) {
	e.db.RecordAlertEvent(model.AlertEvent{
		UserID: job.monitor.UserID, MonitorID: job.monitor.ID, ItemID: job.item.ID,
		Channel: "internal", Status: "stale", NotificationKind: "item_match",
		ReasonCode: reason,
	})
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
