package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisCache struct {
	client *redis.Client
	ctx    context.Context
}

func NewRedisCache(addr, password string, db int) (*RedisCache, error) {
	client := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		PoolSize:     50,
		MinIdleConns: 10,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})

	ctx := context.Background()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	log.Printf("Redis connected: %s", addr)
	return &RedisCache{client: client, ctx: ctx}, nil
}

func (r *RedisCache) BatchIsNew(itemIDs []int64) (map[int64]bool, error) {
	if len(itemIDs) == 0 {
		return make(map[int64]bool), nil
	}

	pipe := r.client.Pipeline()
	cmds := make(map[int64]*redis.IntCmd, len(itemIDs))

	for _, id := range itemIDs {
		cmds[id] = pipe.Exists(r.ctx, fmt.Sprintf("item:seen:%d", id))
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

func (r *RedisCache) MarkAsSeen(itemID int64) error {
	return r.client.Set(r.ctx, fmt.Sprintf("item:seen:%d", itemID), "1", 30*24*time.Hour).Err()
}

func (r *RedisCache) GetUserRegion(userID int64) (string, bool) {
	val, err := r.client.Get(r.ctx, fmt.Sprintf("user:region:%d", userID)).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

func (r *RedisCache) SetUserRegion(userID int64, region string) {
	r.client.Set(r.ctx, fmt.Sprintf("user:region:%d", userID), region, 7*24*time.Hour)
}

func (r *RedisCache) PublishNewItem(item interface{}) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("marshal item: %w", err)
	}
	return r.client.Publish(r.ctx, "vinted:new_items", payload).Err()
}

func (r *RedisCache) Close() error {
	return r.client.Close()
}
