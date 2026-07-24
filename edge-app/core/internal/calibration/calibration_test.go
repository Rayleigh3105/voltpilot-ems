package calibration

import (
	"math"
	"testing"
	"time"
)

func fp(v float64) *float64 { return &v }

func newSession() *Session {
	return NewSession(Config{MaxKw: 1.0, TTL: 30 * time.Second})
}

func TestClampMagnitudeHardCap(t *testing.T) {
	if got := ClampMagnitude(5, 1); got != 1 {
		t.Errorf("over-cap positive: %v (want 1)", got)
	}
	if got := ClampMagnitude(-5, 1); got != -1 {
		t.Errorf("over-cap negative: %v (want -1)", got)
	}
	if got := ClampMagnitude(0.3, 1); got != 0.3 {
		t.Errorf("in-band: %v (want 0.3)", got)
	}
	if got := ClampMagnitude(math.NaN(), 1); got != 0 {
		t.Errorf("NaN -> 0, got %v", got)
	}
	if got := ClampMagnitude(math.Inf(1), 1); got != 0 {
		t.Errorf("Inf -> 0, got %v", got)
	}
}

func TestStartTestRequiresArmAndEnforcesTheCap(t *testing.T) {
	s := newSession()
	now := time.Unix(1_700_000_000, 0)

	// Not armed -> refused.
	if err := s.StartTest(Charge, 0.5, Reading{}, now); err != ErrNotArmed {
		t.Fatalf("start without arm must be refused: %v", err)
	}
	s.Arm()
	if !s.Armed() {
		t.Fatal("Arm did not arm")
	}

	// Over the cap -> refused (physically cannot command more than MaxKw).
	if err := s.StartTest(Charge, 1.5, Reading{}, now); err != ErrBadMagnitude {
		t.Fatalf("over-cap must be refused: %v", err)
	}
	// Zero / negative magnitude -> refused.
	if err := s.StartTest(Charge, 0, Reading{}, now); err != ErrBadMagnitude {
		t.Fatalf("zero magnitude must be refused: %v", err)
	}
	if err := s.StartTest(Discharge, -0.2, Reading{}, now); err != ErrBadMagnitude {
		t.Fatalf("negative magnitude must be refused: %v", err)
	}
	// Bad direction -> refused.
	if err := s.StartTest(Direction("sideways"), 0.5, Reading{}, now); err != ErrBadMagnitude {
		t.Fatalf("bad direction must be refused: %v", err)
	}

	// A valid charge test.
	if err := s.StartTest(Charge, 0.5, Reading{BatteryKw: fp(0)}, now); err != nil {
		t.Fatalf("valid charge test: %v", err)
	}
	kw, active := s.Command(now)
	if !active || kw != 0.5 {
		t.Fatalf("charge command should be +0.5, active: got %v active=%v", kw, active)
	}
	// A valid discharge test signs the command negative.
	if err := s.StartTest(Discharge, 0.4, Reading{}, now); err != nil {
		t.Fatalf("valid discharge test: %v", err)
	}
	kw, _ = s.Command(now)
	if kw != -0.4 {
		t.Fatalf("discharge command should be -0.4, got %v", kw)
	}
}

func TestPhaseTransitionsActiveRevertIdle(t *testing.T) {
	s := newSession()
	s.Arm()
	start := time.Unix(1_700_000_000, 0)
	if err := s.StartTest(Charge, 0.5, Reading{}, start); err != nil {
		t.Fatal(err)
	}
	// Inside TTL -> active + engaged + command present.
	mid := start.Add(10 * time.Second)
	if p := s.Phase(mid); p != PhaseActive {
		t.Fatalf("mid-TTL phase: %v (want active)", p)
	}
	if !s.Engaged(mid) {
		t.Fatal("active test must be engaged")
	}
	// Past TTL, inside RevertGrace -> revert, engaged, but NO command (never re-arms).
	rev := start.Add(30*time.Second + 5*time.Second)
	if p := s.Phase(rev); p != PhaseRevert {
		t.Fatalf("post-TTL phase: %v (want revert)", p)
	}
	if !s.Engaged(rev) {
		t.Fatal("revert window must stay engaged so the release is published")
	}
	if _, active := s.Command(rev); active {
		t.Fatal("no active command during revert - the write must not re-arm")
	}
	// Past the revert grace -> idle (normal path resumes), test kept for display.
	done := start.Add(30*time.Second + RevertGrace + time.Second)
	if p := s.Phase(done); p != PhaseIdle {
		t.Fatalf("post-grace phase: %v (want idle)", p)
	}
	if s.Engaged(done) {
		t.Fatal("past the revert grace calibration no longer overrides the setpoint")
	}
}

func TestAbortRevertsImmediately(t *testing.T) {
	s := newSession()
	s.Arm()
	start := time.Unix(1_700_000_000, 0)
	_ = s.StartTest(Discharge, 0.5, Reading{}, start)
	at := start.Add(3 * time.Second)
	s.Abort(at)
	if p := s.Phase(at); p != PhaseRevert {
		t.Fatalf("abort must move straight to revert: %v", p)
	}
	if _, active := s.Command(at); active {
		t.Fatal("no command after abort")
	}
	// Still reverting within the grace, then idle after.
	if p := s.Phase(at.Add(RevertGrace + time.Second)); p != PhaseIdle {
		t.Fatalf("phase after abort+grace: %v (want idle)", p)
	}
}

func TestDisarmAbortsActiveTest(t *testing.T) {
	s := newSession()
	s.Arm()
	start := time.Unix(1_700_000_000, 0)
	_ = s.StartTest(Charge, 0.5, Reading{}, start)
	at := start.Add(2 * time.Second)
	s.Disarm(at)
	if s.Armed() {
		t.Fatal("Disarm must disarm")
	}
	if p := s.Phase(at); p != PhaseRevert {
		t.Fatalf("Disarm must abort the active test (revert): %v", p)
	}
}

func TestVerdictSignAndScale(t *testing.T) {
	// Charge command +0.5 kW; the battery reads +0.48 kW -> direction + size OK.
	v := Verdict(0.5, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(0.48)})
	if !v.SignOK || !v.MagnitudeOK || v.SignInverted {
		t.Fatalf("good charge verdict: %+v", v)
	}
	if v.DeltaKw == nil || math.Abs(*v.DeltaKw-0.48) > 1e-9 {
		t.Fatalf("delta should be 0.48: %+v", v.DeltaKw)
	}

	// Inverted sign: command +0.5 but the battery discharges -0.5 -> suggest invert.
	v = Verdict(0.5, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(-0.5)})
	if v.SignOK || !v.SignInverted {
		t.Fatalf("inverted verdict: %+v", v)
	}

	// Scale x10 (HV decawatt read as watt): command 0.5, battery moves ~5 kW.
	v = Verdict(0.5, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(5.0)})
	if !v.SignOK {
		t.Fatalf("scale-high should still be same sign: %+v", v)
	}
	if v.MagnitudeOK || v.ScaleHint != "hoch" {
		t.Fatalf("scale-high should flag hoch: %+v", v)
	}

	// Scale too low: command 0.5, battery moves ~0.05 kW.
	v = Verdict(0.5, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(0.05)})
	if v.ScaleHint != "niedrig" {
		t.Fatalf("scale-low should flag niedrig: %+v", v)
	}

	// Not moving: measured ~0.
	v = Verdict(-0.5, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(0.0)})
	if v.SignOK || v.SignInverted {
		t.Fatalf("no-movement should be neither confirmed nor inverted: %+v", v)
	}

	// Measured unknown: no crash, honest text, no OK.
	v = Verdict(0.5, Reading{}, Reading{})
	if v.SignOK || v.MagnitudeOK || v.MeasuredKw != nil {
		t.Fatalf("unknown measured verdict: %+v", v)
	}
}

func TestConfirmationsAndPassed(t *testing.T) {
	s := newSession()
	if s.Passed() {
		t.Fatal("nothing confirmed -> not passed")
	}
	s.ConfirmSign(true)
	if s.Passed() {
		t.Fatal("only sign -> not passed")
	}
	s.ConfirmScale(true)
	if !s.Passed() {
		t.Fatal("sign+scale confirmed -> passed")
	}
	// A correction invalidates both confirmations.
	s.ResetConfirmations()
	if s.Passed() || s.signConfirmed || s.scaleConfirmed {
		t.Fatal("ResetConfirmations must clear both")
	}
}

func TestSnapshotDirectionsTestable(t *testing.T) {
	s := newSession()
	s.Arm()
	now := time.Unix(1_700_000_000, 0)
	band := SocBand{MinPct: 5, MaxPct: 95}

	// At 100 % SoC only DISCHARGE is testable (the task's full-battery case).
	snap := s.Snapshot(now, Reading{SocPct: fp(100), BatteryKw: fp(0)}, band)
	if snap.ChargeTestable {
		t.Fatal("charge must not be testable at 100 % SoC")
	}
	if !snap.DischargeTestable {
		t.Fatal("discharge must be testable at 100 % SoC")
	}
	if !snap.Armed || snap.MaxKw != 1.0 || snap.TtlSeconds != 30 {
		t.Fatalf("snapshot envelope: %+v", snap)
	}

	// At the floor only CHARGE is testable.
	snap = s.Snapshot(now, Reading{SocPct: fp(5), BatteryKw: fp(0)}, band)
	if snap.DischargeTestable || !snap.ChargeTestable {
		t.Fatalf("at the floor only charge is testable: %+v", snap)
	}

	// Unknown SoC -> both testable (guards are the real bound).
	snap = s.Snapshot(now, Reading{}, band)
	if !snap.ChargeTestable || !snap.DischargeTestable {
		t.Fatal("unknown SoC -> both directions offered")
	}
}

func TestSnapshotCarriesTheLiveVerdict(t *testing.T) {
	s := newSession()
	s.Arm()
	start := time.Unix(1_700_000_000, 0)
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0), SocPct: fp(80)}, start)
	// Live reading a few seconds in: the battery discharges -0.47 kW -> sign+size OK.
	live := Reading{BatteryKw: fp(-0.47), SocPct: fp(79)}
	snap := s.Snapshot(start.Add(5*time.Second), live, SocBand{MinPct: 5, MaxPct: 95})
	if snap.Test == nil {
		t.Fatal("active test should be in the snapshot")
	}
	if snap.Test.Phase != PhaseActive || snap.Test.CommandKw != -0.5 {
		t.Fatalf("test view: %+v", snap.Test)
	}
	if !snap.Test.Verdict.SignOK || !snap.Test.Verdict.MagnitudeOK {
		t.Fatalf("live verdict should confirm a good discharge test: %+v", snap.Test.Verdict)
	}
	if snap.Test.SecondsLeft <= 0 || snap.Test.SecondsLeft > 30 {
		t.Fatalf("seconds-left should count down within the TTL: %d", snap.Test.SecondsLeft)
	}
}
