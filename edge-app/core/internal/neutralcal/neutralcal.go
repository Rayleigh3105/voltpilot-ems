// Package neutralcal is the PURE First-Light state machine for MEASURING the
// Inverter-Neutral-Zeit T (docs/ota-autonomie.md §3): the ONE external fact
// OTA Stufe 3 needs and that, until now, only a bench session with a
// physically cut cable could produce.
//
// # What it measures, and why the mechanism must be exactly this
//
// While a component is being swapped, nobody refreshes the battery setpoint
// for a few seconds. Should the swapped component hang, the ONLY remaining
// backstop is the inverter itself: it falls back to neutral (0 kW) on its own
// after its Kommunikations-Verlust-Zeit T. The autonomous watchdog deadline
// must therefore sit STRICTLY under T (otaapply.WatchdogDeadline) - and until
// this package, T was a number a human had to produce at a bench, cable in
// hand ("VP_OTA_NEUTRAL_VERIFIED=familie:sekunden").
//
// T is a MEASURABLE property of the real device, so this package runs the
// same measurement AT THE BOX, under the SAME safety discipline every other
// First-Light test here already follows (internal/calibration,
// internal/curtailcal):
//
//  1. command a small, clearly non-neutral battery setpoint (magnitude
//     deliberately tiny - the point is DETECTABILITY, not power) and refresh
//     it like a normal control write, until a register readback CONFIRMS it
//     landed and the MEASURED battery power confirms the plant actually left
//     neutral (an "already neutral" test proves nothing - see below);
//  2. THEN GO COMPLETELY SILENT on the write channel - no more publishes at
//     all, not even a neutral release. This is the one and only mechanism:
//     `edge/setpoint` is a RETAINED message that Layer 1 acts on when a NEW
//     one arrives, so withholding a new message is indistinguishable, from
//     the inverter's point of view, from a hung software component;
//  3. watch the NORMAL telemetry read path - which keeps running unchanged,
//     nothing about it is stopped - for the inverter's own timeout to fall
//     the battery back to neutral, and report the elapsed time from the last
//     write to the confirmed return.
//
// This is a SOFTWARE approximation of the manual bench procedure
// (docs/ota-autonomie.md §3.2 has the operator physically cut the cable). It
// cannot prove the inverter's behaviour under an ACTUAL comms break (a
// crashed logger, a severed cable) - only under "nothing chooses to write
// anymore", which is exactly the failure mode OTA Stufe 3 needs to survive.
// The Note on every recorded evidence says so.
//
// # The proof must be as strict as the curtailment First-Light (report the
// two live false positives that hardened curtailcal - internal/curtailcal's
// package doc): a SINGLE in-band reading is not proof, an unconfirmed write is
// not proof, and an "already neutral" run is not proof of anything about T -
// it is a failure to depart in the first place. So:
//
//   - the departure itself must be OBSERVED (DepartureSamples consecutive
//     fresh, register-backed readings clearly outside the neutral band)
//     before the silent phase even begins - a test whose commanded departure
//     was clamped away by SoC bounds, a peak guard or anything else must
//     never be scored as "fast T";
//   - the return must be OBSERVED (SettleSamples consecutive FRESH readings
//     inside the neutral band) - a single sample crossing the band is noise,
//     not proof of settling;
//   - a run that cannot prove EITHER half reports why in plain German
//     (VerdictUnprovable) rather than a fabricated number, and a run that
//     simply times out without an excuse reports VerdictNoProof, inviting a
//     repeat - NEVER a number is recorded for anything but VerdictPassed.
//
// # T is reported CONSERVATIVELY, never optimistically
//
// The measured value feeds directly into otaapply.WatchdogDeadline, which
// caps a swap's grace period STRICTLY under T. Overstating T is therefore the
// dangerous direction: a deadline computed from an inflated T could exceed
// the REAL fallback time and leave the battery holding a stale command longer
// than any watchdog defends against. This package resolves that by anchoring
// the reported duration on the LAST reading it can still PROVE was away from
// neutral (Test.lastAwayAt), never on the first reading that happened to look
// settled - see measuredSeconds. A run with no such anchor (the very first
// silent-phase sample already looked neutral) conservatively reports ~0 s,
// which simply fails NeutralSupportsWatchdog downstream rather than lying.
//
// # Safety, matching every other physical-control surface in this codebase
//
//   - explicit start required, ONE test at a time (Start refuses while
//     another is running);
//   - HARD, bounded duration on BOTH halves: DepartureTimeout bounds the
//     active (writing) phase so a test that clearly is not going to depart
//     never keeps writing for the whole window, and the overall TTL bounds
//     the silent observation - past either, the test concludes and (via the
//     agent, which owns the write path) control resumes on the very next
//     setpoint tick;
//   - abortable at any time (Abort), and an aborted run's evidence is NEVER
//     valid - it may have ended mid-departure, proving nothing;
//   - it NEVER touches a guard limit and never widens any authority: the
//     agent still runs every commanded value (including the tiny test
//     departure) through the SAME guard chain every other setpoint gets.
//
// This package holds NO I/O and NO wall-clock reads: every method that
// depends on time takes `now`, so the whole envelope is deterministically
// testable offline. The agent (agent/neutral.go) wires it to the guard chain,
// the edge/setpoint publish (or its deliberate absence), the control readback
// and the persisted per-family evidence file that otaapply.NeutralTable
// consults alongside the operator's VP_OTA_NEUTRAL_VERIFIED.
package neutralcal

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// ValidationError carries an operator-facing German message; the web layer
// maps it to HTTP 400 (mirrors calibration.ValidationError / curtailcal's).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

const (
	// DefaultTTL bounds the WHOLE test (active departure phase + silent
	// observation). Generous enough that a genuinely slow-to-fall-back
	// inverter still gets measured, short enough that a forgotten test hands
	// control back well within a few minutes.
	DefaultTTL = 6 * time.Minute

	// DepartureTimeout bounds the ACTIVE (still writing) phase on its own: if
	// the commanded departure is not confirmed within it, the run concludes
	// early instead of writing a small forced setpoint for the whole TTL when
	// it is already clear nothing is departing (SoC bounds, another guard, an
	// unresponsive device). The silent observation, once departure DOES land,
	// still gets the remainder of DefaultTTL.
	DepartureTimeout = 90 * time.Second

	// ConfirmGrace keeps a concluded test's evidence confirmable afterwards
	// (the curtailcal/calibration precedent), so the operator has time to
	// read the result and, on a pass, record it.
	ConfirmGrace = 3 * time.Minute

	// TestKw is the commanded departure from neutral. Fixed and deliberately
	// SMALL ("Betrag bewusst niedrig - es geht um Erkennbarkeit, nicht um
	// Leistung"): this test is never about magnitude, only about whether the
	// inverter keeps executing ANY non-neutral command once nothing refreshes
	// it. Still guard-clamped like every other setpoint, so it can never
	// exceed the device's real limits regardless of this constant.
	TestKw = 0.5

	// NeutralBandKw is the tolerance around 0 kW within which a measured
	// battery reading counts as "neutral" - wide enough to absorb BMS/
	// measurement noise, narrow enough that TestKw clearly sits outside it.
	NeutralBandKw = 0.15

	// DepartureMargin: a reading must clear the neutral band by at least this
	// much to count as a CONFIRMED departure - the same "the margin IS the
	// proof" discipline as curtailcal's ambientMargin. A reading landing
	// right at the edge of the band proves nothing.
	DepartureMargin = 0.15

	// DepartureSamples/SettleSamples: consecutive FRESH readings required to
	// confirm, respectively, that the commanded departure really moved the
	// battery and that it later returned to neutral. A single sample could be
	// noise or a momentary crossing - the curtailcal PlateauSamples
	// precedent.
	DepartureSamples = 2
	SettleSamples    = 3

	// ReadingFresh bounds how old a measurement may be to still count as
	// "current" for either proof. A stale reading proves nothing about NOW -
	// it degrades a run to VerdictUnprovable ("es fehlen Messwerte") rather
	// than silently accepting old data.
	ReadingFresh = 30 * time.Second

	// RegisterHoldFresh: a register confirmation older than this no longer
	// counts as "the departure is currently in force" (curtailcal
	// precedent) - a stray old confirmation can never gate departure samples
	// taken long after the command may have been overwritten or expired.
	RegisterHoldFresh = 45 * time.Second
)

// Verdict values of the most recent test (operator-facing, machine-readable -
// the same vocabulary shape as curtailcal.Verdict*).
const (
	VerdictRunning    = "laeuft"          // still measuring
	VerdictPassed     = "bestanden"       // departure confirmed AND the return to neutral was observed
	VerdictUnprovable = "nicht_beweisbar" // no departure ever confirmed, or readings went missing - a statement about the run, not about T
	VerdictNoProof    = "kein_nachweis"   // register never confirmed, or it never settled within the window - repeat
)

// Phase describes what a test is doing right now.
type Phase string

const (
	// PhaseIdle: no test is running for this family (never started, or a
	// previous one has fully concluded past its grace window).
	PhaseIdle Phase = "idle"
	// PhaseActive: the small departure is being commanded and refreshed,
	// waiting for the register + measurement to confirm it landed.
	PhaseActive Phase = "aktiv"
	// PhaseSilent: departure confirmed - NOTHING is being written anymore,
	// and the return to neutral is being watched via the normal read path.
	PhaseSilent Phase = "still"
	// PhaseDone: the test has concluded (deadline, early departure timeout,
	// a confirmed return, or an abort). Its evidence may still be valid
	// (ConfirmGrace); a fresh Start begins a new one.
	PhaseDone Phase = "beendet"
)

// Test is one bounded measurement on one family.
type Test struct {
	Family    string
	TestKw    float64
	StartedAt time.Time
	Deadline  time.Time

	// RegisterConfirmed latches once a readback during the ACTIVE phase
	// confirmed the commanded departure landed (sticky, like curtailcal's
	// field of the same name).
	RegisterConfirmed bool
	registerHeldAt    time.Time
	departureRun      int

	// departed latches once the departure was CONFIRMED (register held AND
	// DepartureSamples consecutive fresh, clearly-away readings) - the phase
	// boundary between active and silent.
	departed bool
	// lastWriteAt is the timestamp of the LAST actual publish while active -
	// the clock T is measured from ("Gemessen wird die Zeit vom letzten
	// Schreiben..."). Frozen the moment the phase flips to silent, because
	// nothing publishes (and therefore calls NoteWrite) after that.
	lastWriteAt time.Time

	// settleRun/settleBest count consecutive FRESH in-band readings during
	// the silent phase. settledAt latches the instant SettleSamples was first
	// reached (for the confirm-grace anchor).
	settleRun, settleBest int
	settledAt             time.Time

	// lastAwayAt is the CONSERVATIVE anchor for the reported T: the last
	// moment, during the silent phase, a fresh reading is KNOWN to still be
	// outside the neutral band. See the package doc "T is reported
	// conservatively". Zero until at least one such reading arrives.
	lastAwayAt time.Time

	// lastReadingAt is the freshness anchor used to detect "no current
	// measurements at all" (regardless of phase).
	lastReadingAt time.Time

	aborted bool
}

// boundary is the instant this test's active/silent run concludes on its
// own, absent a confirmed pass or an abort: DepartureTimeout while it has not
// yet departed (never leave a non-landing test writing for the whole TTL),
// else the full Deadline.
func (t *Test) boundary() time.Time {
	if !t.departed {
		if dt := t.StartedAt.Add(DepartureTimeout); dt.Before(t.Deadline) {
			return dt
		}
	}
	return t.Deadline
}

// ended reports whether the test's run is over (deadline/early-timeout
// reached, or aborted) - the point past which Observe/NoteWrite/NoteRegister
// stop having any effect. It does NOT depend on the verdict: a test that has
// already confirmed its return (settled) is also "ended" via this check
// because boundary() only matters once nothing MORE can happen - Passed is
// decided independently in verdictOf, which is checked before this.
func (t *Test) ended(now time.Time) bool {
	return t.aborted || !now.Before(t.boundary())
}

// Session holds at most ONE running/recent test (one operator, one bench
// step at a time - the calibration/curtailcal precedent).
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

// TTL returns the configured overall test duration.
func (s *Session) TTL() time.Duration { return s.ttl }

// activeTest returns the running (not aborted, not past its boundary) test.
func (s *Session) activeTest(now time.Time) *Test {
	if s.test == nil || s.test.ended(now) {
		return nil
	}
	return s.test
}

// Active reports whether a test is currently running for ANY family.
func (s *Session) Active(now time.Time) bool { return s.activeTest(now) != nil }

// ActiveFamily returns the family of the running test, or "" if none.
func (s *Session) ActiveFamily(now time.Time) string {
	if t := s.activeTest(now); t != nil {
		return t.Family
	}
	return ""
}

// RemainingSeconds is how long, DISPLAY-ONLY, until `family`'s running test
// concludes on its own (the tighter departure-timeout boundary while it has
// not yet departed, else the overall TTL). 0 when nothing is running for
// this family.
func (s *Session) RemainingSeconds(family string, now time.Time) int {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.activeTest(now)
	if t == nil || t.Family != fam {
		return 0
	}
	d := t.boundary().Sub(now)
	if d < 0 {
		return 0
	}
	return int(d / time.Second)
}

// Start begins a bounded test on `family`. Refused while another test is
// running (one at a time) or while no family is selected - a test without a
// chosen inverter cannot know what it is measuring.
func (s *Session) Start(family string, now time.Time) (float64, error) {
	fam := strings.ToLower(strings.TrimSpace(family))
	if fam == "" {
		return 0, invalid("Es ist kein Wechselrichter ausgewählt - ein Neutral-Zeit-Test ist nicht möglich.")
	}
	if t := s.activeTest(now); t != nil {
		return 0, invalid("Es läuft bereits ein Neutral-Zeit-Test (%s). Bitte warten oder abbrechen.", t.Family)
	}
	s.test = &Test{
		Family:    fam,
		TestKw:    TestKw,
		StartedAt: now,
		Deadline:  now.Add(s.ttl),
	}
	return TestKw, nil
}

// Abort ends the running test immediately AND invalidates its evidence - a
// run that stopped mid-departure or mid-observation proves nothing about T.
func (s *Session) Abort(now time.Time) {
	if s.test != nil {
		s.test.aborted = true
	}
}

// Phase reports what the test for `family` is doing right now. PhaseIdle when
// no test (ever, or currently) belongs to this family.
func (s *Session) Phase(family string, now time.Time) Phase {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.test
	if t == nil || t.Family != fam {
		return PhaseIdle
	}
	if t.aborted || t.ended(now) {
		return PhaseDone
	}
	if t.departed {
		return PhaseSilent
	}
	return PhaseActive
}

// Command returns the setpoint to publish for `family`, and whether the
// agent should publish ANYTHING at all this tick. false in every phase but
// PhaseActive - going completely silent (never even a neutral release) is the
// entire mechanism of this test, see the package doc.
func (s *Session) Command(family string, now time.Time) (kw float64, publish bool) {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.activeTest(now)
	if t == nil || t.Family != fam || t.departed {
		return 0, false
	}
	return t.TestKw, true
}

// NoteWrite records that the agent ACTUALLY published the active-phase
// command just now - the "last write" instant T is measured from. Calling it
// outside the active phase (or for a different/absent test) is a no-op.
func (s *Session) NoteWrite(family string, now time.Time) {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.activeTest(now)
	if t == nil || t.Family != fam || t.departed {
		return
	}
	t.lastWriteAt = now
}

// NoteRegister records a readback verdict for the active test's family:
// `held` is the semantic verdict that the commanded departure register
// currently reads back as commanded (matches curtailcal.NoteRegister /
// calibration's write-readback check - never a raw value comparison, that is
// Layer 1's job). A confirmed readback latches RegisterConfirmed and stamps
// the current hold (which gates departure samples); a deviating one drops the
// hold and resets the departure run - the departure was not, in fact, in
// force.
func (s *Session) NoteRegister(family string, held bool, now time.Time) {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.activeTest(now)
	if t == nil || t.Family != fam {
		return
	}
	if held {
		t.RegisterConfirmed = true
		t.registerHeldAt = now
		return
	}
	t.registerHeldAt = time.Time{}
	t.departureRun = 0
}

// Observe feeds ONE fresh measured battery-power reading (+ charge/-
// discharge). It is called from the NORMAL telemetry read path, which keeps
// running unchanged for the whole test - this is the entire point: the
// mechanism withholds WRITES, never reads.
func (s *Session) Observe(family string, batteryKw float64, now time.Time) {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.activeTest(now)
	if t == nil || t.Family != fam || math.IsNaN(batteryKw) || math.IsInf(batteryKw, 0) {
		return
	}
	t.lastReadingAt = now
	inBand := math.Abs(batteryKw) <= NeutralBandKw

	if !t.departed {
		// ACTIVE phase: the departure must be CONFIRMED - register-backed
		// (fresh, i.e. the command is demonstrably still in force right now)
		// AND clearly outside the neutral band, for DepartureSamples
		// consecutive readings. A test whose commanded value never actually
		// moved the battery (clamped away by SoC/another guard, or a device
		// that silently ignores it) must never be scored as "instant T" -
		// that is exactly the "already neutral" unprovable case.
		if t.registerHeldAt.IsZero() || now.Sub(t.registerHeldAt) > RegisterHoldFresh {
			t.departureRun = 0
			return
		}
		if math.Abs(batteryKw) >= NeutralBandKw+DepartureMargin {
			t.departureRun++
			if t.departureRun >= DepartureSamples {
				t.departed = true
				// lastWriteAt already holds the last active-phase publish
				// (NoteWrite) - the clock now stops advancing since nothing
				// more will be written.
			}
		} else {
			t.departureRun = 0
		}
		return
	}

	// SILENT phase: watch for the confirmed, sustained return to neutral.
	if inBand {
		t.settleRun++
		if t.settleRun > t.settleBest {
			t.settleBest = t.settleRun
		}
		if t.settleBest >= SettleSamples && t.settledAt.IsZero() {
			t.settledAt = now
		}
	} else {
		t.settleRun = 0
		// The CONSERVATIVE anchor for T: the last moment we KNOW for certain
		// the inverter was still away from neutral. The true fallback instant
		// lies somewhere between this reading and the first of the
		// eventually-confirmed streak; reporting the EARLIER bound guarantees
		// the measured T never OVERSTATES reality - see measuredSeconds and
		// the package doc.
		t.lastAwayAt = now
	}
}

// CanRecord reports whether the current evidence for `family` may be
// persisted as a belegtes T ("Als Nachweis übernehmen"): valid, and the
// verdict is a genuine Pass with a measured duration. Every other verdict -
// including VerdictUnprovable - can never record a number.
func (s *Session) CanRecord(family string, now time.Time) bool {
	ev := s.EvidenceFor(family, now)
	return ev != nil && ev.Valid && ev.Verdict == VerdictPassed && ev.MeasuredSeconds != nil
}

// Evidence is the confirmable outcome of the most recent test for a family.
type Evidence struct {
	Valid  bool    `json:"valid"`
	Family string  `json:"family"`
	TestKw float64 `json:"test_kw"`

	RegisterConfirmed  bool `json:"register_confirmed"`
	DepartureConfirmed bool `json:"departure_confirmed"`

	// SettleSamples/SettleRequired: the live/final progress of the return-to-
	// neutral proof.
	SettleSamples  int `json:"settle_samples"`
	SettleRequired int `json:"settle_required"`

	// MeasuredSeconds is set ONLY on VerdictPassed - "ein nicht beweisbarer
	// Lauf trägt NIE eine Zahl ein" (the task's own words). nil everywhere
	// else, never a fabricated 0.
	MeasuredSeconds *int `json:"measured_seconds,omitempty"`

	Verdict string `json:"verdict"`
	Reason  string `json:"reason,omitempty"`

	// AgeSeconds since the test CONCLUDED (0 while still running).
	AgeSeconds int `json:"age_seconds"`
	// ExpiresInSeconds until the grace window closes (0 = expired).
	ExpiresInSeconds int `json:"expires_in_seconds"`
}

// EvidenceFor returns the confirmable evidence for `family`: valid while the
// test runs and for ConfirmGrace after it concludes; an aborted test is NEVER
// valid (it may have ended mid-proof). A test for a DIFFERENT family, or no
// test at all, yields nil.
func (s *Session) EvidenceFor(family string, now time.Time) *Evidence {
	fam := strings.ToLower(strings.TrimSpace(family))
	t := s.test
	if t == nil || t.Family != fam || t.aborted {
		return nil
	}
	concluded := t.boundary()
	if !t.settledAt.IsZero() && t.settledAt.Before(concluded) {
		concluded = t.settledAt
	}
	expiry := concluded.Add(ConfirmGrace)
	ev := &Evidence{
		Family:             t.Family,
		TestKw:             t.TestKw,
		RegisterConfirmed:  t.RegisterConfirmed,
		DepartureConfirmed: t.departed,
		SettleSamples:      t.settleBest,
		SettleRequired:     SettleSamples,
	}
	if now.After(concluded) {
		ev.AgeSeconds = int(now.Sub(concluded) / time.Second)
	}
	if now.Before(expiry) {
		ev.Valid = true
		ev.ExpiresInSeconds = int(expiry.Sub(now) / time.Second)
	}
	ev.Verdict, ev.Reason, ev.MeasuredSeconds = verdictOf(t, now)
	return ev
}

// verdictOf turns the collected facts into the honest outcome + its German
// reason (+ the measured seconds, ONLY on a Pass). The ORDER matters, exactly
// like curtailcal.verdictOf: a proven return beats everything (it can
// conclude before the boundary), then "still running", then the specific
// causes for why nothing could be proven.
func verdictOf(t *Test, now time.Time) (verdict, reason string, measuredSecs *int) {
	if t.departed && t.RegisterConfirmed && t.settleBest >= SettleSamples {
		secs := measuredSeconds(t)
		return VerdictPassed, "", &secs
	}
	if now.Before(t.boundary()) {
		return VerdictRunning, "", nil
	}
	if !t.RegisterConfirmed {
		return VerdictNoProof, "Der Wechselrichter hat den Testwert nie bestätigt - der Befehl kam nicht an oder wurde überschrieben.", nil
	}
	if !t.departed {
		return VerdictUnprovable, "Die Anlage hat sich beim Testwert nicht messbar von neutral entfernt - vermutlich verhindert eine andere Begrenzung (z. B. der SoC-Bereich) den Test, oder sie war ohnehin neutral. Nicht beweisbar.", nil
	}
	if t.lastReadingAt.IsZero() || now.Sub(t.lastReadingAt) > ReadingFresh {
		return VerdictUnprovable, "Es liegen keine aktuellen Messwerte vor - die Rückkehr nach neutral konnte nicht beobachtet werden.", nil
	}
	return VerdictNoProof, fmt.Sprintf(
		"Die Leistung ist nicht ins Neutralband zurückgekehrt (%d von %d Messwerten in Folge). "+
			"Bitte wiederholen.", t.settleBest, SettleSamples), nil
}

// measuredSeconds is the CONSERVATIVE T for a Passed test: measured from the
// last write to the last reading STILL KNOWN to be away from neutral
// (lastAwayAt), never to the first reading that happened to already look
// settled. Without such a reading (the very first silent-phase sample was
// already in-band - an extremely fast fallback our sampling could not bound
// more tightly) the conservative floor is the write instant itself, i.e. 0 s -
// safe (never overstates T) though not very informative; see the package doc.
func measuredSeconds(t *Test) int {
	anchor := t.lastWriteAt
	if !t.lastAwayAt.IsZero() {
		anchor = t.lastAwayAt
	}
	d := anchor.Sub(t.lastWriteAt)
	if d < 0 {
		d = 0
	}
	return int(d / time.Second)
}

// --- the web-facing view (assembled by the agent) ---------------------------

// TestView is the running (or just-concluded) test, rendered.
type TestView struct {
	Family             string   `json:"family"`
	TestKw             float64  `json:"test_kw"`
	Phase              Phase    `json:"phase"`
	SecondsRemaining   int      `json:"seconds_remaining"`
	RegisterConfirmed  bool     `json:"register_confirmed"`
	DepartureConfirmed bool     `json:"departure_confirmed"`
	SettleSamples      int      `json:"settle_samples"`
	SettleRequired     int      `json:"settle_required"`
	LiveBatteryKw      *float64 `json:"live_battery_kw,omitempty"`
}

// View is the GET /api/neutral payload.
type View struct {
	Available               bool    `json:"available"`
	Reason                  string  `json:"reason,omitempty"`
	ControlEnabled          bool    `json:"control_enabled"`
	AdminGate               bool    `json:"admin_gate"`
	Family                  string  `json:"family,omitempty"`
	TestKw                  float64 `json:"test_kw"`
	TestTTLSeconds          int     `json:"test_ttl_seconds"`
	DepartureTimeoutSeconds int     `json:"departure_timeout_seconds"`

	LiveBatteryKw *float64  `json:"live_battery_kw,omitempty"`
	Test          *TestView `json:"test,omitempty"`
	Evidence      *Evidence `json:"evidence,omitempty"`
	CanRecord     bool      `json:"can_record"`

	// Recorded is the persisted per-family evidence this device already
	// carries (nil = never measured/recorded on this device).
	Recorded *RecordedView `json:"recorded,omitempty"`
}

// RecordedView is the persisted, belegte Neutral-Zeit for the CURRENT family
// (the agent reads it from the otaapply evidence file - this package knows
// nothing about files, only about rendering the fact).
type RecordedView struct {
	Seconds    int    `json:"seconds"`
	MeasuredAt string `json:"measured_at"`
}
