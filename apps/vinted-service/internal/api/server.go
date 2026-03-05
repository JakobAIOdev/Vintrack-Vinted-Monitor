package api

import (
	"encoding/json"
	"log"
	"net/http"
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

func (s *Server) Start() error {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/account/link", s.handleLink)
	mux.HandleFunc("DELETE /api/account/unlink", s.handleUnlink)
	mux.HandleFunc("GET /api/account/status", s.handleStatus)
	mux.HandleFunc("GET /api/account/info", s.handleInfo)

	mux.HandleFunc("POST /api/items/like", s.handleLike)
	mux.HandleFunc("POST /api/items/unlike", s.handleUnlike)
	mux.HandleFunc("GET /api/items/liked", s.handleLikedItems)

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

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create Vinted client", 500)
		return nil, nil, false
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[session] warmup failed for user %s: %v", userID, err)
	}

	if sess.Status != "active" {
		log.Printf("[session] session for user %s is %s, attempting recovery...", userID, sess.Status)

		if sess.RefreshToken != "" {
			log.Printf("[session] attempting token refresh for user %s...", userID)
			if err := client.RefreshAccessToken(); err != nil {
				log.Printf("[session] token refresh failed for user %s: %v", userID, err)
			} else {
				log.Printf("[session] token refresh succeeded for user %s", userID)
				updated := client.GetSession()
				updated.Status = "active"
				updated.LastCheck = time.Now().UTC().Format(time.RFC3339)
				_ = s.sessions.Store(*updated)
				sess = updated
				return sess, client, true
			}
		}

		if client.ValidateSession() {
			log.Printf("[session] re-validation succeeded for user %s, reactivating session", userID)
			sess.Status = "active"
			sess.LastCheck = time.Now().UTC().Format(time.RFC3339)
			_ = s.sessions.Store(*sess)
		} else {
			writeError(w, "Vinted session is "+sess.Status+", please re-link", 403)
			return nil, nil, false
		}
	}

	return sess, client, true
}

type linkRequest struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Domain       string `json:"domain"`
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

	if req.AccessToken == "" {
		writeError(w, "access_token is required", 400)
		return
	}
	if req.Domain == "" {
		writeError(w, "domain is required", 400)
		return
	}

	sess := session.VintedSession{
		UserID:       userID,
		AccessToken:  req.AccessToken,
		RefreshToken: req.RefreshToken,
		Domain:       req.Domain,
		Status:       "active",
		LinkedAt:     time.Now().UTC().Format(time.RFC3339),
		LastCheck:    time.Now().UTC().Format(time.RFC3339),
	}

	client, err := vinted.NewClient(&sess)
	if err != nil {
		writeError(w, "failed to create client: "+err.Error(), 500)
		return
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[link] warmup warning for user %s: %v", userID, err)
	}

	info, err := client.GetAccountInfo()
	if err != nil {
		writeError(w, "invalid token: "+err.Error(), 401)
		return
	}

	sess.VintedUserID = info.ID
	sess.VintedName = info.Login

	if err := s.sessions.Store(sess); err != nil {
		writeError(w, "failed to save session", 500)
		return
	}

	log.Printf("[account] linked user %s -> @%s (ID: %d) on %s", userID, info.Login, info.ID, req.Domain)

	writeJSON(w, 200, map[string]interface{}{
		"linked":      true,
		"vinted_name": info.Login,
		"vinted_id":   info.ID,
		"domain":      req.Domain,
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

	writeJSON(w, 200, map[string]interface{}{
		"linked":      true,
		"status":      sess.Status,
		"vinted_name": sess.VintedName,
		"vinted_id":   sess.VintedUserID,
		"domain":      sess.Domain,
		"linked_at":   sess.LinkedAt,
		"last_check":  sess.LastCheck,
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

func (s *Server) persistIfRefreshed(original *session.VintedSession, client *vinted.Client) {
	updated := client.GetSession()
	if updated.AccessToken != original.AccessToken {
		updated.Status = "active"
		updated.LastCheck = time.Now().UTC().Format(time.RFC3339)
		if err := s.sessions.Store(*updated); err != nil {
			log.Printf("[server] failed to persist refreshed session for user %s: %v", updated.UserID, err)
		} else {
			log.Printf("[server] persisted refreshed tokens for user %s", updated.UserID)
		}
	}
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
	if sess.RefreshToken == "" {
		writeError(w, "no refresh token available — please re-link with a refresh token", 400)
		return
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create client", 500)
		return
	}

	if err := client.WarmUp(); err != nil {
		log.Printf("[refresh] warmup warning for user %s: %v", userID, err)
	}

	if err := client.RefreshAccessToken(); err != nil {
		log.Printf("[refresh] token refresh failed for user %s: %v", userID, err)

		var body struct {
			RefreshToken string `json:"refresh_token"`
		}
		_ = json.NewDecoder(strings.NewReader("")).Decode(&body)

		writeError(w, "token refresh failed: "+err.Error(), 502)
		return
	}

	updated := client.GetSession()
	updated.Status = "active"
	updated.LastCheck = time.Now().UTC().Format(time.RFC3339)
	if err := s.sessions.Store(*updated); err != nil {
		writeError(w, "failed to save refreshed session", 500)
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
