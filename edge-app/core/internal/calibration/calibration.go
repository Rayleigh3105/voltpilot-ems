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
	"sort"
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

// ConfirmGrace is how long a FINISHED test's confirmable verdict stays valid after
// its last attributable measured movement (Defect 1, 2026-07-27). The evidence gate
// (report §7 Gap B) is unchanged - a confirmation still requires a real,
// readback-confirmed test with an OBSERVED movement in the commanded direction - but
// that movement is a fact about the DEVICE, not about whether a bounded command is
// still active. Treating the proof as expiring the instant the test auto-reverts to
// neutral gave the operator a ~2 s window to tick the boxes (the captain's live case);
// so instead the captured evidence stays confirmable for this window. It STILL
// invalidates on a new test, an abort, a disarm, a sign/scale correction, or when the
// window elapses. 3 min: long enough to read the tile and tick two boxes + certify
// without rushing, short enough that the proof is still recent (the device config has
// not changed and the movement was just measured).
const ConfirmGrace = 3 * time.Minute

// moveDeadbandKw is the minimum measured battery power (magnitude) that counts as
// "the battery is moving" - below it the sign is undetermined. Matches the
// live/topology 0.05 kW deadband.
const moveDeadbandKw = 0.05

// quietBaselineFrac / quietBaselineFloorKw bound how much the battery may ALREADY be
// moving BEFORE a test for the measured after-value to be attributable to the
// command. A ToU command sets the battery's ABSOLUTE power, so the verdict judges the
// after-value - but only from a near-idle baseline. If the battery was already
// charging/discharging hard (the captain's live case: a ~31 kW PV-surplus charge),
// the measured after-value reflects that natural activity, NOT our <=1 kW test, so no
// confident sign/scale verdict may be drawn (Verdict.BaselineBusy). The threshold
// scales with the command so a bigger test tolerates a slightly busier baseline, with
// a small absolute floor for BMS standby noise.
const (
	quietBaselineFrac    = 0.5
	quietBaselineFloorKw = 2 * moveDeadbandKw // 0.1 kW
)

// quietBaselineKw is the largest |before| that still counts as "the battery was in
// rest" for a test of the given signed command.
func quietBaselineKw(commandKw float64) float64 {
	return math.Max(quietBaselineFloorKw, quietBaselineFrac*math.Abs(commandKw))
}

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

// fixedTestSteps is the legacy absolute ladder, used only when the inverter's rated
// power is unknown (fallback). On a big unit its smallest rung is a tiny fraction of
// rated and may not move the battery at all - which is exactly why the rated-relative
// ladder below is preferred.
var fixedTestSteps = []float64{0.2, 0.3, 0.5, 1.0}

// testStepFracs is the rated-relative ladder (~1 %, ~3 %, ~5 % of nameplate). A 0.3 kW
// step is 1 % of a 30 kW unit (no measurable movement - the captain's live case) but
// 6 % of a 5 kW hybrid; scaling to rated gives a meaningful ladder on both.
var testStepFracs = []float64{0.01, 0.03, 0.05}

// TestStepsForRated returns the test-power ladder (kW) offered to the operator, derived
// from the inverter's rated power so the smallest rung actually moves the battery
// (Defect 2). Each rung is a fraction of rated, rounded to 0.1 kW (>=0.1), then capped
// by the hard envelope maxKw (VP_CALIBRATION_MAX_KW stays authoritative - this changes
// which values are OFFERED, never the ceiling). Duplicates collapse and the result is
// sorted ascending. When ratedKw is unknown (<=0) it falls back to the fixed ladder
// filtered to <= maxKw, and the surface tells the operator why.
func TestStepsForRated(ratedKw, maxKw float64) []float64 {
	if maxKw <= 0 || math.IsNaN(maxKw) || math.IsInf(maxKw, 0) {
		return nil
	}
	var raw []float64
	if ratedKw > 0 && !math.IsNaN(ratedKw) && !math.IsInf(ratedKw, 0) {
		for _, f := range testStepFracs {
			v := math.Round(ratedKw*f*10) / 10 // nearest 0.1 kW
			if v < 0.1 {
				v = 0.1
			}
			raw = append(raw, v)
		}
	} else {
		raw = append(raw, fixedTestSteps...)
	}
	seen := map[float64]bool{}
	var out []float64
	for _, v := range raw {
		if v > maxKw+1e-9 {
			v = math.Round(maxKw*10) / 10
			if v > maxKw+1e-9 {
				v = maxKw
			}
		}
		if v <= 0 || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		out = []float64{math.Round(maxKw*10) / 10}
	}
	sort.Float64s(out)
	return out
}

// NextStepAbove returns the smallest ladder rung strictly greater than |kw|, or nil when
// none is larger (already at the top of the ladder). It lets the surface name the next
// larger step to try when a test lands but the battery did not move (Defect 2).
func NextStepAbove(steps []float64, kw float64) *float64 {
	m := math.Abs(kw)
	for _, v := range steps {
		if v > m+1e-9 {
			r := v
			return &r
		}
	}
	return nil
}

// ValidationError is a user-facing (German) calibration failure. The web layer
// maps it to HTTP 400; any other error is an internal 500 (the guards.
// SettingsValidationError precedent).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// ErrNotArmed / ErrBadMagnitude are the StartTest refusals (classifiable 400s).
// The Err*Evidence/Observed set are the Gap-B evidence-gate refusals for a TRUE
// sign/scale confirmation (report §7 Gap B): a confirmation may not be recorded
// until the SYSTEM has objectively observed a landed write + the measured movement.
var (
	ErrNotArmed         = &ValidationError{Msg: "Kalibriermodus ist nicht scharfgeschaltet."}
	ErrBadMagnitude     = &ValidationError{Msg: "ungültiger Testwert."}
	ErrNoTestYet        = &ValidationError{Msg: "Bitte führen Sie zuerst einen Testlauf durch."}
	ErrNoWriteEvidence  = &ValidationError{Msg: "Es liegt noch keine bestätigte Rückmeldung des Wechselrichters vor (geschrieben + zurückgelesen). Bitte einen Testlauf durchführen, bis die Register bestätigt sind."}
	ErrSignNotObserved  = &ValidationError{Msg: "Es wurde noch keine Batteriebewegung in die befohlene Richtung gemessen. Bitte testen, bis sich die Batterie sichtbar bewegt."}
	ErrScaleNotObserved = &ValidationError{Msg: "Die gemessene Batterieleistung passt noch nicht zum Sollwert. Bitte die Leistungsskalierung prüfen und erneut testen."}
	// ErrEvidenceExpired: the last test's confirmable result is older than ConfirmGrace
	// (Defect 1). The proof must be recent, so the operator runs a fresh test.
	ErrEvidenceExpired = &ValidationError{Msg: "Das letzte Testergebnis ist zu alt, um es zu bestätigen. Bitte einen neuen Testlauf durchführen."}
)

type testState struct {
	dir       Direction
	commandKw float64 // signed, already capped to [-MaxKw, +MaxKw]
	startedAt time.Time
	deadline  time.Time // startedAt + TTL, or the abort instant if earlier
	aborted   bool
	before    Reading

	// evidence is the captured confirmable verdict of THIS test (Defect 1): the best
	// (highest-scoring) attributable measured movement observed WHILE the command was
	// active, latched by ObserveReading. It survives the auto-revert so the operator
	// can confirm within ConfirmGrace, and is cleared when the test is replaced/aborted
	// or a correction lands. nil = no confirmable movement was ever observed.
	evidence      *VerdictResult
	evidenceAfter Reading   // the live reading at capture (supporting display)
	evidenceAt    time.Time // when captured; the ConfirmGrace clock starts here
}

// Session is the calibration state machine. It is NOT safe for concurrent use;
// the agent owns exactly one and guards it with a mutex.
type Session struct {
	cfg   Config
	armed bool
	test  *testState

	// Operator confirmations, session-scoped (persist across tests within a
	// commissioning session). Passed() == both true gates the certification step.
	// The agent resets them whenever a sign/scale CORRECTION is applied (a prior
	// confirmation is stale once the connection config changes).
	signConfirmed  bool
	scaleConfirmed bool

	// writeReadbackOK: a control WRITE for the CURRENT test completed with a FULL
	// register readback MATCH - the objective "the write landed" evidence the
	// confirm + certify gates require (report §7 Gap B). Set by NoteWriteReadback,
	// reset whenever the test changes (StartTest / Abort / ResetConfirmations), so a
	// certification can never precede a real, confirmed write for the current test.
	writeReadbackOK bool
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
	// A fresh test starts with NO landed-write evidence (report §7 Gap B): the
	// operator must observe a real write->readback for THIS test before confirming.
	// It also drops any prior operator confirmations - a new test must be re-verified
	// on its OWN readback + movement, so confirmations can never carry over onto a
	// different test (Defect 1: "a new test replaces the evidence").
	s.writeReadbackOK = false
	s.signConfirmed = false
	s.scaleConfirmed = false
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
	// The test was cancelled: its landed-write evidence no longer counts.
	s.writeReadbackOK = false
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

// ObserveReading latches a live reading as confirmation EVIDENCE for the current test
// (Defect 1). It captures the best (highest-scoring) attributable measured movement seen
// WHILE the command is active - so the proof survives the auto-revert to neutral and the
// operator can confirm it during ConfirmGrace. It only latches when: a test is live and
// not aborted; the write already read back a full match (writeReadbackOK, report §7 Gap
// B); the test is ACTIVE (only then is the measured movement attributable to the command);
// and the verdict is confirmable (a quiet baseline AND at least sign-or-scale OK). An
// equal-or-better later reading refreshes the capture, so the ConfirmGrace clock tracks
// the LAST good active reading (≈ the test end). The agent calls this before every
// snapshot and before a confirm, so a polling card latches the movement as it happens.
func (s *Session) ObserveReading(now time.Time, live Reading) {
	if s.test == nil || s.test.aborted || !s.writeReadbackOK {
		return
	}
	if s.Phase(now) != PhaseActive {
		return
	}
	v := Verdict(s.test.commandKw, s.test.before, live)
	// Only latch confirmable evidence from a legitimate SAME-DIRECTION movement: an
	// unattributable (busy baseline) reading, or an INVERTED-sign one (whose magnitude
	// might coincidentally match), proves nothing certifiable - the operator applies the
	// sign correction and re-tests.
	if v.BaselineBusy || v.SignInverted || (!v.SignOK && !v.MagnitudeOK) {
		return
	}
	if s.test.evidence == nil || confirmScore(v) >= confirmScore(*s.test.evidence) {
		vc := v
		s.test.evidence = &vc
		s.test.evidenceAfter = live
		s.test.evidenceAt = now
	}
}

// confirmScore counts how much a verdict proves (sign, magnitude), so ObserveReading
// keeps the reading that proves the MOST.
func confirmScore(v VerdictResult) int {
	n := 0
	if v.SignOK {
		n++
	}
	if v.MagnitudeOK {
		n++
	}
	return n
}

// evidenceValid reports whether the current test carries confirmable evidence that is
// still inside the ConfirmGrace window (and the test was not aborted).
func (s *Session) evidenceValid(now time.Time) bool {
	return s.test != nil && !s.test.aborted && s.test.evidence != nil &&
		now.Sub(s.test.evidenceAt) <= ConfirmGrace
}

// evidenceForConfirm returns the captured evidence to confirm against, or the specific
// refusal: no test (ErrNoTestYet), a test but no landed write (ErrNoWriteEvidence),
// a landed write but no attributable movement latched yet (nil,nil -> the caller maps
// it to sign/scale-not-observed), or an expired capture (ErrEvidenceExpired).
func (s *Session) evidenceForConfirm(now time.Time) (*VerdictResult, error) {
	if s.test == nil {
		return nil, ErrNoTestYet
	}
	if s.test.evidence == nil {
		if !s.writeReadbackOK {
			return nil, ErrNoWriteEvidence
		}
		return nil, nil // readback landed, but no confirmable movement observed (yet)
	}
	if now.Sub(s.test.evidenceAt) > ConfirmGrace {
		return nil, ErrEvidenceExpired
	}
	return s.test.evidence, nil
}

// ConfirmSign records the operator's sign confirmation. Setting it TRUE is GATED on
// OBJECTIVE, still-valid evidence for the CURRENT test (report §7 Gap B, Defect 1): the
// test's write read back a full register MATCH AND a MEASURED movement in the commanded
// direction was observed while active (Verdict.SignOK), and that capture is within
// ConfirmGrace. Without it a TRUE confirm is REFUSED. Clearing (ok=false) is always
// allowed. The evidence widens WHEN a confirmation may be made (past the ~2 s revert),
// never WHAT counts as evidence.
func (s *Session) ConfirmSign(ok bool, now time.Time) error {
	if !ok {
		s.signConfirmed = false
		return nil
	}
	ev, err := s.evidenceForConfirm(now)
	if err != nil {
		return err
	}
	if ev == nil || !ev.SignOK {
		return ErrSignNotObserved
	}
	s.signConfirmed = true
	return nil
}

// ConfirmScale records the operator's scale confirmation. Gated exactly like ConfirmSign
// but on Verdict.MagnitudeOK (the measured magnitude matches the commanded one).
func (s *Session) ConfirmScale(ok bool, now time.Time) error {
	if !ok {
		s.scaleConfirmed = false
		return nil
	}
	ev, err := s.evidenceForConfirm(now)
	if err != nil {
		return err
	}
	if ev == nil || !ev.MagnitudeOK {
		return ErrScaleNotObserved
	}
	s.scaleConfirmed = true
	return nil
}

// NoteWriteReadback records the result of the CURRENT test's control write->readback.
// A full-register match is the "the write landed" evidence the confirm + certify gates
// require; a mismatch revokes it. No-op when no test is live. The agent calls this from
// the calibration readback (source=="calibration", a real write - not a release).
func (s *Session) NoteWriteReadback(allMatch bool) {
	if s.test == nil {
		return
	}
	s.writeReadbackOK = allMatch
}

// ResetConfirmations clears both operator confirmations, the landed-write evidence AND
// the captured movement evidence (the agent calls this when a sign/scale correction is
// applied - a prior confirmation and its proof are then stale).
func (s *Session) ResetConfirmations() {
	s.signConfirmed = false
	s.scaleConfirmed = false
	s.writeReadbackOK = false
	if s.test != nil {
		s.test.evidence = nil
	}
}

// Passed reports whether the operator confirmed BOTH sign and scale - the gate the
// certification step requires ("Kalibrierung bestanden").
func (s *Session) Passed() bool { return s.signConfirmed && s.scaleConfirmed }

// CanCertify reports whether certification is allowed: BOTH confirmations pass AND the
// CURRENT test's write read back with a match (report §7 Gap B - a cert can never
// precede a real, confirmed write for the current test).
func (s *Session) CanCertify() bool { return s.Passed() && s.writeReadbackOK }

// Verdict cross-checks a commanded battery setpoint against the MEASURED battery
// power (the "hat die Batterie sich bewegt?" half). A ToU command sets the battery's
// ABSOLUTE power, so it judges the absolute measured value against the command - but
// ONLY when the battery was near-idle BEFORE the test (a quiet baseline), so the
// measured movement is actually attributable to the command and not to the battery's
// natural charging/discharging. An unquiet (or unknown) baseline yields BaselineBusy
// and NO confident sign/scale verdict. The raw before->after delta is kept as
// supporting context. Pure.
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
	// Attribution gate: the measured after-value only reflects the command from a
	// near-idle baseline. Without it (unknown baseline, or the battery already busy),
	// the battery's own activity would be mistaken for our small test's effect - the
	// exact fault behind the false "Richtung stimmt" the operator saw during a ~31 kW
	// PV-surplus charge. No confident verdict then - the operator retries when quiet.
	if before.BatteryKw == nil {
		v.BaselineBusy = true
		v.Text = "Basislinie unbekannt - bitte den Test erneut starten, damit die Batteriebewegung dem Befehl zugeordnet werden kann."
		return v
	}
	if math.Abs(*before.BatteryKw) > quietBaselineKw(commandKw) {
		v.BaselineBusy = true
		v.Text = "Basislinie zu unruhig: die Batterie war vor dem Test nicht in Ruhe. Bitte den Test wiederholen, wenn die Batterie ruhig ist."
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
	BaselineBusy bool     `json:"baseline_busy"` // battery was not near-idle before the test -> verdict not attributable
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
	// NextStepKw is the next larger ladder rung to suggest when this test landed but
	// the battery did not move (agent-set from the rated ladder); nil = already at the
	// top of the ladder.
	NextStepKw *float64 `json:"next_step_kw,omitempty"`
}

// Snapshot is the /api/calibration payload. The Session fills the pure fields; the
// agent decorates Available/Reason/ControlEnabled/Family/Certified before serving.
type Snapshot struct {
	Available      bool    `json:"available"` // a battery inverter is selected (agent-set)
	Reason         string  `json:"reason"`    // German note when unavailable/blocked (agent-set)
	Armed          bool    `json:"armed"`
	Phase          Phase   `json:"phase"`
	MaxKw          float64 `json:"max_kw"`
	TtlSeconds     int     `json:"ttl_seconds"`
	// RatedKw is the selected inverter's nameplate AC power in kW (agent-set; 0 =
	// unknown). TestSteps is the offered test-power ladder in kW, derived from RatedKw
	// (agent-set via TestStepsForRated). When RatedKw is 0 the ladder is the fixed
	// fallback and the surface says why.
	RatedKw   float64   `json:"rated_kw"`
	TestSteps []float64 `json:"test_steps"`
	ControlEnabled bool    `json:"control_enabled"` // global kill-switch on (agent-set)
	Family         string  `json:"family"`          // register-map family (agent-set)
	Certified      bool    `json:"certified"`       // already certified (agent-set)
	// The current WRITE-path sign / power scale on the inverter connection (agent-set),
	// so the correction UI shows what is set. PowerScale 0 = auto-detect.
	InvertControlSign bool    `json:"invert_control_sign"`
	PowerScale        float64 `json:"power_scale"`
	// InvertBattSign is the current READ-path battery sign on the connection (agent-set),
	// so the correction UI can show + toggle it when the MEASURED battery reads inverted
	// vs the cockpit (charge must be positive). Deye (solarman_v5) only.
	InvertBattSign bool `json:"invert_batt_sign"`

	SocPct            *float64 `json:"soc_pct"`
	BatteryKw         *float64 `json:"battery_kw"`
	ChargeTestable    bool     `json:"charge_testable"`
	DischargeTestable bool     `json:"discharge_testable"`

	Test *TestView `json:"test"`

	SignConfirmed  bool `json:"sign_confirmed"`
	ScaleConfirmed bool `json:"scale_confirmed"`
	Passed         bool `json:"passed"`

	// Gap-B evidence gates (report §7): whether the SYSTEM has objectively observed
	// enough to allow each action, so the card enables the boxes / the "freigeben"
	// button on these instead of on a manual tick. WriteReadbackOK = the current test's
	// write read back a full match; CanConfirmSign/Scale add the measured verdict;
	// CanCertify = both confirmations PLUS the write evidence for the current test.
	WriteReadbackOK bool `json:"write_readback_ok"`
	CanConfirmSign  bool `json:"can_confirm_sign"`
	CanConfirmScale bool `json:"can_confirm_scale"`
	CanCertify      bool `json:"can_certify"`

	// EvidenceValid reports that a FINISHED test's confirmable result is still inside
	// the ConfirmGrace window (Defect 1), so the displayed verdict is that captured
	// result (not the reverted live reading) and the confirm boxes stay enabled.
	// EvidenceAgeSeconds is how long ago it was captured, so the surface can say
	// "Ergebnis des letzten Tests (vor N s)".
	EvidenceValid      bool `json:"evidence_valid"`
	EvidenceAgeSeconds int  `json:"evidence_age_seconds"`
}

// Snapshot builds the pure calibration view at `now` given the live reading and
// the operating SoC band. Directions are testable when there is SoC headroom (or
// the SoC is unknown - the guard chain is the real bound). It also latches the live
// reading as confirmation evidence (ObserveReading), so a polling surface captures
// the measured movement while the test is active without a separate call (Defect 1).
func (s *Session) Snapshot(now time.Time, live Reading, band SocBand) Snapshot {
	s.ObserveReading(now, live)
	snap := Snapshot{
		Armed:           s.armed,
		Phase:           s.Phase(now),
		MaxKw:           s.cfg.MaxKw,
		TtlSeconds:      int(s.cfg.TTL / time.Second),
		SocPct:          live.SocPct,
		BatteryKw:       live.BatteryKw,
		SignConfirmed:   s.signConfirmed,
		ScaleConfirmed:  s.scaleConfirmed,
		Passed:          s.Passed(),
		WriteReadbackOK: s.writeReadbackOK,
		CanCertify:      s.CanCertify(),
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
		evValid := s.evidenceValid(now)
		// While ACTIVE the displayed verdict is the real-time live cross-check; after
		// the test ends we show the CAPTURED evidence (the finished test's result) for
		// the ConfirmGrace window, so the operator sees what was proven, not the
		// reverted-to-neutral live reading (Defect 1). Past the window it falls back to
		// the live verdict (which honestly reads "no movement").
		var v VerdictResult
		if phase == PhaseActive {
			v = Verdict(s.test.commandKw, s.test.before, live)
		} else if evValid {
			v = *s.test.evidence
		} else {
			v = Verdict(s.test.commandKw, s.test.before, live)
		}
		if evValid {
			snap.EvidenceValid = true
			if age := now.Sub(s.test.evidenceAt); age > 0 {
				snap.EvidenceAgeSeconds = int(age.Seconds())
			}
		}
		snap.Test = &TestView{
			Direction:   s.test.dir,
			CommandKw:   s.test.commandKw,
			StartedAt:   s.test.startedAt.UTC(),
			ExpiresAt:   s.test.deadline.UTC(),
			SecondsLeft: left,
			Phase:       phase,
			BeforeKw:    s.test.before.BatteryKw,
			Verdict:     v,
		}
		// The confirm boxes light up on the CAPTURED, still-valid evidence (report §7
		// Gap B, Defect 1) - a real readback-confirmed test with an observed movement -
		// so they stay enabled through the auto-revert, but only within ConfirmGrace and
		// never on a manual tick alone.
		if evValid {
			snap.CanConfirmSign = s.test.evidence.SignOK
			snap.CanConfirmScale = s.test.evidence.MagnitudeOK
		}
	}
	return snap
}
