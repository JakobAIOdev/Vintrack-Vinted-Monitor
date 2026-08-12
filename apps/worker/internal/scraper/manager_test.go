package scraper

import (
	"context"
	"testing"

	"vintrack-worker/internal/model"
)

func TestParseMaintenanceEnabled(t *testing.T) {
	if enabled, valid := parseMaintenanceEnabled(`{"enabled":true,"revision":"v1"}`); !valid || !enabled {
		t.Fatalf("expected enabled maintenance, got enabled=%v valid=%v", enabled, valid)
	}
	if enabled, valid := parseMaintenanceEnabled(`{"enabled":false}`); !valid || enabled {
		t.Fatalf("expected disabled maintenance, got enabled=%v valid=%v", enabled, valid)
	}
	if _, valid := parseMaintenanceEnabled("not-json"); valid {
		t.Fatal("expected invalid maintenance JSON to be rejected")
	}
}

func TestMaintenanceEndIsTreatedAsSilentResume(t *testing.T) {
	manager := &Manager{
		initialSyncDone: true,
		maintenanceSeen: true,
		maintenanceOn:   true,
	}
	maintenanceJustEnded := manager.recordMaintenanceState(false, true)
	monitor := model.Monitor{}
	if maintenanceJustEnded {
		prepareMonitorResume(&monitor)
	}
	if !monitor.SuppressStartupNotice || !monitor.ResumeAfterQuietHours {
		t.Fatal("expected maintenance resume to suppress startup notices and preserve catch-up behavior")
	}
}

func TestRuntimeCountsRetainTasksUntilDone(t *testing.T) {
	monitorDone := make(chan struct{})
	discoveryDone := make(chan struct{})
	manager := &Manager{
		running: map[int]*managedTask{
			1: {cancel: func() {}, done: monitorDone, stopping: true},
		},
		monitorCfg: map[int]string{1: "monitor"},
		discoveryRunning: map[string]*managedTask{
			"de": {cancel: func() {}, done: discoveryDone, stopping: true},
		},
		discoveryCfg: map[string]string{"de": "discovery"},
	}

	monitorTasks, discoveryTasks := manager.RuntimeCounts()
	if monitorTasks != 1 || discoveryTasks != 1 {
		t.Fatalf("expected both tasks to remain while draining, got monitor=%d discovery=%d", monitorTasks, discoveryTasks)
	}

	close(monitorDone)
	monitorTasks, discoveryTasks = manager.RuntimeCounts()
	if monitorTasks != 0 || discoveryTasks != 1 {
		t.Fatalf("expected only discovery task after monitor returned, got monitor=%d discovery=%d", monitorTasks, discoveryTasks)
	}

	close(discoveryDone)
	monitorTasks, discoveryTasks = manager.RuntimeCounts()
	if monitorTasks != 0 || discoveryTasks != 0 {
		t.Fatalf("expected drain confirmation only after every goroutine returned, got monitor=%d discovery=%d", monitorTasks, discoveryTasks)
	}
}

func TestStopAllCancelsWithoutPrematurelyConfirmingDrain(t *testing.T) {
	monitorDone := make(chan struct{})
	discoveryDone := make(chan struct{})
	monitorCtx, cancelMonitor := context.WithCancel(context.Background())
	discoveryCtx, cancelDiscovery := context.WithCancel(context.Background())
	manager := &Manager{
		running: map[int]*managedTask{
			1: {cancel: cancelMonitor, done: monitorDone},
		},
		monitorCfg: map[int]string{1: "monitor"},
		discoveryRunning: map[string]*managedTask{
			"de": {cancel: cancelDiscovery, done: discoveryDone},
		},
		discoveryCfg: map[string]string{"de": "discovery"},
	}

	manager.StopAll()
	if monitorCtx.Err() != context.Canceled || discoveryCtx.Err() != context.Canceled {
		t.Fatal("expected StopAll to cancel monitor and discovery contexts")
	}
	monitorTasks, discoveryTasks := manager.RuntimeCounts()
	if monitorTasks != 1 || discoveryTasks != 1 {
		t.Fatalf("expected canceled tasks to remain until done, got monitor=%d discovery=%d", monitorTasks, discoveryTasks)
	}

	close(monitorDone)
	close(discoveryDone)
	monitorTasks, discoveryTasks = manager.RuntimeCounts()
	if monitorTasks != 0 || discoveryTasks != 0 {
		t.Fatalf("expected completed tasks to be reaped, got monitor=%d discovery=%d", monitorTasks, discoveryTasks)
	}
}
