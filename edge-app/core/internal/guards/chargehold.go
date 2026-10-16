// Charge hold against a surplus consumer: the local half of NS-3 B ("der
// Speicher hat Vorrang vor dem Überschuss-Verbraucher", Captain decision
// 2026-10-15, report vp-herzogau-nie-schlechter-k5 §3 and §7.2 candidate g).
//
// The live case (Anlage Herzogau, 12.-14.10.2026): a large consumer in steps
// of ~12 kW that regulates the connection point to zero export by itself and
// takes every surplus the battery does not already hold. In a slot that
// charges with charge_from_surplus_only the box trimmed the charge to the
// measured surplus pv - load (slottrim.go) and the damper aimed ReserveKw below
// it (followdamper.go). The consumer took those 0,5 kW, the surplus shrank by
// them, the trim followed at once - and a release needs 90 s of surplus ABOVE
// the command, which the consumer never leaves. The charge ratcheted down:
// 12.10. 14-15 Uhr from ~25 to ~1 kW as the consumer went to 30-34 kW, 14.10.
// 15:00-16:30 ~1 kW, and 22 kW within two minutes once the consumer was off.
// Two controllers on the same meter, and the box always yielded first.
//
// THE SPLIT IS THE POINT, as with the trim: the CLOUD detects the consumer and
// computes the planned charge against the base load without it
// (services/optimization ueberschuss_verbraucher.py), and hands the edge that
// base load as the per-slot contract field charge_hold_base_load_kw. The edge
// only enforces it against measured values:
//
//   - THE BOUND. While the hold is in force the trim and the damper see the
//     house load as min(load, base): the measured load ABOVE the base load is
//     the consumer's share and no longer lowers the planned charge. The charge
//     then stands, the consumer meets an import and steps down - it gets what
//     remains after the charge. A load below the base is the real load, so a
//     cloud passing through still trims at once.
//   - THE IMPORT GUARD (no grid charging). Holding the charge against a load
//     that does NOT yield would buy the charge from the grid. So the connection
//     point is watched on the LIVE grid value: an import beyond the base-load
//     coverage max(base - pv, 0) plus HoldImportMarginKw that stands without a
//     break for HoldYieldDwell means the load above the base did not yield. The
//     hold then raises its base to the load it measures at that moment (less
//     the base-load coverage), so the trim bounds the charge by pv - load again
//     and takes the import back on the same tick; for the rest of the slot only
//     a load that grows BEYOND that level is held against. A consumer that steps
//     down inside the dwell never costs more than its own reaction time of
//     import, a load that never yields at most one dwell per slot.
//
// Safety posture:
//
//   - It never RAISES anything and never commands a value. It only changes the
//     load the restrict-only trim and the damper bound a charge against, and
//     the bound stays inside [0, planned]: the trim still only lowers, so the
//     rated band, the SoC window, the BMS envelope, the EEG solar-only clamp
//     (charge <= measured PV production) and §14a, which Clamp applied to the
//     command, hold as before - pv - base never exceeds pv.
//   - Charge only, plan only: a discharge, a rest slot, a non-plan holder, a
//     stale plan or a slot without the field releases it (the caller passes
//     hold=false), and every guard after the in-slot corrections - the peak
//     guard, the cars-first cap, the Bezugswächter and the feed-in watchdog -
//     acts on the result unchanged.
//   - It never regulates blind: unknown pv or load releases it, and the import
//     guard only counts a fresh grid measurement (a stale one stops the clock,
//     it never extends a hold on its own).
package guards

import (
	"math"
	"sync"
	"time"
)

const (
	// HoldImportMarginKw is how far the connection point may import beyond the
	// base-load coverage before the import guard's clock runs - above meter
	// noise and the damper's own deadband.
	HoldImportMarginKw = 0.3
	// HoldYieldDwell is how long a load above the base load gets to yield
	// before the hold concludes it does not: one switching step of a staged
	// consumer (Einschalt-/Ausschaltverzug of seconds to tens of seconds), a
	// Messtakt and a tick, with room to spare. Its cost is bounded: at most this
	// long of import per slot for a load that never yields.
	HoldYieldDwell = 60 * time.Second
)

// ChargeHoldResult is one evaluation of the hold.
type ChargeHoldResult struct {
	// Active is true while the hold is in force on this tick: the slot carries
	// it, the command charges and the reading is known.
	Active bool
	// PlanBaseLoadKw is the base load the plan sent.
	PlanBaseLoadKw float64
	// BaseLoadKw is the base load in force: the plan's value, raised to the
	// measured load once a load above it did not yield this slot.
	BaseLoadKw float64
	// ConsumerKw is the measured load above BaseLoadKw - the share that no
	// longer bounds the charge (0 when none).
	ConsumerKw float64
	// Reading is the control reading the trim and the damper act on: the input
	// reading with LoadKw = min(load, BaseLoadKw) while Active, else unchanged.
	Reading Reading
}

// ChargeHolder holds the import guard's clock and the base raised in the
// running slot. Concurrency-safe like its siblings (the setpoint path is
// reachable from the tick loop, the schedule handler and the web API).
type ChargeHolder struct {
	mu          sync.Mutex
	slot        time.Time
	extraKw     float64
	importSince time.Time
}

// NewChargeHolder returns a released holder.
func NewChargeHolder() *ChargeHolder { return &ChargeHolder{} }

// Apply evaluates the hold for this tick.
//
// hold is the caller's authorization (the plan slot's charge_hold_base_load_kw
// together with its trim duty, inside the market-corrections boundary),
// baseLoadKw the field's value, kw the command entering the in-slot
// corrections. live is the live reading (its pv pairs with the live grid value
// gridKw, + import / - export, which only counts when gridFresh); ctl is the
// control reading the corrections act on (the damper's settled pair).
func (h *ChargeHolder) Apply(
	now, slotStart time.Time,
	kw, baseLoadKw float64,
	hold bool,
	live, ctl Reading,
	gridKw float64,
	gridFresh bool,
) ChargeHoldResult {
	res := ChargeHoldResult{Reading: ctl}
	if !hold || !finite(kw) || kw <= 0 || !finite(baseLoadKw) || baseLoadKw < 0 ||
		!known(ctl.PvKw) || !known(ctl.LoadKw) {
		h.Release()
		return res
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if !slotStart.Equal(h.slot) {
		h.slot, h.extraKw, h.importSince = slotStart, 0, time.Time{}
	}

	// The import guard on the connection point: beyond the base-load coverage,
	// standing for the dwell, the load above the base did not yield - the base
	// is raised to the load measured now (less that coverage), which is where
	// the trim of before would have bounded the charge.
	if gridFresh && finite(gridKw) && known(live.PvKw) {
		allowed := math.Max(baseLoadKw+h.extraKw-live.PvKw, 0)
		switch excess := gridKw - allowed; {
		case excess <= HoldImportMarginKw:
			h.importSince = time.Time{}
		case h.importSince.IsZero():
			h.importSince = now
		case now.Sub(h.importSince) >= HoldYieldDwell:
			h.extraKw = math.Max(h.extraKw, ctl.LoadKw-allowed-baseLoadKw)
			h.importSince = now // an import that still stands gets its own dwell
		}
	} else {
		h.importSince = time.Time{}
	}

	base := baseLoadKw + h.extraKw
	res.Active = true
	res.PlanBaseLoadKw = baseLoadKw
	res.BaseLoadKw = math.Round(base*1000) / 1000
	res.ConsumerKw = math.Round(math.Max(ctl.LoadKw-base, 0)*1000) / 1000
	if ctl.LoadKw > base {
		res.Reading.LoadKw = base
	}
	return res
}

// Release lets the hold go (a slot without it, a discharge, the setpoint
// path's early exits): the raised base and the clock are facts about one slot
// and one consumer, so nothing is carried across.
func (h *ChargeHolder) Release() {
	h.mu.Lock()
	h.slot, h.extraKw, h.importSince = time.Time{}, 0, time.Time{}
	h.mu.Unlock()
}
