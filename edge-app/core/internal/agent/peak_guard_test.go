package agent

// PS-3 peak-guard composition through applySetpoint: the offline fallback
// holds the plan-carried peak reserve for ordinary load, peak DEFENSE may
// discharge below the reserve, schedule-mode setpoints are shaved against the
// forming quarter-hour import mean, no-fields plans behave byte-for-byte like
// before, and an unfed tracker (no grid measurement) leaves the guard
// honestly inactive. The telemetry plumbing (onLocalTelemetry -> tracker) is
// proven against the real ingest path.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// peakBase is a fixed quarter boundary (also a Europe/Berlin wall-clock
// quarter) all peak tests anchor their times to.
func peakBase() time.Time { return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC) }

// stalePeakPlan builds a plan far beyond the 20-min staleness window whose
// last version carried the PS-1/PS-2 peak fields (nil = module off).
func stalePeakPlan(now time.Time, target, reserve *float64) *plan.Plan {
	return &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now.Add(-2 * time.Hour),
		Slots:             []plan.Slot{{Start: now.Add(-2 * time.Hour), BatterySetpointKw: 0}},
		GridImportLimitKw: target,
		PeakReserveSocPct: reserve,
	}
}

// feedTrackerSteady feeds the agent's peak tracker a steady grid import at
// per-minute cadence from "from" for the given number of minutes.
func feedTrackerSteady(a *Agent, from time.Time, minutes int, kw float64) {
	for m := 0; m <= minutes; m++ {
		a.peak.Add(from.Add(time.Duration(m)*time.Minute), kw)
	}
}

func newPeakAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	return a
}

func TestFallbackHoldsPeakReserveForOrdinaryLoad(t *testing.T) {
	a := newPeakAgent(t)
	now := peakBase().Add(5 * time.Minute)
	a.mu.Lock()
	a.currentPlan = stalePeakPlan(now, fptr(60), fptr(25))
	// SoC 20 <= reserve 25; load 30 > pv 0: the OLD fallback would discharge
	// 30 kW of ordinary load out of the reserve.
	a.lastReading = guards.Reading{SocPct: 20, PvKw: 0, LoadKw: 30, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	// Import comfortably below the target: no peak defense needed either.
	feedTrackerSteady(a, peakBase(), 5, 30)

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != 0 {
		t.Fatalf("reserve floor: setpoint = %v, want 0 (ordinary discharge stops at the reserve)", snap.SetpointKw)
	}
	if snap.Mode != state.ModeSelfConsume {
		t.Fatalf("mode = %v, want eigenverbrauch", snap.Mode)
	}
	if snap.PeakTargetKw == nil || *snap.PeakTargetKw != 60 {
		t.Fatalf("snapshot peak target = %v, want 60", snap.PeakTargetKw)
	}
	if snap.PeakReserveSocPct == nil || *snap.PeakReserveSocPct != 25 {
		t.Fatalf("snapshot reserve = %v, want 25", snap.PeakReserveSocPct)
	}
	if !snap.PeakGuardActive {
		t.Fatal("guard must report active (target known + fresh grid measurement)")
	}
	if snap.PeakQuarterMeanKw == nil || *snap.PeakQuarterMeanKw != 30 {
		t.Fatalf("quarter mean = %v, want 30", snap.PeakQuarterMeanKw)
	}

	// ABOVE the reserve, ordinary self-consumption discharges as always.
	a.mu.Lock()
	a.lastReading.SocPct = 40
	a.mu.Unlock()
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got != -30 {
		t.Fatalf("above reserve: setpoint = %v, want -30 (normal self-consumption)", got)
	}
}

func TestPeakDefenseDischargesBelowTheReserve(t *testing.T) {
	a := newPeakAgent(t)
	now := peakBase().Add(5 * time.Minute)
	a.mu.Lock()
	a.currentPlan = stalePeakPlan(now, fptr(60), fptr(25))
	// SoC 20 <= reserve 25 (ordinary discharge floored), but the quarter runs
	// hot: 90 kW for 5 min against target 60 -> allowed import for the rest is
	// (60*900 - 90*300)/600 = 45 kW. Load 100 threatens the mean -> the guard
	// discharges FOR THE PEAK, below the reserve, bounded by rated power.
	a.lastReading = guards.Reading{SocPct: 20, PvKw: 0, LoadKw: 100, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	feedTrackerSteady(a, peakBase(), 5, 90)

	a.applySetpoint(now)

	// Correction wants 45-100 = -55; rated discharge (defaults) caps at -50.
	if got := a.State.Get().SetpointKw; got != -50 {
		t.Fatalf("peak defense: setpoint = %v, want -50 (discharge below reserve, rated-capped)", got)
	}

	// At the technical SoC floor even peak defense stops (never below SocMin).
	a.mu.Lock()
	a.lastReading.SocPct = a.Cfg.SocMinPct
	a.mu.Unlock()
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got != 0 {
		t.Fatalf("at SocMin peak defense must not discharge: setpoint = %v, want 0", got)
	}
}

func TestFallbackWithoutPeakFieldsIsLegacyBehavior(t *testing.T) {
	a := newPeakAgent(t)
	now := peakBase().Add(5 * time.Minute)
	a.mu.Lock()
	a.currentPlan = stalePeakPlan(now, nil, nil) // no plan ever carried the fields
	// SoC 10 would sit below any typical reserve; load > pv.
	a.lastReading = guards.Reading{SocPct: 10, PvKw: 0, LoadKw: 30, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	feedTrackerSteady(a, peakBase(), 5, 90) // a fed tracker alone must change nothing

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != -30 {
		t.Fatalf("legacy fallback: setpoint = %v, want -30 (plain self-consumption)", snap.SetpointKw)
	}
	if snap.PeakTargetKw != nil || snap.PeakReserveSocPct != nil || snap.PeakGuardActive || snap.PeakQuarterMeanKw != nil {
		t.Fatalf("module off must expose no peak state: %+v", snap)
	}
}

func TestScheduleSetpointIsShavedAgainstTheQuarterMean(t *testing.T) {
	a := newPeakAgent(t)
	now := peakBase().Add(5 * time.Minute)
	allowed := true
	target := 60.0
	reserve := 25.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes:       15,
		ReceivedAt:        now,
		GridChargeAllowed: &allowed, // merchant plan: the charge is visible
		GridImportLimitKw: &target,
		PeakReserveSocPct: &reserve,
		Slots:             []plan.Slot{{Start: now.Add(-1 * time.Minute), BatterySetpointKw: 20}},
	}
	// Load 50, pv 0: the planned 20-kW charge would import 70 while the
	// quarter (90 kW for 5 min) only allows 45 for the rest -> shave to -5.
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 0, LoadKw: 50, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	feedTrackerSteady(a, peakBase(), 5, 90)

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.Mode != state.ModeSchedule {
		t.Fatalf("mode = %v, want fahrplan", snap.Mode)
	}
	if snap.SetpointKw != -5 {
		t.Fatalf("shaved schedule setpoint = %v, want -5", snap.SetpointKw)
	}
	if !snap.PeakGuardActive {
		t.Fatal("guard must be active in schedule mode too")
	}

	// The reserve floor is a FALLBACK composition only: a fresh plan's own
	// discharge below the reserve executes unchanged (the cloud already plans
	// with its reservation stack; below-floor starts are legitimately relaxed).
	a.mu.Lock()
	a.currentPlan.Slots[0].BatterySetpointKw = -10
	a.lastReading = guards.Reading{SocPct: 20, PvKw: 0, LoadKw: 10, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got != -10 {
		t.Fatalf("fresh-plan discharge below reserve = %v, want -10 (no fallback floor)", got)
	}
}

func TestUnknownGridMeasurementLeavesGuardInactive(t *testing.T) {
	a := newPeakAgent(t)
	now := peakBase().Add(5 * time.Minute)
	a.mu.Lock()
	a.currentPlan = stalePeakPlan(now, fptr(60), nil)
	a.lastReading = guards.Reading{SocPct: 50, PvKw: 0, LoadKw: 100, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	// Tracker never fed: no grid measurement -> never regulate blind.

	a.applySetpoint(now)

	snap := a.State.Get()
	if snap.SetpointKw != -50 {
		t.Fatalf("setpoint = %v, want -50 (plain self-consumption, rated-capped)", snap.SetpointKw)
	}
	if snap.PeakGuardActive {
		t.Fatal("guard must be inactive without a grid measurement")
	}
	if snap.PeakTargetKw == nil || *snap.PeakTargetKw != 60 {
		t.Fatalf("target must still be exposed for the UI: %v", snap.PeakTargetKw)
	}
	if snap.PeakQuarterMeanKw != nil {
		t.Fatalf("no measurement -> no mean, got %v", snap.PeakQuarterMeanKw)
	}
}

func TestLocalTelemetryFeedsThePeakTracker(t *testing.T) {
	a := newGateTestAgent(t)
	ts := peakBase().Add(2 * time.Minute)
	payload := fmt.Sprintf(`{"ts":%q,"power_kw":42.0,"soc_pct":55}`, ts.Format(time.RFC3339))
	a.onLocalTelemetry("edge/telemetry", []byte(payload))

	mean, ok := a.peak.QuarterMean(ts)
	if !ok {
		t.Fatal("onLocalTelemetry must feed the peak tracker")
	}
	if mean != 42 {
		t.Fatalf("tracked mean = %v, want 42", mean)
	}
	// A sample WITHOUT power_kw feeds nothing (the tracker would go stale and
	// the guard inactive rather than holding a fabricated grid value).
	ts2 := ts.Add(10 * time.Minute)
	a.onLocalTelemetry("edge/telemetry", []byte(fmt.Sprintf(`{"ts":%q,"soc_pct":56}`, ts2.Format(time.RFC3339))))
	if _, ok := a.peak.QuarterMean(ts2); ok {
		t.Fatal("tracker must be stale after 10 min without a grid sample")
	}
}
