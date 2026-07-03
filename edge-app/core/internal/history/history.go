// Package history keeps a small, in-memory ring of recent telemetry samples so
// the local web app can draw live time-series charts of the device's own data.
//
// It is deliberately separate from the on-disk store-and-forward buffer
// (internal/buffer): that one exists to survive a cloud outage and is drained
// oldest-first to the cloud; this one is a bounded, lossy view of "the last few
// hours" for the LOCAL dashboard only. Nothing here ever leaves the device.
package history

import (
	"encoding/json"
	"sync"
	"time"
)

// Sample is one normalized measurement point on the local bus (edge/telemetry).
// Fields are pointers because Layer 1 may report only a subset (a string
// inverter reports generation only; a hybrid adds SoC and grid/load), and a
// missing value must stay distinguishable from a real zero.
type Sample struct {
	Ts          time.Time
	PvKw        *float64 // pv_power_kw
	LoadKw      *float64 // load_kw
	GridKw      *float64 // power_kw at the grid coupling point: + import / - export
	SocPct      *float64 // soc_pct (hybrids only)
	GridLimitKw *float64 // observed §14a envelope, if reported
}

// BatteryKw derives the actual battery power from the power balance
// (grid = load - pv + battery), so battery = grid - load + pv. Positive means
// charging (drawing power in), negative means discharging. It is only defined
// when grid, load and pv are all present. The second return is false otherwise.
func (s Sample) BatteryKw() (float64, bool) {
	if s.GridKw == nil || s.LoadKw == nil || s.PvKw == nil {
		return 0, false
	}
	return *s.GridKw - *s.LoadKw + *s.PvKw, true
}

// MarshalJSON renders the compact wire shape the frontend charts consume:
// millisecond epoch plus short keys, with the derived battery power folded in.
// Absent measurements are omitted (JSON null on the wire), never coerced to 0.
func (s Sample) MarshalJSON() ([]byte, error) {
	m := map[string]any{"t": s.Ts.UnixMilli()}
	if s.PvKw != nil {
		m["pv"] = round3(*s.PvKw)
	}
	if s.LoadKw != nil {
		m["load"] = round3(*s.LoadKw)
	}
	if s.GridKw != nil {
		m["grid"] = round3(*s.GridKw)
	}
	if s.SocPct != nil {
		m["soc"] = round3(*s.SocPct)
	}
	if s.GridLimitKw != nil {
		m["limit"] = round3(*s.GridLimitKw)
	}
	if b, ok := s.BatteryKw(); ok {
		m["batt"] = round3(b)
	}
	return json.Marshal(m)
}

func round3(v float64) float64 {
	return float64(int64(v*1000+sign(v)*0.5)) / 1000
}

func sign(v float64) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

// Ring is a bounded, concurrency-safe buffer of the most recent samples.
type Ring struct {
	mu  sync.RWMutex
	buf []Sample
	max int
}

// New returns a ring holding at most max samples (oldest dropped first).
func New(max int) *Ring {
	if max < 1 {
		max = 1
	}
	return &Ring{max: max, buf: make([]Sample, 0, max)}
}

// Add appends a sample, evicting the oldest once the cap is reached.
func (r *Ring) Add(s Sample) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.buf) >= r.max {
		// Shift left by one; cheap at these sizes and keeps a stable window.
		copy(r.buf, r.buf[1:])
		r.buf[len(r.buf)-1] = s
		return
	}
	r.buf = append(r.buf, s)
}

// Since returns all samples strictly newer than t, in chronological order.
func (r *Ring) Since(t time.Time) []Sample {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Sample, 0)
	for _, s := range r.buf {
		if s.Ts.After(t) {
			out = append(out, s)
		}
	}
	return out
}

// Recent returns the samples within the trailing window ending at now.
func (r *Ring) Recent(window time.Duration, now time.Time) []Sample {
	return r.Since(now.Add(-window))
}

// Latest returns the newest sample, ok=false when the ring is empty.
func (r *Ring) Latest() (Sample, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.buf) == 0 {
		return Sample{}, false
	}
	return r.buf[len(r.buf)-1], true
}

// Len reports how many samples are currently held.
func (r *Ring) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.buf)
}
