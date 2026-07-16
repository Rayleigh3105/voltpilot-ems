package guards

// PS-3 peak-guard units: the quarter-hour import-mean tracker (boundary
// alignment, gap reset, projection math) and the PeakShave correction
// (raise-discharge math, compliance ordering, never-regulate-blind).

import (
	"math"
	"testing"
	"time"
)

// q returns a fixed quarter boundary to build test times from (12:00:00 UTC -
// also a Europe/Berlin wall-clock quarter, the billing grid).
func q() time.Time {
	return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
}

// feed adds kw once per minute over [fromMin, toMin] (inclusive), the realistic
// seconds-to-minutes telemetry cadence the tracker's gap window expects.
func feedGrid(tr *PeakTracker, fromMin, toMin int, kw float64) {
	for m := fromMin; m <= toMin; m++ {
		tr.Add(q().Add(time.Duration(m)*time.Minute), kw)
	}
}

func TestPeakTrackerInactiveWithoutSamples(t *testing.T) {
	tr := NewPeakTracker()
	if _, ok := tr.AllowedImport(q(), 60); ok {
		t.Fatal("tracker with no samples must be inactive (never regulate blind)")
	}
	if _, ok := tr.QuarterMean(q()); ok {
		t.Fatal("quarter mean must be unavailable without samples")
	}
}

func TestPeakTrackerMeanWithinQuarter(t *testing.T) {
	tr := NewPeakTracker()
	// 40 kW over the first 5 minutes, then 80 kW for 5 minutes (fed at the
	// realistic per-minute cadence; hold-last integrates between samples).
	feedGrid(tr, 0, 4, 40)
	feedGrid(tr, 5, 10, 80)
	mean, ok := tr.QuarterMean(q().Add(10 * time.Minute))
	if !ok {
		t.Fatal("tracker must be active")
	}
	// [0,5) at 40, [5,10) at 80 -> mean over 10 min = 60.
	if math.Abs(mean-60) > 1e-9 {
		t.Fatalf("quarter mean = %v, want 60", mean)
	}
}

func TestPeakTrackerBackfillsQuarterHeadOnFirstSample(t *testing.T) {
	tr := NewPeakTracker()
	// First sample arrives mid-quarter: the unobserved head counts at the
	// sample's value (hold semantics), so the mean equals that value.
	tr.Add(q().Add(7*time.Minute), 50)
	mean, ok := tr.QuarterMean(q().Add(8 * time.Minute))
	if !ok || math.Abs(mean-50) > 1e-9 {
		t.Fatalf("backfilled mean = %v (ok=%v), want 50", mean, ok)
	}
}

func TestPeakTrackerQuarterBoundaryResetsTheMean(t *testing.T) {
	tr := NewPeakTracker()
	feedGrid(tr, 0, 15, 100)
	// One minute into the NEXT quarter: the old quarter's 100-kW history is
	// gone - the mean reflects only the fresh quarter (held 100 for its first
	// minute), never a blend with the previous 15 minutes.
	tr.Add(q().Add(16*time.Minute), 20)
	mean, ok := tr.QuarterMean(q().Add(16 * time.Minute))
	if !ok {
		t.Fatal("tracker must be active")
	}
	if math.Abs(mean-100) > 1e-9 {
		t.Fatalf("mean after boundary = %v, want 100 (fresh quarter only)", mean)
	}
	// After 5 more minutes at 20 kW: quarter is [15,21) = 1 min @100 + 5 min @20.
	feedGrid(tr, 17, 21, 20)
	mean, _ = tr.QuarterMean(q().Add(21 * time.Minute))
	want := (1*100.0 + 5*20.0) / 6.0
	if math.Abs(mean-want) > 1e-9 {
		t.Fatalf("mean 6 min into new quarter = %v, want %v", mean, want)
	}
}

func TestPeakTrackerProjectionAtExactBoundary(t *testing.T) {
	tr := NewPeakTracker()
	tr.Add(q().Add(14*time.Minute), 90)
	// At :15 sharp the new quarter begins: full budget again.
	allowed, ok := tr.AllowedImport(q().Add(15*time.Minute), 60)
	if !ok {
		t.Fatal("tracker must be active at the boundary")
	}
	if math.Abs(allowed-60) > 1e-6 {
		t.Fatalf("allowed at fresh quarter = %v, want 60", allowed)
	}
}

func TestPeakTrackerExportNeverOffsetsImport(t *testing.T) {
	tr := NewPeakTracker()
	// RLM meters register per direction: heavy export must count as 0 import,
	// never as negative energy that would hide later import.
	feedGrid(tr, 0, 4, -50)
	feedGrid(tr, 5, 10, 30)
	mean, ok := tr.QuarterMean(q().Add(10 * time.Minute))
	if !ok {
		t.Fatal("tracker must be active")
	}
	want := (5*0.0 + 5*30.0) / 10.0
	if math.Abs(mean-want) > 1e-9 {
		t.Fatalf("mean with export head = %v, want %v", mean, want)
	}
}

func TestPeakTrackerGapResetGoesInactiveThenRebaselines(t *testing.T) {
	tr := NewPeakTracker()
	tr.Add(q(), 40)
	// Stale measurement: a projection 3 minutes after the last sample must be
	// inactive (never regulate blind).
	if _, ok := tr.AllowedImport(q().Add(3*time.Minute), 60); ok {
		t.Fatal("projection beyond the gap window must be inactive")
	}
	// The next sample re-baselines (backfill-hold at the new value).
	tr.Add(q().Add(8*time.Minute), 70)
	mean, ok := tr.QuarterMean(q().Add(8 * time.Minute))
	if !ok || math.Abs(mean-70) > 1e-9 {
		t.Fatalf("rebaselined mean = %v (ok=%v), want 70", mean, ok)
	}
}

func TestPeakTrackerAllowedImportMath(t *testing.T) {
	tr := NewPeakTracker()
	// 90 kW for the first 5 minutes of the quarter, limit 60:
	// budget = 60*900 - 90*300 = 27000 kW·s over remaining 600 s -> 45 kW.
	feedGrid(tr, 0, 5, 90)
	allowed, ok := tr.AllowedImport(q().Add(5*time.Minute), 60)
	if !ok {
		t.Fatal("tracker must be active")
	}
	if math.Abs(allowed-45) > 1e-6 {
		t.Fatalf("allowed = %v, want 45", allowed)
	}
	// A quarter whose budget is already blown floors at 0 (accrued import
	// cannot be undone; drive import to zero for the rest).
	tr2 := NewPeakTracker()
	feedGrid(tr2, 0, 10, 200)
	allowed, ok = tr2.AllowedImport(q().Add(10*time.Minute), 60)
	if !ok || allowed != 0 {
		t.Fatalf("overrun budget: allowed = %v (ok=%v), want 0", allowed, ok)
	}
	// Banked budget grows the allowance late in the quarter (mean-correct).
	tr3 := NewPeakTracker()
	feedGrid(tr3, 0, 10, 0)
	allowed, _ = tr3.AllowedImport(q().Add(10*time.Minute), 60)
	if math.Abs(allowed-60*900/300) > 1e-6 {
		t.Fatalf("banked budget allowed = %v, want 180", allowed)
	}
}

func TestPeakTrackerInvalidLimitInactive(t *testing.T) {
	tr := NewPeakTracker()
	tr.Add(q(), 10)
	for _, lim := range []float64{math.NaN(), math.Inf(1), -1} {
		if _, ok := tr.AllowedImport(q().Add(time.Minute), lim); ok {
			t.Errorf("limit %v must leave the guard inactive", lim)
		}
	}
}

// --- PeakShave: the setpoint correction ---

func TestPeakShaveRaisesDischargeToHoldTheMean(t *testing.T) {
	// load 50, pv 0, idle battery -> predicted import 50 > allowed 30:
	// discharge 20 so import lands exactly on the allowance.
	r := reading(60, 0, 50, math.NaN())
	if got := PeakShave(0, 30, limits, r); got != -20 {
		t.Fatalf("PeakShave = %v, want -20", got)
	}
	// A commanded charge is reduced first: charge 10 -> predicted 60 -> target -20.
	if got := PeakShave(10, 30, limits, r); got != -20 {
		t.Fatalf("PeakShave from charge = %v, want -20", got)
	}
	// Within the allowance nothing changes.
	if got := PeakShave(0, 55, limits, r); got != 0 {
		t.Fatalf("within allowance must be untouched, got %v", got)
	}
}

func TestPeakShaveNeverRaisesTheSetpoint(t *testing.T) {
	// Already discharging harder than the correction would ask: keep it.
	r := reading(60, 0, 50, math.NaN())
	if got := PeakShave(-30, 30, limits, r); got != -30 {
		t.Fatalf("must never raise the setpoint, got %v", got)
	}
}

func TestPeakShaveRespectsRatedDischarge(t *testing.T) {
	// load 100, allowed 0 -> correction wants -100; rated discharge is 40.
	r := reading(60, 0, 100, math.NaN())
	if got := PeakShave(0, 0, limits, r); got != -40 {
		t.Fatalf("rated discharge cap: got %v, want -40", got)
	}
}

func TestPeakShaveRespectsSocFloor(t *testing.T) {
	// At/below the SoC floor the guard may reduce charge to 0 but never
	// discharge - an economic guard must not drain a protected battery.
	r := reading(5, 0, 50, math.NaN())
	if got := PeakShave(10, 0, limits, r); got != 0 {
		t.Fatalf("SoC floor: charge must reduce to 0, got %v", got)
	}
	if got := PeakShave(0, 0, limits, r); got != 0 {
		t.Fatalf("SoC floor: must not discharge, got %v", got)
	}
}

func TestPeakShaveUnknownReadingsInactive(t *testing.T) {
	// Unknown load or pv: never regulate blind.
	if got := PeakShave(10, 0, limits, Reading{SocPct: 50, PvKw: Unknown(), LoadKw: 20, GridLimitKw: Unknown()}); got != 10 {
		t.Fatalf("unknown pv must leave kw untouched, got %v", got)
	}
	if got := PeakShave(10, 0, limits, Reading{SocPct: 50, PvKw: 5, LoadKw: Unknown(), GridLimitKw: Unknown()}); got != 10 {
		t.Fatalf("unknown load must leave kw untouched, got %v", got)
	}
}

func TestPeakShaveNeverViolatesComplianceGuards(t *testing.T) {
	// Ordering proof: PeakShave runs on the Clamp result and only ever lowers
	// it toward a non-negative import, so §14a (both directions), the EEG
	// solar-only clamp and the rated band all survive.
	//
	// §14a import: limit 15 already capped the setpoint; the peak correction
	// only reduces further -> final import <= min(14a, allowed).
	r := reading(60, 0, 10, 15)
	kw := Clamp(20, limits, r) // -> 5 (import capped at 15)
	kw = PeakShave(kw, 3, limits, r)
	if imp := r.LoadKw + kw - r.PvKw; imp > 3+1e-9 {
		t.Fatalf("import %v exceeds peak allowance 3", imp)
	}
	// §14a export: the export absorption charged 15; peak correction with a
	// tight allowance reduces the charge, but the corrected import target is
	// >= 0, so the site never swings into export beyond the envelope.
	rExp := reading(50, 30, 0, 15)
	kw = Clamp(0, limits, rExp) // -> 15 (charge to keep export in envelope)
	got := PeakShave(kw, 60, limits, rExp)
	if got != 15 {
		t.Fatalf("no violation to correct: got %v, want 15", got)
	}
	// EEG solar-only: PeakShave only ever REDUCES charge, so charge <= pv holds.
	rEeg := reading(50, 15, 5, math.NaN())
	kw = Clamp(20, solarOnlyLimits, rEeg) // -> 15 (capped at produced pv)
	kw = PeakShave(kw, 0, solarOnlyLimits, rEeg)
	if kw > 15 {
		t.Fatalf("solar-only violated: %v > pv", kw)
	}
	// Rated band both ways.
	rBig := reading(60, 0, 500, math.NaN())
	kw = PeakShave(Clamp(0, limits, rBig), 0, limits, rBig)
	if kw < -limits.MaxDischargeKw {
		t.Fatalf("rated discharge escaped: %v", kw)
	}
}
