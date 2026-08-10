package goe

// Deterministic pacing tests for the D4 phase switcher: every method takes
// `now`, so dwell/pause arithmetic runs on a synthetic clock (the CycleGuard/
// calibration test discipline - no sleeping).

import (
	"testing"
	"time"
)

func at(sec int) time.Time {
	return time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC).Add(time.Duration(sec) * time.Second)
}

func switchCfg() Config {
	return Config{IP: "1.2.3.4", PhaseSwitching: true,
		PhaseSwitchPauseS: 300, PhaseSwitchDwellS: 60}
}

func TestSwitcherUnknownPositionNeverAllowsASwitch(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	for i := 0; i < 10; i++ {
		ph := s.Observe(at(i*100), 3)
		if ph.Active != 0 || ph.SwitchAllowed {
			t.Fatalf("unknown position must never switch: %+v", ph)
		}
	}
}

func TestSwitcherDwellThenSwitch(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	s.NoteReadback(intp(PsmForce1), nil) // charger reports 1p

	// The FIRST observation of a 3p wish starts the dwell - not allowed yet.
	if ph := s.Observe(at(0), 3); ph.SwitchAllowed || ph.Active != 1 {
		t.Fatalf("dwell must delay the first switch: %+v", ph)
	}
	// Still inside the 60 s dwell.
	if ph := s.Observe(at(59), 3); ph.SwitchAllowed {
		t.Fatalf("59s < 60s dwell must still hold")
	}
	// Dwell elapsed; no prior switch -> no pause owed (reboot discipline).
	if ph := s.Observe(at(60), 3); !ph.SwitchAllowed {
		t.Fatalf("dwell elapsed + no pause owed must allow the switch")
	}
}

func TestSwitcherPauseBetweenSwitches(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	s.NoteReadback(intp(PsmForce1), nil)
	s.Observe(at(0), 3)
	if ph := s.Observe(at(60), 3); !ph.SwitchAllowed {
		t.Fatalf("first switch must be allowed after the dwell")
	}
	s.NoteSwitchExecuted(at(60), 3)
	if s.Active() != 3 {
		t.Fatalf("executed switch must adopt the new position, got %d", s.Active())
	}

	// A wish back to 1p: dwell elapses at 60+120=180s, but the 300 s pause
	// since the switch at t=60 holds until t=360.
	s.Observe(at(120), 1)
	if ph := s.Observe(at(180), 1); ph.SwitchAllowed {
		t.Fatalf("the minimum switch pause must hold (dwell alone is not enough)")
	}
	if ph := s.Observe(at(359), 1); ph.SwitchAllowed {
		t.Fatalf("359s: pause (until 360) must still hold")
	}
	if ph := s.Observe(at(360), 1); !ph.SwitchAllowed {
		t.Fatalf("360s: pause elapsed, dwell long since - switch must be allowed")
	}
}

func TestSwitcherFlappingWishRestartsTheDwell(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	s.NoteReadback(intp(PsmForce1), nil)
	s.Observe(at(0), 3)  // start dwell for 3p
	s.Observe(at(30), 1) // wish falls back to the ACTIVE range -> pending cleared
	s.Observe(at(40), 3) // new 3p wish -> dwell restarts at t=40
	if ph := s.Observe(at(70), 3); ph.SwitchAllowed {
		t.Fatalf("dwell must restart on a flapped wish (40+60=100)")
	}
	if ph := s.Observe(at(100), 3); !ph.SwitchAllowed {
		t.Fatalf("restarted dwell elapsed at t=100 - switch must be allowed")
	}
}

func TestSwitcherOffWishClearsPending(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	s.NoteReadback(intp(PsmForce3), nil)
	s.Observe(at(0), 1)
	s.Observe(at(30), 0) // off: no charge intent - never burns the dwell
	if ph := s.Observe(at(61), 1); ph.SwitchAllowed {
		t.Fatalf("an off interlude must restart the dwell, not count toward it")
	}
}

func TestSwitcherReadbackAdoptsThePosition(t *testing.T) {
	s := NewPhaseSwitcher(switchCfg())
	if s.Active() != 0 {
		t.Fatalf("fresh switcher must be unknown")
	}
	// psm Force_3 names the position outright.
	s.NoteReadback(intp(PsmForce3), nil)
	if s.Active() != 3 {
		t.Fatalf("psm Force_3 -> active 3, got %d", s.Active())
	}
	// psm Auto: pnp (phases in use) decides.
	s.NoteReadback(intp(PsmAuto), intp(1))
	if s.Active() != 1 {
		t.Fatalf("psm Auto + pnp 1 -> active 1, got %d", s.Active())
	}
	s.NoteReadback(intp(PsmAuto), intp(3))
	if s.Active() != 3 {
		t.Fatalf("psm Auto + pnp 3 -> active 3, got %d", s.Active())
	}
	// Absent values change NOTHING (never invented).
	s.NoteReadback(nil, nil)
	if s.Active() != 3 {
		t.Fatalf("absent readback values must not change the position")
	}
	s.NoteReadback(intp(PsmAuto), intp(0))
	if s.Active() != 3 {
		t.Fatalf("pnp 0 (idle) must not change the position")
	}
}

func TestSwitcherDefaultsAreConservative(t *testing.T) {
	s := NewPhaseSwitcher(Config{IP: "1.2.3.4", PhaseSwitching: true})
	if s.pause != DefaultPhaseSwitchPause*time.Second || s.dwell != DefaultPhaseSwitchDwell*time.Second {
		t.Fatalf("defaults must be %ds pause / %ds dwell, got %v/%v",
			DefaultPhaseSwitchPause, DefaultPhaseSwitchDwell, s.pause, s.dwell)
	}
}

func intp(v int) *int { return &v }
