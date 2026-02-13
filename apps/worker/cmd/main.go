package main

import (
	"context"
	"fmt"
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
	fmt.Println("Vinted Worker starting...")
	_ = godotenv.Load()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		panic("DATABASE_URL not set")
	}

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	redisPassword := os.Getenv("REDIS_PASSWORD")

	proxyFile := os.Getenv("PROXY_FILE")
	if proxyFile == "" {
		proxyFile = "proxies.txt"
	}

	fmt.Printf("Connecting to Redis (%s)...\n", redisAddr)
	redisCache, err := cache.NewRedisCache(redisAddr, redisPassword, 0)
	if err != nil {
		panic(fmt.Sprintf("Redis connection failed: %v", err))
	}
	defer redisCache.Close()

	if err := redisCache.Ping(); err != nil {
		panic(fmt.Sprintf("Redis ping failed: %v", err))
	}
	fmt.Println("Redis connected")

	fmt.Println("Connecting to PostgreSQL...")
	store, err := database.NewStore(dbURL, redisCache)
	if err != nil {
		panic(fmt.Sprintf("Database connection failed: %v", err))
	}
	defer store.Close()

	fmt.Println("🔒 Loading proxies...")
	proxyManager, err := proxy.Load(proxyFile)
	if err != nil {
		fmt.Printf("Proxy loading failed: %v (Continuing without proxies)\n", err)
		proxyManager = &proxy.Manager{}
	}

	fmt.Println("Initializing scraper engine...")
	engine := scraper.NewEngine(store, proxyManager)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	runningMonitors := make(map[int]context.CancelFunc)
	var mu sync.Mutex

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	updateMonitors := func() {
		activeMonitors, err := store.GetActiveMonitors()
		if err != nil {
			fmt.Printf("Error fetching monitors from DB: %v\n", err)
			return
		}

		mu.Lock()
		defer mu.Unlock()

		activeIDs := make(map[int]bool)

		for _, m := range activeMonitors {
			activeIDs[m.ID] = true

			if _, exists := runningMonitors[m.ID]; !exists {
				fmt.Printf("Starting Monitor [%d]: %s\n", m.ID, m.Query)

				monitorCtx, monitorCancel := context.WithCancel(ctx)
				runningMonitors[m.ID] = monitorCancel

				go engine.MonitorTask(monitorCtx, m)
			}
		}

		for id, cancelFunc := range runningMonitors {
			if !activeIDs[id] {
				fmt.Printf("Stopping Monitor [%d] (removed or paused)\n", id)
				cancelFunc()
				delete(runningMonitors, id)
			}
		}
	}

	updateMonitors()

	fmt.Println("Worker running. Waiting for monitors / updates...")

	for {
		select {
		case <-sigChan:
			fmt.Println("\nShutdown signal received. Stopping all monitors...")
			cancel()

			time.Sleep(1 * time.Second)
			return

		case <-ticker.C:
			updateMonitors()
		}
	}
}
