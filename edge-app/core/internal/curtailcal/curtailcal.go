// Package curtailcal is the PURE First-Light state machine for CURTAILMENT
// certification of a SunSpec PV unit (a fronius_sunspec Erzeuger source): the
// bounded, auto-reverting test that proves - per physical inverter - that a
// Model-123 WMaxLimPct write is (a) accepted (register readback confirms) and
// (b) ENFORCED (the measured AC power is actually CLAMPED AT the commanded
// cap). The (b) half is what makes this gate meaningful on Fronius at all:
// Modbus is the LOWEST control priority there, so a confirmed register alone
// proves nothing - a local setting, Solar.web or a Smart-Meter rule can
// silently override it.
//
// THE CLAMP PROOF (hardened 2026-08-06 after two live FALSE POSITIVES at
// Pilsting). The first rule was "the measured minimum fell to or below the
// cap" - and a passing cloud does exactly that:
//
//	cap 17,4 kW -> measured 12,9 kW   "passed"
//	cap  9,7 kW -> measured  9,5 kW   "passed"
//
// Both were the WEATHER: the sibling inverter on the same roof held its usual
// ratio (WR2 ~ 0,82 x WR1) before AND after, so the whole plant simply had
// less sun. A real cap does not push the power BELOW itself - it CLAMPS it AT
// itself and HOLDS it there. Below the cap only the sun pushes. So the proof
// is now a PLATEAU:
//
//	PlateauSamples consecutive fresh readings within a tolerance band AROUND
//	the cap, WHILE the register is demonstrably still holding the commanded
//	value, AND while the AMBIENT (unthrottled) output would be clearly ABOVE
//	the cap.
//
// The ambient estimate is what tells the cap apart from the cloud:
//
//   - with a SIBLING unit at the same site (the Pilsting WR1/WR2 case) the
//     ratio captured at test start is carried forward: ambient(t) =
//     ref(t) * (before / refBefore). If only the tested unit drops to the cap
//     level and STAYS there while the reference keeps its share, that is the
//     cap; if both fall proportionally, that is the cloud.
//   - without a sibling the unit's OWN pre-test output is the (conservative)
//     estimate, which is why the test refuses to start unless the live output
//     is clearly ABOVE the cap (MinPvKw + the TestFraction headroom). It is
//     backed by a PHYSICAL floor that needs no reference at all: a cap can
//     only ever REDUCE, so a measured power clearly BELOW the cap band proves
//     the cap is not what binds and the ambient IS that value.
//
// If the ambient sinks to or below the cap the honest verdict is
// "nicht beweisbar" (VerdictUnprovable) - NEVER "bestanden": the test simply
// cannot prove anything in that weather and must be repeated.
//
// Mirrors internal/calibration's discipline (the battery First-Light):
//   - no I/O, every time-dependent method takes `now` (deterministic tests);
//   - the test is BOUNDED (cap = TestFraction of the CURRENT measured output,
//     refused below MinPvKw where a drop would be indistinguishable from
//     noise) and TTL-limited - the agent's watchdog plus the inverter's own
//     native WMaxLimPct_RvrtTms revert it, never the operator's attention;
//   - evidence stays confirmable for ConfirmGrace after the test ends (the
//     fm/vp-calib-ux-t6 grace rule: the clamp is a fact about the device, not
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
	// observe the plateau, short enough that a forgotten test is gone before
	// the operator's coffee is.
	//
	// THE CHAIN: the executor's refresh (20 s, sunspec/curtail.js REFRESH_MS)
	// < the inverter's native revert timer (60 s, DEFAULT_RVRT_TMS) < this
	// TTL. A live test therefore never reverts on schedule half way through,
	// while a DEAD executor still hands the plant back within a minute.
	DefaultTTL = 120 * time.Second
	// ConfirmGrace keeps a completed test's evidence confirmable after the
	// auto-revert (the battery First-Light grace rule).
	ConfirmGrace = 3 * time.Minute
	// TestFraction: the test cap is 80 % of the CURRENT measured output - a
	// clearly visible, clearly bounded reduction. The 20 % headroom is also
	// the ambient margin the clamp proof needs (see ambientMargin).
	TestFraction = 0.8
	// MinPvKw refuses a test while the unit produces too little for the clamp
	// to be distinguishable from cloud noise (the evidence would be worthless).
	MinPvKw = 5.0

	// PlateauSamples is how many CONSECUTIVE in-band readings make a plateau.
	// At the ~5 s source cadence that is ~15 s of the power sitting AT the cap
	// - long enough that a cloud edge crossing the band cannot fake it, short
	// enough to fit several times into the 120-s TTL.
	PlateauSamples = 3
	// RegisterHoldFresh: a register confirmation older than this no longer
	// counts as "the cap is currently in force" (kept well under the 60-s
	// native revert timer, so an un-refreshed command can never keep
	// collecting plateau evidence).
	RegisterHoldFresh = 45 * time.Second
	// AmbientRefFresh: a reference-unit reading older than this is unusable -
	// the ambient estimate then falls back to the tested unit's own pre-test
	// value rather than trusting a stale sibling.
	AmbientRefFresh = 60 * time.Second
)

// Verdict values of the most recent test (operator-facing, machine-readable).
const (
	VerdictRunning    = "laeuft"          // still collecting evidence
	VerdictPassed     = "bestanden"       // register held AND the clamp plateau was observed
	VerdictUnprovable = "nicht_beweisbar" // the ambient sank to/below the cap - the weather, not the cap
	VerdictNoProof    = "kein_nachweis"   // no plateau and no ambient excuse: repeat the test
)

// plateauTolerance is the band around the cap within which a reading counts as
// "sitting AT the cap" (ramp jitter / measurement noise / scale rounding).
func plateauTolerance(capKw float64) float64 {
	return math.Max(0.5, 0.05*capKw)
}

// ambientMargin is how far ABOVE the cap the estimated unthrottled output must
// be for a reading to prove anything. Below that the sun alone could produce
// the observed value, so the test is "nicht beweisbar" rather than passed.
func ambientMargin(capKw float64) float64 {
	return math.Max(1.0, 0.1*capKw)
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
	// MinObservedKw tracks the lowest measured output seen during the test.
	// Informative only since the plateau proof - a minimum BELOW the cap is
	// exactly what a cloud produces. nil = no reading yet.
	MinObservedKw *float64

	// registerHeldAt is the last time a readback confirmed the commanded
	// registers. Zero = the cap is not currently proven to be in force.
	registerHeldAt time.Time

	// plateauRun counts the CONSECUTIVE in-band, register-backed, ambient-
	// backed readings; plateauBest keeps the longest run seen.
	plateauRun  int
	plateauBest int

	// ambientBelowCap latches once the estimated unthrottled output sank to or
	// below the cap band: from then on nothing observed can prove the cap.
	ambientBelowCap bool
	lastAmbientKw   *float64

	// The AMBIENT REFERENCE: a sibling unit at the same site, captured at
	// start together with the ratio between the two. refPvKw/refAt are its
	// latest reading.
	refSourceID string
	refBeforeKw float64
	refPvKw     *float64
	refAt       time.Time

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
	// ClampObserved: the measured output sat AT the cap for PlateauSamples
	// consecutive readings while the register held it and the ambient was
	// clearly above - the ENFORCEMENT proof. Replaces the old "fell below the
	// cap" rule, which a passing cloud satisfied (two live false positives).
	ClampObserved bool `json:"clamp_observed"`
	// PlateauSamples/PlateauRequired render the progress of that proof.
	PlateauSamples  int `json:"plateau_samples"`
	PlateauRequired int `json:"plateau_required"`
	// AmbientKw is the latest estimate of what this unit WOULD produce
	// unthrottled; AmbientSource names where it came from ("" = the unit's own
	// pre-test value, otherwise the reference source id).
	AmbientKw     *float64 `json:"ambient_kw,omitempty"`
	AmbientSource string   `json:"ambient_source,omitempty"`
	// Verdict + Reason: the honest outcome. VerdictUnprovable is NOT a
	// failure of the inverter - it is a failure of the weather.
	Verdict string `json:"verdict"`
	Reason  string `json:"reason,omitempty"`
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
//
// refs carries the CURRENT fresh output of the site's OTHER curtailment units;
// the strongest one becomes the AMBIENT REFERENCE, so a cloud that dims the
// whole roof can be told apart from a cap that only dims this unit. Without a
// usable sibling the unit's own pre-test output is the (conservative)
// reference - the plateau requirement plus the headroom below carry the proof.
func (s *Session) Start(sourceID, unitKey string, measuredKw float64, refs map[string]float64, now time.Time) (float64, error) {
	if t := s.activeTest(now); t != nil {
		return 0, invalid("Es läuft bereits ein Abregelungs-Test (%s). Bitte warten oder abbrechen.", t.SourceID)
	}
	if math.IsNaN(measuredKw) || measuredKw < MinPvKw {
		return 0, invalid("Der Wechselrichter liefert gerade zu wenig Leistung für einen aussagekräftigen Test (mindestens %.0f kW). Bitte bei mehr Sonne erneut versuchen.", MinPvKw)
	}
	capKw := math.Round(measuredKw*TestFraction*10) / 10
	// The headroom IS the proof margin: without it a reading at the cap could
	// just as well be the ambient output and nothing is provable.
	if measuredKw-capKw < ambientMargin(capKw) {
		return 0, invalid("Die aktuelle Leistung liegt zu dicht an der Testbegrenzung - eine Wirkung wäre nicht von normalen Schwankungen zu unterscheiden. Bitte bei mehr Sonne erneut versuchen.")
	}
	t := &Test{
		SourceID:  sourceID,
		UnitKey:   unitKey,
		CapKw:     capKw,
		BeforeKw:  measuredKw,
		StartedAt: now,
		Deadline:  now.Add(s.ttl),
	}
	// Pick the strongest fresh sibling as the ambient reference; its ratio to
	// this unit is captured NOW, while this unit is still unthrottled.
	bestID, best := "", 0.0
	for id, kw := range refs {
		if id == sourceID || math.IsNaN(kw) || kw <= 0 {
			continue
		}
		if kw > best {
			bestID, best = id, kw
		}
	}
	if bestID != "" {
		t.refSourceID = bestID
		t.refBeforeKw = best
		v := best
		t.refPvKw = &v
		t.refAt = now
	}
	s.test = t
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

// ambientAt estimates what the unit under test WOULD produce unthrottled, and
// names the source of that estimate ("" = its own pre-test value).
func (t *Test) ambientAt(now time.Time) (float64, string) {
	if t.refSourceID != "" && t.refPvKw != nil && t.refBeforeKw > 0 &&
		!t.refAt.IsZero() && now.Sub(t.refAt) <= AmbientRefFresh {
		return *t.refPvKw * (t.BeforeKw / t.refBeforeKw), t.refSourceID
	}
	return t.BeforeKw, ""
}

// Observe feeds a measured output reading. It is called for EVERY curtailment
// source: the unit under test contributes plateau evidence, the ambient
// reference keeps the weather estimate current. Only readings DURING the
// active window count (after the revert the output legitimately recovers -
// that must not overwrite the evidence).
func (s *Session) Observe(sourceID string, measuredKw float64, now time.Time) {
	t := s.activeTest(now)
	if t == nil || math.IsNaN(measuredKw) {
		return
	}
	if sourceID == t.refSourceID {
		v := measuredKw
		t.refPvKw = &v
		t.refAt = now
		return
	}
	if sourceID != t.SourceID {
		return
	}
	if t.MinObservedKw == nil || measuredKw < *t.MinObservedKw {
		v := measuredKw
		t.MinObservedKw = &v
	}

	tol := plateauTolerance(t.CapKw)
	ambient, _ := t.ambientAt(now)
	// THE PHYSICAL FLOOR, and the half that works without any sibling: a cap
	// can only ever REDUCE, so a power clearly BELOW the cap band proves the
	// cap is not what binds - the available (ambient) output IS this value.
	// That is exactly the first live false positive (cap 17,4 -> measured
	// 12,9): the estimate from before the test still said 21,75, the meter
	// said the sun had gone.
	if measuredKw < t.CapKw-tol {
		ambient = measuredKw
	}
	a := ambient
	t.lastAmbientKw = &a

	// The cap must be what BINDS: if the unthrottled estimate itself is at or
	// below the cap band, nothing observed here can prove a cap.
	if ambient <= t.CapKw+ambientMargin(t.CapKw) {
		t.ambientBelowCap = true
		t.plateauRun = 0
		return
	}
	// The register must be demonstrably holding the commanded value RIGHT NOW
	// - a plateau under an expired/overwritten command proves nothing.
	if t.registerHeldAt.IsZero() || now.Sub(t.registerHeldAt) > RegisterHoldFresh {
		t.plateauRun = 0
		return
	}
	if math.Abs(measuredKw-t.CapKw) <= tol {
		t.plateauRun++
		if t.plateauRun > t.plateauBest {
			t.plateauBest = t.plateauRun
		}
		return
	}
	// Outside the band in either direction: above = the cap is not binding
	// (yet), below = the sun dropped. Both break the run.
	t.plateauRun = 0
}

// NoteRegister records a readback verdict for the unit under test. `held` is
// the SEMANTIC verdict of sunspec/curtail.js evaluateReadback (a register
// without an answer is not a confirmation; the WMaxLim_Ena firmware quirk -
// commanded 0, reported 1 - is tolerated there), not a raw value comparison.
//
// A confirmed readback both LATCHES RegisterConfirmed (the write landed) and
// stamps the CURRENT hold, which is what gates plateau samples; a deviating
// readback drops the hold and breaks the run - the cap was not in force.
func (s *Session) NoteRegister(sourceID string, held bool, now time.Time) {
	t := s.ActiveTestFor(sourceID, now)
	if t == nil {
		return
	}
	if held {
		t.RegisterConfirmed = true
		t.registerHeldAt = now
		return
	}
	t.registerHeldAt = time.Time{}
	t.plateauRun = 0
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
		PlateauSamples:    t.plateauBest,
		PlateauRequired:   PlateauSamples,
		AmbientKw:         t.lastAmbientKw,
		AmbientSource:     t.refSourceID,
	}
	ev.ClampObserved = t.plateauBest >= PlateauSamples
	if now.After(t.Deadline) {
		ev.AgeSeconds = int(now.Sub(t.Deadline) / time.Second)
	}
	if now.Before(expiry) {
		ev.Valid = true
		ev.ExpiresInSeconds = int(expiry.Sub(now) / time.Second)
	}
	ev.Verdict, ev.Reason = verdictOf(t, ev, now)
	return ev
}

// verdictOf turns the collected facts into the honest outcome + its German
// reason. The ORDER matters: a proven clamp beats everything (a cloud earlier
// in the test does not invalidate a plateau observed later), then the weather
// excuse, then the plain "no proof".
func verdictOf(t *Test, ev *Evidence, now time.Time) (string, string) {
	if ev.ClampObserved && ev.RegisterConfirmed {
		return VerdictPassed, ""
	}
	if !now.After(t.Deadline) {
		return VerdictRunning, ""
	}
	if !ev.RegisterConfirmed {
		return VerdictNoProof, "Der Wechselrichter hat den Begrenzungswert nie bestätigt - der Befehl kam nicht an oder wurde überschrieben."
	}
	if t.ambientBelowCap {
		return VerdictUnprovable, fmt.Sprintf(
			"Nicht beweisbar: die verfügbare Sonnenleistung ist während des Tests selbst unter die Begrenzung (%.1f kW) gefallen. Ein Rückgang beweist dann nichts - der Test muss bei stabilerer Einstrahlung wiederholt werden.", t.CapKw)
	}
	return VerdictNoProof, fmt.Sprintf(
		"Die Leistung hat sich nicht auf die Begrenzung (%.1f kW) eingependelt (%d von %d Messwerten am Limit). Vermutlich setzt eine Fronius-interne Steuerung die Begrenzung außer Kraft.",
		t.CapKw, t.plateauBest, PlateauSamples)
}

// CanCertify: the evidence is still valid AND both halves are proven - the
// register readback confirmed the write and the measured output was CLAMPED AT
// the cap (the plateau, against a clearly higher ambient). This is what the
// operator's "Freigeben" button requires; the session never certifies anything
// itself. A "nicht beweisbar" test can never certify.
func (s *Session) CanCertify(sourceID string, now time.Time) bool {
	ev := s.EvidenceFor(sourceID, now)
	return ev != nil && ev.Valid && ev.RegisterConfirmed && ev.ClampObserved
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
	// "SunSpec-Modelle nicht lesbar", "Schreiben fehlgeschlagen: Timeout", or
	// the device DISCARDING the command) so the card names the CAUSE of a
	// failed/hanging test instead of leaving a bare "warte auf Bestätigung".
	// Empty when the latest readback was fine or none is recent.
	LastError           string `json:"last_error,omitempty"`
	LastErrorAgeSeconds int    `json:"last_error_age_seconds,omitempty"`
	// QuirkNote is a KNOWN, harmless firmware deviation of the latest readback
	// (today: WMaxLim_Ena reporting 1 for a commanded 0). Deliberately NOT a
	// LastError - naming it as a fault would send an operator hunting a defect
	// that does not exist.
	QuirkNote string `json:"quirk_note,omitempty"`
}

// TestView is the running test, rendered.
type TestView struct {
	CapKw            float64  `json:"cap_kw"`
	BeforeKw         float64  `json:"before_kw"`
	SecondsRemaining int      `json:"seconds_remaining"`
	RegisterOk       bool     `json:"register_ok"`
	MinObservedKw    *float64 `json:"min_observed_kw,omitempty"`
	// PlateauSamples/PlateauRequired: the live progress of the clamp proof.
	PlateauSamples  int `json:"plateau_samples"`
	PlateauRequired int `json:"plateau_required"`
	// AmbientKw/AmbientSource: what the unit would produce unthrottled and
	// where that estimate comes from (the sibling unit, or its own pre-test
	// value when the site has none).
	AmbientKw     *float64 `json:"ambient_kw,omitempty"`
	AmbientSource string   `json:"ambient_source,omitempty"`
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
