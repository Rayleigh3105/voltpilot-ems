// Package calibration is the pure state machine + arithmetic for the First-Light
// calibration step: the safe, tightly-bounded procedure that proves a battery
// inverter's control SIGN and SCALE on the REAL hardware via small, observed,
// auto-reverting test writes, BEFORE the inverter family is certified for
// optimizer-driven control. It is the mechanism for the very first real write to
// a live customer battery (design data/vp-battery-control-deepdive/report.md §5.7:
// "write a SMALL value, read it back, cross-check the MEASURED battery power moved
// in the expected direction and magnitude, then scale up. Never write a large
// forced value first").
//
// This package holds NO I/O and NO wall-clock reads: every method that depends on
// time takes `now`, so the whole envelope is deterministically testable offline.
// The agent (agent/calibration.go) wires it to the guard chain, the edge/setpoint
// publish, the readback and the persisted certification.
//
// THE SAFETY ENVELOPE - bound on EVERY axis (enforced here or, where noted, by the
// agent that owns I/O and the kill-switch):
//   - explicit ARM required (Armed defaults false); no test without an arm;
//   - SINGLE-SHOT: one bounded test at a time, a new test replaces the old;
//   - MAGNITUDE cap: |setpoint| <= Config.MaxKw - StartTest REFUSES a larger
//     request and ClampMagnitude is the defense clamp; the value STILL flows
//     through guards.Clamp in the agent (never around it);
//   - DURATION cap: every test auto-reverts to neutral after Config.TTL, then a
//     short RevertGrace window during which the release keeps being (re)published,
//     so the write NEVER latches - a controller-owned watchdog, independent of the
//     UI (the agent runs it even if the browser is closed / the socket drops);
//   - the global kill-switch VP_CONTROL_ENABLED still wins (enforced in the agent);
//   - certification is a SEPARATE deliberate step gated on the operator confirming
//     BOTH sign and scale (Passed) - calibration never auto-certifies.
package calibration

import (
	"math"
	"time"
)

// Direction of a calibration test.
type Direction string

const (
	// Charge commands a small POSITIVE battery setpoint (battery charges).
	Charge Direction = "charge"
	// Discharge commands a small NEGATIVE battery setpoint (battery discharges).
	Discharge Direction = "discharge"
)

// Phase is what a calibration test is doing right now, derived from `now`.
type Phase string

const (
	// PhaseIdle: no active test is forcing anything (never started, or past the
	// revert grace). The agent runs the normal setpoint path.
	PhaseIdle Phase = "idle"
	// PhaseActive: the bounded test setpoint is being commanded (still inside TTL).
	PhaseActive Phase = "active"
	// PhaseRevert: the TTL elapsed or the test was aborted; the neutral release is
	// (re)published across this window so it lands even if a tick is missed.
	PhaseRevert Phase = "revert"
)

// RevertGrace is how long AFTER a test's deadline the neutral release keeps being
// (re)published by the agent, so it lands across ~10 s setpoint ticks plus a
// possible busy-logger skip even when one tick is missed. The calibration write
// can never re-arm during this window (only a fresh StartTest re-arms).
const RevertGrace = 30 * time.Second

// moveDeadbandKw is the minimum measured battery power (magnitude) that counts as
// "the battery is moving" - below it the sign is undetermined. Matches the
// live/topology 0.05 kW deadband.
const moveDeadbandKw = 0.05

// magnitudeLo/magnitudeHi bound the |measured|/|commanded| ratio that counts as
// "scale is right". Outside [Lo, Hi] the scale is wrong; ScaleFactorHigh/Low mark
// the ~10x (HV decawatt) and ~0.1x errors so the UI can suggest power_scale.
const (
	magnitudeLo      = 0.5 // measured is at least half the command
	magnitudeHi      = 2.0 // ... and at most double it
	scaleFactorHigh  = 5.0 // measured >> command -> likely HV (set power_scale 10)
	scaleFactorLow   = 0.2 // measured << command -> set power_scale 1
	socTestableMargn = 0.5 // %-points of headroom needed to call a direction testable
)

// Config is the calibration envelope (from config.CalibrationMaxKw / TTL).
type Config struct {
	MaxKw float64       // hard magnitude cap for a test setpoint
	TTL   time.Duration // auto-revert window
}

// Reading is the subset of the live inverter reading the verdict needs. A nil
// field is UNKNOWN (never coerced to 0 - a missing measurement is honest).
type Reading struct {
	BatteryKw *float64 // MEASURED battery power, + charge / - discharge
	SocPct    *float64
}

// SocBand is the operating SoC window (agent guard limits) used to decide which
// directions are testable right now (at 100 % only discharge is verifiable).
type SocBand struct {
	MinPct float64
	MaxPct float64
}

// ClampMagnitude caps a signed request to [-maxKw, +maxKw] - the defense clamp
// behind StartTest's refusal, so a value can never leave this package above the
// envelope even if a caller skips the error.
func ClampMagnitude(kw, maxKw float64) float64 {
	if maxKw <= 0 || math.IsNaN(kw) || math.IsInf(kw, 0) {
		return 0
	}
	return math.Max(-maxKw, math.Min(maxKw, kw))
}

// ValidationError is a user-facing (German) calibration failure. The web layer
// maps it to HTTP 400; any other error is an internal 500 (the guards.
// SettingsValidationError precedent).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// ErrNotArmed / ErrBadMagnitude are the StartTest refusals (classifiable 400s).
var (
	ErrNotArmed     = &ValidationError{Msg: "Kalibriermodus ist nicht scharfgeschaltet."}
	ErrBadMagnitude = &ValidationError{Msg: "ungültiger Testwert."}
)

type testState struct {
	dir       Direction
	commandKw float64 // signed, already capped to [-MaxKw, +MaxKw]
	startedAt time.Time
	deadline  time.Time // startedAt + TTL, or the abort instant if earlier
	aborted   bool
	before    Reading
}

// Session is the calibration state machine. It is NOT safe for concurrent use;
// the agent owns exactly one and guards it with a mutex.
type Session struct {
	cfg  Config
	armed bool
	test *testState

	// Operator confirmations, session-scoped (persist across tests within a
	// commissioning session). Passed() == both true gates the certification step.
	// The agent resets them whenever a sign/scale CORRECTION is applied (a prior
	// confirmation is stale once the connection config changes).
	signConfirmed  bool
	scaleConfirmed bool
}

// NewSession builds a disarmed session with the given envelope.
func NewSession(cfg Config) *Session { return &Session{cfg: cfg} }

// Config returns the envelope.
func (s *Session) Config() Config { return s.cfg }

// Armed reports whether calibration mode is scharfgeschaltet.
func (s *Session) Armed() bool { return s.armed }

// Arm enables calibration mode. Idempotent.
func (s *Session) Arm() { s.armed = true }

// Disarm turns calibration mode off AND aborts any active test (so it reverts to
// neutral). It does NOT clear the operator confirmations or the last test's
// display - a passed calibration stays certifiable.
func (s *Session) Disarm(now time.Time) {
	s.armed = false
	s.Abort(now)
}

// StartTest arms a single bounded test. Requires the session armed; refuses a
// magnitude that is not finite, <= 0, or above the envelope (MaxKw). `before` is
// the live reading captured at the moment of the write, for the verdict.
func (s *Session) StartTest(dir Direction, magnitudeKw float64, before Reading, now time.Time) error {
	if !s.armed {
		return ErrNotArmed
	}
	if dir != Charge && dir != Discharge {
		return ErrBadMagnitude
	}
	if math.IsNaN(magnitudeKw) || math.IsInf(magnitudeKw, 0) || magnitudeKw <= 0 || magnitudeKw > s.cfg.MaxKw {
		return ErrBadMagnitude
	}
	signed := magnitudeKw
	if dir == Discharge {
		signed = -magnitudeKw
	}
	signed = ClampMagnitude(signed, s.cfg.MaxKw) // defense; already in range
	s.test = &testState{
		dir:       dir,
		commandKw: signed,
		startedAt: now,
		deadline:  now.Add(s.cfg.TTL),
		before:    before,
	}
	return nil
}

// Abort ends the active test immediately (its deadline becomes `now`), so the
// agent hands control back with the neutral release. A no-op when no test is live.
func (s *Session) Abort(now time.Time) {
	if s.test == nil {
		return
	}
	if now.Before(s.test.deadline) {
		s.test.deadline = now
	}
	s.test.aborted = true
}

// Phase reports the current test phase at `now`.
func (s *Session) Phase(now time.Time) Phase {
	if s.test == nil {
		return PhaseIdle
	}
	if now.Before(s.test.deadline) {
		return PhaseActive
	}
	if now.Before(s.test.deadline.Add(RevertGrace)) {
		return PhaseRevert
	}
	return PhaseIdle
}

// Engaged reports whether calibration is currently overriding the normal setpoint
// path (an active test OR its revert window). While engaged the agent publishes the
// calibration/neutral setpoint instead of the plan/arbiter value.
func (s *Session) Engaged(now time.Time) bool {
	p := s.Phase(now)
	return p == PhaseActive || p == PhaseRevert
}

// Command returns the bounded test setpoint to publish while ACTIVE (else 0/false).
// The value is already capped; the agent additionally clamps it through guards.
func (s *Session) Command(now time.Time) (kw float64, active bool) {
	if s.Phase(now) == PhaseActive {
		return s.test.commandKw, true
	}
	return 0, false
}

// ConfirmSign / ConfirmScale record the operator's verdict.
func (s *Session) ConfirmSign(ok bool)  { s.signConfirmed = ok }
func (s *Session) ConfirmScale(ok bool) { s.scaleConfirmed = ok }

// ResetConfirmations clears both operator confirmations (the agent calls this when
// a sign/scale correction is applied - a prior confirmation is then stale).
func (s *Session) ResetConfirmations() {
	s.signConfirmed = false
	s.scaleConfirmed = false
}

// Passed reports whether the operator confirmed BOTH sign and scale - the gate the
// certification step requires ("Kalibrierung bestanden").
func (s *Session) Passed() bool { return s.signConfirmed && s.scaleConfirmed }

// Verdict cross-checks a commanded battery setpoint against the MEASURED battery
// power (the "hat die Batterie sich bewegt?" half). It compares the ABSOLUTE
// measured value against the command (the ToU forces the battery toward it), plus
// the raw before->after delta as supporting context. Pure.
func Verdict(commandKw float64, before, after Reading) VerdictResult {
	v := VerdictResult{CommandKw: commandKw}
	if after.BatteryKw != nil {
		m := *after.BatteryKw
		v.MeasuredKw = &m
	}
	if before.BatteryKw != nil && after.BatteryKw != nil {
		d := *after.BatteryKw - *before.BatteryKw
		v.DeltaKw = &d
	}
	if v.MeasuredKw == nil {
		v.Text = "Batterie-Leistung wird noch nicht gemessen - warten Sie auf das erste Messwert-Update."
		return v
	}
	m := *v.MeasuredKw
	cmd := commandKw
	moving := math.Abs(m) >= moveDeadbandKw
	sameSign := (m > 0) == (cmd > 0)
	switch {
	case !moving:
		v.Text = "Die Batterie bewegt sich (noch) nicht - kurz warten oder Testwert erhöhen."
	case sameSign:
		v.SignOK = true
	default:
		v.SignInverted = true
		v.Text = "Vorzeichen VERKEHRT: die Batterie läuft in die falsche Richtung. „Vorzeichen umkehren“ aktivieren und erneut testen."
	}

	if cmd != 0 && v.MeasuredKw != nil {
		ratio := math.Abs(m) / math.Abs(cmd)
		v.ScaleRatio = &ratio
		v.MagnitudeOK = ratio >= magnitudeLo && ratio <= magnitudeHi
		switch {
		case ratio >= scaleFactorHigh:
			v.ScaleHint = "hoch" // measured ~10x -> HV decawatt: set power_scale = 10
		case ratio <= scaleFactorLow && moving:
			v.ScaleHint = "niedrig" // measured ~0.1x: set power_scale = 1
		}
	}

	// One combined German sentence for the common cases (sign wrong already set above).
	if v.SignOK {
		switch {
		case v.MagnitudeOK:
			v.Text = "Richtung und Größe stimmen ✓"
		case v.ScaleHint == "hoch":
			v.Text = "Richtung stimmt, aber die Batterie bewegt etwa das 10-fache: Leistungsskalierung auf 10 (HV) stellen und erneut testen."
		case v.ScaleHint == "niedrig":
			v.Text = "Richtung stimmt, aber die Batterie bewegt viel zu wenig: Leistungsskalierung auf 1 stellen und erneut testen."
		default:
			v.Text = "Richtung stimmt; Größe prüfen (gemessen weicht vom Sollwert ab)."
		}
	}
	return v
}

// VerdictResult is the sign/scale/magnitude cross-check of ONE calibration write.
type VerdictResult struct {
	CommandKw    float64  `json:"command_kw"`
	MeasuredKw   *float64 `json:"measured_kw"`   // after.BatteryKw (nil = unknown)
	DeltaKw      *float64 `json:"delta_kw"`      // after - before (supporting)
	SignOK       bool     `json:"sign_ok"`       // measured direction matches command
	SignInverted bool     `json:"sign_inverted"` // measured OPPOSITE -> suggest invert_control_sign
	MagnitudeOK  bool     `json:"magnitude_ok"`  // |measured| ~= |command|
	ScaleRatio   *float64 `json:"scale_ratio"`   // |measured| / |command|
	ScaleHint    string   `json:"scale_hint"`    // "" | "hoch" (x10) | "niedrig"
	Text         string   `json:"text"`
}

// TestView is the UI view of the active/last test.
type TestView struct {
	Direction   Direction     `json:"direction"`
	CommandKw   float64       `json:"command_kw"`
	StartedAt   time.Time     `json:"started_at"`
	ExpiresAt   time.Time     `json:"expires_at"`
	SecondsLeft int           `json:"seconds_left"`
	Phase       Phase         `json:"phase"`
	BeforeKw    *float64      `json:"before_kw"`
	Verdict     VerdictResult `json:"verdict"`
}

// Snapshot is the /api/calibration payload. The Session fills the pure fields; the
// agent decorates Available/Reason/ControlEnabled/Family/Certified before serving.
type Snapshot struct {
	Available      bool    `json:"available"`  // a battery inverter is selected (agent-set)
	Reason         string  `json:"reason"`     // German note when unavailable/blocked (agent-set)
	Armed          bool    `json:"armed"`
	Phase          Phase   `json:"phase"`
	MaxKw          float64 `json:"max_kw"`
	TtlSeconds     int     `json:"ttl_seconds"`
	ControlEnabled bool    `json:"control_enabled"` // global kill-switch on (agent-set)
	Family         string  `json:"family"`          // register-map family (agent-set)
	Certified      bool    `json:"certified"`       // already certified (agent-set)

	SocPct            *float64 `json:"soc_pct"`
	BatteryKw         *float64 `json:"battery_kw"`
	ChargeTestable    bool     `json:"charge_testable"`
	DischargeTestable bool     `json:"discharge_testable"`

	Test *TestView `json:"test"`

	SignConfirmed  bool `json:"sign_confirmed"`
	ScaleConfirmed bool `json:"scale_confirmed"`
	Passed         bool `json:"passed"`
}

// Snapshot builds the pure calibration view at `now` given the live reading and
// the operating SoC band. Directions are testable when there is SoC headroom (or
// the SoC is unknown - the guard chain is the real bound).
func (s *Session) Snapshot(now time.Time, live Reading, band SocBand) Snapshot {
	snap := Snapshot{
		Armed:          s.armed,
		Phase:          s.Phase(now),
		MaxKw:          s.cfg.MaxKw,
		TtlSeconds:     int(s.cfg.TTL / time.Second),
		SocPct:         live.SocPct,
		BatteryKw:      live.BatteryKw,
		SignConfirmed:  s.signConfirmed,
		ScaleConfirmed: s.scaleConfirmed,
		Passed:         s.Passed(),
	}
	// Direction testability: unknown SoC -> both testable (guards clamp anyway).
	if live.SocPct == nil {
		snap.ChargeTestable, snap.DischargeTestable = true, true
	} else {
		soc := *live.SocPct
		snap.ChargeTestable = soc < band.MaxPct-socTestableMargn
		snap.DischargeTestable = soc > band.MinPct+socTestableMargn
	}
	if s.test != nil {
		phase := s.Phase(now)
		left := 0
		if d := s.test.deadline.Sub(now); d > 0 {
			left = int(math.Ceil(d.Seconds()))
		}
		snap.Test = &TestView{
			Direction:   s.test.dir,
			CommandKw:   s.test.commandKw,
			StartedAt:   s.test.startedAt.UTC(),
			ExpiresAt:   s.test.deadline.UTC(),
			SecondsLeft: left,
			Phase:       phase,
			BeforeKw:    s.test.before.BatteryKw,
			Verdict:     Verdict(s.test.commandKw, s.test.before, live),
		}
	}
	return snap
}
