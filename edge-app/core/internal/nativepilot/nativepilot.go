// Package nativepilot is the supervised PILOT WINDOW of the Deye charge-side
// hand-over (K5, concept vp-wechselrichter-eigenregelung-k1 §8/§9, captain
// decision E7 A: "in betreuten Fenstern von je höchstens 15 Minuten; du löst
// jeden Test aus").
//
// A run hands the Deye's charge side to ONE hand-over candidate (grid_zero =
// "netzseitig Ziel 0", own_config = "Eigenkonfiguration") WITHOUT a certificate -
// the armed window IS the bench, exactly like the grid-setpoint test
// (internal/curtailcal/gridtest.go) - and measures what the certificate would
// have to rest on: kWh "Netz in den Speicher", kWh "Einspeisung trotz freier
// Ladeleistung", mean |grid|, T90 on jumps, oscillation cycles, write cycles and
// every take-back with its reason.
//
// ⚠ IT NEVER STARTS ITSELF. Start is only reachable from the operator-guarded
// POST /api/native/pilot; nothing schedules it, nothing re-arms it. Every run
// ends by itself after at most MaxDuration.
//
// ⚠ THE ABORT ENVELOPE (§8) is checked on every observation and every tick:
// export > 33 kW, import > 5 kW for longer than 10 s, telemetry older than 15 s,
// two readback failures in a row - plus the safety rules that also bind the
// production supervision (reserve floor, EEG grid-charge proof, charging from
// the grid). The device's own 60-s watchdog (Deye 1101) stays the last instance:
// a dead box ends the grid_zero candidate by itself, and own_config IS the
// device's own configuration.
//
// Pure: no I/O, every method takes `now`, so the whole envelope is provable
// with an injected clock.
package nativepilot

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Candidates and intents a run may choose (the Layer-1 words, deye-charge-side.js).
const (
	CandidateGridZero  = "grid_zero"
	CandidateOwnConfig = "own_config"
	IntentSurplus      = "surplus_charge"
	IntentSelfConsume  = "self_consumption"
)

// The envelope and the timing (concept §8).
const (
	MaxDuration     = 15 * time.Minute
	DefaultDuration = 10 * time.Minute
	// ProofGrace: the device has to prove the candidate (a native readback with
	// the candidate's intent) within this, else the run ends - the first tick
	// reads the device configuration, the second hands over.
	ProofGrace       = 60 * time.Second
	ExportAbortKw    = 33.0
	ImportAbortKw    = 5.0
	ImportAbortHold  = 10 * time.Second
	StaleAfter       = 15 * time.Second
	ReadbackFailures = 2
	// FloorMarginPct mirrors guards.NativeFloorMarginPct; CeilingPct is the
	// F11 end criterion ("bis Ladegrenze oder 95 %").
	FloorMarginPct = 3.0
	CeilingPct     = 95.0
	// The charge-side rules of the production supervision (guards/nativemode.go).
	ChargeSideLimitKw = 0.5
	ChargeSideHold    = 60 * time.Second
	// Aftercare: the transition back to the plan is observed this long (F5).
	AftercareDuration = 60 * time.Second
	// A jump / an oscillation starts above these grid magnitudes.
	JumpKw  = 1.0
	SwingKw = 0.5
)

// Closed vocabulary of how a run ended. Each has a German sentence.
const (
	EndDeadline      = "zeit_abgelaufen"
	EndSlot          = "slot_ende"
	EndCeiling       = "ladegrenze_erreicht"
	EndOperator      = "betreiber_abbruch"
	AbortExport      = "einspeisung_ueber_grenze"
	AbortImport      = "bezug_ueber_grenze"
	AbortStale       = "telemetrie_veraltet"
	AbortReadback    = "rueckmeldung_fehlt"
	AbortUnproven    = "nicht_uebernommen"
	AbortFloor       = "reserve_boden"
	AbortGridCharge  = "netzladen_am_geraet"
	AbortControlOff  = "steuerung_aus"
	TakeBackGridLoad = "laden_bei_bezug"
	TakeBackDisch    = "entladen_gegen_absicht"
	TakeBackPvCurt   = "pv_abgeregelt"
)

var endText = map[string]string{
	EndDeadline:      "Das Pilotfenster ist abgelaufen.",
	EndSlot:          "Der Zeitabschnitt ist zu Ende - der Fahrplan übernimmt (F5).",
	EndCeiling:       "Der Speicher hat 95 % erreicht - Ende des Tests.",
	EndOperator:      "Vom Betreiber abgebrochen.",
	AbortExport:      "Die Einspeisung lag über 33 kW - sofort abgebrochen.",
	AbortImport:      "Der Netzbezug lag länger als 10 s über 5 kW - abgebrochen.",
	AbortStale:       "Die Messwerte sind älter als 15 s - abgebrochen.",
	AbortReadback:    "Der Wechselrichter hat zweimal hintereinander nicht bestätigt - abgebrochen.",
	AbortUnproven:    "Der Wechselrichter hat den Kandidaten nicht übernommen.",
	AbortFloor:       "Der Ladestand hat die Reserve erreicht - abgebrochen.",
	AbortGridCharge:  "Der Wechselrichter hat nicht belegt, dass er nicht aus dem Netz lädt - abgebrochen.",
	AbortControlOff:  "Die Steuerung wurde abgeschaltet (Not-Aus) - abgebrochen.",
	TakeBackGridLoad: "Der Speicher hat über eine Minute aus dem Netz geladen - Rücknahme.",
	TakeBackDisch:    "Der Speicher hat über eine Minute entladen, obwohl er nur Überschuss laden sollte - Rücknahme.",
	TakeBackPvCurt:   "Der Speicher nimmt nichts mehr auf und der Wechselrichter würde seine eigene PV abregeln - Rücknahme in den Batterie-Modus.",
}

// EndText is the German sentence of an end/abort/take-back code.
func EndText(code string) string { return endText[code] }

// Kind of an end: a normal end, an envelope abort, or a supervision take-back.
func endKind(code string) string {
	switch code {
	case EndDeadline, EndSlot, EndCeiling, EndOperator:
		return "ende"
	case TakeBackGridLoad, TakeBackDisch, TakeBackPvCurt:
		return "ruecknahme"
	default:
		return "abbruch"
	}
}

// ValidationError is a refusal the operator can act on (HTTP 400).
type ValidationError struct{ Msg string }

func (e ValidationError) Error() string { return e.Msg }

// Request is what the operator asks for.
type Request struct {
	Candidate string `json:"candidate"`
	Intent    string `json:"intent"`
	// Case is the §8 test case the run is for (F11, F1, F2, F5) - a label for
	// the record; F5 also means "until the slot ends".
	Case    string `json:"case"`
	Minutes int    `json:"minutes"`
}

// Conditions are the facts Start judges (the agent gathers them).
type Conditions struct {
	ControlEnabled bool
	Certified      bool
	RemotePath     bool
	OtherTest      bool // a grid-setpoint test or a calibration owns the inverter
	RatedKw        float64
	MeasurementAge time.Duration
	SocPct         *float64
	FloorPct       *float64
	SocMaxPct      float64
	SlotEnd        time.Time // end of the running plan slot (F5)
}

// Observation is one telemetry sample (+ import / - export, + charge).
type Observation struct {
	GridKw, BatteryKw, SocPct *float64
	// SetpointKw is what the plan commands after the run (aftercare, F5).
	SetpointKw *float64
}

// Readback is Layer 1's answer on one control cycle of this run.
type Readback struct {
	Native            bool   // mode "native" and every proof register held
	Intent, Candidate string // native.intent / native.candidate
	GridChargeBlocked *bool  // native.grid_charge_blocked (or the pre-hand-over read)
	Refusal           string // native_refusal
	Wrote             bool
	Mismatch          bool // a readback that did NOT hold (unconfirmed cycles are no statement)
}

// Command is the native_pilot block Layer 1 reads (deye-charge-side.js parseNativePilot).
type Command struct {
	Candidate        string `json:"candidate"`
	Intent           string `json:"intent"`
	Run              string `json:"run"`
	SecondsRemaining int    `json:"seconds_remaining"`
}

// Event is a timestamped reason (take-back, abort, end).
type Event struct {
	At   time.Time `json:"at"`
	Code string    `json:"code"`
	Kind string    `json:"kind"`
	Text string    `json:"text"`
}

// Metrics are the §8 measurement quantities of one run.
type Metrics struct {
	Seconds           float64  `json:"seconds"`
	Samples           int      `json:"samples"`
	GridToStorageKwh  float64  `json:"netz_in_speicher_kwh"`
	ExportHeadroomKwh float64  `json:"einspeisung_trotz_ladeleistung_kwh"`
	MeanAbsGridKw     float64  `json:"mittel_abs_netz_kw"`
	Jumps             int      `json:"spruenge"`
	T90MaxS           float64  `json:"t90_max_s"`
	T90MeanS          float64  `json:"t90_mittel_s"`
	SwingCycles       int      `json:"pendelzyklen"`
	WriteCycles       int      `json:"schreibvorgaenge"`
	WritesPerHour     float64  `json:"schreibvorgaenge_je_stunde"`
	MaxExportKw       float64  `json:"max_einspeisung_kw"`
	MaxImportKw       float64  `json:"max_bezug_kw"`
	ProvenAfterS      *float64 `json:"uebernommen_nach_s,omitempty"`
}

// AftercareSample is one post-run sample (F5: transition back to the plan).
type AftercareSample struct {
	S          float64  `json:"s"`
	GridKw     float64  `json:"netz_kw"`
	BatteryKw  float64  `json:"speicher_kw"`
	SetpointKw *float64 `json:"sollwert_kw,omitempty"`
}

// Run is one armed window.
type Run struct {
	ID        string
	Req       Request
	RatedKw   float64
	StartedAt time.Time
	Deadline  time.Time
	FloorPct  float64
	SocMaxPct float64

	endedAt  time.Time
	end      *Event
	events   []Event
	proven   bool
	provenAt time.Time
	refusal  string
	badRuns  int

	lastObsAt       time.Time
	importSince     time.Time
	gridLoadSince   time.Time
	dischSince      time.Time
	atLimitSince    time.Time
	m               Metrics
	absGridIntegral float64
	jumpStart       time.Time
	jumpPeak        float64
	t90Sum          float64
	swingSign       int
	aftercare       []AftercareSample
}

// Session holds at most one run (plus the last finished one, for GET).
type Session struct {
	run  *Run
	last *Run
	seq  int
}

// New returns an idle session.
func New() *Session { return &Session{} }

// Current is the armed run (nil when none is armed).
func (s *Session) Current() *Run {
	if !s.Active() {
		return nil
	}
	return s.run
}

// Active reports whether a run is armed (not ended).
func (s *Session) Active() bool { return s.run != nil && s.run.end == nil }

// Start arms a run - the ONLY entry. Every refusal is a German sentence.
func (s *Session) Start(req Request, c Conditions, now time.Time) (*Run, error) {
	if s.Active() {
		return nil, ValidationError{"Es läuft bereits ein Pilotfenster - erst abbrechen oder ablaufen lassen."}
	}
	if req.Candidate != CandidateGridZero && req.Candidate != CandidateOwnConfig {
		return nil, ValidationError{"Unbekannter Übergabe-Kandidat - erlaubt sind grid_zero (netzseitig Ziel 0) und own_config (Eigenkonfiguration)."}
	}
	if req.Intent == "" {
		req.Intent = IntentSelfConsume
	}
	if req.Intent != IntentSurplus && req.Intent != IntentSelfConsume {
		return nil, ValidationError{"Unbekannte Absicht - erlaubt sind surplus_charge (nur Überschuss laden) und self_consumption (Eigenverbrauch)."}
	}
	req.Case = strings.ToUpper(strings.TrimSpace(req.Case))
	switch req.Case {
	case "", "F11", "F1", "F2", "F5":
	default:
		return nil, ValidationError{"Unbekannter Prüffall - erlaubt sind F11, F1, F2 und F5."}
	}
	dur := DefaultDuration
	if req.Minutes != 0 {
		if req.Minutes < 1 || time.Duration(req.Minutes)*time.Minute > MaxDuration {
			return nil, ValidationError{fmt.Sprintf("Ein Pilotfenster dauert 1 bis %d Minuten.", int(MaxDuration/time.Minute))}
		}
		dur = time.Duration(req.Minutes) * time.Minute
	}
	switch {
	case c.OtherTest:
		return nil, ValidationError{"Ein anderer Test (Netz-Sollwert-Test oder Kalibrierung) steuert den Wechselrichter gerade."}
	case !c.ControlEnabled:
		return nil, ValidationError{"Die Steuerung ist per Sicherheitsvorgabe deaktiviert (Not-Aus)."}
	case !c.Certified:
		return nil, ValidationError{"Die Steuerung dieses Wechselrichters ist noch nicht freigegeben (First-Light)."}
	case !c.RemotePath:
		return nil, ValidationError{"Der Wechselrichter wird nicht über die Fernsteuerung (Register 1100-1121) gesteuert - nur dort gibt es die beiden Kandidaten."}
	case !(c.RatedKw > 0):
		return nil, ValidationError{"Die Nennleistung des Modells ist unbekannt."}
	case c.MeasurementAge > StaleAfter:
		return nil, ValidationError{fmt.Sprintf("Die Messwerte sind älter als %d Sekunden.", int(StaleAfter/time.Second))}
	case c.FloorPct == nil:
		return nil, ValidationError{"Die Reserve-Untergrenze der Anlage ist nicht bekannt."}
	case c.SocPct == nil:
		return nil, ValidationError{"Der Ladestand ist nicht bekannt."}
	case *c.SocPct <= *c.FloorPct+FloorMarginPct:
		return nil, ValidationError{"Der Ladestand liegt an der Reserve - so lässt sich nichts messen."}
	case *c.SocPct >= CeilingPct:
		return nil, ValidationError{"Der Speicher ist fast voll (≥ 95 %) - so lässt sich die Ladeseite nicht messen."}
	}
	deadline := now.Add(dur)
	if req.Case == "F5" && !c.SlotEnd.IsZero() && c.SlotEnd.After(now) && c.SlotEnd.Before(deadline) {
		deadline = c.SlotEnd
	}
	s.seq++
	r := &Run{
		ID:        fmt.Sprintf("%s-%d", now.UTC().Format("20060102T150405Z"), s.seq),
		Req:       req,
		RatedKw:   c.RatedKw,
		StartedAt: now,
		Deadline:  deadline,
		FloorPct:  *c.FloorPct,
		SocMaxPct: c.SocMaxPct,
		lastObsAt: now,
	}
	s.run, s.last = r, nil
	return r, nil
}

// Window is the natural window of the intent at the nameplate: E-up [0; rated],
// E [-rated; rated]. Natural on purpose - the pilot measures the device's own
// regulation, not a policy bound.
func (r *Run) Window() (minKw, maxKw float64) {
	if r.Req.Intent == IntentSurplus {
		return 0, r.RatedKw
	}
	return -r.RatedKw, r.RatedKw
}

func (r *Run) finish(now time.Time, code string) {
	if r.end != nil {
		return
	}
	ev := Event{At: now, Code: code, Kind: endKind(code), Text: EndText(code)}
	if code == AbortUnproven && r.refusal != "" {
		ev.Text = EndText(code) + " Grund laut Box: " + r.refusal
	}
	r.end = &ev
	r.endedAt = now
	r.events = append(r.events, ev)
}

// Abort ends the running run at the operator's request.
func (s *Session) Abort(now time.Time) {
	if s.Active() {
		s.run.finish(now, EndOperator)
	}
}

// Publish is the per-tick question "what goes on edge/setpoint": the command
// while the run is armed; engaged=false once it ended (the plan takes over).
// It also runs the clock-driven checks (deadline, stale telemetry, proof grace,
// control switched off).
func (s *Session) Publish(now time.Time, controlEnabled bool) (Command, bool) {
	r := s.run
	if r == nil || r.end != nil {
		return Command{}, false
	}
	switch {
	case !controlEnabled:
		r.finish(now, AbortControlOff)
	case !now.Before(r.Deadline):
		if r.Req.Case == "F5" && r.Deadline.Before(r.StartedAt.Add(MaxDuration)) {
			r.finish(now, EndSlot)
		} else {
			r.finish(now, EndDeadline)
		}
	case now.Sub(r.lastObsAt) > StaleAfter:
		r.finish(now, AbortStale)
	case !r.proven && now.Sub(r.StartedAt) > ProofGrace:
		r.finish(now, AbortUnproven)
	}
	if r.end != nil {
		return Command{}, false
	}
	return Command{Candidate: r.Req.Candidate, Intent: r.Req.Intent, Run: r.ID,
		SecondsRemaining: int(r.Deadline.Sub(now) / time.Second)}, true
}

// NoteReadback feeds Layer 1's answer on a cycle of this run.
func (s *Session) NoteReadback(rb Readback, now time.Time) {
	r := s.run
	if r == nil || r.end != nil {
		return
	}
	if rb.Wrote {
		r.m.WriteCycles++
	}
	if rb.Refusal != "" {
		r.refusal = rb.Refusal
	}
	// EEG: the device SAID it may charge from the grid - never acceptable here
	// (the pilot always publishes grid_charge_allowed=false).
	if rb.GridChargeBlocked != nil && !*rb.GridChargeBlocked {
		r.finish(now, AbortGridCharge)
		return
	}
	ok := rb.Native && rb.Intent == r.Req.Intent &&
		(rb.Candidate == "" || rb.Candidate == r.Req.Candidate)
	if ok && rb.GridChargeBlocked == nil {
		// Proven without the grid-charge answer: not a proof on this site.
		r.finish(now, AbortGridCharge)
		return
	}
	if ok {
		if !r.proven {
			r.proven, r.provenAt = true, now
			v := now.Sub(r.StartedAt).Seconds()
			r.m.ProvenAfterS = &v
		}
		r.badRuns = 0
		return
	}
	// Before the proof a non-native cycle is the expected reading tick; after it
	// every cycle that is not the candidate's own proof is a failure.
	if r.proven || rb.Mismatch {
		r.badRuns++
		if r.badRuns >= ReadbackFailures {
			r.finish(now, AbortReadback)
		}
	}
}

func held(cond bool, since *time.Time, now time.Time, hold time.Duration) bool {
	if !cond {
		*since = time.Time{}
		return false
	}
	if since.IsZero() {
		*since = now
	}
	return now.Sub(*since) > hold
}

// Observe feeds one telemetry sample: metrics, the abort envelope and the
// supervision rules. After the run it records the aftercare (F5) for
// AftercareDuration.
func (s *Session) Observe(o Observation, now time.Time) {
	r := s.run
	if r == nil {
		return
	}
	if r.end != nil {
		if o.GridKw != nil && o.BatteryKw != nil && now.Sub(r.endedAt) <= AftercareDuration {
			r.aftercare = append(r.aftercare, AftercareSample{S: round1(now.Sub(r.endedAt).Seconds()),
				GridKw: round3(*o.GridKw), BatteryKw: round3(*o.BatteryKw), SetpointKw: o.SetpointKw})
		}
		return
	}
	if o.GridKw == nil || o.BatteryKw == nil {
		return // not a sample: the stale-telemetry clock keeps running
	}
	grid, batt := *o.GridKw, *o.BatteryKw
	dt := now.Sub(r.lastObsAt).Seconds()
	if r.m.Samples == 0 || dt < 0 {
		dt = 0
	}
	r.lastObsAt = now
	r.m.Samples++
	soc := math.NaN()
	if o.SocPct != nil {
		soc = *o.SocPct
	}
	// --- metrics (§8) ---
	r.m.Seconds += dt
	r.m.GridToStorageKwh += math.Max(0, math.Min(batt, grid)) * dt / 3600
	_, winMax := r.Window()
	headroom := !math.IsNaN(soc) && soc < CeilingPct && batt < winMax-ChargeSideLimitKw
	if headroom && grid < 0 {
		r.m.ExportHeadroomKwh += -grid * dt / 3600
	}
	r.absGridIntegral += math.Abs(grid) * dt
	if r.m.Seconds > 0 {
		r.m.MeanAbsGridKw = r.absGridIntegral / r.m.Seconds
	}
	r.m.MaxExportKw = math.Max(r.m.MaxExportKw, -grid)
	r.m.MaxImportKw = math.Max(r.m.MaxImportKw, grid)
	// T90 on jumps: an excursion above JumpKw lasts until |grid| is back within
	// 10 % of its peak (or SwingKw).
	a := math.Abs(grid)
	if r.jumpStart.IsZero() {
		if a > JumpKw {
			r.jumpStart, r.jumpPeak = now, a
		}
	} else {
		r.jumpPeak = math.Max(r.jumpPeak, a)
		if a <= math.Max(0.1*r.jumpPeak, SwingKw) {
			t := now.Sub(r.jumpStart).Seconds()
			r.m.Jumps++
			r.t90Sum += t
			r.m.T90MaxS = math.Max(r.m.T90MaxS, t)
			r.m.T90MeanS = r.t90Sum / float64(r.m.Jumps)
			r.jumpStart = time.Time{}
		}
	}
	// Oscillation: a sign change of the grid through the ±SwingKw band.
	sign := 0
	if grid > SwingKw {
		sign = 1
	} else if grid < -SwingKw {
		sign = -1
	}
	if sign != 0 {
		if r.swingSign != 0 && sign != r.swingSign {
			r.m.SwingCycles++
		}
		r.swingSign = sign
	}
	if r.m.Seconds > 0 {
		r.m.WritesPerHour = float64(r.m.WriteCycles) * 3600 / r.m.Seconds
	}
	// --- the abort envelope (§8) ---
	if -grid > ExportAbortKw {
		r.finish(now, AbortExport)
		return
	}
	if held(grid > ImportAbortKw, &r.importSince, now, ImportAbortHold) {
		r.finish(now, AbortImport)
		return
	}
	if !math.IsNaN(soc) && soc <= r.FloorPct+FloorMarginPct {
		r.finish(now, AbortFloor)
		return
	}
	// --- the production supervision's charge-side rules, as take-backs ---
	if held(math.Min(batt, grid) > ChargeSideLimitKw, &r.gridLoadSince, now, ChargeSideHold) {
		r.finish(now, TakeBackGridLoad)
		return
	}
	if held(r.Req.Intent == IntentSurplus && batt < -ChargeSideLimitKw, &r.dischSince, now, ChargeSideHold) {
		r.finish(now, TakeBackDisch)
		return
	}
	if r.Req.Candidate == CandidateGridZero {
		ceiling := r.SocMaxPct
		if !(ceiling > 0) {
			ceiling = CeilingPct
		}
		if !math.IsNaN(soc) && soc >= ceiling-FloorMarginPct {
			r.finish(now, TakeBackPvCurt)
			return
		}
		if held(grid < -ChargeSideLimitKw && batt >= winMax-ChargeSideLimitKw, &r.atLimitSince, now, ChargeSideHold) {
			r.finish(now, TakeBackPvCurt)
			return
		}
	}
	// F11 end: the storage reached 95 %.
	if !math.IsNaN(soc) && soc >= CeilingPct {
		r.finish(now, EndCeiling)
	}
}

// View is the GET /api/native/pilot payload.
type View struct {
	Available  bool     `json:"available"`
	Reason     string   `json:"reason,omitempty"`
	MaxMinutes int      `json:"max_minutes"`
	Run        *RunView `json:"run,omitempty"`
}

// RunView is one run as the operator reads it.
type RunView struct {
	ID               string            `json:"id"`
	Candidate        string            `json:"candidate"`
	Intent           string            `json:"intent"`
	Case             string            `json:"case,omitempty"`
	Active           bool              `json:"active"`
	StartedAt        time.Time         `json:"started_at"`
	Deadline         time.Time         `json:"deadline"`
	SecondsRemaining int               `json:"seconds_remaining"`
	Proven           bool              `json:"proven"`
	Refusal          string            `json:"layer1_refusal,omitempty"`
	End              *Event            `json:"end,omitempty"`
	Events           []Event           `json:"events"`
	Metrics          Metrics           `json:"metrics"`
	Aftercare        []AftercareSample `json:"nachlauf,omitempty"`
	AftercareSummary *Aftercare        `json:"nachlauf_auswertung,omitempty"`
}

// Aftercare summarises the transition back to the plan (F5).
type Aftercare struct {
	ErrorAt30sKw *float64 `json:"abweichung_nach_30s_kw,omitempty"`
	OvershootKw  *float64 `json:"ueberschwingen_kw,omitempty"`
}

// Snapshot renders the current (or last) run.
func (s *Session) Snapshot(now time.Time) *RunView {
	r := s.run
	if r == nil {
		r = s.last
	}
	if r == nil {
		return nil
	}
	v := &RunView{ID: r.ID, Candidate: r.Req.Candidate, Intent: r.Req.Intent, Case: r.Req.Case,
		Active: r.end == nil, StartedAt: r.StartedAt, Deadline: r.Deadline, Proven: r.proven,
		Refusal: r.refusal, End: r.end, Events: append([]Event{}, r.events...), Metrics: r.m,
		Aftercare: append([]AftercareSample{}, r.aftercare...)}
	v.Metrics.GridToStorageKwh = round3(v.Metrics.GridToStorageKwh)
	v.Metrics.ExportHeadroomKwh = round3(v.Metrics.ExportHeadroomKwh)
	v.Metrics.MeanAbsGridKw = round3(v.Metrics.MeanAbsGridKw)
	v.Metrics.WritesPerHour = round1(v.Metrics.WritesPerHour)
	if r.end == nil {
		v.SecondsRemaining = int(math.Max(0, r.Deadline.Sub(now).Seconds()))
	}
	if len(r.aftercare) > 0 {
		v.AftercareSummary = aftercareSummary(r.aftercare)
	}
	return v
}

func aftercareSummary(a []AftercareSample) *Aftercare {
	out := &Aftercare{}
	over := 0.0
	seen := false
	for _, s := range a {
		if s.SetpointKw == nil {
			continue
		}
		sp := *s.SetpointKw
		// Overshoot: the battery beyond the commanded value, in its direction.
		if sp != 0 {
			o := (s.BatteryKw - sp) * math.Copysign(1, sp)
			over = math.Max(over, o)
			seen = true
		}
		if out.ErrorAt30sKw == nil && s.S >= 30 {
			e := round3(math.Abs(s.BatteryKw - sp))
			out.ErrorAt30sKw = &e
		}
	}
	if seen {
		o := round3(over)
		out.OvershootKw = &o
	}
	return out
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
func round1(v float64) float64 { return math.Round(v*10) / 10 }
