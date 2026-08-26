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
// is the ONE place the THREE certification sources are merged:
//
//  1. the fleet-wide env allowlist (config.ControlCertified, which treats an
//     empty family as certified for the dev/sim path),
//  2. the per-device First-Light certification the operator granted here via
//     "Steuerung freigeben" (calibration-certified.json),
//  3. the PLATFORM register the cloud published (agent/controlcert.go) - a model
//     certified ONCE at a bench, valid fleet-wide, and armed per plant.
//
// They are ORed, so source 3 can only ever ADD a grant: an existing plant keeps
// exactly the state it had, and a fresh box gets nothing until its model is in
// the register AND an operator armed it. Everything downstream is unchanged -
// the kill switch is still the outer AND, and guards.Clamp still binds.
func (a *Agent) controlCertified(family string) bool {
	if a.Cfg.ControlCertified(family) {
		return true
	}
	a.calMu.Lock()
	local := a.calCert[strings.ToLower(strings.TrimSpace(family))]
	a.calMu.Unlock()
	if local {
		return true
	}
	return a.platformCertified(family)
}

// deviceCertified reports ONLY the per-device First-Light grant, without the
// fleet-wide env allowlist. That is the half a sign/scale correction and
// "Freigabe zurücknehmen" actually remove, so it is what the surface must
// announce as a consequence (see calibration.Snapshot.DeviceCertified).
func (a *Agent) deviceCertified(family string) bool {
	a.calMu.Lock()
	defer a.calMu.Unlock()
	return a.calCert[strings.ToLower(strings.TrimSpace(family))]
}

// certifiedControlPath returns the control surface the family's First-Light grant
// was proven on ("remote"/"tou"), or "" when unknown (env-allowlisted family, or a
// pre-path grant that has not been backfilled yet). Published on edge/setpoint as
// device_certified_path so Layer 1's sticky path decision can seed from it.
// Falls back to the PLATFORM register's benched path when this box has no
// First-Light evidence of its own: the bench proved that surface for this model,
// which is exactly the fact the sticky decision wants to be seeded with.
func (a *Agent) certifiedControlPath(family string) string {
	a.calMu.Lock()
	local := a.calPath[strings.ToLower(strings.TrimSpace(family))]
	a.calMu.Unlock()
	if local != "" {
		return local
	}
	return a.platformControlPath(family)
}

// backfillCertifiedControlPath records the driving path ONCE for a family that
// already carries a device grant but no recorded path (a grant certified before
// the path field existed - the live Pilsting pilot). Called from onControlReadback
// with a NORMAL (non-release, non-blocked) readback's control_path: the device is
// demonstrably being driven on that surface under its grant, which is exactly the
// fact the record captures. Never overwrites an existing path (only certify does).
func (a *Agent) backfillCertifiedControlPath(family, path string) {
	if path != "remote" && path != "tou" {
		return
	}
	fam := strings.ToLower(strings.TrimSpace(family))
	if fam == "" {
		return
	}
	a.calMu.Lock()
	_, has := a.calPath[fam]
	granted := a.calCert[fam]
	if !granted || has {
		a.calMu.Unlock()
		return
	}
	a.calPath[fam] = path
	a.calMu.Unlock()
	if err := a.persistCalibrationCert(); err != nil {
		// Undo so a later readback retries the backfill (memory matches disk).
		a.calMu.Lock()
		delete(a.calPath, fam)
		a.calMu.Unlock()
		slog.Warn("could not persist the certified control path backfill; will retry", "err", err)
		return
	}
	slog.Info("First-Light: recorded the PROVEN control path for an existing grant", "family", fam, "path", path)
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
		// The per-device certification verdict, carried on EVERY setpoint (see
		// applySetpoint). During First-Light on a not-yet-released device this is
		// false and `calibration` alone opens the executor's gate - which is exactly
		// the point: the grant is EARNED here, not assumed. Once released it reports
		// true honestly, so a re-test on a released device is not misreported.
		"device_certified": certified,
		// The executor's certification bypass marker - only ever set on this bounded
		// path (never the plan/arbiter path). See inverter-control-routing.js.
		"calibration": true,
		// A calibration test never grid-charges (EEG-safe + unnecessary to prove sign/scale).
		"grid_charge_allowed": false,
		"soc_min_pct":         a.Cfg.SocMinPct,
		// The ceiling half of the guard band (see applySetpoint): the Deye remote-mode
		// adapter arms the inverter's own SoC belt with it on a charge test.
		"soc_max_pct": a.Cfg.SocMaxPct,
	}
	// The grant's proven path rides the calibration setpoint too (same field as
	// applySetpoint), so a released device's re-test keeps the sticky decision seeded.
	if certified {
		if p := a.certifiedControlPath(family); p != "" {
			msg["device_certified_path"] = p
		}
	}
	// The curtailment block rides the calibration setpoint too, so a battery
	// First-Light test never blanks the Fronius caps (the flow would otherwise
	// stop refreshing them and the native revert timer would lift a legitimate
	// plan cap mid-test).
	if cur := a.curtailSetpointExtras(now); cur != nil {
		msg["curtail"] = cur
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
		// A bounded calibration write is not a plan setpoint, so neither the
		// price-aware trim nor the load following can apply to it - never leave a
		// stale "limited"/"following" claim on the card.
		s.Trim = nil
		s.Follow = nil
		// Nor can the native self-regulation: a bounded First-Light write OWNS
		// the inverter for its TTL, so "the device regulates itself" would be a
		// claim about the exact opposite of what is happening.
		s.Native = nil
	})
	a.trim.Release()
	a.follow.Release()
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
// verdict's cross-check inputs) under a.mu, so calMu is never held under a.mu. The
// battery power carries the documented + charge / - discharge convention (the decode
// boundary honors it via the connection's invert_batt_sign); the verdict and the
// card's "BATTERIE JETZT" tile rely on that convention (charge positive), so a
// firmware whose raw register is inverted MUST have invert_batt_sign set or both read
// backwards.
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
	// Snapshot latches the live reading as confirmation evidence (ObserveReading), so a
	// polling card captures the measured movement while the test is active (Defect 1).
	snap := a.cal.Snapshot(now, live, band)
	a.calMu.Unlock()

	snap.ControlEnabled = a.Cfg.ControlEnabled
	// The admin gate is active only when a secret is configured (opt-in); the surface
	// prompts for it and the mutation endpoints enforce it. Read-only views stay open.
	snap.AdminGate = a.Cfg.CalibrationAdminSecret != ""
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
		snap.DeviceCertified = a.deviceCertified(sel.Family)
		snap.InvertControlSign = sel.Connection.InvertControlSign
		snap.PowerScale = sel.Connection.PowerScale
		snap.InvertBattSign = sel.Connection.InvertBattSign
		// The test-power ladder is derived from the inverter's nameplate so the smallest
		// rung actually moves the battery (Defect 2); rated 0 = unknown -> fixed fallback
		// ladder and the surface says why (Defect 3). The hard cap max_kw stays the ceiling.
		snap.RatedKw = sel.RatedKw
		snap.TestSteps = calibration.TestStepsForRated(sel.RatedKw, a.Cfg.CalibrationMaxKw)
		if snap.Test != nil {
			snap.Test.NextStepKw = calibration.NextStepAbove(snap.TestSteps, snap.Test.CommandKw)
		}
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

// CalibrationAdminSecret returns the configured admin secret that gates the
// calibration MUTATION endpoints (empty = no gate, calibration stays open like the
// rest of the :8484 surface). The owner sets it with VP_CALIBRATION_ADMIN_SECRET;
// the web layer rejects unauthenticated mutations server-side when it is set.
func (a *Agent) CalibrationAdminSecret() string { return a.Cfg.CalibrationAdminSecret }

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
// Setting a confirmation TRUE is EVIDENCE-GATED (report §7 Gap B): the pure session
// refuses it unless the current test's write read back a match AND the MEASURED battery
// moved as commanded, so the live reading is passed in for the verdict. A refusal is a
// *calibration.ValidationError the web layer maps to 400. Clearing (false) never errors.
func (a *Agent) CalibrationConfirm(sign, scale *bool) (calibration.Snapshot, error) {
	now := time.Now().UTC()
	after := a.liveCalibrationReading() // acquires a.mu then releases, before calMu
	a.calMu.Lock()
	// Latch the current live reading as evidence first (a no-op unless the test is
	// active + confirmable), then confirm against the captured, still-valid evidence -
	// so a confirmation made AFTER the test auto-reverted still succeeds within
	// ConfirmGrace (Defect 1), while an expired one is refused.
	a.cal.ObserveReading(now, after)
	var err error
	if sign != nil {
		err = a.cal.ConfirmSign(*sign, now)
	}
	if err == nil && scale != nil {
		err = a.cal.ConfirmScale(*scale, now)
	}
	a.calMu.Unlock()
	return a.calibrationSnapshot(now), err
}

// CalibrationCorrection patches the WRITE-path control sign / power scale AND the
// READ-path measured-battery sign on the inverter connection and re-persists +
// re-publishes the selection, so the next calibration write AND the measured
// cross-check use them. invertBattSign is the read-side fix for a battery that reads
// inverted vs the cockpit (the captain's SUN-30K HV firmware, DEYE.md): it is the
// operator's lever right where they notice it on the card. Because any of these
// invalidates the proof, it resets the operator confirmations AND removes any
// First-Light certification for that family.
func (a *Agent) CalibrationCorrection(invertSign *bool, powerScale *float64, invertBattSign *bool) (calibration.Snapshot, error) {
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
	if invertBattSign != nil {
		req.Connection.InvertBattSign = *invertBattSign
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
	delete(a.calPath, family)
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
	canCertify := a.cal.CanCertify() // Passed() AND the current test's write read back a match
	certPath := ""
	if canCertify {
		a.calCert[family] = true
		// The grant carries the path its EVIDENCE was produced on (the calibration
		// readback's control_path): "remote" seeds Layer 1's sticky path decision so
		// the proven surface survives restarts and degenerate probe answers, and a
		// remote-proven device never silently swaps to EEPROM ToU control. An empty
		// path (older Layer 1 readback) records nothing - compat, never a guess.
		if p := a.cal.LastControlPath(); p == "remote" || p == "tou" {
			a.calPath[family] = p
			certPath = p
		}
	}
	a.calMu.Unlock()
	if !canCertify {
		// Distinguish "confirm the boxes" from "no real write landed yet" (Gap B).
		if !passed {
			return a.calibrationSnapshot(now), calErr("Bitte bestätigen Sie zuerst Vorzeichen UND Skala.")
		}
		return a.calibrationSnapshot(now), calErr("Für die Freigabe fehlt eine bestätigte Rückmeldung des Wechselrichters. Bitte führen Sie einen Testlauf durch, bis das Schreiben zurückgelesen und bestätigt wurde.")
	}
	if err := a.persistCalibrationCert(); err != nil {
		// Roll back the in-memory grant if it cannot be persisted (a restart would
		// otherwise silently drop it and mislead the operator).
		a.calMu.Lock()
		delete(a.calCert, family)
		delete(a.calPath, family)
		a.calMu.Unlock()
		return a.calibrationSnapshot(now), calErr("Die Freigabe konnte nicht gespeichert werden.")
	}
	slog.Warn("First-Light: inverter control CERTIFIED for this device via calibration", "family", family, "path", certPath)
	a.nudgeSetpoint() // control_enabled now flips true for the optimizer/arbiter path
	return a.calibrationSnapshot(now), nil
}

// CalibrationDecertify is the deliberate counterpart to CalibrationCertify ("Freigabe
// zurücknehmen", report §7 Gap A): it removes the selected family from the per-device
// certification, re-persists, and nudges the setpoint so control_certified flips false
// and the family returns to read-only. Mirrors CalibrationCertify's persist rollback so
// the in-memory grant and the on-disk file never diverge. (An env-allowlisted family
// stays certified fleet-wide - this only revokes the per-device First-Light grant.)
func (a *Agent) CalibrationDecertify() (calibration.Snapshot, error) {
	now := time.Now().UTC()
	sel, ok := a.GetInverter()
	if !ok {
		return a.calibrationSnapshot(now), calErr("Kein Wechselrichter ausgewählt.")
	}
	family := strings.ToLower(strings.TrimSpace(sel.Family))
	if family == "" {
		return a.calibrationSnapshot(now), calErr("Kein Modell erkannt.")
	}
	a.calMu.Lock()
	was := a.calCert[family]
	wasPath := a.calPath[family]
	delete(a.calCert, family)
	delete(a.calPath, family)
	a.calMu.Unlock()
	if was {
		if err := a.persistCalibrationCert(); err != nil {
			// Roll back so memory matches disk (a restart would otherwise re-certify).
			a.calMu.Lock()
			a.calCert[family] = true
			if wasPath != "" {
				a.calPath[family] = wasPath
			}
			a.calMu.Unlock()
			return a.calibrationSnapshot(now), calErr("Die Freigabe konnte nicht zurückgenommen werden.")
		}
		slog.Warn("First-Light: inverter control DECERTIFIED for this device (Freigabe zurückgenommen)", "family", family, "was_path", wasPath)
	}
	a.nudgeSetpoint() // control_certified now flips false -> the family is read-only again
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

// calibrationCertVersion is the schema version of calibration-certified.json, bumped
// whenever the MEANING of a stored certification changes. A file BELOW this version was
// written before the current safety gate existed, so its grants cannot be trusted and
// are invalidated once, on load (loadCalibrationCert). v1 introduces the Gap-B evidence
// gate (report §7): a pre-v1 certification was granted WITHOUT the objective
// write->readback + measured-movement proof (it was possible via a manual tick), so on
// upgrade the inverter goes READ-ONLY until a real, evidence-backed First-Light
// re-certifies it. CRITICAL: this is what stops a stale, unverified certification from
// driving the battery the moment the socket-coordination fix makes writes land.
const calibrationCertVersion = 1

// Paths is ADDITIVE (no version bump - bumping would invalidate the live pilot's
// evidence-gated grant, see the version comment above): per granted family, the
// control surface the First-Light evidence was produced on ("remote"/"tou").
// Recorded at certify time from the calibration readback's control_path, and
// backfilled ONCE for a pre-path grant when a normal certified readback names the
// driving path (onControlReadback). Published as device_certified_path on
// edge/setpoint so Layer 1's sticky path decision survives restarts + probe
// failures. An older core reading a newer file simply ignores the field.
type calibrationCertFile struct {
	Version  int               `json:"version"`
	Families []string          `json:"families"`
	Paths    map[string]string `json:"paths,omitempty"`
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
	// One-time invalidation on upgrade (report §7 CRITICAL): a certification recorded
	// BELOW the current schema version was granted before the current safety gate
	// existed (v1 = the Gap-B evidence gate), so it cannot be trusted. Drop it and
	// re-persist an empty, version-stamped file; the inverter stays READ-ONLY until the
	// operator re-runs a real, evidence-backed First-Light. Runs once (next boot sees v1);
	// if the re-persist fails, none is applied THIS boot and the migration retries next boot
	// (fail-safe: read-only until it succeeds).
	if f.Version < calibrationCertVersion {
		if len(f.Families) > 0 {
			slog.Warn("First-Light: invalidating a pre-evidence-gate control certification; the inverter is READ-ONLY until re-certified via a real First-Light",
				"families", f.Families, "was_version", f.Version, "gate_version", calibrationCertVersion)
		}
		if err := a.persistCalibrationCert(); err != nil {
			slog.Warn("could not persist the certification invalidation; will retry on next boot", "err", err)
		}
		return
	}
	a.calMu.Lock()
	for _, fam := range f.Families {
		if fam = strings.ToLower(strings.TrimSpace(fam)); fam != "" {
			a.calCert[fam] = true
		}
	}
	// The proven control path travels with its grant: only paths of GRANTED
	// families are applied (a stray path without a grant carries no meaning).
	for fam, p := range f.Paths {
		fam = strings.ToLower(strings.TrimSpace(fam))
		if a.calCert[fam] && (p == "remote" || p == "tou") {
			a.calPath[fam] = p
		}
	}
	a.calMu.Unlock()
	if len(f.Families) > 0 {
		slog.Info("First-Light: restored per-device control certification", "families", f.Families, "paths", f.Paths)
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
	var paths map[string]string
	for fam, p := range a.calPath {
		if a.calCert[fam] && p != "" {
			if paths == nil {
				paths = map[string]string{}
			}
			paths[fam] = p
		}
	}
	a.calMu.Unlock()
	sort.Strings(fams)
	raw, err := json.MarshalIndent(calibrationCertFile{Version: calibrationCertVersion, Families: fams, Paths: paths}, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.calibrationCertPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.calibrationCertPath())
}
