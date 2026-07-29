package scraper

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"vintrack-worker/internal/model"
	"vintrack-worker/internal/proxy"

	http "github.com/bogdanfinn/fhttp"
)

type timedCatalogFetcher struct {
	delays   map[string]time.Duration
	statuses map[string]int
}

func (f timedCatalogFetcher) FetchCatalog(ctx context.Context, client *Client, _ string, _ string) ([]model.VintedItem, int, error) {
	delay := f.delays[client.ProxyURL]
	select {
	case <-time.After(delay):
	case <-ctx.Done():
		return nil, 0, ctx.Err()
	}
	status := f.statuses[client.ProxyURL]
	if status == 0 {
		status = 200
	}
	if status != 200 {
		return nil, status, errors.New("fetch failed")
	}
	return []model.VintedItem{{ID: 42}}, status, nil
}

func (timedCatalogFetcher) RequiresNetwork() bool { return true }
func (timedCatalogFetcher) Name() string          { return "timed-test" }

func TestFetchCatalogHedgedUsesFasterSecondary(t *testing.T) {
	t.Setenv("CATALOG_HEDGE_DELAY_MS", "10")
	primary := &Client{ProxyURL: "primary"}
	secondary := &Client{ProxyURL: "secondary"}
	pool := &ClientPool{states: []*clientState{
		{client: primary, ewmaLatencyMS: 10},
		{client: secondary, ewmaLatencyMS: 20},
	}}
	engine := &Engine{fetcher: timedCatalogFetcher{delays: map[string]time.Duration{
		"primary":   100 * time.Millisecond,
		"secondary": 5 * time.Millisecond,
	}}}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := engine.fetchCatalogHedged(ctx, pool, "https://example.test", "example.test")

	if result.err != nil || result.status != 200 {
		t.Fatalf("fetchCatalogHedged() = status %d, error %v", result.status, result.err)
	}
	if result.client != secondary {
		t.Fatalf("winner = %v, want secondary", result.client)
	}
	if len(result.items) != 1 || result.items[0].ID != 42 {
		t.Fatalf("items = %#v, want item 42", result.items)
	}
}

func TestFetchCatalogHedgedRotatesPastBlockedClients(t *testing.T) {
	t.Setenv("CATALOG_MAX_ATTEMPTS", "4")
	blockedOne := &Client{ProxyURL: "blocked-one", warmed: make(map[string]bool)}
	blockedTwo := &Client{ProxyURL: "blocked-two", warmed: make(map[string]bool)}
	blockedThree := &Client{ProxyURL: "blocked-three", warmed: make(map[string]bool)}
	healthy := &Client{ProxyURL: "healthy", warmed: make(map[string]bool)}
	pool := &ClientPool{states: []*clientState{
		{client: blockedOne, ewmaLatencyMS: 10},
		{client: blockedTwo, ewmaLatencyMS: 20},
		{client: blockedThree, ewmaLatencyMS: 30},
		{client: healthy, ewmaLatencyMS: 40},
	}}
	engine := &Engine{fetcher: timedCatalogFetcher{
		delays: map[string]time.Duration{},
		statuses: map[string]int{
			"blocked-one":   403,
			"blocked-two":   403,
			"blocked-three": 403,
			"healthy":       200,
		},
	}}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := engine.fetchCatalogHedgedWithDelay(
		ctx,
		pool,
		"https://example.test",
		"example.test",
		time.Hour,
	)

	if result.err != nil || result.status != 200 {
		t.Fatalf("fetchCatalogHedgedWithDelay() = status %d, error %v", result.status, result.err)
	}
	if result.client != healthy {
		t.Fatalf("winner = %v, want healthy fourth client", result.client)
	}
}

func TestFetchCatalogHedgedWaitsForFreeProxyCapacity(t *testing.T) {
	client := &Client{ProxyURL: "only"}
	pool := &ClientPool{states: []*clientState{{client: client}}}
	pool.SetMaxInFlightPerClient(1)
	if got := pool.Acquire(nil); got != client {
		t.Fatalf("setup Acquire() = %v, want client", got)
	}

	engine := &Engine{fetcher: timedCatalogFetcher{
		delays: map[string]time.Duration{"only": time.Millisecond},
	}}
	go func() {
		time.Sleep(20 * time.Millisecond)
		pool.Report(client, 200, time.Millisecond, nil)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := engine.fetchCatalogHedgedWithDelay(
		ctx,
		pool,
		"https://example.test",
		"example.test",
		time.Hour,
	)
	if result.err != nil || result.status != 200 {
		t.Fatalf("fetch after capacity wait = status %d, error %v", result.status, result.err)
	}
	if result.client != client {
		t.Fatalf("fetch client = %v, want released client", result.client)
	}
}

func TestClientPoolPrefersHealthyIdleClient(t *testing.T) {
	slow := &Client{ProxyURL: "slow"}
	fast := &Client{ProxyURL: "fast"}
	busy := &Client{ProxyURL: "busy"}
	pool := &ClientPool{states: []*clientState{
		{client: slow, ewmaLatencyMS: 900},
		{client: fast, ewmaLatencyMS: 100},
		{client: busy, ewmaLatencyMS: 50, inFlight: 2},
	}}

	if got := pool.Acquire(nil); got != fast {
		t.Fatalf("Acquire() = %v, want fast healthy client", got)
	}
	pool.Report(fast, 429, 50*time.Millisecond, nil)
	if got := pool.Acquire(nil); got != slow {
		t.Fatalf("Acquire() after rate limit = %v, want slow non-cooled client", got)
	}
}

func TestCatalogTimeoutForFreeProxyMatchesValidationBudget(t *testing.T) {
	t.Setenv("CATALOG_TIMEOUT_MS", "2000")
	t.Setenv("FREE_PROXY_CATALOG_TIMEOUT_MS", "3500")

	if got := catalogTimeoutForProxySource("free"); got != 3500*time.Millisecond {
		t.Fatalf("free catalog timeout = %s, want 3.5s", got)
	}
	if got := catalogTimeoutForProxySource("server"); got != 2*time.Second {
		t.Fatalf("server catalog timeout = %s, want 2s", got)
	}
}

func TestConfiguredFreeProxyClientPoolSize(t *testing.T) {
	t.Setenv("FREE_PROXY_CLIENT_POOL_SIZE", "")
	if got := configuredFreeProxyClientPoolSize(); got != defaultFreeProxyClientPoolSize {
		t.Fatalf("default free pool size = %d, want %d", got, defaultFreeProxyClientPoolSize)
	}

	t.Setenv("FREE_PROXY_CLIENT_POOL_SIZE", "75")
	if got := configuredFreeProxyClientPoolSize(); got != 75 {
		t.Fatalf("configured free pool size = %d, want 75", got)
	}

	t.Setenv("FREE_PROXY_CLIENT_POOL_SIZE", "500")
	if got := configuredFreeProxyClientPoolSize(); got != maximumFreeProxyClientPoolSize {
		t.Fatalf("capped free pool size = %d, want %d", got, maximumFreeProxyClientPoolSize)
	}
}

func TestCatalogHedgeDelayForFreeProxyAvoidsAutomaticDoubleLoad(t *testing.T) {
	t.Setenv("CATALOG_HEDGE_DELAY_MS", "250")
	t.Setenv("FREE_PROXY_CATALOG_HEDGE_DELAY_MS", "")

	if got := catalogHedgeDelayForProxySource("server"); got != 250*time.Millisecond {
		t.Fatalf("server hedge delay = %s, want 250ms", got)
	}
	if got := catalogHedgeDelayForProxySource("free"); got != 900*time.Millisecond {
		t.Fatalf("free hedge delay = %s, want 900ms", got)
	}

	t.Setenv("FREE_PROXY_CATALOG_HEDGE_DELAY_MS", "1200")
	if got := catalogHedgeDelayForProxySource("free"); got != 1200*time.Millisecond {
		t.Fatalf("configured free hedge delay = %s, want 1.2s", got)
	}
}

func TestStatusCodeFromWrappedWarmupError(t *testing.T) {
	err := errors.Join(
		errors.New("catalog warmup failed"),
		&httpStatusError{operation: "warmup www.vinted.nl", statusCode: 403},
	)
	if got := statusCodeFromError(err); got != 403 {
		t.Fatalf("statusCodeFromError() = %d, want 403", got)
	}
}

func TestPoolClientDoesNotFallBackToDirect(t *testing.T) {
	if _, err := newPoolClient(&proxy.Manager{}, nil, time.Second, true); err == nil {
		t.Fatal("empty required proxy pool created a direct client")
	}
}

func TestBuildDiscoverySpecsGroupsStructuralFilters(t *testing.T) {
	catalog := "123"
	monitors := []model.Monitor{
		{ID: 1, Status: "active", Region: "de", Query: "nike", CatalogIDs: &catalog, ProxySource: "server", ServerProxyVersion: 3},
		{ID: 2, Status: "active", Region: "de", Query: "adidas", CatalogIDs: &catalog, ProxySource: "server", ServerProxyVersion: 3},
		{ID: 3, Status: "active", Region: "de", Query: "puma", CatalogIDs: &catalog, ProxySource: "free"},
	}

	specs := BuildDiscoverySpecs(monitors, "active")
	if len(specs) != 1 {
		t.Fatalf("BuildDiscoverySpecs() produced %d groups, want 1", len(specs))
	}
	for _, spec := range specs {
		if len(spec.Monitors) != 2 {
			t.Fatalf("group has %d monitors, want 2 dedicated monitors", len(spec.Monitors))
		}
		if spec.Fingerprint == "" {
			t.Fatal("group fingerprint is empty")
		}
	}
	if got := BuildDiscoverySpecs(monitors, "off"); len(got) != 0 {
		t.Fatalf("off mode produced %d groups, want none", len(got))
	}
	if got := BuildDiscoverySpecs(monitors, "shadow"); len(got) != 2 {
		t.Fatalf("shadow mode produced %d groups, want dedicated and free test groups", len(got))
	}
	t.Setenv("DISCOVERY_ALLOW_FREE_ACTIVE", "true")
	if got := BuildDiscoverySpecs(monitors, "active"); len(got) != 2 {
		t.Fatalf("active free opt-in produced %d groups, want 2", len(got))
	}
}

func TestFreeDiscoveryFingerprintIgnoresPoolVersionChurn(t *testing.T) {
	base := model.Monitor{Region: "de", ProxySource: "free", FreeProxyVersion: 1}
	updated := base
	updated.FreeProxyVersion = 2
	if discoveryStructuralKey(base) != discoveryStructuralKey(updated) {
		t.Fatal("free proxy pool version unexpectedly restarted the discovery group")
	}
}

func TestWaitForProxyManagerRecovers(t *testing.T) {
	manager := &proxy.Manager{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	go func() {
		time.Sleep(10 * time.Millisecond)
		manager.ReplaceFromString("http://1.2.3.4:8080")
	}()

	if !waitForProxyManager(ctx, manager, time.Millisecond) {
		t.Fatal("proxy manager did not recover")
	}
}

func TestWaitForProxyManagerStopsWithContext(t *testing.T) {
	manager := &proxy.Manager{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if waitForProxyManager(ctx, manager, time.Millisecond) {
		t.Fatal("proxy manager wait ignored canceled context")
	}
}

func TestDetectedItemAlertPlanWaitsForDiscordEnrichment(t *testing.T) {
	monitor := model.Monitor{
		WebhookActive:  true,
		DiscordWebhook: sql.NullString{String: "https://discord.test/webhook", Valid: true},
	}

	publishNow, alertAfterEnrich := detectedItemAlertPlan(monitor, false)
	if !publishNow {
		t.Fatal("dashboard publish should stay on the immediate path")
	}
	if !alertAfterEnrich {
		t.Fatal("Discord alert should wait for seller enrichment")
	}
}

func TestDetectedItemAlertPlanPreservesStrictRegionFilter(t *testing.T) {
	allowedCountries := "de"
	monitor := model.Monitor{
		AllowedCountries: &allowedCountries,
		WebhookActive:    true,
		DiscordWebhook:   sql.NullString{String: "https://discord.test/webhook", Valid: true},
	}

	publishNow, alertAfterEnrich := detectedItemAlertPlan(monitor, hasCountryFilter(monitor.AllowedCountries))
	if publishNow {
		t.Fatal("strict region filter published before seller enrichment")
	}
	if !alertAfterEnrich {
		t.Fatal("strict region filter did not schedule the enriched alert")
	}
	if !sellerCountryAllowed("🇩🇪 DE", monitor.AllowedCountries) {
		t.Fatal("matching seller region was rejected")
	}
	if sellerCountryAllowed("🇫🇷 FR", monitor.AllowedCountries) {
		t.Fatal("non-matching seller region was accepted")
	}
}

func TestDetectedItemAlertPlanSkipsDeferredWorkWithoutExternalAlerts(t *testing.T) {
	publishNow, alertAfterEnrich := detectedItemAlertPlan(model.Monitor{}, false)
	if !publishNow {
		t.Fatal("dashboard publish should be immediate")
	}
	if alertAfterEnrich {
		t.Fatal("item without external alerts scheduled a deferred alert")
	}
}

func TestDiscoveryFailureBackoffOnlyAfterRepeatedFreeFailures(t *testing.T) {
	if got := discoveryFailureBackoff("server", 5); got != 0 {
		t.Fatalf("server backoff = %s, want 0", got)
	}
	if got := discoveryFailureBackoff("free", 1); got != 0 {
		t.Fatalf("first free failure backoff = %s, want 0", got)
	}
	if got := discoveryFailureBackoff("free", 2); got != 250*time.Millisecond {
		t.Fatalf("second free failure backoff = %s, want 250ms", got)
	}
	if got := discoveryFailureBackoff("free", 20); got != 2*time.Second {
		t.Fatalf("capped free failure backoff = %s, want 2s", got)
	}
}

func TestBuildDiscoverySpecsDoesNotMixProxyGroups(t *testing.T) {
	groupOne := 1
	groupTwo := 2
	proxies := sql.NullString{String: "http://127.0.0.1:8000", Valid: true}
	monitors := []model.Monitor{
		{ID: 1, Status: "active", Region: "de", ProxySource: "group", ProxyGroupID: &groupOne, Proxies: proxies},
		{ID: 2, Status: "active", Region: "de", ProxySource: "group", ProxyGroupID: &groupTwo, Proxies: proxies},
	}

	if got := BuildDiscoverySpecs(monitors, "active"); len(got) != 2 {
		t.Fatalf("BuildDiscoverySpecs() produced %d groups, want separate user proxy groups", len(got))
	}
}

func TestMatchesDiscoveryAppliesLocalTextFilters(t *testing.T) {
	anti := "kids, damaged"
	monitor := model.Monitor{Query: "nike max", AntiKeywords: &anti, BannedSellerIDs: []int64{99}}

	if !matchesDiscovery(model.VintedItem{Title: "Air Max 90", BrandTitle: "Nike", User: model.VintedUser{ID: 1}}, monitor) {
		t.Fatal("matching title and brand was rejected")
	}
	if matchesDiscovery(model.VintedItem{Title: "Air Max", BrandTitle: "Nike", Description: "For kids", User: model.VintedUser{ID: 1}}, monitor) {
		t.Fatal("anti-keyword item was accepted")
	}
	if matchesDiscovery(model.VintedItem{Title: "Air Max 90", BrandTitle: "Nike", User: model.VintedUser{ID: 99}}, monitor) {
		t.Fatal("banned seller item was accepted")
	}
	if matchesDiscovery(model.VintedItem{Title: "Air Force 1", BrandTitle: "Nike", User: model.VintedUser{ID: 1}}, monitor) {
		t.Fatal("item missing a query term was accepted")
	}
}

func TestMatchesDiscoveryAcceptsAnyCommaSeparatedQuery(t *testing.T) {
	monitor := model.Monitor{Query: "console ps1, playstation 1 bundle, ps one"}

	if !matchesDiscovery(model.VintedItem{Title: "Sony PS One boxed"}, monitor) {
		t.Fatal("item matching the third query alternative was rejected")
	}
	if matchesDiscovery(model.VintedItem{Title: "PlayStation 2 bundle"}, monitor) {
		t.Fatal("item matching only part of an alternative was accepted")
	}
}

func TestBuildDiscoveryURLKeepsFiltersAndDropsQuery(t *testing.T) {
	t.Setenv("DISCOVERY_PER_PAGE", "96")
	price := 25
	catalog := "10,20"
	raw := BuildDiscoveryURL(model.Monitor{
		Region: "de", Query: "nike", PriceMax: &price, CatalogIDs: &catalog,
	}, 2)
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("search_text") != "" {
		t.Fatalf("search_text = %q, want omitted", query.Get("search_text"))
	}
	if query.Get("price_to") != "25" || query.Get("page") != "2" || query.Get("per_page") != "96" {
		t.Fatalf("discovery query lost server filters: %v", query)
	}
	if len(query["catalog_ids[]"]) != 2 {
		t.Fatalf("catalog filters = %v, want two", query["catalog_ids[]"])
	}
}

func TestBuildDiscoveryURLWithPerPageOverride(t *testing.T) {
	raw := BuildDiscoveryURLWithPerPage(model.Monitor{Region: "de", Query: "nike"}, 1, 64)
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Query().Get("per_page"); got != "64" {
		t.Fatalf("per_page = %q, want 64", got)
	}
}

func TestSellerCountryAllowed(t *testing.T) {
	allowed := "de,fr"
	if !sellerCountryAllowed("🇩🇪 DE", &allowed) {
		t.Fatal("sellerCountryAllowed(DE) = false, want true")
	}
	if sellerCountryAllowed("🇮🇹 IT", &allowed) {
		t.Fatal("sellerCountryAllowed(IT) = true, want false")
	}
	if sellerCountryAllowed("", &allowed) {
		t.Fatal("sellerCountryAllowed(empty) = true, want false")
	}
}

func TestConfiguredClientFingerprint(t *testing.T) {
	t.Setenv("TLS_PROFILE", "chrome_146")
	if got := configuredClientFingerprint(); got.name != "chrome_146" || got.version != "146" {
		t.Fatalf("configuredClientFingerprint() = %#v", got)
	}
	t.Setenv("TLS_PROFILE", "unsupported")
	if got := configuredClientFingerprint(); got.name != "chrome_146" {
		t.Fatalf("unsupported profile fallback = %q, want chrome_146", got.name)
	}
}

func TestWarmupHeadersMatchBrowserNavigation(t *testing.T) {
	t.Setenv("TLS_PROFILE", "chrome_146")
	headers := newWarmupHeaders("www.vinted.de")

	for key, want := range map[string]string{
		"Upgrade-Insecure-Requests": "1",
		"Sec-Fetch-Site":            "none",
		"Sec-Fetch-Mode":            "navigate",
		"Sec-Fetch-User":            "?1",
		"Sec-Fetch-Dest":            "document",
		"Priority":                  "u=0, i",
	} {
		if got := headers.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if got := headers.Get("User-Agent"); !strings.Contains(got, "Chrome/146.") {
		t.Errorf("User-Agent = %q, want Chrome 146", got)
	}
	if len(headers[http.HeaderOrderKey]) == 0 {
		t.Fatal("warmup header order is empty")
	}
}

func TestDiscoveryFingerprintTracksNotificationChanges(t *testing.T) {
	base := model.Monitor{
		ID: 1, Status: "active", Region: "de", Query: "nike", ProxySource: "server",
		DiscordWebhook: sql.NullString{String: "https://discord.test/a", Valid: true},
	}
	changed := base
	changed.DiscordWebhook.String = "https://discord.test/b"
	if discoveryMonitorFingerprint(base) == discoveryMonitorFingerprint(changed) {
		t.Fatal("notification change did not alter discovery fingerprint")
	}
}
