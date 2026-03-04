package api

import (
	"encoding/json"
	"log"
	"net/http"
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
	if sess.Status != "active" {
		writeError(w, "Vinted session is "+sess.Status+", please re-link", 403)
		return nil, nil, false
	}

	client, err := vinted.NewClient(sess)
	if err != nil {
		writeError(w, "failed to create Vinted client", 500)
		return nil, nil, false
	}

	_ = client.WarmUp()

	return sess, client, true
}

type linkRequest struct {
	AccessToken string `json:"access_token"`
	Domain      string `json:"domain"`
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
		UserID:      userID,
		AccessToken: req.AccessToken,
		Domain:      req.Domain,
		Status:      "active",
		LinkedAt:    time.Now().UTC().Format(time.RFC3339),
		LastCheck:   time.Now().UTC().Format(time.RFC3339),
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
	_, client, ok := s.getSessionAndClient(r, w)
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

	userID := getUserID(r)
	_ = s.sessions.AddLike(userID, req.ItemID)

	writeJSON(w, 200, map[string]interface{}{"status": "liked", "item_id": req.ItemID})
}

func (s *Server) handleUnlike(w http.ResponseWriter, r *http.Request) {
	_, client, ok := s.getSessionAndClient(r, w)
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
