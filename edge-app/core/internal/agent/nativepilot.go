package agent

// K5 PILOTFENSTER der Deye-Ladeseite (Konzept vp-wechselrichter-eigenregelung-k1
// §8, Captain-Entscheid E7 A): die Verdrahtung des reinen Zustandsautomaten
// internal/nativepilot in den Sollwert-, Telemetrie- und Rueckmeldepfad - nach
// dem Muster des Netz-Sollwert-Tests (agent/gridtest.go).
//
// ⚠ NUR VON HAND: der einzige Eintritt ist NativePilotStart hinter dem
// Betreiber-Kennwort (POST /api/native/pilot, web.calGuard). Kein Fahrplan,
// kein Zeitplan, kein Neustart armiert ihn; jeder Lauf endet nach hoechstens
// nativepilot.MaxDuration von selbst, und danach uebernimmt der Plan.
//
// ⚠ ER UMGEHT NUR DAS ZERTIFIKAT DES KANDIDATEN - das ist sein Zweck, denn der
// Pilot ist der Pruefstand. Not-Aus, First-Light-Freigabe und Fernsteuerpfad
// sind Voraussetzungen des Armierens; Layer 1 prueft Vorbedingung und
// EEG-Beleg des Geraets weiter (deye-charge-side.js), und der veroeffentlichte
// `grid_charge_allowed` ist immer false.

import (
	"encoding/json"
	"log/slog"
	"math"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/nativepilot"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// nativePilotSource is the setpoint `source` of a pilot cycle; only readbacks
// of this source feed the run (a foreign cycle proves nothing about it).
const nativePilotSource = "native-pilot"

// nativePilotConditions gathers what Start judges.
func (a *Agent) nativePilotConditions(now time.Time) nativepilot.Conditions {
	a.mu.Lock()
	p := a.currentPlan
	r := a.lastReading
	readingAt := a.lastReadingAt
	a.mu.Unlock()
	_, _, ratedKw, isDeye := a.gridPrimaryDeye()
	family := a.currentFamily()
	snap := a.State.Get()
	a.gridMu.Lock()
	gridBusy := a.gridCal.Engaged(now)
	a.gridMu.Unlock()
	c := nativepilot.Conditions{
		ControlEnabled: a.Cfg.ControlEnabled,
		Certified:      a.controlCertified(family),
		RemotePath:     isDeye && snap.Control != nil && snap.Control.ControlPath == "remote",
		OtherTest:      gridBusy || snap.Mode == state.ModeCalibration,
		RatedKw:        ratedKw,
		SocMaxPct:      a.Cfg.SocMaxPct,
		MeasurementAge: 24 * time.Hour,
	}
	if !readingAt.IsZero() {
		c.MeasurementAge = now.Sub(readingAt)
	}
	if !math.IsNaN(r.SocPct) {
		v := r.SocPct
		c.SocPct = &v
	}
	if p != nil {
		c.FloorPct = p.EffectiveFloorSoc()
		if _, start, ok := p.ActiveSetpoint(now); ok && p.SlotMinutes > 0 {
			c.SlotEnd = start.Add(time.Duration(p.SlotMinutes) * time.Minute)
		}
	}
	return c
}

// nativePilotObserve feeds a telemetry sample (called from onLocalTelemetry).
func (a *Agent) nativePilotObserve(now time.Time, measurements map[string]float64, battKw *float64) {
	o := nativepilot.Observation{BatteryKw: battKw}
	if v, ok := measurements["power_kw"]; ok {
		o.GridKw = &v
	}
	if v, ok := measurements["soc_pct"]; ok {
		o.SocPct = &v
	}
	sp := a.State.Get().SetpointKw
	o.SetpointKw = &sp
	a.pilotMu.Lock()
	active := a.pilot.Active()
	a.pilot.Observe(o, now)
	ended := active && !a.pilot.Active()
	a.pilotMu.Unlock()
	if ended {
		a.nudgeSetpoint() // hand the inverter back to the plan at once
	}
}

// nativePilotNoteReadback feeds a control readback of this run.
func (a *Agent) nativePilotNoteReadback(info *state.ControlInfo, unconfirmed bool, now time.Time) {
	if info == nil || !strings.EqualFold(strings.TrimSpace(info.Source), nativePilotSource) {
		return
	}
	gcb := info.NativePreconditionGridChargeBlocked
	if info.Mode == batteryModeNative {
		gcb = info.NativeGridChargeBlocked
	}
	rb := nativepilot.Readback{
		Native:            info.Mode == batteryModeNative && info.AllMatch,
		Intent:            info.NativeIntent,
		Candidate:         info.NativeCandidate,
		GridChargeBlocked: gcb,
		Refusal:           info.NativeRefusal,
		Wrote:             info.Wrote,
		Mismatch:          !unconfirmed && !info.AllMatch,
	}
	a.pilotMu.Lock()
	active := a.pilot.Active()
	a.pilot.NoteReadback(rb, now)
	ended := active && !a.pilot.Active()
	a.pilotMu.Unlock()
	if ended {
		a.nudgeSetpoint()
	}
}

// nativePilotOverride publishes the pilot's setpoint while a run is armed and
// reports whether it did (applySetpoint then returns, like the grid test).
func (a *Agent) nativePilotOverride(now time.Time, p *plan.Plan) bool {
	family := a.currentFamily()
	certified := a.controlCertified(family)
	controlEnabled := a.Cfg.ControlEnabled && certified
	a.pilotMu.Lock()
	cmd, engaged := a.pilot.Publish(now, controlEnabled)
	var minKw, maxKw float64
	if engaged {
		minKw, maxKw = a.pilot.Current().Window()
	}
	a.pilotMu.Unlock()
	if !engaged {
		return false
	}
	msg := map[string]any{
		// The device regulates; 0 is the reference the ordinary plan would write
		// if Layer 1 refuses the candidate (the battery then rests).
		"battery_setpoint_kw":   0.0,
		"source":                nativePilotSource,
		"ts":                    now.Format(time.RFC3339Nano),
		"control_enabled":       controlEnabled,
		"device_certified":      certified,
		"grid_charge_allowed":   false,
		"soc_min_pct":           a.Cfg.SocMinPct,
		"soc_max_pct":           a.Cfg.SocMaxPct,
		"battery_mode":          guards.NativeModeFor(cmd.Intent),
		"battery_native_intent": cmd.Intent,
		"battery_window_min_kw": minKw,
		"battery_window_max_kw": maxKw,
		"native_pilot":          cmd,
	}
	if f := p.EffectiveFloorSoc(); f != nil {
		msg["effective_floor_soc_pct"] = *f
	}
	if certified {
		if pth := a.certifiedControlPath(family); pth != "" {
			msg["device_certified_path"] = pth
		}
	}
	// The Fronius caps stay plan-owned: a curtailment never travels with (or
	// is dropped by) a hand-over.
	if lim := p.ActivePvLimit(now); lim != nil && *lim >= 0 {
		msg["pv_limit_kw"] = math.Round(*lim*1000) / 1000
	}
	if cur := a.curtailSetpointExtras(now); cur != nil {
		msg["curtail"] = cur
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("native-pilot setpoint publish failed", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeCalibration
		s.SetpointKw = 0
		s.SlotStart = time.Time{}
		s.ControlEnabled = controlEnabled
		s.ControlCertified = certified
		s.PeakGuardActive = false
		s.PeakQuarterMeanKw = nil
		s.Trim = nil
		s.Follow = nil
		s.Absorb = nil
		s.Native = nil
	})
	a.trim.Release()
	a.follow.Release()
	a.absorb.Release()
	a.native.Release()
	return true
}

// NativePilotSnapshot implements GET /api/native/pilot.
func (a *Agent) NativePilotSnapshot() nativepilot.View {
	return a.nativePilotView(time.Now().UTC())
}

func (a *Agent) nativePilotView(now time.Time) nativepilot.View {
	_, _, _, isDeye := a.gridPrimaryDeye()
	a.pilotMu.Lock()
	run := a.pilot.Snapshot(now)
	a.pilotMu.Unlock()
	v := nativepilot.View{Available: isDeye, MaxMinutes: int(nativepilot.MaxDuration / time.Minute), Run: run}
	if !isDeye {
		v.Reason = "Dieser Anlage ist kein Deye mit Fernsteuer-Block zugeordnet."
	}
	return v
}

// NativePilotStart arms a run - the ONLY entry (operator-guarded).
func (a *Agent) NativePilotStart(req nativepilot.Request) (nativepilot.View, error) {
	now := time.Now().UTC()
	if _, _, _, isDeye := a.gridPrimaryDeye(); !isDeye {
		return a.nativePilotView(now), nativepilot.ValidationError{
			Msg: "Das Pilotfenster gilt der Deye-Ladeseite (Register 1100-1121). Dieser Anlage ist kein Deye als Wechselrichter zugeordnet.",
		}
	}
	cond := a.nativePilotConditions(now)
	a.pilotMu.Lock()
	r, err := a.pilot.Start(req, cond, now)
	if err == nil {
		if a.pilotWatchdog != nil {
			a.pilotWatchdog.Stop()
		}
		// The self-return, independent of the operator's attention: one nudge at
		// the deadline ends the override and the plan takes over.
		a.pilotWatchdog = time.AfterFunc(r.Deadline.Sub(now)+2*time.Second, a.nudgeSetpoint)
	}
	a.pilotMu.Unlock()
	if err != nil {
		return a.nativePilotView(now), err
	}
	slog.Warn("Pilotfenster Deye-Ladeseite armiert (begrenzt, selbst zuruecknehmend)",
		"run", r.ID, "candidate", r.Req.Candidate, "intent", r.Req.Intent, "case", r.Req.Case,
		"ttl_s", int(r.Deadline.Sub(now)/time.Second))
	a.nudgeSetpoint()
	return a.nativePilotView(now), nil
}

// NativePilotAbort ends the run at once; the plan takes over on the next tick.
func (a *Agent) NativePilotAbort() nativepilot.View {
	now := time.Now().UTC()
	a.pilotMu.Lock()
	a.pilot.Abort(now)
	if a.pilotWatchdog != nil {
		a.pilotWatchdog.Stop()
	}
	a.pilotMu.Unlock()
	a.nudgeSetpoint()
	return a.nativePilotView(now)
}
