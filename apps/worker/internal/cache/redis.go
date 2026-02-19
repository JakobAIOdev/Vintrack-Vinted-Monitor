package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisCache struct {
	client *redis.Client
	ctx    context.Context
}

func NewRedisCache(addr string, password string, db int) (*RedisCache, error) {
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
		return nil, fmt.Errorf("redis connection failed: %w", err)
	}

	fmt.Printf("Redis connected: %s\n", addr)

	return &RedisCache{
		client: client,
		ctx:    context.Background(),
	}, nil
}

func (r *RedisCache) IsNew(itemID int64) bool {
	key := fmt.Sprintf("item:seen:%d", itemID)

	exists, err := r.client.Exists(r.ctx, key).Result()
	if err != nil {
		fmt.Printf("Redis error in IsNew: %v\n", err)
		return true
	}

	return exists == 0
}

func (r *RedisCache) MarkAsSeen(itemID int64) error {
	key := fmt.Sprintf("item:seen:%d", itemID)

	err := r.client.Set(r.ctx, key, "1", 30*24*time.Hour).Err()
	if err != nil {
		return fmt.Errorf("failed to mark item as seen: %w", err)
	}

	return nil
}

func (r *RedisCache) BatchIsNew(itemIDs []int64) (map[int64]bool, error) {
	if len(itemIDs) == 0 {
		return make(map[int64]bool), nil
	}

	pipe := r.client.Pipeline()
	cmds := make(map[int64]*redis.IntCmd, len(itemIDs))

	for _, id := range itemIDs {
		key := fmt.Sprintf("item:seen:%d", id)
		cmds[id] = pipe.Exists(r.ctx, key)
	}

	_, err := pipe.Exec(r.ctx)
	if err != nil && err != redis.Nil {
		return nil, fmt.Errorf("redis pipeline exec failed: %w", err)
	}

	result := make(map[int64]bool, len(itemIDs))
	for id, cmd := range cmds {
		val, _ := cmd.Result()
		result[id] = val == 0
	}

	return result, nil
}

func (r *RedisCache) GetUserRegion(userID int64) (string, bool) {
	key := fmt.Sprintf("user:region:%d", userID)
	val, err := r.client.Get(r.ctx, key).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

func (r *RedisCache) SetUserRegion(userID int64, region string) {
	key := fmt.Sprintf("user:region:%d", userID)
	r.client.Set(r.ctx, key, region, 7*24*time.Hour)
}

func (r *RedisCache) GetStats() (int64, error) {
	return r.client.DBSize(r.ctx).Result()
}

func (r *RedisCache) Close() error {
	return r.client.Close()
}

func (r *RedisCache) Ping() error {
	return r.client.Ping(r.ctx).Err()
}

func (r *RedisCache) PublishNewItem(item interface{}) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return r.client.Publish(r.ctx, "vinted:new_items", payload).Err()
}
