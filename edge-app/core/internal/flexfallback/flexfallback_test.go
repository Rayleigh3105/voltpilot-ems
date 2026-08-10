package flexfallback

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

func fp(v float64) *float64 { return &v }
func bp(v bool) *bool       { return &v }

func pumpReq(t *testing.T) Requirement {
	t.Helper()
	r, err := ParseRequirement(entities.FlexRequirement{
		ID: "pump-daily-hour", Timezone: "Europe/Berlin",
		Days: "daily", From: "00:00", To: "24:00",
		RuntimeMinutes: fp(60), Contiguous: bp(true),
		PowerKw: 2.2, Command: entities.CmdOnOff,
	})
	if err != nil {
		t.Fatalf("pump requirement rejected: %v", err)
	}
	return r
}

func berlin(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("tzdata missing: %v", err)
	}
	return loc
}

// --- parsing ----------------------------------------------------------------

func TestParseRequirementValidatesTheContractEntry(t *testing.T) {
	r := pumpReq(t)
	if r.RuntimeSeconds != 3600 || r.PowerKw != 2.2 || r.Command != entities.CmdOnOff {
		t.Fatalf("parsed fields wrong: %+v", r)
	}
	if !r.Contiguous {
		t.Fatalf("contiguous lost")
	}

	// The fixture of the contract (read BY PATH elsewhere) must parse too -
	// here the semantic refusals: each missing datum refuses the requirement,
	// never guesses (rule 5).
	cases := []entities.FlexRequirement{
		{ID: "", Days: "daily", From: "00:00", To: "24:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "on_off"},
		{ID: "x", Days: "montags", From: "00:00", To: "24:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "on_off"},
		{ID: "x", Days: "daily", From: "0:00", To: "24:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "on_off"},
		{ID: "x", Days: "daily", From: "00:00", To: "25:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "on_off"},
		{ID: "x", Days: "daily", From: "00:00", To: "24:00", PowerKw: 2, Command: "on_off"},
		{ID: "x", Days: "daily", From: "00:00", To: "24:00", RuntimeMinutes: fp(60), Command: "on_off"},
		{ID: "x", Days: "daily", From: "00:00", To: "24:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "mode"},
		{ID: "x", Days: "daily", From: "00:00", To: "24:00", RuntimeMinutes: fp(60), PowerKw: 2, Command: "on_off", Timezone: "Mars/Olympus"},
	}
	for i, fr := range cases {
		if _, err := ParseRequirement(fr); err == nil {
			t.Fatalf("case %d must be refused: %+v", i, fr)
		}
	}
}

func TestParseRequirementDefaultsToTheSiteTimezonePinning(t *testing.T) {
	r, err := ParseRequirement(entities.FlexRequirement{
		ID: "x", Days: "daily", From: "06:00", To: "22:00",
		EnergyKwh: fp(8), PowerKw: 11, Command: entities.CmdSetpointKw,
	})
	if err != nil {
		t.Fatalf("rejected: %v", err)
	}
	if r.Loc.String() != DefaultTimezone {
		t.Fatalf("default timezone = %s, want %s", r.Loc, DefaultTimezone)
	}
	if r.EnergyKwh != 8 || r.RuntimeSeconds != 0 {
		t.Fatalf("energy demand wrong: %+v", r)
	}
}

// --- instances (site time, DST) ---------------------------------------------

func TestCurrentInstanceAnchorsOnTheLocalDay(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	// 2026-06-15 23:30 Berlin is 21:30 UTC - the instance must still be the
	// Berlin 15th, not the UTC-derived 15th-by-accident on another zone.
	now := time.Date(2026, 6, 15, 23, 30, 0, 0, loc)
	inst, ok := r.CurrentInstance(now)
	if !ok {
		t.Fatal("inside the daily window but no instance")
	}
	if inst.Key != "pump-daily-hour@2026-06-15" {
		t.Fatalf("instance key = %s", inst.Key)
	}
	if !inst.Deadline.Equal(time.Date(2026, 6, 16, 0, 0, 0, 0, loc)) {
		t.Fatalf("deadline = %v", inst.Deadline)
	}
}

func TestCurrentInstanceOutsideTheWindowAndDayFilter(t *testing.T) {
	loc := berlin(t)
	r, err := ParseRequirement(entities.FlexRequirement{
		ID: "morning", Days: "weekdays", From: "08:00", To: "10:00",
		RuntimeMinutes: fp(30), PowerKw: 2, Command: entities.CmdOnOff,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Monday 11:00: past the window.
	if _, ok := r.CurrentInstance(time.Date(2026, 6, 15, 11, 0, 0, 0, loc)); ok {
		t.Fatal("11:00 is outside 08:00-10:00")
	}
	// Monday 09:00: inside.
	if _, ok := r.CurrentInstance(time.Date(2026, 6, 15, 9, 0, 0, 0, loc)); !ok {
		t.Fatal("09:00 Monday must be inside")
	}
	// Saturday 09:00: the weekdays filter refuses the anchor day.
	if _, ok := r.CurrentInstance(time.Date(2026, 6, 20, 9, 0, 0, 0, loc)); ok {
		t.Fatal("Saturday must not match weekdays")
	}
}

func TestOvernightWindowBelongsToItsAnchorDay(t *testing.T) {
	loc := berlin(t)
	r, err := ParseRequirement(entities.FlexRequirement{
		ID: "night", Days: "daily", From: "20:00", To: "06:00",
		RuntimeMinutes: fp(120), PowerKw: 3, Command: entities.CmdOnOff,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 02:00 on the 16th lies in the window ANCHORED on the 15th.
	inst, ok := r.CurrentInstance(time.Date(2026, 6, 16, 2, 0, 0, 0, loc))
	if !ok {
		t.Fatal("02:00 must be inside the overnight window")
	}
	if inst.Key != "night@2026-06-15" {
		t.Fatalf("overnight instance key = %s (must anchor on the previous day)", inst.Key)
	}
	if !inst.Deadline.Equal(time.Date(2026, 6, 16, 6, 0, 0, 0, loc)) {
		t.Fatalf("deadline = %v", inst.Deadline)
	}
	// 12:00 is outside both the anchored-yesterday and the anchored-today window.
	if _, ok := r.CurrentInstance(time.Date(2026, 6, 16, 12, 0, 0, 0, loc)); ok {
		t.Fatal("noon must be outside the overnight window")
	}
}

func TestDstDaysKeepWallClockDeadlines(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	// Spring forward 2026-03-29: the local day has 23 elapsed hours.
	inst, ok := r.CurrentInstance(time.Date(2026, 3, 29, 12, 0, 0, 0, loc))
	if !ok {
		t.Fatal("no instance on the spring-forward day")
	}
	if d := inst.Deadline.Sub(inst.Start); d != 23*time.Hour {
		t.Fatalf("spring-forward day spans %v, want 23h", d)
	}
	// Fall back 2026-10-25: 25 elapsed hours.
	inst, ok = r.CurrentInstance(time.Date(2026, 10, 25, 12, 0, 0, 0, loc))
	if !ok {
		t.Fatal("no instance on the fall-back day")
	}
	if d := inst.Deadline.Sub(inst.Start); d != 25*time.Hour {
		t.Fatalf("fall-back day spans %v, want 25h", d)
	}
	// The deadline is a wall-clock midnight either way - the 60-min duty's
	// latest start stays deadline-60min-margin in ABSOLUTE time.
	ls := r.LatestStart(inst, Progress{})
	if want := inst.Deadline.Add(-time.Hour).Add(-StartMargin); !ls.Equal(want) {
		t.Fatalf("latest start = %v, want %v", ls, want)
	}
}

// --- remaining need / latest start ------------------------------------------

func TestRemainingNeedComesFromConfirmedProgress(t *testing.T) {
	r := pumpReq(t)
	if got := r.RemainingSeconds(Progress{}); got != 3600 {
		t.Fatalf("fresh instance remaining = %v", got)
	}
	if got := r.RemainingSeconds(Progress{RuntimeSeconds: 2400}); got != 1200 {
		t.Fatalf("partial remaining = %v", got)
	}
	if got := r.RemainingSeconds(Progress{RuntimeSeconds: 4000}); got != 0 {
		t.Fatalf("overfulfilled remaining = %v", got)
	}
}

func TestEnergyDemandConvertsThroughTheRunPower(t *testing.T) {
	r, err := ParseRequirement(entities.FlexRequirement{
		ID: "charge", Days: "daily", From: "00:00", To: "06:30",
		EnergyKwh: fp(8), PowerKw: 4, Command: entities.CmdSetpointKw,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 8 kWh at 4 kW = 2 h.
	if got := r.RemainingSeconds(Progress{}); got != 7200 {
		t.Fatalf("remaining = %v", got)
	}
	if got := r.RemainingSeconds(Progress{EnergyKwh: 6}); got != 1800 {
		t.Fatalf("remaining after 6 kWh = %v", got)
	}
	// A combined demand binds on the LARGER remaining half.
	comb, err := ParseRequirement(entities.FlexRequirement{
		ID: "comb", Days: "daily", From: "00:00", To: "24:00",
		RuntimeMinutes: fp(60), EnergyKwh: fp(8), PowerKw: 4, Command: entities.CmdSetpointKw,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := comb.RemainingSeconds(Progress{RuntimeSeconds: 3600, EnergyKwh: 4})
	if got != 3600 { // runtime done, 4 kWh left at 4 kW = 1 h
		t.Fatalf("combined remaining = %v", got)
	}
}

// --- the decision -----------------------------------------------------------

func decideAt(t *testing.T, r Requirement, local time.Time, in Input) Verdict {
	t.Helper()
	in.Now = local
	return Decide(r, in)
}

func TestDecideNeverStartsWhileAFreshPlanLies(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	// 23:30 with the full hour remaining: long past the latest start - but a
	// fresh plan means the CLOUD alone plans (rule 2).
	now := time.Date(2026, 6, 15, 23, 30, 0, 0, loc)
	v := decideAt(t, r, now, Input{PlanFresh: true, ProgressKnown: true})
	if v.Active || v.Reason != ReasonPlanFresh {
		t.Fatalf("fresh plan must silence the fallback: %+v", v)
	}
}

func TestDecideRefusesOnUnknownProgress(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	now := time.Date(2026, 6, 15, 23, 30, 0, 0, loc)
	v := decideAt(t, r, now, Input{PlanFresh: false, ProgressKnown: false})
	if v.Active || v.Reason != ReasonProgressUnknown {
		t.Fatalf("unknown progress must refuse (never a fabricated run): %+v", v)
	}
}

func TestDecideWaitsUntilTheLatestStart(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	// Noon, whole hour remaining: latest start is 22:45 (24:00 - 60min - 15min).
	v := decideAt(t, r, time.Date(2026, 6, 15, 12, 0, 0, 0, loc),
		Input{ProgressKnown: true})
	if v.Active || v.Reason != ReasonNotYetDue {
		t.Fatalf("noon must not start (Notnagel, kein zweiter Optimierer): %+v", v)
	}
	if want := time.Date(2026, 6, 15, 22, 45, 0, 0, loc); !v.LatestStart.Equal(want) {
		t.Fatalf("latest start = %v, want %v", v.LatestStart, want)
	}
	// One second past the latest start: active.
	v = decideAt(t, r, time.Date(2026, 6, 15, 22, 45, 1, 0, loc),
		Input{ProgressKnown: true})
	if !v.Active || v.Reason != ReasonRun {
		t.Fatalf("past latest start must run: %+v", v)
	}
}

func TestDecideAccountsConfirmedProgressIntoTheTrigger(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	// 40 of 60 minutes confirmed: latest start moves to 23:25.
	p := Progress{RuntimeSeconds: 2400}
	v := decideAt(t, r, time.Date(2026, 6, 15, 23, 0, 0, 0, loc),
		Input{ProgressKnown: true, Progress: p})
	if v.Active || v.Reason != ReasonNotYetDue {
		t.Fatalf("23:00 with 20 min left must wait until 23:25: %+v", v)
	}
	v = decideAt(t, r, time.Date(2026, 6, 15, 23, 26, 0, 0, loc),
		Input{ProgressKnown: true, Progress: p})
	if !v.Active {
		t.Fatalf("23:26 with 20 min left must run: %+v", v)
	}
}

func TestDecideEndsOnFulfilmentAndAtTheDeadline(t *testing.T) {
	r := pumpReq(t)
	loc := berlin(t)
	v := decideAt(t, r, time.Date(2026, 6, 15, 23, 30, 0, 0, loc),
		Input{ProgressKnown: true, Progress: Progress{RuntimeSeconds: 3600}})
	if v.Active || v.Reason != ReasonFulfilled {
		t.Fatalf("fulfilled duty must not run: %+v", v)
	}
	// Past the deadline the window is over - the duty is honestly missed,
	// never run outside its window.
	nextDayReq, err := ParseRequirement(entities.FlexRequirement{
		ID: "morning", Days: "daily", From: "06:00", To: "08:00",
		RuntimeMinutes: fp(30), PowerKw: 2, Command: entities.CmdOnOff,
	})
	if err != nil {
		t.Fatal(err)
	}
	v = decideAt(t, nextDayReq, time.Date(2026, 6, 15, 8, 0, 1, 0, loc),
		Input{ProgressKnown: true})
	if v.Active || v.Reason != ReasonOutsideWindow {
		t.Fatalf("past the deadline must be outside the window: %+v", v)
	}
}

func TestCommandsFollowTheResolvedCloudTruth(t *testing.T) {
	r := pumpReq(t)
	c := r.Commands()
	if c.OnOff == nil || !*c.OnOff || c.SetpointKw != nil {
		t.Fatalf("on_off requirement must wish on_off true: %+v", c)
	}
	sp, err := ParseRequirement(entities.FlexRequirement{
		ID: "charge", Days: "daily", From: "00:00", To: "24:00",
		EnergyKwh: fp(8), PowerKw: 4.2, Command: entities.CmdSetpointKw,
	})
	if err != nil {
		t.Fatal(err)
	}
	c = sp.Commands()
	if c.SetpointKw == nil || *c.SetpointKw != 4.2 || c.OnOff != nil {
		t.Fatalf("setpoint requirement must wish the resolved power: %+v", c)
	}
}

// --- confirmed-progress tracker ---------------------------------------------

func TestTrackerAccruesOnlyEvidencedRuntime(t *testing.T) {
	tr := &Tracker{}
	tr.Roll("pump@2026-06-15")
	base := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	th := RunThresholdKw(2.2) // 0.22 kW

	tr.Observe(base, 2.2, th)
	tr.Observe(base.Add(60*time.Second), 2.2, th) // 60 s at 2.2 kW accrued
	tr.Observe(base.Add(120*time.Second), 0, th)  // 60 s more (hold-last on 2.2)
	tr.Observe(base.Add(180*time.Second), 0, th)  // previous sample 0: nothing
	if got := tr.Progress.RuntimeSeconds; got != 120 {
		t.Fatalf("runtime = %v, want 120", got)
	}
	wantKwh := 2.2 * 120 / 3600
	if diff := math.Abs(tr.Progress.EnergyKwh - wantKwh); diff > 1e-9 {
		t.Fatalf("energy = %v, want %v", tr.Progress.EnergyKwh, wantKwh)
	}
}

func TestTrackerNeverExtrapolatesAcrossAGap(t *testing.T) {
	tr := &Tracker{}
	tr.Roll("pump@2026-06-15")
	base := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	th := RunThresholdKw(2.2)
	tr.Observe(base, 2.2, th)
	// A 20-minute silence is NO evidence the pump ran - nothing accrues.
	tr.Observe(base.Add(20*time.Minute), 2.2, th)
	if tr.Progress.RuntimeSeconds != 0 {
		t.Fatalf("a gap beyond MaxSampleGap must accrue nothing, got %v",
			tr.Progress.RuntimeSeconds)
	}
	// Standby draw below the run threshold never accrues a duty.
	tr2 := &Tracker{}
	tr2.Roll("k")
	tr2.Observe(base, 0.1, th)
	tr2.Observe(base.Add(time.Minute), 0.1, th)
	if tr2.Progress.RuntimeSeconds != 0 {
		t.Fatalf("standby draw accrued runtime: %v", tr2.Progress.RuntimeSeconds)
	}
}

func TestTrackerRollsToANewInstance(t *testing.T) {
	tr := &Tracker{}
	tr.Roll("pump@2026-06-15")
	base := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	th := RunThresholdKw(2.2)
	tr.Observe(base, 2.2, th)
	tr.Observe(base.Add(time.Minute), 2.2, th)
	if tr.Progress.RuntimeSeconds == 0 {
		t.Fatal("no accrual before roll")
	}
	tr.Roll("pump@2026-06-16")
	if tr.Progress.RuntimeSeconds != 0 || tr.HasLast {
		t.Fatalf("a new instance is a new duty: %+v", tr)
	}
	tr.Roll("pump@2026-06-16") // same key: no-op
}

func TestTrackerSurvivesAJSONRoundTrip(t *testing.T) {
	// The reboot bridge: what the agent persists must restore bit-true enough
	// to continue accrual (flexfallback.json).
	tr := &Tracker{}
	tr.Roll("pump@2026-06-15")
	base := time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC)
	th := RunThresholdKw(2.2)
	tr.Observe(base, 2.2, th)
	tr.Observe(base.Add(time.Minute), 2.2, th)

	dir := t.TempDir()
	path := filepath.Join(dir, "flex.json")
	raw, err := json.Marshal(tr)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	restored := &Tracker{}
	raw2, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw2, restored); err != nil {
		t.Fatal(err)
	}
	if restored.InstanceKey != tr.InstanceKey ||
		restored.Progress.RuntimeSeconds != tr.Progress.RuntimeSeconds {
		t.Fatalf("round trip lost progress: %+v vs %+v", restored, tr)
	}
	// Accrual continues seamlessly on the restored tracker.
	restored.Observe(base.Add(2*time.Minute), 0, th)
	if restored.Progress.RuntimeSeconds != 120 {
		t.Fatalf("restored tracker did not continue: %v", restored.Progress.RuntimeSeconds)
	}
}

func TestRunThresholdHasAFloor(t *testing.T) {
	if got := RunThresholdKw(0.2); got != 0.05 {
		t.Fatalf("floor = %v", got)
	}
	if got := RunThresholdKw(11); math.Abs(got-1.1) > 1e-9 {
		t.Fatalf("relative threshold = %v", got)
	}
}
