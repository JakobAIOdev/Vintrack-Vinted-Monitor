package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"vintrack-vinted/internal/api"
	"vintrack-vinted/internal/session"
	"vintrack-vinted/internal/vinted"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(log.Ltime)
	log.Println("Vintrack Vinted Service starting...")
	_ = godotenv.Load()

	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	redisPassword := getEnv("REDIS_PASSWORD", "")
	listenAddr := getEnv("LISTEN_ADDR", ":4000")

	sessionMgr, err := session.NewManager(redisAddr, redisPassword)
	if err != nil {
		log.Fatalf("Session manager: %v", err)
	}
	defer sessionMgr.Close()

	go sessionMgr.StartKeepAlive(func(sess *session.VintedSession) bool {
		client, err := vinted.NewClient(sess)
		if err != nil {
			return false
		}
		_ = client.WarmUp()

		if client.ValidateSession() {
			return true
		}

		if sess.RefreshToken != "" {
			log.Printf("[keep-alive] validation failed for user %s, attempting token refresh...", sess.UserID)
			if err := client.RefreshAccessToken(); err != nil {
				log.Printf("[keep-alive] token refresh failed for user %s: %v", sess.UserID, err)
				return false
			}

			updated := client.GetSession()
			updated.Status = "active"
			updated.LastCheck = time.Now().UTC().Format(time.RFC3339)
			_ = sessionMgr.Store(*updated)
			sess.AccessToken = updated.AccessToken
			sess.RefreshToken = updated.RefreshToken
			log.Printf("[keep-alive] token refreshed for user %s", sess.UserID)
			return true
		}

		return false
	})

	server := api.NewServer(sessionMgr, listenAddr)

	go func() {
		if err := server.Start(); err != nil {
			log.Fatalf("Server error: %v", err)
		}
	}()

	log.Printf("Vinted Service ready on %s", listenAddr)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down...")
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
