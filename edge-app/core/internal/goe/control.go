// Package goe is the go-e Charger CONTROL executor: it turns an arbitrated
// consumer charge command (kW) into the go-e local HTTP API v2 set operations
// (frc/amp), executes them, and reads the result back to prove the command
// landed. It is the Go twin of edge-app/nodered/goe/goe-control.js (the canonical
// JS mapping, the write twin of goe-api.js); the two are pinned to the SAME
// golden vectors (edge-app/nodered/goe/goe-control-vectors.json, read by both
// control_test.go and goe-control.test.js) so they can never drift - the
// refCheckChar/EdgeRef and SocPlausible/socPlausible cross-language precedent.
//
// A go-e wallbox is a CONSUMER entity; the E2 arbiter clamps its desired
// setpoint through the per-entity guard band and grants a command. The agent's
// consumer-control loop reads that granted command and runs Execute here.
//
// WHY go-e control is a REAL (certified) path and not bench_pending like the
// Deye/Fronius register writes: the go-e HTTP API v2 is documented, versioned
// and deterministic (github.com/goecharger/go-eCharger-API-v2). No guessed
// firmware registers, and the whole write->readback loop is provable in software
// (control_test.go against an httptest server). A wrong current only charges a
// car a little slower/faster - no battery-bank health/warranty risk. So go-e is
// certified and executes behind the core kill-switch VP_CONTROL_ENABLED (off by
// default), with VERIFY-on-device honesty (confirm frc/amp + phase on the first
// real wallbox, CONTROL-BENCH.md).
//
// Control keys (go-e HTTP API v2 apikeys-en.md, quoted):
//
//	frc  R/W uint8  "forceState (Neutral=0, Off=1, On=2)"   <- on/off lever
//	amp  R/W uint8  "requestedCurrent in Ampere"            <- current lever
//	psm      uint8  phaseSwitchMode (Auto=0, Force_1=1, Force_3=2) <- phase lever
//
// psm PROVENANCE (D4): psm is ABSENT from the official apikeys-en.md, but it is
// the key the production integrations provably phase-switch go-e chargers with -
// evcc (charger/go-e.go phases1p3p: psm=1 for 1-phase, psm=2 for 3-phase) and
// the Home Assistant integration marq24/ha-goecharger-api2 (psm in its Config
// key filter). The official docs DO document the surrounding phase machinery
// (fsp R/W force_single_phase, mptwt "min phase toggle wait time", psh
// "phaseSwitchHysteresis", pnp R "numberOfPhases"), so psm is a documentation
// gap, not a guess - the ha-solarman/Victron secondary-source discipline.
// Whether a psm write actually moves the contactor on a given model (only
// phase-switch-capable hardware can) stays VERIFY-on-device (CONTROL-BENCH.md);
// that is why phase switching is a per-device CONFIG opt-in, never assumed.
//
// Readback keys: car (carState 0..5), nrg (energy array, P total in W at idx 11),
// acu (allowed current now, info), alw (allowed to charge, info), psm (phase
// mode), pnp (numberOfPhases actually used, info).
package goe

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
)

// forceState (frc) enum - facts from apikeys-en.md.
const (
	FrcNeutral = 0 // hand control back to the wallbox's own logic
	FrcOff     = 1 // deliberate stop
	FrcOn      = 2 // force charging
)

// phaseSwitchMode (psm) enum - the evcc/HA value set (see the psm provenance
// note in the package comment).
const (
	PsmAuto   = 0 // the charger's own phase logic decides
	PsmForce1 = 1 // force 1-phase charging
	PsmForce3 = 2 // force 3-phase charging
)

// Communication is the driver.communication value that selects this executor.
const Communication = "goe_http_api"

// The status keys we read back after a set (payload-shrinking filter). psm/pnp
// carry the phase position: psm is the mode lever, pnp the number of phases the
// charger actually uses right now (informational).
const readbackFilter = "frc,amp,psm,pnp,acu,car,nrg,alw"

// nrgTotalPowerIdx is the TOTAL charging power slot in the nrg array (goe-api.js
// owns the authoritative decode; inlined here + asserted in the test).
const nrgTotalPowerIdx = 11

// The go-e current band + power->current conversion defaults. A desired current
// below the minimum charge current means "do not charge" (frc=Off), never a
// sub-minimum amp write.
const (
	DefaultMinCurrentA = 6
	DefaultMaxCurrentA = 16
	DefaultPhases      = 3
	DefaultVoltage     = 230.0
)

// Phase-switch pacing defaults (D4, Fahrzeug-Elektronik-Schonung): conservative
// on purpose, config-adjustable per device. The pause is the minimum time
// between two psm writes (an actual contactor/vehicle re-negotiation each
// time); the dwell is how long a DIFFERENT desired range must be stable before
// a switch is even initiated (debounce against a setpoint oscillating around
// the range boundary). Both sit ON TOP of the charger's own protection
// (mptwt "min phase toggle wait time") - never assume the device protects.
const (
	DefaultPhaseSwitchPause = 300 // seconds between two phase switches
	DefaultPhaseSwitchDwell = 60  // seconds a new desired range must be stable
)

// Config is the go-e connection (from the entity driver.connection) + the
// kW->A tuning fields (optional; defaults applied).
//
// PhaseSwitching is the per-device opt-in for D4 phase switching (only
// phase-switch-capable go-e hardware may carry it - the operator/cloud declares
// it, the driver never assumes it): the executor then derives the two
// non-convex power ranges (1-phase ~1,4..3,7 kW / 3-phase ~4,2..11 kW at the
// configured current band) and drives psm under the switch pacing below.
type Config struct {
	IP          string  `json:"ip"`
	Port        int     `json:"port,omitempty"`
	Phases      int     `json:"phases,omitempty"`
	Voltage     float64 `json:"voltage,omitempty"`
	MinCurrentA int     `json:"min_current_a,omitempty"`
	MaxCurrentA int     `json:"max_current_a,omitempty"`

	PhaseSwitching    bool `json:"phase_switching,omitempty"`
	PhaseSwitchPauseS int  `json:"phase_switch_pause_s,omitempty"` // 0 = DefaultPhaseSwitchPause
	PhaseSwitchDwellS int  `json:"phase_switch_dwell_s,omitempty"` // 0 = DefaultPhaseSwitchDwell
}

// PhaseState is the stateful PhaseSwitcher's verdict for ONE planning pass -
// the ONLY dynamic input the pure PlanFor takes for phase switching. Active is
// the phase position the charger is KNOWN to be in (from the psm/pnp readback;
// 0 = unknown - then the plan converts restrict-safe at 3 phases and never
// writes psm, the unbekannt-ist-nie-erfunden rule). SwitchAllowed is the
// pacing verdict (dwell + minimum pause elapsed) for a switch THIS pass.
type PhaseState struct {
	Active        int // 1 | 3 | 0 = unknown
	SwitchAllowed bool
}

// Command is the arbitrated, already guard-clamped consumer command.
type Command struct {
	SetpointKw     *float64 // charge power (kW), from the arbiter's granted setpoint
	OnOff          *bool    // false forces Off regardless of setpoint
	ControlEnabled bool     // the core kill-switch + the family cert verdict
	Stale          bool     // no fresh decision -> fail-safe neutral
	// Phase is the switcher's verdict; nil (or cfg.PhaseSwitching false) keeps
	// the fixed-phase behavior byte-identical.
	Phase *PhaseState
}

// HoldCodePhaseSwitch is the machine-readable reason while the driver holds a
// pending phase switch (the CycleGuard reason-code discipline: the §15
// vocabulary's driver extension - the api ingest whitelists it, the portal maps
// it to text). HoldTextPhaseSwitch is the German sentence the status surfaces
// show verbatim.
const (
	HoldCodePhaseSwitch = "guard_phase_switch"
	HoldTextPhaseSwitch = "wartet - Phasenumschaltpause"
)

// Plan is the pure write plan + readback intent (the goe-control.js controlPlan
// shape). Mode is "charge"|"off"|"neutral"|"idle".
type Plan struct {
	Adapter        string
	Target         string
	Certified      bool
	ControlEnabled bool
	Mode           string
	Frc            int
	Amp            *int
	RequestedKw    *float64
	Writes         []SetOp // EMPTY when not controlEnabled / idle
	Reason         string
	// Psm is the phase-mode write (PsmForce1/PsmForce3) when this plan
	// SWITCHES the phase position; nil otherwise (incl. always without
	// cfg.PhaseSwitching - then psm is never written).
	Psm *int
	// PhasesUsed is the phase count the kW->A conversion ran with (the ACTIVE
	// position, the NEW one after a switch, or the restrict-safe 3 while the
	// position is unknown). Equals the resolved cfg.Phases without switching.
	PhasesUsed int
	// HoldCode/HoldReason name a pending-but-paced phase switch (restrict-only:
	// the setpoint was clamped into the ACTIVE range - or Off when the active
	// range cannot serve it without overshooting). Empty when nothing is held.
	HoldCode   string
	HoldReason string
	// resolved band, exported for tests/diagnostics.
	Phases  int
	Voltage float64
	MinA    int
	MaxA    int
}

// SetOp is one go-e /api/set key=value.
type SetOp struct {
	Key   string
	Value int
	Role  string
}

func resolvedInt(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func resolvedFloat(v, def float64) float64 {
	if v > 0 {
		return v
	}
	return def
}

// CurrentForPower maps a charge power (kW) onto a whole-ampere requested current
// for phases at voltage, FLOORED so actual charge power never exceeds the
// commanded setpoint (guard-authoritative). Non-positive/non-finite -> 0.
func CurrentForPower(kw float64, phases int, voltage float64) int {
	if math.IsNaN(kw) || math.IsInf(kw, 0) || kw <= 0 {
		return 0
	}
	denom := float64(phases) * voltage
	if denom <= 0 {
		return 0
	}
	return int(math.Floor((kw * 1000) / denom))
}

// PowerForCurrent is the inverse (kW), rounded to 3dp.
func PowerForCurrent(amp, phases int, voltage float64) float64 {
	return math.Round((float64(amp)*float64(phases)*voltage/1000)*1000) / 1000
}

// PowerRange is one achievable charge-power band (the §4.3 power_ranges_kw
// shape, derived from the DEVICE configuration - the current band per phase
// position). Below the smallest MinKw the wallbox is off; a value between two
// ranges is NOT achievable and gets snapped DOWN (restrict-only), never
// delivered to the device.
type PowerRange struct {
	Phases int
	MinKw  float64
	MaxKw  float64
}

// Ranges derives the achievable power ranges from the config: without phase
// switching ONE range at the configured phase count; with phase switching the
// two non-convex D4 ranges (1-phase and 3-phase over the same current band,
// e.g. 6..16 A @ 230 V -> [1.38, 3.68] and [4.14, 11.04] kW).
func Ranges(cfg Config) []PowerRange {
	phases := resolvedInt(cfg.Phases, DefaultPhases)
	voltage := resolvedFloat(cfg.Voltage, DefaultVoltage)
	minA := resolvedInt(cfg.MinCurrentA, DefaultMinCurrentA)
	maxA := cfg.MaxCurrentA
	if maxA < minA {
		maxA = resolvedInt(cfg.MaxCurrentA, DefaultMaxCurrentA)
		if maxA < minA {
			maxA = minA
		}
	}
	if !cfg.PhaseSwitching {
		return []PowerRange{{Phases: phases, MinKw: PowerForCurrent(minA, phases, voltage), MaxKw: PowerForCurrent(maxA, phases, voltage)}}
	}
	return []PowerRange{
		{Phases: 1, MinKw: PowerForCurrent(minA, 1, voltage), MaxKw: PowerForCurrent(maxA, 1, voltage)},
		{Phases: 3, MinKw: PowerForCurrent(minA, 3, voltage), MaxKw: PowerForCurrent(maxA, 3, voltage)},
	}
}

// DesiredPhaseMode selects the D4 range for a charge wish on a phase-switching
// config: 3 when the wish reaches the 3-phase minimum, 1 while it reaches the
// 1-phase minimum (INCLUDING a wish in the gap between the ranges - it snaps
// DOWN to the 1-phase range, restrict-only), 0 = off/no charge intent. Returns
// 0 for a non-switching config (no range decision to make) and for a
// non-actionable command (stale/off/neutral).
func DesiredPhaseMode(cfg Config, cmd Command) int {
	if !cfg.PhaseSwitching {
		return 0
	}
	if cmd.Stale || (cmd.OnOff != nil && !*cmd.OnOff) {
		return 0
	}
	hasSetpoint := cmd.SetpointKw != nil && !math.IsNaN(*cmd.SetpointKw) && !math.IsInf(*cmd.SetpointKw, 0)
	wantsOn := cmd.OnOff != nil && *cmd.OnOff
	if !hasSetpoint && !wantsOn {
		return 0
	}
	r := Ranges(cfg)
	if !hasSetpoint {
		// on_off=true without a power: charge at the allowed maximum -> 3p.
		return 3
	}
	wish := *cmd.SetpointKw
	switch {
	case wish >= r[1].MinKw:
		return 3
	case wish >= r[0].MinKw:
		return 1
	default:
		return 0
	}
}

// PlanFor maps a config + command onto the pure write plan (the goe-control.js
// controlPlan twin).
func PlanFor(cfg Config, cmd Command) Plan {
	if cfg.IP == "" {
		return Plan{Adapter: Communication, Mode: "idle", Frc: FrcNeutral, Reason: "keine IP-Adresse"}
	}
	target := cfg.IP
	if cfg.Port > 0 {
		target = fmt.Sprintf("%s:%d", cfg.IP, cfg.Port)
	}
	certified := true // go-e's documented API is software-certified
	controlEnabled := cmd.ControlEnabled && certified

	phases := resolvedInt(cfg.Phases, DefaultPhases)
	voltage := resolvedFloat(cfg.Voltage, DefaultVoltage)
	minA := resolvedInt(cfg.MinCurrentA, DefaultMinCurrentA)
	maxA := cfg.MaxCurrentA
	if maxA < minA {
		maxA = resolvedInt(cfg.MaxCurrentA, DefaultMaxCurrentA)
		if maxA < minA {
			maxA = minA
		}
	}

	var mode string
	var frc int
	var amp *int
	var reqKw *float64
	var psm *int
	var holdCode, holdReason string

	explicitOff := cmd.OnOff != nil && !*cmd.OnOff
	hasSetpoint := cmd.SetpointKw != nil && !math.IsNaN(*cmd.SetpointKw) && !math.IsInf(*cmd.SetpointKw, 0)
	wantsOn := cmd.OnOff != nil && *cmd.OnOff

	// convPhases is the phase count the kW->A conversion runs with. Fixed
	// config without phase switching; with switching it follows the D4 range
	// decision below.
	convPhases := phases

	switch {
	case cmd.Stale || (!hasSetpoint && !wantsOn):
		// Fail-safe on stale/loss or a non-actionable command: Neutral - the
		// wallbox is RELEASED into its own logic (the §4.2 failsafe default
		// for native wallboxes), never a stuck forced current. psm is left
		// untouched: releasing the charge releases the phase choice with it.
		mode, frc = "neutral", FrcNeutral
	case explicitOff:
		mode, frc = "off", FrcOff
	default:
		if cfg.PhaseSwitching {
			desired := DesiredPhaseMode(cfg, cmd)
			active := 0
			switchAllowed := false
			if cmd.Phase != nil {
				active = cmd.Phase.Active
				switchAllowed = cmd.Phase.SwitchAllowed
			}
			switch {
			case desired == 0:
				// Below the smallest range minimum: off (no phase question).
				convPhases = 3
			case active == 0:
				// Phase position UNKNOWN (no readback yet): convert at 3
				// phases - restrict-safe in BOTH cases (actually 3p: exact;
				// actually 1p: the delivered power is a third of the wish,
				// never more) - and NEVER write psm blind. The always-running
				// readback fills the position for the next pass.
				convPhases = 3
			case desired == active:
				convPhases = active
			case switchAllowed:
				// Switch: write psm for the NEW position and convert for it.
				convPhases = desired
				v := PsmForce1
				if desired == 3 {
					v = PsmForce3
				}
				psm = &v
			default:
				// A switch is wanted but paced (dwell/minimum pause):
				// restrict-only into the ACTIVE range. 1p serves a bigger wish
				// at its own maximum; 3p CANNOT serve a wish below its range
				// minimum without overshooting the command, so the honest
				// restriction is Off until the pause allows switching down.
				convPhases = active
				holdCode, holdReason = HoldCodePhaseSwitch, HoldTextPhaseSwitch
			}
		}

		wishA := maxA
		if hasSetpoint {
			wishA = CurrentForPower(*cmd.SetpointKw, convPhases, voltage)
		}
		if wishA < minA {
			mode, frc = "off", FrcOff
		} else {
			mode, frc = "charge", FrcOn
			a := wishA
			if a > maxA {
				a = maxA
			}
			amp = &a
			k := PowerForCurrent(a, convPhases, voltage)
			reqKw = &k
		}
	}

	planned := []SetOp{{Key: "frc", Value: frc, Role: "force_state"}}
	if mode == "charge" {
		planned = append(planned, SetOp{Key: "amp", Value: *amp, Role: "requested_current"})
	}
	if psm != nil && mode == "charge" {
		planned = append(planned, SetOp{Key: "psm", Value: *psm, Role: "phase_switch_mode"})
	} else {
		psm = nil // a psm write only ever accompanies a charge
	}

	p := Plan{
		Adapter: Communication, Target: target, Certified: certified, ControlEnabled: controlEnabled,
		Mode: mode, Frc: frc, Amp: amp, RequestedKw: reqKw,
		Psm: psm, PhasesUsed: convPhases, HoldCode: holdCode, HoldReason: holdReason,
		Phases: phases, Voltage: voltage, MinA: minA, MaxA: maxA,
	}
	if controlEnabled {
		p.Writes = planned
	} else if certified {
		p.Reason = "Steuerung deaktiviert (Not-Aus)"
	} else {
		p.Reason = "Modell noch nicht freigegeben"
	}
	if p.Reason == "" && holdReason != "" {
		p.Reason = holdReason
	}
	return p
}

// SetURL builds the go-e /api/set URL for a plan's writes, or "" when nothing
// is written.
func (p Plan) SetURL(cfg Config) string {
	if len(p.Writes) == 0 {
		return ""
	}
	q := url.Values{}
	for _, w := range p.Writes {
		q.Set(w.Key, strconv.Itoa(w.Value))
	}
	return "http://" + p.hostPort(cfg) + "/api/set?" + q.Encode()
}

// StatusURL is the filtered /api/status readback URL.
func (p Plan) StatusURL(cfg Config) string {
	return "http://" + p.hostPort(cfg) + "/api/status?filter=" + readbackFilter
}

func (p Plan) hostPort(cfg Config) string {
	if cfg.Port > 0 {
		return fmt.Sprintf("%s:%d", cfg.IP, cfg.Port)
	}
	return cfg.IP
}

// Register is one commanded-vs-actual readback entry.
type Register struct {
	Role      string `json:"role"`
	Key       string `json:"key"`
	Commanded int    `json:"commanded"`
	Actual    *int   `json:"actual"`
	Match     bool   `json:"match"`
}

// Verdict is the evaluated readback.
type Verdict struct {
	Registers      []Register
	AllMatch       *bool // nil when nothing was written (readback-only)
	Car            string
	Charging       bool
	PowerKw        *float64
	AllowedCurrent *int
	Allowed        *bool
	// PhaseSwitchMode/PhasesInUse report the phase position (psm / pnp) so the
	// switcher and the status surfaces see the CONFIRMED position, absent when
	// the charger does not report them (never fabricated).
	PhaseSwitchMode *int
	PhasesInUse     *int
}

// status is the parsed /api/status shape we read.
type status struct {
	Frc *int      `json:"frc"`
	Amp *int      `json:"amp"`
	Psm *int      `json:"psm"`
	Pnp *int      `json:"pnp"`
	Acu *int      `json:"acu"`
	Car *int      `json:"car"`
	Alw *bool     `json:"alw"`
	Nrg []float64 `json:"nrg"`
}

func carLabel(car *int) string {
	if car == nil {
		return "unknown"
	}
	switch *car {
	case 1:
		return "idle"
	case 2:
		return "charging"
	case 3:
		return "waiting"
	case 4:
		return "complete"
	case 5:
		return "error"
	default:
		return "unknown"
	}
}

// EvalReadback computes the commanded-vs-actual match for the WRITTEN keys plus
// the informational state, from a parsed /api/status body.
func (p Plan) EvalReadback(st status) Verdict {
	wrote := map[string]bool{}
	for _, w := range p.Writes {
		wrote[w.Key] = true
	}
	v := Verdict{}
	if len(wrote) > 0 {
		allMatch := true
		if wrote["frc"] {
			match := st.Frc != nil && *st.Frc == p.Frc
			v.Registers = append(v.Registers, Register{Role: "force_state", Key: "frc", Commanded: p.Frc, Actual: st.Frc, Match: match})
			allMatch = allMatch && match
		}
		if wrote["amp"] && p.Amp != nil {
			match := st.Amp != nil && *st.Amp == *p.Amp
			v.Registers = append(v.Registers, Register{Role: "requested_current", Key: "amp", Commanded: *p.Amp, Actual: st.Amp, Match: match})
			allMatch = allMatch && match
		}
		if wrote["psm"] && p.Psm != nil {
			match := st.Psm != nil && *st.Psm == *p.Psm
			v.Registers = append(v.Registers, Register{Role: "phase_switch_mode", Key: "psm", Commanded: *p.Psm, Actual: st.Psm, Match: match})
			allMatch = allMatch && match
		}
		v.AllMatch = &allMatch
	}
	v.PhaseSwitchMode = st.Psm
	v.PhasesInUse = st.Pnp
	if len(st.Nrg) > nrgTotalPowerIdx {
		w := st.Nrg[nrgTotalPowerIdx]
		if !math.IsNaN(w) && !math.IsInf(w, 0) {
			kw := math.Round(math.Max(0, w)/1000*1000) / 1000
			v.PowerKw = &kw
		}
	}
	v.Car = carLabel(st.Car)
	v.Charging = v.Car == "charging"
	v.AllowedCurrent = st.Acu
	v.Allowed = st.Alw
	return v
}

// Result is the outcome of Execute.
type Result struct {
	OK        bool
	Wrote     bool
	Plan      Plan
	Verdict   Verdict
	ErrorCode string // invalid_request|unreachable|no_answer|invalid_response
	Message   string
}

// Error codes shared with test-read.js / the portal.
const (
	ErrInvalidRequest  = "invalid_request"
	ErrUnreachable     = "unreachable"
	ErrInvalidResponse = "invalid_response"
)

// Doer performs one HTTP GET, returning the status code + body. The agent
// injects an *http.Client-backed Doer; tests inject an httptest server client or
// a fake. Keeping it an interface makes the whole executor testable offline.
type Doer interface {
	Get(ctx context.Context, url string) (statusCode int, body []byte, err error)
}

// Execute runs the set (if the plan writes anything) then the readback, and
// evaluates the verdict. When the plan is idle (no ip) -> invalid_request; when
// control is disabled (kill-switch) but the ip is valid -> readback ONLY (the UI
// still sees the actual state), never a set.
func Execute(ctx context.Context, doer Doer, cfg Config, cmd Command) Result {
	plan := PlanFor(cfg, cmd)
	if plan.Mode == "idle" {
		return Result{OK: false, ErrorCode: ErrInvalidRequest, Message: plan.Reason, Plan: plan}
	}
	readback := func() Result {
		code, body, err := doer.Get(ctx, plan.StatusURL(cfg))
		if r, bad := classify(code, err); bad {
			return Result{OK: false, ErrorCode: r, Plan: plan}
		}
		var st status
		if e := json.Unmarshal(body, &st); e != nil {
			return Result{OK: false, ErrorCode: ErrInvalidResponse, Plan: plan}
		}
		return Result{OK: true, Wrote: len(plan.Writes) > 0, Plan: plan, Verdict: plan.EvalReadback(st)}
	}
	if len(plan.Writes) == 0 {
		return readback()
	}
	code, body, err := doer.Get(ctx, plan.SetURL(cfg))
	if r, bad := classify(code, err); bad {
		return Result{OK: false, ErrorCode: r, Plan: plan}
	}
	// The set response is { key: true | "error string" } per go-e docs.
	var setResp map[string]json.RawMessage
	if e := json.Unmarshal(body, &setResp); e != nil {
		return Result{OK: false, ErrorCode: ErrInvalidResponse, Plan: plan}
	}
	for _, w := range plan.Writes {
		raw, ok := setResp[w.Key]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return Result{OK: false, ErrorCode: ErrInvalidResponse, Message: "go-e set " + w.Key + ": " + s, Plan: plan}
		}
	}
	return readback()
}

// classify maps an HTTP outcome onto (errorCode, isError). A transport error is
// unreachable; HTTP>=400 is invalid_response. (Timeouts surface as transport
// errors from the injected Doer -> unreachable; the JS twin distinguishes
// no_answer, a finer split not needed here.)
func classify(code int, err error) (string, bool) {
	if err != nil {
		return ErrUnreachable, true
	}
	if code >= 400 {
		return ErrInvalidResponse, true
	}
	return "", false
}

// DriverConfig is the go-e slice of an entity driver block; ParseDriver returns
// the Config + whether the driver selects the go-e executor.
type DriverConfig struct {
	Communication string          `json:"communication"`
	Connection    json.RawMessage `json:"connection"`
}

// ParseDriver extracts a go-e Config from an entity's opaque driver block. It
// returns ok=false when the driver is absent, malformed, not a go-e driver, or
// carries no ip - so a non-go-e / unconfigured entity is simply skipped.
func ParseDriver(driver []byte) (Config, bool) {
	if len(driver) == 0 {
		return Config{}, false
	}
	var d DriverConfig
	if json.Unmarshal(driver, &d) != nil || d.Communication != Communication {
		return Config{}, false
	}
	var cfg Config
	if len(d.Connection) == 0 || json.Unmarshal(d.Connection, &cfg) != nil {
		return Config{}, false
	}
	if cfg.IP == "" {
		return Config{}, false
	}
	return cfg, true
}

// ReadbackPayload renders the edge/entities/{id}/readback message (v1 readback
// shape; the core's onEntityReadback consumes all_match). A FAILED execute
// carries its error_code (an honest status, never a silent success): all_match
// stays absent then, so the heartbeat's tri-state confirmed keeps meaning "no
// evidence", and the error names why there is none.
func ReadbackPayload(entityID, ts string, res Result) []byte {
	type reg struct {
		Role      string `json:"role"`
		Key       string `json:"key"`
		Commanded int    `json:"commanded"`
		Actual    *int   `json:"actual"`
		Match     bool   `json:"match"`
	}
	regs := make([]reg, 0, len(res.Verdict.Registers))
	for _, r := range res.Verdict.Registers {
		regs = append(regs, reg{r.Role, r.Key, r.Commanded, r.Actual, r.Match})
	}
	payload := struct {
		SchemaVersion string   `json:"schema_version"`
		EntityID      string   `json:"entity_id"`
		Ts            string   `json:"ts"`
		Adapter       string   `json:"adapter"`
		Mode          string   `json:"mode"`
		ControlEnab   bool     `json:"control_enabled"`
		Wrote         bool     `json:"wrote"`
		AllMatch      *bool    `json:"all_match"`
		Registers     []reg    `json:"registers"`
		Car           string   `json:"car"`
		Charging      bool     `json:"charging"`
		PowerKw       *float64 `json:"power_kw"`
		PhaseMode     *int     `json:"phase_switch_mode,omitempty"`
		PhasesInUse   *int     `json:"phases_in_use,omitempty"`
		HoldCode      string   `json:"hold_code,omitempty"`
		Reason        string   `json:"reason,omitempty"`
		ErrorCode     string   `json:"error_code,omitempty"`
		Message       string   `json:"message,omitempty"`
	}{
		SchemaVersion: "1.0", EntityID: entityID, Ts: ts, Adapter: Communication,
		Mode: res.Plan.Mode, ControlEnab: res.Plan.ControlEnabled, Wrote: res.Wrote,
		AllMatch: res.Verdict.AllMatch, Registers: regs, Car: res.Verdict.Car,
		Charging: res.Verdict.Charging, PowerKw: res.Verdict.PowerKw,
		PhaseMode: res.Verdict.PhaseSwitchMode, PhasesInUse: res.Verdict.PhasesInUse,
		HoldCode: res.Plan.HoldCode, Reason: res.Plan.Reason,
		ErrorCode: res.ErrorCode, Message: res.Message,
	}
	b, _ := json.Marshal(payload)
	return b
}
