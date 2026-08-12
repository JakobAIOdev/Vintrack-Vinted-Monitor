package scraper

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"vintrack-worker/internal/database"
	"vintrack-worker/internal/model"
)

type Manager struct {
	store            *database.Store
	engine           *Engine
	running          map[int]*managedTask
	monitorCfg       map[int]string
	discoveryRunning map[string]*managedTask
	discoveryCfg     map[string]string
	scheduledPaused  map[int]bool
	initialSyncDone  bool
	maintenanceSeen  bool
	maintenanceOn    bool
	mu               sync.Mutex
}

type managedTask struct {
	cancel   context.CancelFunc
	done     chan struct{}
	stopping bool
}

func NewManager(store *database.Store, engine *Engine) *Manager {
	return &Manager{
		store:            store,
		engine:           engine,
		running:          make(map[int]*managedTask),
		monitorCfg:       make(map[int]string),
		discoveryRunning: make(map[string]*managedTask),
		discoveryCfg:     make(map[string]string),
		scheduledPaused:  make(map[int]bool),
	}
}

func (m *Manager) Sync(ctx context.Context) {
	maintenanceEnabled, maintenanceRead := m.readMaintenanceEnabled(ctx)
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
	m.reapFinishedTasksLocked()
	initialWorkerSync := !m.initialSyncDone
	m.initialSyncDone = true
	maintenanceJustEnded := m.recordMaintenanceState(maintenanceEnabled, maintenanceRead)

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
		if initialWorkerSync || maintenanceJustEnded || m.scheduledPaused[mon.ID] {
			prepareMonitorResume(mon)
			delete(m.scheduledPaused, mon.ID)
		}
		activeIDs[mon.ID] = true
		hash := monitorConfigFingerprint(*mon)

		if task, exists := m.running[mon.ID]; exists {
			if task.stopping {
				continue
			}
			if oldHash, ok := m.monitorCfg[mon.ID]; ok && oldHash != hash {
				log.Printf("Config changed for monitor [%d], restarting...", mon.ID)
				task.cancel()
				task.stopping = true
				// A config refresh is a continuation of an existing monitor. Treat
				// its first catalog response as a resume so items published during
				// the restart window are checked instead of silently seeded.
				prepareMonitorResume(mon)
				continue
			} else {
				continue
			}
		}

		mCtx, mCancel := context.WithCancel(ctx)
		task := &managedTask{cancel: mCancel, done: make(chan struct{})}
		m.running[mon.ID] = task
		m.monitorCfg[mon.ID] = hash
		go func(ctx context.Context, monitor model.Monitor, managed *managedTask) {
			defer close(managed.done)
			m.engine.MonitorTask(ctx, monitor)
		}(mCtx, *mon, task)
	}

	for id, task := range m.running {
		if !activeIDs[id] {
			if !task.stopping {
				log.Printf("Stopping monitor [%d] (removed/paused)", id)
				task.cancel()
				task.stopping = true
			}
		}
	}
	for id := range m.scheduledPaused {
		if !returnedIDs[id] {
			delete(m.scheduledPaused, id)
		}
	}

	discoverySpecs := BuildDiscoverySpecs(discoveryMonitors, m.engine.discoveryMode)
	for key, spec := range discoverySpecs {
		if task, exists := m.discoveryRunning[key]; exists {
			if task.stopping {
				continue
			}
			if m.discoveryCfg[key] == spec.Fingerprint {
				continue
			}
			task.cancel()
			task.stopping = true
			continue
		}
		dCtx, dCancel := context.WithCancel(ctx)
		task := &managedTask{cancel: dCancel, done: make(chan struct{})}
		m.discoveryRunning[key] = task
		m.discoveryCfg[key] = spec.Fingerprint
		go func(ctx context.Context, discoverySpec DiscoverySpec, managed *managedTask) {
			defer close(managed.done)
			m.engine.DiscoveryTask(ctx, discoverySpec)
		}(dCtx, spec, task)
	}
	for key, task := range m.discoveryRunning {
		if _, active := discoverySpecs[key]; !active {
			if !task.stopping {
				task.cancel()
				task.stopping = true
			}
		}
	}
}

func parseMaintenanceEnabled(value string) (bool, bool) {
	var setting struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal([]byte(value), &setting); err != nil {
		return false, false
	}
	return setting.Enabled, true
}

func (m *Manager) recordMaintenanceState(enabled bool, read bool) bool {
	if !read {
		return false
	}
	justEnded := m.maintenanceSeen && m.maintenanceOn && !enabled
	m.maintenanceSeen = true
	m.maintenanceOn = enabled
	return justEnded
}

func (m *Manager) readMaintenanceEnabled(ctx context.Context) (bool, bool) {
	value, exists, err := m.store.GetSettingValueContext(ctx, "monitor_maintenance")
	if err != nil {
		log.Printf("Error fetching monitor maintenance state: %v", err)
		return false, false
	}
	if !exists {
		return false, true
	}
	enabled, valid := parseMaintenanceEnabled(value)
	if !valid {
		log.Printf("Invalid monitor maintenance state; keeping previous worker state")
		return false, false
	}
	return enabled, true
}

func (m *Manager) reapFinishedTasksLocked() {
	for id, task := range m.running {
		select {
		case <-task.done:
			delete(m.running, id)
			delete(m.monitorCfg, id)
		default:
		}
	}
	for key, task := range m.discoveryRunning {
		select {
		case <-task.done:
			delete(m.discoveryRunning, key)
			delete(m.discoveryCfg, key)
		default:
		}
	}
}

func (m *Manager) RuntimeCounts() (monitorTasks int, discoveryTasks int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reapFinishedTasksLocked()
	return len(m.running), len(m.discoveryRunning)
}

func prepareMonitorResume(monitor *model.Monitor) {
	monitor.SuppressStartupNotice = true
	monitor.ResumeAfterQuietHours = true
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, task := range m.running {
		if !task.stopping {
			task.cancel()
			task.stopping = true
		}
	}
	for _, task := range m.discoveryRunning {
		if !task.stopping {
			task.cancel()
			task.stopping = true
		}
	}
	m.reapFinishedTasksLocked()
}
