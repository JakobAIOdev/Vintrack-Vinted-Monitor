package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"
)

type Server struct {
	sessions   *session.Manager
	listenAddr string
}

func NewServer(sessions *session.Manager, addr string) *Server {
	return &Server{sessions: sessions, listenAddr: addr}
}

const browserSyncTTL = 10 * time.Minute
const browserLinkTTL = 180 * 24 * time.Hour
const proactiveRefreshWindow = 15 * time.Minute
const refreshLockTTL = 45 * time.Second

func (s *Server) Start() error {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/account/link", s.handleLink)
	mux.HandleFunc("POST /api/account/browser-sync/start", s.handleBrowserSyncStart)
	mux.HandleFunc("GET /api/account/browser-sync/status", s.handleBrowserSyncStatus)
	mux.HandleFunc("POST /api/account/browser-sync/complete", s.handleBrowserSyncComplete)
	mux.HandleFunc("POST /api/account/browser-link/create", s.handleBrowserLinkCreate)
	mux.HandleFunc("POST /api/account/extension-sync/complete", s.handleExtensionSyncComplete)
	mux.HandleFunc("POST /api/account/phone", s.handleUpdatePhoneNumber)
	mux.HandleFunc("POST /api/account/domain", s.handleUpdateDomain)
	mux.HandleFunc("DELETE /api/account/unlink", s.handleUnlink)
	mux.HandleFunc("GET /api/account/status", s.handleStatus)
	mux.HandleFunc("GET /api/account/info", s.handleInfo)

	mux.HandleFunc("POST /api/items/like", s.handleLike)
	mux.HandleFunc("POST /api/items/unlike", s.handleUnlike)
	mux.HandleFunc("POST /api/items/buy", s.handleOneClickBuy)
	mux.HandleFunc("POST /api/items/buy/warm", s.handleBuyWarm)
	mux.HandleFunc("GET /api/items/checkout-links", s.handleCheckoutLinks)
	mux.HandleFunc("POST /api/items/checkout-links", s.handleStoreCheckoutLink)
	mux.HandleFunc("GET /api/items/liked", s.handleLikedItems)
	mux.HandleFunc("GET /api/items/favorites", s.handleFavorites)
	mux.HandleFunc("GET /api/items/wardrobe", s.handleWardrobe)
	mux.HandleFunc("GET /api/catalog/brands", s.handleBrandSearch)

	mux.HandleFunc("GET /api/messages/inbox", s.handleInbox)
	mux.HandleFunc("GET /api/notifications", s.handleNotifications)
	mux.HandleFunc("GET /api/messages/conversations/{id}", s.handleConversationReplies)
	mux.HandleFunc("POST /api/messages/send", s.handleSendMessage)
	mux.HandleFunc("POST /api/messages/reply", s.handleReplyToConversation)
	mux.HandleFunc("POST /api/offers/send", s.handleSendOffer)

	mux.HandleFunc("POST /api/account/refresh", s.handleRefreshToken)

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})

	log.Printf("API server listening on %s", s.listenAddr)
	return http.ListenAndServe(s.listenAddr, s.withMiddleware(mux))
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-User-ID")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func getUserID(r *http.Request) string {
	return r.Header.Get("X-User-ID")
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, msg string, status int) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func splitCommaList(raw string) []string {
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			values = append(values, value)
		}
	}
	return values
}

func queryStringList(values url.Values, keys ...string) []string {
	result := make([]string, 0)
	for _, key := range keys {
		for _, raw := range values[key] {
			result = append(result, splitCommaList(raw)...)
		}
	}
	return result
}

func extractHeaderValue(raw, name string) string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	for _, line := range lines {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeCookieHeader(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	if strings.Contains(trimmed, "\n") {
		if cookieHeader := extractHeaderValue(trimmed, "cookie"); cookieHeader != "" {
			return cookieHeader
		}
	}

	if key, value, ok := strings.Cut(trimmed, ":"); ok && strings.EqualFold(strings.TrimSpace(key), "cookie") {
		return strings.TrimSpace(value)
	}

	return trimmed
}

func extractCookieValue(header, name string) string {
	for _, part := range strings.Split(header, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeVintedDomain(raw string) string {
	normalized := strings.TrimSpace(strings.ToLower(raw))
	if normalized == "" {
		return ""
	}

	if strings.HasPrefix(normalized, "http://") || strings.HasPrefix(normalized, "https://") {
		if parsed, err := url.Parse(normalized); err == nil && parsed.Host != "" {
			normalized = parsed.Hostname()
		}
	}

	normalized = strings.TrimPrefix(normalized, ".")
	normalized = strings.TrimSuffix(normalized, ".")

	if strings.HasPrefix(normalized, "www.") {
		return normalized
	}

	if normalized == "vinted.co.uk" {
		return "www.vinted.co.uk"
	}

	if strings.HasPrefix(normalized, "vinted.") {
		return "www." + normalized
	}

	return normalized
}

func normalizeBrowserSessionInput(accessToken, refreshToken, cookieHeader, userAgent string) (string, string, string, string, error) {
	normalizedCookieHeader := normalizeCookieHeader(cookieHeader)
	normalizedUserAgent := strings.TrimSpace(userAgent)

	if normalizedUserAgent == "" && strings.Contains(strings.TrimSpace(cookieHeader), "\n") {
		normalizedUserAgent = extractHeaderValue(cookieHeader, "user-agent")
	}

	normalizedAccessToken := strings.TrimSpace(accessToken)
	normalizedRefreshToken := strings.TrimSpace(refreshToken)

	if normalizedCookieHeader != "" {
		if normalizedAccessToken == "" {
			normalizedAccessToken = extractCookieValue(normalizedCookieHeader, "access_token_web")
		}
		if normalizedRefreshToken == "" {
			normalizedRefreshToken = extractCookieValue(normalizedCookieHeader, "refresh_token_web")
		}
	}

	if normalizedAccessToken == "" && normalizedRefreshToken == "" {
		return "", "", "", "", errors.New("access_token or refresh_token is required or must be present in the cookie header")
	}

	return normalizedAccessToken, normalizedRefreshToken, normalizedCookieHeader, normalizedUserAgent, nil
}

func accessTokenExpiresWithin(token string, window time.Duration) bool {
	expiry, ok := accessTokenExpiry(token)
	if !ok {
		return false
	}
	return time.Until(expiry) <= window
}

func accessTokenExpired(token string) bool {
	expiry, ok := accessTokenExpiry(token)
	if !ok {
		return false
	}
	return time.Now().After(expiry)
}

func accessTokenExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}

	payload := parts[1]
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(payload)
	}
	if err != nil {
		return time.Time{}, false
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return time.Time{}, false
	}

	exp, ok := claims["exp"].(float64)
	if !ok || exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(exp), 0), true
}

func serverSideTokenRefreshAllowed(sess *session.VintedSession) bool {
	return sess != nil && !sess.BrowserLinked && strings.TrimSpace(sess.RefreshToken) != ""
}

func sessionForServerSideClient(sess *session.VintedSession) *session.VintedSession {
	if sess == nil || !sess.BrowserLinked || strings.TrimSpace(sess.RefreshToken) == "" {
		return sess
	}

	clientSession := *sess
	clientSession.RefreshToken = ""
	return &clientSession
}

func (s *Server) canonicalizeSessionDomain(sess *session.VintedSession) {
	if sess == nil {
		return
	}

	normalized := normalizeVintedDomain(sess.Domain)
	if normalized == "" || normalized == sess.Domain {
		return
	}

	sess.Domain = normalized
	if err := s.sessions.Store(*sess); err != nil {
		log.Printf("[server] failed to persist canonical domain for user %s: %v", sess.UserID, err)
	}
}

func (s *Server) refreshSessionWithLock(userID string, sess *session.VintedSession) (*session.VintedSession, *vinted.Client, error) {
	if sess == nil {
		return nil, nil, errors.New("no linked Vinted account")
	}
	if sess.BrowserLinked {
		return nil, nil, errors.New("browser-linked sessions are refreshed by the browser extension")
	}
	if strings.TrimSpace(sess.RefreshToken) == "" {
		sess.Status = "missing_refresh_token"
		sess.InvalidReason = "missing_refresh_token"
		_ = s.sessions.Store(*sess)
		return nil, nil, errors.New("no refresh token available")
	}

	lockToken, acquired, err := s.sessions.AcquireRefreshLock(userID, refreshLockTTL)
	if err != nil {
		log.Printf("[session] failed to acquire refresh lock for user %s: %v", userID, err)
	}

	if !acquired {
		for attempt := 0; attempt < 10; attempt++ {
			time.Sleep(500 * time.Millisecond)
			latest, err := s.sessions.Get(userID)
			if err != nil || latest == nil {
				continue
			}
			if latest.AccessToken != sess.AccessToken && !accessTokenExpiresWithin(latest.AccessToken, proactiveRefreshWindow) {
				client, clientErr := vinted.NewClient(latest)
				if clientErr != nil {
					return nil, nil, clientErr
				}
				if warmErr := client.WarmUp(); warmErr != nil {
					log.Printf("[session] warmup warning after refresh wait for user %s: %v", userID, warmErr)
				}
				return latest, client, nil
			}
		}
		return nil, nil, errors.New("session refresh is already in progress")
	}
	defer func() {
		if err := s.sessions.ReleaseRefreshLock(userID, lockToken); err != nil {
			log.Printf("[session] failed to release refresh lock for user %s: %v", userID, err)
		}
	}()

	latest, err := s.sessions.Get(userID)
	if err != nil {
		return nil, nil, err
	}
	if latest != nil {
		sess = latest
	}
	if !accessTokenExpiresWithin(sess.AccessToken, proactiveRefreshWindow) && sess.Status == "active" {
		client, err := vinted.NewClient(sess)
		if err == nil {
			if warmErr := client.WarmUp(); warmErr != nil {
				log.Printf("[session] warmup warning for already fresh session %s: %v", userID, warmErr)
			}
		}
		return sess, client, err
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		return nil, nil, err
	}
	if err := client.WarmUp(); err != nil {
		log.Printf("[session] warmup warning before locked refresh for user %s: %v", userID, err)
	}

	if err := client.RefreshAccessToken(); err != nil {
		return nil, nil, err
	}

	updated := client.GetSession()
	now := time.Now().UTC().Format(time.RFC3339)
	updated.Status = "active"
	updated.LastCheck = now
	updated.LastRefreshAt = now
	updated.LastValidAt = now
	updated.InvalidReason = ""
	if err := s.sessions.Store(*updated); err != nil {
		return nil, nil, err
	}

	return updated, client, nil
}

func accountInfoWithRefresh(client *vinted.Client) (*vinted.AccountInfo, error) {
	info, err := client.GetAccountInfo()
	if err == nil {
		return info, nil
	}

	sess := client.GetSession()
	if !serverSideTokenRefreshAllowed(sess) {
		return nil, err
	}

	if refreshErr := client.RefreshAccessToken(); refreshErr != nil {
		return nil, fmt.Errorf("%v (refresh failed: %v)", err, refreshErr)
	}

	info, retryErr := client.GetAccountInfo()
	if retryErr != nil {
		return nil, retryErr
	}
	return info, nil
}

func (s *Server) getSessionAndClient(r *http.Request, w http.ResponseWriter) (*session.VintedSession, *vinted.Client, bool) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized: missing X-User-ID header", 401)
		return nil, nil, false
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "session fetch error", 500)
		return nil, nil, false
	}
	if sess == nil {
		writeError(w, "no linked Vinted account", 404)
		return nil, nil, false
	}

	s.canonicalizeSessionDomain(sess)

	if serverSideTokenRefreshAllowed(sess) && accessTokenExpiresWithin(sess.AccessToken, proactiveRefreshWindow) {
		refreshed, refreshedClient, err := s.refreshSessionWithLock(userID, sess)
		if err != nil {
			log.Printf("[session] proactive token refresh failed for user %s: %v", userID, err)
			if accessTokenExpired(sess.AccessToken) {
				sess.Status = "needs_browser_reauth"
				sess.InvalidReason = "access_token_expired_refresh_failed"
				_ = s.sessions.Store(*sess)
				writeError(w, "Vinted session needs browser re-authentication", 403)
				return nil, nil, false
			}
			sess.Status = "degraded"
			sess.InvalidReason = "proactive_refresh_failed"
			_ = s.sessions.Store(*sess)
		} else {
			return refreshed, refreshedClient, true
		}
	}

	client, err := vinted.NewClient(sessionForServerSideClient(sess))
	if err != nil {
		writeError(w, "failed to create Vinted client", 500)
		return nil, nil, false
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[session] warmup failed for user %s: %v", userID, err)
	} else {
		s.persistSessionIfChanged(sess, client.GetSession(), false)
	}

	if sess.Status != "active" {
		log.Printf("[session] session for user %s is %s, attempting recovery...", userID, sess.Status)

		if serverSideTokenRefreshAllowed(sess) {
			log.Printf("[session] attempting token refresh for user %s...", userID)
			updated, updatedClient, err := s.refreshSessionWithLock(userID, sess)
			if err != nil {
				log.Printf("[session] token refresh failed for user %s: %v", userID, err)
			} else {
				log.Printf("[session] token refresh succeeded for user %s", userID)
				return updated, updatedClient, true
			}
		}

		if client.ValidateSession() {
			log.Printf("[session] re-validation succeeded for user %s, reactivating session", userID)
			now := time.Now().UTC().Format(time.RFC3339)
			sess.Status = "active"
			sess.LastCheck = now
			sess.LastValidAt = now
			sess.InvalidReason = ""
			_ = s.sessions.Store(*sess)
		} else {
			if sess.Status == "degraded" {
				writeError(w, "Vinted session is temporarily degraded; retry or sync the browser extension", 503)
			} else {
				sess.Status = "needs_browser_reauth"
				sess.InvalidReason = "validation_failed_after_refresh"
				_ = s.sessions.Store(*sess)
				writeError(w, "Vinted session needs browser re-authentication", 403)
			}
			return nil, nil, false
		}
	}

	return sess, client, true
}

type linkRequest struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	CookieHeader string `json:"cookie_header"`
	UserAgent    string `json:"user_agent"`
	PhoneNumber  string `json:"phone_number"`
	Domain       string `json:"domain"`
}

type browserSyncCompleteRequest struct {
	Code         string `json:"code"`
	CookieHeader string `json:"cookie_header"`
	UserAgent    string `json:"user_agent"`
	Domain       string `json:"domain"`
}

type extensionSyncCompleteRequest struct {
	LinkToken          string `json:"link_token"`
	AccessToken        string `json:"access_token"`
	RefreshToken       string `json:"refresh_token"`
	UserAgent          string `json:"user_agent"`
	Domain             string `json:"domain"`
	AllowAccountSwitch bool   `json:"allow_account_switch"`
	BrowserVintedID    int64  `json:"browser_vinted_id"`
	BrowserVintedName  string `json:"browser_vinted_name"`
}

func (s *Server) buildLinkedSession(userID string, req linkRequest) (*session.VintedSession, error) {
	accessToken, refreshToken, cookieHeader, userAgent, err := normalizeBrowserSessionInput(
		req.AccessToken,
		req.RefreshToken,
		req.CookieHeader,
		req.UserAgent,
	)
	if err != nil {
		return nil, err
	}

	existingSession, err := s.sessions.Get(userID)
	if err != nil {
		return nil, fmt.Errorf("session fetch error: %w", err)
	}

	phoneNumber := strings.TrimSpace(req.PhoneNumber)
	if phoneNumber == "" && existingSession != nil {
		phoneNumber = existingSession.PhoneNumber
	}

	domain := normalizeVintedDomain(req.Domain)
	if domain == "" {
		return nil, errors.New("domain is required")
	}

	if userAgent == "" && existingSession != nil {
		userAgent = strings.TrimSpace(existingSession.UserAgent)
	}

	preservedCookieHeader := cookieHeader
	if preservedCookieHeader == "" && existingSession != nil {
		preservedCookieHeader = strings.TrimSpace(existingSession.CookieHeader)
	}

	preservedCsrfToken := ""
	preservedAnonID := ""
	if existingSession != nil {
		preservedCsrfToken = strings.TrimSpace(existingSession.CsrfToken)
		preservedAnonID = strings.TrimSpace(existingSession.AnonID)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	linkedAt := now
	if existingSession != nil && strings.TrimSpace(existingSession.LinkedAt) != "" {
		linkedAt = existingSession.LinkedAt
	}

	return &session.VintedSession{
		UserID:        userID,
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		CookieHeader:  preservedCookieHeader,
		CsrfToken:     preservedCsrfToken,
		AnonID:        preservedAnonID,
		UserAgent:     userAgent,
		PhoneNumber:   phoneNumber,
		BrowserLinked: existingSession != nil && existingSession.BrowserLinked,
		LastBrowserSync: firstNonEmpty(func() string {
			if existingSession == nil {
				return ""
			}
			return existingSession.LastBrowserSync
		}()),
		Domain:      domain,
		Status:      "active",
		LinkedAt:    linkedAt,
		LastCheck:   now,
		LastValidAt: now,
		LastRefreshAt: firstNonEmpty(func() string {
			if existingSession == nil {
				return ""
			}
			return existingSession.LastRefreshAt
		}()),
		InvalidReason: "",
	}, nil
}

func (s *Server) handleLink(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	var req linkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	if req.Domain == "" {
		writeError(w, "domain is required", 400)
		return
	}

	sess, err := s.buildLinkedSession(userID, req)
	if err != nil {
		statusCode := 400
		if strings.Contains(err.Error(), "session fetch error") {
			statusCode = 500
		}
		writeError(w, err.Error(), statusCode)
		return
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create client: "+err.Error(), 500)
		return
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[link] warmup warning for user %s: %v", userID, err)
	}

	info, err := accountInfoWithRefresh(client)
	if err != nil {
		writeError(w, "invalid token: "+err.Error(), 401)
		return
	}

	linkedSession := client.GetSession()
	linkedSession.VintedUserID = info.ID
	linkedSession.VintedName = info.Login
	linkedSession.Status = "active"
	linkedSession.LastValidAt = time.Now().UTC().Format(time.RFC3339)
	linkedSession.InvalidReason = ""

	if err := s.sessions.Store(*linkedSession); err != nil {
		writeError(w, "failed to save session", 500)
		return
	}

	log.Printf("[account] linked user %s -> @%s (ID: %d) on %s", userID, info.Login, info.ID, req.Domain)

	writeJSON(w, 200, map[string]interface{}{
		"linked":              true,
		"vinted_name":         info.Login,
		"vinted_id":           info.ID,
		"domain":              req.Domain,
		"has_browser_session": linkedSession.CookieHeader != "",
		"browser_linked":      linkedSession.BrowserLinked,
		"last_browser_sync":   linkedSession.LastBrowserSync,
		"has_phone_number":    linkedSession.PhoneNumber != "",
	})
}

func (s *Server) handleBrowserSyncStart(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	req, err := s.sessions.CreateBrowserSyncRequest(userID, browserSyncTTL)
	if err != nil {
		writeError(w, "failed to create browser sync request", 500)
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"code":       req.Code,
		"status":     req.Status,
		"created_at": req.CreatedAt,
		"expires_at": req.ExpiresAt,
	})
}

func (s *Server) handleBrowserSyncStatus(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		writeError(w, "code is required", 400)
		return
	}

	req, err := s.sessions.GetBrowserSyncRequest(code)
	if err != nil {
		writeError(w, "browser sync fetch error", 500)
		return
	}
	if req == nil || req.UserID != userID {
		writeError(w, "browser sync request not found", 404)
		return
	}

	writeJSON(w, 200, req)
}

func (s *Server) handleBrowserSyncComplete(w http.ResponseWriter, r *http.Request) {
	var req browserSyncCompleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	req.Code = strings.TrimSpace(req.Code)
	req.Domain = strings.TrimSpace(req.Domain)
	if req.Code == "" {
		writeError(w, "code is required", 400)
		return
	}
	if req.Domain == "" {
		writeError(w, "domain is required", 400)
		return
	}

	syncReq, err := s.sessions.GetBrowserSyncRequest(req.Code)
	if err != nil {
		writeError(w, "browser sync fetch error", 500)
		return
	}
	if syncReq == nil {
		writeError(w, "browser sync request expired or not found", 404)
		return
	}

	linkReq := linkRequest{
		CookieHeader: req.CookieHeader,
		UserAgent:    req.UserAgent,
		Domain:       req.Domain,
	}
	sess, err := s.buildLinkedSession(syncReq.UserID, linkReq)
	if err != nil {
		syncReq.Status = "failed"
		syncReq.Error = err.Error()
		_ = s.sessions.StoreBrowserSyncRequest(*syncReq)
		writeError(w, err.Error(), 400)
		return
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create client: "+err.Error(), 500)
		return
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[browser-sync] warmup warning for user %s: %v", syncReq.UserID, err)
	}

	info, err := accountInfoWithRefresh(client)
	if err != nil {
		syncReq.Status = "failed"
		syncReq.Domain = req.Domain
		syncReq.Error = "invalid browser session: " + err.Error()
		_ = s.sessions.StoreBrowserSyncRequest(*syncReq)
		writeError(w, syncReq.Error, 401)
		return
	}

	linkedSession := client.GetSession()
	linkedSession.VintedUserID = info.ID
	linkedSession.VintedName = info.Login
	linkedSession.BrowserLinked = true
	linkedSession.Status = "active"
	linkedSession.LastValidAt = time.Now().UTC().Format(time.RFC3339)
	linkedSession.InvalidReason = ""
	linkedSession.LastBrowserSync = linkedSession.LastValidAt

	if err := s.sessions.Store(*linkedSession); err != nil {
		writeError(w, "failed to save session", 500)
		return
	}

	syncReq.Status = "completed"
	syncReq.Domain = linkedSession.Domain
	syncReq.VintedID = linkedSession.VintedUserID
	syncReq.VintedName = linkedSession.VintedName
	syncReq.Error = ""
	syncReq.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.sessions.StoreBrowserSyncRequest(*syncReq); err != nil {
		log.Printf("[browser-sync] failed to persist request result for user %s: %v", syncReq.UserID, err)
	}

	writeJSON(w, 200, map[string]interface{}{
		"status":      "completed",
		"vinted_name": linkedSession.VintedName,
		"vinted_id":   linkedSession.VintedUserID,
		"domain":      linkedSession.Domain,
	})
}

func (s *Server) handleBrowserLinkCreate(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	link, err := s.sessions.CreateBrowserLink(userID, browserLinkTTL)
	if err != nil {
		writeError(w, "failed to create browser link", 500)
		return
	}

	writeJSON(w, 200, link)
}

func (s *Server) handleExtensionSyncComplete(w http.ResponseWriter, r *http.Request) {
	var req extensionSyncCompleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	req.LinkToken = strings.TrimSpace(req.LinkToken)
	req.AccessToken = strings.TrimSpace(req.AccessToken)
	req.RefreshToken = strings.TrimSpace(req.RefreshToken)
	req.UserAgent = strings.TrimSpace(req.UserAgent)
	req.Domain = strings.TrimSpace(req.Domain)

	if req.LinkToken == "" {
		writeError(w, "link_token is required", 400)
		return
	}
	if req.AccessToken == "" {
		writeError(w, "access_token is required", 400)
		return
	}
	if req.Domain == "" {
		writeError(w, "domain is required", 400)
		return
	}

	link, err := s.sessions.GetBrowserLinkByToken(req.LinkToken)
	if err != nil {
		writeError(w, "browser link fetch error", 500)
		return
	}
	if link == nil {
		writeError(w, "browser link expired or not found", 404)
		return
	}

	incomingDomain := normalizeVintedDomain(req.Domain)
	existingSession, err := s.sessions.Get(link.UserID)
	if err != nil {
		writeError(w, "session fetch error", 500)
		return
	}
	if existingSession != nil {
		s.canonicalizeSessionDomain(existingSession)
		if !req.AllowAccountSwitch && incomingDomain != "" && existingSession.Domain != "" && incomingDomain != existingSession.Domain {
			if err := s.sessions.TouchBrowserLink(req.LinkToken); err != nil {
				log.Printf("[extension-sync] failed to touch browser link for user %s: %v", link.UserID, err)
			}
			writeJSON(w, 200, map[string]interface{}{
				"status":         "ignored_domain",
				"domain":         existingSession.Domain,
				"ignored_domain": incomingDomain,
				"error":          fmt.Sprintf("browser session domain %s does not match linked domain %s", incomingDomain, existingSession.Domain),
			})
			return
		}
	}

	sess, err := s.buildLinkedSession(link.UserID, linkRequest{
		AccessToken:  req.AccessToken,
		RefreshToken: req.RefreshToken,
		UserAgent:    req.UserAgent,
		Domain:       req.Domain,
	})
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create client: "+err.Error(), 500)
		return
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[extension-sync] warmup warning for user %s: %v", link.UserID, err)
	}

	info, err := accountInfoWithRefresh(client)
	if err != nil {
		if existingSession != nil && existingSession.Status == "active" && !accessTokenExpired(existingSession.AccessToken) {
			if err := s.sessions.TouchBrowserLink(req.LinkToken); err != nil {
				log.Printf("[extension-sync] failed to touch browser link for user %s: %v", link.UserID, err)
			}
			writeJSON(w, 200, map[string]interface{}{
				"status":         "ignored_invalid_browser_session",
				"domain":         existingSession.Domain,
				"ignored_domain": incomingDomain,
				"error":          "Vinted rejected the browser session token",
			})
			return
		}
		writeError(w, "invalid browser token sync: "+err.Error(), 401)
		return
	}

	if req.BrowserVintedID > 0 && info.ID != req.BrowserVintedID {
		writeJSON(w, 409, map[string]interface{}{
			"status":              "browser_account_mismatch",
			"domain":              incomingDomain,
			"browser_vinted_id":   req.BrowserVintedID,
			"resolved_vinted_id":  info.ID,
			"browser_vinted_name": strings.TrimSpace(req.BrowserVintedName),
			"error":               "the server-resolved Vinted account does not match the account open in the selected browser tab",
		})
		return
	}

	if !req.AllowAccountSwitch && existingSession != nil && existingSession.VintedUserID > 0 && info.ID > 0 && existingSession.VintedUserID != info.ID {
		if err := s.sessions.TouchBrowserLink(req.LinkToken); err != nil {
			log.Printf("[extension-sync] failed to touch browser link for user %s: %v", link.UserID, err)
		}
		writeJSON(w, 200, map[string]interface{}{
			"status":            "ignored_account",
			"domain":            existingSession.Domain,
			"ignored_domain":    incomingDomain,
			"ignored_vinted_id": info.ID,
			"error":             "browser is signed in to a different Vinted account",
		})
		return
	}

	linkedSession := client.GetSession()
	linkedSession.VintedUserID = info.ID
	linkedSession.VintedName = info.Login
	linkedSession.BrowserLinked = true
	linkedSession.Status = "active"
	linkedSession.LastValidAt = time.Now().UTC().Format(time.RFC3339)
	linkedSession.InvalidReason = ""
	linkedSession.LastBrowserSync = linkedSession.LastValidAt

	if err := s.sessions.Store(*linkedSession); err != nil {
		writeError(w, "failed to save session", 500)
		return
	}

	if err := s.sessions.TouchBrowserLink(req.LinkToken); err != nil {
		log.Printf("[extension-sync] failed to touch browser link for user %s: %v", link.UserID, err)
	}

	writeJSON(w, 200, map[string]interface{}{
		"status":      "completed",
		"vinted_name": linkedSession.VintedName,
		"vinted_id":   linkedSession.VintedUserID,
		"domain":      linkedSession.Domain,
	})
}

type updatePhoneNumberRequest struct {
	PhoneNumber string `json:"phone_number"`
}

type updateDomainRequest struct {
	Domain string `json:"domain"`
}

func (s *Server) handleUpdateDomain(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	var req updateDomainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	domain := normalizeVintedDomain(req.Domain)
	if domain == "" {
		writeError(w, "domain is required", 400)
		return
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "session fetch error", 500)
		return
	}
	if sess == nil {
		writeError(w, "no linked Vinted account", 404)
		return
	}

	sess.Domain = domain
	sess.LastCheck = time.Now().UTC().Format(time.RFC3339)
	if err := s.sessions.Store(*sess); err != nil {
		writeError(w, "failed to save domain", 500)
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"domain":     sess.Domain,
		"last_check": sess.LastCheck,
	})
}

func (s *Server) handleUpdatePhoneNumber(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "session fetch error", 500)
		return
	}
	if sess == nil {
		writeError(w, "no linked Vinted account", 404)
		return
	}

	var req updatePhoneNumberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	sess.PhoneNumber = strings.TrimSpace(req.PhoneNumber)
	sess.LastCheck = time.Now().UTC().Format(time.RFC3339)
	if err := s.sessions.Store(*sess); err != nil {
		writeError(w, "failed to save phone number", 500)
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"has_phone_number": sess.PhoneNumber != "",
		"last_check":       sess.LastCheck,
	})
}

func (s *Server) handleUnlink(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	if err := s.sessions.Delete(userID); err != nil {
		writeError(w, "failed to unlink", 500)
		return
	}
	_ = s.sessions.DeleteLikes(userID)
	_ = s.sessions.DeleteCheckoutLinks(userID)

	log.Printf("[account] unlinked user %s", userID)
	writeJSON(w, 200, map[string]string{"status": "unlinked"})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "error fetching session", 500)
		return
	}

	if sess == nil {
		writeJSON(w, 200, map[string]interface{}{"linked": false})
		return
	}

	s.canonicalizeSessionDomain(sess)

	writeJSON(w, 200, map[string]interface{}{
		"linked":                  true,
		"status":                  sess.Status,
		"vinted_name":             sess.VintedName,
		"vinted_id":               sess.VintedUserID,
		"domain":                  sess.Domain,
		"linked_at":               sess.LinkedAt,
		"last_check":              sess.LastCheck,
		"last_refresh_at":         sess.LastRefreshAt,
		"last_valid_at":           sess.LastValidAt,
		"invalid_reason":          sess.InvalidReason,
		"has_refresh_token":       sess.RefreshToken != "",
		"requires_browser_reauth": sess.Status == "needs_browser_reauth" || sess.Status == "missing_refresh_token",
		"has_browser_session":     sess.CookieHeader != "",
		"browser_linked":          sess.BrowserLinked,
		"last_browser_sync":       sess.LastBrowserSync,
		"has_phone_number":        sess.PhoneNumber != "",
	})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	_, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	info, err := client.GetAccountInfo()
	if err != nil {
		writeError(w, "failed to fetch account: "+err.Error(), 502)
		return
	}

	writeJSON(w, 200, info)
}

type itemRequest struct {
	ItemID int64 `json:"item_id"`
}

func (s *Server) handleLike(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req itemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ItemID == 0 {
		writeError(w, "item_id is required", 400)
		return
	}

	if err := client.LikeItem(req.ItemID); err != nil {
		writeError(w, "like failed: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)

	userID := getUserID(r)
	_ = s.sessions.AddLike(userID, req.ItemID)

	writeJSON(w, 200, map[string]interface{}{"status": "liked", "item_id": req.ItemID})
}

func (s *Server) handleUnlike(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req itemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ItemID == 0 {
		writeError(w, "item_id is required", 400)
		return
	}

	if err := client.UnlikeItem(req.ItemID); err != nil {
		writeError(w, "unlike failed: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)

	userID := getUserID(r)
	_ = s.sessions.RemoveLike(userID, req.ItemID)

	writeJSON(w, 200, map[string]interface{}{"status": "unliked", "item_id": req.ItemID})
}

type oneClickBuyRequest struct {
	ItemID               int64                  `json:"item_id"`
	SellerID             int64                  `json:"seller_id"`
	IncogniaRequestToken string                 `json:"incognia_request_token"`
	PickupType           int                    `json:"pickup_type"`
	BrowserInfo          vinted.BrowserInfo     `json:"browser_info"`
	PaymentMethod        map[string]interface{} `json:"payment_method"`
	PhoneNumber          string                 `json:"phone_number"`
}

func (s *Server) handleOneClickBuy(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req oneClickBuyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}
	if req.ItemID == 0 {
		writeError(w, "item_id is required", 400)
		return
	}
	if req.SellerID == 0 {
		writeError(w, "seller_id is required", 400)
		return
	}

	result, err := client.OneClickBuy(req.ItemID, vinted.OneClickBuyOptions{
		SellerID:             req.SellerID,
		IncogniaRequestToken: strings.TrimSpace(req.IncogniaRequestToken),
		PickupType:           req.PickupType,
		BrowserInfo:          req.BrowserInfo,
		PaymentMethod:        req.PaymentMethod,
		PhoneNumber:          firstNonEmpty(strings.TrimSpace(req.PhoneNumber), sess.PhoneNumber),
	})
	if err != nil {
		var authErr *vinted.AuthError
		if errors.As(err, &authErr) {
			writeJSON(w, 401, map[string]interface{}{
				"error":        "one-click buy failed: " + authErr.Error(),
				"code":         "invalid_authentication_token",
				"step":         authErr.Step,
				"vinted_code":  authErr.VintedCode,
				"vinted_error": authErr.Message,
			})
			return
		}
		var paymentMissingErr *vinted.PaymentURLMissingError
		if errors.As(err, &paymentMissingErr) {
			s.storeCheckoutLink(getUserID(r), sess, session.CheckoutLink{
				ItemID:        req.ItemID,
				SellerID:      req.SellerID,
				TransactionID: paymentMissingErr.TransactionID,
				PurchaseID:    paymentMissingErr.PurchaseID,
				CheckoutURL:   paymentMissingErr.CheckoutURL,
				Domain:        sess.Domain,
				Status:        "payment_url_missing",
				CreatedAt:     time.Now().UTC().Format(time.RFC3339),
			})
			writeJSON(w, 409, map[string]interface{}{
				"error":        "one-click buy failed: " + paymentMissingErr.Error(),
				"code":         "payment_url_missing",
				"purchase_id":  paymentMissingErr.PurchaseID,
				"checkout_url": paymentMissingErr.CheckoutURL,
				"payment_raw":  paymentMissingErr.Raw,
			})
			return
		}
		var paymentStateErr *vinted.PaymentStateError
		if errors.As(err, &paymentStateErr) {
			writeJSON(w, 409, map[string]interface{}{
				"error":        "one-click buy failed: " + paymentStateErr.Error(),
				"code":         paymentStateErr.Code,
				"step":         paymentStateErr.Step,
				"vinted_code":  paymentStateErr.VintedCode,
				"vinted_error": paymentStateErr.Message,
				"payment_raw":  paymentStateErr.Raw,
			})
			return
		}
		var challengeErr *vinted.DataDomeChallengeError
		if errors.As(err, &challengeErr) {
			writeJSON(w, 409, map[string]interface{}{
				"error":       "one-click buy failed: " + challengeErr.Error(),
				"code":        "datadome_challenge",
				"step":        challengeErr.Step,
				"captcha_url": challengeErr.CaptchaURL,
			})
			return
		}
		writeError(w, "one-click buy failed: "+err.Error(), 502)
		return
	}

	s.storeCheckoutLink(getUserID(r), sess, session.CheckoutLink{
		ItemID:        result.ItemID,
		SellerID:      result.SellerID,
		TransactionID: result.TransactionID,
		PurchaseID:    result.PurchaseID,
		CheckoutURL:   result.CheckoutURL,
		PaymentURL:    result.PaymentURL,
		Domain:        sess.Domain,
		Status:        result.Status,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	})
	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, result)
}

func (s *Server) handleBuyWarm(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, map[string]string{"status": "warmed"})
}

func (s *Server) handleLikedItems(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	ids, err := s.sessions.GetLikes(userID)
	if err != nil {
		writeError(w, "failed to fetch likes", 500)
		return
	}

	writeJSON(w, 200, map[string]interface{}{"item_ids": ids})
}

func (s *Server) handleCheckoutLinks(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	links, err := s.sessions.GetCheckoutLinks(userID)
	if err != nil {
		writeError(w, "failed to fetch checkout links", 500)
		return
	}

	writeJSON(w, 200, map[string]interface{}{"links": links})
}

type storeCheckoutLinkRequest struct {
	ItemID        int64  `json:"item_id"`
	SellerID      int64  `json:"seller_id"`
	TransactionID int64  `json:"transaction_id"`
	PurchaseID    string `json:"purchase_id"`
	CheckoutURL   string `json:"checkout_url"`
	PaymentURL    string `json:"payment_url"`
	Status        string `json:"status"`
}

func (s *Server) handleStoreCheckoutLink(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "failed to load session", 500)
		return
	}
	if sess == nil {
		writeError(w, "no linked session", 404)
		return
	}

	var req storeCheckoutLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid json", 400)
		return
	}

	if strings.TrimSpace(req.CheckoutURL) == "" && strings.TrimSpace(req.PaymentURL) == "" {
		writeError(w, "checkout_url or payment_url is required", 400)
		return
	}

	s.storeCheckoutLink(userID, sess, session.CheckoutLink{
		ItemID:        req.ItemID,
		SellerID:      req.SellerID,
		TransactionID: req.TransactionID,
		PurchaseID:    strings.TrimSpace(req.PurchaseID),
		CheckoutURL:   strings.TrimSpace(req.CheckoutURL),
		PaymentURL:    strings.TrimSpace(req.PaymentURL),
		Status:        firstNonEmpty(strings.TrimSpace(req.Status), "checkout_ready"),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	})

	writeJSON(w, 200, map[string]interface{}{"status": "stored"})
}

func (s *Server) handleFavorites(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	page := r.URL.Query().Get("page")
	favs, err := client.GetFavourites(sess.VintedUserID, page)
	if err != nil {
		writeError(w, "failed to fetch favorites: "+err.Error(), 502)
		return
	}

	client.EnrichFavorites(favs)

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, favs)
}

func (s *Server) handleWardrobe(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}

	perPage := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 100 {
			perPage = parsed
		}
	}

	order := strings.TrimSpace(r.URL.Query().Get("order"))
	if order == "" {
		order = "relevance"
	}

	wardrobe, err := client.GetWardrobe(sess.VintedUserID, page, perPage, order)
	if err != nil {
		writeError(w, "failed to fetch wardrobe: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, wardrobe)
}

func (s *Server) handleBrandSearch(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("query"))
	if query == "" {
		query = strings.TrimSpace(r.URL.Query().Get("q"))
	}
	if query == "" {
		writeError(w, "query is required", 400)
		return
	}

	catalogIDs := queryStringList(r.URL.Query(), "catalog_ids", "catalog_ids[]", "catalog[]")
	if len(catalogIDs) == 0 {
		catalogIDs = vinted.DefaultBrandCatalogIDs()
	}

	region := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("region")))
	regionalSearch := false
	if region != "" {
		domain, known := vinted.DomainForRegion(region)
		if !known {
			writeError(w, "unsupported Vinted region", 400)
			return
		}

		if domain != client.GetDomain() {
			regionalSession := *sess
			regionalSession.Domain = domain
			regionalSession.RefreshToken = ""
			regionalSession.CookieHeader = ""
			regionalSession.CsrfToken = ""
			regionalSession.AnonID = ""
			regionalSession.WarmedAt = ""

			regionalClient, err := vinted.NewClient(&regionalSession)
			if err != nil {
				writeError(w, "failed to create regional Vinted client", 500)
				return
			}
			client = regionalClient
			regionalSearch = true
		}
	}

	brands, err := client.SearchBrands(catalogIDs, query)
	if err != nil {
		writeError(w, "failed to search brands: "+err.Error(), 502)
		return
	}

	if !regionalSearch {
		s.persistIfRefreshed(sess, client)
	}
	writeJSON(w, 200, map[string]interface{}{"brands": brands})
}

func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}

	perPage := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 100 {
			perPage = parsed
		}
	}

	inbox, err := client.GetInbox(page, perPage)
	if err != nil {
		writeError(w, "failed to fetch inbox: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, inbox)
}

func (s *Server) handleNotifications(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}

	perPage := 5
	if raw := strings.TrimSpace(r.URL.Query().Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 50 {
			perPage = parsed
		}
	}

	notifications, err := client.GetNotifications(page, perPage)
	if err != nil {
		writeError(w, "failed to fetch notifications: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, notifications)
}

func (s *Server) handleConversationReplies(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	conversationID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || conversationID == 0 {
		writeError(w, "invalid conversation id", 400)
		return
	}

	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}

	perPage := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			perPage = parsed
		}
	}

	payload, err := client.GetConversationReplies(conversationID, page, perPage)
	if err != nil {
		writeError(w, "failed to fetch conversation replies: "+err.Error(), 502)
		return
	}

	payload["current_user_id"] = sess.VintedUserID

	s.persistIfRefreshed(sess, client)
	writeJSON(w, 200, payload)
}

func (s *Server) persistIfRefreshed(original *session.VintedSession, client *vinted.Client) {
	s.persistSessionIfChanged(original, client.GetSession(), true)
}

func (s *Server) persistSessionIfChanged(original *session.VintedSession, updated *session.VintedSession, markHealthy bool) {
	if original == nil || updated == nil {
		return
	}
	tokenChanged := original.AccessToken != updated.AccessToken || original.RefreshToken != updated.RefreshToken
	if !sessionChanged(original, updated) {
		return
	}

	if markHealthy {
		now := time.Now().UTC().Format(time.RFC3339)
		updated.Status = "active"
		updated.LastCheck = now
		updated.LastValidAt = now
		updated.InvalidReason = ""
		if tokenChanged {
			updated.LastRefreshAt = now
		}
	}

	if err := s.sessions.Store(*updated); err != nil {
		log.Printf("[server] failed to persist session for user %s: %v", updated.UserID, err)
		return
	}

	log.Printf("[server] persisted session update for user %s", updated.UserID)
}

func sessionChanged(original *session.VintedSession, updated *session.VintedSession) bool {
	return original.AccessToken != updated.AccessToken ||
		original.RefreshToken != updated.RefreshToken ||
		original.CookieHeader != updated.CookieHeader ||
		original.CsrfToken != updated.CsrfToken ||
		original.AnonID != updated.AnonID ||
		original.WarmedAt != updated.WarmedAt ||
		original.Status != updated.Status ||
		original.LastCheck != updated.LastCheck ||
		original.LastRefreshAt != updated.LastRefreshAt ||
		original.LastValidAt != updated.LastValidAt ||
		original.InvalidReason != updated.InvalidReason
}

func (s *Server) storeCheckoutLink(userID string, sess *session.VintedSession, link session.CheckoutLink) {
	if userID == "" || sess == nil {
		return
	}
	if strings.TrimSpace(link.CheckoutURL) == "" && strings.TrimSpace(link.PaymentURL) == "" {
		return
	}
	if link.Domain == "" {
		link.Domain = sess.Domain
	}
	if link.CreatedAt == "" {
		link.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err := s.sessions.AddCheckoutLink(userID, link); err != nil {
		log.Printf("[server] failed to store checkout link for user %s: %v", userID, err)
	}
}

type sendMessageRequest struct {
	ItemID   int64  `json:"item_id"`
	SellerID int64  `json:"seller_id"`
	Message  string `json:"message"`
}

type replyToConversationRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Message        string `json:"message"`
}

func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	if req.ItemID == 0 {
		writeError(w, "item_id is required", 400)
		return
	}
	if req.SellerID == 0 {
		writeError(w, "seller_id is required", 400)
		return
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		writeError(w, "message is required", 400)
		return
	}
	if len(msg) > 2000 {
		writeError(w, "message too long (max 2000 characters)", 400)
		return
	}

	if err := client.SendMessage(req.ItemID, req.SellerID, msg); err != nil {
		writeError(w, "send message failed: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)

	writeJSON(w, 200, map[string]interface{}{"status": "sent", "item_id": req.ItemID})
}

func (s *Server) handleReplyToConversation(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req replyToConversationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	if req.ConversationID == 0 {
		writeError(w, "conversation_id is required", 400)
		return
	}

	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		writeError(w, "message is required", 400)
		return
	}
	if len(msg) > 2000 {
		writeError(w, "message too long (max 2000 characters)", 400)
		return
	}

	if err := client.ReplyToConversation(req.ConversationID, msg); err != nil {
		writeError(w, "send reply failed: "+err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)

	writeJSON(w, 200, map[string]interface{}{"status": "sent", "conversation_id": req.ConversationID})
}

type sendOfferRequest struct {
	ItemID   int64  `json:"item_id"`
	SellerID int64  `json:"seller_id"`
	Price    string `json:"price"`
	Currency string `json:"currency"`
}

func (s *Server) handleSendOffer(w http.ResponseWriter, r *http.Request) {
	sess, client, ok := s.getSessionAndClient(r, w)
	if !ok {
		return
	}

	var req sendOfferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", 400)
		return
	}

	if req.ItemID == 0 {
		writeError(w, "item_id is required", 400)
		return
	}
	if req.SellerID == 0 {
		writeError(w, "seller_id is required", 400)
		return
	}
	if req.Price == "" {
		writeError(w, "price is required", 400)
		return
	}
	if req.Currency == "" {
		req.Currency = "EUR" // default
	}

	if err := client.SendOffer(req.ItemID, req.SellerID, req.Price, req.Currency); err != nil {
		writeError(w, err.Error(), 502)
		return
	}

	s.persistIfRefreshed(sess, client)

	writeJSON(w, 200, map[string]interface{}{"status": "sent", "item_id": req.ItemID, "price": req.Price})
}

func (s *Server) handleRefreshToken(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	if userID == "" {
		writeError(w, "unauthorized", 401)
		return
	}

	sess, err := s.sessions.Get(userID)
	if err != nil {
		writeError(w, "session fetch error", 500)
		return
	}
	if sess == nil {
		writeError(w, "no linked Vinted account", 404)
		return
	}
	if sess.BrowserLinked {
		writeError(w, "browser-linked Vinted sessions are refreshed by the browser extension", 400)
		return
	}
	if sess.RefreshToken == "" {
		writeError(w, "no refresh token available — please re-link with a refresh token", 400)
		return
	}

	updated, _, err := s.refreshSessionWithLock(userID, sess)
	if err != nil {
		log.Printf("[refresh] token refresh failed for user %s: %v", userID, err)
		writeError(w, "token refresh failed: "+err.Error(), 502)
		return
	}

	log.Printf("[refresh] token refreshed for user %s (@%s)", userID, updated.VintedName)

	writeJSON(w, 200, map[string]interface{}{
		"status":      "refreshed",
		"vinted_name": updated.VintedName,
		"vinted_id":   updated.VintedUserID,
		"domain":      updated.Domain,
	})
}
