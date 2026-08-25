package agent

// The additive `execution` heartbeat block (Fahrplan-Konzept
// vp-fahrplan-kunde-konzept §5, PR 3).
//
// What it is worth: since the in-slot duties the box knowingly deviates from
// the plan's watt value, and the heartbeat carried NO trace of that - so the
// portal could only say "something was adjusted", never the direction or the
// cause. These tests pin the direction, the mode and the measured target the
// cloud needs to name it, plus the honesty rules (no fabricated value, no
// claim without a correction).

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// confirmedControl is a minimal, healthy readback so controlSummary produces a
// block at all (an execution block only rides INSIDE the control block).
func confirmedControl() *state.ControlInfo {
	c := -4.332
	return &state.ControlInfo{
		AllMatch:  true,
		CheckedAt: time.Date(2026, 7, 30, 21, 22, 0, 0, time.UTC),
		Registers: []state.ControlRegister{
			{Role: "battery_power", CommandedKw: &c, ActualKw: &c, Match: true},
		},
	}
}

func TestExecutionSummaryNamesTheLoadFollowingDirection(t *testing.T) {
	// The captain's live constellation (30.07., 21:22): the plan discharged
	// -4,332 kW into a 7,117 kW house, so the box RAISED the discharge to cover
	// the deficit instead of buying the difference at ~32,5 ct.
	deficit := 7.087
	snap := state.Snapshot{
		Mode:    state.ModeSchedule,
		Control: confirmedControl(),
		Follow: &state.FollowInfo{
			Active:    true,
			Direction: guards.FollowDeepen,
			PlannedKw: -4.332,
			DeficitKw: &deficit,
		},
	}
	ex := controlSummary(snap).Execution
	if ex == nil {
		t.Fatal("a following device must report an execution block")
	}
	if ex.Mode != execModeFollow || ex.Direction != guards.FollowDeepen {
		t.Fatalf("mode/direction: %+v", ex)
	}
	if ex.PlannedKw == nil || *ex.PlannedKw != -4.332 {
		t.Fatalf("the pre-correction plan value must ride along: %+v", ex)
	}
	if ex.DeficitKw == nil || *ex.DeficitKw != deficit {
		t.Fatalf("the measured deficit must ride along: %+v", ex)
	}
	if ex.SurplusKw != nil {
		t.Fatal("a discharge correction must not claim a PV surplus")
	}
}

func TestExecutionSummaryNamesTheLimitingDirection(t *testing.T) {
	// The mirror (23:12): the plan discharged deeper than the house needed, so
	// the box LIMITED it instead of exporting the difference unpriced.
	deficit := 5.1
	snap := state.Snapshot{
		Mode:    state.ModeSchedule,
		Control: confirmedControl(),
		Follow: &state.FollowInfo{
			Active:    true,
			Direction: guards.FollowReduce,
			PlannedKw: -6.7,
			DeficitKw: &deficit,
		},
	}
	ex := controlSummary(snap).Execution
	if ex == nil || ex.Direction != guards.FollowReduce {
		t.Fatalf("limiting direction: %+v", ex)
	}
}

func TestIdleFollowerReportsOnlyWhileItActuallyCorrects(t *testing.T) {
	floor, deficit := 35.0, 14.7
	active := state.Snapshot{
		Mode: state.ModeSchedule, Control: confirmedControl(), EffectiveFloorSocPct: &floor,
		Follow: &state.FollowInfo{Active: true, Path: execModeIdleFollow,
			Direction: guards.FollowDeepen, PlannedKw: 0, DeficitKw: &deficit},
	}
	ex := controlSummary(active).Execution
	if ex == nil || ex.Mode != execModeIdleFollow || ex.EffectiveFloorSocPct == nil ||
		*ex.EffectiveFloorSocPct != floor || !ex.MeasurementsFresh {
		t.Fatalf("active idle correction diagnostics = %+v", ex)
	}

	// Screenshot B: PV now exceeds load, the follower returned 0 kW and
	// Active=false. Even if a stale in-memory struct still carries the path, the
	// heartbeat truth is the neutral plan mode - never "covering live".
	neutral := active
	neutral.Follow = &state.FollowInfo{Active: false, Path: execModeIdleFollow, PlannedKw: 0}
	if ex := controlSummary(neutral).Execution; ex == nil || ex.Mode != execModePlan {
		t.Fatalf("neutral slot must report plan, not idle_follow: %+v", ex)
	}
}

func TestIdleFollowerRequiresFreshHeldReadback(t *testing.T) {
	now := time.Date(2026, 8, 25, 10, 0, 30, 0, time.UTC)
	held := &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now.Add(-10 * time.Second)}
	if !idleReadbackHealthy(held, now, 30*time.Second) {
		t.Fatal("fresh independently held readback must release the portable path")
	}
	for _, bad := range []*state.ControlInfo{
		nil,
		{AllMatch: false, Confirm: "not_held", CheckedAt: now},
		{AllMatch: true, Confirm: "no_answer", CheckedAt: now},
		{AllMatch: true, Confirm: "held", CheckedAt: now.Add(-31 * time.Second)},
		{AllMatch: true, Confirm: "held", CheckedAt: now.Add(time.Second)},
	} {
		if idleReadbackHealthy(bad, now, 30*time.Second) {
			t.Fatalf("unsafe readback accepted: %+v", bad)
		}
	}
}

func TestExecutionSummaryNamesThePriceAwareTrim(t *testing.T) {
	surplus := 3.1
	snap := state.Snapshot{
		Mode:    state.ModeSchedule,
		Control: confirmedControl(),
		Trim: &state.TrimInfo{
			Active:    true,
			PlannedKw: 11.1,
			SurplusKw: &surplus,
		},
	}
	ex := controlSummary(snap).Execution
	if ex == nil || ex.Mode != execModeTrim {
		t.Fatalf("trim mode: %+v", ex)
	}
	if ex.SurplusKw == nil || *ex.SurplusKw != surplus {
		t.Fatalf("the measured surplus must ride along: %+v", ex)
	}
	if ex.Direction != "" {
		t.Fatal("a trim has no follow direction - it must not invent one")
	}
	if ex.DeficitKw != nil {
		t.Fatal("a charge correction must not claim a house deficit")
	}
}

func TestExecutionSummaryDistinguishesPlanFromFallback(t *testing.T) {
	planned := state.Snapshot{Mode: state.ModeSchedule, Control: confirmedControl()}
	if ex := controlSummary(planned).Execution; ex == nil || ex.Mode != execModePlan {
		t.Fatalf("an uncorrected plan slot must report mode plan: %+v", ex)
	}
	fallback := state.Snapshot{Mode: state.ModeSelfConsume, Control: confirmedControl()}
	ex := controlSummary(fallback).Execution
	if ex == nil || ex.Mode != execModeFallback {
		t.Fatalf("a device on its built-in rule must report mode fallback: %+v", ex)
	}
	// An uncorrected device claims nothing beyond its mode.
	if ex.Direction != "" || ex.PlannedKw != nil || ex.DeficitKw != nil || ex.SurplusKw != nil {
		t.Fatalf("no correction means no correction detail: %+v", ex)
	}
}

// A mode that does NOT map cleanly onto plan/fallback makes no claim at all -
// mislabelling a desired-held battery or a calibration run as "the built-in
// safety rule" would be exactly the invented statement the honesty rules ban.
func TestExecutionSummaryMakesNoClaimForAnUnmappedMode(t *testing.T) {
	for _, m := range []state.Mode{state.ModeDesired, state.ModeCalibration, state.ModeNoReading} {
		snap := state.Snapshot{Mode: m, Control: confirmedControl()}
		sum := controlSummary(snap)
		if sum == nil {
			t.Fatalf("%s: the control block itself must still ride", m)
		}
		if sum.Execution != nil {
			t.Fatalf("%s: must not claim an execution mode: %+v", m, sum.Execution)
		}
	}
}

func TestExecutionSummaryOmitsAnUnknownMeasurement(t *testing.T) {
	// Never regulate blind - and never REPORT blind either: an unknown deficit
	// stays absent instead of being coerced to 0.
	snap := state.Snapshot{
		Mode:    state.ModeSchedule,
		Control: confirmedControl(),
		Follow: &state.FollowInfo{
			Active:    true,
			Direction: guards.FollowDeepen,
			PlannedKw: -4.0,
		},
	}
	if ex := controlSummary(snap).Execution; ex == nil || ex.DeficitKw != nil {
		t.Fatalf("an unknown deficit must stay absent: %+v", ex)
	}
}

func TestExecutionSummaryStaysInsideTheControlBlock(t *testing.T) {
	// No readback -> no control block at all -> no execution block. The cloud
	// contract for a device that confirms nothing is byte-identical to before.
	if sum := controlSummary(state.Snapshot{Mode: state.ModeSchedule}); sum != nil {
		t.Fatalf("no readback must yield no summary: %+v", sum)
	}
}

func TestExecutionSummaryWireShapeOmitsEmptyFields(t *testing.T) {
	deficit := 7.087
	snap := state.Snapshot{
		Mode:    state.ModeSchedule,
		Control: confirmedControl(),
		Follow: &state.FollowInfo{
			Active:    true,
			Direction: guards.FollowDeepen,
			PlannedKw: -4.332,
			DeficitKw: &deficit,
		},
	}
	raw, err := json.Marshal(controlSummary(snap))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Execution map[string]any `json:"execution"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"mode", "direction", "planned_kw", "deficit_kw"} {
		if _, ok := out.Execution[k]; !ok {
			t.Fatalf("wire block is missing %q: %v", k, out.Execution)
		}
	}
	if _, ok := out.Execution["surplus_kw"]; ok {
		t.Fatalf("an absent measurement must not reach the wire: %v", out.Execution)
	}

	// And a summary WITHOUT an execution block must not carry the key at all,
	// so an older core's payload stays byte-identical.
	bare, _ := json.Marshal(&cloud.ControlSummary{MismatchRoles: []string{}})
	var probe map[string]any
	_ = json.Unmarshal(bare, &probe)
	if _, ok := probe["execution"]; ok {
		t.Fatalf("execution must be omitempty: %v", probe)
	}
}
