// Peak guard (PS-3, Lastspitzenkappung): the edge-local closed loop that
// defends the plan-carried billing-period peak target (grid_import_limit_kw).
//
// The RLM billing peak is the highest 15-min MEAN grid import of the billing
// period (wall-clock quarter hours :00/:15/:30/:45). The cloud MPC plans peaks
// on forecasts every 15 min; a stochastic load jump at :07 can only be caught
// ON the device, inside the running quarter hour - which is exactly what this
// guard does: track the running quarter's mean import from measured telemetry
// and, when the projected quarter mean threatens to exceed the target, lower
// the battery setpoint (reduce charge / raise discharge) so the mean holds.
//
// Safety posture: the guard is ECONOMIC, restrict-only and import-side only.
// It runs AFTER the compliance clamps (rated band, SoC, EEG solar-only, §14a)
// and may only ever LOWER the setpoint - never charge more, never violate the
// SoC floor or rated discharge, never touch export. Because it only lowers the
// setpoint toward a non-negative import target, it can never push the site
// into export and therefore never re-violates the §14a export bound; the §14a
// import bound was already applied to a value the guard only reduces further.
// Unknown measurements (no grid reading, stale tracker, unknown load/pv) make
// the guard INACTIVE - it never regulates blind; a missed quarter only costs
// money (Leistungspreis), never safety.
package guards

import (
	"math"
	"sync"
	"time"
)

// peakQuarter is the RLM billing interval. Quarter boundaries are computed
// with Truncate on the absolute timeline, which coincides with the Europe/
// Berlin wall-clock :00/:15/:30/:45 grid because Berlin's UTC offset (+1/+2 h)
// is a whole multiple of 15 min - no timezone database needed on the device.
const peakQuarter = 15 * time.Minute

// peakGapReset bounds how old the last grid sample may be before the tracker
// refuses to project (regulating blind) and re-baselines on the next sample.
// Telemetry cadence is seconds; two minutes absorbs any realistic hiccup.
const peakGapReset = 2 * time.Minute

// PeakTracker maintains the running quarter hour's mean grid IMPORT from the
// measured site grid power (power_kw, + = import). Import only: an RLM meter
// registers energy per direction (1.8.0), so export in the same quarter never
// offsets import - negative samples count as zero. Concurrency-safe (fed from
// the telemetry path, read from the setpoint path).
type PeakTracker struct {
	mu           sync.Mutex
	seen         bool
	quarterStart time.Time // start of the quarter being integrated
	cursor       time.Time // integrated up to here
	integral     float64   // import kW·s accumulated over [quarterStart, cursor]
	lastImportKw float64   // import held forward from cursor (hold-last)
}

// NewPeakTracker returns an empty tracker (inactive until the first sample).
func NewPeakTracker() *PeakTracker { return &PeakTracker{} }

func quarterStartOf(t time.Time) time.Time { return t.Truncate(peakQuarter) }

// Add feeds one measured site grid sample (signed kW, + = import) observed at
// ts. Non-finite values are ignored. After a gap beyond peakGapReset the
// tracker re-baselines: the unobserved head of the quarter is backfilled at
// the new sample's value (hold semantics, symmetric with the projection) - a
// reboot mid-quarter converges within a couple of samples and errs toward
// defending slightly more, never toward silently allowing more import.
func (t *PeakTracker) Add(ts time.Time, gridKw float64) {
	if math.IsNaN(gridKw) || math.IsInf(gridKw, 0) {
		return
	}
	importKw := math.Max(gridKw, 0)
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.seen || ts.Before(t.quarterStart) || ts.Sub(t.cursor) > peakGapReset {
		qs := quarterStartOf(ts)
		t.seen = true
		t.quarterStart = qs
		t.integral = importKw * ts.Sub(qs).Seconds()
		t.cursor = ts
		t.lastImportKw = importKw
		return
	}
	if !ts.After(t.cursor) {
		// Same-instant / out-of-order sample: just refresh the held value.
		t.lastImportKw = importKw
		return
	}
	t.quarterStart, t.integral, t.cursor = advanceQuarter(t.quarterStart, t.integral, t.cursor, t.lastImportKw, ts)
	t.lastImportKw = importKw
}

// advanceQuarter integrates heldKw from cursor to "to", rolling over quarter
// boundaries (each new quarter starts with an empty integral).
func advanceQuarter(quarterStart time.Time, integral float64, cursor time.Time, heldKw float64, to time.Time) (time.Time, float64, time.Time) {
	for cursor.Before(to) {
		boundary := quarterStart.Add(peakQuarter)
		step := to
		if boundary.Before(step) {
			step = boundary
		}
		integral += heldKw * step.Sub(cursor).Seconds()
		cursor = step
		if !cursor.Before(boundary) {
			// Reached the boundary: the next quarter begins (empty integral) -
			// also when it lands exactly on "to", so a projection at :15 sharp
			// already answers for the fresh quarter.
			quarterStart = boundary
			integral = 0
		}
	}
	return quarterStart, integral, cursor
}

// project rolls the tracker state forward to now (read-only) and returns the
// current quarter's start and accumulated import. ok=false when the tracker
// has never seen a sample or the last sample is older than peakGapReset - the
// guard must then stay inactive (never regulate blind).
func (t *PeakTracker) project(now time.Time) (quarterStart time.Time, integral float64, heldKw float64, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.seen {
		return time.Time{}, 0, 0, false
	}
	if now.Before(t.cursor) {
		now = t.cursor // minor clock skew: answer for the integrated state
	}
	if now.Sub(t.cursor) > peakGapReset {
		return time.Time{}, 0, 0, false
	}
	qs, in, _ := advanceQuarter(t.quarterStart, t.integral, t.cursor, t.lastImportKw, now)
	return qs, in, t.lastImportKw, true
}

// AllowedImport returns the grid import (kW) the site may average over the
// REST of the running quarter so that the quarter's 15-min mean stays at or
// below limitKw. Already-overrun budget floors the answer at 0 (accrued import
// cannot be undone; the guard then drives import toward zero for the rest of
// the quarter). ok=false = tracker inactive (no/stale grid measurement).
func (t *PeakTracker) AllowedImport(now time.Time, limitKw float64) (float64, bool) {
	if math.IsNaN(limitKw) || math.IsInf(limitKw, 0) || limitKw < 0 {
		return 0, false
	}
	qs, integral, _, ok := t.project(now)
	if !ok {
		return 0, false
	}
	remaining := qs.Add(peakQuarter).Sub(now).Seconds()
	if remaining < 1 {
		remaining = 1 // boundary edge: avoid a division blow-up
	}
	budget := limitKw*peakQuarter.Seconds() - integral
	allowed := budget / remaining
	if allowed < 0 {
		allowed = 0
	}
	return allowed, true
}

// QuarterMean returns the running quarter's mean import so far (kW) for the
// local "Betrieb" card. Right at the quarter start (nothing integrated yet)
// it reports the held sample value. ok=false = tracker inactive.
func (t *PeakTracker) QuarterMean(now time.Time) (float64, bool) {
	qs, integral, held, ok := t.project(now)
	if !ok {
		return 0, false
	}
	elapsed := now.Sub(qs).Seconds()
	if elapsed < 1 {
		return held, true
	}
	return integral / elapsed, true
}

// PeakShave lowers an already guard-clamped setpoint so the predicted grid
// import (load + battery - pv) stays within allowedImportKw - the PS-3 peak
// guard's correction, structurally the §14a import correction with a
// tracker-derived limit. Restrict-only and bounded:
//
//   - it only ever LOWERS kw (reduce charge / raise discharge), never raises it,
//   - raised discharge respects the rated discharge and the SoC floor (at/below
//     SocMinPct it will reduce charge to 0 but never discharge),
//   - unknown load or pv leaves kw untouched (never regulate blind),
//   - the corrected import equals allowedImportKw >= 0, so the site is never
//     pushed into export - the §14a export bound cannot be re-violated, and the
//     §14a import bound was applied to a value this only reduces further.
func PeakShave(kw, allowedImportKw float64, l Limits, r Reading) float64 {
	if !known(r.LoadKw) || !known(r.PvKw) {
		return kw
	}
	if math.IsNaN(allowedImportKw) || allowedImportKw < 0 {
		allowedImportKw = 0
	}
	predicted := r.LoadKw + kw - r.PvKw
	if predicted <= allowedImportKw {
		return kw
	}
	target := allowedImportKw - r.LoadKw + r.PvKw
	floor := -l.MaxDischargeKw
	if known(r.SocPct) && r.SocPct <= l.SocMinPct {
		floor = 0
	}
	if target < floor {
		target = floor
	}
	if target >= kw {
		return kw // never raise the setpoint
	}
	return math.Round(target*1000) / 1000
}
