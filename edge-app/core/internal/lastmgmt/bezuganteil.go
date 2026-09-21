package lastmgmt

// The charging budget WITH A SHARE (UEMS AP-15 IP-19, rules V1, V3, V5, G1;
// concept vp-uems-ap15-verbund §3.6/§4.6, R3, R13). Several boxes behind ONE
// connection point hold its import limit together: each holds an own share
// (internal/anteile - stored, without expiry, back before the first
// measurement). This file is the import-side twin of guards/exportanteil.go
// for what the Ladepark-Rahmen controls (OCPP stations and the wallboxes of
// `wallboxes[]`), and it changes exactly two things against budget.go: WHERE
// the limit comes from, and the ROLE of the box.
//
//	role         fresh (<= 30 s)                    blind
//	fuehrt       today's loop against the whole     no hold: linear within
//	             connection limit, unchanged        BezugAnteilWindow to the share
//	steuert_mit  the share, fixed                   the share, fixed
//	(or none)
//
// The share is what the box's CONTROLLED consumers may draw together; what
// nobody controls sits in the reserve of the share document (G2, R3: 473 kW
// Vorbehalt + 77 kW Anteil = 550 kW). So a co-controlling box does not
// subtract its own building load from its share - it would count that load
// twice - and it needs no measurement at all to hold it: without a
// connection, after a restart, before the first sample the budget is the same
// 77 kW (R3). A document without a role (the field is optional) is treated
// like steuert_mit - the safe side, as IP-18 decided it.
//
// SAFE BY CONSTRUCTION, NOT BY ARGUMENT (V5, "ein Waechter erweitert nie"):
// BudgetAnteil first runs today's unchanged Budget on the same tracker and
// only ever LOWERS its result. A share can therefore never hand the stations
// more than the same box without a share would, and it sits under the
// allocator - no „Jetzt voll laden" and no customer rule lifts it (V1, R13).
// Without a share document nothing here runs and budget.go is byte for byte
// what it was.

import (
	"math"
	"time"
)

// BezugAnteilWindow is how long the LEADING box takes, once its own
// connection-point measurement is older than BudgetFreshWindow, to arrive at
// its share: linear and WITHOUT the hold phase of budget.go (V2/V3). Behind
// one connection point with a partner, holding is not defensible - the partner
// may raise its draw to its own share at any time. Same figure as
// guards.ExportAnteilWindow on the feed-in side.
const BezugAnteilWindow = 60 * time.Second

// BezugAnteil is the own import share of a held share document.
type BezugAnteil struct {
	// AnteilKw is the box's own share in the direction bezug (kW).
	AnteilKw float64
	// Fuehrt is true for the leading box (rolle fuehrt, it measures the
	// connection point). False for steuert_mit AND for a document without a
	// role: the share then holds, always.
	Fuehrt bool
}

// BudgetAnteil evaluates the charging budget for a box that holds a share
// document. The verdict keeps today's vocabulary (BudgetMode) - a share that
// binds reads statisch (a fixed figure), zieht_zusammen (the leading box's
// ramp) or sicherheitsbudget (arrived) - and names the share in its sentence.
// It is never Measured() while the share binds, so the executor reserves the
// safe default of stations it cannot reach OUT OF the share (ocppBudget).
func (t *BudgetTracker) BudgetAnteil(now time.Time, set Settings, an BezugAnteil) BudgetVerdict {
	heute := t.Budget(now, set)
	anteil := an.AnteilKw
	if !budgetFinite(anteil) || anteil < 0 {
		anteil = 0
	}
	anteil = round3(anteil)
	res := heute
	res.AnteilKw = &anteil

	t.mu.Lock()
	seen, at := t.seen, t.at
	age := now.Sub(at)
	if age < 0 {
		age = 0
	}
	var deckel float64
	mode, blind := BudgetStatic, heute.Blind
	reason := "Gemeinsame Steuerung: diese Box steuert mit und sieht den Netzanschluss nicht. " +
		"Ihre Ladepunkte bekommen zusammen höchstens ihren Anteil von " + kwText(anteil) +
		" kW - auch ohne Verbindung und nach einem Neustart."
	switch {
	case !an.Fuehrt:
		t.rampValid = false
		deckel = anteil
	case seen && age <= BudgetFreshWindow:
		// fresh: the leading box regulates the WHOLE limit with today's loop;
		// its share does not bind while it measures.
		t.rampValid = false
		t.mu.Unlock()
		return res
	case !seen:
		// R15: the share holds before the first measurement.
		t.rampValid = false
		deckel = anteil
		reason = "Gemeinsame Steuerung: noch keine Messung am Netzanschluss - es gilt der Anteil dieser Box von " +
			kwText(anteil) + " kW."
	case age > BudgetFreshWindow+BezugAnteilWindow:
		t.rampValid = false
		deckel, mode, blind = anteil, BudgetSafe, true
		reason = t.blindPrefix(age) + "in der Gemeinsamen Steuerung gilt der Anteil dieser Box von " +
			kwText(anteil) + " kW."
	default:
		if !t.rampValid {
			// the operating point at the onset of blindness: the budget
			// today's evaluation still holds
			t.rampValid, t.rampFrom = true, heute.Kw
		}
		deckel, mode, blind = t.rampFrom, BudgetContracting, true
		if deckel > anteil {
			frac := (age - BudgetFreshWindow).Seconds() / BezugAnteilWindow.Seconds()
			frac = math.Min(math.Max(frac, 0), 1)
			deckel -= (deckel - anteil) * frac
		}
		reason = t.blindPrefix(age) + "in der Gemeinsamen Steuerung zieht die Box das Ladebudget ohne Halten auf ihren Anteil von " +
			kwText(anteil) + " kW zusammen (aktuell " + kwText(round3(deckel)) + " kW)."
	}
	t.mu.Unlock()

	deckel = round3(deckel)
	if deckel < heute.Kw {
		res.Kw, res.Mode, res.Blind, res.Reason = deckel, mode, blind, reason
		res.AnteilBinds = true
	}
	return res
}

// Netzpunkt is the newest usable paired measurement of the tracker, for the
// leading box's grid-charge loop (guards.NetzladenDeckelFuer): the same
// sample the budget works with, so both instruments see one connection point.
type Netzpunkt struct {
	// Seen is false while nothing usable was ever measured.
	Seen bool
	Age  time.Duration
	// GridKw is the signed connection-point power (+ import).
	GridKw float64
	// ChargingKw is the measured draw of the charge points.
	ChargingKw float64
	// BattChargeKw is the measured battery charge (>= 0), 0 without one.
	BattChargeKw float64
	// PlanableKw is the connection limit (or the tighter observed §14a
	// envelope) minus the engineering margin - the figure the budget regulates
	// against. ok=false in Bezugsgrenze when no connection limit is maintained.
	PlanableKw float64
}

// Netzpunkt reports the newest paired measurement and the planable connection
// power for set. hasLimit is false without a maintained connection limit: the
// box then knows no Bezugsgrenze to regulate against.
func (t *BudgetTracker) Netzpunkt(now time.Time, set Settings) (n Netzpunkt, hasLimit bool) {
	set = set.WithDefaults()
	t.mu.Lock()
	defer t.mu.Unlock()
	limit := set.GridLimitKw
	if t.have14a && t.kw14a < limit {
		limit = t.kw14a
	}
	n.PlanableKw = round3(limit * (1 - set.MarginPct/100))
	hasLimit = set.GridLimitKw > 0
	if !t.seen {
		return n, hasLimit
	}
	n.Seen, n.GridKw, n.ChargingKw = true, t.gridKw, t.chargingKw
	n.Age = now.Sub(t.at)
	if n.Age < 0 {
		n.Age = 0
	}
	if t.haveBatt {
		n.BattChargeKw = t.battKw
	}
	return n, hasLimit
}
