package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisCache struct {
	client           *redis.Client
	ctx              context.Context
	opts             *redis.Options
	mu               sync.Mutex
	readonly         bool
	scanMu           sync.Mutex
	scanCursor       uint64
	scanCounts       map[string]uint64
	lastPrefixCounts map[string]uint64
	lastPrefixScanAt time.Time
	v2Claims         atomic.Uint64
}

type SellerInfo struct {
	Region          string    `json:"region"`
	Rating          string    `json:"rating"`
	RatingStars     float64   `json:"rating_stars"`
	RatingCount     int       `json:"rating_count"`
	RatingAvailable bool      `json:"rating_available"`
	FetchedAt       time.Time `json:"fetched_at"`
}

func NewRedisCache(addr, password string, db int) (*RedisCache, error) {
	opts := &redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		PoolSize:     50,
		MinIdleConns: 10,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	}

	client := redis.NewClient(opts)
	ctx := context.Background()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	log.Printf("Redis connected: %s", addr)
	return &RedisCache{
		client: client, ctx: ctx, opts: opts,
		scanCounts:       make(map[string]uint64),
		lastPrefixCounts: make(map[string]uint64),
	}, nil
}

func isReadOnlyErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "READONLY")
}

func (r *RedisCache) reconnect() {
	r.mu.Lock()
	defer r.mu.Unlock()

	_ = r.client.Close()
	r.client = redis.NewClient(r.opts)

	if err := r.client.Ping(r.ctx).Err(); err != nil {
		log.Printf("redis reconnect ping failed: %v", err)
	} else {
		log.Printf("redis reconnected successfully")
		r.readonly = false
	}
}

func (r *RedisCache) writeWithRetry(op func() error) error {
	err := op()
	if isReadOnlyErr(err) {
		if !r.readonly {
			log.Printf("redis READONLY detected, attempting reconnect...")
			r.readonly = true
		}
		r.reconnect()
		return op()
	}
	if err == nil && r.readonly {
		r.readonly = false
	}
	return err
}

const (
	seenBucketDays = 8
	seenItemTTL    = seenBucketDays * 24 * time.Hour
)

func seenBucketKey(monitorID int, day time.Time) string {
	return fmt.Sprintf("item:seen:v2:%d:%s", monitorID, day.UTC().Format("2006-01-02"))
}

func seenBucketKeys(monitorID int, now time.Time) []string {
	keys := make([]string, 0, seenBucketDays)
	day := now.UTC()
	for offset := 0; offset < seenBucketDays; offset++ {
		keys = append(keys, seenBucketKey(monitorID, day.AddDate(0, 0, -offset)))
	}
	return keys
}

func seenBucketExpiresAt(now time.Time) time.Time {
	day := now.UTC()
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	return start.AddDate(0, 0, seenBucketDays)
}

func (r *RedisCache) BatchIsNew(monitorID int, itemIDs []int64) (map[int64]bool, error) {
	if len(itemIDs) == 0 {
		return make(map[int64]bool), nil
	}

	pipe := r.client.Pipeline()
	legacy := make(map[int64]*redis.IntCmd, len(itemIDs))
	members := make([]interface{}, 0, len(itemIDs))

	for _, id := range itemIDs {
		legacy[id] = pipe.Exists(r.ctx, fmt.Sprintf("item:seen:%d:%d", monitorID, id))
		members = append(members, id)
	}
	bucketCommands := make([]*redis.BoolSliceCmd, 0, seenBucketDays)
	for _, key := range seenBucketKeys(monitorID, time.Now()) {
		bucketCommands = append(bucketCommands, pipe.SMIsMember(r.ctx, key, members...))
	}

	if _, err := pipe.Exec(r.ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("pipeline exec: %w", err)
	}

	result := make(map[int64]bool, len(itemIDs))
	for index, id := range itemIDs {
		cmd := legacy[id]
		val, _ := cmd.Result()
		seen := val > 0
		for _, bucket := range bucketCommands {
			values, bucketErr := bucket.Result()
			if bucketErr != nil {
				return nil, fmt.Errorf("smismember: %w", bucketErr)
			}
			if index < len(values) && values[index] {
				seen = true
				break
			}
		}
		result[id] = !seen
	}
	return result, nil
}

func (r *RedisCache) MarkAsSeen(monitorID int, itemID int64) error {
	return r.writeWithRetry(func() error {
		now := time.Now()
		pipe := r.client.TxPipeline()
		key := seenBucketKey(monitorID, now)
		pipe.SAdd(r.ctx, key, itemID)
		pipe.ExpireAt(r.ctx, key, seenBucketExpiresAt(now))
		_, err := pipe.Exec(r.ctx)
		return err
	})
}

func (r *RedisCache) BatchMarkAsSeen(monitorID int, itemIDs []int64) error {
	if len(itemIDs) == 0 {
		return nil
	}
	return r.writeWithRetry(func() error {
		now := time.Now()
		key := seenBucketKey(monitorID, now)
		members := make([]interface{}, 0, len(itemIDs))
		for _, id := range itemIDs {
			members = append(members, id)
		}
		pipe := r.client.TxPipeline()
		pipe.SAdd(r.ctx, key, members...)
		pipe.ExpireAt(r.ctx, key, seenBucketExpiresAt(now))
		_, err := pipe.Exec(r.ctx)
		if err != nil && err != redis.Nil {
			return fmt.Errorf("batch mark-seen pipeline: %w", err)
		}
		return nil
	})
}

func (r *RedisCache) ClaimMonitorItem(monitorID int, itemID int64, source string) (bool, error) {
	if strings.TrimSpace(source) == "" {
		source = "canonical"
	}
	now := time.Now()
	keys := append(
		[]string{fmt.Sprintf("item:seen:%d:%d", monitorID, itemID)},
		seenBucketKeys(monitorID, now)...,
	)

	var claimed bool
	err := r.writeWithRetry(func() error {
		value, err := claimMonitorItemScript.Run(
			r.ctx,
			r.client,
			keys,
			strconv.FormatInt(itemID, 10),
			source,
			seenBucketExpiresAt(now).Unix(),
		).Int()
		claimed = value == 1
		if claimed {
			r.v2Claims.Add(1)
		}
		return err
	})
	if err != nil {
		return false, err
	}
	return claimed, nil
}

func redisMetricValue(info string, key string) uint64 {
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, key+":") {
			continue
		}
		value, _ := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, key+":")), 10, 64)
		return value
	}
	return 0
}

func redisKeyPrefix(key string) string {
	switch {
	case strings.HasPrefix(key, "item:seen:v2:"):
		return "item_seen_v2"
	case strings.HasPrefix(key, "item:seen:"):
		return "item_seen_legacy"
	case strings.HasPrefix(key, "seller:info:"):
		return "seller_info"
	case strings.HasPrefix(key, "user:region:"):
		return "user_region_legacy"
	case strings.HasPrefix(key, "monitor:health:"):
		return "monitor_health"
	default:
		return "other"
	}
}

// RuntimeMetrics performs at most 20 bounded SCAN pages. Prefix counts become
// an exact snapshot whenever a full cursor pass completes; INFO/DBSIZE values
// are current on every call.
func (r *RedisCache) RuntimeMetrics(ctx context.Context) map[string]any {
	info, _ := r.client.Info(ctx, "memory", "stats").Result()
	dbSize, _ := r.client.DBSize(ctx).Result()
	r.scanMu.Lock()
	for page := 0; page < 20; page++ {
		keys, cursor, err := r.client.Scan(ctx, r.scanCursor, "*", 1000).Result()
		if err != nil {
			break
		}
		for _, key := range keys {
			r.scanCounts[redisKeyPrefix(key)]++
		}
		r.scanCursor = cursor
		if cursor == 0 {
			r.lastPrefixCounts = r.scanCounts
			r.lastPrefixScanAt = time.Now().UTC()
			r.scanCounts = make(map[string]uint64)
			break
		}
	}
	prefixCounts := make(map[string]uint64, len(r.lastPrefixCounts))
	for prefix, count := range r.lastPrefixCounts {
		prefixCounts[prefix] = count
	}
	scannedAt := r.lastPrefixScanAt
	r.scanMu.Unlock()
	return map[string]any{
		"dbSize":                  dbSize,
		"usedMemoryBytes":         redisMetricValue(info, "used_memory"),
		"maxMemoryBytes":          redisMetricValue(info, "maxmemory"),
		"evictedKeys":             redisMetricValue(info, "evicted_keys"),
		"keyCountsByPrefix":       prefixCounts,
		"prefixCountsCompletedAt": scannedAt.Format(time.RFC3339Nano),
		"v2Claims":                r.v2Claims.Load(),
		"updatedAt":               time.Now().UTC().Format(time.RFC3339Nano),
	}
}

var claimMonitorItemScript = redis.NewScript(`
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
for index = 2, #KEYS do
  if redis.call("SISMEMBER", KEYS[index], ARGV[1]) == 1 then
    return 0
  end
end
redis.call("SADD", KEYS[2], ARGV[1])
redis.call("EXPIREAT", KEYS[2], ARGV[3])
return 1
`)

func (r *RedisCache) GetUserRegion(userID int64) (string, bool) {
	return r.GetUserRegionContext(r.ctx, userID)
}

func (r *RedisCache) GetUserRegionContext(ctx context.Context, userID int64) (string, bool) {
	val, err := r.client.Get(ctx, fmt.Sprintf("user:region:%d", userID)).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

func (r *RedisCache) SetUserRegion(userID int64, region string) {
	// Kept as a no-op during the dual-read rollout. Existing region-only keys
	// remain readable and naturally expire; all new writes use seller:info.
}

func sellerInfoKey(domain string, userID int64) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	domain = strings.ReplaceAll(domain, ":", "_")
	return fmt.Sprintf("seller:info:%s:%d", domain, userID)
}

func (r *RedisCache) GetSellerInfo(ctx context.Context, domain string, userID int64) (SellerInfo, bool) {
	if userID <= 0 {
		return SellerInfo{}, false
	}
	payload, err := r.client.Get(ctx, sellerInfoKey(domain, userID)).Bytes()
	if err != nil {
		return SellerInfo{}, false
	}
	var info SellerInfo
	if err := json.Unmarshal(payload, &info); err != nil {
		return SellerInfo{}, false
	}
	return info, true
}

func (r *RedisCache) SetSellerInfo(ctx context.Context, domain string, userID int64, info SellerInfo, ttl time.Duration) error {
	if userID <= 0 {
		return nil
	}
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	payload, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return r.writeWithRetry(func() error {
		return r.client.Set(ctx, sellerInfoKey(domain, userID), payload, ttl).Err()
	})
}

// PublishNewItem sends a live-feed match to the owning member's channel.
//
// This used to publish to one global channel that every connected dashboard
// subscribed to, so every browser received every item found for every member
// and discarded almost all of them. Scoping the channel to the member makes the
// delivered volume proportional to the matches themselves.
func (r *RedisCache) PublishNewItem(userID string, item interface{}) error {
	if userID == "" {
		return nil
	}
	payload, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("marshal item: %w", err)
	}
	channel := fmt.Sprintf("vinted:new_items:%s", userID)
	return r.writeWithRetry(func() error {
		return r.client.Publish(r.ctx, channel, payload).Err()
	})
}

func (r *RedisCache) SetMonitorHealth(monitorID int, data []byte) error {
	key := fmt.Sprintf("monitor:health:%d", monitorID)
	return r.writeWithRetry(func() error {
		return r.client.Set(r.ctx, key, data, 10*time.Minute).Err()
	})
}

func (r *RedisCache) GetMonitorHealth(monitorID int) ([]byte, error) {
	key := fmt.Sprintf("monitor:health:%d", monitorID)
	return r.client.Get(r.ctx, key).Bytes()
}

func (r *RedisCache) GetMonitorHealthBatch(monitorIDs []int) (map[int][]byte, error) {
	if len(monitorIDs) == 0 {
		return make(map[int][]byte), nil
	}

	pipe := r.client.Pipeline()
	cmds := make(map[int]*redis.StringCmd, len(monitorIDs))

	for _, id := range monitorIDs {
		key := fmt.Sprintf("monitor:health:%d", id)
		cmds[id] = pipe.Get(r.ctx, key)
	}

	pipe.Exec(r.ctx)

	result := make(map[int][]byte, len(monitorIDs))
	for id, cmd := range cmds {
		val, err := cmd.Bytes()
		if err == nil {
			result[id] = val
		}
	}
	return result, nil
}

func (r *RedisCache) DeleteMonitorHealth(monitorID int) error {
	key := fmt.Sprintf("monitor:health:%d", monitorID)
	return r.writeWithRetry(func() error {
		return r.client.Del(r.ctx, key).Err()
	})
}

func (r *RedisCache) Close() error {
	return r.client.Close()
}
