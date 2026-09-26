package guards

// The feed-in watchdog WITH A SHARE (UEMS AP-15 IP-18, rules V1, V2, V4-V6,
// G1, B2; concept vp-uems-ap15-verbund §3.6/§4.6). Several boxes behind ONE
// connection point hold its feed-in limit together: each holds an own share
// (internal/anteile - stored, without expiry, back before the first
// measurement). Only two things change against the single-box watchdog in
// exportlimit.go: WHERE the limit comes from, and the ROLE of the box.
//
//	role         loop (fresh)                       blind
//	fuehrt       whole limit at the connection      no hold: linear within
//	             point, as today                    ExportAnteilWindow to the share
//	steuert_mit  the share at its OWN measuring     the same - it is blind towards
//	(or none)    point (feeder meter, or the sum    the connection point by nature,
//	             of its own devices)                so the share always holds
//
// A document without a role (the field is optional) is treated like
// steuert_mit: the share holds at the box's own point, always - the safe side.
// The whole limit of the connection point is never an input of such a box
// (G1): its loop limit is its share.
//
// The share covers EVERYTHING the box pushes into the grid (V6): generation
// PLUS discharge <= share. So with a share the watchdog gets the battery
// discharge as a second actuator - only lowering, never charging, never
// raising: blind it lowers the discharge to the share, with a fresh
// measurement it is the LAST actuator, touched only once the producers are
// already at 0. Without a share document nothing here runs and exportlimit.go
// is byte for byte what it was.
//
// SAFE BY CONSTRUCTION, NOT BY ARGUMENT (V5, "ein Waechter erweitert nie"):
// CapAnteil runs the unchanged staged evaluation of exportlimit.go against
// the loop limit with the share's safe cap, lowers only, and finally takes the
// minimum with a shadow of the SAME box without a share (today's Cap on the
// same measurements, plan limit and discharge). A share can therefore never
// release what the same box would hold without it.
//
// A STANDING VALUE PROVES NO HEADROOM (AP-15 Folge of IP-28 finding 1,
// B2/V5): a sample whose grid value repeats the one before bit for bit is no
// new measurement of the connection point - only its PV and battery are new.
// On such a sample generation plus discharge stay within what the sample on
// which the value last moved proved: its generation and discharge then plus
// its headroom (stehBeleg). Its headroom is released once, braked as always,
// but never found again. Without it a meter that froze in the dip of a
// probing adjustment was read against the PV that followed each release -
// the frozen grid value never showed it - and the loop found the same
// headroom again on every sample (K-1 8.0 -> 10.1 -> 12.2 kW in the
// container) until the probe judged the value blind. Not a lock on the
// newest sample: the box samples every 2 s and regulates every 10 s, so the
// sample that moved is often not the one a tick reads - a healthy noise-free
// meter still gets its release. A value that moves with every sample is
// exactly today's.

import (
	"fmt"
	"math"
	"time"
)

// ExportAnteilWindow is how long a box holding a share takes, once its own
// measurement is older than ExportFreshWindow, to arrive at its share (V2):
// linear and WITHOUT the hold phase of the single-box watchdog. Behind one
// connection point with a partner, holding is not defensible - the partner
// may raise its feed-in to its own share at any time (a gap in the clouds).
// So a box is on its share at most ExportFreshWindow + ExportAnteilWindow
// (90 s) after its last measurement, against 390 s without a share (R9).
const ExportAnteilWindow = 60 * time.Second

// ohneStehSperre switches "a standing value proves no headroom" off - the
// mutation probe of the tests (stehender_wert_test.go), never set outside them.
var ohneStehSperre bool

// ohneJeMessung counts the headroom of einSpielraum (and the rise of its
// counterpart einAnstieg) per evaluation again, as on uems - the mutation
// probe of einspielraum_je_messung_test.go, never set outside it.
var ohneJeMessung bool

// ohneAnstieg switches the healing of A8r off - a rising battery push and a
// charge while the clock runs in the past lower nothing, as on uems: the
// mutation probe of anstieg_senkt_test.go, never set outside it.
var ohneAnstieg bool

// ohneRampenAnstieg switches rampAnstieg off - a rising battery push on the
// blind ramp lowers nothing, as on uems: the mutation probe of
// rampe_anstieg_test.go, never set outside it.
var ohneRampenAnstieg bool

// ohneAnlauf lets einAnstieg start only after a push was let through, as on
// uems (the first evaluation counts no rise): the mutation probe of
// rampe_anstieg_test.go, never set outside it.
var ohneAnlauf bool

// ExportAnteil is the own feed-in share of a held share document.
type ExportAnteil struct {
	// AnteilKw is the box's own share in the direction einspeisung (kW).
	AnteilKw float64
	// Fuehrt is true for the leading box (rolle fuehrt, it measures the
	// connection point). False for steuert_mit AND for a document without a
	// role: the share then holds at the box's own point, always.
	Fuehrt bool
	// EingefrorenSeit is set while the box's own measured value counts as
	// frozen (B2, Einfrierprobe): the time of its last change. The watchdog
	// then treats the value as a measurement that old - blind, the same
	// stages as a measurement gone quiet. Zero = not frozen.
	EingefrorenSeit time.Time
	// Pruefen is set while the Einfrierprobe asks for a probing adjustment in
	// the feed-in direction (IP-27 A7, Einfrierprobe.Pruefung): the value has
	// stood still for PruefStillstand, or the answer window of the probe runs.
	// The watchdog then lowers ONCE by PruefSenkKw - only above its share and
	// only what must reach its own point - and holds that point until the
	// probe has answered. ExportCap.Pruefung reports the lowering.
	Pruefen bool
	// PruefenNeu: the probe is due, no watchdog made it yet in this
	// standstill - only then may this one START it (once per standstill).
	PruefenNeu bool
	// LadenKw is the battery charge the setpoint path is about to command
	// (kW >= 0; a discharge is 0), the counterpart of dischargeKw: together
	// they are the battery's push, which einAnstieg compares with the push
	// the measurement was taken under. Zero = no charge.
	LadenKw float64
}

// CapAnteil evaluates the watchdog for a box that holds a share document.
//
// limitKw is the plan's whole feed-in limit at the connection point (nil =
// none, or no plan at all - the share holds anyway, V5); only the leading box
// regulates against it. dischargeKw is the battery discharge the setpoint
// path is about to command (kW >= 0; a charge is 0), BEFORE this guard.
//
// The result is always Active. CapKw is the plant PV cap as with Cap;
// DischargeCapKw, when set, is the ceiling the caller must lower the
// commanded discharge to (never a charge, never a raise).
func (l *ExportLimiter) CapAnteil(now time.Time, limitKw *float64, an ExportAnteil, dischargeKw float64) ExportCap {
	anteil := an.AnteilKw
	if !finite(anteil) || anteil < 0 {
		anteil = 0
	}
	discharge := dischargeKw
	if !finite(discharge) || discharge < 0 {
		discharge = 0
	}
	laden := an.LadenKw
	if !finite(laden) || laden < 0 || discharge > 0 {
		laden = 0
	}
	// budget: what generation and discharge together may push at the box's
	// point when it is blind - its share (never above the whole limit).
	budget, loop := anteil, anteil
	if an.Fuehrt && limitKw != nil && finite(*limitKw) && *limitKw >= 0 {
		loop = *limitKw
		budget = math.Min(anteil, loop)
	}
	safePv := math.Max(budget-discharge, 0)

	// V5 by construction: the SAME box without a share runs alongside,
	// unchanged, on the same measurements - the share only ever lowers it.
	l.mu.Lock()
	shadow := l.schattenLocked()
	l.mu.Unlock()
	heuteStatic := 0.0
	if limitKw != nil && finite(*limitKw) {
		heuteStatic = math.Max(*limitKw-discharge, 0)
	}
	heute := shadow.Cap(now, limitKw, heuteStatic)

	l.mu.Lock()
	defer l.mu.Unlock()
	// B2: a frozen value is no measurement - its age counts from its last
	// change, so it goes blind exactly like one that stopped arriving.
	at := l.at
	eingefroren := l.seen && !an.EingefrorenSeit.IsZero() && !an.EingefrorenSeit.After(at)
	if eingefroren {
		at = an.EingefrorenSeit
	}
	// A8 (IP-27): an age below zero is no age - the clock went back behind
	// the measurement. Blind, never clamped to "fresh": the measurement counts
	// as older than every window until the next one re-anchors the clock
	// (ObserveMitSpeicher).
	uhrsprung := l.seen && now.Before(at)
	if uhrsprung {
		at = now.Add(-(ExportFreshWindow + ExportAnteilWindow + time.Second))
	}
	// K6's cascade (CapCascade) belongs to the single box's own leader: a
	// share document runs without an inner loop, so a loop armed by an earlier
	// CapCascade never survives into the share (Nachzug main 26.09.2026).
	l.armInner(InnerLoop{})
	res := l.capLockedAb(now, at, loop, safePv)
	res.AnteilKw = &anteil
	res.Eingefroren = eingefroren && res.Blind
	res.Uhrsprung = uhrsprung
	if !an.Pruefen || res.Blind {
		l.pruefValid = false
	}
	switch {
	case !res.Blind:
		l.rampValid = false
		dcapVor, dcapVorValid := l.dcap, l.dcapValid
		l.dischargeFresh(now, loop, discharge, &res)
		l.einSpielraum(now, loop, discharge, dcapVor, dcapVorValid, &res)
		if !ohneAnstieg {
			if l.vergangenheit {
				l.ladungVorDemSprung(now, loop, &res)
			}
			l.einAnstieg(now, loop, discharge, laden, &res)
		}
		if l.steht && !ohneStehSperre {
			l.stehBeleg(now, loop, discharge, &res)
		}
		if an.Pruefen {
			l.pruefen(now, budget, discharge, an.PruefenNeu, &res)
		}
	case !l.seen || res.MeasurementAge > ExportFreshWindow+ExportAnteilWindow:
		// never measured (R15: the share holds before the first measurement)
		// or past the ramp: the share, for generation AND discharge together.
		// A cap already held below it stays (the staged evaluation above holds
		// it) - a blind controller releases nothing.
		pv := math.Min(res.CapKw, safePv)
		l.setBlind(now, pv, budget)
		res.CapKw = round3(pv)
		l.dischargeReport(discharge, &res)
		if pv >= safePv-1e-9 || !l.seen {
			res.State = ExportSafeCap
		}
	default:
		frac := l.ramp(now, res.MeasurementAge, safePv, budget, discharge, &res)
		if !ohneRampenAnstieg {
			l.rampAnstieg(now, frac, budget, discharge, laden, &res)
		}
	}
	l.anteilReason(an.Fuehrt, budget, discharge, &res)
	l.stellKw, l.stellValid = l.schub(discharge, laden), true
	if heute.Active {
		h := heute.CapKw
		res.HeuteCapKw = &h
	}
	if heute.Active && heute.CapKw < res.CapKw {
		// today's staged evaluation is the tighter one right now (e.g. it
		// restarted from its static cap after the plan's limit came back):
		// it binds, with its own verdict
		res.CapKw, res.State, res.Reason = heute.CapKw, heute.State, heute.Reason
	}
	return res
}

// ramp pulls generation and discharge linearly within ExportAnteilWindow to
// the share, without holding (V2/V4), and returns how far it is (0..1).
// Caller holds l.mu.
func (l *ExportLimiter) ramp(now time.Time, age time.Duration, safePv, budget, discharge float64, res *ExportCap) float64 {
	if !l.rampValid {
		// the operating point at the onset of blindness: the last cap and the
		// discharge that was really allowed
		l.rampValid, l.rampPv, l.rampDis = true, l.cap, discharge
		if l.dcapValid && l.dcap < discharge {
			l.rampDis = l.dcap
		}
		l.rampSchub = l.schubVor()
	}
	frac := (age - ExportFreshWindow).Seconds() / ExportAnteilWindow.Seconds()
	frac = math.Min(math.Max(frac, 0), 1)
	pv := l.rampPv
	if pv > safePv {
		pv -= (pv - safePv) * frac
	}
	dis := l.rampDis
	if dis > budget {
		dis -= (dis - budget) * frac
	}
	// most restrictive wins against the staged evaluation of today
	pv = math.Min(pv, res.CapKw)
	l.setBlind(now, pv, dis)
	res.CapKw = round3(pv)
	l.dischargeReport(discharge, res)
	switch {
	case pv < safePv-1e-9 && l.rampPv <= safePv && l.rampDis <= budget:
		// already below the share when the measurement went away: kept, never
		// raised while blind
		res.State = ExportHolding
	case frac >= 1 || (pv <= safePv+1e-9 && dis <= budget+1e-9):
		// arrived: generation and discharge together on the share
		res.State = ExportSafeCap
	default:
		res.State = ExportContracting
	}
	return frac
}

// rampAnstieg is einAnstieg on the blind ramp (V6 in EVERY evaluation, also
// blind): the ramp pulls generation and discharge from the operating point at
// the onset of blindness, and that point held with the battery where it
// stood then - a charge took part of the producers' power. When the setpoint
// path raises the battery's push above the push the ramp began with (the plan
// comes back during the ramp: a charge drops, a discharge rises), the
// producers are lowered by that rise in the same evaluation, never below 0,
// and what goes beyond them lowers the discharge (the last actuator). A push
// above the share at the onset is pulled along the ramp like the discharge
// itself - generation and discharge reach the share together. The ramp
// itself stays (60 s linear, V2); this only ever lowers, command-side,
// without a measurement. Caller holds l.mu, after ramp.
func (l *ExportLimiter) rampAnstieg(now time.Time, frac, budget, discharge, laden float64, res *ExportCap) {
	vor := l.rampSchub - math.Max(l.rampSchub-budget, 0)*frac
	anstieg := l.schub(discharge, laden) - vor
	if anstieg <= 1e-9 {
		return
	}
	rest := l.cap - anstieg
	if pv := math.Max(rest, 0); l.cap > pv {
		l.cap, l.capAt = pv, now
		res.CapKw = round3(pv)
	}
	dis := l.schub(discharge, 0)
	if rest < 0 && dis > 0 {
		l.dcap, l.dcapValid, l.dcapAt = math.Max(dis+rest, 0), true, now
		l.dischargeReport(discharge, res)
	}
}

// setBlind stores what a blind evaluation commands, so that the first fresh
// measurement releases from HERE, braked - not from the cap before the gap.
func (l *ExportLimiter) setBlind(now time.Time, pv, dis float64) {
	l.cap, l.capValid, l.capAt = pv, true, now
	l.dcap, l.dcapValid, l.dcapAt = dis, true, now
}

// dischargeFresh is V6 with a fresh measurement: the discharge is the LAST
// actuator. The total the box may push is measured PV + measured discharge +
// headroom - margin; the producers take the cut first (exportlimit.go's law is
// exactly total - discharge), and only what remains below the discharge
// lowers it. Tightening immediate, releasing rate-limited - as for the PV cap.
// Caller holds l.mu.
func (l *ExportLimiter) dischargeFresh(now time.Time, limit, discharge float64, res *ExportCap) {
	target := l.dischargeTarget(limit, discharge)
	switch {
	case !l.dcapValid:
		if target >= discharge {
			return
		}
		l.dcap, l.dcapValid, l.dcapAt = target, true, now
	case target <= l.dcap-ExportStepKw:
		l.dcap, l.dcapAt = target, now
	case target <= l.dcap:
		l.dcapAt = now
	default:
		elapsed := now.Sub(l.dcapAt)
		if elapsed < 0 {
			elapsed = 0
		}
		next := math.Min(target, l.dcap+releaseRate(limit)*elapsed.Seconds())
		if next-l.dcap >= ExportStepKw || next >= target {
			l.dcap, l.dcapAt = next, now
		}
	}
	l.dischargeReport(discharge, res)
}

// dischargeTarget is the discharge ceiling the newest measurement supports:
// what is left of the box's total once the producers are at 0. The discharge
// at the measurement is the MEASURED battery when the sample carried one,
// else what was really allowed (commanded, capped). Caller holds l.mu.
func (l *ExportLimiter) dischargeTarget(limit, discharge float64) float64 {
	return l.dischargeTargetAt(l.gridKw, l.pvKw, limit, discharge)
}

func (l *ExportLimiter) dischargeTargetAt(gridKw, pvKw, limit, discharge float64) float64 {
	dis := discharge
	if l.dcapValid && l.dcap < dis {
		dis = l.dcap
	}
	if l.battValid {
		dis = math.Max(-l.battKw, 0)
	}
	exportKw := math.Max(-gridKw, 0)
	return math.Max(pvKw+dis+(limit-exportKw)-exportMargin(limit), 0)
}

// dischargeReport sets DischargeCapKw only while it binds - a ceiling above
// the commanded discharge changes nothing and claims nothing.
func (l *ExportLimiter) dischargeReport(discharge float64, res *ExportCap) {
	if l.dcapValid && l.dcap < discharge {
		v := round3(math.Max(l.dcap, 0))
		res.DischargeCapKw = &v
	}
}

// pruefen is the probing adjustment of IP-27 A7 on a fresh measurement (the
// Einfrierprobe asked for it, an.Pruefen). At its start it lowers ONCE what
// must reach the box's own point by PruefSenkKw - generation first, the
// discharge only when the producers have less (V6: the discharge is the last
// actuator) - and only while generation plus discharge, MEASURED, run above
// the share (the same quantity the box falls back to blind). Under the share,
// or with nothing effectively lowerable, it does nothing: no adjustment that
// could not show, and so no verdict from the probe. Until the probe answers it
// holds that point - no release credit accrues - and a value that moves then
// releases from there, braked, like after every blind state. Caller holds l.mu.
func (l *ExportLimiter) pruefen(now time.Time, budget, discharge float64, neu bool, res *ExportCap) {
	if !l.pruefValid {
		if !neu {
			return
		}
		dis := 0.0
		if l.battValid && l.battKw < 0 {
			dis = -l.battKw
		}
		if l.pvKw+dis <= budget {
			return
		}
		pv := math.Min(l.cap, l.pvKw)
		switch {
		case pv >= PruefSenkKw:
			l.pruefPv, l.pruefDis = pv-PruefSenkKw, math.Inf(1)
		case dis >= PruefSenkKw:
			l.pruefPv, l.pruefDis = math.Inf(1), dis-PruefSenkKw
		default:
			return
		}
		l.pruefValid = true
		res.Pruefung = true
	}
	if l.cap > l.pruefPv {
		l.cap = l.pruefPv
	}
	l.capAt = now
	res.CapKw = round3(l.cap)
	if !math.IsInf(l.pruefDis, 1) {
		if !l.dcapValid || l.dcap > l.pruefDis {
			l.dcap, l.dcapValid = l.pruefDis, true
		}
		l.dcapAt = now
		l.dischargeReport(discharge, res)
	}
}

// schattenLocked is the shadow of V5 - the same box WITHOUT a share. It
// starts as a copy of what this watchdog held until now (without a document
// it WAS today's watchdog: Observe and Cap), so it continues exactly where
// today's would, and from then on it gets every sample through today's
// Observe - which re-anchors on a clock that jumped back, exactly as the
// single box does (A8). Caller holds l.mu.
func (l *ExportLimiter) schattenLocked() *ExportLimiter {
	if l.heute == nil {
		l.heute = &ExportLimiter{
			seen: l.seen, at: l.at, gridKw: l.gridKw, pvKw: l.pvKw,
			capValid: l.capValid, cap: l.cap, capAt: l.capAt,
			limitValid: l.limitValid, limit: l.limit,
			uhrBlind: l.uhrBlind, uhrAb: l.uhrAb,
		}
	}
	return l.heute
}

// einSpielraum gives the headroom of ONE fresh measurement out once (IP-18
// finding of IP-27): the PV law (exportlimit.go) and the discharge law above
// each see all of it, so after a state in which both actuators were lowered -
// blind on the share, or a probing adjustment - both released it, and the
// plant pushed that headroom twice. Now the discharge takes first what its
// ceiling rose on this measurement (the last actuator to be cut is the first
// to be released, V6), and the producers get what is left: the PV cap is at
// most the PV law's target minus that rise - over ALL evaluations of the one
// measurement, not per evaluation. Only the RISE of the ceiling counts -
// never the gap between a plan and a battery that cannot follow it (SoC,
// limits), which would hold the producers down for nothing. A ceiling born in
// this evaluation rises from the discharge measured under it. Caller holds
// l.mu.
func (l *ExportLimiter) einSpielraum(now time.Time, limit, discharge, dcapVor float64, vorValid bool, res *ExportCap) {
	if !l.dcapValid {
		return
	}
	vor := discharge
	switch {
	case vorValid:
		vor = math.Min(dcapVor, discharge)
	case l.battValid:
		vor = math.Min(math.Max(-l.battKw, 0), discharge)
	}
	// ONE measurement, not one evaluation: a second evaluation of the same
	// sample (an urgent nudge and the tick before the next sample) counts
	// the rise from where the ceiling stood before the FIRST one - what the
	// discharge took there is taken from the producers again. Only ever a
	// larger rise, so only ever a lower PV cap (V5).
	if l.spielraumValid && l.spielraumMessung == l.messung && !ohneJeMessung {
		vor = math.Min(vor, l.spielraumVor)
	} else {
		l.spielraumValid, l.spielraumMessung, l.spielraumVor = true, l.messung, vor
	}
	anstieg := math.Min(l.dcap, discharge) - vor
	if anstieg <= 0 {
		return
	}
	rest := math.Max(closedLoopCap(limit, l.gridKw, l.pvKw)-anstieg, 0)
	if l.cap > rest {
		l.cap, l.capAt = rest, now
		res.CapKw = round3(l.cap)
	}
}

// einAnstieg is einSpielraum in the other direction (V6 in EVERY
// evaluation): the PV law and the discharge law read the newest measurement
// with the battery where it stood when it was taken - and count a charging
// battery as no discharge at all. When the setpoint path raises the battery's
// push above that (the plan comes back and the battery goes from charging to
// discharging, a charge drops, a discharge rises), the measurement's headroom
// is spent on that rise first: the producers get the PV law's target minus
// the rise, at once in this evaluation, and what goes beyond the producers
// lowers the discharge (the last actuator, V6). The rise counts from the push
// before the FIRST evaluation of this measurement - the measured battery, or
// the push let through before when the battery did not follow it: only a
// RISE of the command counts, never a battery that cannot follow it, which
// would hold the producers down for nothing. Only ever lowers. Caller holds
// l.mu.
func (l *ExportLimiter) einAnstieg(now time.Time, limit, discharge, laden float64, res *ExportCap) {
	if !l.stellValid && ohneAnlauf {
		return
	}
	vor := l.schubVor()
	if l.anstiegValid && l.anstiegMessung == l.messung && !ohneJeMessung {
		vor = math.Min(vor, l.anstiegVor)
	} else {
		l.anstiegValid, l.anstiegMessung, l.anstiegVor = true, l.messung, vor
	}
	anstieg := l.schub(discharge, laden) - vor
	if anstieg <= 1e-9 {
		return
	}
	rest := closedLoopCap(limit, l.gridKw, l.pvKw) - anstieg
	if pv := math.Max(rest, 0); l.cap > pv {
		l.cap, l.capAt = pv, now
		res.CapKw = round3(pv)
	}
	dis := l.schub(discharge, 0)
	if rest < 0 && dis > 0 {
		l.dcap, l.dcapValid, l.dcapAt = math.Max(dis+rest, 0), true, now
		l.dischargeReport(discharge, res)
	}
}

// ladungVorDemSprung: while the box's clock runs behind the newest sample it
// had before it jumped back (A8r), a charge proves no headroom - the same
// uncertainty as a standing value. The watchdog re-anchors and regulates on
// the samples after the jump, but the plan it executes is anchored on the
// clock before the jump: its slots come back when the clock reaches them
// again, and with them a discharge instead of the charge that took the
// producers' power until then (the self-consumption fallback while no slot
// covers the clock). The producers are held where they would push the limit
// with the charge gone; the discharge then gets its share from einAnstieg.
// Only ever lowers; a sample after the old newest one ends it. Caller holds
// l.mu.
func (l *ExportLimiter) ladungVorDemSprung(now time.Time, limit float64, res *ExportCap) {
	if !l.battValid || l.battKw <= 0 {
		return
	}
	pv := math.Max(closedLoopCap(limit, l.gridKw, l.pvKw)-l.battKw, 0)
	if l.cap > pv {
		l.cap, l.capAt = pv, now
		res.CapKw = round3(pv)
	}
}

// schubVor is the push a rise counts from: the push the last evaluation let
// through, or the measured battery when it pushed more (a battery that did
// not follow the command - only a RISE of the command counts). Before the
// first evaluation no push was let through: push 0, so the very first
// evaluation already counts a commanded discharge as a rise (Anlauf). Caller
// holds l.mu.
func (l *ExportLimiter) schubVor() float64 {
	vor := 0.0
	if l.stellValid {
		vor = l.stellKw
	}
	if l.battValid {
		vor = math.Max(vor, -l.battKw)
	}
	return vor
}

// schub is the battery push the evaluation lets through (+ discharge /
// - charge, kW): the commanded discharge under its ceiling, or the charge.
// Caller holds l.mu.
func (l *ExportLimiter) schub(discharge, laden float64) float64 {
	if laden > 0 {
		return -laden
	}
	if l.dcapValid && l.dcap < discharge {
		return math.Max(l.dcap, 0)
	}
	return discharge
}

// stehBeleg bounds what the box pushes on a standing value by what the last
// value that moved proved: its generation and discharge then, plus its
// headroom (see the file doc). The laws above read the newest PV and battery,
// which followed every release while the frozen grid value did not show it -
// they would find the same headroom again on every sample; this takes back
// whatever goes beyond the proof. The producers are cut first (V6: the discharge is the last
// actuator). Only ever lowers; on a healthy standing value (nothing moved,
// nothing released) the loop already sits exactly on the proof. Caller holds
// l.mu.
func (l *ExportLimiter) stehBeleg(now time.Time, limit, discharge float64, res *ExportCap) {
	dis := discharge
	if l.dcapValid && l.dcap < dis {
		dis = l.dcap
	}
	disA := dis
	if l.ankerBattValid {
		disA = math.Max(-l.ankerBatt, 0)
	}
	beleg := math.Max(l.ankerPv+disA+limit-math.Max(-l.gridKw, 0)-exportMargin(limit), 0)
	ueber := l.cap + dis - beleg
	if ueber <= 1e-9 {
		return
	}
	pv := math.Max(l.cap-ueber, 0)
	ueber -= l.cap - pv
	l.cap, l.capAt = pv, now
	res.CapKw = round3(pv)
	if ueber > 1e-9 {
		l.dcap, l.dcapValid, l.dcapAt = math.Max(dis-ueber, 0), true, now
		l.dischargeReport(discharge, res)
	}
}

// verankern re-anchors the watchdog on a clock that went back to ts (A8):
// the sample at ts becomes the newest, and the release credit counts from it
// at the earliest - the time before the jump is no time on the new clock, and
// a merely reordered sample can never earn a faster release. Caller holds l.mu.
func (l *ExportLimiter) verankern(ts time.Time) {
	l.at = ts
	if l.capAt.After(ts) {
		l.capAt = ts
	}
	if l.dcapAt.After(ts) {
		l.dcapAt = ts
	}
}

// ObserveMitSpeicher is Observe plus the measured battery power of the same
// sample (kW, + charge / - discharge; nil = not measured - unknown is not
// zero). Only a box holding a share uses the battery (V6); for every other
// box this is Observe.
func (l *ExportLimiter) ObserveMitSpeicher(ts time.Time, gridKw, pvKw float64, battKw *float64) (urgent bool) {
	if !finite(gridKw) || !finite(pvKw) {
		return false
	}
	l.mu.Lock()
	shadow := l.schattenLocked()
	if l.seen && ts.Before(l.at) {
		// A8 (IP-27): a sample older than the newest one is a clock that
		// jumped back, not a stale sample - re-anchor instead of discarding
		// every sample until the clock has caught up. The shadow below keeps
		// today's rule (it IS today). As in the Einfrierprobe, the jump
		// sample's value proves nothing: it counts as standing.
		if !l.vergangenheit || l.at.After(l.sprungBis) {
			l.sprungBis = l.at
		}
		l.vergangenheit = true
		l.verankern(ts)
		l.steht = l.wertValid
	} else {
		if l.vergangenheit && ts.After(l.sprungBis) {
			l.vergangenheit = false
		}
		l.steht = l.wertValid && gridKw == l.wertKw
		l.wertValid, l.wertKw = true, gridKw
		if !l.steht {
			l.ankerPv, l.ankerBattValid = math.Max(pvKw, 0), battKw != nil && finite(*battKw)
			if l.ankerBattValid {
				l.ankerBatt = *battKw
			}
		}
	}
	l.battValid = battKw != nil && finite(*battKw)
	if l.battValid {
		l.battKw = *battKw
	}
	// the same measurement the PV law reads in Observe, judged for the
	// discharge: a tighter discharge ceiling republishes at once, too
	urgentDis := l.limitValid && l.dcapValid &&
		l.dischargeTargetAt(gridKw, math.Max(pvKw, 0), l.limit, l.dcap) < l.dcap-ExportStepKw
	l.mu.Unlock()
	if shadow != nil {
		shadow.Observe(ts, gridKw, pvKw)
	}
	return l.Observe(ts, gridKw, pvKw) || urgentDis
}

// GeraeteSummeNetz is the measuring point of a box without its own meter
// (B3, "Summe ihrer Geraeteleistungen"), in the sign of the grid channel
// (+ import / - export): what its producers and its battery push out, i.e.
// battery - PV. Without a measured battery there is no sum (ok = false) - a
// discharge the box cannot see is not zero.
func GeraeteSummeNetz(pvKw float64, battKw *float64) (gridKw float64, ok bool) {
	if battKw == nil || !finite(*battKw) || !finite(pvKw) {
		return 0, false
	}
	return *battKw - math.Max(pvKw, 0), true
}

// anteilReason words the verdict for a box holding a share. The sentence is
// written here, once, like every other reason of this guard. Caller holds l.mu.
func (l *ExportLimiter) anteilReason(fuehrt bool, budget, discharge float64, res *ExportCap) {
	wo := "am Messpunkt dieser Box"
	if fuehrt {
		wo = "am Netzverknuepfungspunkt"
	}
	entladung := ""
	if res.DischargeCapKw != nil {
		entladung = fmt.Sprintf(" Die Entladung des Speichers ist dafuer von %s auf %s kW gesenkt.",
			kw1(discharge), kw1(*res.DischargeCapKw))
	}
	switch res.State {
	case ExportLimiting, ExportWatching:
		if fuehrt {
			res.Reason += entladung
			return
		}
		exportKw, pv := 0.0, 0.0
		if res.ExportKw != nil && res.PvKw != nil {
			exportKw, pv = *res.ExportKw, *res.PvKw
		}
		if res.State == ExportLimiting {
			res.Reason = fmt.Sprintf(
				"Die Erzeuger sind auf %s kW begrenzt, damit der Anteil dieser Box von %s kW an "+
					"ihrem Messpunkt eingehalten wird (aktuell %s kW Einspeisung bei %s kW Erzeugung). "+
					"Das ist eine bewusste Begrenzung, kein Fehler der Anlage.%s",
				kw1(res.CapKw), kw1(res.LimitKw), kw1(exportKw), kw1(pv), entladung)
			return
		}
		res.Reason = fmt.Sprintf(
			"Die Einspeisung am Messpunkt dieser Box liegt bei %s kW von %s kW (Anteil dieser Box) - "+
				"die Erzeuger sind vorsorglich auf %s kW begrenzt, greifen dort aber nicht an "+
				"(Erzeugung %s kW).%s",
			kw1(exportKw), kw1(res.LimitKw), kw1(res.CapKw), kw1(pv), entladung)
	case ExportHolding:
		res.Reason = fmt.Sprintf(
			"%s - die zuletzt gesetzte Begrenzung von %s kW liegt schon "+
				"unter dem Anteil dieser Box von %s kW und wird gehalten, nicht freigegeben.%s",
			blindSatz(res, wo), kw1(res.CapKw), kw1(budget), entladung)
	case ExportContracting:
		res.Reason = fmt.Sprintf(
			"%s - Erzeugung und Entladung werden ohne Halten auf den Anteil "+
				"dieser Box von %s kW gefuehrt (Erzeuger aktuell %s kW). Freigegeben wird ohne "+
				"Messung nichts.%s",
			blindSatz(res, wo), kw1(budget), kw1(res.CapKw), entladung)
	default:
		if !l.seen {
			res.Reason = fmt.Sprintf(
				"Noch keine Messung %s - Erzeugung und Entladung zusammen sind vorsorglich auf den "+
					"Anteil dieser Box von %s kW begrenzt (Erzeuger %s kW).%s",
				wo, kw1(budget), kw1(res.CapKw), entladung)
			return
		}
		res.Reason = fmt.Sprintf(
			"%s - Erzeugung und Entladung zusammen liegen auf dem Anteil "+
				"dieser Box von %s kW, der ohne jede Messung gilt (Erzeuger %s kW).%s",
			blindSatz(res, wo), kw1(budget), kw1(res.CapKw), entladung)
	}
}

// blindSatz opens the sentence of a blind verdict: the measurement stopped
// arriving - or it arrives, frozen (B2).
func blindSatz(res *ExportCap, wo string) string {
	if res.Uhrsprung {
		return fmt.Sprintf("Die Uhr dieser Box ist hinter die letzte Messung %s zurückgesprungen - "+
			"bis zur nächsten Messung gilt sie als blind", wo)
	}
	if res.Eingefroren {
		return fmt.Sprintf("Der Messwert %s steht seit %s still, obwohl diese Box selbst um "+
			"mindestens %s kW verstellt hat - er gilt als eingefroren",
			wo, age1(res.MeasurementAge), kw1(EinfrierStellKw))
	}
	return fmt.Sprintf("Seit %s keine Messung %s", age1(res.MeasurementAge), wo)
}
