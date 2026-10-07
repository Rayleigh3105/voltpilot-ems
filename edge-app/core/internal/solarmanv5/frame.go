// Package solarmanv5 is the Go twin of edge-app/nodered/deye/solarman-v5.js:
// the Solarman V5 logger protocol (Modbus-RTU framed in a V5 envelope over
// TCP 8899), the transport every Deye WiFi/LAN datalogger speaks.
//
// It exists for Edge Light (edge-light/), which runs WITHOUT Node-RED: the
// reads Node-RED's "Solarman-V5 lesen" node performs move into the core
// binary. This file is the pure, socket-free codec; client.go owns the TCP
// session. Both sides are pinned to the SAME vectors
// (edge-app/nodered/deye/solarman-v5-vectors.json, generated from the JS
// module) - change the JS module, regenerate, and this package's tests say
// whether the twin has to follow.
//
//	Request  frame: A5 <len LE> 4510 <seq LE> <loggerSerial LE32>
//	                02 0000 00000000 00000000 00000000 <modbus-RTU> <cksum> 15
//	Response frame: A5 <len LE> 1510 <seq LE> <loggerSerial LE32>
//	                <frametype> <status> <3x u32 LE> <modbus-RTU> <cksum> 15
//
// The embedded Modbus-RTU frame is big-endian; everything in the V5 wrapper is
// little-endian. The V5 checksum is a byte sum (mod 256) over every byte except
// the start byte, the checksum byte itself and the end byte.
package solarmanv5

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Wire constants (solarman-v5.js).
const (
	Start           byte   = 0xa5
	End             byte   = 0x15
	ControlRequest  uint16 = 0x4510
	ControlResponse uint16 = 0x1510
	FrameTypeSolar  byte   = 0x02

	// responseModbusOffset: 11-byte header + 14-byte payload preamble
	// (frametype 1 + status 1 + 3x u32). The REQUEST preamble is 15 bytes
	// (frametype 1 + sensortype 2 + 3x u32) - asymmetric on purpose.
	responseModbusOffset = 25
	requestPreamble      = 15

	// MaxReadCount is the Modbus fn-0x03 ceiling for one request.
	MaxReadCount = 125
)

// frameTypeLabels mirror V5_FRAME_TYPES.
var frameTypeLabels = map[byte]string{
	0x00: "Solarman-Cloud",
	0x01: "Datenlogger-Stick",
	0x02: "Wechselrichter",
}

// FrameTypeLabel is the German label for a V5 response frame-type byte.
func FrameTypeLabel(t byte) string {
	if l, ok := frameTypeLabels[t]; ok {
		return l
	}
	return "unbekannt"
}

// modbusExceptions mirror MODBUS_EXCEPTIONS (plain-German meaning).
var modbusExceptions = map[byte]string{
	0x01: "unzulaessige Funktion (illegal function)",
	0x02: "unzulaessige Datenadresse (illegal data address)",
	0x03: "unzulaessiger Datenwert (illegal data value)",
	0x04: "Geraetefehler im Wechselrichter (slave device failure)",
	0x05: "wird bearbeitet (acknowledge)",
	0x06: "Wechselrichter beschaeftigt (slave device busy)",
	0x07: "Verarbeitung abgelehnt (negative acknowledge)",
	0x08: "Speicher-Paritaetsfehler (memory parity error)",
	0x0a: "Gateway-Pfad nicht verfuegbar (gateway path unavailable)",
	0x0b: "Wechselrichter hat nicht geantwortet (gateway target failed to respond)",
}

// ModbusExceptionText is the plain-German meaning of a Modbus exception code.
func ModbusExceptionText(code byte) string {
	if t, ok := modbusExceptions[code]; ok {
		return t
	}
	return "unbekannte Modbus-Ausnahme"
}

// ProtocolError is every refusal of a received frame. The caller (the test
// read, the poll) classifies it as "invalid_response" - distinct from a dial
// failure (unreachable) and a silent peer (no_answer).
type ProtocolError struct{ Msg string }

func (e *ProtocolError) Error() string { return e.Msg }

func protoErr(format string, a ...any) error {
	return &ProtocolError{Msg: fmt.Sprintf(format, a...)}
}

// IsProtocolError reports whether err is a frame/Modbus-level refusal.
func IsProtocolError(err error) bool {
	var pe *ProtocolError
	return errors.As(err, &pe)
}

// --- Modbus RTU --------------------------------------------------------------

// CRC16 is the standard Modbus/RTU CRC16 (init 0xFFFF, poly 0xA001). On the
// wire it is appended LOW byte first.
func CRC16(b []byte) uint16 {
	crc := uint16(0xffff)
	for _, x := range b {
		crc ^= uint16(x)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0xa001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}

func appendCRC(body []byte) []byte {
	c := CRC16(body)
	return append(body, byte(c&0xff), byte(c>>8))
}

// ReadHoldingRequest builds a Modbus-RTU "read holding registers" (fn 0x03).
func ReadHoldingRequest(slave byte, start, count uint16) []byte {
	b := make([]byte, 6, 8)
	b[0] = slave
	b[1] = 0x03
	binary.BigEndian.PutUint16(b[2:], start)
	binary.BigEndian.PutUint16(b[4:], count)
	return appendCRC(b)
}

// WriteSingleRequest builds a Modbus-RTU "write single register" (fn 0x06).
func WriteSingleRequest(slave byte, reg, value uint16) []byte {
	b := make([]byte, 6, 8)
	b[0] = slave
	b[1] = 0x06
	binary.BigEndian.PutUint16(b[2:], reg)
	binary.BigEndian.PutUint16(b[4:], value)
	return appendCRC(b)
}

// WriteMultipleRequest builds a Modbus-RTU "write multiple registers" (fn 0x10).
func WriteMultipleRequest(slave byte, start uint16, values []uint16) ([]byte, error) {
	if len(values) == 0 {
		return nil, errors.New("WriteMultipleRequest: values darf nicht leer sein")
	}
	b := make([]byte, 7+2*len(values), 9+2*len(values))
	b[0] = slave
	b[1] = 0x10
	binary.BigEndian.PutUint16(b[2:], start)
	binary.BigEndian.PutUint16(b[4:], uint16(len(values)))
	b[6] = byte(len(values) * 2)
	for i, v := range values {
		binary.BigEndian.PutUint16(b[7+2*i:], v)
	}
	return appendCRC(b), nil
}

// ParseReadResponse validates a Modbus-RTU fn-0x03 reply and returns its
// register words (index 0 = first requested register).
func ParseReadResponse(mb []byte) ([]uint16, error) {
	if len(mb) < 5 {
		return nil, protoErr("Modbus-Antwort zu kurz")
	}
	body := mb[:len(mb)-2]
	if binary.LittleEndian.Uint16(mb[len(mb)-2:]) != CRC16(body) {
		return nil, protoErr("Modbus-CRC falsch")
	}
	fn := mb[1]
	if fn&0x80 != 0 {
		return nil, protoErr("Modbus-Ausnahme 0x%02x: %s", mb[2], ModbusExceptionText(mb[2]))
	}
	if fn != 0x03 {
		return nil, protoErr("unerwartete Modbus-Funktion 0x%02x", fn)
	}
	byteCount := int(mb[2])
	if byteCount <= 0 || len(body) < 3+byteCount {
		return nil, protoErr("Modbus-Nutzlast unvollstaendig")
	}
	regs := make([]uint16, byteCount/2)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(mb[3+2*i:])
	}
	return regs, nil
}

// WriteAck is a validated Modbus write acknowledgement.
type WriteAck struct {
	Fn       byte
	Reg      uint16 // fn 0x06
	Value    uint16 // fn 0x06
	StartReg uint16 // fn 0x10
	Count    uint16 // fn 0x10
}

// ParseWriteResponse validates a fn-0x06 echo or fn-0x10 acknowledgement.
// expectFn = 0 accepts either.
func ParseWriteResponse(mb []byte, expectFn byte) (WriteAck, error) {
	if len(mb) < 5 {
		return WriteAck{}, protoErr("Modbus-Schreibantwort zu kurz")
	}
	body := mb[:len(mb)-2]
	if binary.LittleEndian.Uint16(mb[len(mb)-2:]) != CRC16(body) {
		return WriteAck{}, protoErr("Modbus-CRC falsch")
	}
	fn := mb[1]
	if fn&0x80 != 0 {
		return WriteAck{}, protoErr("Modbus-Ausnahme 0x%02x: %s", mb[2], ModbusExceptionText(mb[2]))
	}
	if expectFn != 0 && fn != expectFn {
		return WriteAck{}, protoErr("unerwartete Modbus-Funktion 0x%02x", fn)
	}
	switch fn {
	case 0x06:
		if len(body) < 6 {
			return WriteAck{}, protoErr("fn-0x06-Antwort unvollstaendig")
		}
		return WriteAck{Fn: fn, Reg: binary.BigEndian.Uint16(mb[2:]), Value: binary.BigEndian.Uint16(mb[4:])}, nil
	case 0x10:
		if len(body) < 6 {
			return WriteAck{}, protoErr("fn-0x10-Antwort unvollstaendig")
		}
		return WriteAck{Fn: fn, StartReg: binary.BigEndian.Uint16(mb[2:]), Count: binary.BigEndian.Uint16(mb[4:])}, nil
	}
	return WriteAck{}, protoErr("unerwartete Modbus-Schreibfunktion 0x%02x", fn)
}

// --- Solarman V5 wrapper -----------------------------------------------------

// Checksum is the V5 byte sum over every byte except start, checksum and end.
func Checksum(frame []byte) byte {
	var sum byte
	for i := 1; i < len(frame)-2; i++ {
		sum += frame[i]
	}
	return sum
}

// NormLoggerSerial accepts a number or a decimal/hex string, exactly like the
// JS twin (which runs it through Number()): an integer in 0..2^32-1.
func NormLoggerSerial(v any) (uint32, error) {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case uint32:
		n = float64(x)
	case uint64:
		n = float64(x)
	case string:
		n = jsNumber(strings.TrimSpace(x))
	default:
		return 0, fmt.Errorf("Logger-Seriennummer ungueltig (positive Ganzzahl erwartet): %v", v)
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || math.Floor(n) != n {
		return 0, fmt.Errorf("Logger-Seriennummer ungueltig (positive Ganzzahl erwartet): %v", v)
	}
	if n > 0xffffffff {
		return 0, fmt.Errorf("Logger-Seriennummer ausserhalb 32-Bit: %v", v)
	}
	return uint32(n), nil
}

// jsNumber mirrors JavaScript's Number(string) for the inputs a serial field
// can carry: "" -> 0, decimal (incl. exponent/sign), 0x/0o/0b prefixes; every
// other string -> NaN.
func jsNumber(s string) float64 {
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			u, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(u)
		}
	}
	if s == "Infinity" || s == "+Infinity" {
		return math.Inf(1)
	}
	if s == "-Infinity" {
		return math.Inf(-1)
	}
	// strconv accepts "inf"/"nan"/hex floats/underscores; Number() does not.
	for _, r := range s {
		if !strings.ContainsRune("0123456789+-.eE", r) {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// BuildRequest wraps a Modbus-RTU frame in a Solarman V5 request frame.
func BuildRequest(serial uint32, seq uint16, modbus []byte) []byte {
	length := requestPreamble + len(modbus)
	f := make([]byte, 0, 11+length+2)
	f = append(f, Start, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	binary.LittleEndian.PutUint16(f[1:], uint16(length))
	binary.LittleEndian.PutUint16(f[3:], ControlRequest)
	binary.LittleEndian.PutUint16(f[5:], seq)
	binary.LittleEndian.PutUint32(f[7:], serial)
	pre := make([]byte, requestPreamble)
	pre[0] = FrameTypeSolar
	f = append(f, pre...)
	f = append(f, modbus...)
	f = append(f, 0x00, End)
	f[len(f)-2] = Checksum(f)
	return f
}

// BuildReadRequest is the full V5 request for a fn-0x03 read.
func BuildReadRequest(serial uint32, seq uint16, slave byte, start, count uint16) []byte {
	return BuildRequest(serial, seq, ReadHoldingRequest(slave, start, count))
}

// BuildWriteSingleRequest is the full V5 request for a fn-0x06 write.
func BuildWriteSingleRequest(serial uint32, seq uint16, slave byte, reg, value uint16) []byte {
	return BuildRequest(serial, seq, WriteSingleRequest(slave, reg, value))
}

// BuildWriteMultipleRequest is the full V5 request for a fn-0x10 write.
func BuildWriteMultipleRequest(serial uint32, seq uint16, slave byte, start uint16, values []uint16) ([]byte, error) {
	mb, err := WriteMultipleRequest(slave, start, values)
	if err != nil {
		return nil, err
	}
	return BuildRequest(serial, seq, mb), nil
}

// ExpectedFrameLength is the total length a V5 frame claims via its length
// field (header 11 + payload + checksum/end 2). ok is false until the three
// header bytes carrying the length are present. A wrong start byte is an error
// (the stream is not a V5 stream).
func ExpectedFrameLength(buf []byte) (n int, ok bool, err error) {
	if len(buf) < 3 {
		return 0, false, nil
	}
	if buf[0] != Start {
		return 0, false, protoErr("ungueltiges Startbyte 0x%x", buf[0])
	}
	return 11 + int(binary.LittleEndian.Uint16(buf[1:])) + 2, true, nil
}

// Response is a validated V5 response envelope.
type Response struct {
	ControlCode  uint16
	Sequence     uint16
	LoggerSerial uint32
	FrameType    byte
	Status       byte
	Modbus       []byte
}

// ParseOpts are the optional identity checks of ParseResponse.
type ParseOpts struct {
	ExpectSerial   *uint32
	ExpectSequence *uint16
}

// ParseResponse validates the V5 wrapper and returns the embedded Modbus frame.
// Bytes after the frame's own length (the next TCP segment) are ignored.
func ParseResponse(buf []byte, opts ParseOpts) (*Response, error) {
	if len(buf) < 13 {
		return nil, protoErr("Solarman-V5-Frame zu kurz")
	}
	if buf[0] != Start {
		return nil, protoErr("ungueltiges Startbyte 0x%x", buf[0])
	}
	total := 11 + int(binary.LittleEndian.Uint16(buf[1:])) + 2
	if len(buf) < total {
		return nil, protoErr("Frame kuerzer als Laengenfeld (%d<%d)", len(buf), total)
	}
	f := buf[:total]
	if f[len(f)-1] != End {
		return nil, protoErr("ungueltiges Endbyte 0x%x", f[len(f)-1])
	}
	if cs := Checksum(f); cs != f[len(f)-2] {
		return nil, protoErr("V5-Pruefsumme falsch (0x%x != 0x%x)", f[len(f)-2], cs)
	}
	r := &Response{
		ControlCode:  binary.LittleEndian.Uint16(f[3:]),
		Sequence:     binary.LittleEndian.Uint16(f[5:]),
		LoggerSerial: binary.LittleEndian.Uint32(f[7:]),
		FrameType:    f[11],
		Status:       f[12],
	}
	if r.ControlCode != ControlResponse {
		return nil, protoErr("unerwarteter V5-Controlcode 0x%x (erwartet 0x1510)", r.ControlCode)
	}
	if opts.ExpectSerial != nil && *opts.ExpectSerial != r.LoggerSerial {
		return nil, protoErr("Logger-Seriennummer im Frame weicht ab: %d", r.LoggerSerial)
	}
	if opts.ExpectSequence != nil && *opts.ExpectSequence != r.Sequence {
		return nil, protoErr("Sequenznummer im Frame weicht ab: %d", r.Sequence)
	}
	// Only frame type 0x02 carries an inverter (Modbus) reply.
	if r.FrameType != FrameTypeSolar {
		return nil, protoErr("V5-Frametyp 0x%02x (%s) - kein Wechselrichter-Antwortframe; der Logger meldet keine Antwort vom Wechselrichter (Status 0x%02x)",
			r.FrameType, FrameTypeLabel(r.FrameType), r.Status)
	}
	mb := f[responseModbusOffset : len(f)-2]
	if len(mb) < 5 {
		if len(mb) == 0 {
			return nil, protoErr("Logger lieferte keine Modbus-Nutzlast (Status 0x%02x) - der Wechselrichter hat nicht geantwortet", r.Status)
		}
		if len(mb) >= 3 && mb[1]&0x80 != 0 {
			return nil, protoErr("Modbus-Ausnahme 0x%02x: %s (verkuerzte Antwort % X)", mb[2], ModbusExceptionText(mb[2]), mb)
		}
		return nil, protoErr("verkuerzte Modbus-Antwort (%d Byte: % X) - der Wechselrichter hat nicht regulaer geantwortet", len(mb), mb)
	}
	r.Modbus = append([]byte(nil), mb...)
	return r, nil
}

// ReadRegistersFromResponse unwraps a V5 response and decodes its fn-0x03
// payload into register words.
func ReadRegistersFromResponse(buf []byte, opts ParseOpts) ([]uint16, error) {
	r, err := ParseResponse(buf, opts)
	if err != nil {
		return nil, err
	}
	return ParseReadResponse(r.Modbus)
}
