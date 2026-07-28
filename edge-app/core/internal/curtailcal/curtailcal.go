// Package curtailcal is the PURE First-Light state machine for CURTAILMENT
// certification of a SunSpec PV unit (a fronius_sunspec Erzeuger source): the
// bounded, auto-reverting test that proves - per physical inverter - that a
// Model-123 WMaxLimPct write is (a) accepted (register readback confirms) and
// (b) ENFORCED (the measured AC power actually drops to the commanded cap).
// The (b) half is what makes this gate meaningful on Fronius at all: Modbus is
// the LOWEST control priority there, so a confirmed register alone proves
// nothing - a local setting, Solar.web or a Smart-Meter rule can silently
// override it.
//
// Mirrors internal/calibration's discipline (the battery First-Light):
//   - no I/O, every time-dependent method takes `now` (deterministic tests);
//   - the test is BOUNDED (cap = TestFraction of the CURRENT measured output,
//     refused below MinPvKw where a drop would be indistinguishable from
//     noise) and TTL-limited - the agent's watchdog plus the inverter's own
//     native WMaxLimPct_RvrtTms revert it, never the operator's attention;
//   - evidence stays confirmable for ConfirmGrace after the test ends (the
//     fm/vp-calib-ux-t6 grace rule: the drop is a fact about the device, not
//     about whether the bounded command is still active);
//   - certification NEVER happens automatically - the agent asks CanCertify
//     and the operator presses the button.
package curtailcal

import (
	"fmt"
	"math"
	"time"
)

// ValidationError carries an operator-facing German message; the web layer
// maps it to HTTP 400 (mirrors calibration.ValidationError).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

const (
	// DefaultTTL bounds one curtailment test. 120 s: long enough for the
	// inverter's ramp (WMaxLimPct_WinTms) plus several 5-s source reads to
	// observe the drop, short enough that a forgotten test is gone before the
	// operator's coffee is.
	DefaultTTL = 120 * time.Second
	// ConfirmGrace keeps a completed test's evidence confirmable after the
	// auto-revert (the battery First-Light grace rule).
	ConfirmGrace = 3 * time.Minute
	// TestFraction: the test cap is 80 % of the CURRENT measured output - a
	// clearly visible, clearly bounded reduction.
	TestFraction = 0.8
	// MinPvKw refuses a test while the unit produces too little for the drop
	// to be distinguishable from cloud noise (the evidence would be worthless).
	MinPvKw = 5.0
)

// dropTolerance is the margin above the cap within which the measured minimum
// still counts as "dropped to the cap" (ramp overshoot / measurement noise).
func dropTolerance(capKw float64) float64 {
	return math.Max(0.5, 0.05*capKw)
}

// Test is one bounded curtailment test on one unit.
type Test struct {
	SourceID string
	UnitKey  string
	// CapKw is the bounded test cap (TestFraction of BeforeKw, rounded 0.1).
	CapKw float64
	// BeforeKw is the measured output when the test started.
	BeforeKw  float64
	StartedAt time.Time
	Deadline  time.Time
	// RegisterConfirmed latches once a readback during the test confirmed
	// every commanded register (the write LANDED).
	RegisterConfirmed bool
	// MinObservedKw tracks the lowest measured output seen during the test -
	// the enforcement half of the evidence. nil = no reading arrived yet.
	MinObservedKw *float64

	aborted bool
}

// Evidence is the confirmable outcome of the most recent test for a unit.
type Evidence struct {
	Valid             bool     `json:"valid"`
	SourceID          string   `json:"source_id"`
	UnitKey           string   `json:"unit_key"`
	CapKw             float64  `json:"cap_kw"`
	BeforeKw          float64  `json:"before_kw"`
	MinObservedKw     *float64 `json:"min_observed_kw,omitempty"`
	RegisterConfirmed bool     `json:"register_confirmed"`
	// DropObserved: the measured output fell to (or below) the cap within
	// tolerance - the ENFORCEMENT proof.
	DropObserved bool `json:"drop_observed"`
	// AgeSeconds since the test ENDED (0 while still active).
	AgeSeconds int `json:"age_seconds"`
	// ExpiresInSeconds until the grace window closes (0 = expired).
	ExpiresInSeconds int `json:"expires_in_seconds"`
}

// Session holds at most ONE running/recent curtailment test (one operator,
// one bench step at a time - like the battery calibration session).
type Session struct {
	ttl  time.Duration
	test *Test
}

// New builds a session with the given TTL (0 = DefaultTTL).
func New(ttl time.Duration) *Session {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Session{ttl: ttl}
}

// TTL returns the configured test duration.
func (s *Session) TTL() time.Duration { return s.ttl }

// Start begins a bounded test for the unit: cap = TestFraction of the CURRENT
// measured output. Refused while another test is active, or when the unit
// produces less than MinPvKw (no meaningful evidence possible).
func (s *Session) Start(sourceID, unitKey string, measuredKw float64, now time.Time) (float64, error) {
	if t := s.activeTest(now); t != nil {
		return 0, invalid("Es läuft bereits ein Abregelungs-Test (%s). Bitte warten oder abbrechen.", t.SourceID)
	}
	if math.IsNaN(measuredKw) || measuredKw < MinPvKw {
		return 0, invalid("Der Wechselrichter liefert gerade zu wenig Leistung für einen aussagekräftigen Test (mindestens %.0f kW). Bitte bei mehr Sonne erneut versuchen.", MinPvKw)
	}
	capKw := math.Round(measuredKw*TestFraction*10) / 10
	s.test = &Test{
		SourceID:  sourceID,
		UnitKey:   unitKey,
		CapKw:     capKw,
		BeforeKw:  measuredKw,
		StartedAt: now,
		Deadline:  now.Add(s.ttl),
	}
	return capKw, nil
}

// activeTest returns the running (not aborted, not past deadline) test.
func (s *Session) activeTest(now time.Time) *Test {
	if s.test == nil || s.test.aborted || now.After(s.test.Deadline) {
		return nil
	}
	return s.test
}

// ActiveTestFor returns the running test IF it belongs to sourceID.
func (s *Session) ActiveTestFor(sourceID string, now time.Time) *Test {
	t := s.activeTest(now)
	if t == nil || t.SourceID != sourceID {
		return nil
	}
	return t
}

// Active reports whether any test is running.
func (s *Session) Active(now time.Time) bool { return s.activeTest(now) != nil }

// Abort ends the running test immediately AND invalidates its evidence (an
// aborted test proves nothing - the cap may never have been observed).
func (s *Session) Abort(now time.Time) {
	if s.test != nil {
		s.test.aborted = true
	}
}

// Observe feeds a measured output reading for the unit under test. Only
// readings DURING the active window count (after the revert the output
// legitimately recovers - that must not overwrite the evidence).
func (s *Session) Observe(sourceID string, measuredKw float64, now time.Time) {
	t := s.ActiveTestFor(sourceID, now)
	if t == nil || math.IsNaN(measuredKw) {
		return
	}
	if t.MinObservedKw == nil || measuredKw < *t.MinObservedKw {
		v := measuredKw
		t.MinObservedKw = &v
	}
}

// NoteRegisterMatch records a readback verdict for the unit under test: a
// confirmed write LATCHES (the write landed; a later transient mismatch does
// not un-land it - the enforcement half judges the effect separately).
func (s *Session) NoteRegisterMatch(sourceID string, allMatch bool, now time.Time) {
	t := s.ActiveTestFor(sourceID, now)
	if t == nil {
		return
	}
	if allMatch {
		t.RegisterConfirmed = true
	}
}

// EvidenceFor returns the confirmable evidence for sourceID: valid while the
// test runs and for ConfirmGrace after its deadline; an aborted test is never
// valid; a test for a DIFFERENT source yields nil.
func (s *Session) EvidenceFor(sourceID string, now time.Time) *Evidence {
	t := s.test
	if t == nil || t.SourceID != sourceID || t.aborted {
		return nil
	}
	expiry := t.Deadline.Add(ConfirmGrace)
	ev := &Evidence{
		SourceID:          t.SourceID,
		UnitKey:           t.UnitKey,
		CapKw:             t.CapKw,
		BeforeKw:          t.BeforeKw,
		MinObservedKw:     t.MinObservedKw,
		RegisterConfirmed: t.RegisterConfirmed,
	}
	if t.MinObservedKw != nil && *t.MinObservedKw <= t.CapKw+dropTolerance(t.CapKw) {
		ev.DropObserved = true
	}
	if now.After(t.Deadline) {
		ev.AgeSeconds = int(now.Sub(t.Deadline) / time.Second)
	}
	if now.Before(expiry) {
		ev.Valid = true
		ev.ExpiresInSeconds = int(expiry.Sub(now) / time.Second)
	}
	return ev
}

// CanCertify: the evidence is still valid AND both halves are proven - the
// register readback confirmed the write and the measured output dropped to
// the cap. This is what the operator's "Freigeben" button requires; the
// session never certifies anything itself.
func (s *Session) CanCertify(sourceID string, now time.Time) bool {
	ev := s.EvidenceFor(sourceID, now)
	return ev != nil && ev.Valid && ev.RegisterConfirmed && ev.DropObserved
}

// --- the web-facing view (assembled by the agent) ---------------------------

// UnitView is one Fronius unit on the calibration surface.
type UnitView struct {
	SourceID string `json:"source_id"`
	UnitKey  string `json:"unit_key"`
	Label    string `json:"label"`
	Target   string `json:"target"`
	// Certified = the persisted per-unit First-Light grant.
	Certified bool `json:"certified"`
	// LivePvKw is the unit's latest fresh measured output (nil = none).
	LivePvKw *float64 `json:"live_pv_kw,omitempty"`
	// TestCapKw previews what a test started NOW would command (nil while the
	// output is below MinPvKw).
	TestCapKw *float64 `json:"test_cap_kw,omitempty"`
	// Test is the RUNNING test on this unit (nil otherwise).
	Test *TestView `json:"test,omitempty"`
	// Evidence of the most recent (possibly just-ended) test, while valid.
	Evidence   *Evidence `json:"evidence,omitempty"`
	CanCertify bool      `json:"can_certify"`
	// LastError surfaces the most recent EXECUTION failure reported for this
	// unit (the flow's blocked readback reason - "Gateway nicht erreichbar",
	// "SunSpec-Modelle nicht lesbar", "Schreiben fehlgeschlagen: Timeout", ...)
	// so the card names the CAUSE of a failed/hanging test instead of leaving
	// a bare "warte auf Bestätigung". Empty when the latest readback was fine
	// or none is recent.
	LastError           string `json:"last_error,omitempty"`
	LastErrorAgeSeconds int    `json:"last_error_age_seconds,omitempty"`
}

// TestView is the running test, rendered.
type TestView struct {
	CapKw            float64  `json:"cap_kw"`
	BeforeKw         float64  `json:"before_kw"`
	SecondsRemaining int      `json:"seconds_remaining"`
	RegisterOk       bool     `json:"register_ok"`
	MinObservedKw    *float64 `json:"min_observed_kw,omitempty"`
}

// View is the GET /api/curtail payload.
type View struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// ControlEnabled mirrors the global kill-switch (VP_CONTROL_ENABLED).
	ControlEnabled bool `json:"control_enabled"`
	// AdminGate: the calibration admin secret is configured - mutations need
	// the X-VP-Calibration-Token header (the SAME gate as the battery card).
	AdminGate      bool       `json:"admin_gate"`
	TestTTLSeconds int        `json:"test_ttl_seconds"`
	MinPvKw        float64    `json:"min_pv_kw"`
	Units          []UnitView `json:"units"`
}
