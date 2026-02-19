package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"vintrack-worker/internal/cache"
	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(log.Ltime)
	log.Println("Vintrack Worker starting...")
	_ = godotenv.Load()

	dbURL := mustEnv("DATABASE_URL")
	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	proxyFile := getEnv("PROXY_FILE", "proxies.txt")

	redisCache, err := cache.NewRedisCache(redisAddr, os.Getenv("REDIS_PASSWORD"), 0)
	if err != nil {
		log.Fatalf("Redis: %v", err)
	}
	defer redisCache.Close()

	store, err := database.NewStore(dbURL, redisCache)
	if err != nil {
		log.Fatalf("PostgreSQL: %v", err)
	}
	defer store.Close()

	proxyManager, err := proxy.Load(proxyFile)
	if err != nil {
		log.Printf("Proxies: %v (continuing without)", err)
		proxyManager = &proxy.Manager{}
	}

	engine := scraper.NewEngine(store, proxyManager)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var (
		running = make(map[int]context.CancelFunc)
		mu      sync.Mutex
	)

	syncMonitors := func() {
		monitors, err := store.GetActiveMonitors()
		if err != nil {
			log.Printf("Error fetching monitors: %v", err)
			return
		}

		mu.Lock()
		defer mu.Unlock()

		activeIDs := make(map[int]bool, len(monitors))

		for _, m := range monitors {
			activeIDs[m.ID] = true
			if _, exists := running[m.ID]; !exists {
				mCtx, mCancel := context.WithCancel(ctx)
				running[m.ID] = mCancel
				go engine.MonitorTask(mCtx, m)
			}
		}

		for id, cancelFn := range running {
			if !activeIDs[id] {
				log.Printf("Stopping monitor [%d] (removed/paused)", id)
				cancelFn()
				delete(running, id)
			}
		}
	}

	syncMonitors()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	log.Println("Worker running. Polling for monitor changes every 5s...")

	for {
		select {
		case <-sigChan:
			log.Println("Shutdown signal received, stopping all monitors...")
			cancel()
			time.Sleep(time.Second)
			return
		case <-ticker.C:
			syncMonitors()
		}
	}
}

func mustEnv(key string) string {
	val := os.Getenv(key)
	if val == "" {
		log.Fatalf("Required env var %s not set", key)
	}
	return val
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
