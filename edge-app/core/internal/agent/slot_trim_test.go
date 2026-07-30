package agent

// The price-aware in-slot trim, end to end through applySetpoint (2026-07-30).
//
// The scenario is the captain's own live reading at Anlage Pilsting: PV 15.3 kW,
// house 7.6 kW (7.7 kW surplus), plan setpoint 10.8 kW - so 3.1 kW of the charge
// came from the grid. In an EXPENSIVE slot the setpoint published to Layer 1
// must be the surplus, in a CHEAP one it must be the plan's 10.8 kW, and the
// published value must ALWAYS equal the state's setpoint (that identity is what
// keeps a deliberate limitation from ever reading as "setpoint not adopted").

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func trimAgentAddr(t *testing.T) (*Agent, string) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw = 30
	cfg.MaxDischargeKw = 30
	return startBusOnlyAgent(t, cfg)
}

func trimAgent(t *testing.T) *Agent {
	t.Helper()
	a, _ := trimAgentAddr(t)
	return a
}

// pilstingPlan is a FRESH one-slot plan commanding the observed 10.8 kW charge,
// with the cloud's price verdict for that slot.
func pilstingPlan(now time.Time, surplusOnly bool) *plan.Plan {
	yes := true
	return &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GeneratedAt:       now.Add(-time.Minute),
		GridChargeAllowed: &yes, // merchant: the FK3 clamp is not what we are testing
		Slots: []plan.Slot{{
			Start:                 now.Add(-5 * time.Minute),
			BatterySetpointKw:     10.8,
			ChargeFromSurplusOnly: surplusOnly,
		}},
	}
}

func pilstingReading() guards.Reading {
	return guards.Reading{SocPct: 92, PvKw: 15.3, LoadKw: 7.6, GridLimitKw: guards.Unknown()}
}

func TestExpensiveSlotTrimsTheChargeToTheSurplusAndSaysWhy(t *testing.T) {
	a := trimAgent(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingPlan(now, true)
	a.lastReading = pilstingReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan (a trim is not a fallback)", snap.Mode)
	}
	if snap.SetpointKw != 7.7 {
		t.Fatalf("setpoint = %v, want the measured surplus 7.7", snap.SetpointKw)
	}
	if snap.Trim == nil || !snap.Trim.Active {
		t.Fatal("the state must carry the limitation - an unnamed limitation reads as a defect")
	}
	if snap.Trim.PlannedKw != 10.8 {
		t.Fatalf("trim.planned_kw = %v, want the plan's 10.8", snap.Trim.PlannedKw)
	}
	if snap.Trim.SurplusKw == nil || *snap.Trim.SurplusKw != 7.7 {
		t.Fatalf("trim.surplus_kw = %v, want 7.7", snap.Trim.SurplusKw)
	}
}

func TestCheapSlotPublishesThePlanSetpointUnchanged(t *testing.T) {
	a := trimAgent(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingPlan(now, false)
	a.lastReading = pilstingReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != 10.8 {
		t.Fatalf("setpoint = %v, want the plan's 10.8 - a cheap purchase is CORRECT", snap.SetpointKw)
	}
	if snap.Trim != nil {
		t.Fatalf("trim = %+v, want none on a cheap slot", snap.Trim)
	}
}

// A plan from a pre-feature cloud carries no flag at all: byte-for-byte the old
// behavior (the field is fail-OPEN by contract - an unpriced restriction must
// never reshape dispatch).
func TestALegacyPlanWithoutTheFlagBehavesExactlyAsBefore(t *testing.T) {
	a := trimAgent(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	yes := true
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GridChargeAllowed: &yes,
		Slots:             []plan.Slot{{Start: now.Add(-5 * time.Minute), BatterySetpointKw: 10.8}},
	}
	a.lastReading = pilstingReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	if snap := a.State.Get(); snap.SetpointKw != 10.8 || snap.Trim != nil {
		t.Fatalf("setpoint = %v trim = %+v, want 10.8 and no trim", snap.SetpointKw, snap.Trim)
	}
}

// A STALE plan hands over to the self-consumption fallback, which follows
// pv - load = the surplus itself, so the trim is a no-op there by construction.
func TestAStalePlanFallsBackAndTheTrimIsANoOp(t *testing.T) {
	a := trimAgent(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	p := pilstingPlan(now, true)
	p.ReceivedAt = now.Add(-2 * time.Hour)
	p.GeneratedAt = now.Add(-2 * time.Hour)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = pilstingReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSelfConsume {
		t.Fatalf("mode = %v, want eigenverbrauch", snap.Mode)
	}
	if snap.SetpointKw != 7.7 { // pv - load
		t.Fatalf("fallback setpoint = %v, want 7.7", snap.SetpointKw)
	}
	if snap.Trim != nil {
		t.Fatalf("trim = %+v, want none (the fallback never grid-charges)", snap.Trim)
	}
}

// THE identity that keeps a deliberate limitation from being reported as a
// refused write: what we PUBLISH is what we trimmed, so the register readback
// compares against the trimmed value (PR #280's confirmation logic).
func TestTheTrimmedValueIsWhatGetsPublishedSoNoMismatchIsPossible(t *testing.T) {
	a, addr := trimAgentAddr(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	sub := subscribeSetpoint(t, addr)

	a.mu.Lock()
	a.currentPlan = pilstingPlan(now, true)
	a.lastReading = pilstingReading()
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "the trimmed setpoint on the local bus", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 7.7
	})
	m, _ := sub.latest()
	if m["source"] != "schedule" {
		t.Fatalf("source = %v, want schedule (a trim is not a fallback)", m["source"])
	}
	// What we published IS what the state reports, so the register readback
	// compares against the trimmed value and can never report a refused write.
	if snap := a.State.Get(); snap.SetpointKw != m["battery_setpoint_kw"] {
		t.Fatalf("state %v != published %v", snap.SetpointKw, m["battery_setpoint_kw"])
	}
}

// Losing the measurements must never leave a stale limitation claim on the card,
// and it must never regulate blind: the plan setpoint goes out unchanged.
func TestLosingTheMeasurementsClearsTheLimitationInsteadOfRegulatingBlind(t *testing.T) {
	a := trimAgent(t)
	now := time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingPlan(now, true)
	a.lastReading = pilstingReading()
	a.mu.Unlock()
	a.applySetpoint(now)
	if a.State.Get().Trim == nil {
		t.Fatal("expected the limitation to be recorded first")
	}

	unknown := guards.Reading{
		SocPct: guards.Unknown(), PvKw: guards.Unknown(),
		LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown(),
	}
	a.mu.Lock()
	a.lastReading = unknown
	a.mu.Unlock()
	a.applySetpoint(now.Add(10 * time.Second))

	snap := a.State.Get()
	if snap.SetpointKw != 10.8 {
		t.Fatalf("setpoint = %v, want the plan's 10.8 (never regulate blind)", snap.SetpointKw)
	}
	if snap.Trim != nil {
		t.Fatalf("trim = %+v, want cleared without a reading", snap.Trim)
	}
	if a.trim.Engaged() {
		t.Fatal("the trimmer must be released when it cannot regulate")
	}

	// And with no active slot either (stale plan), the honest no-reading state
	// carries no limitation claim at all.
	p := pilstingPlan(now, true)
	p.ReceivedAt = now.Add(-2 * time.Hour)
	p.GeneratedAt = now.Add(-2 * time.Hour)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = unknown
	a.mu.Unlock()
	a.applySetpoint(now.Add(20 * time.Second))
	snap = a.State.Get()
	if snap.Mode != state.ModeNoReading {
		t.Fatalf("mode = %v, want keine_messwerte", snap.Mode)
	}
	if snap.Trim != nil {
		t.Fatalf("trim = %+v, want none", snap.Trim)
	}
}
