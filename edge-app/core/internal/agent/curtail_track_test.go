package agent

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// herzogauCurtailPlan is the FRESH one-slot plan of the 10:30 run: charge the
// battery at its 30 kW maximum and cap the plant at 36,869 kW = 6,5 kW house +
// 30 kW battery, i.e. "let nothing out of the site".
func herzogauCurtailPlan(now time.Time, capKw float64) *plan.Plan {
	no, floor, cap := false, 5.0, capKw
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &no, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: now, BatterySetpointKw: 30, PvLimitKw: &cap,
		}},
	}
}

func curtailReading(pv, load float64) guards.Reading {
	return guards.Reading{SocPct: 30, PvKw: pv, LoadKw: load, GridLimitKw: guards.Unknown()}
}

// THE REGRESSION (scout report §2 Glied 1b): between 10:35 and 10:44 the house
// climbed from 6,5 to 29 kW while the plan's cap stood still at 36,9 kW, so the
// plant hung ~20 kW below its capability - and that capped output then fed the
// next run's PV nowcast, which under-estimated the surplus and let the cap
// collapse. The published pv_limit_kw must follow the measurement.
func TestPublishedCurtailmentFollowsTheRisingHouse(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	slot := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	p := herzogauCurtailPlan(slot, 36.869)

	// Wait for the CAP WE EXPECT, never merely for "a message": the retained
	// setpoint of the previous tick is still there and would answer at once.
	set := func(at time.Time, pv, load, wantCap float64) {
		a.mu.Lock()
		a.currentPlan, a.lastReading, a.lastReadingAt = p, curtailReading(pv, load), at
		a.mu.Unlock()
		a.State.Update(func(s *state.Snapshot) {
			s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: at}
		})
		a.applySetpoint(at)
		waitFor(t, 5*time.Second, "the published cap", func() bool {
			m, ok := sub.latest()
			if !ok {
				return false
			}
			v, isNum := m["pv_limit_kw"].(float64)
			return isNum && math.Abs(v-wantCap) < 1e-9
		})
	}

	// 10:30 - house 6,5, the cap the plan itself computed.
	set(slot, 48.8, 6.5, 36.5)
	if got := a.State.Get().CurtailTrack; got == nil || math.Abs(got.CapKw-36.5) > 1e-9 {
		t.Fatalf("10:30 tracked cap = %+v, want 6.5 + 30 = 36.5", got)
	}

	// 10:44 - house 29. The plan still says 36,869; the device must not.
	at := slot.Add(14 * time.Minute)
	set(at, 55.1, 29, 59)
	got := a.State.Get().CurtailTrack
	if got == nil || got.State != string(guards.CurtailTracking) {
		t.Fatalf("the live curtailment must be tracking: %+v", got)
	}
	if math.Abs(got.CapKw-59) > 1e-9 {
		t.Fatalf("tracked cap = %.3f kW, want 29 + 30 = 59", got.CapKw)
	}
	if got.PlanCapKw != 36.869 {
		t.Fatalf("the plan's own value must still be reported: %+v", got)
	}
	// And the whole point: with the cap at 59 the plant may produce its measured
	// 55,1 kW, so nothing is thrown away and nothing leaves the site.
	if grid := 29 + 30 - math.Min(55.1, 59.0); grid < -1e-9 {
		t.Fatalf("grid = %.3f kW, want no export", grid)
	}
	if got.Reason == "" {
		t.Fatal("a deliberate correction must carry its German reason")
	}
}

// The other direction, same law: the house falls inside the slot, the static cap
// becomes too WIDE and the plant would export. The correction is immediate.
func TestPublishedCurtailmentTightensWhenTheHouseFalls(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	slot := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	p := herzogauCurtailPlan(slot, 57)

	step := func(at time.Time, pv, load, wantCap float64) {
		a.mu.Lock()
		a.currentPlan, a.lastReading, a.lastReadingAt = p, curtailReading(pv, load), at
		a.mu.Unlock()
		a.applySetpoint(at)
		waitFor(t, 5*time.Second, "the published cap", func() bool {
			m, ok := sub.latest()
			if !ok {
				return false
			}
			v, isNum := m["pv_limit_kw"].(float64)
			return isNum && math.Abs(v-wantCap) < 1e-9
		})
	}

	step(slot, 55, 29, 59)
	// One tick later the house drops. A tightening is IMMEDIATE, and it lands
	// well below the plan's own 57 kW.
	step(slot.Add(10*time.Second), 55, 6.5, 36.5)
}

// Without a planned curtailment NOTHING changes - the slot publishes no cap at
// all, exactly as before this guard existed.
func TestNoPlannedCurtailmentPublishesNoCap(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 8, 45, 0, 0, time.UTC)
	no, floor := false, 5.0

	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &no, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{Start: now, BatterySetpointKw: 9.82}},
	}
	a.lastReading, a.lastReadingAt = curtailReading(55.1, 28.9), now
	a.mu.Unlock()

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "a published setpoint", func() bool {
		_, ok := sub.latest()
		return ok
	})
	m, _ := sub.latest()
	if _, has := m["pv_limit_kw"]; has {
		t.Fatalf("an uncurtailed slot must publish no cap: %v", m["pv_limit_kw"])
	}
	if got := a.State.Get().CurtailTrack; got != nil {
		t.Fatalf("and claim no live curtailment: %+v", got)
	}
}

// The compliance watchdog stays SUPERORDINATE: it composes most-restrictive-wins
// after the tracker, so a feed-in limit can only ever tighten the live cap.
func TestTheFeedInWatchdogStillTightensTheTrackedCap(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	slot := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	p := herzogauCurtailPlan(slot, 36.869)
	limit := 10.0
	p.GridExportLimitKw = &limit

	// The connection point is exporting hard: the watchdog's own closed loop
	// lands far below what the tracker would allow.
	a.export.Observe(slot, -25, 55)
	a.mu.Lock()
	a.currentPlan, a.lastReading, a.lastReadingAt = p, curtailReading(55, 29), slot
	a.mu.Unlock()

	a.applySetpoint(slot)
	var pub float64
	waitFor(t, 5*time.Second, "a published cap", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		f, isNum := m["pv_limit_kw"].(float64)
		pub = f
		return isNum
	})
	tracked := a.State.Get().CurtailTrack
	if tracked == nil || math.Abs(tracked.CapKw-59) > 1e-9 {
		t.Fatalf("the tracker still reports its own verdict: %+v", tracked)
	}
	if pub >= tracked.CapKw {
		t.Fatalf("the feed-in watchdog must tighten it: published %.3f, tracked %.3f",
			pub, tracked.CapKw)
	}
}

// The fail-safe is the PLAN, never a release: a measurement gap freezes the last
// cap and then falls back to the plan's own value.
func TestTheTrackerFallsBackToThePlanWhenTheMeasurementGoesAway(t *testing.T) {
	a, addr := followAgentAddr(t)
	subscribeSetpoint(t, addr)
	slot := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	p := herzogauCurtailPlan(slot, 36.869)

	a.mu.Lock()
	a.currentPlan, a.lastReading, a.lastReadingAt = p, curtailReading(55, 29), slot
	a.mu.Unlock()
	a.applySetpoint(slot)
	if got := a.State.Get().CurtailTrack; got == nil || math.Abs(got.CapKw-59) > 1e-9 {
		t.Fatalf("first evaluation = %+v, want 59", got)
	}

	// The reading stops arriving. Inside the hold window the cap is FROZEN.
	held := slot.Add(60 * time.Second)
	a.applySetpoint(held)
	if got := a.State.Get().CurtailTrack; got == nil ||
		got.State != string(guards.CurtailHolding) || math.Abs(got.CapKw-59) > 1e-9 {
		t.Fatalf("a short gap must freeze the cap: %+v", a.State.Get().CurtailTrack)
	}

	// Beyond it the plan's own value takes over - the pre-guard behaviour.
	late := slot.Add(3 * time.Minute)
	a.applySetpoint(late)
	got := a.State.Get().CurtailTrack
	if got == nil || got.State != string(guards.CurtailPlan) ||
		math.Abs(got.CapKw-36.869) > 1e-9 || !got.Blind {
		t.Fatalf("a long gap must fall back to the plan value: %+v", got)
	}
	if got.LoadKw != nil || got.ChargeKw != nil {
		t.Fatalf("a blind verdict must not claim measurements: %+v", got)
	}
}
