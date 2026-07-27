package calibration

import (
	"math"
	"strings"
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

// TestRemoteScaleHintIsPathAware pins the fix for the misleading over-delivery hint
// (task vp-deye-strategy-v2): on the Deye REMOTE-MODE path the setpoint scales from the
// model's RATED power (register 1109 = 0.1 % of rated), so a scale mismatch must NOT
// suggest "Leistungsskalierung auf 10 (HV)" - that lever only exists on the ToU/decawatt
// register map. The ToU verdict keeps the power_scale advice; only the human hint
// changes, never a fact.
func TestRemoteScaleHintIsPathAware(t *testing.T) {
	// The exact live symptom: commanded -1 kW discharge from a quiet baseline, measured
	// -8 kW (~8x over-delivery).
	tou := Verdict(-1.0, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(-8.0)})
	if !tou.SignOK || tou.MagnitudeOK {
		t.Fatalf("an ~8x over-delivery is same-sign but wrong scale: %+v", tou)
	}
	if tou.ScaleHint != "hoch" || !strings.Contains(tou.Text, "Leistungsskalierung auf 10") {
		t.Fatalf("the ToU verdict must KEEP the power_scale hint: %+v", tou)
	}

	remote := tou.RemoteScaleHint()
	// The FACTS survive - only the human hint changes (so confirm gates are unaffected).
	if !remote.SignOK || remote.MagnitudeOK {
		t.Fatalf("RemoteScaleHint must not change the sign/magnitude facts: %+v", remote)
	}
	if remote.ScaleRatio == nil || tou.ScaleRatio == nil || *remote.ScaleRatio != *tou.ScaleRatio {
		t.Fatalf("ScaleRatio must survive: %+v", remote)
	}
	if remote.ScaleHint != "" {
		t.Fatalf("the power_scale ScaleHint must be cleared on the remote path: %q", remote.ScaleHint)
	}
	if strings.Contains(remote.Text, "Leistungsskalierung") || strings.Contains(remote.Text, "HV") {
		t.Fatalf("the remote hint must NOT mention power_scale: %q", remote.Text)
	}
	if !strings.Contains(remote.Text, "Nennleistung") || !strings.Contains(remote.Text, "Modell") {
		t.Fatalf("the remote hint must point at the model rating: %q", remote.Text)
	}

	// A clean verdict (sign + size OK) is a no-op on either path.
	good := Verdict(-1.0, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(-0.99)})
	if !good.SignOK || !good.MagnitudeOK {
		t.Fatalf("precondition (a good verdict): %+v", good)
	}
	if got := good.RemoteScaleHint(); got.Text != good.Text || got.ScaleHint != good.ScaleHint {
		t.Fatalf("RemoteScaleHint must be a no-op when sign+size are OK: %+v", got)
	}
	// A wrong-SIGN verdict is also a no-op (RemoteScaleHint only touches scale hints).
	inv := Verdict(-1.0, Reading{BatteryKw: fp(0)}, Reading{BatteryKw: fp(1.0)})
	if !inv.SignInverted {
		t.Fatalf("precondition (inverted): %+v", inv)
	}
	if got := inv.RemoteScaleHint(); got.Text != inv.Text {
		t.Fatalf("RemoteScaleHint must not touch an inverted-sign verdict: %q", got.Text)
	}
}

// TestSnapshotAppliesRemoteHintAfterSetControlPath proves the Session surfaces the
// path-aware hint end to end: once a calibration readback reports control_path "remote"
// (SetControlPath), the displayed verdict for an over-delivering test uses the remote
// wording, not the power_scale advice.
func TestSnapshotAppliesRemoteHintAfterSetControlPath(t *testing.T) {
	s := newSession()
	s.Arm()
	start := time.Unix(1_700_000_000, 0)
	// Discharge test from a quiet baseline; the battery over-delivers (-8 kW on -0.5 cmd).
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0), SocPct: fp(80)}, start)
	over := Reading{BatteryKw: fp(-8.0), SocPct: fp(78)}
	band := SocBand{MinPct: 5, MaxPct: 95}

	// Before any readback the path is unknown -> the default (ToU) hint.
	def := s.Snapshot(start.Add(3*time.Second), over, band)
	if !strings.Contains(def.Test.Verdict.Text, "Leistungsskalierung") {
		t.Fatalf("without a remote readback the ToU hint shows: %q", def.Test.Verdict.Text)
	}

	// A calibration readback over the remote path flips the displayed hint.
	s.SetControlPath("remote")
	rem := s.Snapshot(start.Add(3*time.Second), over, band)
	if strings.Contains(rem.Test.Verdict.Text, "Leistungsskalierung") {
		t.Fatalf("on the remote path the power_scale hint must be gone: %q", rem.Test.Verdict.Text)
	}
	if !strings.Contains(rem.Test.Verdict.Text, "Nennleistung") {
		t.Fatalf("on the remote path the hint must point at the model rating: %q", rem.Test.Verdict.Text)
	}
}

// TestVerdictRequiresAQuietBaseline is the Defect-2 guard: the measured after-value
// is only attributable to the command from a NEAR-IDLE baseline. The captain's live
// case was a stale -1 kW discharge test while the battery was naturally CHARGING at
// ~31 kW - the absolute measured value happened to "match" the command sign yet had
// nothing to do with it. A busy (or unknown) baseline must never yield a confident
// sign/scale verdict.
func TestVerdictRequiresAQuietBaseline(t *testing.T) {
	// The owner's scenario: discharge -1 kW commanded, but the battery was charging
	// hard (+31 kW) before AND after the (never-landed) test. Absolute sign would
	// have said "inverted"; with the corrected read sign it is +31 either way - the
	// point is neither reading is attributable, so no confident verdict at all.
	for _, after := range []float64{31, -30} {
		v := Verdict(-1.0, Reading{BatteryKw: fp(31)}, Reading{BatteryKw: fp(after)})
		if !v.BaselineBusy {
			t.Fatalf("a ~31 kW baseline must be flagged busy (after=%.0f): %+v", after, v)
		}
		if v.SignOK || v.SignInverted || v.MagnitudeOK {
			t.Fatalf("a busy baseline must yield NO confident sign/scale verdict (after=%.0f): %+v", after, v)
		}
		if v.MeasuredKw == nil || v.Text == "" {
			t.Fatalf("busy verdict should still report the measured value + an honest text: %+v", v)
		}
	}

	// An unknown baseline (no before reading yet) is equally un-attributable.
	v := Verdict(0.5, Reading{}, Reading{BatteryKw: fp(0.48)})
	if !v.BaselineBusy || v.SignOK || v.MagnitudeOK {
		t.Fatalf("an unknown baseline must not yield a confident verdict: %+v", v)
	}

	// A genuinely quiet baseline still produces a normal verdict (regression): a
	// small pre-test drift within the threshold does not block it.
	v = Verdict(0.5, Reading{BatteryKw: fp(0.05)}, Reading{BatteryKw: fp(0.48)})
	if v.BaselineBusy || !v.SignOK || !v.MagnitudeOK {
		t.Fatalf("a near-idle baseline must still confirm a good test: %+v", v)
	}
	// The threshold scales with the command: 0.4 kW baseline is busy for a 0.5 kW
	// test (> max(0.1, 0.25)) but quiet for a 1.0 kW test (<= max(0.1, 0.5)).
	if v := Verdict(0.5, Reading{BatteryKw: fp(0.4)}, Reading{BatteryKw: fp(0.48)}); !v.BaselineBusy {
		t.Fatalf("0.4 kW baseline must be busy for a 0.5 kW command: %+v", v)
	}
	if v := Verdict(1.0, Reading{BatteryKw: fp(0.4)}, Reading{BatteryKw: fp(0.95)}); v.BaselineBusy || !v.SignOK {
		t.Fatalf("0.4 kW baseline must be quiet for a 1.0 kW command: %+v", v)
	}
}

// TestConfirmationRefusedFromABusyBaseline pins that the Gap-B confirm gates get
// STRICTER with Defect 2: even a landed write + a measured value that "matches" the
// command sign cannot confirm sign/scale unless the baseline was quiet.
func TestConfirmationRefusedFromABusyBaseline(t *testing.T) {
	s := newSession()
	now := time.Unix(1_700_000_000, 0)
	s.Arm()
	// Test started while the battery was already charging hard (busy baseline).
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(31)}, now)
	s.NoteWriteReadback(true) // the write DID read back - evidence exists...
	busyAfter := Reading{BatteryKw: fp(-0.48)}
	s.ObserveReading(now, busyAfter) // ... but a busy baseline latches NO evidence.
	if err := s.ConfirmSign(true, now); err != ErrSignNotObserved {
		t.Fatalf("a busy baseline must refuse a sign confirm even with a landed write: %v", err)
	}
	if err := s.ConfirmScale(true, now); err != ErrScaleNotObserved {
		t.Fatalf("a busy baseline must refuse a scale confirm even with a landed write: %v", err)
	}
	if s.CanCertify() {
		t.Fatal("nothing confirmed from a busy baseline -> not certifiable")
	}
}

// primeEvidence arms + starts a discharge test, records a matching write->readback AND
// latches a good measured movement, so the Gap-B confirm/certify gates have their
// objective, still-valid evidence. Returns the observation time to confirm against.
func primeEvidence(s *Session, now time.Time) time.Time {
	s.Arm()
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0)}, now)
	s.NoteWriteReadback(true) // the write read back a full register match
	// A measured movement in the commanded direction while active -> latched evidence.
	s.ObserveReading(now, Reading{BatteryKw: fp(-0.48), SocPct: fp(60)})
	return now
}

func TestConfirmationsAndPassed(t *testing.T) {
	s := newSession()
	now := primeEvidence(s, time.Unix(1_700_000_000, 0))
	if s.Passed() {
		t.Fatal("nothing confirmed -> not passed")
	}
	if err := s.ConfirmSign(true, now); err != nil {
		t.Fatalf("confirm sign with evidence: %v", err)
	}
	if s.Passed() {
		t.Fatal("only sign -> not passed")
	}
	if err := s.ConfirmScale(true, now); err != nil {
		t.Fatalf("confirm scale with evidence: %v", err)
	}
	if !s.Passed() || !s.CanCertify() {
		t.Fatal("sign+scale confirmed with evidence -> passed + certifiable")
	}
	// A correction invalidates both confirmations AND the landed-write evidence.
	s.ResetConfirmations()
	if s.Passed() || s.signConfirmed || s.scaleConfirmed || s.writeReadbackOK {
		t.Fatal("ResetConfirmations must clear both confirmations + the write evidence")
	}
}

// TestConfirmationRequiresObjectiveEvidence is the Gap-B guard: a TRUE sign/scale
// confirmation is refused until the SYSTEM observed a landed write AND a measured
// movement; certification additionally needs the current test's write evidence.
func TestConfirmationRequiresObjectiveEvidence(t *testing.T) {
	s := newSession()
	now := time.Unix(1_700_000_000, 0)
	good := Reading{BatteryKw: fp(-0.48)}

	// No test at all -> refused.
	if err := s.ConfirmSign(true, now); err != ErrNoTestYet {
		t.Fatalf("confirm without a test must be refused: %v", err)
	}

	// A test but NO write->readback yet -> refused (the write never landed).
	s.Arm()
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0)}, now)
	s.ObserveReading(now, good) // no readback yet -> nothing latches
	if err := s.ConfirmSign(true, now); err != ErrNoWriteEvidence {
		t.Fatalf("confirm before a landed write must be refused: %v", err)
	}
	if s.CanCertify() {
		t.Fatal("cannot certify without a landed write")
	}

	// Write landed, but the battery moved the WRONG way -> nothing confirmable latches.
	s.NoteWriteReadback(true)
	wrongWay := Reading{BatteryKw: fp(0.48)} // command is discharge (-), battery charges (+)
	s.ObserveReading(now, wrongWay)
	if err := s.ConfirmSign(true, now); err != ErrSignNotObserved {
		t.Fatalf("confirm sign against an inverted movement must be refused: %v", err)
	}
	// Write landed, but the magnitude is way off (below the move deadband) -> the tiny
	// movement is not confirmable, so scale is refused.
	tinyMove := Reading{BatteryKw: fp(-0.02)}
	s.ObserveReading(now, tinyMove)
	if err := s.ConfirmScale(true, now); err != ErrScaleNotObserved {
		t.Fatalf("confirm scale against a bad magnitude must be refused: %v", err)
	}

	// Write landed AND a good measured verdict -> both confirm, cert allowed.
	s.ObserveReading(now, good)
	if err := s.ConfirmSign(true, now); err != nil {
		t.Fatalf("good sign confirm: %v", err)
	}
	if err := s.ConfirmScale(true, now); err != nil {
		t.Fatalf("good scale confirm: %v", err)
	}
	if !s.CanCertify() {
		t.Fatal("both confirmed with a landed write -> certifiable")
	}

	// A readback MISMATCH revokes the write evidence -> cert blocked again.
	s.NoteWriteReadback(false)
	if s.CanCertify() {
		t.Fatal("a readback mismatch must revoke certifiability")
	}

	// Starting a NEW test resets the write evidence AND any prior confirmation.
	_ = s.StartTest(Discharge, 0.4, Reading{BatteryKw: fp(0)}, now)
	if s.writeReadbackOK || s.signConfirmed || s.scaleConfirmed {
		t.Fatal("a fresh test must reset the landed-write evidence and confirmations")
	}
	// Clearing a confirmation is always allowed (no evidence needed).
	if err := s.ConfirmSign(false, now); err != nil {
		t.Fatalf("clearing a confirmation must never error: %v", err)
	}
}

// TestConfirmableWithinGraceAfterRevert is the Defect-1 fix: a test's measured movement
// stays confirmable for ConfirmGrace AFTER the bounded write auto-reverts to neutral, so
// the operator is not forced to tick the boxes in the ~2 s before the revert. The proof
// (readback + observed movement) is unchanged; only how long it counts widens.
func TestConfirmableWithinGraceAfterRevert(t *testing.T) {
	s := newSession()
	start := time.Unix(1_700_000_000, 0)
	s.Arm()
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0), SocPct: fp(60)}, start)
	s.NoteWriteReadback(true)
	// A good measured movement observed WHILE active (t+5s) latches the evidence.
	moving := Reading{BatteryKw: fp(-0.48), SocPct: fp(59)}
	s.ObserveReading(start.Add(5*time.Second), moving)

	// The test has fully reverted (past TTL + RevertGrace) and the battery is neutral
	// again - the LIVE reading no longer shows the command.
	after := start.Add(30*time.Second + RevertGrace + 20*time.Second)
	neutral := Reading{BatteryKw: fp(0.0), SocPct: fp(59)}
	snap := s.Snapshot(after, neutral, SocBand{MinPct: 5, MaxPct: 95})
	if snap.Phase != PhaseIdle {
		t.Fatalf("test should be idle (reverted) at t+80s: %v", snap.Phase)
	}
	if !snap.EvidenceValid || snap.EvidenceAgeSeconds <= 0 {
		t.Fatalf("the finished test's result must stay valid within the grace window: %+v", snap)
	}
	// The displayed verdict is the CAPTURED result, not the reverted-to-neutral live one.
	if !snap.Test.Verdict.SignOK || !snap.Test.Verdict.MagnitudeOK {
		t.Fatalf("the shown verdict must be the captured good result: %+v", snap.Test.Verdict)
	}
	if !snap.CanConfirmSign || !snap.CanConfirmScale {
		t.Fatalf("the confirm boxes must stay enabled during the grace window: %+v", snap)
	}
	// Confirming AFTER the revert, still inside the grace window, works.
	if err := s.ConfirmSign(true, after); err != nil {
		t.Fatalf("sign confirm inside the grace window must succeed: %v", err)
	}
	if err := s.ConfirmScale(true, after); err != nil {
		t.Fatalf("scale confirm inside the grace window must succeed: %v", err)
	}
	if !s.CanCertify() {
		t.Fatal("both confirmed inside the grace window -> certifiable")
	}
}

// TestConfirmRefusedAfterGraceExpiry: past ConfirmGrace the evidence is stale and a
// confirmation is refused - the operator runs a fresh test.
func TestConfirmRefusedAfterGraceExpiry(t *testing.T) {
	s := newSession()
	start := time.Unix(1_700_000_000, 0)
	s.Arm()
	_ = s.StartTest(Discharge, 0.5, Reading{BatteryKw: fp(0), SocPct: fp(60)}, start)
	s.NoteWriteReadback(true)
	s.ObserveReading(start.Add(5*time.Second), Reading{BatteryKw: fp(-0.48)})

	expired := start.Add(5*time.Second + ConfirmGrace + time.Second)
	if err := s.ConfirmSign(true, expired); err != ErrEvidenceExpired {
		t.Fatalf("a confirmation past the grace window must be refused: %v", err)
	}
	snap := s.Snapshot(expired, Reading{BatteryKw: fp(0)}, SocBand{MinPct: 5, MaxPct: 95})
	if snap.EvidenceValid || snap.CanConfirmSign || snap.CanConfirmScale {
		t.Fatalf("past the grace window the boxes must lock again: %+v", snap)
	}
}

// TestEvidenceInvalidatesOnNewTestAbortAndCorrection: the grace evidence must invalidate
// on a new test, an abort, and a correction (ResetConfirmations).
func TestEvidenceInvalidatesOnNewTestAbortAndCorrection(t *testing.T) {
	mk := func() (*Session, time.Time) {
		s := newSession()
		now := primeEvidence(s, time.Unix(1_700_000_000, 0))
		if !s.evidenceValid(now) {
			t.Fatal("precondition: evidence must be valid")
		}
		return s, now
	}
	// A NEW test replaces the evidence.
	s, now := mk()
	_ = s.StartTest(Charge, 0.5, Reading{BatteryKw: fp(0)}, now)
	if s.evidenceValid(now) {
		t.Fatal("a new test must replace the evidence")
	}
	// An abort invalidates it.
	s, now = mk()
	s.Abort(now)
	if s.evidenceValid(now) {
		t.Fatal("an abort must invalidate the evidence")
	}
	// A correction (ResetConfirmations) invalidates it.
	s, now = mk()
	s.ResetConfirmations()
	if s.evidenceValid(now) {
		t.Fatal("a correction must invalidate the evidence")
	}
	// After a correction both the movement evidence AND the landed-write evidence are
	// gone, so a confirm is refused (ErrNoWriteEvidence) until a fresh test re-proves it.
	if err := s.ConfirmSign(true, now); err != ErrNoWriteEvidence {
		t.Fatalf("after a correction, confirm must be refused until a fresh test: %v", err)
	}
}

// TestTestStepsForRatedScalesToTheInverter is the Defect-2 fix: the offered test-power
// ladder is a fraction of rated power, so the smallest rung actually moves the battery on
// a big unit while staying sensible on a small one. The hard cap max_kw stays the ceiling.
func TestTestStepsForRatedScalesToTheInverter(t *testing.T) {
	// 30 kW unit, 1.0 kW hard cap: ~1/3/5 % = 0.3/0.9/1.5, capped to 0.3/0.9/1.0. The
	// 0.9 kW rung (~3 %) is far above the useless 0.3 kW (~1 %) the owner had on 30 kW.
	got := TestStepsForRated(30, 1.0)
	want := []float64{0.3, 0.9, 1.0}
	if !floatsEqual(got, want) {
		t.Fatalf("30 kW ladder: got %v want %v", got, want)
	}
	// 5 kW household hybrid: ~1/3/5 % = 0.05/0.15/0.25 -> rounded 0.1/0.2/0.3, none capped.
	got = TestStepsForRated(5, 1.0)
	want = []float64{0.1, 0.2, 0.3}
	if !floatsEqual(got, want) {
		t.Fatalf("5 kW ladder: got %v want %v", got, want)
	}
	// Unknown rated -> the fixed fallback ladder, filtered to the cap.
	got = TestStepsForRated(0, 1.0)
	want = []float64{0.2, 0.3, 0.5, 1.0}
	if !floatsEqual(got, want) {
		t.Fatalf("unknown-rated fallback ladder: got %v want %v", got, want)
	}
	// Every rung stays within the hard cap.
	for _, st := range TestStepsForRated(50, 1.0) {
		if st > 1.0+1e-9 {
			t.Fatalf("a ladder rung %v exceeds the hard cap", st)
		}
	}
	// No cap -> nil (defensive).
	if TestStepsForRated(30, 0) != nil {
		t.Fatal("a non-positive cap yields no ladder")
	}
}

// TestNextStepAbove: the actionable "try a bigger step" suggestion picks the next rung.
func TestNextStepAbove(t *testing.T) {
	steps := []float64{0.3, 0.9, 1.0}
	if got := NextStepAbove(steps, 0.3); got == nil || *got != 0.9 {
		t.Fatalf("next above 0.3 should be 0.9: %v", got)
	}
	// Works on a negative (discharge) command by magnitude.
	if got := NextStepAbove(steps, -0.3); got == nil || *got != 0.9 {
		t.Fatalf("next above |-0.3| should be 0.9: %v", got)
	}
	if got := NextStepAbove(steps, 1.0); got != nil {
		t.Fatalf("nothing is larger than the top rung: %v", got)
	}
}

func floatsEqual(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if math.Abs(a[i]-b[i]) > 1e-9 {
			return false
		}
	}
	return true
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
	// Gap B: even with a good verdict, the confirm boxes stay locked until a real
	// write->readback landed (no writeReadbackOK yet).
	if snap.CanConfirmSign || snap.CanConfirmScale || snap.WriteReadbackOK {
		t.Fatalf("no landed-write evidence yet -> confirm boxes must stay locked: %+v", snap)
	}
	s.NoteWriteReadback(true)
	snap = s.Snapshot(start.Add(5*time.Second), live, SocBand{MinPct: 5, MaxPct: 95})
	if !snap.WriteReadbackOK || !snap.CanConfirmSign || !snap.CanConfirmScale {
		t.Fatalf("with a landed write + good verdict the boxes must unlock: %+v", snap)
	}
}
