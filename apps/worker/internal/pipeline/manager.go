package pipeline

import (
	"context"
	"sync"
	"vintrack-worker/internal/database"
	"vintrack-worker/internal/scraper"
)

type MonitorManager struct {
	db          *database.Store
	engine      *scraper.Engine
	activeTasks map[int]context.CancelFunc
	mu          sync.Mutex
}
