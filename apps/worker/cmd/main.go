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
	"vintrack-worker/internal/model"
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

	// Domains to poll globally. In a larger setup, infer this from monitors.
	// For now, tracking the most common domains to avoid excessive redundant loops.
	activeDomains := map[string]string{
		"de": "www.vinted.de",
		"fr": "www.vinted.fr",
		"pl": "www.vinted.pl",
		"uk": "www.vinted.co.uk",
		"it": "www.vinted.it",
		"nl": "www.vinted.nl",
		"es": "www.vinted.es",
	}

	var (
		feedRunning = make(map[string]context.CancelFunc)
		mu          sync.Mutex
	)

	syncMonitors := func() {
		monitors, err := store.GetActiveMonitors()
		if err != nil {
			log.Printf("Error fetching monitors: %v", err)
			return
		}

		engine.UpdateMonitors(monitors)

		// Find required domains based on active monitors
		requiredDomains := make(map[string]bool)
		for _, m := range monitors {
			if domain, ok := activeDomains[m.Region]; ok {
				requiredDomains[domain] = true
			} else {
				// Default or unlisted region fallback
				domain = model.RegionDomain(m.Region)
				activeDomains[m.Region] = domain
				requiredDomains[domain] = true
			}
		}

		mu.Lock()
		defer mu.Unlock()

		// Start feeds for new domains
		for region, domain := range activeDomains {
			if requiredDomains[domain] {
				if _, exists := feedRunning[domain]; !exists {
					log.Printf("Starting global feed for region: %s (%s)", region, domain)
					fCtx, fCancel := context.WithCancel(ctx)
					feedRunning[domain] = fCancel
					go engine.GlobalFeedTask(fCtx, domain, region)
				}
			}
		}

		// Stop feeds for domains with no active monitors
		for domain, cancelFn := range feedRunning {
			if !requiredDomains[domain] {
				log.Printf("Stopping global feed for domain: %s (no active monitors)", domain)
				cancelFn()
				delete(feedRunning, domain)
			}
		}
	}

	syncMonitors()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	log.Println("Worker running globally. Polling for monitor changes every 5s...")

	for {
		select {
		case <-sigChan:
			log.Println("Shutdown signal received, stopping all feeds...")
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
