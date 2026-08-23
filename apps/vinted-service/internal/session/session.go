package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

type VintedSession struct {
	UserID          string `json:"user_id"`
	VintedUserID    int64  `json:"vinted_user_id"`
	VintedName      string `json:"vinted_name"`
	AccessToken     string `json:"access_token"`
	RefreshToken    string `json:"refresh_token,omitempty"`
	CookieHeader    string `json:"cookie_header,omitempty"`
	CsrfToken       string `json:"csrf_token,omitempty"`
	AnonID          string `json:"anon_id,omitempty"`
	WarmedAt        string `json:"warmed_at,omitempty"`
	UserAgent       string `json:"user_agent,omitempty"`
	PhoneNumber     string `json:"phone_number,omitempty"`
	BrowserLinked   bool   `json:"browser_linked,omitempty"`
	LastBrowserSync string `json:"last_browser_sync,omitempty"`
	Domain          string `json:"domain"`
	Status          string `json:"status"`
	LinkedAt        string `json:"linked_at"`
	LastCheck       string `json:"last_check"`
	LastRefreshAt   string `json:"last_refresh_at,omitempty"`
	LastValidAt     string `json:"last_valid_at,omitempty"`
	InvalidReason   string `json:"invalid_reason,omitempty"`
}

type CheckoutLink struct {
	ItemID        int64  `json:"item_id"`
	SellerID      int64  `json:"seller_id"`
	TransactionID int64  `json:"transaction_id"`
	PurchaseID    string `json:"purchase_id,omitempty"`
	CheckoutURL   string `json:"checkout_url,omitempty"`
	PaymentURL    string `json:"payment_url,omitempty"`
	Domain        string `json:"domain,omitempty"`
	Status        string `json:"status"`
	CreatedAt     string `json:"created_at"`
}

type BrowserSyncRequest struct {
	Code        string `json:"code"`
	UserID      string `json:"user_id"`
	Status      string `json:"status"`
	Domain      string `json:"domain,omitempty"`
	VintedName  string `json:"vinted_name,omitempty"`
	VintedID    int64  `json:"vinted_id,omitempty"`
	Error       string `json:"error,omitempty"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
	CompletedAt string `json:"completed_at,omitempty"`
}

type BrowserLink struct {
	Token      string `json:"token"`
	UserID     string `json:"user_id"`
	CreatedAt  string `json:"created_at"`
	ExpiresAt  string `json:"expires_at"`
	LastUsedAt string `json:"last_used_at,omitempty"`
	Persistent bool   `json:"persistent,omitempty"`
}

type Manager struct {
	redis *redis.Client
	ctx   context.Context
	store *persistentStore
}

func NewManager(redisAddr, redisPassword, databaseURL, encryptionKey string) (*Manager, error) {
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

	var store *persistentStore
	if databaseURL != "" {
		var err error
		store, err = newPersistentStore(databaseURL, encryptionKey)
		if err != nil {
			_ = client.Close()
			return nil, err
		}
		log.Printf("Session manager connected to PostgreSQL durable session store")
	} else {
		log.Printf("Session manager running without durable PostgreSQL session store")
	}

	manager := &Manager{redis: client, ctx: ctx, store: store}
	if manager.store != nil {
		manager.migrateCachedSessionsToStore()
	}

	return manager, nil
}

func (m *Manager) Close() error {
	if m.store != nil {
		_ = m.store.Close()
	}
	return m.redis.Close()
}

func (m *Manager) sessionKey(userID string) string {
	return fmt.Sprintf("vinted:session:%s", userID)
}

func (m *Manager) migrateCachedSessionsToStore() {
	keys, err := m.redis.Keys(m.ctx, "vinted:session:*").Result()
	if err != nil {
		log.Printf("[session] failed to scan Redis sessions for durable migration: %v", err)
		return
	}
	if len(keys) == 0 {
		return
	}

	values, err := m.redis.MGet(m.ctx, keys...).Result()
	if err != nil {
		log.Printf("[session] failed to read Redis sessions for durable migration: %v", err)
		return
	}

	migrated := 0
	for _, val := range values {
		s, ok := val.(string)
		if !ok || s == "" {
			continue
		}

		var sess VintedSession
		if err := json.Unmarshal([]byte(s), &sess); err != nil || sess.UserID == "" || sess.AccessToken == "" {
			continue
		}
		if err := m.store.Save(m.ctx, sess); err != nil {
			log.Printf("[session] failed to migrate cached session for user %s: %v", sess.UserID, err)
			continue
		}
		migrated++
	}
	if migrated > 0 {
		log.Printf("[session] migrated %d cached Vinted session(s) to PostgreSQL", migrated)
	}
}

func (m *Manager) Store(sess VintedSession) error {
	if m.store != nil {
		if err := m.store.Save(m.ctx, sess); err != nil {
			return err
		}
	}

	return m.cacheSession(sess)
}

func (m *Manager) Get(userID string) (*VintedSession, error) {
	sess, err := m.getCached(userID)
	if err != nil {
		return nil, err
	}
	if sess != nil {
		return sess, nil
	}

	if m.store == nil {
		return nil, nil
	}

	sess, err = m.store.Get(m.ctx, userID)
	if err != nil || sess == nil {
		return sess, err
	}
	if err := m.cacheSession(*sess); err != nil {
		log.Printf("[session] failed to repopulate Redis cache for user %s: %v", userID, err)
	}
	return sess, nil
}

func (m *Manager) getCached(userID string) (*VintedSession, error) {
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

func (m *Manager) cacheSession(sess VintedSession) error {
	data, err := json.Marshal(sess)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}
	return m.redis.Set(m.ctx, m.sessionKey(sess.UserID), data, 7*24*time.Hour).Err()
}

func (m *Manager) refreshLockKey(userID string) string {
	return fmt.Sprintf("vinted:session-refresh-lock:%s", userID)
}

func (m *Manager) AcquireRefreshLock(userID string, ttl time.Duration) (string, bool, error) {
	token, err := m.newBrowserSyncCode()
	if err != nil {
		return "", false, err
	}
	ok, err := m.redis.SetNX(m.ctx, m.refreshLockKey(userID), token, ttl).Result()
	return token, ok, err
}

func (m *Manager) ReleaseRefreshLock(userID, token string) error {
	const script = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`
	return m.redis.Eval(m.ctx, script, []string{m.refreshLockKey(userID)}, token).Err()
}

func (m *Manager) Delete(userID string) error {
	if m.store != nil {
		if err := m.store.Delete(m.ctx, userID); err != nil {
			return err
		}
	}
	return m.redis.Del(m.ctx, m.sessionKey(userID)).Err()
}

func (m *Manager) GetAllSessions() ([]VintedSession, error) {
	if m.store != nil {
		sessions, err := m.store.List(m.ctx)
		if err != nil {
			return nil, err
		}
		for _, sess := range sessions {
			if err := m.cacheSession(sess); err != nil {
				log.Printf("[session] failed to cache durable session for user %s: %v", sess.UserID, err)
			}
		}
		return sessions, nil
	}

	keys, err := m.redis.Keys(m.ctx, "vinted:session:*").Result()
	if err != nil {
		return nil, err
	}

	if len(keys) == 0 {
		return []VintedSession{}, nil
	}

	values, err := m.redis.MGet(m.ctx, keys...).Result()
	if err != nil {
		return nil, err
	}

	sessions := make([]VintedSession, 0, len(values))
	for _, val := range values {
		if val == nil {
			continue
		}

		s, ok := val.(string)
		if !ok {
			continue
		}

		var sess VintedSession
		if err := json.Unmarshal([]byte(s), &sess); err != nil {
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

func (m *Manager) checkoutLinksKey(userID string) string {
	return fmt.Sprintf("vinted:checkout-links:%s", userID)
}

func (m *Manager) AddCheckoutLink(userID string, link CheckoutLink) error {
	data, err := json.Marshal(link)
	if err != nil {
		return fmt.Errorf("marshal checkout link: %w", err)
	}

	pipe := m.redis.TxPipeline()
	pipe.LPush(m.ctx, m.checkoutLinksKey(userID), data)
	pipe.LTrim(m.ctx, m.checkoutLinksKey(userID), 0, 99)
	_, err = pipe.Exec(m.ctx)
	return err
}

func (m *Manager) GetCheckoutLinks(userID string) ([]CheckoutLink, error) {
	values, err := m.redis.LRange(m.ctx, m.checkoutLinksKey(userID), 0, 99).Result()
	if err != nil {
		return nil, err
	}

	links := make([]CheckoutLink, 0, len(values))
	for _, value := range values {
		var link CheckoutLink
		if err := json.Unmarshal([]byte(value), &link); err != nil {
			continue
		}
		links = append(links, link)
	}
	return links, nil
}

func (m *Manager) DeleteCheckoutLinks(userID string) error {
	return m.redis.Del(m.ctx, m.checkoutLinksKey(userID)).Err()
}

func (m *Manager) browserSyncKey(code string) string {
	return fmt.Sprintf("vinted:browser-sync:%s", code)
}

func (m *Manager) newBrowserSyncCode() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate browser sync code: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (m *Manager) CreateBrowserSyncRequest(userID string, ttl time.Duration) (*BrowserSyncRequest, error) {
	code, err := m.newBrowserSyncCode()
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	req := BrowserSyncRequest{
		Code:      code,
		UserID:    userID,
		Status:    "pending",
		CreatedAt: now.Format(time.RFC3339),
		ExpiresAt: now.Add(ttl).Format(time.RFC3339),
	}

	if err := m.StoreBrowserSyncRequest(req); err != nil {
		return nil, err
	}

	return &req, nil
}

func (m *Manager) StoreBrowserSyncRequest(req BrowserSyncRequest) error {
	expiresAt, err := time.Parse(time.RFC3339, req.ExpiresAt)
	if err != nil {
		return fmt.Errorf("parse browser sync expiry: %w", err)
	}

	ttl := time.Until(expiresAt)
	if ttl <= 0 {
		return fmt.Errorf("browser sync request expired")
	}

	data, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal browser sync request: %w", err)
	}

	return m.redis.Set(m.ctx, m.browserSyncKey(req.Code), data, ttl).Err()
}

func (m *Manager) GetBrowserSyncRequest(code string) (*BrowserSyncRequest, error) {
	data, err := m.redis.Get(m.ctx, m.browserSyncKey(code)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var req BrowserSyncRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, err
	}

	return &req, nil
}

func (m *Manager) browserLinkTokenKey(token string) string {
	return fmt.Sprintf("vinted:browser-link:token:%s", token)
}

func (m *Manager) browserLinkUserKey(userID string) string {
	return fmt.Sprintf("vinted:browser-link:user:%s", userID)
}

func browserLinkTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (m *Manager) CreateBrowserLink(userID string, ttl time.Duration) (*BrowserLink, error) {
	existingToken, err := m.redis.Get(m.ctx, m.browserLinkUserKey(userID)).Result()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if existingToken != "" {
		_ = m.redis.Del(m.ctx, m.browserLinkTokenKey(existingToken)).Err()
	}

	token, err := m.newBrowserSyncCode()
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	link := BrowserLink{
		Token:      token,
		UserID:     userID,
		CreatedAt:  now.Format(time.RFC3339),
		ExpiresAt:  now.Add(ttl).Format(time.RFC3339),
		Persistent: m.store != nil,
	}

	if err := m.StoreBrowserLink(link); err != nil {
		return nil, err
	}

	return &link, nil
}

func (m *Manager) StoreBrowserLink(link BrowserLink) error {
	if m.store != nil {
		link.Persistent = true
		if err := m.store.SaveBrowserLink(m.ctx, browserLinkTokenHash(link.Token), link); err != nil {
			return err
		}
	}
	return m.cacheBrowserLink(link)
}

func (m *Manager) cacheBrowserLink(link BrowserLink) error {
	expiresAt, err := time.Parse(time.RFC3339, link.ExpiresAt)
	if err != nil {
		return fmt.Errorf("parse browser link expiry: %w", err)
	}

	ttl := time.Until(expiresAt)
	if ttl <= 0 {
		return fmt.Errorf("browser link expired")
	}

	data, err := json.Marshal(link)
	if err != nil {
		return fmt.Errorf("marshal browser link: %w", err)
	}

	pipe := m.redis.TxPipeline()
	pipe.Set(m.ctx, m.browserLinkTokenKey(link.Token), data, ttl)
	pipe.Set(m.ctx, m.browserLinkUserKey(link.UserID), link.Token, ttl)
	_, err = pipe.Exec(m.ctx)
	return err
}

func (m *Manager) GetBrowserLinkByToken(token string) (*BrowserLink, error) {
	data, err := m.redis.Get(m.ctx, m.browserLinkTokenKey(token)).Bytes()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if err == nil {
		var link BrowserLink
		if err := json.Unmarshal(data, &link); err != nil {
			return nil, err
		}
		if m.store != nil {
			link.Persistent = true
			if err := m.store.SaveBrowserLink(m.ctx, browserLinkTokenHash(token), link); err != nil {
				return nil, err
			}
		}
		return &link, nil
	}

	if m.store == nil {
		return nil, nil
	}
	link, err := m.store.GetBrowserLinkByTokenHash(m.ctx, browserLinkTokenHash(token))
	if err != nil || link == nil {
		return link, err
	}
	link.Token = token
	link.ExpiresAt = time.Now().UTC().Add(180 * 24 * time.Hour).Format(time.RFC3339)
	if err := m.cacheBrowserLink(*link); err != nil {
		log.Printf("[session] failed to cache durable browser link for user %s: %v", link.UserID, err)
	}
	return link, nil
}

func (m *Manager) TouchBrowserLink(token string) error {
	link, err := m.GetBrowserLinkByToken(token)
	if err != nil || link == nil {
		return err
	}

	now := time.Now().UTC()
	link.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	link.ExpiresAt = now.Add(180 * 24 * time.Hour).Format(time.RFC3339)
	return m.StoreBrowserLink(*link)
}

func (m *Manager) HasBrowserLink(userID string) (bool, error) {
	if m.store != nil {
		exists, err := m.store.HasBrowserLink(m.ctx, userID)
		if err != nil || exists {
			return exists, err
		}
	}
	exists, err := m.redis.Exists(m.ctx, m.browserLinkUserKey(userID)).Result()
	return exists > 0, err
}

func (m *Manager) DeleteBrowserLink(userID string) error {
	token, err := m.redis.Get(m.ctx, m.browserLinkUserKey(userID)).Result()
	if err != nil && err != redis.Nil {
		return err
	}

	if m.store != nil {
		if err := m.store.DeleteBrowserLink(m.ctx, userID); err != nil {
			return err
		}
	}

	keys := []string{m.browserLinkUserKey(userID)}
	if token != "" {
		keys = append(keys, m.browserLinkTokenKey(token))
	}
	return m.redis.Del(m.ctx, keys...).Err()
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
			if sess.Status != "active" && sess.Status != "degraded" {
				continue
			}

			valid := false
			for attempt := 1; attempt <= 3; attempt++ {
				if validateFn(&sess) {
					valid = true
					break
				}
				if attempt < 3 {
					log.Printf("[keep-alive] validation attempt %d/3 failed for user %s, retrying...", attempt, sess.UserID)
					time.Sleep(5 * time.Second)
				}
			}

			if valid {
				now := time.Now().UTC().Format(time.RFC3339)
				sess.LastCheck = now
				sess.LastValidAt = now
				sess.Status = "active"
				sess.InvalidReason = ""
			} else {
				log.Printf("[keep-alive] session degraded for user %s (@%s) after 3 attempts", sess.UserID, sess.VintedName)
				sess.Status = "degraded"
				sess.InvalidReason = "keep_alive_validation_failed"
			}
			if err := m.Store(sess); err != nil {
				log.Printf("[keep-alive] failed to update session for %s: %v", sess.UserID, err)
			}
		}

		log.Printf("[keep-alive] checked %d sessions", len(sessions))
	}
}
