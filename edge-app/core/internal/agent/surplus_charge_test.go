package agent

// In-slot surplus absorption, end to end through applySetpoint (2026-08-02) -
// the charge-side counterpart of slot_trim_test.go / load_follow_test.go, and
// the only one of the three that RAISES a setpoint.
//
// The scenario is the live reading of the Pilsting MORNING (scout report
// vp-pilsting-abregeln, captain observation ~10:41): PV 23.9 kW, house 4.3 kW,
// battery at 7 % SoC - and 16.6 kW leaving the site at a NEGATIVE spot price,
// hour after hour, because the plan commanded what its PV forecast sized and no
// nowcast corrects the running slot. In a slot the cloud marked worth storing,
// the setpoint published to Layer 1 must be the MEASURED surplus; in an unmarked
// one it must be the plan's own value; the guard chain must still bind on the
// RAISED value; and the published value must ALWAYS equal the state's setpoint
// (that identity is what keeps a deliberate correction from ever reading as
// "setpoint not adopted").

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func absorbAgentAddr(t *testing.T) (*Agent, string) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw = 30
	cfg.MaxDischargeKw = 30
	return startBusOnlyAgent(t, cfg)
}

func absorbAgent(t *testing.T) *Agent {
	t.Helper()
	a, _ := absorbAgentAddr(t)
	return a
}

// pilstingMorningPlan is a FRESH one-slot plan commanding the observed 0.0 kW -
// the plan's own value, sized by a PV forecast that never saw the real surplus -
// with the cloud's price verdict for that slot. EEG posture (grid_charge_allowed
// false), like the real plant.
func pilstingMorningPlan(now time.Time, absorb bool) *plan.Plan {
	no := false
	return &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GeneratedAt:       now.Add(-time.Minute),
		GridChargeAllowed: &no,
		Slots: []plan.Slot{{
			Start:                  now.Add(-5 * time.Minute),
			BatterySetpointKw:      0.0,
			ChargeSurplusToBattery: absorb,
		}},
	}
}

func pilstingMorningReading() guards.Reading {
	return guards.Reading{SocPct: 7, PvKw: 23.9, LoadKw: 4.3, GridLimitKw: guards.Unknown()}
}

func TestMarkedSlotChargesTheMeasuredSurplusAndSaysWhy(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, true)
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan (a correction is not a fallback)", snap.Mode)
	}
	if snap.SetpointKw != 19.6 { // pv - load
		t.Fatalf("setpoint = %v, want the measured surplus 19.6", snap.SetpointKw)
	}
	if snap.Absorb == nil || !snap.Absorb.Active {
		t.Fatal("the state must carry the correction - an unnamed correction reads as a defect")
	}
	if snap.Absorb.PlannedKw != 0.0 {
		t.Fatalf("absorb.planned_kw = %v, want the plan's 0.0", snap.Absorb.PlannedKw)
	}
	if snap.Absorb.SurplusKw == nil || *snap.Absorb.SurplusKw != 19.6 {
		t.Fatalf("absorb.surplus_kw = %v, want 19.6", snap.Absorb.SurplusKw)
	}
	// The money: nothing leaves the site at a negative price any more.
	if got := 4.3 + snap.SetpointKw - 23.9; math.Abs(got) > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the whole point)", got)
	}
	// ... and it is not mistaken for either sibling correction.
	if snap.Trim != nil || snap.Follow != nil {
		t.Fatalf("trim=%+v follow=%+v, want neither (they are disjoint)", snap.Trim, snap.Follow)
	}
}

// The heartbeat carries WHY the commanded value deviates from the plan: an
// unnamed correction reads as a defect in the portal exactly as it does on the
// local card.
func TestTheHeartbeatNamesTheAbsorptionAsItsExecutionMode(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, true)
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()
	a.applySetpoint(now)

	ex := executionSummary(a.State.Get())
	if ex == nil || ex.Mode != execModeAbsorb {
		t.Fatalf("execution = %+v, want mode %q", ex, execModeAbsorb)
	}
	if ex.PlannedKw == nil || *ex.PlannedKw != 0.0 {
		t.Fatalf("execution.planned_kw = %v, want 0.0", ex.PlannedKw)
	}
	if ex.SurplusKw == nil || *ex.SurplusKw != 19.6 {
		t.Fatalf("execution.surplus_kw = %v, want 19.6", ex.SurplusKw)
	}
	if ex.DeficitKw != nil || ex.Direction != "" {
		t.Fatalf("execution = %+v, want no discharge-side fields", ex)
	}
}

// The price arbitrage stays untouched: an UNMARKED slot keeps its value
// byte-for-byte, whatever the measured surplus is.
func TestAnUnmarkedSlotIsNeverRaised(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, false)
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != 0.0 {
		t.Fatalf("setpoint = %v, want the plan's 0.0 on an unmarked slot", snap.SetpointKw)
	}
	if snap.Absorb != nil {
		t.Fatalf("absorb = %+v, want none on an unmarked slot", snap.Absorb)
	}
}

// A plan from a pre-feature cloud carries no flag at all: byte-for-byte the old
// behavior (the field is fail-OPEN by contract).
func TestALegacyPlanWithoutTheAbsorbFlagBehavesExactlyAsBefore(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	no := false
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GridChargeAllowed: &no,
		Slots:             []plan.Slot{{Start: now.Add(-5 * time.Minute), BatterySetpointKw: 0.0}},
	}
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	if snap := a.State.Get(); snap.SetpointKw != 0.0 || snap.Absorb != nil {
		t.Fatalf("setpoint = %v absorb = %+v, want 0.0 and no correction", snap.SetpointKw, snap.Absorb)
	}
}

// The COMMITTED CONTRACT BYTES (docs/contracts/examples, read by path on
// purpose - moving the fixture must break this): its first slot is the observed
// Pilsting shape (fully curtailed, 0,0 kW commanded, duty carried), so against
// the measured morning the published setpoint must be the surplus.
func TestTheCommittedContractFixtureAbsorbsTheMeasuredSurplus(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "docs", "contracts", "examples", "mqtt-schedule.valid.absorb-surplus.json"))
	if err != nil {
		t.Fatal(err)
	}
	rx := time.Date(2026, 8, 2, 8, 31, 0, 0, time.UTC)
	p, err := plan.Parse(raw, rx)
	if err != nil {
		t.Fatalf("absorb-surplus fixture: %v", err)
	}

	a := absorbAgent(t)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC))

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan", snap.Mode)
	}
	if snap.SetpointKw != 19.6 {
		t.Fatalf("marked slot setpoint = %v, want the measured surplus 19.6", snap.SetpointKw)
	}
	if snap.Absorb == nil || snap.Absorb.PlannedKw != 0.0 {
		t.Fatalf("absorb = %+v, want the fixture's planned 0.0 named", snap.Absorb)
	}
}

// THE safety composition end to end: the raised value goes back through the SAME
// guard chain, so the EEG solar-only clamp, the SoC ceiling and the rated band
// all still bind on it. Here the battery is nearly full - it must absorb nothing.
func TestAFullBatteryAbsorbsNothingEvenInAMarkedSlot(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, true)
	a.lastReading = guards.Reading{SocPct: 96, PvKw: 23.9, LoadKw: 4.3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != 0.0 {
		t.Fatalf("setpoint = %v, want 0 at the SoC ceiling", snap.SetpointKw)
	}
	if snap.Absorb != nil {
		t.Fatalf("absorb = %+v, want none when nothing could be absorbed", snap.Absorb)
	}
}

// A commanded DISCHARGE is never raised into a charge, even in a marked slot:
// an economic guard does not flip a direction.
func TestACommandedDischargeIsNeverTurnedIntoACharge(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	p := pilstingMorningPlan(now, true)
	p.Slots[0].BatterySetpointKw = -4.0
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != -4.0 {
		t.Fatalf("setpoint = %v, want the plan's -4.0 (no direction flip)", snap.SetpointKw)
	}
	if snap.Absorb != nil {
		t.Fatalf("absorb = %+v, want none on a commanded discharge", snap.Absorb)
	}
}

// A STALE plan hands over to the self-consumption fallback, which charges
// pv - load = the surplus itself, so the correction is a no-op there by
// construction.
func TestAStalePlanFallsBackAndTheAbsorptionIsANoOp(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	p := pilstingMorningPlan(now, true)
	p.ReceivedAt = now.Add(-2 * time.Hour)
	p.GeneratedAt = now.Add(-2 * time.Hour)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSelfConsume {
		t.Fatalf("mode = %v, want eigenverbrauch", snap.Mode)
	}
	if snap.SetpointKw != 19.6 { // pv - load, the fallback's own rule
		t.Fatalf("fallback setpoint = %v, want 19.6", snap.SetpointKw)
	}
	if snap.Absorb != nil {
		t.Fatalf("absorb = %+v, want none (the fallback already charges the surplus)", snap.Absorb)
	}
}

// THE identity that keeps a deliberate correction from being reported as a
// refused write: what we PUBLISH is what we absorbed, so the register readback
// compares against the raised value (PR #280's confirmation logic).
func TestTheAbsorbedValueIsWhatGetsPublishedSoNoMismatchIsPossible(t *testing.T) {
	a, addr := absorbAgentAddr(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	sub := subscribeSetpoint(t, addr)

	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, true)
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "the absorbed setpoint on the local bus", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 19.6
	})
	m, _ := sub.latest()
	if m["source"] != "schedule" {
		t.Fatalf("source = %v, want schedule (a correction is not a fallback)", m["source"])
	}
	if snap := a.State.Get(); snap.SetpointKw != m["battery_setpoint_kw"] {
		t.Fatalf("state %v != published %v", snap.SetpointKw, m["battery_setpoint_kw"])
	}
	// The EEG posture rides along unchanged - absorbing is solar by construction.
	if m["grid_charge_allowed"] != false {
		t.Fatalf("grid_charge_allowed = %v, want false (EEG plan)", m["grid_charge_allowed"])
	}
}

// Losing the measurements must never leave a stale correction claim on the card,
// and it must never regulate blind: the plan setpoint goes out unchanged.
func TestLosingTheMeasurementsClearsTheAbsorptionInsteadOfRegulatingBlind(t *testing.T) {
	a := absorbAgent(t)
	now := time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingMorningPlan(now, true)
	a.lastReading = pilstingMorningReading()
	a.mu.Unlock()
	a.applySetpoint(now)
	if a.State.Get().Absorb == nil {
		t.Fatal("setup: the correction must be active first")
	}

	a.mu.Lock()
	a.lastReading = guards.Reading{
		SocPct: 7, PvKw: guards.Unknown(), LoadKw: 4.3, GridLimitKw: guards.Unknown(),
	}
	a.mu.Unlock()
	a.applySetpoint(now.Add(10 * time.Second))

	snap := a.State.Get()
	if snap.SetpointKw != 0.0 {
		t.Fatalf("setpoint = %v, want the plan's 0.0 (never regulate blind)", snap.SetpointKw)
	}
	if snap.Absorb != nil {
		t.Fatalf("absorb = %+v, want the claim cleared", snap.Absorb)
	}
}
