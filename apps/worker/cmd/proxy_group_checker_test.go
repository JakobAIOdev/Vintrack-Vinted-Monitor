package main

import (
	"errors"
	"testing"

	"vintrack-worker/internal/scraper"
)

func TestSafeProxyLabelRemovesCredentials(t *testing.T) {
	label := safeProxyLabel("socks5://secret-user:secret-pass@127.0.0.1:1080")
	if label != "socks5://127.0.0.1:1080" {
		t.Fatalf("safeProxyLabel() = %q, want credentials removed", label)
	}
}

func TestProxyGroupCheckOutcomeClassifiesLatency(t *testing.T) {
	outcome := proxyGroupCheckOutcome(
		indexedProxyCandidate{index: 2, proxyURL: "http://127.0.0.1:8080"},
		scraper.FreeProxyValidationResult{LatencyMs: 5100, ErrorCode: "latency"},
		errors.New("too slow"),
	)
	if outcome.Status != "slow" || outcome.ErrorCode == nil || *outcome.ErrorCode != "latency" {
		t.Fatalf("proxyGroupCheckOutcome() = %#v, want slow latency result", outcome)
	}
}

func TestProxyGroupCheckOutcomeMarksSuccessfulButSlowProxy(t *testing.T) {
	outcome := proxyGroupCheckOutcome(
		indexedProxyCandidate{index: 3, proxyURL: "http://127.0.0.1:8080"},
		scraper.FreeProxyValidationResult{LatencyMs: 3000},
		nil,
	)
	if outcome.Status != "slow" || outcome.ErrorCode == nil || *outcome.ErrorCode != "latency" {
		t.Fatalf("proxyGroupCheckOutcome() = %#v, want successful slow result", outcome)
	}
}

func TestProxyGroupCheckOutcomeKeepsTransportFailureSanitized(t *testing.T) {
	outcome := proxyGroupCheckOutcome(
		indexedProxyCandidate{
			index:    1,
			proxyURL: "http://user:password@proxy.example:8080",
		},
		scraper.FreeProxyValidationResult{ErrorCode: "timeout"},
		errors.New("request contained sensitive upstream details"),
	)
	if outcome.Status != "failed" || outcome.Label != "http://proxy.example:8080" {
		t.Fatalf("proxyGroupCheckOutcome() = %#v, want sanitized failed result", outcome)
	}
	if outcome.ErrorCode == nil || *outcome.ErrorCode != "timeout" {
		t.Fatalf("proxyGroupCheckOutcome() error code = %#v, want timeout", outcome.ErrorCode)
	}
}
