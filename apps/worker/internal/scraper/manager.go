package scraper

import (
	"context"
	"log"
	"sync"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
)

type Manager struct {
	store            *database.Store
	engine           *Engine
	running          map[int]context.CancelFunc
	monitorCfg       map[int]string
	discoveryRunning map[string]context.CancelFunc
	discoveryCfg     map[string]string
	scheduledPaused  map[int]bool
	mu               sync.Mutex
}

func NewManager(store *database.Store, engine *Engine) *Manager {
	return &Manager{
		store:            store,
		engine:           engine,
		running:          make(map[int]context.CancelFunc),
		monitorCfg:       make(map[int]string),
		discoveryRunning: make(map[string]context.CancelFunc),
		discoveryCfg:     make(map[string]string),
		scheduledPaused:  make(map[int]bool),
	}
}

func (m *Manager) Sync(ctx context.Context) {
	expiredDemoIDs, err := m.store.PauseExpiredDemoMonitors()
	if err != nil {
		log.Printf("Error pausing expired demo monitors: %v", err)
	} else if len(expiredDemoIDs) > 0 {
		log.Printf("Auto-paused %d expired demo monitor(s)", len(expiredDemoIDs))
	}

	monitors, err := m.store.GetActiveMonitors()
	if err != nil {
		log.Printf("Error fetching monitors: %v", err)
		return
	}
	m.engine.SyncNotificationPolicies(monitors)

	m.mu.Lock()
	defer m.mu.Unlock()

	activeIDs := make(map[int]bool, len(monitors))
	returnedIDs := make(map[int]bool, len(monitors))
	discoveryMonitors := make([]model.Monitor, 0, len(monitors))
	now := time.Now()

	for i := range monitors {
		mon := &monitors[i]
		returnedIDs[mon.ID] = true
		if mon.ProxySource == "free" {
			mon.FreeProxyVersion = m.engine.FreeProxyRegionVersion(mon.Region)
		} else if mon.ProxyGroupID == nil {
			mon.ServerProxyVersion = m.engine.ServerProxyVersion()
		}
		quietHoursActive := monitorQuietHoursActive(*mon, now)
		if !quietHoursActive {
			discoveryMonitors = append(discoveryMonitors, *mon)
		}
		if monitorScheduledPause(*mon, now) {
			m.scheduledPaused[mon.ID] = true
			continue
		}
		if m.scheduledPaused[mon.ID] {
			mon.SuppressStartupNotice = true
			delete(m.scheduledPaused, mon.ID)
		}
		activeIDs[mon.ID] = true
		hash := monitorConfigFingerprint(*mon)

		if cancelFn, exists := m.running[mon.ID]; exists {
			if oldHash, ok := m.monitorCfg[mon.ID]; ok && oldHash != hash {
				log.Printf("Config changed for monitor [%d], restarting...", mon.ID)
				cancelFn()
				delete(m.running, mon.ID)
			} else {
				continue
			}
		}

		mCtx, mCancel := context.WithCancel(ctx)
		m.running[mon.ID] = mCancel
		m.monitorCfg[mon.ID] = hash
		go m.engine.MonitorTask(mCtx, *mon)
	}

	for id, cancelFn := range m.running {
		if !activeIDs[id] {
			log.Printf("Stopping monitor [%d] (removed/paused)", id)
			cancelFn()
			delete(m.running, id)
			delete(m.monitorCfg, id)
		}
	}
	for id := range m.scheduledPaused {
		if !returnedIDs[id] {
			delete(m.scheduledPaused, id)
		}
	}

	discoverySpecs := BuildDiscoverySpecs(discoveryMonitors, m.engine.discoveryMode)
	for key, spec := range discoverySpecs {
		if cancelFn, exists := m.discoveryRunning[key]; exists {
			if m.discoveryCfg[key] == spec.Fingerprint {
				continue
			}
			cancelFn()
			delete(m.discoveryRunning, key)
			delete(m.discoveryCfg, key)
		}
		dCtx, dCancel := context.WithCancel(ctx)
		m.discoveryRunning[key] = dCancel
		m.discoveryCfg[key] = spec.Fingerprint
		go m.engine.DiscoveryTask(dCtx, spec)
	}
	for key, cancelFn := range m.discoveryRunning {
		if _, active := discoverySpecs[key]; !active {
			cancelFn()
			delete(m.discoveryRunning, key)
			delete(m.discoveryCfg, key)
		}
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, cancelFn := range m.running {
		cancelFn()
		delete(m.running, id)
		delete(m.monitorCfg, id)
	}
	for key, cancelFn := range m.discoveryRunning {
		cancelFn()
		delete(m.discoveryRunning, key)
		delete(m.discoveryCfg, key)
	}
}
