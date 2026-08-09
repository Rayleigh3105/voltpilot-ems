package guards

// The stateful consumer CYCLE GUARD (Verbrauchssteuerung Inkrement 3,
// docs/verbrauchssteuerung.md §13.1): minimum on-time, minimum off-time,
// maximum starts per day and a ramp are TEMPORAL invariants that the pure
// power clamp [0, effective_max] cannot express - reactive rules and
// arbitration can switch faster than any plan, so the invariants are enforced
// by ONE stateful guard on the execution path of EVERY consumer command (plan
// desires and future reactive desires run through the same clamp; the
// PeakTracker/Despiker pattern).
//
// Restrict-only, in the temporal sense: the guard DELAYS a switch-on
// (min-off pause, start budget) and HOLDS a previously granted state (min-on,
// ramp) - it never raises a level beyond something that was already granted,
// and it never invents protection: an absent limit deactivates exactly that
// axis (unbekannte Grenzen = kein erfundener Schutz).
//
// Every intervention carries an honest machine-readable reason code (the §15
// reason_code vocabulary, cycle-guard extension) plus a German sentence for
// the status surfaces ("wartet - Mindestpause").
//
// State is in-memory (last transition instants, a start counter per SITE-LOCAL
// day, the last applied level). A reboot forgets it - deliberately: a guard
// that cannot KNOW how long the device has been off must not invent a pause
// (the no-fabricated-protection rule), so after a restart every axis starts
// from a clean baseline.

import (
	"math"
	"sync"
	"time"
)

// The cycle-guard reason codes (the §15 reason_code vocabulary, Inkrement-3
// extension - the api ingest whitelists them, the portal maps them to text).
const (
	CycleReasonMinOn     = "guard_min_on"
	CycleReasonMinOff    = "guard_min_off"
	CycleReasonMaxStarts = "guard_max_starts"
	CycleReasonRamp      = "guard_ramp"
)

// Cycle-guard clamp stages (the arbitration events' reasons[].stage
// vocabulary, next to guard:rated_band etc.).
const (
	StageCycleMinOn     = "guard:cycle_min_on"
	StageCycleMinOff    = "guard:cycle_min_off"
	StageCycleMaxStarts = "guard:cycle_max_starts"
	StageCycleRamp      = "guard:cycle_ramp"
)

// CycleLimits are the registry-config limits of one consumer entity (D-9:
// they travel in guards.limits of the entity descriptor, sourced from
// consumer_profile). A zero value deactivates that axis.
type CycleLimits struct {
	MinOn           time.Duration
	MinOff          time.Duration
	MaxStartsPerDay int
	RampKwPerMin    float64
}

// CycleHold names one active intervention: the machine-readable reason code
// plus the German sentence the status surfaces show verbatim.
type CycleHold struct {
	Code string
	Text string
}

// CycleState is the guard's queryable snapshot (feeds the heartbeat's
// consumers block: the edge view of the running day).
type CycleState struct {
	// On is the guard's view of the COMMANDED state (not the measured one).
	On bool
	// Hold is the active intervention, nil when the last decision passed.
	Hold *CycleHold
	// StartsToday counts commanded starts in the current site-local day.
	StartsToday int
	// RuntimeTodaySeconds is the accumulated commanded ON time today.
	RuntimeTodaySeconds int
}

// CycleGuard enforces the temporal invariants for ONE consumer entity.
// Safe for concurrent use.
type CycleGuard struct {
	mu     sync.Mutex
	limits CycleLimits
	loc    *time.Location

	initialized    bool
	on             bool
	lastTransition time.Time
	day            string
	startsToday    int
	runtimeToday   time.Duration
	accrualAt      time.Time

	lastKw   float64
	lastKwAt time.Time

	lastHold *CycleHold
}

// NewCycleGuard builds a guard with the given limits. loc is the site-local
// timezone for the per-day start budget (nil = time.Local; v1 pins site time
// to the device clock, which is Europe/Berlin on the fleet).
func NewCycleGuard(limits CycleLimits, loc *time.Location) *CycleGuard {
	if loc == nil {
		loc = time.Local
	}
	return &CycleGuard{limits: sanitizeCycleLimits(limits), loc: loc}
}

// SetLimits swaps the limits (a registry re-push) WITHOUT resetting the
// timing state - the device's history does not change because its
// configuration did.
func (g *CycleGuard) SetLimits(limits CycleLimits) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.limits = sanitizeCycleLimits(limits)
}

func sanitizeCycleLimits(l CycleLimits) CycleLimits {
	if l.MinOn < 0 {
		l.MinOn = 0
	}
	if l.MinOff < 0 {
		l.MinOff = 0
	}
	if l.MaxStartsPerDay < 0 {
		l.MaxStartsPerDay = 0
	}
	if math.IsNaN(l.RampKwPerMin) || l.RampKwPerMin < 0 {
		l.RampKwPerMin = 0
	}
	return l
}

// Apply decides what may actually be commanded for a wish. wishOn is the
// wished commanded state; wishKw the wished level (NaN for a pure on/off
// consumer - the ramp axis then stays out of the decision). It returns the
// allowed state, the allowed level (NaN in for NaN stays NaN out) and the
// active hold (nil = the wish passed).
func (g *CycleGuard) Apply(now time.Time, wishOn bool, wishKw float64) (bool, float64, *CycleHold) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.accrue(now)

	if !g.initialized {
		// First decision after boot: adopt the wish as the baseline. A
		// switch-on still consumes a start from the day budget (the
		// conservative direction), but no pause can be owed to a history the
		// guard cannot know - lastTransition stays unset while off.
		g.initialized = true
		if wishOn {
			if hold := g.startBudgetHold(); hold != nil {
				g.lastHold = hold
				return false, offKw(wishKw), hold
			}
			g.on = true
			g.lastTransition = now
			g.startsToday++
			g.lastKw = 0
			g.lastKwAt = now
			return g.settleOn(now, wishKw)
		}
		g.on = false
		g.lastKw = 0
		g.lastHold = nil
		return false, offKw(wishKw), nil
	}

	switch {
	case wishOn && !g.on:
		if g.limits.MinOff > 0 && !g.lastTransition.IsZero() &&
			now.Sub(g.lastTransition) < g.limits.MinOff {
			hold := &CycleHold{Code: CycleReasonMinOff, Text: "wartet - Mindestpause"}
			g.lastHold = hold
			return false, offKw(wishKw), hold
		}
		if hold := g.startBudgetHold(); hold != nil {
			g.lastHold = hold
			return false, offKw(wishKw), hold
		}
		g.on = true
		g.lastTransition = now
		g.startsToday++
		g.lastKw = 0
		g.lastKwAt = now
		return g.settleOn(now, wishKw)

	case !wishOn && g.on:
		if g.limits.MinOn > 0 && now.Sub(g.lastTransition) < g.limits.MinOn {
			// Hold the PREVIOUSLY GRANTED level - never something new.
			hold := &CycleHold{Code: CycleReasonMinOn, Text: "läuft - Mindestlaufzeit hält"}
			g.lastHold = hold
			return true, g.lastKw, hold
		}
		g.on = false
		g.lastTransition = now
		g.lastKw = 0
		g.lastHold = nil
		return false, offKw(wishKw), nil

	case wishOn && g.on:
		return g.settleOn(now, wishKw)
	}
	// !wishOn && !g.on: nothing to do.
	g.lastHold = nil
	return false, offKw(wishKw), nil
}

// NoteUncommanded records that the core stopped commanding this entity
// entirely (a release failsafe cleared the retained command). The guard's
// commanded state falls to off WITHOUT any hold - there is no command left to
// hold onto; the device follows its own default now.
func (g *CycleGuard) NoteUncommanded(now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.accrue(now)
	g.initialized = true
	if g.on {
		g.on = false
		g.lastTransition = now
	}
	g.lastKw = 0
	g.lastHold = nil
}

// State returns the queryable snapshot.
func (g *CycleGuard) State(now time.Time) CycleState {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.accrue(now)
	st := CycleState{
		On:                  g.on,
		StartsToday:         g.startsToday,
		RuntimeTodaySeconds: int(g.runtimeToday / time.Second),
	}
	if g.lastHold != nil {
		h := *g.lastHold
		st.Hold = &h
	}
	return st
}

// settleOn applies the ramp axis while ON. Caller holds the mutex.
func (g *CycleGuard) settleOn(now time.Time, wishKw float64) (bool, float64, *CycleHold) {
	if math.IsNaN(wishKw) {
		// Pure on/off wish: no level to ramp.
		g.lastHold = nil
		g.lastKwAt = now
		return true, wishKw, nil
	}
	kw := wishKw
	var hold *CycleHold
	if g.limits.RampKwPerMin > 0 {
		elapsedMin := now.Sub(g.lastKwAt).Minutes()
		if elapsedMin < 0 {
			elapsedMin = 0
		}
		allowed := g.limits.RampKwPerMin * elapsedMin
		switch {
		case kw > g.lastKw+allowed:
			kw = math.Round((g.lastKw+allowed)*1000) / 1000
			hold = &CycleHold{Code: CycleReasonRamp, Text: "Rampe begrenzt die Änderung"}
		case kw < g.lastKw-allowed:
			kw = math.Round((g.lastKw-allowed)*1000) / 1000
			hold = &CycleHold{Code: CycleReasonRamp, Text: "Rampe begrenzt die Änderung"}
		}
	}
	g.lastKw = kw
	g.lastKwAt = now
	g.lastHold = hold
	return true, kw, hold
}

// startBudgetHold checks the per-day start budget. Caller holds the mutex.
func (g *CycleGuard) startBudgetHold() *CycleHold {
	if g.limits.MaxStartsPerDay > 0 && g.startsToday >= g.limits.MaxStartsPerDay {
		return &CycleHold{Code: CycleReasonMaxStarts,
			Text: "wartet - maximale Starts pro Tag erreicht"}
	}
	return nil
}

// accrue advances the day/runtime accounting to now. Caller holds the mutex.
func (g *CycleGuard) accrue(now time.Time) {
	if !g.accrualAt.IsZero() && g.on && now.After(g.accrualAt) {
		g.runtimeToday += now.Sub(g.accrualAt)
	}
	g.accrualAt = now
	day := now.In(g.loc).Format("2006-01-02")
	if g.day != day {
		g.day = day
		g.startsToday = 0
		g.runtimeToday = 0
	}
}

// offKw maps a wish level to the off decision's level: NaN stays NaN (pure
// on/off), anything else is 0.
func offKw(wishKw float64) float64 {
	if math.IsNaN(wishKw) {
		return math.NaN()
	}
	return 0
}
