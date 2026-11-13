package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"vintrack-vinted/internal/api"
	"vintrack-vinted/internal/config"
	"vintrack-vinted/internal/session"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(log.Ltime)
	log.Println("Vintrack Vinted Service starting...")
	_ = godotenv.Load()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Configuration: %v", err)
	}

	sessionMgr, err := session.NewManager(cfg.RedisAddr, cfg.RedisPassword, cfg.DatabaseURL, cfg.EncryptionKey)
	if err != nil {
		log.Fatalf("Session manager: %v", err)
	}
	defer sessionMgr.Close()

	server := api.NewServer(sessionMgr, cfg.ListenAddr)
	if cfg.CheckoutDevDirect {
		server.AllowDirectCheckoutForDevelopment()
		log.Println("[checkout] DEVELOPMENT MODE: request checkout connects directly from this host and ignores member proxy groups (CHECKOUT_DEV_DIRECT_CONNECTION=true)")
	}
	go sessionMgr.StartKeepAlive(server.ValidateSessionForKeepAlive)
	automationCtx, stopAutomations := context.WithCancel(context.Background())
	defer stopAutomations()
	go server.StartAccountAutomations(automationCtx)

	go func() {
		if err := server.Start(); err != nil {
			log.Fatalf("Server error: %v", err)
		}
	}()

	log.Printf("Vinted Service ready on %s", cfg.ListenAddr)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down...")
	// One checkout is at most a warmup plus four sequential 15 s requests.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Shutdown did not complete cleanly: %v", err)
	}
}
