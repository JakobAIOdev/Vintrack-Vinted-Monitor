package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

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
		return client.ValidateSession()
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
