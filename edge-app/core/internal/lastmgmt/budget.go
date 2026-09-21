package lastmgmt

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// This file is STUFE 2 of the load-management concept
// (`vp-ocpp-lastmgmt-konzept-w4` §4.2 Nr. 2): the charging budget stops being a
// static subtraction of two operator-maintained numbers and FOLLOWS THE
// MEASURED connection point instead — and the §14a envelope is folded in.
//
// THE CONTROL LAW (the concept's own formula):
//
//	rest   = gemessener Netzbezug − gemessene Ladeleistung   ("the rest of the site")
//	budget = planbar − rest
//
// Subtracting the measured CHARGING power is not a nicety, it is what makes the
// loop stable. The charge points' own draw is already inside the measured grid
// power, so `budget = planbar − grid` would shrink the budget by exactly the
// power it just granted, cut the cars, watch the grid fall, grant it again — a
// sustained oscillation with the period of the loop. Adding back only what is
// PROVEN to be charging is the import-side twin of guards/exportlimit.go's
// `cap = pv_total + headroom − margin`, which adds back the quantity it
// controls for the very same reason.
//
// Everything else the site does — the building, a wallbox on another circuit,
// the battery, PV — is netted in AUTOMATICALLY because it is already inside the
// one measured number. That is the whole advantage over planning, and it is why
// this replaces HouseReserveKw rather than adding to it.
//
// ⚠ THE FAIL-SAFE RULE IS THE INVERSION OF EVERY ECONOMIC GUARD, and it is
// copied deliberately from guards/exportlimit.go (there on the export side,
// here on the import side): blind must never mean unlimited.
//
//	frisch                -> geschlossener Regelkreis
//	kurze Lücke           -> das zuletzt berechnete Budget HALTEN (nie erhöhen)
//	längere Lücke         -> auf das SICHERE Budget ZUSAMMENZIEHEN
//	nie gemessen          -> das hinterlegte statische Budget (Stufe 1, byte-gleich)
//
// The two blind figures are different on purpose. A site that has NEVER been
// measured is a Stufe-1 site: its budget is exactly what the operator
// maintained, and nothing about this file may change that (a test pins it).
// A site that WAS measured and went blind is a different question — there the
// honest assumption is the WORST building load the operator knows
// (`max(HouseReserveKw, MaxHouseLoadKw)`), which is never more generous than
// the static figure.
//
// ⚠ THE INERTIA LIVES IN EXACTLY ONE PLACE, and it is asymmetric by
// construction: the site's rest load is taken as the MAXIMUM over a trailing
// window (BudgetSmoothWindow). A load step therefore shrinks the budget in the
// very next sample, while a load drop only widens it once the whole window has
// passed. One mechanism, both jobs: conservative in the direction that protects
// the connection, deliberately sluggish in the direction that would otherwise
// let a flickering house load rewrite every station's charging profile.
//
// ⚠ KNOWN INTERACTION with the box's own despike gate, and it is accepted on
// purpose: that gate HOLDS the last accepted value of `power_kw` for a few
// samples after a step it considers implausible (agent.onLocalTelemetry). A
// held grid reading paired with a fresh charging total therefore mis-states the
// rest for the length of that hold — and because the window keeps the MAXIMUM,
// an over-stated rest keeps the budget small for up to one window. That is the
// conservative direction, it is bounded, and it corrects itself; reacting to a
// single sample less than immediately would move the error into the direction
// that protects nothing. Do not "fix" it by softening the maximum.

// BudgetMode is the machine-readable verdict of the budget stage. The German
// sentence travels next to it (BudgetVerdict.Reason) exactly like otaapply's
// Blocker/reason pair — no surface parses a German sentence, and the sentence
// is written ONCE so the :8484 card and the cloud can never word it differently.
type BudgetMode string

const (
	// BudgetStatic: the budget comes from the operator's own numbers — either
	// because no measurement has ever arrived, or because the operator switched
	// the dynamic budget off. This is Stufe-1 behaviour, byte for byte.
	BudgetStatic BudgetMode = "statisch"
	// BudgetMeasured: closed loop against the connection point.
	BudgetMeasured BudgetMode = "gemessen"
	// BudgetHolding: the measurement went away recently — the last computed
	// budget is FROZEN. Never a release.
	BudgetHolding BudgetMode = "haelt"
	// BudgetContracting: blind long enough that holding is no longer
	// defensible — the budget is being pulled down to the safe one.
	BudgetContracting BudgetMode = "zieht_zusammen"
	// BudgetSafe: blind, and the budget has arrived at the safe figure that
	// holds against the worst building load the operator knows.
	BudgetSafe BudgetMode = "sicherheitsbudget"
)

const (
	// BudgetFreshWindow is how old the newest usable measurement may be and
	// still DRIVE the loop. Sized at several source poll cycles (5 s) and OCPP
	// meter-value cadences (10 s), so an ordinary hiccup never leaves the loop,
	// but short enough that the loop's whole value — its recency — is real.
	// Same figure and same reasoning as guards.ExportFreshWindow.
	BudgetFreshWindow = 30 * time.Second
	// BudgetHoldWindow is how long a measurement gap is absorbed by FREEZING
	// the last budget (measured from the last measurement, so it covers the
	// fresh window).
	BudgetHoldWindow = 90 * time.Second
	// BudgetContractWindow is how long the contraction to the safe budget
	// takes once holding is no longer defensible. Gradual on purpose: dropping
	// a charging park to the safe budget on a ten-second telemetry hiccup would
	// be a self-inflicted outage, and the connection is not yet in danger — we
	// are only losing the ability to PROVE that it is not.
	BudgetContractWindow = 5 * time.Minute
	// BudgetSmoothWindow is the trailing window the site's rest load is taken
	// as the MAXIMUM of — the one place the inertia lives (see the file doc).
	// A minute covers several telemetry samples and meter-value cycles, and it
	// is the same order as guards.ExportReleaseWindow on the export side.
	BudgetSmoothWindow = 60 * time.Second
	// PlanLimitFreshWindow is how long a plan-derived ceiling survives without
	// being renewed. It is generous against the executor's own cadence and
	// FAIL-OPEN when it runs out: a ceiling nobody is refreshing is not a
	// ceiling this lane keeps defending (see ObservePlanLimit).
	PlanLimitFreshWindow = 90 * time.Second
	// BudgetStepKw is the ABSOLUTE floor under the out-of-band reaction (see
	// urgentDropKw): below one kilowatt nothing is worth waking the executor
	// for, however small the site is.
	BudgetStepKw = 1.0
	// budgetMaxSamples bounds the smoothing window's memory against a
	// telemetry storm. At a realistic cadence the window holds a handful.
	budgetMaxSamples = 600
)

// BudgetVerdict is one evaluation of the charging budget, WITH the terms it was
// derived from so a surface can show the customer the arithmetic instead of a
// bare number.
type BudgetVerdict struct {
	// Kw is the usable site charging budget.
	Kw float64 `json:"kw"`
	// Mode / Reason are the machine-readable stage and its German sentence.
	Mode   BudgetMode `json:"mode"`
	Reason string     `json:"reason,omitempty"`
	// LimitKw is the EFFECTIVE connection limit the verdict worked with: the
	// maintained Anschlussgrenze, or the observed §14a envelope when that is
	// tighter (most-restrictive-wins).
	LimitKw float64 `json:"limit_kw"`
	// PlanableKw is LimitKw minus the engineering margin.
	PlanableKw float64 `json:"planable_kw"`
	// Section14aKw is the observed §14a envelope, when one was ever reported.
	// nil = never reported — NOT a limit of zero (the guards.Reading footgun:
	// a §14a value of 0 means zero kilowatts, and only an ABSENT channel means
	// unknown).
	Section14aKw *float64 `json:"section_14a_kw,omitempty"`
	// Section14aBinds is true when that envelope is what caps the site.
	Section14aBinds bool `json:"section_14a_binds,omitempty"`
	// SiteLoadKw is the rest of the site (everything but the charge points) the
	// decision worked with — the trailing maximum, not the last sample. nil
	// while blind or static: never a fabricated measurement.
	SiteLoadKw *float64 `json:"site_load_kw,omitempty"`
	// GridKw / ChargingKw are the newest paired measurement (signed grid power,
	// + import; measured charging power). nil with none.
	GridKw     *float64 `json:"grid_kw,omitempty"`
	ChargingKw *float64 `json:"charging_kw,omitempty"`
	// MeasurementAge is how old the newest usable measurement is; 0 with none.
	MeasurementAge time.Duration `json:"-"`
	// Blind is true whenever the verdict was NOT formed from a fresh
	// measurement (holding / contracting / safe).
	Blind bool `json:"blind,omitempty"`
	// PlanLimitKw is what the FAHRPLAN leaves the vehicles in the running
	// quarter (kW) - the peak-shaving target of the cloud, projected onto the
	// rest of this quarter hour and reduced by the site's other load. nil =
	// kein Fahrplan-Deckel (kein Ziel, kein frischer Plan, keine Messung).
	PlanLimitKw *float64 `json:"plan_limit_kw,omitempty"`
	// PlanLimitBinds is true when that ceiling is what caps the vehicles.
	PlanLimitBinds bool `json:"plan_limit_binds,omitempty"`
	// Capped is true when the measured budget was cut back to the connection's
	// own planable power (see the cap in measuredBudget).
	Capped bool `json:"capped,omitempty"`
	// AnteilKw is the box's own import share of a held share document (AP-15
	// IP-19, bezuganteil.go); nil without one - then nothing below changed.
	AnteilKw *float64 `json:"anteil_kw,omitempty"`
	// AnteilBinds is true when that share is what caps the vehicles.
	AnteilBinds bool `json:"anteil_binds,omitempty"`
	// Pruefung is true when this evaluation made the probing adjustment of
	// IP-27 A7 (BudgetAnteil only): the caller reports it to the
	// Einfrierprobe, whose answer window starts now.
	Pruefung bool `json:"-"`
}

// Measured reports whether this verdict came out of the closed loop.
func (v BudgetVerdict) Measured() bool { return v.Mode == BudgetMeasured }

// BudgetTracker carries the measurement history and the last commanded budget
// across ticks. Concurrency-safe: Observe runs on the telemetry path, Budget on
// the load-management tick.
//
// It is PURE in the house sense — no I/O, no clock of its own, every
// time-dependent method takes its `now` — so every rule above is provable
// without a websocket, a station or a container.
type BudgetTracker struct {
	mu sync.Mutex

	// the trailing rest-load samples (the smoothing window)
	samples []restSample
	// the newest USABLE paired measurement
	seen       bool
	at         time.Time
	gridKw     float64
	chargingKw float64
	// battKw is the power the site's battery was last MEASURED taking (>= 0;
	// a discharge is 0 here). haveBatt distinguishes "never reported" from
	// "reported as zero" - the guards.Reading footgun, one more time.
	battKw   float64
	haveBatt bool
	// incompleteAt is when a sample was last DISCARDED because a charging
	// connector reported no measurement. It is remembered so a blind stage can
	// name the real cause instead of blaming the telemetry path.
	incompleteAt time.Time

	// the §14a envelope, once observed. Deliberately NOT expired: it only ever
	// REDUCES, and the battery guard (guards.Clamp) treats the observed
	// envelope the same way — the edge keeps the last one it saw.
	have14a bool
	kw14a   float64

	// the budget currently in force (measured mode writes it; the blind stages
	// hold and then contract it)
	curValid bool
	cur      float64
	// planLimit is the newest plan-derived SITE import allowance for the
	// running quarter, planLimitAt when it was handed in. Both are cleared the
	// moment the agent stops feeding them - see ObservePlanLimit.
	planLimit   float64
	planLimitAt time.Time
	havePlan    bool
	// planable and marginKw are remembered from the last Budget() call so
	// Observe can judge urgency without the caller having to hand it the
	// settings.
	planableValid bool
	planable      float64
	marginKw      float64
	// rampFrom is the budget in force when the LEADING box of a share
	// document went blind (bezuganteil.go); rampValid while that ramp runs.
	rampValid bool
	rampFrom  float64

	// zwilling is the share path's twin (IP-27 A8): it is fed every input of
	// this tracker, but it RE-ANCHORS on a clock that jumped back (verankert)
	// where this tracker - today's - discards every sample until the clock has
	// caught up. Only BudgetAnteil and Netzpunkt read it; today's verdicts are
	// byte for byte what they were.
	zwilling  *BudgetTracker
	verankert bool
	// uhrsprung: the last Budget of the twin found its newest sample in the
	// future of now (an age below zero is no age - blind)
	uhrsprung bool
	// the probing adjustment of the leading box (IP-27 A7, BudgetAnteil): the
	// budget it lowered to, held until the Einfrierprobe answers
	pruefValid bool
	pruefKw    float64
}

// twin returns the share path's twin, created with the first input; nil for
// the twin itself.
func (t *BudgetTracker) twin() *BudgetTracker {
	if t.verankert {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.zwilling == nil {
		t.zwilling = &BudgetTracker{verankert: true}
	}
	return t.zwilling
}

// verankernLocked re-anchors the tracker on a clock that went back to ts
// (A8): the sample at ts becomes the newest, and every time the tracker keeps
// is brought back to it at the latest - the smoothing window and the plan
// ceiling then hold from the jump on, never shorter (a merely reordered
// sample can only make them hold longer). Caller holds t.mu.
func (t *BudgetTracker) verankernLocked(ts time.Time) {
	t.at = ts
	for i := range t.samples {
		if t.samples[i].at.After(ts) {
			t.samples[i].at = ts
		}
	}
	if t.planLimitAt.After(ts) {
		t.planLimitAt = ts
	}
	if t.incompleteAt.After(ts) {
		t.incompleteAt = ts
	}
}

// urgentDropKw is how much smaller a sample must demand the budget to be
// before the executor is woken out of band.
//
// It is HALF THE ENGINEERING MARGIN, because the margin is precisely the head
// room that absorbs an unplanned import between two decisions (Konzept §4.2):
// while the demanded shrink still fits in half of it, the ordinary tick is soon
// enough, and waking on every wobble would rewrite every station's charging
// profile for nothing. The absolute floor keeps a tiny site from waking on
// noise.
func urgentDropKw(marginKw float64) float64 {
	if half := marginKw / 2; half > BudgetStepKw {
		return half
	}
	return BudgetStepKw
}

type restSample struct {
	at   time.Time
	rest float64
	// restNoBatt is `rest` with the battery's MEASURED charge taken back out,
	// i.e. the site's net position without the charge points AND without the
	// battery. It is what the Stufe-4 surplus lane divides (surplus.go); it
	// equals `rest` on a site with no battery measurement, so a plant without
	// one behaves exactly as before.
	restNoBatt float64
}

// NewBudgetTracker returns an idle tracker: no measurement, no budget, which
// evaluates to the static Stufe-1 budget until something is measured.
func NewBudgetTracker() *BudgetTracker { return &BudgetTracker{} }

// Observe feeds ONE PAIRED measurement of the connection point:
//
//	gridKw     the signed site grid power (+ import / − export), i.e. the same
//	           gated composite `power_kw` every other guard on the box reads
//	chargingKw the power the charge points are MEASURED drawing right now
//	complete   false when a connector that currently claims budget reports no
//	           fresh measurement of its own
//
// ⚠ An INCOMPLETE sample is not a measurement for this purpose and is
// DISCARDED, exactly as guards.ExportLimiter discards a sample missing either
// of its two channels. The reason is the stability argument in the file doc: an
// authorised connector whose draw we cannot prove makes `rest` an over-estimate
// by exactly the power we just granted, which is the oscillation. Falling into
// the staged fallback is stable, and it is honest.
//
// It returns urgent=true when this sample demands a MEANINGFULLY smaller budget
// than the one in force, so the caller can re-decide at once instead of waiting
// out its tick — that is what turns "a machine switched on in the building"
// into a reaction within one measurement cycle.
func (t *BudgetTracker) Observe(ts time.Time, gridKw, chargingKw float64, complete bool) (urgent bool) {
	return t.ObserveM(ts, Measurement{GridKw: gridKw, ChargingKw: chargingKw, Complete: complete})
}

// Measurement is ONE paired look at the connection point. It exists so the
// third channel (the battery, Stufe 4) could be added WITHOUT a five-argument
// signature and without letting a caller pair two moments by accident - the
// pairing is the whole stability argument of this file.
type Measurement struct {
	// GridKw is the signed site grid power (+ import / - export).
	GridKw float64
	// ChargingKw is the power the charge points are MEASURED drawing.
	ChargingKw float64
	// BatteryChargeKw is the power the site's battery is MEASURED taking. It
	// is only read when HaveBattery is true; a DISCHARGE belongs here as 0,
	// never as a negative number (it is not a surplus the cars could claim).
	BatteryChargeKw float64
	HaveBattery     bool
	// Complete is false when a connector that currently claims budget reports
	// no fresh measurement of its own.
	Complete bool
}

// ObserveM is Observe with the full measurement (see Measurement).
func (t *BudgetTracker) ObserveM(ts time.Time, m Measurement) (urgent bool) {
	gridKw, chargingKw := m.GridKw, m.ChargingKw
	if !budgetFinite(gridKw) || !budgetFinite(chargingKw) {
		return false
	}
	batt := 0.0
	haveBatt := false
	if m.HaveBattery && budgetFinite(m.BatteryChargeKw) && m.BatteryChargeKw > 0 {
		batt, haveBatt = m.BatteryChargeKw, true
	} else if m.HaveBattery && budgetFinite(m.BatteryChargeKw) {
		// A reported discharge (or a flat zero) IS a measurement - it says the
		// battery is taking nothing, which the cars-first lane needs to know.
		haveBatt = true
	}
	if z := t.twin(); z != nil {
		z.ObserveM(ts, m)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if !m.Complete {
		if ts.After(t.incompleteAt) {
			t.incompleteAt = ts
		}
		return false
	}
	// Out-of-order samples are ignored: the newest measurement is the truth.
	// The share path's twin re-anchors instead: a sample older than the
	// newest one is a clock that jumped back (IP-27 A8).
	if t.seen && ts.Before(t.at) {
		if !t.verankert {
			return false
		}
		t.verankernLocked(ts)
	}
	t.seen, t.at, t.gridKw, t.chargingKw = true, ts, gridKw, chargingKw
	t.battKw, t.haveBatt = batt, haveBatt
	rest := gridKw - chargingKw
	t.samples = append(t.samples, restSample{at: ts, rest: rest, restNoBatt: rest - batt})
	t.pruneLocked(ts)

	if !t.planableValid || !t.curValid {
		return false
	}
	target := measuredBudget(t.planable, t.restHoldLocked())
	return target < t.cur-urgentDropKw(t.marginKw)
}

// ObserveGridLimit feeds the OBSERVED §14a envelope at the connection point —
// the same `grid_limit_kw` channel guards.Reading carries.
//
// ⚠ Pass the value ONLY when the channel was actually reported: a §14a value of
// 0 means zero kilowatts, and only an ABSENT channel means unknown (the
// documented guards.Reading footgun). A once-observed envelope is kept, never
// aged out: it can only ever reduce the budget, and the battery guard on the
// same box keeps its last observed envelope too.
func (t *BudgetTracker) ObserveGridLimit(kw float64) {
	if !budgetFinite(kw) || kw < 0 {
		return
	}
	if z := t.twin(); z != nil {
		z.ObserveGridLimit(kw)
	}
	t.mu.Lock()
	t.have14a, t.kw14a = true, kw
	t.mu.Unlock()
}

// ObservePlanLimit arms the FAHRPLAN lane: allowedImportKw is what the SITE
// may still average over the rest of the running quarter hour so the cloud's
// peak-shaving target holds (guards.PeakTracker.AllowedImport). The vehicles'
// share of it is worked out in Budget(), where the site's other load is known.
//
// ⚠ FAIL-OPEN IS THE WHOLE POINT (Captain 20.08.2026). The lane exists only
// while it is being fed: no plan, a STALE plan, no peak target or no
// measurement means the agent calls ClearPlanLimit and the local logic applies
// UNCHANGED - a vehicle must never stand still because a plan is missing, and
// in doubt it charges. The expiry below is the second half of that promise: a
// wedged caller cannot leave a ceiling standing.
//
// ⚠ Note the deliberate ASYMMETRY to the battery guard: plan.PeakImportLimit
// is staleness-INDEPENDENT there, because the battery keeps defending the last
// known target at no cost. Here the same stale target could leave a car
// standing, so this lane drops it.
func (t *BudgetTracker) ObservePlanLimit(ts time.Time, allowedImportKw float64) {
	if !budgetFinite(allowedImportKw) || allowedImportKw < 0 {
		t.ClearPlanLimit()
		return
	}
	if z := t.twin(); z != nil {
		z.ObservePlanLimit(ts, allowedImportKw)
	}
	t.mu.Lock()
	t.planLimit, t.planLimitAt, t.havePlan = allowedImportKw, ts, true
	t.mu.Unlock()
}

// ClearPlanLimit drops the Fahrplan lane - the local logic then applies
// unchanged.
func (t *BudgetTracker) ClearPlanLimit() {
	if z := t.twin(); z != nil {
		z.ClearPlanLimit()
	}
	t.mu.Lock()
	t.havePlan, t.planLimit, t.planLimitAt = false, 0, time.Time{}
	t.mu.Unlock()
}

// planCapLocked is what the Fahrplan leaves the vehicles, or ok=false when the
// lane is not armed (or its value has expired). Caller holds t.mu.
func (t *BudgetTracker) planCapLocked(now time.Time, rest float64) (float64, bool) {
	if !t.havePlan || t.planLimitAt.IsZero() {
		return 0, false
	}
	age := now.Sub(t.planLimitAt)
	if age < 0 {
		age = 0
	}
	if age > PlanLimitFreshWindow {
		return 0, false
	}
	return round3(math.Max(0, t.planLimit-rest)), true
}

// Budget evaluates the charging budget for now.
func (t *BudgetTracker) Budget(now time.Time, set Settings) BudgetVerdict {
	set = set.WithDefaults()

	t.mu.Lock()
	defer t.mu.Unlock()

	limit := set.GridLimitKw
	res := BudgetVerdict{}
	if t.have14a {
		kw := t.kw14a
		res.Section14aKw = &kw
		if kw < limit {
			limit, res.Section14aBinds = kw, true
		}
	}
	planable := round3(limit * (1 - set.MarginPct/100))
	staticKw := budgetUnder(limit, set)
	res.LimitKw, res.PlanableKw = round3(limit), planable
	t.planable, t.planableValid = planable, true
	t.marginKw = limit - planable

	// The two ways a site is STATIC. Both hand back exactly the figure the
	// operator maintained — on a site that never measured anything this file
	// changes nothing at all, which is the whole compatibility promise.
	if set.StaticBudget {
		res.Mode, res.Kw = BudgetStatic, staticKw
		res.Reason = "Das feste Ladebudget ist eingestellt: " + kwText(staticKw) +
			" kW aus den hinterlegten Werten. Die Messung am Netzanschluss wird nicht verwendet."
		return t.finishStatic(res)
	}
	if !t.seen {
		res.Mode, res.Kw = BudgetStatic, staticKw
		res.Reason = "Noch keine Messung am Netzanschluss — es gilt das hinterlegte Budget von " +
			kwText(staticKw) + " kW (Anschluss minus die für das Gebäude reservierte Leistung)."
		if !t.incompleteAt.IsZero() {
			res.Reason = "Noch keine verwertbare Messung am Netzanschluss (ein ladender Ladepunkt " +
				"meldet keinen Messwert) — es gilt das hinterlegte Budget von " + kwText(staticKw) + " kW."
		}
		return t.finishStatic(res)
	}

	age := now.Sub(t.at)
	t.uhrsprung = false
	if age < 0 {
		age = 0
		if t.verankert {
			// the twin (IP-27 A8): an age below zero is no age - blind,
			// past every stage, until the next sample re-anchors the clock
			t.uhrsprung = true
			age = BudgetHoldWindow + BudgetContractWindow + time.Second
		}
	}
	res.MeasurementAge = age
	grid, charging := t.gridKw, t.chargingKw
	res.GridKw, res.ChargingKw = &grid, &charging

	// The safe budget is the blind one: the worst building load the operator
	// maintained, whichever of the two figures is larger. It is never more
	// generous than the static budget, so a blind site can never end up with
	// MORE charging power than a site nobody ever measured.
	safeHouse := math.Max(set.HouseReserveKw, set.MaxHouseLoadKw)
	safeKw := round3(math.Max(0, planable-safeHouse))

	switch {
	case age <= BudgetFreshWindow:
		rest := t.restHoldLocked()
		res.SiteLoadKw = &rest
		kw := measuredBudget(planable, rest)
		res.Capped = rest < -1e-9
		// ⚠ Der FAHRPLAN-Deckel wirkt NUR hier, im gemessenen Zweig, und nur
		// nach unten: die statischen und blinden Zweige bleiben unberührt
		// (fail-open by construction), und der Deckel kann nichts anheben.
		if cap, ok := t.planCapLocked(now, rest); ok {
			res.PlanLimitKw = &cap
			if cap < kw {
				kw, res.PlanLimitBinds = cap, true
			}
		}
		t.cur, t.curValid = kw, true
		res.Mode, res.Kw = BudgetMeasured, kw
		res.Reason = measuredReason(res, set)
	case t.curValid && age <= BudgetHoldWindow:
		res.Mode, res.Kw, res.Blind = BudgetHolding, round3(t.cur), true
		res.Reason = t.blindPrefix(age) + "das zuletzt berechnete Ladebudget von " +
			kwText(round3(t.cur)) + " kW wird gehalten und nicht erhöht."
	case t.curValid && age <= BudgetHoldWindow+BudgetContractWindow:
		res.Blind = true
		// A contraction NEVER raises the budget: if the safe figure happens to
		// be higher than what we were holding, we keep holding. A blind
		// controller must not release.
		if safeKw >= t.cur {
			res.Mode, res.Kw = BudgetHolding, round3(t.cur)
			res.Reason = t.blindPrefix(age) + "das zuletzt berechnete Ladebudget von " +
				kwText(round3(t.cur)) + " kW wird gehalten und nicht erhöht."
			break
		}
		frac := (age - BudgetHoldWindow).Seconds() / BudgetContractWindow.Seconds()
		frac = math.Min(math.Max(frac, 0), 1)
		res.Mode = BudgetContracting
		res.Kw = round3(t.cur - (t.cur-safeKw)*frac)
		res.Reason = t.blindPrefix(age) + "das Ladebudget wird schrittweise auf das sichere Budget von " +
			kwText(safeKw) + " kW zusammengezogen (aktuell " + kwText(res.Kw) + " kW). Ohne Messung wird nichts freigegeben."
	default:
		res.Mode, res.Kw, res.Blind = BudgetSafe, safeKw, true
		t.cur, t.curValid = safeKw, true
		res.Reason = t.blindPrefix(age) + "es gilt das sichere Ladebudget von " + kwText(safeKw) +
			" kW (Anschluss minus die höchste bekannte Gebäudelast von " + kwText(round3(safeHouse)) + " kW)."
	}
	return res
}

// finishStatic drops the commanded budget: a static site must not carry a
// measured figure into a later blind stage. Caller holds t.mu.
func (t *BudgetTracker) finishStatic(res BudgetVerdict) BudgetVerdict {
	t.curValid, t.cur = false, 0
	return res
}

// blindPrefix is the one opening every blind sentence shares, and it names the
// REAL cause: a dead telemetry path and a station that stopped metering are two
// different problems with two different levers.
func (t *BudgetTracker) blindPrefix(age time.Duration) string {
	if t.uhrsprung {
		return "Die Uhr der Box ist hinter die letzte Messung am Netzanschluss zurückgesprungen — "
	}
	if t.incompleteAt.After(t.at) {
		return "Ein ladender Ladepunkt meldet seit " + ageText(age) + " keinen Messwert — "
	}
	return "Seit " + ageText(age) + " keine Messung am Netzanschluss — "
}

// measuredBudget is the control law plus the ONE cap on it.
//
// ⚠ THE CAP IS DELIBERATE: the budget is never planned above the connection's
// own planable power, even when the site is EXPORTING and the arithmetic would
// allow it. A PV surplus that creates headroom can vanish behind a cloud in
// seconds, and no seconds-scale loop (nor a charging vehicle's ramp) can follow
// that. The surplus is still used — it lowers the measured rest and therefore
// the import — it just never RAISES the budget above the number the fuse is
// sized for. This is the same posture as the concept's own honesty about the
// loop: protection against a minutes-long overload, not against a millisecond
// peak.
func measuredBudget(planableKw, restKw float64) float64 {
	kw := planableKw - restKw
	if kw > planableKw {
		kw = planableKw
	}
	if kw < 0 {
		kw = 0
	}
	return round3(kw)
}

// restHoldLocked is the trailing MAXIMUM of the site's rest load — the whole
// smoothing mechanism (see the file doc). Caller holds t.mu.
func (t *BudgetTracker) restHoldLocked() float64 {
	rest := math.Inf(-1)
	for _, s := range t.samples {
		if s.rest > rest {
			rest = s.rest
		}
	}
	if math.IsInf(rest, -1) {
		return t.gridKw - t.chargingKw
	}
	return round3(rest)
}

// restNoBattHoldLocked is the same trailing MAXIMUM over the battery-free rest
// - the quantity the Stufe-4 surplus lane divides. Taking the maximum of the
// rest is taking the MINIMUM of the surplus, so the one window is conservative
// for both jobs. Caller holds t.mu.
func (t *BudgetTracker) restNoBattHoldLocked() float64 {
	rest := math.Inf(-1)
	for _, s := range t.samples {
		if s.restNoBatt > rest {
			rest = s.restNoBatt
		}
	}
	if math.IsInf(rest, -1) {
		return t.gridKw - t.chargingKw - t.battKw
	}
	return round3(rest)
}

func (t *BudgetTracker) pruneLocked(now time.Time) {
	cut := now.Add(-BudgetSmoothWindow)
	i := 0
	for ; i < len(t.samples); i++ {
		if !t.samples[i].at.Before(cut) {
			break
		}
	}
	t.samples = t.samples[i:]
	if n := len(t.samples); n > budgetMaxSamples {
		t.samples = t.samples[n-budgetMaxSamples:]
	}
}

// measuredReason spells the arithmetic out, because that is what a customer can
// check against their own meter.
func measuredReason(v BudgetVerdict, set Settings) string {
	rest := 0.0
	if v.SiteLoadKw != nil {
		rest = *v.SiteLoadKw
	}
	var b strings.Builder
	b.WriteString("Das Ladebudget folgt der Messung am Netzanschluss: ")
	b.WriteString(kwText(v.PlanableKw))
	b.WriteString(" kW planbar (")
	b.WriteString(kwText(v.LimitKw))
	b.WriteString(" kW Anschluss − ")
	b.WriteString(pctText(set.MarginPct))
	b.WriteString(" % Sicherheitsabstand) − ")
	b.WriteString(kwText(rest))
	b.WriteString(" kW übriger Standortbezug = ")
	b.WriteString(kwText(v.Kw))
	b.WriteString(" kW.")
	if v.Section14aBinds && v.Section14aKw != nil {
		b.WriteString(" Der Netzbetreiber begrenzt den Anschluss gerade auf ")
		b.WriteString(kwText(*v.Section14aKw))
		b.WriteString(" kW (§ 14a) — diese Grenze gilt vor der hinterlegten Anschlussgrenze.")
	}
	if v.PlanLimitBinds && v.PlanLimitKw != nil {
		b.WriteString(" Der Fahrplan hält gerade die Lastspitze — dafür bleiben den Fahrzeugen in dieser Viertelstunde ")
		b.WriteString(kwText(*v.PlanLimitKw))
		b.WriteString(" kW.")
	}
	if v.Capped {
		b.WriteString(" Der Standort speist gerade ein; mehr als der Anschluss trägt wird trotzdem nicht verplant.")
	}
	return b.String()
}

// budgetUnder is Settings.BudgetKw() for an arbitrary connection limit, so the
// §14a envelope can be folded in WITHOUT a second copy of the order of
// operations (the margin comes off the connection first, then the building —
// see Settings.BudgetKw).
func budgetUnder(limitKw float64, s Settings) float64 {
	planable := limitKw * (1 - s.MarginPct/100)
	free := planable - s.HouseReserveKw
	if free <= 0 {
		return 0
	}
	return round3(free)
}

func budgetFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// kwText renders a kW value the German way (one decimal, comma) so every
// sentence on this path reads like the rest of the device's copy.
func kwText(v float64) string {
	return strings.Replace(fmt.Sprintf("%.1f", v), ".", ",", 1)
}

func pctText(v float64) string {
	return strings.Replace(strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.1f", v), "0"), "."), ".", ",", 1)
}

// ageText renders a measurement gap as "45 s" / "3 min".
func ageText(d time.Duration) string {
	if d < 90*time.Second {
		return fmt.Sprintf("%d s", int(d.Round(time.Second)/time.Second))
	}
	return fmt.Sprintf("%d min", int(d.Round(time.Minute)/time.Minute))
}
