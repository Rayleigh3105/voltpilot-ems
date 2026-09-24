package agent

import (
	"log/slog"
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Mehrere Wechselrichter an einem Netzpunkt (package K6, concept
// vp-wechselrichter-eigenregelung-k1 §6.2-§6.4) - the CORE half. The rules are
// pure and live in guards (leader.go, exportcascade.go, backstop.go); this file
// gathers the facts and carries the verdicts into the Wegwahl, the published PV
// cap and the snapshot.

// leaderSuspectHold is how long the measured symptom of a wrong meter location
// (the K4b hint einspeisung_trotz_ladeleistung) stays on the leader block after
// it last fired: long enough that the commissioning operator finds it the next
// morning, short enough that a fixed meter clears it on its own.
const leaderSuspectHold = 24 * time.Hour

// leaderVerdict is "Genau ein Führungsgerät je Netzpunkt" for the selection:
// what the operator declared (balance.json), what the box measured
// (guards.MeterCheck), and the hint the K4b supervision raised. nil info when
// there is no selection - then there is nothing that could lead.
func (a *Agent) leaderVerdict(now time.Time) (guards.LeaderVerdict, *state.LeaderInfo) {
	a.srcMu.Lock()
	bal := a.bal
	hasNetz := false
	for _, s := range a.srcs {
		if s.Role == sources.RoleNetz {
			hasNetz = true
		}
	}
	a.srcMu.Unlock()
	check := a.meterCheck.Verdict(now)
	further := bal.FurtherStorage
	if further == "" {
		further = guards.FurtherStorageNone
	}
	v := guards.LeaderFor(guards.LeaderInput{
		MeterLocation:  bal.MeterLocation(),
		FurtherStorage: further,
		Plausibility:   check.State,
	})

	a.invMu.Lock()
	selected := a.inv != nil
	a.invMu.Unlock()
	if !selected {
		return v, nil
	}
	info := &state.LeaderInfo{
		Leads:          v.Leads,
		Reason:         v.Reason,
		Text:           v.Text,
		MeterLocation:  bal.MeterLocation(),
		FurtherStorage: further,
		Plausibility:   check.State,
		Pairs:          check.Pairs,
	}
	if !math.IsNaN(check.DeviationKw) {
		d := check.DeviationKw
		info.DeviationKw = &d
	}
	a.mu.Lock()
	suspect := !a.leaderSuspectAt.IsZero() && now.Sub(a.leaderSuspectAt) <= leaderSuspectHold
	a.mu.Unlock()
	switch {
	case suspect:
		info.Hint = guards.LeaderHintCheckMeter
	case v.Leads && !hasNetz:
		info.Hint = guards.LeaderHintOneTimeTest
	}
	info.HintText = guards.LeaderHintText(info.Hint)
	return v, info
}

// noteLeaderSymptom remembers the K4b hint as the measured symptom of a leader
// meter that does not see the whole connection point.
func (a *Agent) noteLeaderSymptom(now time.Time, dec guards.NativeDecision) {
	if dec.Hint != guards.NativeHintExportWithHeadroom {
		return
	}
	a.mu.Lock()
	a.leaderSuspectAt = now
	a.mu.Unlock()
}

// innerLoop is the leader's own regulation as the feed-in watchdog sees it:
// only a PROVEN device mode with an open charge side can take a surplus. A
// pending mode is not an inner loop yet - the device may still be following
// the reference setpoint.
func (a *Agent) innerLoop(dec guards.NativeDecision, r guards.Reading, limits guards.Limits, slot time.Time) guards.InnerLoop {
	if !dec.Native || !dec.Proven || !guards.IntentOpensCharge(dec.Intent) {
		return guards.InnerLoop{}
	}
	batt := math.NaN()
	a.mu.Lock()
	if a.lastBattKw != nil {
		batt = *a.lastBattKw
	}
	a.mu.Unlock()
	return guards.InnerLoop{
		Active:    true,
		CeilingKw: dec.Window.MaxKw,
		BatteryKw: batt,
		SocPct:    r.SocPct,
		SocMaxPct: limits.SocMaxPct,
		Slot:      slot,
	}
}

// composeCurtailment is the PV-cap half of applySetpoint: the live curtailment
// (curtailtrack) and the feed-in watchdog, composed most-restrictive-wins.
//
// K6 moved it BEHIND the Wegwahl because both halves need to know whether the
// leader regulates itself - the cascade's inner loop. nativeDecide reads neither
// the PV cap nor the watchdog, so the order changes no native decision, and
// without an inner loop every line below is what it was.
//
// NEGATIVPREIS / §51 (concept §6.3): where the slot curtails AND the leader
// stores the surplus itself, the tracker's feed-forward is the wrong law - it
// counts the COMMANDED charge, a number the device does not follow in its own
// mode. The slot then becomes "Einspeisegrenze 0 kW" for a second watchdog
// instance (exportZero, so the site's compliance limiter and its heartbeat keep
// meaning the registered limit): its cascade lets the battery charge to its
// ceiling and only then throttles the PV inverters on export <= 0. The curtailment
// still never outlives its slot - without the plan's pv_limit_kw nothing here
// runs.
func (a *Agent) composeCurtailment(now, readingAt time.Time, r guards.Reading, kw float64,
	pvLimit, exportLimit *float64, inner guards.InnerLoop,
) (*float64, *state.CurtailTrackInfo, *state.ExportGuardInfo) {
	if !readingAt.IsZero() {
		a.curtailTrack.Observe(readingAt, r.LoadKw, kw)
	}
	curtailCap := a.curtailTrack.Cap(now, pvLimit)
	curtailTrack := a.curtailTrackInfo(curtailCap)
	if curtailCap.Active && inner.Active {
		zero := 0.0
		economic := inner
		economic.Economic = true
		zc := a.exportZero.CapCascade(now, &zero, 0, economic)
		v := zc.CapKw
		pvLimit = &v
		curtailTrack.CapKw = zc.CapKw
		curtailTrack.Blind = zc.Blind
		curtailTrack.Reason = "Negativer Preis: der Wechselrichter lädt den Überschuss selbst in den Speicher, die " +
			"PV-Wechselrichter werden auf „keine Einspeisung“ geregelt. " + zc.CascadeText
		if b := inner.BatteryKw; !math.IsNaN(b) {
			curtailTrack.ChargeKw = &b
		}
	} else {
		// Not in use: forget, so the next such slot starts from a measurement.
		a.exportZero.Cap(now, nil, 0)
		if curtailCap.Active {
			v := curtailCap.CapKw
			pvLimit = &v
		}
	}

	exportCap := a.export.CapCascade(now, exportLimit, exportSafeStaticCap(exportLimit, kw), inner)
	if exportCap.Active {
		if pvLimit == nil || exportCap.CapKw < *pvLimit {
			v := exportCap.CapKw
			pvLimit = &v
		}
	}
	exportGuard := a.exportGuardInfo(exportCap)
	a.logExportGuard(exportGuard)
	return pvLimit, curtailTrack, exportGuard
}

// exportBackstop judges whether the site's feed-in limit survives the box
// (guards.ExportBackstopFor) and logs a changed verdict once.
func (a *Agent) exportBackstop(limitKw float64) guards.BackstopVerdict {
	a.srcMu.Lock()
	bal := a.bal
	var otherKwp float64
	otherUnknown := false
	for _, s := range a.srcs {
		if s.Role != sources.RoleErzeuger {
			continue
		}
		if s.CapacityKwp > 0 {
			otherKwp += s.CapacityKwp
		} else {
			otherUnknown = true
		}
	}
	a.srcMu.Unlock()
	var device *float64
	if d := a.State.Get().DeviceExportLimit; d != nil {
		kw := d.LimitKw
		device = &kw
	}
	limit := limitKw
	v, _ := guards.ExportBackstopFor(guards.BackstopInput{
		LimitKw:        &limit,
		Declared:       bal.ExportBackstop,
		DeviceLimitKw:  device,
		MeterLocation:  bal.MeterLocation(),
		OtherPvKwp:     otherKwp,
		OtherPvUnknown: otherUnknown,
	})
	a.mu.Lock()
	changed := v.Text != a.lastBackstop
	a.lastBackstop = v.Text
	a.mu.Unlock()
	if changed {
		if v.Covered {
			slog.Info("einspeisegrenze: geraeteseitiger rueckhalt", "source", v.Source, "text", v.Text)
		} else {
			slog.Warn("einspeisegrenze ohne geraeteseitigen rueckhalt", "text", v.Text)
		}
	}
	return v
}
