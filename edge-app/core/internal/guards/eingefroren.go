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
// THE PROBE RUNS IN OPERATION. As built in IP-20 it never made a test step of
// its own (the triggered step probe before arming is IP-21). The healing of
// IP-27 finding A7 EXTENDS rule B2 here - deliberately, and only in this one
// point: a value that stands bit-identical for PruefStillstand WHILE the box
// runs above its own share (measured at its own point - the same quantity it
// falls back to blind) asks for ONE probing adjustment per standstill: the
// watchdog lowers by PruefSenkKw (lowering is always safe), holds that point,
// and this probe decides with the shorter PruefAntwortFenster. A value that
// moves = a healthy meter, the watchdog releases braked; a value that stays =
// frozen = blind. The leading box sees its own connection point stand still
// while the partner legally rises to its share - without the probing
// adjustment it had no reason to adjust and never learned that it was blind
// (matrix row A7: the share must hold <= 90 s after the last value). A resting
// box under its share, a box with nothing effectively lowerable and a second
// probe within the same standstill never probe (PruefungFaellig/Geprueft).
//
// THE CLOCK (IP-27 finding A8, "Dauer statt Uhrzeit"): a value with a
// timestamp older than the last one seen is a clock jump, not a stale sample -
// the probe re-anchors (shifts its times by the jump, so the durations it has
// measured survive, and the jump itself counts as no time) instead of
// discarding every value until the clock has caught up. The jump sample's
// own value counts as no change; the samples after it do.
//
// It listens to two things:
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

	// PruefStillstand is the Startwert of the probing adjustment (IP-27 A7):
	// how long the value must stand bit-identical - measured by the values
	// themselves - before a box above its share probes. As long as the
	// freshness window of the watchdogs (ExportFreshWindow, BudgetFreshWindow):
	// a value that old would count as a gap if it had stopped arriving.
	PruefStillstand = 30 * time.Second
	// PruefAntwortFenster is the Startwert of the answer window after a
	// TARGETED probing adjustment: shorter than EinfrierFenster, because the
	// box knows exactly when it lowered and by how much - two control ticks
	// (10 s) and four source polls (5 s) are enough for the meter to show it.
	// 30 s standstill + 20 s answer + at most the 60 s ramp of V2 from the last
	// change puts the leading box on its share 90 s after the last value (NW-7
	// confirms both figures at the test bench).
	PruefAntwortFenster = 20 * time.Second
	// PruefSenkKw is how far a probing adjustment lowers: EinfrierStellKw plus
	// the write resolution, so a rounded setpoint can never land below the
	// 2 kW the probe must see.
	PruefSenkKw = EinfrierStellKw + ExportStepKw
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

	lastTs    time.Time // timestamp of the newest value (the clock anchor, A8)
	geprueft  bool      // a probing adjustment was made in this standstill
	gezieltAb time.Time // when it was made
}

// Wert feeds one connection-point value (kW, + import / - export). Exactly
// the same number is no change; any other number re-anchors the probe.
func (p *Einfrierprobe) Wert(ts time.Time, kw float64) {
	if !finite(kw) {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen && ts.Before(p.lastTs) {
		// A8: the clock jumped back - re-anchor on the new clock. The
		// durations measured so far move with it (a merely reordered sample
		// can only make them longer: blind sooner, never later), and the
		// value of the jump sample itself proves nothing - a stale telegram
		// must not un-freeze a frozen meter. The next samples count.
		d := ts.Sub(p.lastTs)
		p.wertAt = p.wertAt.Add(d)
		if !p.ueber.IsZero() {
			p.ueber = p.ueber.Add(d)
		}
		if !p.gezieltAb.IsZero() {
			p.gezieltAb = p.gezieltAb.Add(d)
		}
		p.lastTs = ts
		return
	}
	p.lastTs = ts
	if p.seen && kw == p.wert {
		return
	}
	p.seen, p.wert, p.wertAt = true, kw, ts
	p.ref, p.ueber, p.frozen = p.stell, time.Time{}, false
	p.geprueft, p.gezieltAb = false, time.Time{}
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
	if !p.frozen && !p.ueber.IsZero() && (now.Sub(p.ueber) >= EinfrierFenster ||
		p.geprueft && !p.gezieltAb.IsZero() && now.Sub(p.gezieltAb) >= PruefAntwortFenster) {
		p.frozen = true
	}
	if !p.frozen {
		return time.Time{}, false
	}
	return p.wertAt, true
}

// Pruefung answers whether a probing adjustment is asked for at now (IP-27
// A7). neu: it is due - the value has stood bit-identical for
// PruefStillstand, measured by its own timestamps, and no probe was made in
// this standstill; only then may a watchdog START one. Otherwise richtung is
// set while one runs - it was made (Geprueft) and its answer window is open:
// the watchdog that made it holds its point. richtung is the sign of the
// standing value (+1 import, -1 export, 0 none): only the watchdogs of that
// direction probe, so two directions can never cancel at the meter. Whether
// the box is above its share and has something to lower is theirs to judge.
func (p *Einfrierprobe) Pruefung(now time.Time) (richtung int, neu bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.seen || p.frozen {
		return 0, false
	}
	switch {
	case p.geprueft:
		if a := now.Sub(p.gezieltAb); a < 0 || a >= PruefAntwortFenster {
			return 0, false
		}
	case p.lastTs.Sub(p.wertAt) < PruefStillstand:
		return 0, false
	}
	switch {
	case p.wert < 0:
		return -1, !p.geprueft
	case p.wert > 0:
		return +1, !p.geprueft
	}
	return 0, false
}

// Geprueft records that a watchdog made the probing adjustment at now: once
// per standstill, the answer window starts. The adjustment itself reaches the
// probe the ordinary way (Verstellt, counted only as far as it MUST show).
func (p *Einfrierprobe) Geprueft(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.seen || p.geprueft {
		return
	}
	p.geprueft, p.gezieltAb = true, now
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
