// Package kacoserial is the Go twin of edge-app/nodered/kaco/kaco-serial-decode.js:
// KACO's own serial ASCII protocol of the Powador generation BEFORE the
// TL3/Ethernet line (Powador 2500xi..8000xi and the older non-"xi" single-phase
// units such as the Powador 3200 - INT). These devices speak NO Modbus: the
// box asks `#<address><command>\r` over RS485 (9600 8N1, bus address 1-32) and
// gets one fixed-width ASCII line back. VoltPilot reaches the bus through a
// TRANSPARENT RS485-to-Ethernet converter (Waveshare "RS485 TO ETH" class, TCP
// server mode) - the bytes are the same, only the transport is TCP.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kaco/kaco-serial-vectors.json, GENERATED from the JS module
// (kaco-serial-vectors.gen.js); this package's test reads that file by path.
// Numbers are parsed like JavaScript's Number() on an 'ascii'-decoded field (an
// empty field is 0, the high bit of every byte is dropped), rounding is
// Math.round (half towards +Infinity).
//
// Read only: this device generation has no remote control, nothing is ever
// written. Protocol source and the on-device checklist: nodered/KACO.md §11,
// nodered/kaco/POWADOR-RS485-CHECKLISTE.md.
package kacoserial

import (
	"bytes"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Bus address range (KACO operating manual 31001135-06: 1-32, never 0).
const (
	MinAddress = 1
	MaxAddress = 32
)

// Defaults of the module: the converter's usual TCP-server port (not a KACO
// norm - every converter sets its own) and the lowest valid bus address.
const (
	DefaultPort    = 8899
	DefaultAddress = MinAddress
)

// Family is the one decode family of the module (FAMILIES).
const Family = "kaco_serial"

// Known reports whether family is a family this decoder reads.
func Known(family string) bool { return family == Family }

// CmdMeasure is command "0": the live values (status, voltage/current/power,
// temperature, daily yield).
const CmdMeasure byte = '0'

const (
	lf = 0x0a
	cr = 0x0d
)

// knownReplyCommands are the command bytes of KACO's protocol variants this
// decoder RECOGNISES in a reply head (APL_RS485protocol_KACO 1.4, table 3) - an
// unknown byte (e.g. 'n' of the CRC16 variant, '4' of the "000xi" park units)
// is another protocol of the brand, never guessed at.
var knownReplyCommands = map[byte]bool{'0': true, '3': true, '8': true, '9': true, 's': true}

// Fixed field offsets of the command-"0" reply, counted from the LF (the
// module's CMD0_OFFSETS; verified against real 6400xi/8000xi recordings).
type span struct{ from, to int }

var (
	offStatus       = span{6, 9}
	offDcVoltage    = span{10, 15}
	offDcCurrent    = span{16, 21}
	offDcPower      = span{22, 27}
	offAcVoltage    = span{28, 33}
	offAcCurrent    = span{34, 39}
	offAcPower      = span{40, 45}
	offTemperature  = span{46, 49}
	offDailyYieldWh = span{50, 56}
)

const (
	offChecksumSp = 56 // the last byte that enters the sum
	offChecksum   = 57 // the checksum byte itself - then optional " <type>\r"
)

// Cmd0MinLen is the shortest complete command-"0" frame (checksum included).
const Cmd0MinLen = offChecksum + 1

// BuildRequest is the module's buildRequest: `#<2-digit address><command>\r`.
func BuildRequest(address int, command byte) ([]byte, error) {
	if address < MinAddress || address > MaxAddress {
		return nil, fmt.Errorf("address must be an integer 1..32, got %d", address)
	}
	return []byte(fmt.Sprintf("#%02d%c\r", address, command)), nil
}

// Checksum is the module's kacoChecksum: the byte sum mod 256 (a RAW byte,
// never ASCII hex).
func Checksum(b []byte) byte {
	var sum int
	for _, c := range b {
		sum += int(c)
	}
	return byte(sum & 0xff)
}

// TrimLeadingJunk drops bus-switching noise before the frame: every reply
// starts with LF, everything before it is noise. Empty when no LF arrived yet.
func TrimLeadingJunk(raw []byte) []byte {
	i := bytes.IndexByte(raw, lf)
	if i < 0 {
		return []byte{}
	}
	return raw[i:]
}

// IsCmd0Complete reports a COMPLETE command-"0" frame in raw (already
// trimmed): length first, THEN a CR at or after the checksum - the checksum
// byte itself may be 0x0D.
func IsCmd0Complete(raw []byte) bool {
	if len(raw) < Cmd0MinLen {
		return false
	}
	return bytes.IndexByte(raw[offChecksum:], cr) >= 0
}

// ChecksumVerdict is verifyCmd0Checksum's { ok, expected, actual }.
type ChecksumVerdict struct {
	OK       bool
	Expected byte
	Actual   byte
}

// VerifyCmd0Checksum sums from '*' (offset 1) to the space before the checksum
// (offset 56), both included. A frame too short is {false, 0, 0} - never a panic.
func VerifyCmd0Checksum(raw []byte) ChecksumVerdict {
	if len(raw) <= offChecksum {
		return ChecksumVerdict{}
	}
	exp := Checksum(raw[1 : offChecksumSp+1])
	act := raw[offChecksum]
	return ChecksumVerdict{OK: exp == act, Expected: exp, Actual: act}
}

// ReplyCommandByte is the command echo in a reply head (`LF * AA c`); ok=false
// without a recognisable head.
func ReplyCommandByte(raw []byte) (byte, bool) {
	if len(raw) < 5 || raw[0] != lf || raw[1] != '*' {
		return 0, false
	}
	return raw[4], true
}

// ProtocolMismatch: a LF* head with a command byte this decoder does not know
// (another KACO protocol). No head at all is NOT a mismatch, just no answer.
func ProtocolMismatch(raw []byte) bool {
	c, ok := ReplyCommandByte(raw)
	return ok && !knownReplyCommands[c]
}

// ParseError: a reply does not fit the expected form (too short, wrong head,
// wrong command byte, non-numeric field) - a PROTOCOL problem, not a value.
type ParseError struct{ Msg string }

func (e *ParseError) Error() string { return e.Msg }

func parseErr(format string, a ...any) error { return &ParseError{Msg: fmt.Sprintf(format, a...)} }

// Parsed is parseCmd0's result.
type Parsed struct {
	Address          int
	Status           float64
	DcVoltageV       float64
	DcCurrentA       float64
	DcPowerW         float64
	AcVoltageV       float64
	AcCurrentA       float64
	AcPowerW         float64
	TemperatureC     float64
	DailyYieldWh     float64
	InverterType     string
	ChecksumOk       bool
	ChecksumExpected byte
	ChecksumActual   byte
}

// asciiField is Buffer.toString('ascii').trim(): the high bit of every byte is
// dropped, then JavaScript's whitespace trim.
func asciiField(raw []byte, s span) string {
	b := make([]byte, 0, s.to-s.from)
	for _, c := range raw[s.from:s.to] {
		b = append(b, c&0x7f)
	}
	return strings.Trim(string(b), jsWhitespace)
}

// jsWhitespace are the characters String.prototype.trim removes that can occur
// in a 7-bit field (WhiteSpace + LineTerminator of ECMA-262 within ASCII).
const jsWhitespace = " \t\n\v\f\r"

var (
	decimalLiteral = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	hexLiteral     = regexp.MustCompile(`^0[xX][0-9a-fA-F]+$`)
	octLiteral     = regexp.MustCompile(`^0[oO][0-7]+$`)
	binLiteral     = regexp.MustCompile(`^0[bB][01]+$`)
)

// jsNumber is JavaScript's Number(string) on an already trimmed string: "" is
// 0, "Infinity" is infinite, 0x/0o/0b prefixes are integers, anything else
// must be a decimal literal or it is NaN.
func jsNumber(s string) float64 {
	switch {
	case s == "":
		return 0
	case s == "Infinity" || s == "+Infinity":
		return math.Inf(1)
	case s == "-Infinity":
		return math.Inf(-1)
	case hexLiteral.MatchString(s):
		return parseUintOrNaN(s[2:], 16)
	case octLiteral.MatchString(s):
		return parseUintOrNaN(s[2:], 8)
	case binLiteral.MatchString(s):
		return parseUintOrNaN(s[2:], 2)
	case decimalLiteral.MatchString(s):
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			// Out of range: ParseFloat returns ±Inf with ErrRange, like Number().
			var ne *strconv.NumError
			if errorsAs(err, &ne) && ne.Err == strconv.ErrRange {
				return f
			}
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func parseUintOrNaN(digits string, base int) float64 {
	u, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		// Beyond uint64: JavaScript keeps counting in float64; a field of at
		// most six characters can never get there.
		return math.NaN()
	}
	return float64(u)
}

func numField(raw []byte, s span, name string) (float64, error) {
	str := asciiField(raw, s)
	n := jsNumber(str)
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, parseErr("Feld %q ist nicht numerisch: %q", name, str)
	}
	return n, nil
}

// ParseCmd0 decodes a reply to `#<adr>0\r`. A ParseError means the FORM does
// not fit (too short, no LF* head, wrong command byte, non-numeric field). A
// checksum error is NOT fatal (the kaco-rs485 stance: bus collisions are not
// rare on RS485, the fields usually still read right): the caller gets the
// values AND the verdict.
func ParseCmd0(raw []byte) (*Parsed, error) {
	if len(raw) < Cmd0MinLen {
		return nil, parseErr("Frame zu kurz: %d Bytes (mind. %d)", len(raw), Cmd0MinLen)
	}
	if raw[0] != lf || raw[1] != '*' {
		return nil, parseErr("fehlender LF*-Kopf: %q", string(raw[:2]))
	}
	if raw[4] != CmdMeasure {
		return nil, parseErr("Kommando-Byte ist %q, erwartet \"0\" (anderes KACO-Protokoll? siehe KACO.md)", string(raw[4]))
	}
	addrStr := asciiField(raw, span{2, 4})
	addrNum := jsNumber(addrStr)
	if math.IsNaN(addrNum) || math.IsInf(addrNum, 0) || addrNum != math.Trunc(addrNum) {
		return nil, parseErr("Adressfeld nicht numerisch: %q", addrStr)
	}
	p := &Parsed{Address: int(addrNum)}
	v := VerifyCmd0Checksum(raw)
	p.ChecksumOk, p.ChecksumExpected, p.ChecksumActual = v.OK, v.Expected, v.Actual

	// The type string after the checksum is decorative: absent, the frame is
	// still fully usable.
	tail := raw[offChecksum+1:]
	if i := bytes.IndexByte(tail, cr); i >= 0 {
		tail = tail[:i]
	}
	p.InverterType = asciiField(tail, span{0, len(tail)})

	var err error
	fields := []struct {
		dst  *float64
		s    span
		name string
	}{
		{&p.Status, offStatus, "status"}, {&p.DcVoltageV, offDcVoltage, "dcVoltage"}, {&p.DcCurrentA, offDcCurrent, "dcCurrent"},
		{&p.DcPowerW, offDcPower, "dcPower"}, {&p.AcVoltageV, offAcVoltage, "acVoltage"}, {&p.AcCurrentA, offAcCurrent, "acCurrent"},
		{&p.AcPowerW, offAcPower, "acPower"}, {&p.TemperatureC, offTemperature, "temperature"}, {&p.DailyYieldWh, offDailyYieldWh, "dailyYieldWh"},
	}
	for _, f := range fields {
		if *f.dst, err = numField(raw, f.s, f.name); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// jsRound is Math.round: half towards +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// float64(x*1000) keeps Go from fusing the product into the +0.5 of jsRound:
// an FMA (arm64) rounds -0.5 W to -0.001 kW where JavaScript and a MIPS box
// without FMA give 0 - the vector "Rundung: -0,5 W" caught exactly that.
func round3(x float64) float64 {
	v := jsRound(float64(x*1000)) / 1000
	if v == 0 {
		return 0 // JSON.stringify(-0) is "0"
	}
	return v
}

// Meta is decode's meta.
type Meta struct {
	Status         float64
	DcVoltageV     float64
	DcCurrentA     float64
	AcVoltageV     float64
	AcCurrentA     float64
	TempC          float64
	EnergyTodayKwh float64
	ChecksumOk     bool
	InverterType   string
	AcKw           float64
	DcKw           float64
}

// Result is decode's { reading, meta, address, checksumOk }.
type Result struct {
	Reading    map[string]float64
	Meta       Meta
	Address    int
	ChecksumOk bool
}

// Decode brings a command-"0" reply into the VoltPilot bus form. The AC output
// power IS the generation (a string device without storage); a rare negative
// night power clamps to 0 for pv_power_kw, meta.AcKw keeps the sign. With
// requireChecksum a checksum error drops the whole sample. Never panics: an
// unparsable frame is nil.
func Decode(raw []byte, requireChecksum bool) *Result {
	p, err := ParseCmd0(raw)
	if err != nil {
		return nil
	}
	if !p.ChecksumOk && requireChecksum {
		return nil
	}
	return &Result{
		Reading: map[string]float64{"pv_power_kw": round3(math.Max(0, p.AcPowerW) / 1000)},
		Meta: Meta{
			Status: p.Status, DcVoltageV: p.DcVoltageV, DcCurrentA: p.DcCurrentA, AcVoltageV: p.AcVoltageV,
			AcCurrentA: p.AcCurrentA, TempC: p.TemperatureC, EnergyTodayKwh: round3(p.DailyYieldWh / 1000),
			ChecksumOk: p.ChecksumOk, InverterType: p.InverterType,
			AcKw: round3(p.AcPowerW / 1000), DcKw: round3(p.DcPowerW / 1000),
		},
		Address:    p.Address,
		ChecksumOk: p.ChecksumOk,
	}
}
