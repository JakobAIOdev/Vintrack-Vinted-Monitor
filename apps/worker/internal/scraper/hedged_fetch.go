package scraper

import (
	"context"
	"fmt"
	"time"

	"vintrack-worker/internal/model"
)

type catalogFetchResult struct {
	items    []model.VintedItem
	status   int
	err      error
	client   *Client
	duration time.Duration
	attempts []catalogFetchAttempt
}

type catalogFetchAttempt struct {
	status   int
	err      error
	client   *Client
	duration time.Duration
}

func (e *Engine) fetchCatalogHedged(ctx context.Context, pool *ClientPool, apiURL string, domain string) catalogFetchResult {
	hedgeDelay := time.Duration(getEnvInt("CATALOG_HEDGE_DELAY_MS", 250)) * time.Millisecond
	return e.fetchCatalogHedgedWithDelay(ctx, pool, apiURL, domain, hedgeDelay)
}

func (e *Engine) fetchCatalogHedgedWithDelay(ctx context.Context, pool *ClientPool, apiURL string, domain string, hedgeDelay time.Duration) catalogFetchResult {
	if pool == nil {
		startedAt := time.Now()
		items, status, err := e.fetcher.FetchCatalog(ctx, nil, apiURL, domain)
		return catalogFetchResult{items: items, status: status, err: err, duration: time.Since(startedAt)}
	}

	maxAttempts := getEnvInt("CATALOG_MAX_ATTEMPTS", 5)
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	if pool.Size() < maxAttempts {
		maxAttempts = pool.Size()
	}

	attempted := make(map[*Client]bool, maxAttempts)
	primary := pool.AcquireExcluding(attempted)
	if primary == nil {
		if waitErr := pool.WaitError(); waitErr != nil {
			return catalogFetchResult{err: waitErr}
		}
		return catalogFetchResult{err: fmt.Errorf("no healthy catalog client available")}
	}

	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make(chan catalogFetchResult, maxAttempts)
	launch := func(client *Client) {
		attempted[client] = true
		go func() {
			startedAt := time.Now()
			items, status, err := e.fetcher.FetchCatalog(requestCtx, client, apiURL, domain)
			duration := time.Since(startedAt)
			pool.Report(client, status, duration, err)
			results <- catalogFetchResult{
				items: items, status: status, err: err, client: client, duration: duration,
			}
		}()
	}

	launch(primary)
	launched := 1
	completed := 0
	if hedgeDelay < 0 {
		hedgeDelay = 0
	}
	timer := time.NewTimer(hedgeDelay)
	defer timer.Stop()
	hedgeTimer := timer.C

	launchNext := func() bool {
		if launched >= maxAttempts {
			return false
		}
		next := pool.AcquireExcluding(attempted)
		if next == nil {
			return false
		}
		launched++
		launch(next)
		return true
	}

	last := catalogFetchResult{}
	attempts := make([]catalogFetchAttempt, 0, maxAttempts)
	for completed < launched {
		select {
		case result := <-results:
			completed++
			last = result
			attempts = append(attempts, catalogFetchAttempt{
				status: result.status, err: result.err, client: result.client, duration: result.duration,
			})
			if result.err == nil && result.status == 200 {
				result.attempts = attempts
				return result
			}
			launchNext()
		case <-hedgeTimer:
			hedgeTimer = nil
			launchNext()
		case <-ctx.Done():
			if last.err == nil {
				last.err = ctx.Err()
			}
			last.attempts = attempts
			return last
		}
	}

	last.attempts = attempts
	return last
}
