package agent

import (
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// LATE PAIRING after a station-side start or stop (csms.Connector.PowerSettled).
//
// The control law needs `grid − charging` of ONE moment. While every connector
// has settled, the current grid reading and the newest MeterValues sample are
// that moment (ocppObserve). A car that just woke up ramps over several
// MeterValues, and the grid meter sees each step seconds before the station
// reports it. Then the newest charging sample measures its own moment only, so
// it is paired with the grid reading taken nearest to it - kept here for one
// metering cadence - and the readings in between are dropped. One correct pair
// per MeterValues sample keeps the lanes measured; a mispaired one would
// govern the trailing maximum for a whole minute.

// ocppPairWindow is how far a grid reading may lie from a settling connector's
// sample and still describe the same moment. The inverter is read every 5 s,
// so the nearest reading is at most 2.5 s away plus read jitter.
const ocppPairWindow = 3 * time.Second

// ocppGridMemory is how long grid readings are kept for a late pair: one
// MeterValues cadence plus the window.
const ocppGridMemory = csms.DefaultMeterInterval + ocppPairWindow

// gridReading is one telemetry sample of the connection point, with what the
// claiming wallboxes drew at that moment.
type gridReading struct {
	at        time.Time
	gridKw    float64
	battKw    *float64
	wallboxKw float64
}

func (r gridReading) measurement(chargingKw float64, complete bool) lastmgmt.Measurement {
	m := lastmgmt.Measurement{GridKw: r.gridKw, ChargingKw: chargingKw + r.wallboxKw, Complete: complete}
	if r.battKw != nil {
		m.HaveBattery, m.BatteryKw = true, *r.battKw
	}
	return m
}

// gridPairer remembers the recent grid readings and which of them were
// already handed to the tracker.
type gridPairer struct {
	mu     sync.Mutex
	recent []gridReading
	// fedAt is the newest reading handed to the tracker as COMPLETE; the
	// tracker ignores anything older.
	fedAt time.Time
	// pairedAt is the newest settling sample already paired, so one sample is
	// never paired twice.
	pairedAt time.Time
}

// pair decides what one new grid reading contributes:
//   - itself with the current charging total, when everything has settled or
//     the settling sample lies within the window before it (then they ARE one
//     moment, and a building load step is seen at once);
//   - else the late pair of the newest settling sample with its nearest
//     reading, once per sample;
//   - else an incomplete reading, which the tracker records as such.
//
// ⚠ While a connector settles, a building load step therefore reaches the
// executor with the next pair - at worst one MeterValues cadence later. That
// is the same price MeterInTransit pays after every commanded change; a
// mispaired reading instead would govern both lanes for a whole minute.
func (p *gridPairer) pair(r gridReading, snap csms.Snapshot) (time.Time, lastmgmt.Measurement) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.remember(r)
	charging, complete, pairAt := snap.ChargingPair(r.at, ocppMeterMaxAge, ocppPairWindow)
	switch {
	case !complete:
		return r.at, r.measurement(charging, false)
	case pairAt.IsZero() || r.at.Sub(pairAt) <= ocppPairWindow:
		if pairAt.After(p.pairedAt) {
			p.pairedAt = pairAt
		}
		if r.at.After(p.fedAt) {
			p.fedAt = r.at
		}
		return r.at, r.measurement(charging, true)
	case pairAt.After(p.pairedAt):
		if best, ok := p.nearest(pairAt); ok {
			p.pairedAt, p.fedAt = pairAt, best.at
			return best.at, best.measurement(charging, true)
		}
	}
	return r.at, r.measurement(charging, false)
}

// remember keeps the reading and forgets what no late pair can use any more.
func (p *gridPairer) remember(r gridReading) {
	keep := p.recent[:0]
	for _, old := range p.recent {
		if r.at.Sub(old.at) <= ocppGridMemory && old.at.Before(r.at) {
			keep = append(keep, old)
		}
	}
	p.recent = append(keep, r)
}

// nearest is the reading closest to at within the window, among those newer
// than the last one the tracker accepted.
func (p *gridPairer) nearest(at time.Time) (gridReading, bool) {
	var best gridReading
	bestGap := time.Duration(-1)
	for _, r := range p.recent {
		if !r.at.After(p.fedAt) {
			continue
		}
		gap := r.at.Sub(at)
		if gap < 0 {
			gap = -gap
		}
		if gap <= ocppPairWindow && (bestGap < 0 || gap < bestGap) {
			best, bestGap = r, gap
		}
	}
	return best, bestGap >= 0
}
