package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"
)

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Println("WARNING: No .env file found, relying on system env vars")
	}

	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		log.Fatal("ERROR: DATABASE_URL is not set in .env")
	}

	proxyFile := os.Getenv("PROXY_FILE")
	if proxyFile == "" {
		proxyFile = "proxies.txt"
	}

	db, err := database.NewStore(connStr)
	if err != nil {
		log.Fatal("ERROR: DB Init Error:", err)
	}
	fmt.Println("Connected to Database")

	pm, err := proxy.Load(proxyFile)
	if err != nil {
		log.Println("WARNING: No proxies found. Using Localhost.")
		pm = &proxy.Manager{}
	}

	engine := scraper.NewEngine(db, pm)

	runningMonitors := make(map[int]bool)

	fmt.Println("Worker started. Waiting for active monitors...")

	pollIntervalStr := os.Getenv("DB_POLL_INTERVAL_SEC")
	pollInterval := 10
	if val, err := strconv.Atoi(pollIntervalStr); err == nil {
		pollInterval = val
	}

	for {
		monitors, err := db.GetActiveMonitors()
		if err != nil {
			log.Println("WARNING: DB Poll Error:", err)
			time.Sleep(time.Duration(pollInterval) * time.Second)
			continue
		}

		for _, m := range monitors {
			if !runningMonitors[m.ID] {
				runningMonitors[m.ID] = true
				go engine.MonitorTask(m)
			}
		}

		time.Sleep(time.Duration(pollInterval) * time.Second)
	}
}
