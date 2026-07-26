package main

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"vintrack-worker/internal/database"
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
	existing := map[string]string{
		"http://existing-a:80": "http://existing-a:80",
		"http://existing-b:80": "http://existing-b:80",
	}

	got, newCount := selectFreeProxyImportCandidates(sources, existing, 3)
	want := []database.FreeProxyRecord{
		{ProxyURL: "http://existing-a:80", Source: "iplocate:de"},
		{ProxyURL: "http://existing-b:80", Source: "iplocate"},
		{ProxyURL: "http://new-a:80", Source: "iplocate:de"},
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

func TestSelectFreeProxyImportCandidatesRotatesOversizedPool(t *testing.T) {
	sources := [][]freeProxyImportCandidate{{
		{ProxyURL: "http://new:80", Source: "iplocate"},
		{ProxyURL: "http://existing-a:80", Source: "iplocate"},
		{ProxyURL: "http://existing-b:80", Source: "iplocate"},
		{ProxyURL: "http://existing-c:80", Source: "iplocate"},
	}}
	existing := map[string]string{
		"http://existing-a:80": "http://existing-a:80",
		"http://existing-b:80": "http://existing-b:80",
		"http://existing-c:80": "http://existing-c:80",
		"http://existing-d:80": "http://existing-d:80",
	}

	got, newCount := selectFreeProxyImportCandidates(sources, existing, 3)

	if len(got) != 3 {
		t.Fatalf("selected candidate count = %d, want 3", len(got))
	}
	if newCount != 1 {
		t.Fatalf("new candidate count = %d, want 1", newCount)
	}
	if got[0].ProxyURL != "http://new:80" {
		t.Fatalf("first selected candidate = %q, want new proxy", got[0].ProxyURL)
	}
}

func TestSelectFreeProxyImportCandidatesReusesStoredURLVariant(t *testing.T) {
	sources := [][]freeProxyImportCandidate{{
		{ProxyURL: "http://existing:80", Source: "iplocate"},
	}}
	existing := map[string]string{
		"http://existing:80": "http://existing:80/",
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
		proxiflyProxyListURL:   "proxifly",
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
		databaySOCKS4ListURL: "socks4",
		databaySOCKS5ListURL: "socks5",
		proxiflyProxyListURL: "http",
	}

	for importURL, want := range tests {
		if got := defaultSchemeForImportURL(importURL); got != want {
			t.Errorf("defaultSchemeForImportURL(%q) = %q, want %q", importURL, got, want)
		}
	}
}
