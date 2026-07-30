package agent

// In-slot load following, end to end through applySetpoint (2026-07-30) - the
// discharge-side mirror of slot_trim_test.go.
//
// The scenario is the live reading of the Pilsting NIGHT (scout report
// vp-netzbezug-nacht-s3 §2.1): house 7.117 kW, PV 0.03 kW, SoC 77 %, and a plan
// setpoint of -4.332 kW - which is the slot's LOAD FORECAST, so 2.755 kW was
// bought at ~32.5 ct while the battery was 77 % full. In a slot the cloud marked
// worth covering the setpoint published to Layer 1 must be the MEASURED house
// deficit; in an unmarked one it must be the plan's -4.332 kW; and the published
// value must ALWAYS equal the state's setpoint (that identity is what keeps a
// deliberate correction from ever reading as "setpoint not adopted").

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func followAgentAddr(t *testing.T) (*Agent, string) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw = 30
	cfg.MaxDischargeKw = 30
	return startBusOnlyAgent(t, cfg)
}

func followAgent(t *testing.T) *Agent {
	t.Helper()
	a, _ := followAgentAddr(t)
	return a
}

// pilstingNightPlan is a FRESH one-slot plan commanding the observed -4.332 kW
// discharge, with the cloud's price verdict for that slot.
func pilstingNightPlan(now time.Time, coverLoad bool) *plan.Plan {
	yes := true
	return &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GeneratedAt:       now.Add(-time.Minute),
		GridChargeAllowed: &yes,
		Slots: []plan.Slot{{
			Start:                now.Add(-5 * time.Minute),
			BatterySetpointKw:    -4.332,
			CoverLoadFromBattery: coverLoad,
		}},
	}
}

func pilstingNightReading() guards.Reading {
	return guards.Reading{SocPct: 77, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: guards.Unknown()}
}

func TestMarkedSlotCoversTheMeasuredHouseAndSaysWhy(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingNightPlan(now, true)
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan (a correction is not a fallback)", snap.Mode)
	}
	if snap.SetpointKw != -7.087 { // pv - load
		t.Fatalf("setpoint = %v, want the measured deficit -7.087", snap.SetpointKw)
	}
	if snap.Follow == nil || !snap.Follow.Active {
		t.Fatal("the state must carry the correction - an unnamed correction reads as a defect")
	}
	if snap.Follow.PlannedKw != -4.332 {
		t.Fatalf("follow.planned_kw = %v, want the plan's -4.332", snap.Follow.PlannedKw)
	}
	if snap.Follow.DeficitKw == nil || *snap.Follow.DeficitKw != 7.087 {
		t.Fatalf("follow.deficit_kw = %v, want 7.087", snap.Follow.DeficitKw)
	}
	// The money: the house no longer draws from the grid.
	if got := 7.117 + snap.SetpointKw - 0.03; got > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the whole point)", got)
	}
}

func TestUnmarkedSlotPublishesThePlanSetpointUnchanged(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingNightPlan(now, false)
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != -4.332 {
		t.Fatalf("setpoint = %v, want the plan's -4.332 - a deliberate purchase stays", snap.SetpointKw)
	}
	if snap.Follow != nil {
		t.Fatalf("follow = %+v, want none on an unmarked slot", snap.Follow)
	}
}

// A plan from a pre-feature cloud carries no flag at all: byte-for-byte the old
// behavior (the field is fail-OPEN by contract).
func TestALegacyPlanWithoutTheCoverFlagBehavesExactlyAsBefore(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	yes := true
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-time.Minute),
		GridChargeAllowed: &yes,
		Slots:             []plan.Slot{{Start: now.Add(-5 * time.Minute), BatterySetpointKw: -4.332}},
	}
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	if snap := a.State.Get(); snap.SetpointKw != -4.332 || snap.Follow != nil {
		t.Fatalf("setpoint = %v follow = %+v, want -4.332 and no correction", snap.SetpointKw, snap.Follow)
	}
}

// A STALE plan hands over to the self-consumption fallback, which follows
// pv - load = the deficit itself, so the correction is a no-op there by
// construction.
func TestAStalePlanFallsBackAndTheCorrectionIsANoOp(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	p := pilstingNightPlan(now, true)
	p.ReceivedAt = now.Add(-2 * time.Hour)
	p.GeneratedAt = now.Add(-2 * time.Hour)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSelfConsume {
		t.Fatalf("mode = %v, want eigenverbrauch", snap.Mode)
	}
	if snap.SetpointKw != -7.087 { // pv - load, the fallback's own rule
		t.Fatalf("fallback setpoint = %v, want -7.087", snap.SetpointKw)
	}
	if snap.Follow != nil {
		t.Fatalf("follow = %+v, want none (the fallback already follows the load)", snap.Follow)
	}
}

// THE identity that keeps a deliberate correction from being reported as a
// refused write: what we PUBLISH is what we followed, so the register readback
// compares against the followed value (PR #280's confirmation logic).
func TestTheFollowedValueIsWhatGetsPublishedSoNoMismatchIsPossible(t *testing.T) {
	a, addr := followAgentAddr(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	sub := subscribeSetpoint(t, addr)

	a.mu.Lock()
	a.currentPlan = pilstingNightPlan(now, true)
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "the followed setpoint on the local bus", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == -7.087
	})
	m, _ := sub.latest()
	if m["source"] != "schedule" {
		t.Fatalf("source = %v, want schedule (a correction is not a fallback)", m["source"])
	}
	if snap := a.State.Get(); snap.SetpointKw != m["battery_setpoint_kw"] {
		t.Fatalf("state %v != published %v", snap.SetpointKw, m["battery_setpoint_kw"])
	}
}

// Losing the measurements must never leave a stale correction claim on the card,
// and it must never regulate blind: the plan setpoint goes out unchanged.
func TestLosingTheMeasurementsClearsTheCorrectionInsteadOfRegulatingBlind(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = pilstingNightPlan(now, true)
	a.lastReading = pilstingNightReading()
	a.mu.Unlock()
	a.applySetpoint(now)
	if a.State.Get().Follow == nil {
		t.Fatal("expected the correction to be recorded first")
	}

	// pv/load gone but SoC still known: the guard must not regulate on a guess.
	a.mu.Lock()
	a.lastReading = guards.Reading{
		SocPct: 77, PvKw: guards.Unknown(), LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown(),
	}
	a.mu.Unlock()
	a.applySetpoint(now.Add(10 * time.Second))

	snap := a.State.Get()
	if snap.Follow != nil {
		t.Fatalf("follow = %+v, want the claim cleared", snap.Follow)
	}
	if snap.SetpointKw != -4.332 {
		t.Fatalf("setpoint = %v, want the plan's -4.332 unchanged", snap.SetpointKw)
	}
}

// The peak reserve composes: ordinary load covering stops at the reserve, which
// is exactly what the reserve exists for (peak DEFENSE may still go below it).
func TestThePeakReserveBoundsTheLoadFollowing(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC)
	p := pilstingNightPlan(now, true)
	target, reserve := 25.0, 80.0
	p.GridImportLimitKw = &target
	p.PeakReserveSocPct = &reserve
	r := pilstingNightReading() // SoC 77 % - below the 80 % reserve
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = r
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Follow != nil {
		t.Fatalf("follow = %+v, want none below the peak reserve", snap.Follow)
	}
	if snap.SetpointKw != -4.332 {
		t.Fatalf("setpoint = %v, want the plan's -4.332 (the reserve is protected)", snap.SetpointKw)
	}
}
