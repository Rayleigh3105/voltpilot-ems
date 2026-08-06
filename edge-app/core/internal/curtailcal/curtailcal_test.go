package curtailcal

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)

// hold marks the register as confirmed at `at` (what the executor's readback
// verdict does) - the precondition for any plateau sample.
func hold(s *Session, at time.Time) { s.NoteRegister("src-1", true, at) }

// plateau feeds n consecutive in-band readings, 5 s apart (the real source
// cadence), starting at `from`.
func plateau(s *Session, from time.Time, kw float64, n int) time.Time {
	at := from
	for i := 0; i < n; i++ {
		at = at.Add(5 * time.Second)
		s.Observe("src-1", kw, at)
	}
	return at
}

func TestStartBoundsTheTestAndRefusesLowOutput(t *testing.T) {
	s := New(0)
	if s.TTL() != DefaultTTL {
		t.Fatalf("default TTL expected, got %v", s.TTL())
	}
	// Too little output: no meaningful evidence possible -> refused.
	if _, err := s.Start("src-1", "ip:502#1", 3.0, nil, t0); err == nil {
		t.Fatal("a 3 kW output must refuse the test (below MinPvKw)")
	} else {
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("want ValidationError, got %T", err)
		}
	}
	// 21.4 kW output -> cap 80 % = 17.1 (rounded 0.1).
	capKw, err := s.Start("src-1", "ip:502#1", 21.4, nil, t0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if capKw != 17.1 {
		t.Fatalf("cap = 80%% of measured, rounded 0.1: got %v", capKw)
	}
	if !s.Active(t0) || s.ActiveTestFor("src-1", t0) == nil {
		t.Fatal("test must be active for src-1")
	}
	if s.ActiveTestFor("src-2", t0) != nil {
		t.Fatal("no test active for another source")
	}
	// A second test while one runs is refused (one bench step at a time).
	if _, err := s.Start("src-2", "ip:502#2", 30, nil, t0.Add(time.Second)); err == nil {
		t.Fatal("concurrent second test must be refused")
	}
}

// The headroom between the live output and the test cap IS the proof margin -
// at MinPvKw it is exactly the ambient margin, and the invariant is asserted
// so a future TestFraction change cannot silently make tests unprovable.
func TestStartRequiresEnoughHeadroomToProveAnything(t *testing.T) {
	s := New(0)
	if _, err := s.Start("src-1", "k1", MinPvKw, nil, t0); err != nil {
		t.Fatalf("MinPvKw must still leave provable headroom: %v", err)
	}
	capKw := s.ActiveTestFor("src-1", t0).CapKw
	if MinPvKw-capKw < ambientMargin(capKw) {
		t.Fatalf("MinPvKw %.1f - cap %.1f must cover the ambient margin %.1f",
			MinPvKw, capKw, ambientMargin(capKw))
	}
}

func TestEvidenceNeedsRegisterConfirmationANDAClampPlateau(t *testing.T) {
	s := New(0)
	capKw, _ := s.Start("src-1", "k1", 20, nil, t0) // cap 16
	if capKw != 16 {
		t.Fatalf("cap: %v", capKw)
	}

	// Nothing observed yet: no certification.
	if s.CanCertify("src-1", t0.Add(10*time.Second)) {
		t.Fatal("no evidence yet - must not certify")
	}

	// Register confirmed but the power never dropped (a foreign controller
	// overrides the limit): still NOT certifiable - the enforcement half is
	// the whole point on Fronius.
	hold(s, t0.Add(15*time.Second))
	plateau(s, t0.Add(15*time.Second), 19.8, 4) // stays near full output
	if s.CanCertify("src-1", t0.Add(45*time.Second)) {
		t.Fatal("register-only evidence must NOT certify (no observed clamp)")
	}
	ev := s.EvidenceFor("src-1", t0.Add(45*time.Second))
	if ev == nil || !ev.RegisterConfirmed || ev.ClampObserved {
		t.Fatalf("evidence half-proven expected: %+v", ev)
	}

	// ONE in-band reading is not a plateau (a cloud edge crosses the band too).
	at := plateau(s, t0.Add(45*time.Second), 16.2, 1)
	if s.CanCertify("src-1", at) {
		t.Fatal("a single in-band reading must not certify")
	}
	if got := s.EvidenceFor("src-1", at).PlateauSamples; got != 1 {
		t.Fatalf("plateau progress 1 expected, got %d", got)
	}

	// The measured output SITS AT the cap for PlateauSamples readings while
	// the register holds: both halves proven -> certifiable.
	at = plateau(s, at, 16.2, PlateauSamples-1)
	if !s.CanCertify("src-1", at) {
		t.Fatalf("register + clamp plateau must certify: %+v", s.EvidenceFor("src-1", at))
	}
	if v := s.EvidenceFor("src-1", at).Verdict; v != VerdictPassed {
		t.Fatalf("verdict %q expected, got %q", VerdictPassed, v)
	}
	// A recovering reading AFTER the deadline never overwrites the evidence.
	s.Observe("src-1", 20, t0.Add(DefaultTTL+time.Second))
	if ev := s.EvidenceFor("src-1", t0.Add(DefaultTTL+2*time.Second)); ev == nil || !ev.ClampObserved {
		t.Fatalf("post-deadline reading must not touch the evidence: %+v", ev)
	}
}

// The FIRST live false positive (Pilsting 2026-08-06): cap 17,4 kW, measured
// 12,9 kW - well BELOW the cap. The old "minimum fell to the cap" rule passed
// it; a cap CLAMPS power AT itself, only the sun pushes it below.
func TestAFallBELOWTheCapNeverCertifies(t *testing.T) {
	s := New(0)
	capKw, _ := s.Start("src-1", "k1", 21.75, nil, t0) // cap 17.4
	if capKw != 17.4 {
		t.Fatalf("cap: %v", capKw)
	}
	hold(s, t0.Add(10*time.Second))
	at := plateau(s, t0.Add(10*time.Second), 12.9, 6)
	if s.CanCertify("src-1", at) {
		t.Fatal("a fall BELOW the cap is the weather, never a proven clamp")
	}
	ev := s.EvidenceFor("src-1", at)
	if ev.ClampObserved || ev.PlateauSamples != 0 {
		t.Fatalf("no plateau expected: %+v", ev)
	}
	// After the test the verdict is honest about WHY (the ambient estimate -
	// this unit's own pre-test value, no sibling - sank below the cap).
	late := t0.Add(DefaultTTL + 10*time.Second)
	if v := s.EvidenceFor("src-1", late).Verdict; v != VerdictUnprovable {
		t.Fatalf("verdict %q expected, got %q (%s)", VerdictUnprovable, v, s.EvidenceFor("src-1", late).Reason)
	}
}

// The SECOND live false positive: cap 9,7 kW, measured 9,5 kW - INSIDE the
// tolerance band, so the band alone would pass it. The sibling unit held its
// usual ratio (WR2 ~ 0,82 x WR1) before AND after, i.e. the whole roof simply
// had less sun: the ambient reference is what tells them apart.
func TestAmbientReferenceTellsACloudApartFromACap(t *testing.T) {
	// WR1 = the tested unit at 11.9 kW, WR2 = the sibling at 9.76 (ratio 0.82).
	refs := map[string]float64{"src-2": 9.76}
	s := New(0)
	capKw, _ := s.Start("src-1", "k1", 11.9, refs, t0) // cap 9.5
	_ = capKw
	hold(s, t0.Add(10*time.Second))

	// The CLOUD: both units fall proportionally; the tested one lands right in
	// the cap band, but the sibling shows the sun is simply gone.
	at := t0.Add(10 * time.Second)
	for i := 0; i < 6; i++ {
		at = at.Add(5 * time.Second)
		s.Observe("src-2", 7.79, at) // 0.82 * 9.5 - the ratio HELD
		s.Observe("src-1", 9.5, at)
	}
	if s.CanCertify("src-1", at) {
		t.Fatal("both units falling proportionally is a cloud, never a proven cap")
	}
	late := t0.Add(DefaultTTL + 10*time.Second)
	ev := s.EvidenceFor("src-1", late)
	if ev.Verdict != VerdictUnprovable {
		t.Fatalf("cloud -> %q, got %q (%s)", VerdictUnprovable, ev.Verdict, ev.Reason)
	}
	if ev.AmbientSource != "src-2" {
		t.Fatalf("the sibling must be named as the ambient source: %+v", ev)
	}

	// The CAP: same cap, but ONLY the tested unit sits at it while the sibling
	// keeps its full share - the ambient estimate stays clearly above.
	s2 := New(0)
	s2.Start("src-1", "k1", 11.9, refs, t0)
	hold(s2, t0.Add(10*time.Second))
	at = t0.Add(10 * time.Second)
	for i := 0; i < PlateauSamples; i++ {
		at = at.Add(5 * time.Second)
		s2.Observe("src-2", 9.76, at) // the sibling is unchanged: full sun
		s2.Observe("src-1", 9.5, at)
	}
	if !s2.CanCertify("src-1", at) {
		t.Fatalf("only the tested unit clamped -> that IS the cap: %+v", s2.EvidenceFor("src-1", at))
	}
}

// Without a sibling the unit's own pre-test value is the ambient estimate -
// conservative by construction: it can only ever OVER-state the ambient while
// the sun sinks, and a sinking ambient is exactly what turns the verdict into
// "nicht beweisbar".
func TestWithoutAReferenceThePreTestValueIsTheAmbientAndAPlateauStillProves(t *testing.T) {
	s := New(0)
	s.Start("src-1", "k1", 25, nil, t0) // cap 20
	hold(s, t0.Add(10*time.Second))
	at := plateau(s, t0.Add(10*time.Second), 20.1, PlateauSamples)
	if !s.CanCertify("src-1", at) {
		t.Fatalf("a plateau against the pre-test ambient certifies: %+v", s.EvidenceFor("src-1", at))
	}
	ev := s.EvidenceFor("src-1", at)
	if ev.AmbientSource != "" {
		t.Fatalf("no sibling -> the ambient source is the unit itself: %q", ev.AmbientSource)
	}
}

// A plateau only counts while the register is DEMONSTRABLY holding the
// commanded value: an unconfirmed / lost / stale register cannot back it.
func TestAPlateauWithoutALiveRegisterHoldProvesNothing(t *testing.T) {
	// Never confirmed at all.
	s := New(0)
	s.Start("src-1", "k1", 25, nil, t0)
	at := plateau(s, t0, 20.1, 6)
	if s.CanCertify("src-1", at) {
		t.Fatal("a plateau without a register confirmation must not certify")
	}

	// Confirmed, then the readback DEVIATES (the device discarded the
	// command): the run breaks and the collected samples do not carry over.
	s2 := New(0)
	s2.Start("src-1", "k1", 25, nil, t0)
	hold(s2, t0.Add(5*time.Second))
	at = plateau(s2, t0.Add(5*time.Second), 20.1, PlateauSamples-1)
	s2.NoteRegister("src-1", false, at)
	at = plateau(s2, at, 20.1, PlateauSamples-1)
	if s2.CanCertify("src-1", at) {
		t.Fatal("a broken register hold must break the plateau run")
	}

	// Confirmed long ago and never refreshed: the hold is STALE, so nothing
	// observed after it counts (an un-refreshed cap has already reverted).
	s3 := New(0)
	s3.Start("src-1", "k1", 25, nil, t0)
	hold(s3, t0.Add(time.Second))
	stale := t0.Add(time.Second + RegisterHoldFresh + time.Second)
	if at := plateau(s3, stale, 20.1, PlateauSamples); s3.CanCertify("src-1", at) {
		t.Fatal("a stale register hold must not back a plateau")
	}
}

func TestGraceWindowAndExpiry(t *testing.T) {
	s := New(0)
	s.Start("src-1", "k1", 20, nil, t0)
	hold(s, t0.Add(10*time.Second))
	plateau(s, t0.Add(10*time.Second), 15.9, PlateauSamples)

	// After the TTL the test is no longer active, but the evidence stays
	// confirmable for ConfirmGrace (the battery First-Light grace rule).
	after := t0.Add(DefaultTTL + 30*time.Second)
	if s.Active(after) {
		t.Fatal("test must have auto-ended")
	}
	if !s.CanCertify("src-1", after) {
		t.Fatalf("evidence must stay confirmable within the grace window: %+v", s.EvidenceFor("src-1", after))
	}
	ev := s.EvidenceFor("src-1", after)
	if ev.AgeSeconds != 30 || ev.ExpiresInSeconds <= 0 {
		t.Fatalf("age/expiry bookkeeping: %+v", ev)
	}

	// Past the grace window: expired, not certifiable.
	late := t0.Add(DefaultTTL + ConfirmGrace + time.Second)
	if s.CanCertify("src-1", late) {
		t.Fatal("expired evidence must not certify")
	}
	if ev := s.EvidenceFor("src-1", late); ev == nil || ev.Valid {
		t.Fatalf("expired evidence must be invalid, got %+v", ev)
	}
}

func TestAbortInvalidatesEvidence(t *testing.T) {
	s := New(0)
	s.Start("src-1", "k1", 20, nil, t0)
	hold(s, t0.Add(5*time.Second))
	plateau(s, t0.Add(5*time.Second), 16.0, PlateauSamples)
	s.Abort(t0.Add(30 * time.Second))
	if s.Active(t0.Add(31 * time.Second)) {
		t.Fatal("aborted test must not be active")
	}
	if s.EvidenceFor("src-1", t0.Add(31*time.Second)) != nil {
		t.Fatal("an aborted test proves nothing - evidence must be nil")
	}
	// A fresh test can start immediately after an abort.
	if _, err := s.Start("src-1", "k1", 20, nil, t0.Add(40*time.Second)); err != nil {
		t.Fatalf("restart after abort: %v", err)
	}
}

func TestToleranceAndMarginScaleButKeepAFloor(t *testing.T) {
	if got := plateauTolerance(4); got != 0.5 {
		t.Fatalf("small cap -> 0.5 kW floor, got %v", got)
	}
	if got := plateauTolerance(40); got != 2.0 {
		t.Fatalf("5%% of a 40 kW cap = 2 kW, got %v", got)
	}
	if got := ambientMargin(4); got != 1.0 {
		t.Fatalf("small cap -> 1 kW ambient-margin floor, got %v", got)
	}
	if got := ambientMargin(40); got != 4.0 {
		t.Fatalf("10%% of a 40 kW cap = 4 kW, got %v", got)
	}
	// The margin must never be swallowed by the tolerance band, or a reading
	// at the top of the band would "prove" a cap against an equal ambient.
	for _, capKw := range []float64{4, 9.5, 17.4, 40} {
		if ambientMargin(capKw) <= plateauTolerance(capKw) {
			t.Fatalf("cap %.1f: ambient margin %.2f must exceed the band %.2f",
				capKw, ambientMargin(capKw), plateauTolerance(capKw))
		}
	}
}

// The timing chain the whole hardening rests on: the executor refreshes an
// active cap well before the inverter's native revert timer fires, and that
// timer fires well before a First-Light test ends. Pinned here because a
// change to any one of the three silently breaks the other two - the JS half
// (sunspec/curtail.js REFRESH_MS / DEFAULT_RVRT_TMS) pins the same chain.
func TestTheRefreshRevertTTLChainHolds(t *testing.T) {
	const refresh = 20 * time.Second // sunspec/curtail.js REFRESH_MS
	const revert = 60 * time.Second  // sunspec/curtail.js DEFAULT_RVRT_TMS
	if 2*refresh > revert {
		t.Fatalf("a MISSED refresh (%v) must still land before the revert (%v)", refresh, revert)
	}
	if revert >= DefaultTTL {
		t.Fatalf("the native revert (%v) must fire inside the test TTL (%v), never define it", revert, DefaultTTL)
	}
	if RegisterHoldFresh >= revert {
		t.Fatalf("a register hold (%v) must go stale before the cap reverts (%v)", RegisterHoldFresh, revert)
	}
}
