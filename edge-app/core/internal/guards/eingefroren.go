package guards

// The frozen connection-point value (UEMS AP-15 IP-20, rule B2; concept
// vp-uems-ap15-verbund §3.6, matrix row A7, case R9). A meter can die without
// going quiet: it keeps sending telegrams with a fresh timestamp and always
// the same number. A watchdog that only looks at the age would call it healthy
// and regulate against a figure that no longer holds. So B2: fresh is the own
// connection-point value up to 30 s (as today); FROZEN counts as blind - the
// value has not changed for 60 s although the box itself moved its actuators
// by >= 2 kW (start values, the test bench confirms them, NW-7).
//
// THE PROBE RUNS IN OPERATION and never makes a test step of its own (the
// triggered step probe before arming is IP-21). It listens to two things:
//
//	Wert       every connection-point value (the box's own, G1)
//	Verstellt  every EFFECTIVE change of the box's own actuators, signed in
//	           the sign of the grid channel (+ import / - export)
//
// and answers one question: since when is the value frozen? A value change
// re-anchors the probe; so does nothing else. The own adjustments are summed
// SIGNED since the last change - a PV cap lowered by 5 kW (+5) and a charge
// point lowered by 5 kW (-5) cancel at the meter and prove nothing. Frozen
// means: that sum has stood at least EinfrierStellKw away from its value at
// the last change for EinfrierFenster, and the value has not moved. The
// verdict latches until the value changes again (a blind box that ramps down
// adjusts even more; it must not un-freeze by returning to its old point).
//
// NO FALSE ALARM BY CONSTRUCTION: a resting plant (nothing adjusted), a night
// without PV (a PV cap has nothing to cut), an adjustment below 2 kW and one
// that cannot reach the meter never arm it - only what MUST show at the meter
// is counted (WirksamGesenkt, WirksamSpeicher): lowering a ceiling counts only
// down to the flow measured at that moment (a cap from 80 to 70 kW at 30 kW
// generation changes nothing), a raise never counts (it only permits), and a
// battery counts only its move towards 0 from its MEASURED power.
//
// The answer "frozen since" is the time of the LAST CHANGE: a repeated value is
// no measurement, the last proof of life is. The watchdogs treat it exactly
// like a measurement that old - the same stages, the same braked release once
// the value moves again. What the probe decides is only ever "blind": it can
// narrow a watchdog, never widen one (V5).

import (
	"math"
	"sync"
	"time"
)

const (
	// EinfrierStellKw is the Startwert of B2: the box's own effective
	// adjustment (summed, signed) that MUST show at the connection point.
	EinfrierStellKw = 2.0
	// EinfrierFenster is the Startwert of B2: how long the value may stand
	// still after such an adjustment before it counts as frozen.
	EinfrierFenster = 60 * time.Second
)

// Einfrierprobe detects a frozen connection-point value (B2). The zero value
// is ready to use; it is concurrency-safe (Wert runs on the telemetry path,
// Verstellt on the setpoint and charging paths).
type Einfrierprobe struct {
	mu sync.Mutex

	seen   bool
	wert   float64
	wertAt time.Time // time of the last CHANGE of the value

	stell  float64   // own effective adjustments, summed (kW, grid sign)
	ref    float64   // stell at the last change of the value
	ueber  time.Time // since when |stell-ref| >= EinfrierStellKw; zero = not
	frozen bool      // latched until the value changes
}

// Wert feeds one connection-point value (kW, + import / - export). Exactly
// the same number is no change; any other number re-anchors the probe.
func (p *Einfrierprobe) Wert(ts time.Time, kw float64) {
	if !finite(kw) {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen && ts.Before(p.wertAt) {
		return
	}
	if p.seen && kw == p.wert {
		return
	}
	p.seen, p.wert, p.wertAt = true, kw, ts
	p.ref, p.ueber, p.frozen = p.stell, time.Time{}, false
}

// Verstellt records an effective change of the box's own actuators at ts
// (kW, grid sign; see WirksamGesenkt / WirksamSpeicher). 0 records nothing.
func (p *Einfrierprobe) Verstellt(ts time.Time, wirksamKw float64) {
	if !finite(wirksamKw) || wirksamKw == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stell += wirksamKw
	switch {
	case math.Abs(p.stell-p.ref) < EinfrierStellKw:
		p.ueber = time.Time{}
	case p.ueber.IsZero():
		p.ueber = ts
	}
}

// Eingefroren answers whether the value counts as frozen at now, and since
// when: the time of its last change. ok=false = not frozen (or never seen).
func (p *Einfrierprobe) Eingefroren(now time.Time) (seit time.Time, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.seen {
		return time.Time{}, false
	}
	if !p.frozen && !p.ueber.IsZero() && now.Sub(p.ueber) >= EinfrierFenster {
		p.frozen = true
	}
	if !p.frozen {
		return time.Time{}, false
	}
	return p.wertAt, true
}

// WirksamGesenkt is the part of changing a ceiling from altKw to neuKw that
// MUST reach the meter, given the flow measured under it at that moment (PV
// generation under a PV cap, the charge points' draw under their allocation):
// a ceiling acts only where it is below the flow, and a raise only permits.
// +Inf is "no ceiling". The result is the reduction (kW >= 0); the caller
// signs it for the grid (less generation +, less charging -). An unknown flow
// proves nothing: 0.
func WirksamGesenkt(altKw, neuKw, flussKw float64) float64 {
	if math.IsNaN(altKw) || math.IsNaN(neuKw) || !finite(flussKw) || flussKw <= 0 {
		return 0
	}
	return math.Max(math.Min(altKw, flussKw)-math.Min(neuKw, flussKw), 0)
}

// WirksamSpeicher is the part of a new battery command (kW, + charge /
// - discharge) that MUST reach the meter, starting from the MEASURED battery
// power: a battery can always move towards 0, never surely away from it (SoC,
// power limits). The result is in the grid sign (less discharge +, less
// charge -); an unknown measurement proves nothing: 0.
func WirksamSpeicher(gemessenKw, sollKw float64) float64 {
	if !finite(gemessenKw) || !finite(sollKw) {
		return 0
	}
	switch {
	case gemessenKw < 0:
		return math.Min(math.Max(sollKw, gemessenKw), 0) - gemessenKw
	case gemessenKw > 0:
		return math.Min(math.Max(sollKw, 0), gemessenKw) - gemessenKw
	}
	return 0
}
