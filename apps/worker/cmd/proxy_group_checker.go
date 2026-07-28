package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"
)

const (
	proxyGroupCheckMaximumSize = 100
	proxyGroupCheckConcurrency = 10
	proxyGroupCheckMaxLatency  = 5_000
	proxyGroupCheckSlowLatency = 2_500
	proxyGroupCheckJobTimeout  = 2 * time.Minute
)

var proxyGroupCheckRunning atomic.Bool

type indexedProxyCandidate struct {
	index    int
	proxyURL string
}

type proxyGroupCheckSummary struct {
	total   int
	working int
	slow    int
	failed  int
	results []database.ProxyGroupCheckResult
}

func processProxyGroupCheckJob(ctx context.Context, store *database.Store) {
	if !proxyGroupCheckRunning.CompareAndSwap(false, true) {
		return
	}
	defer proxyGroupCheckRunning.Store(false)

	claimCtx, cancelClaim := context.WithTimeout(ctx, 5*time.Second)
	job, err := store.ClaimProxyGroupCheckJobContext(claimCtx, proxyGroupCheckMaximumSize)
	cancelClaim()
	if err != nil {
		log.Printf("proxy group check claim failed: %v", err)
		return
	}
	if job == nil {
		return
	}

	jobCtx, cancelJob := context.WithTimeout(ctx, proxyGroupCheckJobTimeout)
	summary, checkErr := runProxyGroupCheck(jobCtx, store, *job)
	cancelJob()

	writeCtx, cancelWrite := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelWrite()
	if checkErr != nil {
		if err := store.FailProxyGroupCheckJobContext(writeCtx, job.ID, checkErr.Error()); err != nil {
			log.Printf("proxy group check %d failure persistence failed: %v", job.ID, err)
		}
		log.Printf("proxy group check %d failed in region %s: %v", job.ID, job.Region, checkErr)
		return
	}
	if err := store.CompleteProxyGroupCheckJobContext(
		writeCtx,
		job.ID,
		summary.total,
		summary.working,
		summary.slow,
		summary.failed,
		summary.results,
	); err != nil {
		log.Printf("proxy group check %d completion persistence failed: %v", job.ID, err)
		return
	}
	log.Printf(
		"proxy group check %d completed for region %s: %d working, %d slow, %d failed",
		job.ID,
		job.Region,
		summary.working,
		summary.slow,
		summary.failed,
	)
}

func runProxyGroupCheck(
	ctx context.Context,
	store *database.Store,
	job database.ProxyGroupCheckJob,
) (proxyGroupCheckSummary, error) {
	manager := proxy.FromString(job.Proxies)
	total := min(manager.Count(), job.Total, proxyGroupCheckMaximumSize)
	if total < 1 {
		return proxyGroupCheckSummary{}, errors.New("proxy group contains no valid proxies")
	}

	candidates := make(chan indexedProxyCandidate)
	results := make(chan database.ProxyGroupCheckResult, proxyGroupCheckConcurrency)
	var workers sync.WaitGroup
	for range proxyGroupCheckConcurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for candidate := range candidates {
				validationCtx, cancelValidation := context.WithTimeout(ctx, 8*time.Second)
				validation, err := scraper.ValidateFreeProxy(
					validationCtx,
					candidate.proxyURL,
					job.Region,
					proxyGroupCheckMaxLatency,
				)
				cancelValidation()
				outcome := proxyGroupCheckOutcome(candidate, validation, err)
				select {
				case results <- outcome:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		defer close(candidates)
		for index := range total {
			candidate := indexedProxyCandidate{
				index:    index,
				proxyURL: manager.Next(),
			}
			select {
			case candidates <- candidate:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		workers.Wait()
		close(results)
	}()

	summary := proxyGroupCheckSummary{
		total:   total,
		results: make([]database.ProxyGroupCheckResult, 0, total),
	}
	for result := range results {
		summary.results = append(summary.results, result)
		switch result.Status {
		case "working":
			summary.working++
		case "slow":
			summary.slow++
		default:
			summary.failed++
		}
		checked := len(summary.results)
		if checked%5 == 0 || checked == total {
			progressCtx, cancelProgress := context.WithTimeout(ctx, 2*time.Second)
			err := store.UpdateProxyGroupCheckProgressContext(
				progressCtx,
				job.ID,
				total,
				checked,
				summary.working,
				summary.slow,
				summary.failed,
			)
			cancelProgress()
			if err != nil && ctx.Err() == nil {
				log.Printf("proxy group check %d progress persistence failed: %v", job.ID, err)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return proxyGroupCheckSummary{}, fmt.Errorf("proxy check timed out or was canceled: %w", err)
	}
	if len(summary.results) != total {
		return proxyGroupCheckSummary{}, fmt.Errorf(
			"proxy check stopped after %d of %d results",
			len(summary.results),
			total,
		)
	}
	sort.Slice(summary.results, func(left int, right int) bool {
		return summary.results[left].Index < summary.results[right].Index
	})
	return summary, nil
}

func proxyGroupCheckOutcome(
	candidate indexedProxyCandidate,
	validation scraper.FreeProxyValidationResult,
	err error,
) database.ProxyGroupCheckResult {
	result := database.ProxyGroupCheckResult{
		Index:  candidate.index,
		Label:  safeProxyLabel(candidate.proxyURL),
		Status: "working",
	}
	if validation.LatencyMs > 0 {
		latency := validation.LatencyMs
		result.LatencyMS = &latency
	}
	if err == nil {
		if validation.LatencyMs > proxyGroupCheckSlowLatency {
			errorCode := "latency"
			result.Status = "slow"
			result.ErrorCode = &errorCode
		}
		return result
	}

	result.Status = "failed"
	errorCode := validation.ErrorCode
	if errorCode == "" {
		errorCode = "unknown"
	}
	if errorCode == "latency" {
		result.Status = "slow"
	}
	result.ErrorCode = &errorCode
	return result
}

func safeProxyLabel(proxyURL string) string {
	parsed, err := url.Parse(proxyURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "proxy"
	}
	return parsed.Scheme + "://" + parsed.Host
}
