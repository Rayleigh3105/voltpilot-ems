// Package modbusgeraet holds the PURE half of the self-built Modbus device with
// several values to read AND write (Steuerlogik K3, docs/contracts/v2/
// modbus-geraet.md): an air conditioner, a heat pump or a cold-room controller
// the installer describes register by register. It reads the definition the
// cloud pushes in driver.connection, checks it with the same rules as the API
// (shared vectors docs/contracts/v2/modbus-geraet-vectors.json), decodes what
// the device answers and plans what to write.
//
// It touches nothing - no socket, no clock. The executor in internal/agent
// owns the one connection per device and runs reads and writes through it.
//
// The device REGULATES ITSELF (report §15.1): the box moves its setpoint in °C
// inside the released band, picks its operating mode from the closed list the
// installer mapped, switches its enable on or off - and leaves it at its rest
// values whenever there is no granted wish or the device reports a fault (never
// work against a fault of the device, §15.6). With the plant's control gate shut
// it writes nothing at all, like every other driver.
package modbusgeraet

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
)

// Communication is the driver word the cloud and the box share for every
// self-built device (componentapply.CommunicationSelfBuild).
const Communication = "modbus_baukasten"

// Limits of one definition (the poll budget of the Baukasten plus the K3
// write budget).
const (
	MaxChannels             = 16
	MaxControls             = 3 // one per kind: on_off, setpoint_c, mode
	MaxModes                = 8
	MinReadIntervalS        = 5
	DefaultChangeIntervalS  = 60
	MinChangeIntervalS      = 10
	MaxChangeIntervalS      = 3600
	MaxRaw                  = 65535
	FcCoil                  = 5
	FcSingle                = 6
	FcMultiple              = 16
	DefaultRegisterFC       = FcMultiple
	maxAddress              = 65535
	defaultPort             = 502
	defaultUnit             = 1
	controlKindOnOff        = entities.CmdOnOff
	controlKindSetpointC    = entities.CmdSetpointC
	controlKindMode         = entities.CmdMode
	registerHolding         = "holding"
	registerInput           = "input"
	registerCoil            = "coil"
	registerDiscrete        = "discrete"
	unitCelsius             = "°C"
	unitPercent             = "%"
	signalFault             = "fault"
	defaultReadDataType     = "u16"
	defaultSetpointDataType = "s16"
)

// Signals are the words of the Steuerlogik word list (steuerlogik-woerter.json,
// table "signal") a channel may carry: a logic reads <entity>.<signal>.
var Signals = []string{"temperature", "room_temperature", "open", "door_open", "defrost", "fault", "running",
	"humidity", "outdoor_temperature", "supply_temperature", "return_temperature"}

// BoolSignals are read as yes/no: a bit, a coil or a discrete input.
var BoolSignals = map[string]bool{"open": true, "door_open": true, "defrost": true, "fault": true, "running": true}

func temperatureSignal(s string) bool { return strings.HasSuffix(s, "temperature") }

var slugRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// Register is one Modbus location. Bit selects one bit of a 16-bit register
// (status bits); DataType is ignored for coils and discrete inputs.
type Register struct {
	Kind      string `json:"kind"`
	Address   int    `json:"address"`
	DataType  string `json:"data_type,omitempty"`
	WordOrder string `json:"word_order,omitempty"`
	Bit       *int   `json:"bit,omitempty"`
}

// Count is the number of registers (or bits) a read needs.
func (r Register) Count() int {
	switch r.DataType {
	case "u32", "s32", "float32":
		return 2
	}
	return 1
}

// IsBit reports whether the register yields a yes/no (coil, discrete input or
// one bit of a register).
func (r Register) IsBit() bool {
	return r.Kind == registerCoil || r.Kind == registerDiscrete || r.Bit != nil
}

// Channel is one read value.
type Channel struct {
	Slug            string   `json:"slug"`
	Label           string   `json:"label"`
	Unit            string   `json:"unit"`
	Signal          string   `json:"signal,omitempty"`
	Register        Register `json:"register"`
	Scale           *float64 `json:"scale,omitempty"`
	Offset          *float64 `json:"offset,omitempty"`
	MinReadInterval int      `json:"min_read_interval_s,omitempty"`
}

// Control is one write value: on_off, setpoint_c or mode.
type Control struct {
	Slug     string          `json:"slug"`
	Label    string          `json:"label"`
	Kind     string          `json:"kind"`
	Register Register        `json:"register"`
	WriteFC  int             `json:"write_fc,omitempty"`
	Readback *Register       `json:"readback,omitempty"`
	Rest     json.RawMessage `json:"rest"`
	// on_off
	OnValue  *int `json:"on_value,omitempty"`
	OffValue *int `json:"off_value,omitempty"`
	// setpoint_c
	Scale  *float64 `json:"scale,omitempty"`
	Offset *float64 `json:"offset,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
	Step   *float64 `json:"step,omitempty"`
	// mode: Steuerlogik word -> register value
	Modes map[string]int `json:"modes,omitempty"`
}

// Controls is the write block of a definition.
type Controls struct {
	MinChangeIntervalS *int      `json:"min_change_interval_s,omitempty"`
	WatchdogAddress    *int      `json:"watchdog_address,omitempty"`
	WatchdogValue      *int      `json:"watchdog_value,omitempty"`
	Values             []Control `json:"values"`
	// Freigabe is set by the cloud after the guided test and the installer's
	// confirmation; without it the box writes nothing.
	Freigabe json.RawMessage `json:"freigabe,omitempty"`
}

// Definition is the self-built device as the cloud stores it in
// driver.connection.
type Definition struct {
	SchemaVersion int `json:"schema_version,omitempty"`
	Transport     struct {
		Host   string `json:"host"`
		Port   *int   `json:"port,omitempty"`
		UnitID *int   `json:"unit_id,omitempty"`
	} `json:"transport"`
	Channels []Channel `json:"channels"`
	Controls *Controls `json:"controls,omitempty"`
}

// Port and Unit with their defaults.
func (d Definition) Port() int {
	if d.Transport.Port == nil {
		return defaultPort
	}
	return *d.Transport.Port
}

// Unit is the Modbus unit id (default 1).
func (d Definition) Unit() int {
	if d.Transport.UnitID == nil {
		return defaultUnit
	}
	return *d.Transport.UnitID
}

// Released reports whether the write block carries the cloud's release.
func (d Definition) Released() bool {
	return d.Controls != nil && len(d.Controls.Freigabe) > 0 && string(d.Controls.Freigabe) != "null"
}

// ChangeInterval of the device (default 60 s).
func (d Definition) ChangeInterval() int {
	if d.Controls == nil || d.Controls.MinChangeIntervalS == nil {
		return DefaultChangeIntervalS
	}
	return *d.Controls.MinChangeIntervalS
}

// Control returns the write value of one kind, or nil.
func (d Definition) Control(kind string) *Control {
	if d.Controls == nil {
		return nil
	}
	for i := range d.Controls.Values {
		if d.Controls.Values[i].Kind == kind {
			return &d.Controls.Values[i]
		}
	}
	return nil
}

// ChannelForSignal returns the channel that carries a signal, or nil.
func (d Definition) ChannelForSignal(signal string) *Channel {
	for i := range d.Channels {
		if d.Channels[i].Signal == signal {
			return &d.Channels[i]
		}
	}
	return nil
}

// Fehler is one refusal of the rules: a stable code (shared with the API's
// twin through the vectors) and where it sits.
type Fehler struct {
	Code string
	Wo   string
}

func (f Fehler) Error() string { return f.Code + " (" + f.Wo + ")" }

// The refusal codes (modbus-geraet-vectors.json; the API words them in German).
const (
	ErrTransport        = "transport"
	ErrChannelCount     = "channel_count"
	ErrChannelSlug      = "channel_slug"
	ErrRegister         = "register"
	ErrDataType         = "data_type"
	ErrBit              = "bit"
	ErrSignal           = "signal"
	ErrSignalTwice      = "signal_twice"
	ErrSignalUnit       = "signal_unit"
	ErrSignalBool       = "signal_bool"
	ErrInterval         = "read_interval"
	ErrControlCount     = "control_count"
	ErrControlKind      = "control_kind"
	ErrControlTwice     = "control_twice"
	ErrControlSlug      = "control_slug"
	ErrWriteFC          = "write_fc"
	ErrOnOffValues      = "on_off_values"
	ErrScale            = "scale"
	ErrBand             = "band"
	ErrStep             = "step"
	ErrRawRange         = "raw_range"
	ErrModes            = "modes"
	ErrModeWord         = "mode_word"
	ErrRest             = "rest"
	ErrChangeInterval   = "change_interval"
	ErrWatchdog         = "watchdog"
	ErrReadback         = "readback"
	ErrReadbackDataType = "readback_data_type"
)

// Lies reads and checks a definition. Every rule that can refuse a write lives
// here and in its API twin; the box re-checks what it got from the cloud
// (the cloud is believed nothing).
func Lies(raw json.RawMessage) (Definition, []Fehler) {
	var d Definition
	if err := json.Unmarshal(raw, &d); err != nil {
		return d, []Fehler{{ErrTransport, "definition: " + err.Error()}}
	}
	return d, Pruefe(d)
}

// Pruefe applies the rules to a parsed definition and collects ALL refusals.
func Pruefe(d Definition) []Fehler {
	var out []Fehler
	fehl := func(code, wo string) { out = append(out, Fehler{code, wo}) }

	if strings.TrimSpace(d.Transport.Host) == "" || d.Port() < 1 || d.Port() > 65535 || d.Unit() < 0 || d.Unit() > 255 {
		fehl(ErrTransport, "transport")
	}
	if len(d.Channels) > MaxChannels {
		fehl(ErrChannelCount, "channels")
	}
	slugs := map[string]bool{}
	signale := map[string]bool{}
	for i, c := range d.Channels {
		wo := fmt.Sprintf("channels[%d]", i)
		if !slugRe.MatchString(c.Slug) || slugs[c.Slug] {
			fehl(ErrChannelSlug, wo)
		}
		slugs[c.Slug] = true
		pruefeRegister(c.Register, wo, true, fehl)
		if c.MinReadInterval != 0 && c.MinReadInterval < MinReadIntervalS {
			fehl(ErrInterval, wo)
		}
		if c.Signal == "" {
			continue
		}
		if !enthaelt(Signals, c.Signal) {
			fehl(ErrSignal, wo)
			continue
		}
		if signale[c.Signal] {
			fehl(ErrSignalTwice, wo)
		}
		signale[c.Signal] = true
		switch {
		case BoolSignals[c.Signal] && !c.Register.IsBit():
			fehl(ErrSignalBool, wo)
		case !BoolSignals[c.Signal] && c.Register.IsBit():
			fehl(ErrSignalBool, wo)
		case temperatureSignal(c.Signal) && c.Unit != unitCelsius:
			fehl(ErrSignalUnit, wo)
		case c.Signal == "humidity" && c.Unit != unitPercent:
			fehl(ErrSignalUnit, wo)
		}
	}
	if d.Controls == nil {
		return out
	}
	cs := d.Controls
	if len(cs.Values) == 0 || len(cs.Values) > MaxControls {
		fehl(ErrControlCount, "controls.values")
	}
	if cs.MinChangeIntervalS != nil && (*cs.MinChangeIntervalS < MinChangeIntervalS || *cs.MinChangeIntervalS > MaxChangeIntervalS) {
		fehl(ErrChangeInterval, "controls.min_change_interval_s")
	}
	if cs.WatchdogAddress != nil {
		v := 0
		if cs.WatchdogValue != nil {
			v = *cs.WatchdogValue
		}
		if *cs.WatchdogAddress < 0 || *cs.WatchdogAddress > maxAddress || v < 0 || v > MaxRaw {
			fehl(ErrWatchdog, "controls.watchdog_address")
		}
	}
	arten := map[string]bool{}
	for i, c := range cs.Values {
		wo := fmt.Sprintf("controls.values[%d]", i)
		if !slugRe.MatchString(c.Slug) || slugs[c.Slug] {
			fehl(ErrControlSlug, wo)
		}
		slugs[c.Slug] = true
		switch c.Kind {
		case controlKindOnOff, controlKindSetpointC, controlKindMode:
		default:
			fehl(ErrControlKind, wo)
			continue
		}
		if arten[c.Kind] {
			fehl(ErrControlTwice, wo)
		}
		arten[c.Kind] = true
		pruefeControl(c, wo, fehl)
	}
	return out
}

func pruefeRegister(r Register, wo string, lesen bool, fehl func(code, wo string)) {
	switch r.Kind {
	case registerHolding, registerInput:
		switch r.DataType {
		case "", "u16", "s16", "u32", "s32", "float32":
		default:
			fehl(ErrDataType, wo)
		}
		if r.Bit != nil && (*r.Bit < 0 || *r.Bit > 15 || r.Count() != 1) {
			fehl(ErrBit, wo)
		}
	case registerCoil, registerDiscrete:
		if r.Bit != nil {
			fehl(ErrBit, wo)
		}
	default:
		fehl(ErrRegister, wo)
	}
	if r.Address < 0 || r.Address > maxAddress || r.Address+r.Count()-1 > maxAddress {
		fehl(ErrRegister, wo)
	}
	if !lesen && r.Kind != registerHolding && r.Kind != registerCoil {
		fehl(ErrRegister, wo)
	}
}

func pruefeControl(c Control, wo string, fehl func(code, wo string)) {
	pruefeRegister(c.Register, wo, false, fehl)
	if c.Register.Bit != nil {
		fehl(ErrBit, wo)
	}
	coil := c.Register.Kind == registerCoil
	fc := c.EffectiveFC()
	if (coil && fc != FcCoil) || (!coil && fc != FcSingle && fc != FcMultiple) {
		fehl(ErrWriteFC, wo)
	}
	if c.Register.Kind == registerHolding && c.Register.DataType != "" && c.Register.DataType != "u16" && c.Register.DataType != "s16" {
		fehl(ErrDataType, wo)
	}
	if c.Readback != nil {
		pruefeRegister(*c.Readback, wo+".readback", true, fehl)
		if c.Readback.Bit != nil || c.Readback.Count() != 1 {
			fehl(ErrReadbackDataType, wo+".readback")
		}
		// A coil is read back as a bit, a register as a word.
		if bitRB := c.Readback.Kind == registerCoil || c.Readback.Kind == registerDiscrete; bitRB != coil {
			fehl(ErrReadback, wo+".readback")
		}
	}
	switch c.Kind {
	case controlKindOnOff:
		if c.OnValue == nil || c.OffValue == nil || !inRaw(*c.OnValue) || !inRaw(*c.OffValue) ||
			*c.OnValue == *c.OffValue || (coil && (*c.OnValue > 1 || *c.OffValue > 1)) {
			fehl(ErrOnOffValues, wo)
		}
		var b bool
		if json.Unmarshal(c.Rest, &b) != nil {
			fehl(ErrRest, wo)
		}
	case controlKindSetpointC:
		if coil {
			fehl(ErrRegister, wo)
			return
		}
		if c.scale() == 0 || math.IsNaN(c.scale()) || math.IsInf(c.scale(), 0) || math.IsNaN(c.offset()) {
			fehl(ErrScale, wo)
			return
		}
		if c.Min == nil || c.Max == nil || !(*c.Min < *c.Max) {
			fehl(ErrBand, wo)
			return
		}
		if c.Step != nil && !(*c.Step > 0 && *c.Step <= *c.Max-*c.Min) {
			fehl(ErrStep, wo)
		}
		var rest float64
		if json.Unmarshal(c.Rest, &rest) != nil || rest < *c.Min || rest > *c.Max {
			fehl(ErrRest, wo)
			return
		}
		for _, v := range []float64{*c.Min, *c.Max, rest} {
			if _, ok := c.rawSetpoint(v); !ok {
				fehl(ErrRawRange, wo)
				break
			}
		}
	case controlKindMode:
		if coil {
			fehl(ErrRegister, wo)
			return
		}
		if len(c.Modes) == 0 || len(c.Modes) > MaxModes {
			fehl(ErrModes, wo)
			return
		}
		rohe := map[int]bool{}
		for w, r := range c.Modes {
			if !enthaelt(logik.Betriebsarten, w) {
				fehl(ErrModeWord, wo)
			}
			if !inRaw(r) || rohe[r] {
				fehl(ErrModes, wo)
			}
			rohe[r] = true
		}
		var rest string
		if json.Unmarshal(c.Rest, &rest) != nil {
			fehl(ErrRest, wo)
		} else if _, ok := c.Modes[rest]; !ok {
			fehl(ErrRest, wo)
		}
	}
}

// EffectiveFC is the write function code (coil: 5, register: 16 by default -
// a single-register write is accepted but not taken over by several real
// devices, the Baukasten lesson).
func (c Control) EffectiveFC() int {
	if c.WriteFC != 0 {
		return c.WriteFC
	}
	if c.Register.Kind == registerCoil {
		return FcCoil
	}
	return DefaultRegisterFC
}

func (c Control) scale() float64 {
	if c.Scale == nil {
		return 1
	}
	return *c.Scale
}

func (c Control) offset() float64 {
	if c.Offset == nil {
		return 0
	}
	return *c.Offset
}

func (c Control) dataType() string {
	if c.Register.DataType == "" {
		return defaultSetpointDataType
	}
	return c.Register.DataType
}

// rawSetpoint turns °C into the register word: (v - offset) / scale, rounded
// half away from zero, as two's complement for s16. ok=false when the word
// cannot hold it.
func (c Control) rawSetpoint(v float64) (uint16, bool) {
	r := math.Round((v - c.offset()) / c.scale())
	switch c.dataType() {
	case "s16":
		if r < -32768 || r > 32767 {
			return 0, false
		}
		return uint16(int16(r)), true
	default:
		if r < 0 || r > MaxRaw {
			return 0, false
		}
		return uint16(r), true
	}
}

// Band is the released band and step of a setpoint_c control.
func (c Control) Band() (min, max float64, step *float64) {
	return *c.Min, *c.Max, c.Step
}

// RestSetpoint, RestMode and RestOn read the rest value of a control.
func (c Control) RestSetpoint() float64 {
	var v float64
	_ = json.Unmarshal(c.Rest, &v)
	return v
}

// RestMode is the rest word of a mode control.
func (c Control) RestMode() string {
	var v string
	_ = json.Unmarshal(c.Rest, &v)
	return v
}

// RestOn is the rest state of an on_off control.
func (c Control) RestOn() bool {
	var v bool
	_ = json.Unmarshal(c.Rest, &v)
	return v
}

// ModeWords lists the mode words of a mode control in a stable order (the
// order of the Steuerlogik's closed list).
func (c Control) ModeWords() []string {
	var out []string
	for _, w := range logik.Betriebsarten {
		if _, ok := c.Modes[w]; ok {
			out = append(out, w)
		}
	}
	return out
}

// --- decode --------------------------------------------------------------------

// Decode turns the answered registers (or bits) of a channel into its value:
// raw * scale + offset, a yes/no as 1 or 0. ok=false for an answer that does
// not fit - never a fabricated value.
func Decode(r Register, regs []uint16, bits []bool, scale, offset float64) (float64, bool) {
	switch r.Kind {
	case registerCoil, registerDiscrete:
		if len(bits) < 1 {
			return 0, false
		}
		if bits[0] {
			return 1, true
		}
		return 0, true
	}
	if len(regs) < r.Count() {
		return 0, false
	}
	if r.Bit != nil {
		if regs[0]&(1<<uint(*r.Bit)) != 0 {
			return 1, true
		}
		return 0, true
	}
	w0 := regs[0]
	var raw float64
	switch r.DataType {
	case "", "u16":
		raw = float64(w0)
	case "s16":
		raw = float64(int16(w0))
	default:
		w1 := regs[1]
		hi, lo := w0, w1
		if r.WordOrder == "little" {
			hi, lo = w1, w0
		}
		u := uint32(hi)<<16 | uint32(lo)
		switch r.DataType {
		case "u32":
			raw = float64(u)
		case "s32":
			raw = float64(int32(u))
		case "float32":
			raw = float64(math.Float32frombits(u))
		}
	}
	v := raw*scale + offset
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// ChannelScale returns scale and offset of a channel (defaults 1 and 0).
func (c Channel) ChannelScale() (float64, float64) {
	s, o := 1.0, 0.0
	if c.Scale != nil {
		s = *c.Scale
	}
	if c.Offset != nil {
		o = *c.Offset
	}
	return s, o
}

// --- plan ----------------------------------------------------------------------

// Write is one planned register write.
type Write struct {
	Slug    string `json:"slug"`
	Kind    string `json:"kind"`
	Address int    `json:"address"`
	FC      int    `json:"fc"`
	Raw     uint16 `json:"raw"`
	// Value is what the raw word means: °C, a mode word, on/off.
	Value any `json:"value"`
	// Rest marks a rest value (no wish, gate shut, fault).
	Rest bool `json:"rest"`
}

// Lage is what the executor knows when it plans.
type Lage struct {
	// Gate: the plant's control gate is open (both box switches) - shut means
	// rest values only.
	Gate bool
	// Fault: the device reports a fault, or its declared fault channel has no
	// fresh value (unknown is no "no fault").
	Fault bool
}

// Plan derives the writes for the granted commands. Every control gets a
// value: the granted one, else its rest value. With a fault every control gets
// its rest value; with the gate shut (or no release) nothing is written. Values are clamped again here (the guard
// chain clamped before; an executor never trusts its input).
func Plan(d Definition, granted entities.Commands, l Lage) ([]Write, string) {
	if d.Controls == nil {
		return nil, ""
	}
	grund := ""
	nurRuhe := false
	switch {
	case !d.Released():
		return nil, "nicht_freigegeben"
	case !l.Gate:
		// control_enabled false: the driver layer writes nothing at all (the
		// command contract), not even rest values - the plant's two switches
		// are the operator's hand on the box.
		return nil, "steuerung_aus"
	case l.Fault:
		nurRuhe, grund = true, "geraet_stoerung"
	}
	var out []Write
	for _, c := range d.Controls.Values {
		w := Write{Slug: c.Slug, Kind: c.Kind, Address: c.Register.Address, FC: c.EffectiveFC()}
		switch c.Kind {
		case controlKindOnOff:
			on := c.RestOn()
			w.Rest = true
			if !nurRuhe && granted.OnOff != nil {
				on, w.Rest = *granted.OnOff, false
			}
			w.Value = on
			if on {
				w.Raw = uint16(*c.OnValue)
			} else {
				w.Raw = uint16(*c.OffValue)
			}
		case controlKindSetpointC:
			v := c.RestSetpoint()
			w.Rest = true
			if !nurRuhe && granted.SetpointC != nil {
				v, w.Rest = *granted.SetpointC, false
			}
			min, max, step := c.Band()
			v = entities.RoundSetpointC(v, min, max, step)
			raw, ok := c.rawSetpoint(v)
			if !ok {
				continue // cannot happen for a checked definition
			}
			w.Raw, w.Value = raw, v
		case controlKindMode:
			m := c.RestMode()
			w.Rest = true
			if !nurRuhe && granted.Mode != "" {
				if _, ok := c.Modes[granted.Mode]; ok {
					m, w.Rest = granted.Mode, false
				}
			}
			w.Raw, w.Value = uint16(c.Modes[m]), m
		}
		out = append(out, w)
	}
	return out, grund
}

// Ist is the read-back state of the write values; nil/"" = unknown.
type Ist struct {
	On       *bool    `json:"on,omitempty"`
	Setpoint *float64 `json:"setpoint_c,omitempty"`
	Mode     string   `json:"mode,omitempty"`
}

// ReadbackRegister is where a control's state is read back: its readback
// register, else the write register itself.
func (c Control) ReadbackRegister() Register {
	if c.Readback != nil {
		r := *c.Readback
		if r.DataType == "" && c.Kind == controlKindSetpointC {
			r.DataType = c.dataType()
		}
		return r
	}
	r := c.Register
	if c.Kind == controlKindSetpointC {
		r.DataType = c.dataType()
	}
	return r
}

// Interpret reads the read-back word (or bit) of a control. A word that
// maps to no declared value is unknown, never a guess.
func (c Control) Interpret(regs []uint16, bits []bool, ist *Ist) {
	r := c.ReadbackRegister()
	switch c.Kind {
	case controlKindOnOff:
		var raw int
		switch {
		case r.Kind == registerCoil || r.Kind == registerDiscrete:
			if len(bits) < 1 {
				return
			}
			if bits[0] {
				raw = 1
			}
		case len(regs) >= 1:
			raw = int(regs[0])
		default:
			return
		}
		switch raw {
		case *c.OnValue:
			on := true
			ist.On = &on
		case *c.OffValue:
			off := false
			ist.On = &off
		}
	case controlKindSetpointC:
		v, ok := Decode(r, regs, bits, c.scale(), c.offset())
		if ok {
			v = math.Round(v*1e6) / 1e6
			ist.Setpoint = &v
		}
	case controlKindMode:
		if len(regs) < 1 {
			return
		}
		for w, raw := range c.Modes {
			if raw == int(regs[0]) {
				ist.Mode = w
			}
		}
	}
}

func inRaw(v int) bool { return v >= 0 && v <= MaxRaw }

func enthaelt(liste []string, w string) bool {
	for _, x := range liste {
		if x == w {
			return true
		}
	}
	return false
}
