package agent

// In-slot load following, end to end through applySetpoint (2026-07-30) - the
// discharge-side mirror of slot_trim_test.go.
//
// The scenario is the live reading of the Pilsting NIGHT (scout report
// vp-netzbezug-nacht-s3 §2.1): house 7.117 kW, PV 0.03 kW, SoC 77 %, and a plan
// setpoint of -4.332 kW - which is the slot's LOAD FORECAST, so 2.755 kW was
// bought at ~32.5 ct while the battery was 77 % full. Its mirror image was
// measured on the same night at 23:12: -6.7 kW planned into a 5.1 kW house, so
// 1.4 kW was EXPORTED at ~21 ct while that kWh was worth ~32.5 ct later. In a
// slot the cloud marked worth covering the setpoint published to Layer 1 must
// track the MEASURED house deficit in BOTH directions; in an unmarked one it
// must be the plan's own value; and the published value must ALWAYS equal the
// state's setpoint (that identity is what keeps a deliberate correction from
// ever reading as "setpoint not adopted").

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

// Full Edge path for the customer-validated A -> B replay. The same live
// follower instance receives both snapshots; B is not helped by a reset.
func TestAuthorizedIdleSlotCoversScreenshotAThenReportsScreenshotBNeutral(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)
	yes, floor := true, 35.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{Start: now, BatterySetpointKw: 0, UnplannedLoadDischarge: true}},
	}
	a.lastReading = guards.Reading{SocPct: 95, PvKw: 22.1, LoadKw: 36.8, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "screenshot A idle correction", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == -14.7
	})
	snap := a.State.Get()
	if snap.Follow == nil || snap.Follow.Path != execModeIdleFollow || !snap.Follow.Active {
		t.Fatalf("screenshot A follow evidence = %+v, want active idle path", snap.Follow)
	}
	if grid := 36.8 + snap.SetpointKw - 22.1; math.Abs(grid) > .2 {
		t.Fatalf("screenshot A grid = %.3f kW, want within 0.2 kW of zero", grid)
	}

	// Ten seconds later PV exceeds the load. The exact same correction must
	// publish 0, clear the active/path claim and never add battery export.
	bAt := now.Add(10 * time.Second)
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 95, PvKw: 22.6, LoadKw: 16.6, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = bAt
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) { s.Control.CheckedAt = bAt })
	a.applySetpoint(bAt)
	waitFor(t, 5*time.Second, "screenshot B neutral command", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 0.0
	})
	snap = a.State.Get()
	if snap.SetpointKw != 0 || snap.Follow != nil {
		t.Fatalf("screenshot B state setpoint=%v follow=%+v, want honest neutral", snap.SetpointKw, snap.Follow)
	}
	if addedBatteryExport := math.Max(-snap.SetpointKw, 0); addedBatteryExport > .2 {
		t.Fatalf("screenshot B added battery export = %.3f kW, want <= 0.2", addedBatteryExport)
	}
	if ex := controlSummary(snap).Execution; ex == nil || ex.Mode != execModePlan {
		t.Fatalf("screenshot B execution = %+v, want neutral plan mode", ex)
	}
}

// The customer-trust regression from 28.08.2026: the economic plan deliberately
// held the battery for later, but the cockpit showed 94 % SoC next to 4.1 kW
// grid import (PV 0.9 / house 5.0). Near the configured 95 % ceiling the small
// top band must cover that load even when the economic unplanned flag is false;
// it must stop again at 90 %, preserving the rest for the optimizer.
func TestNearlyFullBatteryCoversIdleImportOnlyInsideItsSmallTopBand(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 28, 14, 51, 0, 0, time.UTC)
	yes, floor := true, 35.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: now, BatterySetpointKw: 0,
			// The optimizer explicitly valued later use more highly. This is
			// the exact path the high-SoC rule exists to bound.
			UnplannedLoadDischarge: false,
		}},
	}
	a.lastReading = guards.Reading{
		SocPct: 94, PvKw: .9, LoadKw: 5.0, GridLimitKw: guards.Unknown(),
	}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the 94%-battery correction", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == -4.1
	})
	snap := a.State.Get()
	if snap.Follow == nil || snap.Follow.Path != execModeHighSocFollow || !snap.Follow.Active {
		t.Fatalf("full-battery execution evidence = %+v", snap.Follow)
	}
	if snap.Follow.FloorSocPct == nil || *snap.Follow.FloorSocPct != 90 {
		t.Fatalf("top-band floor = %+v, want 90%%", snap.Follow.FloorSocPct)
	}
	if ex := controlSummary(snap).Execution; ex == nil || ex.Mode != execModeHighSocFollow ||
		ex.EffectiveFloorSocPct == nil || *ex.EffectiveFloorSocPct != 90 {
		t.Fatalf("heartbeat must name the bounded correction and its real floor: %+v", ex)
	}
	if grid := 5.0 + snap.SetpointKw - .9; math.Abs(grid) > .001 {
		t.Fatalf("grid = %.3f kW, want zero", grid)
	}

	// Same idle slot, but the five-point top band is spent. No economic grant
	// exists, so the optimizer gets the remaining energy back immediately.
	atFloor := now.Add(10 * time.Second)
	a.mu.Lock()
	a.lastReading.SocPct = 90
	a.lastReadingAt = atFloor
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) { s.Control.CheckedAt = atFloor })
	a.applySetpoint(atFloor)
	waitFor(t, 5*time.Second, "top-band release", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 0.0
	})
	if snap := a.State.Get(); snap.Follow != nil || snap.SetpointKw != 0 {
		t.Fatalf("top band must release back to the optimizer: setpoint=%v follow=%+v",
			snap.SetpointKw, snap.Follow)
	}
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
	if snap.Follow.Direction != guards.FollowDeepen {
		t.Fatalf("follow.direction = %q, want %q", snap.Follow.Direction, guards.FollowDeepen)
	}
	// The money: the house no longer draws from the grid.
	if got := 7.117 + snap.SetpointKw - 0.03; got > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the whole point)", got)
	}
}

// The MIRROR half (Pilsting 23:12): the plan discharges past the house, so the
// difference leaves the site at the feed-in price while the same kWh is worth
// more as avoided import later. The published setpoint must be the measured
// deficit, and the card must say it LIMITED the discharge.
func TestMarkedSlotLimitsADischargeThatOvershootsTheHouse(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 23, 12, 0, 0, time.UTC)
	p := pilstingNightPlan(now, true)
	p.Slots[0].BatterySetpointKw = -6.7
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 77, PvKw: 0, LoadKw: 5.1, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan (a correction is not a fallback)", snap.Mode)
	}
	if snap.SetpointKw != -5.1 {
		t.Fatalf("setpoint = %v, want the measured deficit -5.1", snap.SetpointKw)
	}
	if snap.Follow == nil || snap.Follow.Direction != guards.FollowReduce {
		t.Fatalf("follow = %+v, want the limiting direction named", snap.Follow)
	}
	if snap.Follow.PlannedKw != -6.7 {
		t.Fatalf("follow.planned_kw = %v, want the plan's -6.7", snap.Follow.PlannedKw)
	}
	// The money: nothing leaves the site unpriced any more.
	if got := 5.1 + snap.SetpointKw - 0; math.Abs(got) > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0", got)
	}
}

// The floor of the limiting direction, end to end: PV covers the house, so the
// discharge stops at 0 - the follower never turns a discharge into a charge.
func TestWithNoDeficitTheFollowedSetpointIsZeroAndNeverACharge(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	p := pilstingNightPlan(now, true)
	p.Slots[0].BatterySetpointKw = -3.0
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 9.1, LoadKw: 3.4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != 0 {
		t.Fatalf("setpoint = %v, want exactly 0 (stop discharging, never charge)", snap.SetpointKw)
	}
	if snap.Follow == nil || snap.Follow.Direction != guards.FollowReduce {
		t.Fatalf("follow = %+v, want the limiting direction named", snap.Follow)
	}
}

// The limiting direction on the COMMITTED CONTRACT BYTES (docs/contracts/
// examples, read by path on purpose - moving the fixture must break this): its
// active slot carries the duty and discharges 4.332 kW, so against a 2 kW house
// the published setpoint must be -2 kW. (Its unmarked 30 kW sell window sits
// half an hour later, i.e. outside the plan's own staleness window, so the
// unmarked half is proven on a fresh plan below.)
func TestTheCommittedContractFixtureIsLimitedToTheMeasuredHouse(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "docs", "contracts", "examples", "mqtt-schedule.valid.cover-load.json"))
	if err != nil {
		t.Fatal(err)
	}
	rx := time.Date(2026, 7, 30, 19, 16, 0, 0, time.UTC)
	p, err := plan.Parse(raw, rx)
	if err != nil {
		t.Fatalf("cover-load fixture: %v", err)
	}

	a := followAgent(t)
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 77, PvKw: 0, LoadKw: 2.0, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(time.Date(2026, 7, 30, 19, 20, 0, 0, time.UTC))

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan", snap.Mode)
	}
	if snap.SetpointKw != -2.0 {
		t.Fatalf("marked slot setpoint = %v, want the measured deficit -2.0", snap.SetpointKw)
	}
	if snap.Follow == nil || snap.Follow.Direction != guards.FollowReduce {
		t.Fatalf("follow = %+v, want the limiting direction named", snap.Follow)
	}
	if snap.Follow.PlannedKw != -4.332 {
		t.Fatalf("follow.planned_kw = %v, want the fixture's -4.332", snap.Follow.PlannedKw)
	}
}

// The price arbitrage stays untouched: an UNMARKED slot keeps its deliberate
// sell window byte-for-byte, however far it overshoots the measured house.
func TestAnUnmarkedSellWindowIsNeverLimited(t *testing.T) {
	a := followAgent(t)
	now := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	p := pilstingNightPlan(now, false)
	p.Slots[0].BatterySetpointKw = -25.0
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 80, PvKw: 0, LoadKw: 2.0, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != -25.0 {
		t.Fatalf("setpoint = %v, want the plan's -25 (a deliberate sale stays)", snap.SetpointKw)
	}
	if snap.Follow != nil {
		t.Fatalf("follow = %+v, want none on an unmarked slot", snap.Follow)
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

	// The identity must hold for a LIMITED discharge too - that is the direction
	// a reader could most easily mistake for a refused write.
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 77, PvKw: 0, LoadKw: 2.0, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now.Add(10 * time.Second))

	waitFor(t, 5*time.Second, "the limited setpoint on the local bus", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == -2.0
	})
	m, _ = sub.latest()
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
