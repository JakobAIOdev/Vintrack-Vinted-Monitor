package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

type VintedSession struct {
	UserID       string `json:"user_id"`
	VintedUserID int64  `json:"vinted_user_id"`
	VintedName   string `json:"vinted_name"`
	AccessToken  string `json:"access_token"`
	Domain       string `json:"domain"`
	Status       string `json:"status"`
	LinkedAt     string `json:"linked_at"`
	LastCheck    string `json:"last_check"`
}

type Manager struct {
	redis *redis.Client
	ctx   context.Context
}

func NewManager(redisAddr, redisPassword string) (*Manager, error) {
	client := redis.NewClient(&redis.Options{
		Addr:         redisAddr,
		Password:     redisPassword,
		DB:           0,
		PoolSize:     10,
		MinIdleConns: 2,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})

	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	log.Printf("Session manager connected to Redis: %s", redisAddr)
	return &Manager{redis: client, ctx: ctx}, nil
}

func (m *Manager) Close() error {
	return m.redis.Close()
}

func (m *Manager) sessionKey(userID string) string {
	return fmt.Sprintf("vinted:session:%s", userID)
}

func (m *Manager) Store(sess VintedSession) error {
	data, err := json.Marshal(sess)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}
	return m.redis.Set(m.ctx, m.sessionKey(sess.UserID), data, 7*24*time.Hour).Err()
}

func (m *Manager) Get(userID string) (*VintedSession, error) {
	data, err := m.redis.Get(m.ctx, m.sessionKey(userID)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sess VintedSession
	if err := json.Unmarshal(data, &sess); err != nil {
		return nil, err
	}
	return &sess, nil
}

func (m *Manager) Delete(userID string) error {
	return m.redis.Del(m.ctx, m.sessionKey(userID)).Err()
}

func (m *Manager) GetAllSessions() ([]VintedSession, error) {
	keys, err := m.redis.Keys(m.ctx, "vinted:session:*").Result()
	if err != nil {
		return nil, err
	}
	var sessions []VintedSession
	for _, key := range keys {
		data, err := m.redis.Get(m.ctx, key).Bytes()
		if err != nil {
			continue
		}
		var sess VintedSession
		if err := json.Unmarshal(data, &sess); err != nil {
			continue
		}
		sessions = append(sessions, sess)
	}
	return sessions, nil
}

func (m *Manager) likesKey(userID string) string {
	return fmt.Sprintf("vinted:likes:%s", userID)
}

func (m *Manager) AddLike(userID string, itemID int64) error {
	return m.redis.SAdd(m.ctx, m.likesKey(userID), itemID).Err()
}

func (m *Manager) RemoveLike(userID string, itemID int64) error {
	return m.redis.SRem(m.ctx, m.likesKey(userID), itemID).Err()
}

func (m *Manager) GetLikes(userID string) ([]int64, error) {
	vals, err := m.redis.SMembers(m.ctx, m.likesKey(userID)).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(vals))
	for _, v := range vals {
		var id int64
		if _, err := fmt.Sscanf(v, "%d", &id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (m *Manager) DeleteLikes(userID string) error {
	return m.redis.Del(m.ctx, m.likesKey(userID)).Err()
}

func (m *Manager) StartKeepAlive(validateFn func(sess *VintedSession) bool) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		sessions, err := m.GetAllSessions()
		if err != nil {
			log.Printf("[keep-alive] error fetching sessions: %v", err)
			continue
		}

		for _, sess := range sessions {
			if sess.Status != "active" {
				continue
			}

			valid := validateFn(&sess)
			if valid {
				sess.LastCheck = time.Now().UTC().Format(time.RFC3339)
				sess.Status = "active"
			} else {
				log.Printf("[keep-alive] session expired for user %s (@%s)", sess.UserID, sess.VintedName)
				sess.Status = "expired"
			}
			if err := m.Store(sess); err != nil {
				log.Printf("[keep-alive] failed to update session for %s: %v", sess.UserID, err)
			}
		}

		log.Printf("[keep-alive] checked %d sessions", len(sessions))
	}
}
