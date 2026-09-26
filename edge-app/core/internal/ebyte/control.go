package ebyte

// The per-channel consumer CONTROL mapping: arbitrated command -> relay plan ->
// readback verdict. One consumer entity owns ONE relay output of an I/O module;
// its driver names the module's local source and the channel, never a second
// connection (the module has exactly one socket owner, the core).
//
// The relay semantics are the Shelly ones (a relay delivers 0 or RATED, the
// §4.2 failsafe of a heating rod is OFF, no neutral to release into), and so is
// the gate: the executor only runs behind VP_CONTROL_ENABLED AND
// VP_CONSUMER_CONTROL_ENABLED. What differs is the dead-man: it is not carried
// by each ON write but configured once on the device (the offline fault
// output), so an ON is refused while the device watchdog is not armed.

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Command is the arbitrated, already guard-clamped consumer command.
type Command struct {
	SetpointKw     *float64
	OnOff          *bool
	ControlEnabled bool
	Stale          bool // no arbiter decision -> fail-safe OFF
}

const onKwThreshold = 0.005

// Reason strings (German, surface-verbatim).
const (
	reasonFailsafeOff = "Failsafe: ohne frischen Befehl bleibt der Ausgang aus"
	reasonBelowRated  = "Sollwert unter der Nennleistung - der Ausgang bleibt aus (nie mehr liefern als befohlen)"
	reasonKillSwitch  = "Steuerung deaktiviert (Not-Aus)"
	ReasonNoWatchdog  = "Einschalten verweigert: der Geräte-Watchdog des I/O-Moduls ist nicht eingerichtet"
	reasonWatchdog    = "Einschalten mit Geräte-Watchdog (Totmann-Schutz)"
)

// Plan is the pure write intent for one channel.
type Plan struct {
	Channel        int
	ControlEnabled bool
	Mode           string // "on" | "off"
	On             bool
	Write          bool
	Reason         string
}

// PlanFor maps a command onto the channel plan. ratedKw > 0 enables the
// restrict-only snap of a bare sub-rated setpoint.
func PlanFor(channel int, ratedKw float64, cmd Command) Plan {
	hasSetpoint := cmd.SetpointKw != nil && !math.IsNaN(*cmd.SetpointKw) && !math.IsInf(*cmd.SetpointKw, 0)
	var mode, reason string
	switch {
	case cmd.Stale || (cmd.OnOff == nil && !hasSetpoint):
		mode, reason = "off", reasonFailsafeOff
	case cmd.OnOff != nil:
		mode = map[bool]string{true: "on", false: "off"}[*cmd.OnOff]
	case *cmd.SetpointKw <= onKwThreshold:
		mode = "off"
	case ratedKw > 0 && *cmd.SetpointKw < ratedKw*(1-1e-6):
		mode, reason = "off", reasonBelowRated
	default:
		mode = "on"
	}
	p := Plan{Channel: channel, ControlEnabled: cmd.ControlEnabled, Mode: mode, On: mode == "on", Reason: reason}
	if p.On && p.Reason == "" {
		p.Reason = reasonWatchdog
	}
	if cmd.ControlEnabled {
		p.Write = true
	} else {
		p.Reason = reasonKillSwitch
	}
	return p
}

// Register is the commanded-vs-actual relay readback entry (1 = on, 0 = off).
type Register struct {
	Role      string `json:"role"`
	Key       string `json:"key"`
	Commanded int    `json:"commanded"`
	Actual    *int   `json:"actual"`
	Match     bool   `json:"match"`
}

// Result is the outcome of one channel pass.
type Result struct {
	OK        bool
	Wrote     bool
	Plan      Plan
	Actual    *bool // the output state read back (nil = not read)
	ErrorCode string
	Message   string
}

// OutputKey names a relay output channel ("do_3").
func OutputKey(channel int) string { return "do_" + strconv.Itoa(channel) }

// InputKey names a digital input channel ("di_3").
func InputKey(channel int) string { return "di_" + strconv.Itoa(channel) }

// Verdict evaluates the readback of a written plan. AllMatch stays nil when
// nothing was written (readback-only) or nothing was read.
func (r Result) Verdict() ([]Register, *bool) {
	if !r.Wrote && !r.Plan.Write {
		return nil, nil
	}
	commanded := 0
	if r.Plan.On {
		commanded = 1
	}
	reg := Register{Role: "relay", Key: OutputKey(r.Plan.Channel), Commanded: commanded}
	if r.Actual == nil {
		return []Register{reg}, nil
	}
	a := 0
	if *r.Actual {
		a = 1
	}
	reg.Actual, reg.Match = &a, a == commanded
	m := reg.Match
	return []Register{reg}, &m
}

// ReadbackPayload renders edge/entities/{id}/readback (v1 readback shape; the
// core's onEntityReadback consumes all_match). A failed pass carries its
// error_code and no all_match, so "no evidence" never reads like a mismatch.
func ReadbackPayload(entityID, ts string, res Result) []byte {
	regs, allMatch := []Register{}, (*bool)(nil)
	if res.OK {
		regs, allMatch = res.Verdict()
		if regs == nil {
			regs = []Register{}
		}
	}
	payload := struct {
		SchemaVersion string     `json:"schema_version"`
		EntityID      string     `json:"entity_id"`
		Ts            string     `json:"ts"`
		Adapter       string     `json:"adapter"`
		Channel       int        `json:"channel"`
		Mode          string     `json:"mode"`
		ControlEnab   bool       `json:"control_enabled"`
		Wrote         bool       `json:"wrote"`
		AllMatch      *bool      `json:"all_match"`
		Registers     []Register `json:"registers"`
		On            *bool      `json:"on,omitempty"`
		Reason        string     `json:"reason,omitempty"`
		ErrorCode     string     `json:"error_code,omitempty"`
		Message       string     `json:"message,omitempty"`
	}{
		SchemaVersion: "1.0", EntityID: entityID, Ts: ts, Adapter: Communication,
		Channel: res.Plan.Channel, Mode: res.Plan.Mode, ControlEnab: res.Plan.ControlEnabled,
		Wrote: res.Wrote, AllMatch: allMatch, Registers: regs, On: res.Actual,
		Reason: res.Plan.Reason, ErrorCode: res.ErrorCode, Message: res.Message,
	}
	b, _ := json.Marshal(payload)
	return b
}

// ChannelDriver is the driver block of a consumer entity bound to one output
// of an I/O module: the module's ENTITY id (the device component in the same
// registry) and the 1-based channel. It deliberately carries no connection -
// the box resolves the module's connection from the device entity's own
// driver, so a changed module address is one edit in one place, and an older
// box (componentapply skips connection-less drivers) ignores it harmlessly.
type ChannelDriver struct {
	Communication string  `json:"communication"`
	IOEntityID    string  `json:"io_entity_id"`
	Channel       int     `json:"channel"`
	RatedPowerKw  float64 `json:"rated_power_kw,omitempty"`
}

// ParseChannelDriver extracts the channel binding of a consumer entity.
// ok=false for any other driver (including the module's own device driver,
// which carries a connection and no channel).
func ParseChannelDriver(driver []byte) (ChannelDriver, bool) {
	if len(driver) == 0 {
		return ChannelDriver{}, false
	}
	var d ChannelDriver
	if json.Unmarshal(driver, &d) != nil || d.Communication != Communication {
		return ChannelDriver{}, false
	}
	d.IOEntityID = strings.TrimSpace(d.IOEntityID)
	if d.IOEntityID == "" || d.Channel < 1 || d.Channel > MaxChannels {
		return ChannelDriver{}, false
	}
	return d, true
}

// DeviceDriver is the driver block of the I/O module's own device entity.
type DeviceDriver struct {
	Communication string          `json:"communication"`
	Connection    json.RawMessage `json:"connection"`
}

// ParseDeviceDriver extracts the module connection from its device entity.
// ok=false when the driver is not an ebyte device driver or names no IP.
func ParseDeviceDriver(driver []byte) (Config, bool) {
	if len(driver) == 0 {
		return Config{}, false
	}
	var d DeviceDriver
	if json.Unmarshal(driver, &d) != nil || d.Communication != Communication || len(d.Connection) == 0 {
		return Config{}, false
	}
	var cfg Config
	if json.Unmarshal(d.Connection, &cfg) != nil || strings.TrimSpace(cfg.IP) == "" {
		return Config{}, false
	}
	cfg.Channel = 0
	return cfg, true
}
