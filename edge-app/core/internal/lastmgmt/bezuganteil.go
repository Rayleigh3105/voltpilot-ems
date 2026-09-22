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
//	steuert_mit  today's loop against the SHARE at  share − reserve − the declared
//	(or none)    its OWN meter (the feeder):        maximum of the uncontrolled
//	             min(share, share − rest)           load behind that meter
//
// The share of a co-controlling box is EVERYTHING behind its own measuring
// point (concept §3.2 Schicht 2, §3.3, B3; contract steuerungsverbund §1): the
// charge park, the box's other controllable consumers, and whatever nobody
// controls behind its feeder meter - a building distribution, a device
// without a write release. The Vorbehalt covers only what lies behind NO
// feeder. So the box holds its share where it measures, the import-side twin
// of guards/exportanteil.go: `rest = feeder − measured charging; budget =
// share − rest`, never above the share. Whatever draws behind the feeder is
// held - also a load the cloud never heard of (R3 with 50 kW building load in
// the feeder of Verwaltung: 27 kW for the park instead of 77, 507 kW at the
// connection point instead of 557).
//
// Fresh means a feeder value of at most 30 s (BudgetFreshWindow, the feed-in
// watchdog's figure); a frozen value (B2) and a clock behind the sample (A8)
// are blind like a missing one, and a standing value asks for the one probing
// adjustment of IP-27 A7 - on this box too, since its loop now reads the
// meter. Blind - no value, older than 30 s, before the first sample, after a
// restart - the box knows no rest and assumes the worst it was told: the
// share minus the reserve of its other controllable consumers minus
// ungeregelt_hinter_abgang (the declared maximum of the uncontrolled load
// behind the feeder, the blind twin of max(HouseReserveKw, MaxHouseLoadKw) in
// budget.go). It jumps there at once - the building may reach its maximum any
// second - and only never ABOVE its last fresh figure within
// BezugAnteilWindow (a blind controller releases nothing it just measured).
//
// THE RESERVE COUNTS ONCE (reserve_verbraucher, PR 1058): with a fresh
// feeder value the other controllable consumers draw inside `rest`, so the
// reserve is NOT subtracted again; it holds only where the box cannot see
// them - blind, and at a box without a meter of its own. Such a box
// ("kein eigener Zaehler") holds the sum of its devices like IP-18: its
// battery charges from its own PV only (guards/bezuganteil.go), so that sum
// adds nothing to the park's rest, and the other consumers are the reserve -
// the charge park gets share − reserve, today's figure; the cloud sends no
// ungeregelt_hinter_abgang for it. Without the field every blind figure is
// the one of PR 1058; with a meter that sits like DQ-10 (only what the box
// controls behind it) the fresh figure is the share, as before.
//
// An unreachable station's draw sits in the measured rest AND is reserved out
// of the budget by the executor (a share that binds is never Measured()): the
// conservative side, kept so one rule serves the executor for both roles.
// A document without a role (the field is optional) is treated like
// steuert_mit - the safe side, as IP-18 decided it.
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
	// EingefrorenSeit is set while the box's own connection-point value counts
	// as frozen (B2, guards.Einfrierprobe): the time of its last change. The
	// budget then treats the value as a measurement that old - the leading
	// box goes blind exactly as when the value stops arriving. Zero = not
	// frozen.
	EingefrorenSeit time.Time
	// Pruefen is set while the Einfrierprobe asks for a probing adjustment in
	// the import direction (IP-27 A7, guards.Einfrierprobe.Pruefung). The
	// leading box then lowers its charging budget ONCE by guards.PruefSenkKw
	// below the MEASURED draw - only while that draw is above its share (the
	// figure it falls back to blind) - and holds it until the probe answers.
	Pruefen bool
	// PruefenNeu: the probe is due and no watchdog made it yet in this
	// standstill - only then may the budget START it (once per standstill).
	PruefenNeu bool
	// ReserveKw is reserve_verbraucher.bezug of the share document (AP-15
	// Folge of IP-19): the rated power of the box's OTHER controllable import
	// devices - relays, SG-Ready, heat pumps, a wallbox outside wallboxes[].
	// The share holds for everything the box controls, so the charge park
	// gets the share MINUS this reserve (never below 0) wherever the share
	// binds. 0 = none (an older document without the field): today's figure.
	ReserveKw float64
	// UngeregeltKw is ungeregelt_hinter_abgang.bezug of the share document
	// (AP-15 Folge of IP-19, B3): the declared maximum of the uncontrolled
	// load behind the box's own feeder meter. Only the BLIND figure of a
	// co-controlling box subtracts it - fresh, the feeder measures that load.
	// 0 = none declared (an older document): the blind figure of PR 1058.
	UngeregeltKw float64
}

// pruefSenkKw is guards.PruefSenkKw (EinfrierStellKw + the write resolution);
// lastmgmt keeps its own copy like its own fresh window, and a test pins the
// two equal.
const pruefSenkKw = 2.1

// BudgetAnteil evaluates the charging budget for a box that holds a share
// document. The verdict keeps today's vocabulary (BudgetMode) - a share that
// binds reads statisch (a fixed figure), zieht_zusammen (the leading box's
// ramp) or sicherheitsbudget (arrived) - and names the share in its sentence.
// It is never Measured() while the share binds, so the executor reserves the
// safe default of stations it cannot reach OUT OF the share (ocppBudget).
func (t *BudgetTracker) BudgetAnteil(now time.Time, set Settings, an BezugAnteil) BudgetVerdict {
	heute := t.Budget(now, set)
	// IP-27 A8: the twin re-anchors on a clock that jumped back where today's
	// tracker holds a stale sample as fresh; the lower of the two is the base -
	// the share never evaluates above today's (V5), and a stale sample never
	// lifts it.
	z := t.twin()
	src := t
	if z != nil {
		if h := z.Budget(now, set); h.Kw < heute.Kw {
			heute = h
		}
		src = z
	}
	src.mu.Lock()
	seen, at, charging := src.seen, src.at, src.chargingKw
	rest := src.restHoldLocked()
	src.mu.Unlock()
	anteil := an.AnteilKw
	if !budgetFinite(anteil) || anteil < 0 {
		anteil = 0
	}
	anteil = round3(anteil)
	res := heute
	res.AnteilKw = &anteil
	// The charge park's part of the share: the share minus the reserve of the
	// box's other controllable consumers (V3 - the share holds for ALL of
	// them; they have no power model on the box). Only ever lower (V5); the
	// fresh leading box below regulates the whole limit and measures those
	// consumers at the connection point, so the reserve changes nothing there.
	lade, anteilKw := anteil, kwText(anteil)+" kW"
	if r := an.ReserveKw; budgetFinite(r) && r > 0 {
		r = round3(r)
		lade = round3(math.Max(anteil-r, 0))
		res.ReserveVerbraucherKw = &r
		anteilKw = kwText(lade) + " kW (" + kwText(anteil) + " kW abzüglich " + kwText(r) +
			" kW für ihre anderen steuerbaren Verbraucher)"
	}
	// The blind figure of a co-controlling box: what it assumes about its own
	// meter when it cannot read it - the reserve AND the declared maximum of
	// the uncontrolled load behind its feeder draw at full power.
	blindKw, blindText := lade, anteilKw
	if u := an.UngeregeltKw; !an.Fuehrt && budgetFinite(u) && u > 0 {
		u = round3(u)
		res.UngeregeltHinterAbgangKw = &u
		blindKw = round3(math.Max(lade-u, 0))
		blindText = kwText(blindKw) + " kW (" + kwText(anteil) + " kW abzüglich "
		if r := res.ReserveVerbraucherKw; r != nil {
			blindText += kwText(*r) + " kW für ihre anderen steuerbaren Verbraucher und "
		}
		blindText += kwText(u) + " kW für das Ungeregelte hinter ihrem Zähler)"
	}

	t.mu.Lock()
	// B2: a frozen value is no measurement - its age counts from its last
	// change.
	eingefroren := seen && !an.EingefrorenSeit.IsZero() && !an.EingefrorenSeit.After(at)
	if eingefroren {
		at = an.EingefrorenSeit
	}
	// A8: an age below zero is no age - the clock went back behind the
	// sample. Blind, never clamped to "fresh".
	age := now.Sub(at)
	uhrsprung := seen && age < 0
	frisch := seen && !uhrsprung && age <= BudgetFreshWindow
	if !an.Pruefen || !frisch {
		t.pruefValid = false
	}
	if !an.Fuehrt {
		t.rampValid = false
		res = t.mitsteuerndLocked(an, heute, res, mitMessung{frisch: frisch, seen: seen, uhrsprung: uhrsprung,
			eingefroren: eingefroren, age: age, rest: rest, charging: charging}, anteil, blindKw, blindText)
		t.mu.Unlock()
		return res
	}
	var deckel float64
	mode, blind := BudgetStatic, heute.Blind
	var reason string
	switch {
	case uhrsprung:
		t.rampValid = false
		deckel, mode, blind = lade, BudgetSafe, true
		reason = "Die Uhr der Box ist hinter die letzte Messung am Netzanschluss zurückgesprungen - bis zur " +
			"nächsten Messung gilt in der Gemeinsamen Steuerung der Anteil dieser Box von " + anteilKw + "."
	case seen && age <= BudgetFreshWindow:
		// fresh: the leading box regulates the WHOLE limit with today's loop;
		// its share does not bind while it measures.
		t.rampValid = false
		if an.Pruefen {
			t.pruefenLocked(charging, anteil, an.PruefenNeu, "am Netzanschluss", &res)
		}
		t.mu.Unlock()
		return res
	case !seen:
		// R15: the share holds before the first measurement.
		t.rampValid = false
		deckel = lade
		reason = "Gemeinsame Steuerung: noch keine Messung am Netzanschluss - es gilt der Anteil dieser Box von " +
			anteilKw + "."
	case age > BudgetFreshWindow+BezugAnteilWindow:
		t.rampValid = false
		deckel, mode, blind = lade, BudgetSafe, true
		reason = t.anteilBlindPrefix(age, eingefroren) + "in der Gemeinsamen Steuerung gilt der Anteil dieser Box von " +
			anteilKw + "."
	default:
		if !t.rampValid {
			// the operating point at the onset of blindness: the budget
			// today's evaluation still holds
			t.rampValid, t.rampFrom = true, heute.Kw
		}
		deckel, mode, blind = t.rampFrom, BudgetContracting, true
		if deckel > lade {
			frac := (age - BudgetFreshWindow).Seconds() / BezugAnteilWindow.Seconds()
			frac = math.Min(math.Max(frac, 0), 1)
			deckel -= (deckel - lade) * frac
		}
		reason = t.anteilBlindPrefix(age, eingefroren) + "in der Gemeinsamen Steuerung zieht die Box das Ladebudget ohne Halten auf ihren Anteil von " +
			anteilKw + " zusammen (aktuell " + kwText(round3(deckel)) + " kW)."
	}
	t.mu.Unlock()

	deckel = round3(deckel)
	if deckel < heute.Kw {
		res.Kw, res.Mode, res.Blind, res.Reason = deckel, mode, blind, reason
		res.AnteilBinds = true
	}
	return res
}

// mitMessung is what the co-controlling box knows about its own meter at one
// evaluation: whether the feeder value is fresh (<= 30 s, not frozen, no clock
// jump), and the trailing rest and the charging of the newest sample.
type mitMessung struct {
	frisch, seen, uhrsprung, eingefroren bool
	age                                  time.Duration
	rest, charging                       float64
}

// mitsteuerndLocked is the charging budget of a co-controlling box (steuert_mit
// or no role): the share held at its OWN meter (see the file doc). Fresh,
// today's loop with the share as the planable power; blind, the share minus
// the reserve and the declared uncontrolled maximum (blindKw), never above the
// last fresh figure within BezugAnteilWindow. The minimum with today's
// evaluation stays the construction (V5). Caller holds t.mu.
func (t *BudgetTracker) mitsteuerndLocked(an BezugAnteil, heute, res BudgetVerdict, m mitMessung,
	anteil, blindKw float64, blindText string) BudgetVerdict {
	var deckel float64
	var reason string
	blind := heute.Blind || (m.seen && !m.frisch)
	anteilKw := kwText(anteil) + " kW"
	switch {
	case m.frisch:
		// rest: everything behind the feeder that is not the park's measured
		// charging - the other consumers of the box and the uncontrolled
		// load alike. Never above the share (measuredBudget caps).
		deckel = measuredBudget(anteil, m.rest)
		t.mitKw, t.mitValid = deckel, true
		if m.rest > 0.05 {
			reason = "Gemeinsame Steuerung: diese Box steuert mit und hält ihren Anteil von " + anteilKw +
				" an ihrem eigenen Zähler. Dort ziehen gerade " + kwText(round3(m.rest)) +
				" kW, die nicht ihre Ladepunkte sind - ihre Ladepunkte bekommen zusammen höchstens " +
				kwText(deckel) + " kW."
		} else {
			reason = "Gemeinsame Steuerung: diese Box steuert mit und hält ihren Anteil von " + anteilKw +
				" an ihrem eigenen Zähler - ihre Ladepunkte bekommen zusammen höchstens " + kwText(deckel) + " kW."
		}
	case !m.seen:
		// R15: before the first sample (after a restart, or a box without a
		// meter of its own) the blind figure holds.
		t.mitValid = false
		deckel = blindKw
		reason = "Gemeinsame Steuerung: kein Messwert vom eigenen Zähler dieser Box - ihre Ladepunkte bekommen " +
			"zusammen höchstens " + blindText + ", auch ohne Verbindung und nach einem Neustart."
	default:
		deckel = blindKw
		// a blind controller releases nothing it just measured: within the
		// window the last fresh figure stays the ceiling where it is lower
		if t.mitValid && !m.uhrsprung && m.age <= BudgetFreshWindow+BezugAnteilWindow {
			deckel = math.Min(deckel, t.mitKw)
		} else {
			t.mitValid = false
		}
		reason = t.mitBlindPrefix(m) + "in der Gemeinsamen Steuerung bekommen die Ladepunkte dieser Box zusammen " +
			"höchstens " + blindText + "."
		if deckel < blindKw {
			reason = t.mitBlindPrefix(m) + "in der Gemeinsamen Steuerung bleibt das Ladebudget dieser Box bis zu " +
				ageText(BezugAnteilWindow) + " auf dem zuletzt gemessenen Wert von " + kwText(round3(deckel)) +
				" kW, danach gilt " + blindText + "."
		}
	}
	deckel = round3(deckel)
	res.EigenerZaehler = m.frisch
	if deckel < heute.Kw {
		res.Kw, res.Mode, res.Blind, res.Reason = deckel, BudgetStatic, blind, reason
		res.AnteilBinds = true
	}
	// IP-27 A7: a standing feeder value asks for ONE probing adjustment -
	// only while the park draws above the blind figure (below it, blindness
	// changes nothing)
	if m.frisch && an.Pruefen {
		t.pruefenLocked(m.charging, blindKw, an.PruefenNeu, "am eigenen Zähler", &res)
	}
	return res
}

// mitBlindPrefix opens the sentence of a blind co-controlling box: its own
// meter, not the connection point. Caller holds t.mu.
func (t *BudgetTracker) mitBlindPrefix(m mitMessung) string {
	switch {
	case m.uhrsprung:
		return "Die Uhr der Box ist hinter die letzte Messung am eigenen Zähler zurückgesprungen - "
	case m.eingefroren:
		return "Der Messwert am eigenen Zähler steht seit " + ageText(m.age) +
			" still, obwohl diese Box selbst verstellt hat - er gilt als eingefroren; "
	case t.incompleteAt.After(t.at):
		return "Ein ladender Ladepunkt meldet seit " + ageText(m.age) + " keinen Messwert - "
	}
	return "Seit " + ageText(m.age) + " keine Messung am eigenen Zähler - "
}

// pruefenLocked is the probing adjustment of IP-27 A7 on the import side: at
// its start the box (the leading one at the connection point, a co-controlling
// one at its own meter - wo names it) lowers its charging budget ONCE to
// pruefSenkKw below the MEASURED draw - only while that draw runs above the
// figure it falls back to blind (anteil), and
// only when there is that much to lower (else nothing: no adjustment that
// could not show, no verdict from the probe). It holds that figure until the
// probe answers; a value that moves releases through today's loop. Caller
// holds t.mu.
func (t *BudgetTracker) pruefenLocked(chargingKw, anteil float64, neu bool, wo string, res *BudgetVerdict) {
	if !t.pruefValid {
		if !neu || !budgetFinite(chargingKw) || chargingKw <= anteil || chargingKw < pruefSenkKw {
			return
		}
		t.pruefValid, t.pruefKw = true, round3(chargingKw-pruefSenkKw)
		res.Pruefung = true
	}
	if t.pruefKw < res.Kw {
		res.Kw = t.pruefKw
		res.Reason = "Gemeinsame Steuerung: der Messwert " + wo + " steht still - diese Box senkt ihr " +
			"Ladebudget einmal um " + kwText(pruefSenkKw) + " kW auf " + kwText(t.pruefKw) +
			" kW und prüft, ob der Zähler das zeigt."
	}
}

// anteilBlindPrefix opens the sentence of a blind share verdict: the value
// stopped arriving - or it arrives, frozen (B2). Caller holds t.mu.
func (t *BudgetTracker) anteilBlindPrefix(age time.Duration, eingefroren bool) string {
	if eingefroren {
		return "Der Messwert am Netzanschluss steht seit " + ageText(age) +
			" still, obwohl diese Box selbst verstellt hat - er gilt als eingefroren; "
	}
	return t.blindPrefix(age)
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
	// IP-27 A8: the sample of the share path's twin, which re-anchors on a
	// clock that jumped back
	src := t
	if t.zwilling != nil {
		src = t.zwilling
		src.mu.Lock()
		defer src.mu.Unlock()
	}
	if !src.seen {
		return n, hasLimit
	}
	n.Seen, n.GridKw, n.ChargingKw = true, src.gridKw, src.chargingKw
	n.Age = now.Sub(src.at)
	if n.Age < 0 {
		// an age below zero is no age: older than every window (blind)
		n.Age = BudgetHoldWindow + BudgetContractWindow + time.Second
	}
	if src.haveBatt {
		n.BattChargeKw = src.battKw
	}
	return n, hasLimit
}
