package agent

// Agent-level tests for the First-Light calibration wiring: the bounded write path
// on edge/setpoint (magnitude cap + guard clamp + certification bypass but NOT the
// kill-switch), the TTL auto-revert, and the calibration-gated per-device
// certification hand-off (persisted, merged into controlCertified).

import (
	"errors"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/calibration"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

func bptr(v bool) *bool { return &v }

// selectDeye selects the pilot Deye (family hybrid_3p) - deliberately UNCERTIFIED.
func selectDeye(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
}

func TestCalibrationOverridePublishesABoundedWriteThatBypassesCertNotTheKillSwitch(t *testing.T) {
	cfg := config.Defaults() // ControlEnabled true; MaxKw 1.0; TTL 30s
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a) // uncertified: the normal path would give control_enabled=false
	sub := subscribeSetpoint(t, addr)

	// SoC 60 leaves discharge room; a discharge test at -0.5 kW.
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	// Drive the pure session directly so the phases run at a controlled clock.
	start := time.Now().UTC()
	a.cal.Arm()
	if err := a.cal.StartTest(calibration.Discharge, 0.5, calibration.Reading{BatteryKw: fptr(0)}, start); err != nil {
		t.Fatal(err)
	}

	// ACTIVE: the small clamped test setpoint, calibration=true, and control_enabled
	// TRUE despite the family being uncertified (the certification bypass) - because
	// the global kill-switch is on.
	a.applySetpoint(start.Add(3 * time.Second))
	waitFor(t, 5*time.Second, "calibration active setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "calibration" && m["control_enabled"] == true
	})
	m, _ := sub.latest()
	if m["calibration"] != true {
		t.Fatalf("calibration marker must be set: %v", m)
	}
	if kw := m["battery_setpoint_kw"].(float64); kw != -0.5 {
		t.Fatalf("bounded discharge setpoint = %v, want -0.5", kw)
	}
	if m["grid_charge_allowed"] != false {
		t.Fatalf("calibration must never grid-charge: %v", m)
	}
	if a.controlCertified("hybrid_3p") {
		t.Fatal("the family must still be uncertified - the calibration bypass is what let the write through")
	}

	// AUTO-REVERT: past the TTL (inside the revert grace) -> neutral, control_enabled
	// false so the flow issues the release; the write NEVER latches.
	a.applySetpoint(start.Add(cfg.CalibrationTTL + 5*time.Second))
	waitFor(t, 5*time.Second, "calibration auto-revert", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "calibration" && m["control_enabled"] == false && m["battery_setpoint_kw"] == 0.0
	})

	// PAST the grace: calibration no longer overrides -> the normal path resumes
	// (uncertified Deye -> control_enabled false, and NO calibration marker).
	a.applySetpoint(start.Add(cfg.CalibrationTTL + calibration.RevertGrace + 2*time.Second))
	waitFor(t, 5*time.Second, "normal path after grace", func() bool {
		m, ok := sub.latest()
		_, hasCal := m["calibration"]
		return ok && !hasCal && m["source"] != "calibration"
	})
}

func TestCalibrationValueStillFlowsThroughGuardClamp(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	sub := subscribeSetpoint(t, addr)

	// At the SoC FLOOR a discharge is clamped to 0 by the guard chain - proving the
	// calibration value goes THROUGH guards.Clamp, never around it.
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: cfg.SocMinPct, PvKw: 0, LoadKw: 0, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	start := time.Now().UTC()
	a.cal.Arm()
	if err := a.cal.StartTest(calibration.Discharge, 0.5, calibration.Reading{}, start); err != nil {
		t.Fatal(err)
	}
	a.applySetpoint(start.Add(2 * time.Second))
	waitFor(t, 5*time.Second, "guard-clamped calibration setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "calibration" && m["battery_setpoint_kw"] == 0.0
	})
}

func TestCalibrationArmRefusesWithoutKillSwitchOrControllableInverter(t *testing.T) {
	// Kill-switch OFF -> arming refused.
	cfg := config.Defaults()
	cfg.ControlEnabled = false
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	if _, err := a.CalibrationArm(true); err == nil {
		t.Fatal("arming must be refused while VP_CONTROL_ENABLED=false")
	}

	// Kill-switch ON but no inverter selected -> refused.
	cfg2 := config.Defaults()
	cfg2.DataDir = t.TempDir()
	a2, _ := startBusOnlyAgent(t, cfg2)
	if _, err := a2.CalibrationArm(true); err == nil {
		t.Fatal("arming must be refused without a controllable inverter")
	}
}

func TestCalibrationStartTestEnforcesTheMagnitudeCap(t *testing.T) {
	cfg := config.Defaults() // MaxKw 1.0
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	t.Cleanup(func() { a.CalibrationAbort() })

	if _, err := a.CalibrationArm(true); err != nil {
		t.Fatal(err)
	}
	// Over the cap -> refused with a 400-class CalibrationError.
	_, err := a.CalibrationStartTest("discharge", 5.0)
	if err == nil {
		t.Fatal("a request above VP_CALIBRATION_MAX_KW must be refused")
	}
	var ce *calibration.ValidationError
	if !errors.As(err, &ce) {
		t.Fatalf("expected a calibration.ValidationError, got %T", err)
	}
	// A within-cap test is accepted and immediately active.
	snap, err := a.CalibrationStartTest("discharge", 0.5)
	if err != nil {
		t.Fatalf("valid test: %v", err)
	}
	if snap.Test == nil || snap.Test.Phase != calibration.PhaseActive {
		t.Fatalf("test should be active: %+v", snap.Test)
	}
}

func TestCalibrationCertificationHandoffIsGatedPersistedAndMerged(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Defaults()
	cfg.DataDir = dir
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	sub := subscribeSetpoint(t, addr)

	if a.controlCertified("hybrid_3p") {
		t.Fatal("precondition: the Deye family is uncertified")
	}
	// Certify refused before both confirmations pass.
	if _, err := a.CalibrationCertify(); err == nil {
		t.Fatal("certification must be refused before sign+scale are confirmed")
	}
	a.CalibrationConfirm(bptr(true), bptr(true)) // operator confirms sign + scale
	snap, err := a.CalibrationCertify()
	if err != nil {
		t.Fatalf("certify after passing: %v", err)
	}
	if !snap.Certified {
		t.Fatal("snapshot must report certified after the hand-off")
	}
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("the family must be certified for THIS device after First-Light")
	}

	// The optimizer path now writes live: a plan setpoint carries control_enabled=true.
	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -5, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "certified optimizer write", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "schedule" && m["control_enabled"] == true
	})

	// Persisted across a restart: a fresh agent on the same data dir is still certified.
	a2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a2.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatal(err)
	}
	if !a2.controlCertified("hybrid_3p") {
		t.Fatal("First-Light certification must survive a restart (persisted)")
	}
}

func TestCalibrationCorrectionResetsConfirmationsAndDecertifies(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	a.CalibrationConfirm(bptr(true), bptr(true))
	if _, err := a.CalibrationCertify(); err != nil {
		t.Fatal(err)
	}
	if !a.controlCertified("hybrid_3p") {
		t.Fatal("certified after passing")
	}

	// A control-sign correction invalidates the proof: confirmations reset, the
	// family is decertified, and the WRITE sign is now set on the connection.
	snap, err := a.CalibrationCorrection(bptr(true), nil)
	if err != nil {
		t.Fatalf("correction: %v", err)
	}
	if snap.Passed || snap.SignConfirmed || snap.ScaleConfirmed {
		t.Fatalf("correction must reset the operator confirmations: %+v", snap)
	}
	if a.controlCertified("hybrid_3p") {
		t.Fatal("a sign correction must revoke the stale First-Light certification")
	}
	sel, _ := a.GetInverter()
	if !sel.Connection.InvertControlSign {
		t.Fatal("the correction must set invert_control_sign on the inverter connection")
	}
}

func TestCalibrationSnapshotAvailability(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)

	// No inverter -> not available.
	if snap := a.CalibrationSnapshot(); snap.Available || snap.Reason == "" {
		t.Fatalf("no inverter -> unavailable with a reason: %+v", snap)
	}
	// Deye -> available, uncertified, envelope carried.
	selectDeye(t, a)
	snap := a.CalibrationSnapshot()
	if !snap.Available || snap.Certified {
		t.Fatalf("Deye -> available + uncertified: %+v", snap)
	}
	if snap.MaxKw != 1.0 || snap.TtlSeconds != 30 || snap.Family != "hybrid_3p" {
		t.Fatalf("snapshot envelope: %+v", snap)
	}
}
