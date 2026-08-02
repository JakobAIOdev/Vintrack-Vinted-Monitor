package main

import (
	"context"
	"maps"
	"reflect"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/scraper"
)

func TestFreeProxyValidationTimeout(t *testing.T) {
	tests := []struct {
		name         string
		maxLatencyMs int
		want         time.Duration
	}{
		{name: "default", maxLatencyMs: 0, want: 4 * time.Second},
		{name: "normal", maxLatencyMs: 2500, want: 4 * time.Second},
		{name: "custom", maxLatencyMs: 4000, want: 5500 * time.Millisecond},
		{name: "capped", maxLatencyMs: 15000, want: 8 * time.Second},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := freeProxyValidationTimeout(test.maxLatencyMs); got != test.want {
				t.Fatalf("freeProxyValidationTimeout(%d) = %s, want %s", test.maxLatencyMs, got, test.want)
			}
		})
	}
}

func TestFreeProxyTimeoutBatchFitsRecoveryCycleBudget(t *testing.T) {
	const candidates = 960
	const concurrency = 48
	waves := (candidates + concurrency - 1) / concurrency
	worstCase := time.Duration(waves) * freeProxyValidationTimeout(2500)
	if worstCase > 90*time.Second {
		t.Fatalf("timeout-only batch budget = %s, want at most 90s", worstCase)
	}
}

func TestWaitForFreeProxyBatchHonorsCycleCancellation(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(1)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if waitForFreeProxyBatch(ctx, &wg) {
		t.Fatal("waitForFreeProxyBatch returned true for a canceled cycle")
	}

	wg.Done()
}

func TestWaitForFreeProxyBatchCompletes(t *testing.T) {
	var wg sync.WaitGroup

	if !waitForFreeProxyBatch(context.Background(), &wg) {
		t.Fatal("waitForFreeProxyBatch returned false for a completed batch")
	}
}

func TestInterleaveFreeProxyCandidates(t *testing.T) {
	batches := [][]database.FreeProxyCandidate{
		{{ProxyURL: "de-1", Region: "de"}, {ProxyURL: "de-2", Region: "de"}},
		{{ProxyURL: "fr-1", Region: "fr"}},
		{{ProxyURL: "it-1", Region: "it"}, {ProxyURL: "it-2", Region: "it"}},
	}

	got := interleaveFreeProxyCandidates(batches)
	want := []database.FreeProxyCandidate{
		{ProxyURL: "de-1", Region: "de"},
		{ProxyURL: "fr-1", Region: "fr"},
		{ProxyURL: "it-1", Region: "it"},
		{ProxyURL: "de-2", Region: "de"},
		{ProxyURL: "it-2", Region: "it"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("interleaveFreeProxyCandidates() = %#v, want %#v", got, want)
	}
}

func TestFreeProxyWaveGroupSlotsStayBoundedAndFair(t *testing.T) {
	tests := []struct {
		name               string
		maximumSlots       int
		recoveryRegions    int
		maintenanceRegions int
		wantRecovery       int
		wantMaintenance    int
	}{
		{name: "all recovery", maximumSlots: 24, recoveryRegions: 12, wantRecovery: 24},
		{name: "all maintenance", maximumSlots: 24, maintenanceRegions: 12, wantMaintenance: 24},
		{name: "proportional split", maximumSlots: 24, recoveryRegions: 9, maintenanceRegions: 3, wantRecovery: 18, wantMaintenance: 6},
		{name: "maintenance retains a slot", maximumSlots: 2, recoveryRegions: 11, maintenanceRegions: 1, wantRecovery: 1, wantMaintenance: 1},
		{name: "empty wave", maximumSlots: 0, recoveryRegions: 2, maintenanceRegions: 2},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotRecovery, gotMaintenance := freeProxyWaveGroupSlots(
				test.maximumSlots,
				test.recoveryRegions,
				test.maintenanceRegions,
			)
			if gotRecovery != test.wantRecovery ||
				gotMaintenance != test.wantMaintenance {
				t.Fatalf(
					"freeProxyWaveGroupSlots() = %d/%d, want %d/%d",
					gotRecovery,
					gotMaintenance,
					test.wantRecovery,
					test.wantMaintenance,
				)
			}
			if gotRecovery+gotMaintenance > test.maximumSlots {
				t.Fatalf(
					"allocated %d slots above maximum %d",
					gotRecovery+gotMaintenance,
					test.maximumSlots,
				)
			}
		})
	}
}

func TestFreeProxyWaveClassSlotsPrioritizeUsedRecovery(t *testing.T) {
	recovery, keepalive, idle := freeProxyWaveClassSlots(64, 4, 2, 8)
	if recovery != 48 || keepalive != 9 || idle != 7 {
		t.Fatalf("class slots = %d/%d/%d, want 48/9/7", recovery, keepalive, idle)
	}
	if recovery+keepalive+idle != 64 {
		t.Fatalf("class slots total = %d, want 64", recovery+keepalive+idle)
	}

	recovery, keepalive, idle = freeProxyWaveClassSlots(12, 0, 0, 7)
	if recovery != 0 || keepalive != 0 || idle != 12 {
		t.Fatalf("idle-only slots = %d/%d/%d, want 0/0/12", recovery, keepalive, idle)
	}
}

func TestFreeProxyRegionWorkClassPrioritizesEveryUnderfilledRegion(t *testing.T) {
	tests := []struct {
		name      string
		bootstrap bool
		used      bool
		want      freeProxyRegionWorkClass
	}{
		{name: "used recovery", bootstrap: true, used: true, want: freeProxyRegionWorkRecovery},
		{name: "idle recovery", bootstrap: true, used: false, want: freeProxyRegionWorkRecovery},
		{name: "used keepalive", used: true, want: freeProxyRegionWorkKeepalive},
		{name: "idle maintenance", want: freeProxyRegionWorkIdle},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := freeProxyRegionWorkClassFor(test.bootstrap, test.used); got != test.want {
				t.Fatalf(
					"freeProxyRegionWorkClassFor(%v, %v) = %d, want %d",
					test.bootstrap,
					test.used,
					got,
					test.want,
				)
			}
		})
	}
}

func TestFreeProxyAdaptiveRegionConcurrency(t *testing.T) {
	now := time.Now()
	if got := freeProxyAdaptiveRegionConcurrency(12, now, now.Add(time.Minute), now.Add(6*time.Minute)); got != 6 {
		t.Fatalf("throttled concurrency = %d, want 6", got)
	}
	if got := freeProxyAdaptiveRegionConcurrency(12, now, now.Add(-time.Minute), now.Add(4*time.Minute)); got != 9 {
		t.Fatalf("recovering concurrency = %d, want 9", got)
	}
	if got := freeProxyAdaptiveRegionConcurrency(12, now, now.Add(-time.Minute), now.Add(-time.Second)); got != 12 {
		t.Fatalf("restored concurrency = %d, want 12", got)
	}
}

func TestWarmupTransportFailureClassification(t *testing.T) {
	if !isWarmupTransportFailure("timeout", scraper.FreeProxyValidationStageWarmup) {
		t.Fatal("warmup timeout should be a global transport failure")
	}
	if isWarmupTransportFailure("timeout", scraper.FreeProxyValidationStageCatalog) {
		t.Fatal("catalog timeout should remain region-local")
	}
	if isWarmupTransportFailure("vinted_403", scraper.FreeProxyValidationStageWarmup) {
		t.Fatal("warmup HTTP denial should remain region-local")
	}
}

func TestFreeProxyWaveEgressRecoveryThresholds(t *testing.T) {
	tests := []struct {
		name string
		wave freeProxyWaveStats
		want bool
	}{
		{
			name: "more than two percent succeeds",
			wave: freeProxyWaveStats{
				Checked:                 100,
				Passed:                  3,
				WarmupTransportFailures: 97,
			},
			want: true,
		},
		{
			name: "warmup failures below sixty percent",
			wave: freeProxyWaveStats{
				Checked:                 100,
				Passed:                  1,
				WarmupTransportFailures: 59,
			},
			want: true,
		},
		{
			name: "boundary remains degraded",
			wave: freeProxyWaveStats{
				Checked:                 100,
				Passed:                  2,
				WarmupTransportFailures: 60,
			},
			want: false,
		},
		{name: "empty wave", wave: freeProxyWaveStats{}, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := freeProxyWaveShowsEgressRecovery(test.wave); got != test.want {
				t.Fatalf("freeProxyWaveShowsEgressRecovery() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestInterleaveFreeProxyImportCandidatesRedistributesUnusedQuota(t *testing.T) {
	sources := [][]freeProxyImportCandidate{
		{
			{ProxyURL: "http://country-1:80", Source: "iplocate:de"},
		},
		{
			{ProxyURL: "http://global-1:80", Source: "iplocate"},
			{ProxyURL: "http://global-2:80", Source: "iplocate"},
			{ProxyURL: "http://global-3:80", Source: "iplocate"},
		},
	}

	got := interleaveFreeProxyImportCandidates(sources, 4)
	want := []freeProxyImportCandidate{
		{ProxyURL: "http://country-1:80", Source: "iplocate:de"},
		{ProxyURL: "http://global-1:80", Source: "iplocate"},
		{ProxyURL: "http://global-2:80", Source: "iplocate"},
		{ProxyURL: "http://global-3:80", Source: "iplocate"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("interleaveFreeProxyImportCandidates() = %#v, want %#v", got, want)
	}
}

func TestInterleaveFreeProxyImportCandidatesKeepsFirstSourceAttribution(t *testing.T) {
	sources := [][]freeProxyImportCandidate{
		{
			{ProxyURL: "http://shared:80", Source: "iplocate:de"},
			{ProxyURL: "http://country-2:80", Source: "iplocate:de"},
		},
		{
			{ProxyURL: "http://shared:80", Source: "iplocate"},
			{ProxyURL: "http://global-2:80", Source: "iplocate"},
		},
	}

	got := interleaveFreeProxyImportCandidates(sources, 3)
	want := []freeProxyImportCandidate{
		{ProxyURL: "http://shared:80", Source: "iplocate:de"},
		{ProxyURL: "http://global-2:80", Source: "iplocate"},
		{ProxyURL: "http://country-2:80", Source: "iplocate:de"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("interleaveFreeProxyImportCandidates() = %#v, want %#v", got, want)
	}
}

func TestInterleaveFreeProxyImportCandidatesUsesProtocolQuotas(t *testing.T) {
	sources := make([][]freeProxyImportCandidate, 4)
	protocols := []string{"http", "https", "socks5", "socks4"}
	for sourceIndex, protocol := range protocols {
		for candidateIndex := 0; candidateIndex < 30; candidateIndex++ {
			sources[sourceIndex] = append(sources[sourceIndex], freeProxyImportCandidate{
				ProxyURL: "proxy-" + protocol + "-" + strconv.Itoa(candidateIndex),
				Protocol: protocol,
				Source:   "source-" + protocol,
			})
		}
	}

	got := interleaveFreeProxyImportCandidates(sources, 20)
	counts := map[string]int{}
	for _, candidate := range got {
		if candidate.Protocol == "http" || candidate.Protocol == "https" {
			counts["web"]++
		} else {
			counts[candidate.Protocol]++
		}
	}

	if counts["web"] != 12 || counts["socks5"] != 7 || counts["socks4"] != 1 {
		t.Fatalf("protocol counts = %#v, want web=12 socks5=7 socks4=1", counts)
	}
}

func TestSelectFreeProxyImportCandidatesIsStableAcrossFeedReordering(t *testing.T) {
	now := time.Now()
	inventory := map[string]database.FreeProxyInventoryRecord{
		"http://winner:80":   {ProxyURL: "http://winner:80", SuccessCount: 2, LastChecked: &now},
		"http://untested:80": {ProxyURL: "http://untested:80"},
		"http://failed:80":   {ProxyURL: "http://failed:80", LastChecked: &now},
	}
	first := []freeProxyImportCandidate{
		{ProxyURL: "http://new:80", Protocol: "http", Source: "feed"},
		{ProxyURL: "http://failed:80", Protocol: "http", Source: "feed"},
		{ProxyURL: "http://untested:80", Protocol: "http", Source: "feed"},
		{ProxyURL: "http://winner:80", Protocol: "http", Source: "feed"},
	}
	second := append([]freeProxyImportCandidate(nil), first...)
	slices.Reverse(second)

	gotFirst, _ := selectFreeProxyImportCandidates(
		[][]freeProxyImportCandidate{first},
		maps.Clone(inventory),
		4,
	)
	gotSecond, _ := selectFreeProxyImportCandidates(
		[][]freeProxyImportCandidate{second},
		maps.Clone(inventory),
		4,
	)

	if !reflect.DeepEqual(gotFirst, gotSecond) {
		t.Fatalf("selection changed after feed reorder: %#v != %#v", gotFirst, gotSecond)
	}
	if gotFirst[0].ProxyURL != "http://winner:80" ||
		gotFirst[1].ProxyURL != "http://untested:80" ||
		gotFirst[2].ProxyURL != "http://new:80" {
		t.Fatalf("selection priority = %#v, want winner, untested, new", gotFirst)
	}
}

func TestSelectFreeProxyImportCandidatesHonorsRemainingPoolCapacity(t *testing.T) {
	sources := [][]freeProxyImportCandidate{
		{
			{ProxyURL: "http://existing-a:80", Source: "iplocate:de"},
			{ProxyURL: "http://new-a:80", Source: "iplocate:de"},
			{ProxyURL: "http://new-b:80", Source: "iplocate:de"},
		},
		{
			{ProxyURL: "http://existing-b:80", Source: "iplocate"},
			{ProxyURL: "http://new-c:80", Source: "iplocate"},
		},
	}
	existing := map[string]database.FreeProxyInventoryRecord{
		"http://existing-a:80": {ProxyURL: "http://existing-a:80"},
		"http://existing-b:80": {ProxyURL: "http://existing-b:80"},
	}

	got, newCount := selectFreeProxyImportCandidates(sources, existing, 3)
	want := []database.FreeProxyRecord{
		{ProxyURL: "http://existing-a:80", Source: "iplocate:de", Sources: []string{"iplocate:de"}},
		{ProxyURL: "http://existing-b:80", Source: "iplocate", Sources: []string{"iplocate"}},
		{ProxyURL: "http://new-a:80", Source: "iplocate:de", Sources: []string{"iplocate:de"}},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("selectFreeProxyImportCandidates() = %#v, want %#v", got, want)
	}
	if newCount != 1 {
		t.Fatalf("selectFreeProxyImportCandidates() new count = %d, want 1", newCount)
	}
	if len(existing) != 3 {
		t.Fatalf("pool size after selection = %d, want 3", len(existing))
	}
}

func TestSelectFreeProxyImportCandidatesRetainsUntestedOversizedPool(t *testing.T) {
	sources := [][]freeProxyImportCandidate{{
		{ProxyURL: "http://new:80", Source: "iplocate"},
		{ProxyURL: "http://existing-a:80", Source: "iplocate"},
		{ProxyURL: "http://existing-b:80", Source: "iplocate"},
		{ProxyURL: "http://existing-c:80", Source: "iplocate"},
	}}
	existing := map[string]database.FreeProxyInventoryRecord{
		"http://existing-a:80": {ProxyURL: "http://existing-a:80"},
		"http://existing-b:80": {ProxyURL: "http://existing-b:80"},
		"http://existing-c:80": {ProxyURL: "http://existing-c:80"},
		"http://existing-d:80": {ProxyURL: "http://existing-d:80"},
	}

	got, newCount := selectFreeProxyImportCandidates(sources, existing, 3)

	if len(got) != 3 {
		t.Fatalf("selected candidate count = %d, want 3", len(got))
	}
	if newCount != 0 {
		t.Fatalf("new candidate count = %d, want 0", newCount)
	}
	if got[0].ProxyURL != "http://existing-a:80" {
		t.Fatalf("first selected candidate = %q, want retained untested proxy", got[0].ProxyURL)
	}
}

func TestSelectFreeProxyImportCandidatesReusesStoredURLVariant(t *testing.T) {
	sources := [][]freeProxyImportCandidate{{
		{ProxyURL: "http://existing:80", Source: "iplocate"},
	}}
	existing := map[string]database.FreeProxyInventoryRecord{
		"http://existing:80": {ProxyURL: "http://existing:80/"},
	}

	got, newCount := selectFreeProxyImportCandidates(sources, existing, 1)

	if len(got) != 1 || got[0].ProxyURL != "http://existing:80/" {
		t.Fatalf("selected candidates = %#v, want stored URL variant", got)
	}
	if newCount != 0 {
		t.Fatalf("new candidate count = %d, want 0", newCount)
	}
}

func TestCanonicalFreeProxyURLRemovesOnlyEmptyRootPath(t *testing.T) {
	tests := map[string]string{
		"http://127.0.0.1:8080":         "http://127.0.0.1:8080",
		"http://127.0.0.1:8080/":        "http://127.0.0.1:8080",
		"socks5://user:pass@host:1080/": "socks5://user:pass@host:1080",
		"http://127.0.0.1:8080/path":    "http://127.0.0.1:8080/path",
	}

	for rawURL, want := range tests {
		if got := canonicalFreeProxyURL(rawURL); got != want {
			t.Errorf("canonicalFreeProxyURL(%q) = %q, want %q", rawURL, got, want)
		}
	}
}

func TestIPLocateCountryFromURL(t *testing.T) {
	tests := map[string]string{
		"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/DE/proxies.txt": "de",
		"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/GB/proxies.txt": "uk",
		"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt":          "",
		"https://example.test/countries/invalid":                                                   "",
	}

	for rawURL, want := range tests {
		if got := iplocateCountryFromURL(rawURL); got != want {
			t.Errorf("iplocateCountryFromURL(%q) = %q, want %q", rawURL, got, want)
		}
	}
}

func TestFreeProxySourcePrefersKnownURLProvider(t *testing.T) {
	tests := map[string]string{
		"https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt": "iplocate",
		proxyScrapeFallbackURL: "proxyscrape",
		proxiflyHTTPListURL:    "proxifly",
		proxiflyHTTPSListURL:   "proxifly",
		databayHTTPListURL:     "databay:http",
		databaySOCKS4ListURL:   "databay:socks4",
		databaySOCKS5ListURL:   "databay:socks5",
		monosansProxyListURL:   "monosans",
	}

	for importURL, want := range tests {
		if got := freeProxySource(nil, importURL); got != want {
			t.Errorf("freeProxySource(nil, %q) = %q, want %q", importURL, got, want)
		}
	}
}

func TestDefaultSchemeForImportURL(t *testing.T) {
	tests := map[string]string{
		databaySOCKS4ListURL:  "socks4",
		databaySOCKS5ListURL:  "socks5",
		databayHTTPListURL:    "http",
		proxiflyHTTPListURL:   "http",
		proxiflyHTTPSListURL:  "https",
		proxiflySOCKS4ListURL: "socks4",
		proxiflySOCKS5ListURL: "socks5",
	}

	for importURL, want := range tests {
		if got := defaultSchemeForImportURL(importURL); got != want {
			t.Errorf("defaultSchemeForImportURL(%q) = %q, want %q", importURL, got, want)
		}
	}
}
