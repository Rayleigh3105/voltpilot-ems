package guards

// The grid-charge ceiling of the battery WITH A SHARE (UEMS AP-15 IP-19, rules
// V1, V3, V5, G1; concept vp-uems-ap15-verbund §3.6/§4.6, R3). The import-side
// twin of the discharge ceiling in exportanteil.go: the Bezugswaechter covers
// EVERYTHING the box controls, and the battery charging from the grid is the
// one consumer today's box never bounded by the connection limit (only by
// §14a and the plan).
//
//	role         fresh (<= 30 s) and a known limit   otherwise
//	fuehrt       loop: charge <= planable − rest,     no charge from the grid:
//	             rest = grid − measured charge +      charge <= own measured PV
//	             what the charge park was granted
//	             but does not draw yet
//	steuert_mit  -                                    the same - its share goes
//	(or none)                                         to the charge park
//
// and, wherever a charge park runs, never the PV the park already counted
// (see PV IS COUNTED ONCE below).
//
// "Nicht aus dem Netz" is the solar-only clamp of today (guards.Clamp stage 4):
// a charge no larger than the box's own measured PV adds nothing to the import
// at the connection point that the PV does not offset, so the worst case of R3
// stays 473 kW Vorbehalt + 77 kW Anteil + 0 kW = 550 kW. Without a usable PV
// reading that is 0 - grid-charging blind is exactly what V3 excludes.
//
// The charge park is served FIRST on a fresh loop: what it was granted but
// does not draw yet is taken off the battery's headroom, so the two loops
// against one connection limit never both spend the same kilowatts from one
// sample. The budget in turn sees the battery's measured charge as rest.
// That reservation only exists once the park has decided on the sample: the
// two run in different ticks (setpoint 10 s, OCPP pass 20 s), and after a
// blind state both were lowered and the first fresh sample shows one
// headroom (AP-15 Folge of PR 1055, agent/bezug_doppelfreigabe_test.go).
// Until the park has decided on a sample of the fresh stretch (ParkOffen),
// the battery releases nothing: it keeps at most its measured charge,
// whatever the order of the two ticks.
//
// PV IS COUNTED ONCE (AP-15 Folge of PR 1061): "at most the own PV" does not
// see the charge park, but the park's loop already counted a PV surplus at
// the meter as headroom (rest = meter − charging shrinks by it) - a battery
// that then takes "its" PV raises the import by exactly that PV. Wherever a
// charge park runs (Vorrang), the solar-only branch therefore becomes the
// same loop, the park first, capped by the PV - never above what it allowed
// before:
//
//	steuert_mit, fresh own meter   min(PV, share − rest), rest and ParkOffen
//	(or none)                      as above
//	blind, a sample known          min(PV, headroom − rest on the LAST sample),
//	(both roles)                   the park's current grant in rest
//	blind before the first sample  PV: the park stands on its blind figure,
//	                               which the solar-only rule was proven for
//
// Blind, the park's figure may still rest on the last sample - its fresh
// figure, which the leading box's budget holds (budget.go) or ramps down
// from - so the battery keeps to the loop on that sample: a blind controller
// releases nothing it did not measure. What the park's grant fell below its
// measured draw since (its blind figure lowered it) the loop credits, so the
// battery gets its PV back once the park stands where the blind rule holds
// (at a co-controlling box ungeregelt + reserve + (share − reserve −
// ungeregelt) + 0 = share).
//
// The ceiling only ever LOWERS a charge (LowerCharge): it never discharges,
// never raises a charge and never touches a discharge (the mirror of V6).
// Every rule above is a minimum with the solar-only clamp of before. Without
// a share document nothing here runs.

import "math"

// Netzladen is what the ceiling is derived from; every measurement is the
// box's own (G1).
type Netzladen struct {
	// Fuehrt is the role of the box (rolle fuehrt); false for steuert_mit and
	// for a document without a role.
	Fuehrt bool
	// Fresh is true while the own connection-point measurement is at most 30 s
	// old; Limit is true when a connection limit is maintained. Only both
	// together let the leading box charge from the grid.
	Fresh bool
	Limit bool
	// PlanableKw is the connection limit (or the tighter §14a envelope) minus
	// the engineering margin, as the charging budget uses it.
	PlanableKw float64
	// GridKw is the measured connection point (+ import); BattChargeKw the
	// measured battery charge (>= 0) of the same sample.
	GridKw       float64
	BattChargeKw float64
	// ReservedKw is what the charge park was granted but does not draw yet.
	ReservedKw float64
	// ParkOffen is true while the loop regulates again after it did not
	// (blind, frozen, start) and the charge park has NOT yet decided on a
	// sample of that fresh stretch: whatever headroom it shows is the
	// park's first. The loop then releases nothing - the charge stays at or
	// below the MEASURED charge - until the park has decided and ReservedKw
	// says what it took.
	ParkOffen bool
	// PvKw is the box's own measured PV; Unknown() without a reading.
	PvKw float64
	// Vorrang is true wherever a charge park runs beside the battery (AP-15
	// Folge, PV counted once): the solar-only branch then counts the park
	// first. False: the solar-only clamp of before, whatever else is set.
	// With Vorrang, a co-controlling box (Fuehrt false) reads PlanableKw as
	// its share and GridKw/BattChargeKw/ReservedKw/ParkOffen at its own
	// meter.
	Vorrang bool
	// Nachlauf is true while the box is blind but knows a sample (GridKw,
	// BattChargeKw of the last one): the loop keeps evaluating it, with
	// ReservedKw and ParkUnterKw from the park's current grant.
	Nachlauf bool
	// ParkUnterKw is what the charge park's grant lies BELOW its measured draw
	// of that sample (>= 0) - blind, its budget lowered it.
	ParkUnterKw float64
	// Pruefen / PruefenNeu: the Einfrierprobe asks for a probing adjustment
	// in the import direction (IP-27 A7) - running / still to be made.
	// PruefKw is the ceiling a probe of THIS guard already set (the caller
	// keeps it between evaluations); nil = none.
	Pruefen, PruefenNeu bool
	PruefKw             *float64
}

// NetzladenDeckel is the ceiling on the battery's charge (kW >= 0).
type NetzladenDeckel struct {
	DeckelKw float64
	// Regelt is true for the leading box's closed loop, false for the
	// solar-only clamp.
	Regelt bool
	// PruefKw is the probing ceiling to keep while the probe runs (IP-27
	// A7), nil = none; Pruefung is true when this evaluation set it.
	PruefKw  *float64
	Pruefung bool
}

// NetzladenDeckelFuer derives the battery's charge ceiling for a box that
// holds a share document.
func NetzladenDeckelFuer(in Netzladen) NetzladenDeckel {
	if in.Fuehrt && in.Fresh && in.Limit && finite(in.PlanableKw) && finite(in.GridKw) {
		batt, reserved := in.BattChargeKw, in.ReservedKw
		if !finite(batt) || batt < 0 {
			batt = 0
		}
		if !finite(reserved) || reserved < 0 {
			reserved = 0
		}
		rest := in.GridKw - batt + reserved
		d := NetzladenDeckel{DeckelKw: round3(math.Max(in.PlanableKw-rest, 0)), Regelt: true}
		if in.ParkOffen && batt < d.DeckelKw {
			d.DeckelKw = round3(batt)
		}
		if in.Pruefen {
			netzladenPruefen(in, batt, &d)
		}
		return d
	}
	pv := 0.0
	if known(in.PvKw) && finite(in.PvKw) && in.PvKw > 0 {
		pv = in.PvKw
	}
	// the leading box with a fresh sample but no known limit has nothing to
	// hold against: the solar-only clamp of before
	if !in.Vorrang || (in.Fuehrt && in.Fresh) || !finite(in.PlanableKw) || !finite(in.GridKw) ||
		(in.Fuehrt && !in.Limit) || !(in.Fresh || in.Nachlauf) {
		return NetzladenDeckel{DeckelKw: round3(pv)}
	}
	batt, reserved := in.BattChargeKw, in.ReservedKw
	if !finite(batt) || batt < 0 {
		batt = 0
	}
	if !finite(reserved) || reserved < 0 {
		reserved = 0
	}
	if u := in.ParkUnterKw; !in.Fresh && finite(u) && u > 0 {
		reserved -= u
	}
	k := math.Min(pv, math.Max(in.PlanableKw-(in.GridKw-batt+reserved), 0))
	if in.ParkOffen && batt < k {
		k = batt
	}
	return NetzladenDeckel{DeckelKw: round3(k)}
}

// LowerCharge applies a charge ceiling to the final battery setpoint (+ charge
// / - discharge): it only ever LOWERS a charge - a discharge, an idle battery
// and a charge below the ceiling pass unchanged.
// netzladenPruefen is the probing adjustment of IP-27 A7 at the battery: the
// leading box lowers the charge ONCE by PruefSenkKw below the MEASURED charge
// - only while the battery charges from the grid (above its own PV, what it
// falls back to blind) and only with that much to lower - and keeps the
// ceiling until the probe answers.
func netzladenPruefen(in Netzladen, battKw float64, d *NetzladenDeckel) {
	switch {
	case in.PruefKw != nil:
		v := *in.PruefKw
		d.PruefKw = &v
	case in.PruefenNeu && battKw >= PruefSenkKw && (!known(in.PvKw) || !finite(in.PvKw) || battKw > in.PvKw):
		v := round3(battKw - PruefSenkKw)
		d.PruefKw, d.Pruefung = &v, true
	default:
		return
	}
	if *d.PruefKw < d.DeckelKw {
		d.DeckelKw = *d.PruefKw
	}
}

func LowerCharge(kw float64, deckelKw *float64) float64 {
	if deckelKw == nil || !(kw > 0) || kw <= *deckelKw {
		return kw
	}
	return math.Max(*deckelKw, 0)
}
