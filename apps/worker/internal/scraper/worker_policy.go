package scraper

import (
	"encoding/json"
	"log"
	"os"
	"strings"

	"vintrack-worker/internal/database"
)

const workerPolicySettingKey = "policy.worker"

func defaultWorkerPolicy() workerPolicy {
	return workerPolicy{
		Version:               1,
		Revision:              1,
		DiscoveryMode:         "off",
		EnrichSellerInfo:      true,
		CatalogLatencyMetrics: true,
		SellerFreshTTLMinutes: 30,
		SellerStaleTTLMinutes: 1440,
	}
}

func (e *Engine) applyWorkerPolicy(policy workerPolicy) {
	policy = normalizeWorkerPolicy(policy)
	policy.DiscoveryMode = resolveDiscoveryMode(policy.DiscoveryMode)
	if !e.fetcher.RequiresNetwork() {
		policy.DiscoveryMode = "off"
		policy.EnrichSellerInfo = false
	}
	e.workerPolicy.Store(policy)
	e.enrichersMu.RLock()
	for _, enricher := range e.enrichers {
		enricher.configureCacheTTLs(policy)
	}
	e.enrichersMu.RUnlock()
	freePolicy := loadFreeProxyPacingPolicy(e.db)
	e.freePacersMu.Lock()
	e.freePacingPolicy = freePolicy
	for region, pacer := range e.freePacers {
		pacer.mu.Lock()
		pacer.policy = freePolicy
		pacer.mu.Unlock()
		if !freePolicy.applies(region) {
			delete(e.freePacers, region)
		}
	}
	e.freePacersMu.Unlock()
}

func (e *Engine) workerPolicySnapshot() workerPolicy {
	if policy := e.workerPolicy.Load(); policy != nil {
		return policy.(workerPolicy)
	}
	return defaultWorkerPolicy()
}

type workerPolicy struct {
	Version                  int    `json:"version"`
	Revision                 int    `json:"revision"`
	DiscoveryMode            string `json:"discoveryMode"`
	DiscoveryAllowFreeActive bool   `json:"discoveryAllowFreeActive"`
	EnrichSellerInfo         bool   `json:"enrichSellerInfo"`
	CatalogLatencyMetrics    bool   `json:"catalogLatencyMetrics"`
	SellerFreshTTLMinutes    int    `json:"sellerFreshTtlMinutes"`
	SellerStaleTTLMinutes    int    `json:"sellerStaleTtlMinutes"`
}

func normalizeWorkerPolicy(policy workerPolicy) workerPolicy {
	defaults := defaultWorkerPolicy()
	policy.DiscoveryMode = resolveDiscoveryMode(policy.DiscoveryMode)
	if policy.SellerFreshTTLMinutes <= 0 {
		policy.SellerFreshTTLMinutes = defaults.SellerFreshTTLMinutes
	}
	if policy.SellerStaleTTLMinutes < policy.SellerFreshTTLMinutes {
		policy.SellerStaleTTLMinutes = max(defaults.SellerStaleTTLMinutes, policy.SellerFreshTTLMinutes)
	}
	return policy
}

func loadWorkerPolicy(store *database.Store) workerPolicy {
	policy := defaultWorkerPolicy()
	if raw, ok, err := store.GetSettingValue(workerPolicySettingKey); err == nil && ok {
		var parsed workerPolicy
		if json.Unmarshal([]byte(raw), &parsed) == nil && parsed.Version == 1 && parsed.Revision > 0 {
			return normalizeWorkerPolicy(parsed)
		}
		log.Printf("worker policy document invalid; using safe defaults")
		return policy
	}

	// One-release compatibility path for mixed deployments. New deployments
	// receive policy.worker from the database migration.
	log.Printf("deprecated worker runtime environment switches are in use; migrate to %s", workerPolicySettingKey)
	policy.DiscoveryMode = resolveDiscoveryMode(os.Getenv("DISCOVERY_MODE"))
	policy.DiscoveryAllowFreeActive = strings.EqualFold(strings.TrimSpace(os.Getenv("DISCOVERY_ALLOW_FREE_ACTIVE")), "true")
	policy.EnrichSellerInfo = !strings.EqualFold(strings.TrimSpace(os.Getenv("ENRICH_SELLER_INFO")), "false")
	policy.CatalogLatencyMetrics = !strings.EqualFold(strings.TrimSpace(os.Getenv("CATALOG_LATENCY_METRICS")), "false")
	return normalizeWorkerPolicy(policy)
}
