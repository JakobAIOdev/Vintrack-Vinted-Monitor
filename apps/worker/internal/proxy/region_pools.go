package proxy

import "sync"

type RegionPools struct {
	mu    sync.RWMutex
	pools map[string]*Manager
}

func NewRegionPools() *RegionPools {
	return &RegionPools{pools: make(map[string]*Manager)}
}

func (p *RegionPools) Manager(region string) *Manager {
	p.mu.RLock()
	manager := p.pools[region]
	p.mu.RUnlock()
	if manager != nil {
		return manager
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if manager = p.pools[region]; manager != nil {
		return manager
	}
	manager = &Manager{}
	p.pools[region] = manager
	return manager
}

func (p *RegionPools) Replace(region string, raw string) bool {
	return p.Manager(region).ReplaceFromString(raw)
}

func (p *RegionPools) Publish(region string, raw string, state string, mature int, reason string, readyObservations int) bool {
	return p.Manager(region).ReplaceSnapshot(raw, state, mature, reason, readyObservations)
}

func (p *RegionPools) Snapshot(region string) PoolSnapshot {
	return p.Manager(region).PoolSnapshot()
}

// RegionInactiveReason marks a manager that Retain emptied because its region
// is not configured right now.
const RegionInactiveReason = "region_inactive"

// Retain empties pools that are no longer configured. The Manager itself stays
// registered: monitor tasks and client pools hold the pointer for as long as
// the process runs, so handing out a fresh Manager when the region returns
// would leave them bound to an empty one that is never published to again.
func (p *RegionPools) Retain(regions []string) {
	desired := make(map[string]bool, len(regions))
	for _, region := range regions {
		desired[region] = true
	}

	p.mu.RLock()
	inactive := make([]*Manager, 0)
	for region, manager := range p.pools {
		if !desired[region] {
			inactive = append(inactive, manager)
		}
	}
	p.mu.RUnlock()

	for _, manager := range inactive {
		manager.ReplaceSnapshot("", "recovering", 0, RegionInactiveReason, 0)
	}
}

func (p *RegionPools) Version(region string) uint64 {
	return p.Manager(region).Version()
}
