package agent

import (
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// AP-15 IP-20: ONE probe for a frozen connection-point value (B2,
// guards.Einfrierprobe), two users - the feed-in watchdog (CapAnteil) and the
// Bezugswaechter (charging budget, battery grid-charge ceiling). It hears the
// box's own measuring point on the telemetry path and the box's own EFFECTIVE
// adjustments where they are made: the published setpoint (PV cap, battery)
// and the charge park's allocation. Without a share document nothing here is
// fed or asked, and every watchdog is byte for byte today's.

// einfrierStand is the probe plus what the agent needs to judge an adjustment
// as effective: the last measured battery and the last published PV cap.
type einfrierStand struct {
	probe guards.Einfrierprobe

	mu       sync.Mutex
	battKw   *float64 // newest measured battery (+ charge / - discharge)
	pvCapKw  float64  // last published PV cap; +Inf = none
	pvCapSet bool     // false before the first published setpoint
	// pruefBattKw is the probing ceiling on the battery charge the
	// Bezugswaechter set (IP-27 A7), kept while the probe runs
	pruefBattKw *float64
}

// einfrierWert feeds the probe with the box's own measuring point - the same
// gated composite power_kw both watchdogs regulate against - and keeps the
// measured battery for the next setpoint. Only with a share document.
func (a *Agent) einfrierWert(ts time.Time, measurements map[string]float64, battKw *float64) {
	if a.heldAnteile() == nil {
		return
	}
	if g, ok := measurements["power_kw"]; ok {
		a.einfrier.probe.Wert(ts, g)
	}
	e := &a.einfrier
	e.mu.Lock()
	e.battKw = nil
	if battKw != nil {
		v := *battKw
		e.battKw = &v
	}
	e.mu.Unlock()
}

// einfrierSollwert records what a published setpoint MUST change at the meter
// (guards.WirksamGesenkt / WirksamSpeicher): a PV cap lowered below the
// measured generation, a battery moved towards 0 from its measured power. A
// setpoint Layer 1 does not execute (control off) adjusts nothing, and a
// native battery (the inverter's own loop) is not the box's watt value.
func (a *Agent) einfrierSollwert(now time.Time, controlEnabled bool, pvLimit *float64, pvKw, battSollKw float64, native bool) {
	if a.heldAnteile() == nil {
		return
	}
	kappe := math.Inf(1)
	if pvLimit != nil {
		kappe = *pvLimit
	}
	e := &a.einfrier
	e.mu.Lock()
	alt, hatte := e.pvCapKw, e.pvCapSet
	e.pvCapKw, e.pvCapSet = kappe, true
	batt := e.battKw
	e.mu.Unlock()
	if !controlEnabled {
		return
	}
	wirksam := 0.0
	if hatte {
		wirksam += guards.WirksamGesenkt(alt, kappe, pvKw) // less generation: + at the meter
	}
	if batt != nil && !native {
		wirksam += guards.WirksamSpeicher(*batt, battSollKw)
	}
	e.probe.Verstellt(now, wirksam)
}

// einfrierLadepunkte records what a new allocation of the charge park MUST
// change at the meter: an allocation lowered below the measured draw (less
// import: - at the meter). A raise only permits.
func (a *Agent) einfrierLadepunkte(now time.Time, alt, neu *lastmgmt.Plan, gemessenKw float64, ok bool) {
	if a.heldAnteile() == nil || alt == nil || neu == nil || !ok {
		return
	}
	a.einfrier.probe.Verstellt(now, -guards.WirksamGesenkt(alt.AllocatedKw, neu.AllocatedKw, gemessenKw))
}

// eingefrorenSeit is the probe's verdict for the watchdogs: the last change of
// a frozen value, zero while it is not frozen.
func (a *Agent) eingefrorenSeit(now time.Time) time.Time {
	if seit, ok := a.einfrier.probe.Eingefroren(now); ok {
		return seit
	}
	return time.Time{}
}

// einfrierPruefen is the probe's request for a probing adjustment (IP-27 A7,
// guards.Einfrierprobe.Pruefung): the direction of the standing value (0 =
// none) and whether it is still to be made. Only with a share document -
// without one nothing here is ever asked.
func (a *Agent) einfrierPruefen(now time.Time) (richtung int, neu bool) {
	if a.heldAnteile() == nil {
		return 0, false
	}
	return a.einfrier.probe.Pruefung(now)
}

// einfrierGeprueft reports a probing adjustment a watchdog made: once per
// standstill, the answer window starts.
func (a *Agent) einfrierGeprueft(now time.Time, geprueft bool) {
	if geprueft {
		a.einfrier.probe.Geprueft(now)
	}
}
