package shelly

// The Shelly consumer CONTROL executor: arbitrated command -> relay write ->
// readback. The pure mapping (PlanFor) and the readback evaluation are pinned
// by the golden vectors in testdata/shelly-control-vectors.json (the
// goe-control-vectors discipline; Go is the only implementation today - a
// future JS twin must read the SAME file).
//
// WHY shelly control is a REAL (driver-certified) path and not bench_pending
// like the Deye/Fronius register writes: the Shelly local HTTP APIs (Gen1 REST,
// Gen2+ RPC) are documented, versioned and deterministic; production
// integrations (Home Assistant core, evcc) drive the same calls. No guessed
// firmware registers, and the whole write->readback loop is provable in
// software (control_test.go against httptest stubs of BOTH generations). A
// wrong relay write switches a resistive load - no battery-bank health risk.
// So the DRIVER executes behind the kill-switches (VP_CONTROL_ENABLED AND
// VP_CONSUMER_CONTROL_ENABLED, both off by default) with VERIFY-on-device
// honesty for everything hardware-behavioral (timer fidelity, metering
// plausibility - CONTROL-BENCH.md -> Shelly); the consumer TYPES
// (heating-rod / generic-load) stay `simulator_only` in the cloud catalog
// until the captain's bench session flips them (D11, its own mini-PR).

import (
	"context"
	"encoding/json"
	"math"
)

// Command is the arbitrated, already guard-clamped consumer command (the
// goe.Command shape minus the phase machinery - a relay has none).
type Command struct {
	SetpointKw     *float64 // granted power wish (kW); a relay can only ever snap it
	OnOff          *bool    // the authoritative relay command when present
	ControlEnabled bool     // the core kill-switch verdict
	Stale          bool     // no arbiter decision at all -> fail-safe OFF
}

// onKwThreshold separates "commanded to run" from "commanded off" on a bare
// setpoint (mirrors agent/consumers.go grantedOn + the guard deadband).
const onKwThreshold = 0.005

// Reason strings (German, surface-verbatim).
const (
	reasonFailsafeOff  = "Failsafe: ohne frischen Befehl bleibt das Relais aus"
	reasonBelowRated   = "Sollwert unter der Nennleistung - das Relais bleibt aus (nie mehr liefern als befohlen)"
	reasonKillSwitch   = "Steuerung deaktiviert (Not-Aus)"
	reasonNoIP         = "keine IP-Adresse"
	reasonTimerArmed   = "Einschalten mit Abfall-Timer (Totmann-Schutz)"
	reasonTimerNoGuard = "Einschalten OHNE Abfall-Timer (per Konfiguration deaktiviert)"
)

// Plan is the pure write plan + readback intent.
type Plan struct {
	Adapter        string
	Target         string
	Certified      bool // the driver-level verdict (see the package comment), not the cloud type catalog
	ControlEnabled bool
	// Mode is "on"|"off"|"idle". Unlike go-e there is NO neutral: a relay has
	// no own logic to release into, and the §4.2 failsafe of a heating rod is
	// OFF - a rod without a fresh command must not keep heating.
	Mode string
	On   bool
	// TimerS is the dead-man window the ON write carries (0 = none: either an
	// OFF write, or the timer was explicitly disabled).
	TimerS int
	// Write is true when the plan actually writes (control enabled + not idle).
	Write  bool
	Reason string
}

// PlanFor maps a config + command onto the pure write plan.
func PlanFor(cfg Config, cmd Command) Plan {
	if cfg.IP == "" {
		return Plan{Adapter: Communication, Mode: "idle", Reason: reasonNoIP}
	}
	certified := true // documented HTTP API, software-provable loop (package comment)
	controlEnabled := cmd.ControlEnabled && certified

	var mode string
	var reason string
	hasSetpoint := cmd.SetpointKw != nil && !math.IsNaN(*cmd.SetpointKw) && !math.IsInf(*cmd.SetpointKw, 0)

	switch {
	case cmd.Stale || (cmd.OnOff == nil && !hasSetpoint):
		// Fail-safe OFF on stale/loss or a non-actionable command (§4.2
		// default `off`): a heating rod without a fresh decision must not
		// keep heating. Deliberately NOT the go-e neutral release - a relay
		// has no own charging logic to hand control back to.
		mode, reason = "off", reasonFailsafeOff
	case cmd.OnOff != nil:
		if *cmd.OnOff {
			mode = "on"
		} else {
			mode = "off"
		}
	case *cmd.SetpointKw <= onKwThreshold:
		mode = "off"
	case cfg.RatedPowerKw > 0 && *cmd.SetpointKw < cfg.RatedPowerKw*(1-1e-6):
		// Restrict-only on a bare setpoint: a relay delivers 0 or RATED,
		// nothing between - turning on for a sub-rated wish would deliver
		// MORE than commanded. Snap DOWN to off, honestly named (the
		// power_ranges gap discipline). Only judged when the driver knows
		// the rated power; the sanctioned command paths for on_off consumers
		// carry an explicit on_off anyway (cloud-resolved).
		mode, reason = "off", reasonBelowRated
	default:
		// A granted positive setpoint without a known rated power: commanded
		// to run (mirrors grantedOn - the cloud resolves on_off targets to
		// rated power, so the arbiter's clamped wish IS the run command).
		mode = "on"
	}

	p := Plan{
		Adapter: Communication, Target: cfg.HostPort(), Certified: certified,
		ControlEnabled: controlEnabled, Mode: mode, On: mode == "on",
		Reason: reason,
	}
	if p.On {
		p.TimerS = cfg.onTimerS()
		if p.Reason == "" {
			if p.TimerS > 0 {
				p.Reason = reasonTimerArmed
			} else {
				p.Reason = reasonTimerNoGuard
			}
		}
	}
	if controlEnabled {
		p.Write = true
	} else if p.Reason == "" || p.Reason == reasonTimerArmed || p.Reason == reasonTimerNoGuard {
		p.Reason = reasonKillSwitch
	}
	return p
}

// Register is the commanded-vs-actual relay readback entry (the v1 all_match
// register shape: 1 = on, 0 = off).
type Register struct {
	Role      string `json:"role"`
	Key       string `json:"key"`
	Commanded int    `json:"commanded"`
	Actual    *int   `json:"actual"`
	Match     bool   `json:"match"`
}

// Verdict is the evaluated readback.
type Verdict struct {
	Registers []Register
	AllMatch  *bool // nil when nothing was written (readback-only)
	On        *bool
	PowerKw   *float64 // metering models only, never fabricated
}

// relayKey names the readback register per dialect (the documented field).
func relayKey(ident Identity) string {
	if ident.Gen == Gen1 {
		return "ison"
	}
	return "output"
}

// EvalReadback compares the plan's commanded relay state to the read state.
func (p Plan) EvalReadback(ident Identity, st State) Verdict {
	v := Verdict{On: st.On, PowerKw: st.PowerKw}
	if !p.Write {
		return v
	}
	commanded := 0
	if p.On {
		commanded = 1
	}
	var actual *int
	match := false
	if st.On != nil {
		a := 0
		if *st.On {
			a = 1
		}
		actual = &a
		match = a == commanded
	}
	v.Registers = []Register{{Role: "relay", Key: relayKey(ident), Commanded: commanded,
		Actual: actual, Match: match}}
	v.AllMatch = &match
	return v
}

// Result is the outcome of Execute.
type Result struct {
	OK        bool
	Wrote     bool
	Plan      Plan
	Identity  Identity
	Verdict   Verdict
	ErrorCode string
	Message   string
}

// Execute runs the relay write (when the plan writes) then the readback, and
// evaluates the verdict. Kill-switch off but a valid target -> readback ONLY
// (the surfaces still see the actual state), never a write.
func Execute(ctx context.Context, doer Doer, cfg Config, ident Identity, cmd Command) Result {
	plan := PlanFor(cfg, cmd)
	if plan.Mode == "idle" {
		return Result{OK: false, ErrorCode: ErrInvalidRequest, Message: plan.Reason, Plan: plan, Identity: ident}
	}
	if plan.Write {
		if de := SetRelay(ctx, doer, cfg, ident, plan.On); de != nil {
			return Result{OK: false, ErrorCode: de.Code, Message: de.Message, Plan: plan, Identity: ident}
		}
	}
	st, de := ReadState(ctx, doer, cfg, ident)
	if de != nil {
		return Result{OK: false, Wrote: plan.Write, ErrorCode: de.Code, Message: de.Message,
			Plan: plan, Identity: ident}
	}
	return Result{OK: true, Wrote: plan.Write, Plan: plan, Identity: ident,
		Verdict: plan.EvalReadback(ident, st)}
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
		Gen           int      `json:"gen,omitempty"`
		Metering      bool     `json:"metering"`
		Mode          string   `json:"mode"`
		ControlEnab   bool     `json:"control_enabled"`
		Wrote         bool     `json:"wrote"`
		AllMatch      *bool    `json:"all_match"`
		Registers     []reg    `json:"registers"`
		On            *bool    `json:"on,omitempty"`
		PowerKw       *float64 `json:"power_kw,omitempty"`
		TimerS        int      `json:"timer_s,omitempty"`
		Reason        string   `json:"reason,omitempty"`
		ErrorCode     string   `json:"error_code,omitempty"`
		Message       string   `json:"message,omitempty"`
	}{
		SchemaVersion: "1.0", EntityID: entityID, Ts: ts, Adapter: Communication,
		Gen: res.Identity.Gen, Metering: res.Identity.HasMetering,
		Mode: res.Plan.Mode, ControlEnab: res.Plan.ControlEnabled, Wrote: res.Wrote,
		AllMatch: res.Verdict.AllMatch, Registers: regs,
		On: res.Verdict.On, PowerKw: res.Verdict.PowerKw, TimerS: res.Plan.TimerS,
		Reason: res.Plan.Reason, ErrorCode: res.ErrorCode, Message: res.Message,
	}
	b, _ := json.Marshal(payload)
	return b
}

// DriverConfig is the shelly slice of an entity driver block; ParseDriver
// returns the Config + whether the driver selects this executor.
type DriverConfig struct {
	Communication string          `json:"communication"`
	Connection    json.RawMessage `json:"connection"`
}

// ParseDriver extracts a shelly Config from an entity's opaque driver block.
// ok=false when the driver is absent, malformed, not a shelly driver, or
// carries no ip - a non-shelly / unconfigured entity is simply skipped.
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
