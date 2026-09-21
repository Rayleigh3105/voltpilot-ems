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
	if l.heute == nil {
		l.heute = NewExportLimiter()
	}
	shadow := l.heute
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
	res := l.capLockedAb(now, at, loop, safePv)
	res.AnteilKw = &anteil
	res.Eingefroren = eingefroren && res.Blind
	switch {
	case !res.Blind:
		l.rampValid = false
		l.dischargeFresh(now, loop, discharge, &res)
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
		l.ramp(now, res.MeasurementAge, safePv, budget, discharge, &res)
	}
	l.anteilReason(an.Fuehrt, budget, discharge, &res)
	if heute.Active && heute.CapKw < res.CapKw {
		// today's staged evaluation is the tighter one right now (e.g. it
		// restarted from its static cap after the plan's limit came back):
		// it binds, with its own verdict
		res.CapKw, res.State, res.Reason = heute.CapKw, heute.State, heute.Reason
	}
	return res
}

// ramp pulls generation and discharge linearly within ExportAnteilWindow to
// the share, without holding (V2/V4). Caller holds l.mu.
func (l *ExportLimiter) ramp(now time.Time, age time.Duration, safePv, budget, discharge float64, res *ExportCap) {
	if !l.rampValid {
		// the operating point at the onset of blindness: the last cap and the
		// discharge that was really allowed
		l.rampValid, l.rampPv, l.rampDis = true, l.cap, discharge
		if l.dcapValid && l.dcap < discharge {
			l.rampDis = l.dcap
		}
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

// ObserveMitSpeicher is Observe plus the measured battery power of the same
// sample (kW, + charge / - discharge; nil = not measured - unknown is not
// zero). Only a box holding a share uses the battery (V6); for every other
// box this is Observe.
func (l *ExportLimiter) ObserveMitSpeicher(ts time.Time, gridKw, pvKw float64, battKw *float64) (urgent bool) {
	if !finite(gridKw) || !finite(pvKw) {
		return false
	}
	l.mu.Lock()
	if l.seen && ts.Before(l.at) {
		l.mu.Unlock()
		return false
	}
	l.battValid = battKw != nil && finite(*battKw)
	if l.battValid {
		l.battKw = *battKw
	}
	// the same measurement the PV law reads in Observe, judged for the
	// discharge: a tighter discharge ceiling republishes at once, too
	urgentDis := l.limitValid && l.dcapValid &&
		l.dischargeTargetAt(gridKw, math.Max(pvKw, 0), l.limit, l.dcap) < l.dcap-ExportStepKw
	shadow := l.heute
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
	if res.Eingefroren {
		return fmt.Sprintf("Der Messwert %s steht seit %s still, obwohl diese Box selbst um "+
			"mindestens %s kW verstellt hat - er gilt als eingefroren",
			wo, age1(res.MeasurementAge), kw1(EinfrierStellKw))
	}
	return fmt.Sprintf("Seit %s keine Messung %s", age1(res.MeasurementAge), wo)
}
