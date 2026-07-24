package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/calibration"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// This file wires the pure internal/calibration state machine into the running
// agent: the bounded write path (calibrationOverride, published on edge/setpoint),
// the controller-owned auto-revert watchdog, the measured-battery cross-check, the
// per-device certification hand-off, and the web.CalibrationController surface.
//
// The safety envelope (see internal/calibration for the pure half):
//   - OFF by default (Armed=false); an explicit arm + a specific test button are
//     required before any write - and arming refuses unless the GLOBAL kill-switch
//     VP_CONTROL_ENABLED is on AND a battery-controllable inverter is selected;
//   - the test value is magnitude-capped (calibration.StartTest) and STILL clamped
//     through guards.Clamp here, never around it;
//   - every write auto-reverts to the neutral release after Config.TTL, enforced by
//     armCalibrationWatchdog even if the UI is closed / the socket drops;
//   - control_enabled on the calibration setpoint bypasses ONLY the certification
//     allowlist (so the first real write can prove sign/scale); it is still ANDed
//     with the global kill-switch, so VP_CONTROL_ENABLED=false stops it dead;
//   - certification is a SEPARATE, deliberate step (CalibrationCertify) gated on the
//     operator confirming BOTH sign and scale - calibration never auto-certifies.

// calErr builds a user-facing (German) calibration.ValidationError the web layer
// maps to HTTP 400.
func calErr(format string, args ...any) error {
	return &calibration.ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// controlCertified reports whether a family may receive live control writes. It
// merges the env allowlist (config.ControlCertified, which treats an empty family
// as certified for the dev/sim path) with the per-device First-Light certification
// the operator granted via "Steuerung freigeben".
func (a *Agent) controlCertified(family string) bool {
	if a.Cfg.ControlCertified(family) {
		return true
	}
	a.calMu.Lock()
	defer a.calMu.Unlock()
	return a.calCert[strings.ToLower(strings.TrimSpace(family))]
}

// currentFamily is the selected register-map family ("" = none selected).
func (a *Agent) currentFamily() string {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil {
		return ""
	}
	return a.inv.Family
}

// calibrationControllable reports whether the selected inverter is a battery
// inverter the control executor can actually WRITE - the surfaces where First-Light
// applies: the Deye Solarman-V5 Time-of-Use path and the generic/SunSpec Modbus
// path. Fronius (planned-only, needs live discovery), the read-only Solar API and
// the go-e consumer never get a calibration write.
func calibrationControllable(sel inverter.Selection) bool {
	switch sel.Communication {
	case inverter.CommSolarmanV5, inverter.CommModbusTCP:
		return true
	}
	return false
}

// calibrationOverride publishes the bounded calibration setpoint (while a test is
// ACTIVE) or the neutral release (during the auto-revert window) INSTEAD of the
// plan/arbiter value, and returns true so applySetpoint returns early. It never
// bypasses guards.Clamp, the magnitude cap, or the global kill-switch - calibration
// only bypasses the certification allowlist. Not engaged -> returns false and the
// normal setpoint path runs unchanged.
func (a *Agent) calibrationOverride(now time.Time, r guards.Reading, limits guards.Limits) bool {
	a.calMu.Lock()
	engaged := a.cal.Engaged(now)
	active := a.cal.Phase(now) == calibration.PhaseActive
	cmd, hasCmd := a.cal.Command(now)
	a.calMu.Unlock()
	if !engaged {
		return false
	}

	family := a.currentFamily()
	certified := a.controlCertified(family)

	var (
		kw             float64
		controlEnabled bool
	)
	if active && hasCmd {
		// The bounded, magnitude-capped test value, STILL guard-clamped (rated band,
		// SoC window, §14a, EEG solar-only) - the SAME chain a plan setpoint gets.
		kw = guards.Clamp(cmd, limits, r)
		// control_enabled bypasses certification for the calibration write, but the
		// global kill-switch still wins (safety invariant: VP_CONTROL_ENABLED=false
		// stops it dead).
		controlEnabled = a.Cfg.ControlEnabled
	} else {
		// Auto-revert window: command NEUTRAL and control_enabled=false, so the flow's
		// controller-owned failsafe issues the release (hand back to self-consumption).
		kw = 0
		controlEnabled = false
	}

	msg := map[string]any{
		"battery_setpoint_kw": kw,
		"source":              "calibration",
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     controlEnabled,
		// The executor's certification bypass marker - only ever set on this bounded
		// path (never the plan/arbiter path). See inverter-control-routing.js.
		"calibration": true,
		// A calibration test never grid-charges (EEG-safe + unnecessary to prove sign/scale).
		"grid_charge_allowed": false,
		"soc_min_pct":         a.Cfg.SocMinPct,
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("calibration setpoint publish failed", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeCalibration
		s.SetpointKw = kw
		s.SlotStart = time.Time{}
		s.ControlEnabled = controlEnabled
		s.ControlCertified = certified
		s.PeakGuardActive = false
		s.PeakQuarterMeanKw = nil
	})
	return true
}

// nudgeSetpoint recomputes + republishes the setpoint immediately (the same
// react-now pattern the schedule update uses). Used by the calibration actions and
// the auto-revert watchdog so a state change is reflected without waiting a tick.
func (a *Agent) nudgeSetpoint() {
	if a.Bus == nil {
		return
	}
	a.applySetpoint(time.Now().UTC())
}

// armCalibrationWatchdog (re)starts the controller-owned auto-revert timer: at the
// test deadline it nudges applySetpoint so the neutral release is published promptly
// (not up to a setpoint tick later), INDEPENDENT of the UI. Must be called under calMu.
func (a *Agent) armCalibrationWatchdog(d time.Duration) {
	if a.calWatchdog != nil {
		a.calWatchdog.Stop()
	}
	a.calWatchdog = time.AfterFunc(d, a.nudgeSetpoint)
}

// liveCalibrationReading copies out the latest measured battery power + SoC (the
// verdict's cross-check inputs) under a.mu, so calMu is never held under a.mu.
func (a *Agent) liveCalibrationReading() calibration.Reading {
	a.mu.Lock()
	batt := a.lastBattKw
	soc := a.lastReading.SocPct
	a.mu.Unlock()
	live := calibration.Reading{}
	if batt != nil {
		v := *batt
		live.BatteryKw = &v
	}
	if !math.IsNaN(soc) {
		v := soc
		live.SocPct = &v
	}
	return live
}

// calibrationSnapshot builds the /api/calibration payload: the pure session view
// decorated with the agent context (availability, kill-switch, family, certified).
func (a *Agent) calibrationSnapshot(now time.Time) calibration.Snapshot {
	live := a.liveCalibrationReading()
	band := calibration.SocBand{MinPct: a.Cfg.SocMinPct, MaxPct: a.Cfg.SocMaxPct}
	a.calMu.Lock()
	snap := a.cal.Snapshot(now, live, band)
	a.calMu.Unlock()

	snap.ControlEnabled = a.Cfg.ControlEnabled
	sel, ok := a.GetInverter()
	switch {
	case !ok:
		snap.Reason = "Bitte wählen Sie zuerst Ihren Wechselrichter aus."
	case !calibrationControllable(sel):
		snap.Family = sel.Family
		snap.Reason = "Für diesen Wechselrichter ist keine Batterie-Steuerung verfügbar."
	default:
		snap.Available = true
		snap.Family = sel.Family
		snap.Certified = a.controlCertified(sel.Family)
		snap.InvertControlSign = sel.Connection.InvertControlSign
		snap.PowerScale = sel.Connection.PowerScale
		if snap.BatteryKw == nil && snap.SocPct == nil {
			snap.Reason = "Der Wechselrichter liefert noch keine Batterie-Messwerte - kurz warten."
		}
	}
	// The global kill-switch overrides everything: no calibration write is possible.
	if !a.Cfg.ControlEnabled {
		snap.Available = false
		snap.Reason = "Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert (Not-Aus)."
	}
	return snap
}

// CalibrationSnapshot implements web.CalibrationController (GET /api/calibration).
func (a *Agent) CalibrationSnapshot() calibration.Snapshot {
	return a.calibrationSnapshot(time.Now().UTC())
}

// CalibrationArm arms/disarms calibration mode. Arming refuses unless the global
// kill-switch is on AND a battery-controllable inverter is selected. Disarming
// aborts any active test (so it auto-reverts to neutral).
func (a *Agent) CalibrationArm(armed bool) (calibration.Snapshot, error) {
	now := time.Now().UTC()
	if armed {
		if err := a.calibrationPreflight(); err != nil {
			return a.calibrationSnapshot(now), err
		}
	}
	a.calMu.Lock()
	if armed {
		a.cal.Arm()
	} else {
		a.cal.Disarm(now)
		if a.calWatchdog != nil {
			a.calWatchdog.Stop()
		}
	}
	a.calMu.Unlock()
	a.nudgeSetpoint() // disarm -> publish the neutral revert promptly
	return a.calibrationSnapshot(now), nil
}

// CalibrationStartTest arms a single bounded test (a small charge/discharge write).
func (a *Agent) CalibrationStartTest(dir string, magnitudeKw float64) (calibration.Snapshot, error) {
	now := time.Now().UTC()
	if err := a.calibrationPreflight(); err != nil {
		return a.calibrationSnapshot(now), err
	}
	d := calibration.Direction(strings.ToLower(strings.TrimSpace(dir)))
	before := a.liveCalibrationReading()

	a.calMu.Lock()
	err := a.cal.StartTest(d, magnitudeKw, before, now)
	if err == nil {
		a.armCalibrationWatchdog(a.Cfg.CalibrationTTL)
	}
	a.calMu.Unlock()
	if err != nil {
		// StartTest returns *calibration.ValidationError - surface it as a 400.
		return a.calibrationSnapshot(now), err
	}
	a.nudgeSetpoint() // publish the calibration setpoint immediately
	return a.calibrationSnapshot(now), nil
}

// CalibrationAbort ends the active test immediately (auto-revert to neutral).
func (a *Agent) CalibrationAbort() calibration.Snapshot {
	now := time.Now().UTC()
	a.calMu.Lock()
	a.cal.Abort(now)
	if a.calWatchdog != nil {
		a.calWatchdog.Stop()
	}
	a.calMu.Unlock()
	a.nudgeSetpoint()
	return a.calibrationSnapshot(now)
}

// CalibrationConfirm records the operator's sign/scale verdict (nil = leave as is).
func (a *Agent) CalibrationConfirm(sign, scale *bool) calibration.Snapshot {
	a.calMu.Lock()
	if sign != nil {
		a.cal.ConfirmSign(*sign)
	}
	if scale != nil {
		a.cal.ConfirmScale(*scale)
	}
	a.calMu.Unlock()
	return a.calibrationSnapshot(time.Now().UTC())
}

// CalibrationCorrection patches the WRITE-path sign / power scale on the inverter
// connection and re-persists + re-publishes the selection, so the next calibration
// write uses them. Because the proof is now stale, it resets the operator
// confirmations AND removes any First-Light certification for that family.
func (a *Agent) CalibrationCorrection(invertSign *bool, powerScale *float64) (calibration.Snapshot, error) {
	now := time.Now().UTC()
	sel, ok := a.GetInverter()
	if !ok {
		return a.calibrationSnapshot(now), calErr("Kein Wechselrichter ausgewählt.")
	}
	req := inverter.SelectionRequest{
		Brand:      sel.Brand,
		Model:      sel.Model,
		Family:     sel.Family,
		Connection: sel.Connection,
	}
	if invertSign != nil {
		req.Connection.InvertControlSign = *invertSign
	}
	if powerScale != nil {
		req.Connection.PowerScale = *powerScale
	}
	if _, err := a.SetInverter(req); err != nil {
		var ve *inverter.ValidationError
		if errors.As(err, &ve) {
			return a.calibrationSnapshot(now), &calibration.ValidationError{Msg: ve.Msg}
		}
		return a.calibrationSnapshot(now), calErr("Die Korrektur konnte nicht gespeichert werden.")
	}
	// A sign/scale change invalidates prior confirmations + certification for this
	// family (the proof is stale) - reset both so the operator re-verifies.
	family := strings.ToLower(strings.TrimSpace(sel.Family))
	a.calMu.Lock()
	a.cal.ResetConfirmations()
	decertified := a.calCert[family]
	delete(a.calCert, family)
	a.calMu.Unlock()
	if decertified {
		if err := a.persistCalibrationCert(); err != nil {
			slog.Warn("could not persist decertification after a control correction", "err", err)
		}
	}
	a.nudgeSetpoint()
	return a.calibrationSnapshot(now), nil
}

// CalibrationCertify is the deliberate hand-off: once the operator confirmed BOTH
// sign and scale (Passed), add the selected family to the per-device certification
// so the optimizer's Fahrplan drives it live. This is the ONLY calibration path to
// certification - it never happens automatically.
func (a *Agent) CalibrationCertify() (calibration.Snapshot, error) {
	now := time.Now().UTC()
	sel, ok := a.GetInverter()
	if !ok || !calibrationControllable(sel) {
		return a.calibrationSnapshot(now), calErr("Für diesen Wechselrichter ist keine Freigabe möglich.")
	}
	family := strings.ToLower(strings.TrimSpace(sel.Family))
	if family == "" {
		return a.calibrationSnapshot(now), calErr("Kein Modell erkannt.")
	}
	a.calMu.Lock()
	passed := a.cal.Passed()
	if passed {
		a.calCert[family] = true
	}
	a.calMu.Unlock()
	if !passed {
		return a.calibrationSnapshot(now), calErr("Bitte bestätigen Sie zuerst Vorzeichen UND Skala.")
	}
	if err := a.persistCalibrationCert(); err != nil {
		// Roll back the in-memory grant if it cannot be persisted (a restart would
		// otherwise silently drop it and mislead the operator).
		a.calMu.Lock()
		delete(a.calCert, family)
		a.calMu.Unlock()
		return a.calibrationSnapshot(now), calErr("Die Freigabe konnte nicht gespeichert werden.")
	}
	slog.Warn("First-Light: inverter control CERTIFIED for this device via calibration", "family", family)
	a.nudgeSetpoint() // control_enabled now flips true for the optimizer/arbiter path
	return a.calibrationSnapshot(now), nil
}

// calibrationPreflight is the shared guard for arm + start: the global kill-switch
// must be on and a battery-controllable inverter must be selected.
func (a *Agent) calibrationPreflight() error {
	if !a.Cfg.ControlEnabled {
		return calErr("Die Wechselrichter-Steuerung ist deaktiviert (Not-Aus). Kalibrierung nicht möglich.")
	}
	sel, ok := a.GetInverter()
	if !ok {
		return calErr("Bitte wählen Sie zuerst Ihren Wechselrichter aus.")
	}
	if !calibrationControllable(sel) {
		return calErr("Für diesen Wechselrichter ist keine Batterie-Kalibrierung verfügbar.")
	}
	return nil
}

// --- persisted per-device certification (data-dir/calibration-certified.json) ---

type calibrationCertFile struct {
	Families []string `json:"families"`
}

func (a *Agent) calibrationCertPath() string {
	return filepath.Join(a.Cfg.DataDir, "calibration-certified.json")
}

// loadCalibrationCert restores the persisted certification set at boot. A missing
// file is normal; a corrupt one leaves the set empty (the fail-safe default).
func (a *Agent) loadCalibrationCert() {
	raw, err := os.ReadFile(a.calibrationCertPath())
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("calibration certification unreadable; none applied", "err", err)
		}
		return
	}
	var f calibrationCertFile
	if err := json.Unmarshal(raw, &f); err != nil {
		slog.Warn("calibration certification corrupt; none applied", "err", err)
		return
	}
	a.calMu.Lock()
	for _, fam := range f.Families {
		if fam = strings.ToLower(strings.TrimSpace(fam)); fam != "" {
			a.calCert[fam] = true
		}
	}
	a.calMu.Unlock()
	if len(f.Families) > 0 {
		slog.Info("First-Light: restored per-device control certification", "families", f.Families)
	}
}

// persistCalibrationCert writes the current certification set atomically (tmp +
// rename, 0600), like the other data-dir stores.
func (a *Agent) persistCalibrationCert() error {
	a.calMu.Lock()
	fams := make([]string, 0, len(a.calCert))
	for fam, ok := range a.calCert {
		if ok {
			fams = append(fams, fam)
		}
	}
	a.calMu.Unlock()
	sort.Strings(fams)
	raw, err := json.MarshalIndent(calibrationCertFile{Families: fams}, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.calibrationCertPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.calibrationCertPath())
}
