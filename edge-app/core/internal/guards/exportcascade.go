// Kaskade statt zweier gleichberechtigter Regler (package K6, concept
// vp-wechselrichter-eigenregelung-k1 §6.3).
//
// When the leader regulates itself with an open charge side (E↑, E, E~), two
// loops act on the same connection point: INSIDE the device (seconds, it moves
// the battery toward grid 0) and OUTSIDE the box's feed-in watchdog (~20 s, it
// moves the curtailable PV inverters toward export <= limit). As two equal
// regulators they fight: at a limit of 0 kW (negative price) the watchdog aims
// one margin BELOW the device's own target, so every correction of the device
// is answered by a tighter PV cap, and the cap ratchets the plant down while the
// battery could still have taken the surplus.
//
// As a CASCADE they cannot fight, because only one of them acts at a time:
//
//   - The storage still has headroom (charging more than CascadeGapKw below its
//     ceiling, SoC below the upper bound): the watchdog YIELDS. It never tightens,
//     and it holds while an export above limit + CascadeGapKw is the inner loop's
//     to answer, for CascadeInnerGrace. How far it RELEASES depends on what the
//     limit is:
//   - a COMPLIANCE limit (the registered feed-in limit) is never gambled on
//     the inner loop: the release stops where the export would stand if the
//     storage took nothing more - the ordinary target, and at a limit below
//     the margin one Abstand above export 0, so a zero-export site still
//     lets the battery pull the PV up step by step;
//   - the ECONOMIC 0 kW of a negative-price slot (InnerLoop.Economic)
//     releases up to what the storage can still take, at the storage's pace,
//     so the battery charges to its ceiling within minutes; a wrong bet costs
//     a few seconds of export at a negative price, never a compliance breach.
//   - The storage is saturated (ceiling or SoC bound reached, or unknown): the
//     watchdog regulates exactly as without a cascade, except that its target is
//     never below the device's own (export 0) - the "Abstand" keeps the outer
//     loop off the inner one's operating point.
//   - The inner loop let an export above the limit stand for the whole grace
//     although it still had headroom (a device meter that does not see the
//     second PV system, a device that ignores its window): the watchdog takes
//     over for the rest of the slot. A compliance limit may wait for the inner
//     loop, never on it.
//
// Without an active inner loop none of this runs: CapCascade with a zero
// InnerLoop is Cap, byte for byte.
package guards

import (
	"math"
	"time"
)

const (
	// CascadeGapKw is the Abstand between the two loops: the storage counts as
	// saturated once it charges within this of its ceiling, and while it is not,
	// an export up to this above the limit is the inner loop's to answer. A few
	// tenths of a kW: above measurement noise and the watchdog's own write step
	// (ExportStepKw), below anything a grid operator or a tariff notices.
	CascadeGapKw = 0.3
	// CascadeInnerGrace is how long the watchdog lets the inner loop answer an
	// export above the limit while the storage still has headroom: ONE setpoint
	// tick. The device itself reacts in seconds; F7 of the concept demands the
	// limit back within 20 s, and the Fronius ramp needs its own few seconds of
	// that. A slow reading that makes the inner loop look failed costs only the
	// pre-K6 behaviour for the rest of the slot; a long grace would cost the
	// limit.
	CascadeInnerGrace = 10 * time.Second
)

// The cascade words of ExportCap.Cascade (box-local, never on the heartbeat).
const (
	CascadeInner       = "innen"
	CascadeOuter       = "aussen"
	CascadeInnerFailed = "innen_versagt"
)

var cascadeText = map[string]string{
	CascadeInner: "Der Speicher nimmt den Überschuss selbst auf - der Einspeisewächter lässt ihm den " +
		"Vortritt und greift erst, wenn der Speicher voll ist oder an seiner Ladegrenze lädt.",
	CascadeOuter: "Der Speicher nimmt nichts mehr auf (Ladegrenze oder Ladestand erreicht) - der " +
		"Einspeisewächter regelt die Erzeuger.",
	CascadeInnerFailed: "Der Speicher hätte noch laden können, hat den Überschuss aber nicht aufgenommen - " +
		"der Einspeisewächter regelt die Erzeuger für den Rest der Viertelstunde selbst.",
}

// InnerLoop is the leader's own regulation as the watchdog sees it.
type InnerLoop struct {
	// Active: the leader regulates itself (proven) with an open CHARGE side -
	// only then is there an inner loop that can take a surplus.
	Active bool
	// CeilingKw is the charge ceiling of its window (+ = charge).
	CeilingKw float64
	// BatteryKw is the measured battery power (+ charge); NaN = unknown.
	BatteryKw float64
	// SocPct / SocMaxPct: the measured SoC and the configured upper bound
	// (NaN / 0 = unknown).
	SocPct, SocMaxPct float64
	// Slot identifies the plan slot: a failed inner loop is latched until it
	// changes.
	Slot time.Time
	// Economic: the limit is the negative-price slot's 0 kW, not a registered
	// feed-in limit - the watchdog may then release ahead of the storage.
	Economic bool
}

// HeadroomKw is how much more the storage can take right now, beyond the
// Abstand; 0 when it is saturated - or when anything needed to know is unknown,
// because an unknown storage must never hold the compliance loop back.
func (in InnerLoop) HeadroomKw() float64 {
	if !in.Active || !finite(in.BatteryKw) || !finite(in.CeilingKw) || !finite(in.SocPct) {
		return 0
	}
	if in.SocMaxPct > 0 && in.SocPct >= in.SocMaxPct {
		return 0
	}
	if h := in.CeilingKw - in.BatteryKw - CascadeGapKw; h > 0 {
		return h
	}
	return 0
}

// armInner takes this call's inner loop. A new slot - or no inner loop - clears
// the failure latch. Caller holds l.mu.
func (l *ExportLimiter) armInner(in InnerLoop) {
	if !in.Active || !in.Slot.Equal(l.innerSlot) {
		l.overSince, l.innerFailed = time.Time{}, false
	}
	l.inner = in
	l.innerSlot = time.Time{}
	if in.Active {
		l.innerSlot = in.Slot
	}
}

// yielding reports whether the watchdog currently leaves the surplus to the
// storage. Caller holds l.mu.
func (l *ExportLimiter) yielding() bool {
	return l.inner.Active && !l.innerFailed && l.inner.HeadroomKw() > 0
}

// outerTarget is the closed-loop law. With an inner loop the target export is
// never below the device's own target (0): at a limit below the margin the
// watchdog would otherwise aim at an import the device keeps correcting away.
// Caller holds l.mu.
func (l *ExportLimiter) outerTarget(limit, gridKw, pvKw float64) float64 {
	if !l.inner.Active {
		return closedLoopCap(limit, gridKw, pvKw)
	}
	capKw := pvKw + math.Max(limit-exportMargin(limit), 0) - math.Max(-gridKw, 0)
	if capKw < 0 {
		capKw = 0
	}
	return capKw
}

// releaseBase is the power range a release is paced against: the limit, or the
// storage's ceiling when an inner loop takes what a release lets through. At a
// limit of 0 kW the plain rate would crawl (ExportReleaseMinRateKwPerSec) while
// the battery waits for the surplus it is supposed to store.
func (l *ExportLimiter) releaseBase(limit float64) float64 {
	if l.inner.Active && l.inner.Economic && finite(l.inner.CeilingKw) {
		return math.Max(limit, l.inner.CeilingKw)
	}
	return limit
}

// innerCap is the cascade half of freshCap. It returns true when it decided
// the cap (the storage still has headroom), false when the ordinary law runs.
// Caller holds l.mu.
func (l *ExportLimiter) innerCap(now time.Time, limit, exportKw float64, res *ExportCap) bool {
	switch {
	case l.innerFailed:
		res.Cascade = CascadeInnerFailed
		res.CascadeText = cascadeText[CascadeInnerFailed]
		return false
	case l.inner.HeadroomKw() <= 0:
		l.overSince = time.Time{}
		res.Cascade = CascadeOuter
		res.CascadeText = cascadeText[CascadeOuter]
		return false
	case !l.capValid:
		// The very first cap comes from the ordinary law - derived from a real
		// measurement, neither optimistic nor punitive.
		res.Cascade = CascadeInner
		res.CascadeText = cascadeText[CascadeInner]
		return false
	}
	if exportKw > limit+CascadeGapKw {
		if l.overSince.IsZero() {
			l.overSince = now
		}
		if now.Sub(l.overSince) >= CascadeInnerGrace {
			l.innerFailed = true
			res.Cascade = CascadeInnerFailed
			res.CascadeText = cascadeText[CascadeInnerFailed]
			return false
		}
		// HOLD: the inner loop's grace. No tightening, and no release credit.
		l.capAt = now
	} else {
		l.overSince = time.Time{}
		// YIELD: never tighten; release as far as the limit's kind allows.
		target := l.pvKw - exportKw + math.Max(limit-exportMargin(limit), CascadeGapKw)
		if l.inner.Economic {
			target = l.pvKw + math.Max(limit-exportKw, 0) + l.inner.HeadroomKw()
		}
		if target > l.cap {
			l.follow(now, target, releaseRate(l.releaseBase(limit)))
		} else {
			l.capAt = now
		}
	}
	res.Cascade = CascadeInner
	res.CascadeText = cascadeText[CascadeInner]
	return true
}
