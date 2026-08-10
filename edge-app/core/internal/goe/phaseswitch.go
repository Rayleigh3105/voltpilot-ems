package goe

// The stateful PHASE SWITCHER (D4, docs/verbrauchssteuerung.md §13.1): the go-e
// 1p/3p switch is a TEMPORAL invariant exactly like the cycle guard's min-on/
// min-off - a contactor operation the vehicle electronics must be sheltered
// from, so switches are paced by a debounce dwell (the new desired range must
// be STABLE) and a minimum pause between two switches. The guards.CycleGuard
// pattern applies verbatim: restrict-only (a paced switch clamps the setpoint
// into the ACTIVE range or holds Off, never a value between ranges and never
// more power than commanded), an honest reason ("wartet -
// Phasenumschaltpause"), and a reboot deliberately forgets state - a pause the
// switcher cannot know is not owed (no invented protection), only the dwell
// applies from a clean baseline.
//
// The switcher never does I/O and every method takes `now`, so the pacing
// arithmetic is deterministically testable (the calibration/flexfallback
// discipline). It is the ONE owner of the dynamic phase state; the pure
// PlanFor consumes its verdict as Command.Phase.

import (
	"sync"
	"time"
)

// PhaseSwitcher paces the 1p/3p switching of ONE go-e-backed entity.
// Safe for concurrent use.
type PhaseSwitcher struct {
	mu    sync.Mutex
	pause time.Duration
	dwell time.Duration

	active       int // 1 | 3 | 0 = unknown (nothing read back yet)
	desired      int // pending switch target while != active; 0 = none
	desiredSince time.Time
	lastSwitch   time.Time
}

// NewPhaseSwitcher builds a switcher with the config's pacing (defaults
// applied: 300 s pause / 60 s dwell).
func NewPhaseSwitcher(cfg Config) *PhaseSwitcher {
	return &PhaseSwitcher{
		pause: time.Duration(resolvedInt(cfg.PhaseSwitchPauseS, DefaultPhaseSwitchPause)) * time.Second,
		dwell: time.Duration(resolvedInt(cfg.PhaseSwitchDwellS, DefaultPhaseSwitchDwell)) * time.Second,
	}
}

// Observe records the current pass's desired range (from DesiredPhaseMode) and
// returns the PhaseState the plan runs with. desired 0 (off/no charge intent)
// clears any pending switch - an off wish never burns the dwell.
func (s *PhaseSwitcher) Observe(now time.Time, desired int) PhaseState {
	s.mu.Lock()
	defer s.mu.Unlock()

	if desired == 0 || desired == s.active || s.active == 0 {
		// Nothing to switch (or nothing KNOWN to switch from - an unknown
		// position never initiates a switch; the readback fills it first).
		s.desired = 0
		return PhaseState{Active: s.active}
	}
	if desired != s.desired {
		// A NEW switch wish starts its stability dwell from scratch (a wish
		// flapping across the range boundary keeps restarting it - debounce).
		s.desired = desired
		s.desiredSince = now
	}
	dwellOk := now.Sub(s.desiredSince) >= s.dwell
	pauseOk := s.lastSwitch.IsZero() || now.Sub(s.lastSwitch) >= s.pause
	return PhaseState{Active: s.active, SwitchAllowed: dwellOk && pauseOk}
}

// NoteSwitchExecuted records that a psm write for `mode` (1|3) went out to the
// charger (the executor calls it ONLY after a transport-error-free set, so a
// failed write never burns the pause budget; re-writing the same psm after a
// lost response is idempotent, never a toggle). The active position is adopted
// optimistically - the always-running readback confirms or corrects it.
func (s *PhaseSwitcher) NoteSwitchExecuted(now time.Time, mode int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSwitch = now
	s.active = mode
	s.desired = 0
}

// NoteReadback adopts the phase position the charger REPORTS: psm Force_1/
// Force_3 names it outright; psm Auto falls back to pnp (the number of phases
// actually in use) while charging. Absent/unknown values change nothing -
// never invented.
func (s *PhaseSwitcher) NoteReadback(psm, pnp *int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case psm != nil && *psm == PsmForce1:
		s.active = 1
	case psm != nil && *psm == PsmForce3:
		s.active = 3
	case pnp != nil && *pnp == 1:
		s.active = 1
	case pnp != nil && *pnp > 1:
		s.active = 3
	}
}

// Active returns the known phase position (0 = unknown).
func (s *PhaseSwitcher) Active() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}
