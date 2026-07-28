package curtailcal

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)

func TestStartBoundsTheTestAndRefusesLowOutput(t *testing.T) {
	s := New(0)
	if s.TTL() != DefaultTTL {
		t.Fatalf("default TTL expected, got %v", s.TTL())
	}
	// Too little output: no meaningful evidence possible -> refused.
	if _, err := s.Start("src-1", "ip:502#1", 3.0, t0); err == nil {
		t.Fatal("a 3 kW output must refuse the test (below MinPvKw)")
	} else {
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("want ValidationError, got %T", err)
		}
	}
	// 21.4 kW output -> cap 80 % = 17.1 (rounded 0.1).
	capKw, err := s.Start("src-1", "ip:502#1", 21.4, t0)
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
	if _, err := s.Start("src-2", "ip:502#2", 30, t0.Add(time.Second)); err == nil {
		t.Fatal("concurrent second test must be refused")
	}
}

func TestEvidenceNeedsRegisterConfirmationANDObservedDrop(t *testing.T) {
	s := New(0)
	capKw, _ := s.Start("src-1", "k1", 20, t0) // cap 16
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
	s.NoteRegisterMatch("src-1", true, t0.Add(15*time.Second))
	s.Observe("src-1", 19.8, t0.Add(20*time.Second)) // stays near full output
	if s.CanCertify("src-1", t0.Add(30*time.Second)) {
		t.Fatal("register-only evidence must NOT certify (no observed drop)")
	}
	ev := s.EvidenceFor("src-1", t0.Add(30*time.Second))
	if ev == nil || !ev.RegisterConfirmed || ev.DropObserved {
		t.Fatalf("evidence half-proven expected: %+v", ev)
	}

	// The measured output drops to the cap (within tolerance): both halves
	// proven -> certifiable.
	s.Observe("src-1", 16.4, t0.Add(60*time.Second)) // <= 16 + max(0.5, 0.8)
	if !s.CanCertify("src-1", t0.Add(70*time.Second)) {
		t.Fatal("register + observed drop must certify")
	}
	// A recovering reading AFTER the deadline never overwrites the evidence.
	s.Observe("src-1", 20, t0.Add(DefaultTTL+time.Second))
	if ev := s.EvidenceFor("src-1", t0.Add(DefaultTTL+2*time.Second)); ev == nil || *ev.MinObservedKw != 16.4 {
		t.Fatalf("post-deadline reading must not touch the evidence: %+v", ev)
	}
}

func TestGraceWindowAndExpiry(t *testing.T) {
	s := New(0)
	s.Start("src-1", "k1", 20, t0)
	s.NoteRegisterMatch("src-1", true, t0.Add(10*time.Second))
	s.Observe("src-1", 15.9, t0.Add(20*time.Second))

	// After the TTL the test is no longer active, but the evidence stays
	// confirmable for ConfirmGrace (the battery First-Light grace rule).
	after := t0.Add(DefaultTTL + 30*time.Second)
	if s.Active(after) {
		t.Fatal("test must have auto-ended")
	}
	if !s.CanCertify("src-1", after) {
		t.Fatal("evidence must stay confirmable within the grace window")
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
	s.Start("src-1", "k1", 20, t0)
	s.NoteRegisterMatch("src-1", true, t0.Add(5*time.Second))
	s.Observe("src-1", 15.0, t0.Add(10*time.Second))
	s.Abort(t0.Add(15 * time.Second))
	if s.Active(t0.Add(16 * time.Second)) {
		t.Fatal("aborted test must not be active")
	}
	if s.EvidenceFor("src-1", t0.Add(16*time.Second)) != nil {
		t.Fatal("an aborted test proves nothing - evidence must be nil")
	}
	// A fresh test can start immediately after an abort.
	if _, err := s.Start("src-1", "k1", 20, t0.Add(20*time.Second)); err != nil {
		t.Fatalf("restart after abort: %v", err)
	}
}

func TestDropToleranceScalesButNeverBelowHalfKw(t *testing.T) {
	if got := dropTolerance(4); got != 0.5 {
		t.Fatalf("small cap -> 0.5 kW floor, got %v", got)
	}
	if got := dropTolerance(40); got != 2.0 {
		t.Fatalf("5%% of a 40 kW cap = 2 kW, got %v", got)
	}
}
