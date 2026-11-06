// Package kostalrtu is the Go twin of
// edge-app/nodered/kostal/kostal-piko-rtu-decode.js: the documented AUSWEG
// next to the Web-API (kostaldxs) - Modbus RTU over the PIKO's RS485
// terminal (protocol switched to "Modbus" at the device) through a
// transparent RS485-to-Ethernet gateway, the same hardware class
// edge-app/core/internal/kacoserial already drives for the Powador serial
// path.
//
// The register map is COMMUNITY-documented, not official (KOSTAL gives the
// "KOSTAL Modbus Interface - RS485" description only through its service) -
// see the JS module's header for the exact source and the reasoning why
// "Verbindung testen" cross-checks this path against the Web-API.
//
// No status/limitation register in this map (unlike the Web-API) - the
// community source does not document one; a guessed register would be
// wrong, not a missing field.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kostal/kostal-piko-rtu-vectors.json, GENERATED from the JS
// module (kostal-piko-rtu-vectors.gen.js); this package's test reads that
// file by path.
package kostalrtu

import "math"

// Family is the one decode family this package reads.
const Family = "kostal_piko_rtu"

// Known reports whether family is a family this decoder reads.
func Known(family string) bool { return family == Family }

// 19200 Baud, 8E1 (report §2.5/§3.2). Informational - no code path here.
const (
	BaudRate = 19200
	DataBits = 8
	Parity   = "even"
	StopBits = 1
)

// DefaultPort is the common TCP-server-mode port of a transparent RS485-to-
// Ethernet converter (the same device class as kacoserial.DefaultPort).
const DefaultPort = 8899

// Modbus device address range + the neutral suggested default (no documented
// KOSTAL factory value - [DBUS] shows address 3 as a field example, not a norm).
const (
	MinUnitID     = 1
	MaxUnitID     = 247
	DefaultUnitID = 1
)

// Register map (report §3.2; address = register label - 1, cross-checked
// against thenebu/dbus-kostal-piko's `read_holding_registers(client,
// 30001-1, 56)`).
const (
	RegDC1V = 30000
	RegDC1A = 30001
	RegDC1W = 30002
	RegDC2V = 30005
	RegDC2A = 30006
	RegDC2W = 30007
	RegDC3V = 30010
	RegDC3A = 30011
	RegDC3W = 30012

	RegL1V = 30015
	RegL1A = 30016
	RegL1W = 30017
	RegL2V = 30019
	RegL2A = 30020
	RegL2W = 30021
	RegL3V = 30023
	RegL3A = 30024
	RegL3W = 30025

	RegDCTotalW  = 30028
	RegACTotalW  = 30030 // the fast-tick channel (register label 30031)
	RegCosPhi    = 30032
	RegFrequency = 30033

	RegRatedW = 30043

	RegEnergyTotalHi  = 30050
	RegEnergyTotalLo  = 30051
	RegOperatingHours = 30053
	RegEnergyTodayWh  = 30055

	RegNameStart   = 30070
	RegNameCount   = 13
	RegSerialStart = 30083
	RegSerialCount = 13
)

// Block is one FC03 register read: Regs[0] is the register at address Start.
type Block struct {
	Start int
	Regs  []uint16
}

// BlockSpec is {start, count} for one FC03 request to issue.
type BlockSpec struct {
	Start int
	Count int
}

// FastBlockSpec reads just the AC total power register.
var FastBlockSpec = BlockSpec{Start: RegACTotalW, Count: 1}

// TestBlockSpecs reads the full map in 4 requests (DC/AC/frequency
// contiguous, then rated power, then energy/hours, then name/serial ASCII) -
// the connection test's one-shot diagnostic bundle.
var TestBlockSpecs = []BlockSpec{
	{Start: RegDC1V, Count: RegFrequency - RegDC1V + 1},
	{Start: RegRatedW, Count: 1},
	{Start: RegEnergyTotalHi, Count: RegEnergyTodayWh - RegEnergyTotalHi + 1},
	{Start: RegNameStart, Count: RegNameCount + RegSerialCount},
}

// WordAt finds a register's value across several blocks (undefined/0,false
// when no block covers it - never a fabricated 0 that looks real).
func WordAt(blocks []Block, address int) (uint16, bool) {
	for _, b := range blocks {
		i := address - b.Start
		if i >= 0 && i < len(b.Regs) {
			return b.Regs[i], true
		}
	}
	return 0, false
}

// Channel is one DC string or AC phase reading.
type Channel struct {
	VoltageV *float64
	CurrentA *float64
	PowerW   *float64
}

func channelSet(c Channel) bool { return c.VoltageV != nil || c.CurrentA != nil || c.PowerW != nil }

// Verbose is DecodeVerbose's full diagnostic (the connection test) - the Go
// twin of kostal-piko-rtu-decode.js decodeVerbose(). Every field is nil/zero
// when its register was not covered by any block - never a fabricated value.
type Verbose struct {
	PvPowerKw, AcKw, DcKw *float64
	Strings, Phases       [3]Channel
	FrequencyHz, CosPhi   *float64
	RatedW                *float64
	EnergyTotalKwh        *float64
	EnergyTodayKwh        *float64
	OperatingHours        *float64
	Name, Serial          string
}

// Result is decode's { reading }, mirroring kostaldxs.Result's shape
// (Reading only - no Meta on the fast path, DecodeVerbose carries the rest).
type Result struct {
	Reading map[string]float64
}

func fp(v float64) *float64 { return &v }

func round3(x float64) float64 {
	v := math.Floor(float64(x*1000)+0.5) / 1000
	if v == 0 {
		return 0
	}
	return v
}

func channelAt(blocks []Block, vAddr, aAddr, wAddr int) Channel {
	var ch Channel
	if v, ok := WordAt(blocks, vAddr); ok {
		ch.VoltageV = fp(round3(float64(v) / 10))
	}
	if a, ok := WordAt(blocks, aAddr); ok {
		ch.CurrentA = fp(round3(float64(a) / 100))
	}
	if w, ok := WordAt(blocks, wAddr); ok {
		ch.PowerW = fp(float64(w))
	}
	return ch
}

// Decode brings the FAST tick (FastBlockSpec) into the VoltPilot bus form:
// only pv_power_kw from the AC total power register, the same minimalism as
// kostaldxs.Decode. nil when the register was not read.
func Decode(blocks []Block) *Result {
	acW, ok := WordAt(blocks, RegACTotalW)
	if !ok {
		return nil
	}
	pv := float64(acW)
	if pv < 0 {
		pv = 0
	}
	return &Result{Reading: map[string]float64{"pv_power_kw": round3(pv / 1000)}}
}

// DecodeVerbose is the full diagnostic from TestBlockSpecs, the same form as
// kostaldxs's Meta so the built-in Gegenprobe (build-flows.js) can compare
// both sides channel by channel.
func DecodeVerbose(blocks []Block) Verbose {
	var v Verbose
	if acW, ok := WordAt(blocks, RegACTotalW); ok {
		ac := float64(acW)
		pv := ac
		if pv < 0 {
			pv = 0
		}
		v.PvPowerKw = fp(round3(pv / 1000))
		v.AcKw = fp(round3(ac / 1000))
	}
	if dcW, ok := WordAt(blocks, RegDCTotalW); ok {
		v.DcKw = fp(round3(float64(dcW) / 1000))
	}
	v.Strings[0] = channelAt(blocks, RegDC1V, RegDC1A, RegDC1W)
	v.Strings[1] = channelAt(blocks, RegDC2V, RegDC2A, RegDC2W)
	v.Strings[2] = channelAt(blocks, RegDC3V, RegDC3A, RegDC3W)
	v.Phases[0] = channelAt(blocks, RegL1V, RegL1A, RegL1W)
	v.Phases[1] = channelAt(blocks, RegL2V, RegL2A, RegL2W)
	v.Phases[2] = channelAt(blocks, RegL3V, RegL3A, RegL3W)
	if f, ok := WordAt(blocks, RegFrequency); ok {
		v.FrequencyHz = fp(round3(float64(f) / 10))
	}
	if c, ok := WordAt(blocks, RegCosPhi); ok {
		v.CosPhi = fp(round3(float64(c) / 100))
	}
	if r, ok := WordAt(blocks, RegRatedW); ok {
		v.RatedW = fp(float64(r))
	}
	if hi, okHi := WordAt(blocks, RegEnergyTotalHi); okHi {
		if lo, okLo := WordAt(blocks, RegEnergyTotalLo); okLo {
			v.EnergyTotalKwh = fp(round3(float64((uint32(hi)<<16)|uint32(lo)) / 1000))
		}
	}
	if d, ok := WordAt(blocks, RegEnergyTodayWh); ok {
		v.EnergyTodayKwh = fp(round3(float64(d) / 1000))
	}
	if h, ok := WordAt(blocks, RegOperatingHours); ok {
		v.OperatingHours = fp(float64(h))
	}
	v.Name = asciiBlock(blocks, RegNameStart, RegNameCount)
	v.Serial = asciiBlock(blocks, RegSerialStart, RegSerialCount)
	return v
}

// asciiBlock reads `count` registers as 2 ASCII characters each (high byte
// first), trimmed. "" when any register in the span was not read (the whole
// field is absent, not a partial string).
func asciiBlock(blocks []Block, start, count int) string {
	b := make([]byte, 0, count*2)
	for i := 0; i < count; i++ {
		w, ok := WordAt(blocks, start+i)
		if !ok {
			return ""
		}
		b = append(b, byte(w>>8), byte(w))
	}
	// Stop at the first NUL byte, like a C string.
	if i := indexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return trimASCII(string(b))
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

func trimASCII(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}
