package neutralcal

import (
	"errors"
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)

// hold marks the register as confirmed at `at` (what the executor's readback
// verdict does) - the precondition for any departure sample.
func hold(s *Session, family string, at time.Time) { s.NoteRegister(family, true, at) }

// away feeds n consecutive fresh readings clearly outside the neutral band,
// 5 s apart (the real telemetry cadence), starting at `from`.
func away(s *Session, family string, from time.Time, kw float64, n int) time.Time {
	at := from
	for i := 0; i < n; i++ {
		at = at.Add(5 * time.Second)
		s.Observe(family, kw, at)
	}
	return at
}

// settle feeds n consecutive fresh in-band (near-zero) readings.
func settle(s *Session, family string, from time.Time, n int) time.Time {
	return away(s, family, from, 0.0, n)
}

// depart drives a session through the full ACTIVE phase: start, hold the
// register, observe DepartureSamples away readings. Returns the timestamp of
// the last active-phase write (what NoteWrite would have stamped) and the
// timestamp after the departure readings.
func depart(t *testing.T, s *Session, family string, start time.Time) time.Time {
	t.Helper()
	if _, err := s.Start(family, start); err != nil {
		t.Fatalf("start: %v", err)
	}
	hold(s, family, start)
	s.NoteWrite(family, start)
	at := away(s, family, start, TestKw, DepartureSamples)
	if s.Phase(family, at) != PhaseSilent {
		t.Fatalf("expected PhaseSilent after confirmed departure, got %v", s.Phase(family, at))
	}
	return start // NoteWrite was stamped at `start`
}

func TestStartRefusesWithoutAFamilyAndWhileAnotherTestRuns(t *testing.T) {
	s := New(0)
	if s.TTL() != DefaultTTL {
		t.Fatalf("default TTL expected, got %v", s.TTL())
	}
	if _, err := s.Start("", t0); err == nil {
		t.Fatal("an empty family must refuse the test")
	} else {
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("want ValidationError, got %T", err)
		}
	}
	kw, err := s.Start("hybrid_3p", t0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if kw != TestKw {
		t.Fatalf("Start must return TestKw, got %v", kw)
	}
	if !s.Active(t0) || s.ActiveFamily(t0) != "hybrid_3p" {
		t.Fatal("test must be active for hybrid_3p")
	}
	// A second test while one runs is refused (one bench step at a time),
	// even for a different family.
	if _, err := s.Start("sunspec", t0.Add(time.Second)); err == nil {
		t.Fatal("a concurrent second test must be refused")
	}
}

func TestFamilyIsCaseAndSpaceNormalized(t *testing.T) {
	s := New(0)
	if _, err := s.Start("  Hybrid_3P  ", t0); err != nil {
		t.Fatalf("start: %v", err)
	}
	if s.ActiveFamily(t0) != "hybrid_3p" {
		t.Fatalf("family must be normalized, got %q", s.ActiveFamily(t0))
	}
	if s.Phase("HYBRID_3P", t0) != PhaseActive {
		t.Fatalf("Phase lookup must normalize too, got %v", s.Phase("HYBRID_3P", t0))
	}
}

// The register alone is never proof: a confirmed write whose measured power
// never actually left the neutral band is exactly the "already neutral"
// case (SoC bounds or another guard clamped the tiny departure away), and it
// must conclude Unprovable, never a fabricated fast T.
func TestARegisterConfirmedWriteThatNeverDepartsIsUnprovable(t *testing.T) {
	s := New(0)
	if _, err := s.Start("hybrid_3p", t0); err != nil {
		t.Fatalf("start: %v", err)
	}
	hold(s, "hybrid_3p", t0)
	s.NoteWrite("hybrid_3p", t0)
	// Every reading sits INSIDE the neutral band despite the confirmed write
	// (kept well within the departure timeout, so the run is still genuinely
	// active while we check it).
	at := away(s, "hybrid_3p", t0, 0.02, 5)
	if s.Phase("hybrid_3p", at) != PhaseActive {
		t.Fatalf("must stay active - no departure was ever observed: %v", s.Phase("hybrid_3p", at))
	}
	// Past the departure timeout the run concludes on its own.
	end := t0.Add(DepartureTimeout + time.Second)
	ev := s.EvidenceFor("hybrid_3p", end)
	if ev == nil {
		t.Fatal("evidence expected")
	}
	if ev.Verdict != VerdictUnprovable {
		t.Fatalf("verdict = %q, want %q", ev.Verdict, VerdictUnprovable)
	}
	if ev.MeasuredSeconds != nil {
		t.Fatalf("an unprovable run must NEVER record a number, got %v", *ev.MeasuredSeconds)
	}
}

// A register that never confirms at all is the "kein_nachweis" case - the
// command may not even have reached the device.
func TestARegisterThatNeverConfirmsIsNoProof(t *testing.T) {
	s := New(0)
	if _, err := s.Start("sunspec", t0); err != nil {
		t.Fatalf("start: %v", err)
	}
	s.NoteWrite("sunspec", t0)
	// Readings arrive (clearly away) but the register is never confirmed -
	// Observe must refuse to count them as a proven departure.
	end := t0.Add(DepartureTimeout + time.Second)
	away(s, "sunspec", t0, TestKw, 10)
	ev := s.EvidenceFor("sunspec", end)
	if ev.Verdict != VerdictNoProof {
		t.Fatalf("verdict = %q, want %q", ev.Verdict, VerdictNoProof)
	}
	if ev.MeasuredSeconds != nil {
		t.Fatal("no-proof must never carry a number")
	}
}

// A departed, register-confirmed test whose measurements simply go missing
// during the silent phase is Unprovable ("es fehlen Messwerte"), not a
// generic no-proof - the CAUSE must be distinguishable.
func TestMissingMeasurementsDuringTheSilentPhaseAreUnprovable(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	// No further Observe() calls at all - as if telemetry had stopped.
	end := writeAt.Add(s.TTL() + time.Second)
	ev := s.EvidenceFor("hybrid_3p", end)
	if ev.Verdict != VerdictUnprovable {
		t.Fatalf("verdict = %q, want %q (reason: %s)", ev.Verdict, VerdictUnprovable, ev.Reason)
	}
	if ev.MeasuredSeconds != nil {
		t.Fatal("missing measurements must never record a number")
	}
}

// A departed, register-confirmed test that gets fresh readings the whole
// time, but they never settle into the neutral band, is genuine "no proof" -
// repeat with a longer window, not an excuse.
func TestNeverSettlingWithFreshDataIsNoProof(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	end := writeAt.Add(s.TTL())
	// Keep feeding fresh AWAY readings for the whole silent window.
	at := writeAt.Add(time.Duration(DepartureSamples) * 5 * time.Second)
	for at.Before(end) {
		at = at.Add(5 * time.Second)
		s.Observe("hybrid_3p", TestKw, at)
	}
	ev := s.EvidenceFor("hybrid_3p", end.Add(time.Second))
	if ev.Verdict != VerdictNoProof {
		t.Fatalf("verdict = %q, want %q", ev.Verdict, VerdictNoProof)
	}
	if ev.MeasuredSeconds != nil {
		t.Fatal("never-settled must never record a number")
	}
}

// The one and only path that may record a number: departed, confirmed, and
// SettleSamples consecutive fresh in-band readings during the silent phase.
func TestAFullPassRecordsAConservativeMeasuredDuration(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	// One more AWAY reading well into the silent phase (the conservative
	// anchor), then the confirmed settle streak.
	lastAway := writeAt.Add(20 * time.Second)
	s.Observe("hybrid_3p", TestKw, lastAway)
	settleEnd := settle(s, "hybrid_3p", lastAway, SettleSamples)

	ev := s.EvidenceFor("hybrid_3p", settleEnd)
	if ev == nil {
		t.Fatal("evidence expected")
	}
	if !ev.Valid {
		t.Fatal("a just-concluded pass must be valid")
	}
	if ev.Verdict != VerdictPassed {
		t.Fatalf("verdict = %q, want %q (reason: %s)", ev.Verdict, VerdictPassed, ev.Reason)
	}
	if !ev.RegisterConfirmed || !ev.DepartureConfirmed {
		t.Fatalf("both proofs must be recorded: %+v", ev)
	}
	if ev.SettleSamples < SettleSamples {
		t.Fatalf("settle samples: %d", ev.SettleSamples)
	}
	if ev.MeasuredSeconds == nil {
		t.Fatal("a pass MUST carry a measured duration")
	}
	want := int(lastAway.Sub(writeAt) / time.Second)
	if *ev.MeasuredSeconds != want {
		t.Fatalf("measured seconds = %d, want %d (conservative anchor = last known-away reading)",
			*ev.MeasuredSeconds, want)
	}
	if !s.CanRecord("hybrid_3p", settleEnd) {
		t.Fatal("a valid pass must be recordable")
	}
}

// The conservative-anchor guarantee, stated as a property: the reported T
// NEVER exceeds the true elapsed time to the first settled reading - i.e. it
// never OVERSTATES T, the unsafe direction for a watchdog deadline that must
// stay strictly under the real value.
func TestMeasuredSecondsNeverOverstatesTheTrueElapsedTime(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	lastAway := writeAt.Add(37 * time.Second)
	s.Observe("hybrid_3p", TestKw, lastAway)
	settleEnd := settle(s, "hybrid_3p", lastAway, SettleSamples)
	ev := s.EvidenceFor("hybrid_3p", settleEnd)
	trueUpperBound := int(settleEnd.Sub(writeAt) / time.Second)
	if *ev.MeasuredSeconds > trueUpperBound {
		t.Fatalf("measured %ds must never exceed the true upper bound %ds",
			*ev.MeasuredSeconds, trueUpperBound)
	}
	if *ev.MeasuredSeconds != int(lastAway.Sub(writeAt)/time.Second) {
		t.Fatalf("measured seconds must anchor on the last KNOWN-away reading: got %d", *ev.MeasuredSeconds)
	}
}

// If the transition happens faster than our sampling can bound (the very
// first silent-phase reading is already settled), the conservative floor is
// ~0s rather than a guess - safe, even though not very informative.
func TestAnInstantFallbackReportsAConservativeFloorNearZero(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	// No lastAwayAt is ever recorded - straight to the confirmed settle run.
	settleEnd := settle(s, "hybrid_3p", writeAt, SettleSamples)
	ev := s.EvidenceFor("hybrid_3p", settleEnd)
	if ev.Verdict != VerdictPassed {
		t.Fatalf("verdict: %q (%s)", ev.Verdict, ev.Reason)
	}
	if ev.MeasuredSeconds == nil || *ev.MeasuredSeconds != 0 {
		t.Fatalf("an unbounded-fast fallback must report 0 s, got %v", ev.MeasuredSeconds)
	}
}

// Abort at any point invalidates the evidence - a run that stopped mid-way
// proves nothing about T, regardless of how far it had progressed.
func TestAbortInvalidatesEvidenceAtEveryStage(t *testing.T) {
	cases := []struct {
		name string
		run  func(s *Session)
	}{
		{"mid-active", func(s *Session) {
			if _, err := s.Start("hybrid_3p", t0); err != nil {
				t.Fatal(err)
			}
			hold(s, "hybrid_3p", t0)
		}},
		{"mid-silent", func(s *Session) {
			depart(t, s, "hybrid_3p", t0)
		}},
		{"after-a-full-pass", func(s *Session) {
			writeAt := depart(t, s, "hybrid_3p", t0)
			settle(s, "hybrid_3p", writeAt, SettleSamples)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := New(0)
			c.run(s)
			s.Abort(t0.Add(time.Minute))
			if s.Active(t0.Add(time.Minute)) {
				t.Fatal("an aborted test must not report as active")
			}
			ev := s.EvidenceFor("hybrid_3p", t0.Add(time.Minute))
			if ev != nil {
				t.Fatalf("an aborted test's evidence must be invalid/absent entirely, got %+v", ev)
			}
			if s.CanRecord("hybrid_3p", t0.Add(time.Minute)) {
				t.Fatal("an aborted test must never be recordable")
			}
		})
	}
}

// The overall TTL is a hard cap: a departed test that never settles must
// conclude at the deadline, not run forever.
func TestTheOverallTTLIsAHardCap(t *testing.T) {
	ttl := 90 * time.Second
	s := New(ttl)
	writeAt := depart(t, s, "hybrid_3p", t0)
	deadline := writeAt.Add(ttl)
	if s.Active(deadline.Add(-time.Second)) == false {
		t.Fatal("test must still be counted active just before its deadline")
	}
	if s.Active(deadline.Add(time.Second)) {
		t.Fatal("test must conclude once its TTL elapses")
	}
	if pub, ok := s.Command("hybrid_3p", deadline.Add(time.Second)); ok || pub != 0 {
		t.Fatalf("past the deadline nothing may be commanded: kw=%v publish=%v", pub, ok)
	}
}

// DepartureTimeout bounds the ACTIVE (writing) phase on its own, tighter than
// the overall TTL: a test that never departs must not keep writing for the
// whole window.
func TestDepartureTimeoutEndsTheActivePhaseEarly(t *testing.T) {
	s := New(6 * time.Minute) // overall TTL much longer than DepartureTimeout
	if _, err := s.Start("hybrid_3p", t0); err != nil {
		t.Fatal(err)
	}
	// No departure ever confirmed (never held / never away).
	justBefore := t0.Add(DepartureTimeout - time.Second)
	justAfter := t0.Add(DepartureTimeout + time.Second)
	if kw, pub := s.Command("hybrid_3p", justBefore); !pub || kw != TestKw {
		t.Fatalf("must still be actively commanding just before the departure timeout: kw=%v pub=%v", kw, pub)
	}
	if _, pub := s.Command("hybrid_3p", justAfter); pub {
		t.Fatal("must stop commanding once the departure timeout elapses without a confirmed departure")
	}
	if s.Phase("hybrid_3p", justAfter) != PhaseDone {
		t.Fatalf("phase must be Done past the departure timeout, got %v", s.Phase("hybrid_3p", justAfter))
	}
}

// Command() returns publish=false for the WHOLE silent phase - going
// completely silent (never even a neutral release) is the entire mechanism.
func TestCommandGoesSilentTheInstantDepartureIsConfirmed(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	for _, at := range []time.Time{
		writeAt.Add(1 * time.Second),
		writeAt.Add(time.Minute),
		writeAt.Add(3 * time.Minute),
	} {
		if kw, pub := s.Command("hybrid_3p", at); pub || kw != 0 {
			t.Fatalf("at %v: silent phase must publish NOTHING, got kw=%v publish=%v", at, kw, pub)
		}
	}
}

// A stale register confirmation (older than RegisterHoldFresh) can never gate
// a departure sample - an expired/overwritten command proves nothing about
// what is happening now.
func TestAStaleRegisterConfirmationCannotGateADepartureSample(t *testing.T) {
	s := New(0)
	if _, err := s.Start("hybrid_3p", t0); err != nil {
		t.Fatal(err)
	}
	hold(s, "hybrid_3p", t0)
	stale := t0.Add(RegisterHoldFresh + time.Second)
	s.Observe("hybrid_3p", TestKw, stale)
	if s.Phase("hybrid_3p", stale) != PhaseActive {
		t.Fatal("a stale register confirmation must not let departure be confirmed")
	}
}

// A single away reading, or one just at the edge of the departure margin, is
// not proof - DepartureSamples consecutive ones are required, and a lone
// dip does not count.
func TestASingleAwayReadingIsNotDepartureProof(t *testing.T) {
	s := New(0)
	if _, err := s.Start("hybrid_3p", t0); err != nil {
		t.Fatal(err)
	}
	hold(s, "hybrid_3p", t0)
	s.Observe("hybrid_3p", TestKw, t0.Add(5*time.Second))
	if s.Phase("hybrid_3p", t0.Add(5*time.Second)) != PhaseActive {
		t.Fatal("one sample must not confirm departure")
	}
	// A reading right at the departure margin boundary (not clearing it)
	// resets the run, so it never sneaks through.
	edge := NeutralBandKw + DepartureMargin - 0.01
	s.Observe("hybrid_3p", edge, t0.Add(10*time.Second))
	if s.Phase("hybrid_3p", t0.Add(10*time.Second)) != PhaseActive {
		t.Fatal("a reading inside the margin must not confirm departure")
	}
}

// A single in-band reading during the silent phase is not proof of settling -
// SettleSamples consecutive ones are required, and a lone dip resets the run.
func TestASingleInBandReadingDuringSilenceIsNotSettleProof(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	// One in-band blip, then back away - must not count toward settling.
	at := writeAt.Add(5 * time.Second)
	s.Observe("hybrid_3p", 0.0, at)
	at = at.Add(5 * time.Second)
	s.Observe("hybrid_3p", TestKw, at)
	end := writeAt.Add(DefaultTTL)
	ev := s.EvidenceFor("hybrid_3p", end.Add(time.Second))
	if ev.Verdict == VerdictPassed {
		t.Fatal("a single blip must never certify a pass")
	}
}

// NoteWrite/NoteRegister/Observe for the WRONG family (a different test, or
// none) must be no-ops - a stray callback from an unrelated inverter must
// never corrupt this session's evidence.
func TestCallbacksForAnUnrelatedFamilyAreNoOps(t *testing.T) {
	s := New(0)
	if _, err := s.Start("hybrid_3p", t0); err != nil {
		t.Fatal(err)
	}
	s.NoteWrite("sunspec", t0)
	s.NoteRegister("sunspec", true, t0)
	s.Observe("sunspec", TestKw, t0.Add(5*time.Second))
	if s.Phase("hybrid_3p", t0.Add(5*time.Second)) != PhaseActive {
		t.Fatal("an unrelated family's callbacks must not affect the running test")
	}
	// NaN/Inf readings for the RIGHT family must also be ignored, never
	// treated as "away" or "in band".
	hold(s, "hybrid_3p", t0)
	s.Observe("hybrid_3p", math.NaN(), t0.Add(6*time.Second))
	s.Observe("hybrid_3p", math.Inf(1), t0.Add(7*time.Second))
	if s.Phase("hybrid_3p", t0.Add(7*time.Second)) != PhaseActive {
		t.Fatal("NaN/Inf readings must never advance the departure proof")
	}
}

// EvidenceFor is nil for a family that was never tested at all - the caller
// must not confuse "no evidence" with "test failed".
func TestEvidenceForAnUntestedFamilyIsNil(t *testing.T) {
	s := New(0)
	if ev := s.EvidenceFor("hybrid_3p", t0); ev != nil {
		t.Fatalf("no test has run yet, evidence must be nil, got %+v", ev)
	}
	depart(t, s, "hybrid_3p", t0)
	if ev := s.EvidenceFor("sunspec", t0.Add(time.Minute)); ev != nil {
		t.Fatalf("evidence for a DIFFERENT family must be nil, got %+v", ev)
	}
}

// Evidence expires ConfirmGrace after the test concludes - an old result
// cannot be confirmed/recorded indefinitely.
func TestEvidenceExpiresAfterTheConfirmGraceWindow(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	settleEnd := settle(s, "hybrid_3p", writeAt, SettleSamples)
	justBefore := settleEnd.Add(ConfirmGrace - time.Second)
	justAfter := settleEnd.Add(ConfirmGrace + time.Second)
	if ev := s.EvidenceFor("hybrid_3p", justBefore); ev == nil || !ev.Valid {
		t.Fatal("evidence must still be valid within the grace window")
	}
	if ev := s.EvidenceFor("hybrid_3p", justAfter); ev == nil || ev.Valid {
		t.Fatalf("evidence must expire after the grace window: %+v", ev)
	}
	if s.CanRecord("hybrid_3p", justAfter) {
		t.Fatal("expired evidence must never be recordable")
	}
}

// A fresh Start replaces the previous test's evidence entirely (single-shot,
// like curtailcal/calibration) - a NEW test on the same family must not
// silently inherit an old departure/settle state.
func TestANewStartReplacesThePreviousTestsEvidence(t *testing.T) {
	s := New(0)
	writeAt := depart(t, s, "hybrid_3p", t0)
	settleEnd := settle(s, "hybrid_3p", writeAt, SettleSamples)
	if ev := s.EvidenceFor("hybrid_3p", settleEnd); ev.Verdict != VerdictPassed {
		t.Fatalf("sanity: first run must pass, got %q", ev.Verdict)
	}
	restart := settleEnd.Add(time.Hour)
	if _, err := s.Start("hybrid_3p", restart); err != nil {
		t.Fatalf("restart after conclusion+grace: %v", err)
	}
	ev := s.EvidenceFor("hybrid_3p", restart)
	if ev.Verdict != VerdictRunning {
		t.Fatalf("a freshly started test must read as running, not carry over the old pass: %q", ev.Verdict)
	}
	if ev.DepartureConfirmed || ev.RegisterConfirmed || ev.SettleSamples != 0 {
		t.Fatalf("a fresh test must start with a CLEAN slate: %+v", ev)
	}
}

// TTL()==0 falls back to DefaultTTL (the New() constructor contract).
func TestNewDefaultsAZeroOrNegativeTTL(t *testing.T) {
	if s := New(0); s.TTL() != DefaultTTL {
		t.Fatalf("TTL: %v", s.TTL())
	}
	if s := New(-time.Second); s.TTL() != DefaultTTL {
		t.Fatalf("TTL: %v", s.TTL())
	}
	if s := New(45 * time.Second); s.TTL() != 45*time.Second {
		t.Fatalf("a positive TTL must be kept verbatim: %v", s.TTL())
	}
}

// The safety chain documented in the package (and mirrored by
// otaapply.WatchdogDeadline's own margin/floor arithmetic): DepartureTimeout
// must stay comfortably under the overall DefaultTTL, or the "bound the
// active phase tighter" guarantee is vacuous.
func TestDepartureTimeoutStaysUnderTheOverallDefaultTTL(t *testing.T) {
	if DepartureTimeout >= DefaultTTL {
		t.Fatalf("DepartureTimeout (%v) must stay strictly under DefaultTTL (%v)", DepartureTimeout, DefaultTTL)
	}
}
