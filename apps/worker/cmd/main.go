package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/proxy"
	"vintrack-worker/internal/scraper"

	"github.com/joho/godotenv"
)

func main() {
	godotenv.Load()

	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		log.Fatal("DATABASE_URL missing")
	}

	db, err := database.NewStore(connStr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("DB Connected")

	proxyFile := os.Getenv("PROXY_FILE")
	if proxyFile == "" {
		proxyFile = "proxies.txt"
	}
	pm, _ := proxy.Load(proxyFile)
	if pm == nil {
		pm = &proxy.Manager{}
	}

	engine := scraper.NewEngine(db, pm)

	runningMonitors := make(map[int]context.CancelFunc)

	fmt.Println("Worker Manager running...")

	pollInterval := 5
	if val, err := strconv.Atoi(os.Getenv("DB_POLL_INTERVAL_SEC")); err == nil {
		pollInterval = val
	}

	for {
		activeMonitors, err := db.GetActiveMonitors()
		if err != nil {
			log.Println("DB Poll Error:", err)
			time.Sleep(time.Duration(pollInterval) * time.Second)
			continue
		}

		activeIDs := make(map[int]bool)

		for _, m := range activeMonitors {
			activeIDs[m.ID] = true

			if _, isRunning := runningMonitors[m.ID]; !isRunning {
				fmt.Printf("Starting Monitor [%d]: %s\n", m.ID, m.Query)

				ctx, cancel := context.WithCancel(context.Background())
				runningMonitors[m.ID] = cancel

				go engine.MonitorTask(ctx, m)
			}
		}

		for id, cancelFunc := range runningMonitors {
			if !activeIDs[id] {
				fmt.Printf("Stopping Monitor [%d] (removed from active list)\n", id)
				cancelFunc()
				delete(runningMonitors, id)
			}
		}

		time.Sleep(time.Duration(pollInterval) * time.Second)
	}
}
