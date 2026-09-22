// Dynamische Einspeisebegrenzung am Netzverknuepfungspunkt: the REAL-TIME
// watchdog that regulates the controllable producers against the MEASURED grid
// power, so the site's feed-in limit holds no matter what the house does.
//
// WHY IT EXISTS (Anlage Pilsting, live 2026-08-06). The plant is registered with
// a 30 kW feed-in limit at the connection point. Today a customer-owned Loxone
// holds that limit: it reads the connection point, commands the inverters, and
// NETS THE WALLBOXES IN - a charging car makes room for more generation, and the
// moment it is unplugged the generation has to come down within seconds
// ("sonst schiesst der drueber wenn ein Auto abgesteckt wird").
//
// VoltPilot PLANNED that limit (site.max_feed_in_kw is a hard export cap in the
// solver, FK1) but never REGULATED it: the plant cap the curtailment executor
// splits across the Fronius units came from the 15-min PLAN (sp.pv_limit_kw), so
// an unplugged car stayed unnoticed until the next re-plan - up to 15 minutes of
// overrun. This guard closes that loop on the device, in the same place and with
// the same discipline as the PS-3 peak guard on the IMPORT side
// (guards/peakguard.go): it is the export-side twin, not a new invention.
//
// THE CONTROL LAW is a proportional loop with gain 1 over the connection point:
//
//	export   = max(-grid, 0)                  (grid: + import / - export)
//	headroom = limit - export
//	cap      = pv_total + headroom - margin
//
// i.e. "if I cap TOTAL plant PV at cap and everything else stays put, the export
// lands exactly `margin` below the limit". House load, wallboxes and battery are
// netted AUTOMATICALLY because they are already inside the measured grid power -
// that IS the advantage over planning, and the reason the Loxone can go away.
// The cap is the PLANT-level total (the same quantity the plan's pv_limit_kw
// carries), so the executor's existing split (sunspec/curtail.js splitPlantCap)
// subtracts the uncontrollable share and distributes the rest unchanged.
//
// ⚠ THE FAIL-SAFE RULE IS THE OPPOSITE OF EVERY OTHER GUARD HERE. The economic
// guards (trim, load following, surplus absorption, peak) all follow "blind =>
// INACTIVE, never regulate blind": a missed correction costs money, never
// safety. For a COMPLIANCE limit that reasoning inverts - blind must not mean
// "unlimited". So this guard degrades in stages instead of releasing:
//
//	gap <= ExportFreshWindow     -> closed loop (above)
//	gap <= ExportHoldWindow      -> HOLD the last commanded cap (freeze, never release)
//	gap >  ExportHoldWindow      -> CONTRACT linearly (over ExportContractWindow)
//	                                toward the safe static cap, then stay there
//	no measurement ever          -> the safe static cap immediately
//
// The SAFE STATIC CAP is supplied by the caller as `limit - commanded discharge`
// and is sufficient for ANY house load: export = pv + discharge - load - charge
// <= pv + discharge <= (limit - discharge) + discharge = limit, because load and
// charge are non-negative. It needs no measurement at all - which is precisely
// why it is the blind fallback. It holds for every house load, but NOT for every
// producer: pv is the generation THIS box controls, and a producer that another
// box reads or controls behind the same connection point is not in it (UEMS
// AP-15 W11). Where several boxes share one connection point, each holds its
// own share instead (exportanteil.go), and this guard's blind fallback becomes
// that share.
//
// Safety posture, the parts that are structural rather than argued:
//
//   - It NEVER widens anything. The caller composes the live cap with the plan's
//     own curtailment most-restrictive-wins (min), and the cap only ever REDUCES
//     generation - it can never command production, never raise an import, never
//     affect the §14a envelope or a SoC bound. It never touches the battery -
//     except that, with a share document, it may LOWER a discharge (W12 below).
//   - It only ever regulates the CONTROLLABLE producers. The uncontrollable
//     share (the primary hybrid) rides inside pv_total, so the loop accounts for
//     it - but if that share alone exceeds the limit, the writable budget floors
//     at 0 and the guard says so instead of pretending to hold the limit.
//   - Tightening is IMMEDIATE and unconditional; releasing is rate-limited
//     (ExportReleaseWindow for the full limit range) so the loop cannot oscillate
//     against the inverter's own WMaxLimPct ramp.
//   - It is a DELIBERATE limitation, not a failed write: the commanded cap is
//     what gets written, so the register readback matches it (the PR #280 lesson,
//     applied to the curtailment path).
//
// WHAT IT DOES NOT DO. Without a share document it regulates ONLY the
// controllable producers - never the battery. Absorbing a surplus into the
// battery is an OPTIMIZER decision (see guards/surpluscharge.go, which acts on a
// CLOUD-priced flag); a live guard that commanded the battery for anything
// ECONOMIC would fight the plan it is supposed to execute - that stays true in
// every case. What changes with a share (UEMS AP-15 W12, V6): a share smaller
// than the battery's discharge power cannot be held by the producers alone, so
// the share guard (exportanteil.go) also LOWERS the discharge - never charges,
// never raises, blind to the share and with a fresh measurement only once the
// producers are already at 0. That costs a planned discharge, never safety.
package guards

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// ExportState is the watchdog's machine-readable state. The German sentence
// travels next to it (ExportCap.Reason) exactly like otaapply's Blocker/reason
// pair - no surface ever has to parse a German sentence, and the sentence is
// written ONCE so the edge card and the cloud can never word it differently.
type ExportState string

const (
	// ExportOff: no feed-in limit is configured for the site (the plan carries
	// no grid_export_limit_kw). The guard produces NO cap - a limit is never
	// invented.
	ExportOff ExportState = "aus"
	// ExportWatching: fresh measurement, the cap is above what the plant is
	// currently producing - it is armed at the inverter but not holding it back.
	ExportWatching ExportState = "ueberwacht"
	// ExportLimiting: fresh measurement, the cap is actually holding the
	// producers back so the limit stays.
	ExportLimiting ExportState = "regelt"
	// ExportHolding: the measurement went away recently - the last commanded cap
	// is FROZEN. Never a release.
	ExportHolding ExportState = "haelt"
	// ExportContracting: the measurement has been gone long enough that holding
	// is no longer defensible - the cap is being pulled down to the safe static
	// cap.
	ExportContracting ExportState = "zieht_zusammen"
	// ExportSafeCap: blind, and the cap has arrived at (or started at) the safe
	// static cap that holds for any house load.
	ExportSafeCap ExportState = "sicherheitskappe"
)

const (
	// ExportMarginFrac / ExportMarginMinKw size the reserve the loop keeps below
	// the limit. It covers STEADY-STATE error only - measurement noise, the
	// inverter's own WMaxLimPct ramp (WMaxLimPct_WinTms) and the percent
	// quantisation of the register. It deliberately does NOT try to cover a LOAD
	// STEP: unplugging a 11 kW wallbox moves the operating point by 11 kW, which
	// no static margin can absorb - that is answered by the loop's reaction (one
	// measurement + write cycle), and by the fact that the cap is already armed
	// IN the inverter, which enforces it locally and continuously.
	ExportMarginFrac  = 0.02
	ExportMarginMinKw = 0.3

	// ExportFreshWindow is how old the newest connection-point measurement may be
	// and still DRIVE the closed loop. Sized at several source poll cycles (5 s)
	// and setpoint ticks (10 s), so an ordinary hiccup never leaves the loop, but
	// short enough that the loop's whole value - its recency - is real.
	ExportFreshWindow = 30 * time.Second
	// ExportHoldWindow is how long a measurement gap is absorbed by FREEZING the
	// last cap (measured from the last measurement, so it covers the fresh
	// window). Far below the plan staleness window - a compliance limit may not
	// wait 20 minutes to notice it is flying blind.
	ExportHoldWindow = 90 * time.Second
	// ExportContractWindow is how long the contraction to the safe static cap
	// takes once holding is no longer defensible. Gradual on purpose: a sudden
	// drop to the static cap on a 10-second telemetry hiccup would be a
	// self-inflicted outage, and the limit is not yet violated - we are only
	// losing the ability to PROVE it is not.
	ExportContractWindow = 5 * time.Minute

	// ExportReleaseWindow is how long a release from 0 to the full limit takes.
	// Tightening is immediate; releasing is deliberately slow, because a release
	// invites the plant to produce more and the loop must not chase its own
	// actuation (the inverter needs WMaxLimPct_WinTms to ramp, and our own
	// measurement is one poll behind). ~1 minute is fast enough that a plugged-in
	// car is monetised within seconds-to-a-minute, slow enough not to oscillate.
	ExportReleaseWindow = 60 * time.Second
	// ExportReleaseMinRateKwPerSec keeps a tiny limit from ramping forever.
	ExportReleaseMinRateKwPerSec = 0.05

	// ExportStepKw is the smallest cap change worth writing. A release that would
	// move the cap less than this is deferred (the elapsed time keeps
	// accumulating, so the ramp resumes with a bigger step) - stable register
	// writes without ever delaying a TIGHTENING, which is never deferred.
	ExportStepKw = 0.1
	// exportLimitingMarginKw decides "is this cap actually holding the plant
	// back?" - the plant is at its cap when its measured PV is within this band
	// of it. Display/telemetry only; it gates no write.
	exportLimitingMarginKw = 0.3
)

// ExportCap is one evaluation of the feed-in watchdog.
type ExportCap struct {
	// Active is true when a feed-in limit is configured, i.e. when CapKw is a
	// real command. False = ExportOff, and the caller must not cap anything.
	Active bool
	// CapKw is the PLANT-level total PV cap to command (kW, >= 0). Only
	// meaningful when Active.
	CapKw float64
	// State / Reason are the machine-readable verdict and its German sentence.
	State  ExportState
	Reason string
	// LimitKw echoes the configured feed-in limit.
	LimitKw float64
	// Limiting is true while the cap is actually holding the producers back
	// (measured PV at or above the cap). Display only.
	Limiting bool
	// ExportKw / PvKw are the measurements the verdict was formed from; nil when
	// the guard is running blind.
	ExportKw *float64
	PvKw     *float64
	// MeasurementAge is how old the newest usable measurement is; 0 with none.
	MeasurementAge time.Duration
	// Blind is true whenever the verdict was NOT formed from a fresh
	// measurement (hold / contract / safe cap).
	Blind bool
	// DischargeCapKw is the ceiling on the battery DISCHARGE (kW, >= 0) that a
	// share demands (V6, CapAnteil only); nil = none binds. The caller only
	// ever LOWERS a commanded discharge to it - never a charge, never a raise.
	DischargeCapKw *float64
	// AnteilKw echoes the box's own feed-in share; nil without a share
	// document (Cap).
	AnteilKw *float64
	// HeuteCapKw is the cap the SAME box would command without a share - the
	// shadow of CapAnteil (V5) - nil when that shadow holds nothing (no
	// feed-in limit in the plan). The distance to CapKw is what the share
	// holds back (IP-22, anteilverlust.go). CapAnteil only; Cap leaves it nil.
	HeuteCapKw *float64
	// Eingefroren is true while the verdict is blind because the measured
	// value stands still although the box itself moved its actuators (B2,
	// eingefroren.go; CapAnteil only). MeasurementAge then counts from the
	// last change of the value.
	Eingefroren bool
	// Uhrsprung is true while the verdict is blind because the box's clock
	// went back behind its newest measurement (IP-27 A8): an
	// age below zero is no age.
	Uhrsprung bool
	// Pruefung is true when this evaluation made the probing adjustment of
	// IP-27 A7 (CapAnteil only): the caller reports it to the Einfrierprobe
	// (Geprueft), whose answer window starts now.
	Pruefung bool
}

// ExportLimiter holds the watchdog's measurement + hysteresis state across ticks.
// Concurrency-safe: Observe runs on the telemetry path, Cap on the setpoint path.
type ExportLimiter struct {
	mu sync.Mutex

	// newest usable measurement
	seen   bool
	at     time.Time
	gridKw float64
	pvKw   float64
	// A negative age starts the ordinary blind fallback on the new clock.
	// Only an accepted measurement ends it; catching up is no new evidence.
	uhrBlind bool
	uhrAb    time.Time
	uhrNeu   bool // a new sample must also be on/before the evaluation clock

	// the currently commanded cap
	capValid bool
	cap      float64
	capAt    time.Time

	// the last limit Cap() was called with, so Observe can judge urgency without
	// the caller having to hand it the plan.
	limitValid bool
	limit      float64

	// Only with a share document (exportanteil.go, CapAnteil) - untouched by
	// Cap. The measured battery of the newest sample (+ charge / - discharge).
	battValid bool
	battKw    float64
	// the commanded discharge ceiling (V6)
	dcapValid bool
	dcap      float64
	dcapAt    time.Time
	// the operating point at the onset of blindness, origin of the linear
	// ramp to the share (V2)
	rampValid       bool
	rampPv, rampDis float64
	// heute is the same box WITHOUT a share, evaluated alongside (V5)
	heute *ExportLimiter
	// the probing adjustment of IP-27 A7 (exportanteil.go, pruefen): the
	// point it lowered to, held until the Einfrierprobe answers; +Inf = that
	// actuator is not probed
	pruefValid        bool
	pruefPv, pruefDis float64
	// a standing value proves no headroom (exportanteil.go, stehBeleg): the
	// grid value of the newest sample, steht when it repeats the one before
	// bit for bit, and the PV and measured battery (+ charge / - discharge;
	// ankerBattValid = measured) of the sample on which it last moved.
	// Written by ObserveMitSpeicher only - Cap never reads them.
	wertValid, steht   bool
	wertKw             float64
	ankerPv, ankerBatt float64
	ankerBattValid     bool
	// messung counts the accepted samples (Observe) - the identity of the
	// measurement an evaluation reads. einSpielraum gives the headroom of one
	// measurement out once: spielraumVor is the discharge ceiling before the
	// first evaluation of measurement spielraumMessung (exportanteil.go).
	messung, spielraumMessung uint64
	spielraumVor              float64
	spielraumValid            bool
}

// NewExportLimiter returns an idle watchdog (no measurement, no cap).
func NewExportLimiter() *ExportLimiter { return &ExportLimiter{} }

// Observe feeds one measurement of the CONNECTION POINT: the signed site grid
// power (kW, + = import / - = export) and the total measured plant PV. Both are
// required - without PV the control law has no anchor, so an incomplete sample
// is not a measurement at all and the staged fallback takes over.
//
// It returns urgent=true when this sample demands a MEANINGFULLY tighter cap
// than the one currently commanded, so the caller can republish the setpoint at
// once instead of waiting for the next tick. That is what turns "the car was
// unplugged" into a reaction within one measurement cycle.
func (l *ExportLimiter) Observe(ts time.Time, gridKw, pvKw float64) (urgent bool) {
	if !finite(gridKw) || !finite(pvKw) {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// Like ObserveMitSpeicher: an older timestamp re-anchors the clock.
	// A reordered sample must not earn release credit from before the jump.
	if l.seen && ts.Before(l.at) {
		l.verankern(ts)
	}
	l.uhrNeu = l.uhrBlind
	l.seen, l.at, l.gridKw, l.pvKw = true, ts, gridKw, math.Max(pvKw, 0)
	l.messung++
	if !l.limitValid || !l.capValid {
		return false
	}
	target := closedLoopCap(l.limit, l.gridKw, l.pvKw)
	return target < l.cap-ExportStepKw
}

// closedLoopCap is the control law (see the package doc): the total plant PV cap
// whose steady state puts the export one margin below the limit.
func closedLoopCap(limitKw, gridKw, pvKw float64) float64 {
	exportKw := math.Max(-gridKw, 0)
	headroom := limitKw - exportKw
	capKw := pvKw + headroom - exportMargin(limitKw)
	if capKw < 0 {
		capKw = 0
	}
	return capKw
}

func exportMargin(limitKw float64) float64 {
	return math.Max(ExportMarginMinKw, ExportMarginFrac*limitKw)
}

// Cap evaluates the watchdog for now.
//
// limitKw is the site's configured feed-in limit at the connection point (nil =
// none configured -> ExportOff, no cap). safeStaticCapKw is the blind fallback
// the caller derives WITHOUT any measurement - `limit - commanded discharge`,
// which holds for any house load (see the package doc).
//
// The returned cap is the caller's to compose most-restrictive-wins with the
// plan's own curtailment; this guard never widens anything.
func (l *ExportLimiter) Cap(now time.Time, limitKw *float64, safeStaticCapKw float64) ExportCap {
	if limitKw == nil || !finite(*limitKw) || *limitKw < 0 {
		l.forget()
		return ExportCap{State: ExportOff}
	}
	limit := *limitKw
	if !finite(safeStaticCapKw) || safeStaticCapKw < 0 {
		safeStaticCapKw = 0
	}
	if safeStaticCapKw > limit {
		safeStaticCapKw = limit
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	return l.capLocked(now, limit, safeStaticCapKw)
}

// capLocked is the staged evaluation behind Cap (and CapAnteil, which runs it
// against the loop limit and the share's safe cap first - so a share can only
// ever narrow what this returns). Caller holds l.mu.
func (l *ExportLimiter) capLocked(now time.Time, limit, safeStaticCapKw float64) ExportCap {
	return l.capLockedAb(now, l.at, limit, safeStaticCapKw)
}

// capLockedAb is capLocked with the time of the newest usable measurement
// given: CapAnteil passes the last CHANGE of a frozen value (B2,
// eingefroren.go), Cap always the newest sample. Caller holds l.mu.
func (l *ExportLimiter) capLockedAb(now, at time.Time, limit, safeStaticCapKw float64) ExportCap {
	l.limit, l.limitValid = limit, true

	res := ExportCap{Active: true, LimitKw: limit}

	age := time.Duration(0)
	fresh := false
	if l.seen {
		age = now.Sub(at)
		if l.uhrNeu && age >= 0 {
			l.uhrBlind = false
		}
		l.uhrNeu = false
		if age < 0 {
			if !l.uhrBlind || now.Before(l.uhrAb) {
				l.uhrAb = now
			}
			l.uhrBlind = true
		}
		if l.uhrBlind {
			age = now.Sub(l.uhrAb)
		}
		fresh = !l.uhrBlind && age <= ExportFreshWindow
	}
	res.MeasurementAge = age
	res.Uhrsprung = l.uhrBlind
	if l.uhrBlind {
		// Keep the actual (possibly negative) age visible; only the fallback
		// windows count from detecting the jump on the new clock.
		res.MeasurementAge = now.Sub(at)
	}

	switch {
	case l.seen && fresh:
		l.freshCap(now, limit, &res)
	case l.capValid && age <= ExportHoldWindow+ExportContractWindow:
		l.blindCap(now, age, safeStaticCapKw, &res)
	default:
		// Never measured, or blind for longer than we are willing to hold: the
		// safe static cap, which needs no measurement to be correct.
		l.cap, l.capValid, l.capAt = safeStaticCapKw, true, now
		res.CapKw, res.Blind, res.State = safeStaticCapKw, true, ExportSafeCap
		if !l.seen {
			res.Reason = fmt.Sprintf(
				"Noch keine Messung am Netzverknuepfungspunkt - die Erzeuger sind vorsorglich "+
					"auf die sichere Kappe von %s kW begrenzt (sie haelt die Einspeisegrenze von "+
					"%s kW auch ohne jeden Eigenverbrauch ein).",
				kw1(safeStaticCapKw), kw1(limit))
		} else {
			res.Reason = fmt.Sprintf(
				"Seit %s keine Messung am Netzverknuepfungspunkt - die Erzeuger liegen auf der "+
					"sicheren Kappe von %s kW, die die Einspeisegrenze von %s kW auch ohne jeden "+
					"Eigenverbrauch einhaelt.",
				age1(age), kw1(safeStaticCapKw), kw1(limit))
		}
	}
	if res.Uhrsprung {
		res.Reason = "Die Uhr der Box ist hinter die letzte Messung am Netzverknuepfungspunkt zurückgesprungen - " + res.Reason
	}
	return res
}

// freshCap runs the closed loop on the newest measurement. Caller holds l.mu.
func (l *ExportLimiter) freshCap(now time.Time, limit float64, res *ExportCap) {
	exportKw := math.Max(-l.gridKw, 0)
	pv := l.pvKw
	res.ExportKw, res.PvKw = &exportKw, &pv

	target := closedLoopCap(limit, l.gridKw, l.pvKw)
	switch {
	case !l.capValid:
		// First evaluation: adopt the target outright. It is derived from a real
		// measurement, so it is neither optimistic nor punitive.
		l.cap, l.capValid, l.capAt = target, true, now
	case target <= l.cap-ExportStepKw:
		// TIGHTEN: immediate and unconditional once it is worth writing. A limit
		// being approached must never wait for a dwell window.
		l.cap, l.capAt = target, now
	case target <= l.cap:
		// A tightening SMALLER than the write resolution is held: measurement
		// noise around the converged operating point would otherwise rewrite the
		// register on every tick. The erosion is bounded by ExportStepKw (0,1 kW
		// against a margin that is several times that), and because `target` is
		// ABSOLUTE, a slow genuine drift accumulates in `cap - target` and
		// crosses the threshold on its own - nothing is lost, only smoothed.
		//
		// capAt IS advanced here: the cap is in equilibrium, so no release credit
		// may accrue. Only the deferred RELEASE step below leaves it alone, which
		// is exactly where accumulation is wanted.
		l.capAt = now
	default:
		// RELEASE: rate-limited, and never in dribbles. Not advancing capAt lets
		// the elapsed time accumulate, so a deferred step resumes larger rather
		// than stalling.
		elapsed := now.Sub(l.capAt)
		if elapsed < 0 {
			elapsed = 0
		}
		step := releaseRate(limit) * elapsed.Seconds()
		next := math.Min(target, l.cap+step)
		if next-l.cap >= ExportStepKw || next >= target {
			l.cap, l.capAt = next, now
		}
	}
	res.CapKw = round3(l.cap)
	res.Limiting = pv >= l.cap-exportLimitingMarginKw
	if res.Limiting {
		res.State = ExportLimiting
		res.Reason = fmt.Sprintf(
			"Die Erzeuger sind auf %s kW begrenzt, damit die Einspeisegrenze von %s kW am "+
				"Netzverknuepfungspunkt eingehalten wird (aktuell %s kW Einspeisung bei %s kW "+
				"Erzeugung). Das ist eine bewusste Begrenzung, kein Fehler der Anlage.",
			kw1(res.CapKw), kw1(limit), kw1(exportKw), kw1(pv))
		return
	}
	res.State = ExportWatching
	res.Reason = fmt.Sprintf(
		"Die Einspeisung liegt bei %s kW von %s kW - die Erzeuger sind vorsorglich auf %s kW "+
			"begrenzt, greifen dort aber nicht an (Erzeugung %s kW).",
		kw1(exportKw), kw1(limit), kw1(res.CapKw), kw1(pv))
}

// blindCap holds, then contracts. Caller holds l.mu; l.capValid is true.
func (l *ExportLimiter) blindCap(now time.Time, age time.Duration, safeStaticCapKw float64, res *ExportCap) {
	res.Blind = true
	if age <= ExportHoldWindow {
		// Should not be reachable (the fresh branch covers it), but the freeze is
		// stated explicitly so a future re-ordering cannot turn it into a release.
		res.CapKw, res.State = round3(l.cap), ExportHolding
		res.Reason = l.holdReason(age)
		return
	}
	// The held cap is the starting point of the contraction. A contraction NEVER
	// raises the cap: if the safe static cap happens to be higher than what we
	// were holding, we keep holding - a blind controller must not release.
	if safeStaticCapKw >= l.cap {
		res.CapKw, res.State = round3(l.cap), ExportHolding
		res.Reason = l.holdReason(age)
		return
	}
	frac := (age - ExportHoldWindow).Seconds() / ExportContractWindow.Seconds()
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	res.CapKw = round3(l.cap - (l.cap-safeStaticCapKw)*frac)
	if frac >= 1 {
		res.State = ExportSafeCap
		res.Reason = fmt.Sprintf(
			"Seit %s keine Messung am Netzverknuepfungspunkt - die Erzeuger liegen auf der "+
				"sicheren Kappe von %s kW, die die Einspeisegrenze von %s kW auch ohne jeden "+
				"Eigenverbrauch einhaelt.",
			age1(age), kw1(safeStaticCapKw), kw1(res.LimitKw))
		return
	}
	res.State = ExportContracting
	res.Reason = fmt.Sprintf(
		"Seit %s keine Messung am Netzverknuepfungspunkt - die Begrenzung der Erzeuger wird "+
			"schrittweise auf die sichere Kappe von %s kW zusammengezogen (aktuell %s kW). "+
			"Freigegeben wird ohne Messung nichts.",
		age1(age), kw1(safeStaticCapKw), kw1(res.CapKw))
}

func (l *ExportLimiter) holdReason(age time.Duration) string {
	return fmt.Sprintf(
		"Seit %s keine Messung am Netzverknuepfungspunkt - die zuletzt gesetzte Begrenzung von "+
			"%s kW wird gehalten und nicht freigegeben.",
		age1(age), kw1(round3(l.cap)))
}

// CommandedCap reports the cap currently held (kW) - for tests and diagnostics.
func (l *ExportLimiter) CommandedCap() (float64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cap, l.capValid
}

// forget drops the commanded cap. Called from Cap() when the site's feed-in
// limit disappears (a NEW plan without the field - the contract's
// clear-on-absent rule): the next configured limit must start from a fresh
// measurement, never from a cap that belonged to a different limit.
func (l *ExportLimiter) forget() {
	l.mu.Lock()
	l.capValid, l.cap, l.capAt = false, 0, time.Time{}
	l.limitValid, l.limit = false, 0
	l.dcapValid, l.dcap, l.dcapAt, l.rampValid = false, 0, time.Time{}, false
	l.mu.Unlock()
}

// finite is the guards' known() plus an infinity check: this guard multiplies
// and subtracts its inputs, where an Inf would silently poison a compliance cap.
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func releaseRate(limitKw float64) float64 {
	return math.Max(ExportReleaseMinRateKwPerSec, limitKw/ExportReleaseWindow.Seconds())
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// kw1 formats a kW value the German way (one decimal, comma) so the reason reads
// like the rest of the device's copy. The sentence is written HERE, once, and
// travels to the :8484 card and the cloud heartbeat verbatim - two renderings of
// the same verdict could otherwise word it differently.
func kw1(v float64) string {
	return strings.Replace(fmt.Sprintf("%.1f", v), ".", ",", 1)
}

// age1 renders a measurement gap as "45 s" / "3 min".
func age1(d time.Duration) string {
	if d < 90*time.Second {
		return fmt.Sprintf("%d s", int(d.Round(time.Second)/time.Second))
	}
	return fmt.Sprintf("%d min", int(d.Round(time.Minute)/time.Minute))
}
