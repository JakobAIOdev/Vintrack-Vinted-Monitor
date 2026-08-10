package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisCache struct {
	client   *redis.Client
	ctx      context.Context
	opts     *redis.Options
	mu       sync.Mutex
	readonly bool
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
	return &RedisCache{client: client, ctx: ctx, opts: opts}, nil
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

func (r *RedisCache) BatchIsNew(monitorID int, itemIDs []int64) (map[int64]bool, error) {
	if len(itemIDs) == 0 {
		return make(map[int64]bool), nil
	}

	pipe := r.client.Pipeline()
	cmds := make(map[int64]*redis.IntCmd, len(itemIDs))

	for _, id := range itemIDs {
		cmds[id] = pipe.Exists(r.ctx, fmt.Sprintf("item:seen:%d:%d", monitorID, id))
	}

	if _, err := pipe.Exec(r.ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("pipeline exec: %w", err)
	}

	result := make(map[int64]bool, len(itemIDs))
	for id, cmd := range cmds {
		val, _ := cmd.Result()
		result[id] = val == 0 // 0 = not seen = new
	}
	return result, nil
}

func (r *RedisCache) MarkAsSeen(monitorID int, itemID int64) error {
	return r.writeWithRetry(func() error {
		return r.client.Set(r.ctx, fmt.Sprintf("item:seen:%d:%d", monitorID, itemID), "1", 30*24*time.Hour).Err()
	})
}

func (r *RedisCache) BatchMarkAsSeen(monitorID int, itemIDs []int64) error {
	if len(itemIDs) == 0 {
		return nil
	}
	return r.writeWithRetry(func() error {
		pipe := r.client.Pipeline()
		for _, id := range itemIDs {
			pipe.Set(r.ctx, fmt.Sprintf("item:seen:%d:%d", monitorID, id), "1", 30*24*time.Hour)
		}
		_, err := pipe.Exec(r.ctx)
		if err != nil && err != redis.Nil {
			return fmt.Errorf("batch mark-seen pipeline: %w", err)
		}
		return nil
	})
}

func (r *RedisCache) ClaimMonitorItem(monitorID int, itemID int64, source string) (bool, error) {
	key := fmt.Sprintf("item:seen:%d:%d", monitorID, itemID)
	if strings.TrimSpace(source) == "" {
		source = "canonical"
	}

	var claimed bool
	err := r.writeWithRetry(func() error {
		ok, err := r.client.SetNX(r.ctx, key, source, 30*24*time.Hour).Result()
		claimed = ok
		return err
	})
	if err != nil {
		return false, err
	}
	return claimed, nil
}

func (r *RedisCache) ClaimUserItemAlert(userID string, itemID int64) (bool, error) {
	key := fmt.Sprintf("item:alerted:%s:%d", userID, itemID)
	var claimed bool
	err := r.writeWithRetry(func() error {
		ok, err := r.client.SetNX(r.ctx, key, "1", 30*24*time.Hour).Result()
		claimed = ok
		return err
	})
	if err != nil {
		return false, err
	}
	return claimed, nil
}

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
	_ = r.writeWithRetry(func() error {
		return r.client.Set(r.ctx, fmt.Sprintf("user:region:%d", userID), region, 7*24*time.Hour).Err()
	})
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

func (r *RedisCache) PublishNewItem(item interface{}) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("marshal item: %w", err)
	}
	return r.writeWithRetry(func() error {
		return r.client.Publish(r.ctx, "vinted:new_items", payload).Err()
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
