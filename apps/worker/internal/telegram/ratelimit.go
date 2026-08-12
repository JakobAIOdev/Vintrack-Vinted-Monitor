package telegram

import (
	"context"
	"log"
	"os"
	"strconv"
	"sync"
	"time"
)

// Telegram allows roughly 30 bot messages per second across all chats for a
// single token. Vintrack serves every member from one token, so the send rate
// has to be paced deliberately instead of being discovered through bot-wide
// 429s that penalise every chat at once.
const (
	defaultGlobalRatePerSecond = 25
	defaultGlobalBurst         = 25

	// A 429 that asks for at least this long is the bot-wide flood limit rather
	// than a per-chat one, which reports about a second.
	globalPauseThreshold = 2 * time.Second

	authFailureLogInterval = time.Minute
)

// tokenBucket is a virtual-time leaky bucket. Each caller reserves its own slot
// and sleeps until that slot opens, so waiters are served first-come
// first-served without busy-waiting and without an extra dependency.
type tokenBucket struct {
	mu          sync.Mutex
	interval    time.Duration
	burst       time.Duration
	nextFree    time.Time
	pausedUntil time.Time
}

var globalLimiter = newGlobalLimiter()

func newGlobalLimiter() *tokenBucket {
	rate := envInt("TELEGRAM_GLOBAL_RATE_PER_SECOND", defaultGlobalRatePerSecond)
	if rate < 1 {
		rate = 1
	}
	burst := envInt("TELEGRAM_GLOBAL_BURST", defaultGlobalBurst)
	if burst < 1 {
		burst = 1
	}
	interval := time.Second / time.Duration(rate)
	return &tokenBucket{interval: interval, burst: time.Duration(burst) * interval}
}

// reserve claims the next slot and reports how long the caller must wait for it.
func (b *tokenBucket) reserve(now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()

	if earliest := now.Add(-b.burst); b.nextFree.Before(earliest) {
		b.nextFree = earliest
	}
	if b.pausedUntil.After(b.nextFree) {
		b.nextFree = b.pausedUntil
	}

	start := b.nextFree
	b.nextFree = start.Add(b.interval)
	if start.After(now) {
		return start.Sub(now)
	}
	return 0
}

// pause holds the whole bucket back, used when Telegram reports a bot-wide 429.
func (b *tokenBucket) pause(d time.Duration) {
	if d <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if until := time.Now().Add(d); until.After(b.pausedUntil) {
		b.pausedUntil = until
		log.Printf("[telegram] bot-wide rate limit; pausing sends for %s", d.Truncate(time.Millisecond))
	}
}

// reset clears all pacing state. Tests share the process-global limiter, so a
// pause recorded by one case would otherwise stall every case after it.
func (b *tokenBucket) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextFree = time.Time{}
	b.pausedUntil = time.Time{}
}

func (b *tokenBucket) wait(ctx context.Context) error {
	delay := b.reserve(time.Now())
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

var (
	authFailureLogMu    sync.Mutex
	authFailureLoggedAt time.Time
)

// logAuthenticationFailure surfaces a rejected bot token on stdout. It affects
// every member at once, so it must be visible without querying alert_events,
// but it also repeats per delivery and has to stay throttled.
func logAuthenticationFailure(status int) {
	authFailureLogMu.Lock()
	defer authFailureLogMu.Unlock()
	if time.Since(authFailureLoggedAt) < authFailureLogInterval {
		return
	}
	authFailureLoggedAt = time.Now()
	log.Printf(
		"[telegram] bot authentication failed (HTTP %d): TELEGRAM_BOT_TOKEN is rejected, all telegram alerts are failing",
		status,
	)
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}
