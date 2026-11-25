package direktvermarkter

import (
	"math"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
)

// Decode reuses the generic Modbus read-path twin (modbusprofil.DecodeValue):
// a 16-bit type reads regs[0]; a 32-bit type combines two words - "little" =
// low word first, anything else = high word first; the byte order inside a
// register is always big-endian. ok=false for missing words, an unknown type
// or a non-finite float.
func Decode(regs []uint16, dataType, wordOrder string) (float64, bool) {
	return modbusprofil.DecodeValue(regs, dataType, wordOrder)
}

// Encode is Decode's inverse for the write path (FC 6/16): it builds the
// register words a write populates. ok=false for an unknown type or a value
// outside the type's representable range.
func Encode(value float64, dataType, wordOrder string) ([]uint16, bool) {
	if value != math.Trunc(value) {
		return nil, false
	}
	switch dataType {
	case "u16":
		if value < 0 || value > math.MaxUint16 {
			return nil, false
		}
		return []uint16{uint16(value)}, true
	case "s16":
		if value < math.MinInt16 || value > math.MaxInt16 {
			return nil, false
		}
		return []uint16{uint16(int16(value))}, true
	case "u32":
		if value < 0 || value > math.MaxUint32 {
			return nil, false
		}
		return splitWords(uint32(value), wordOrder), true
	case "s32":
		if value < math.MinInt32 || value > math.MaxInt32 {
			return nil, false
		}
		return splitWords(uint32(int32(value)), wordOrder), true
	}
	return nil, false
}

// splitWords combines the convention Decode/DecodeValue read by: "little" =
// low word first, anything else = high word first; big-endian bytes within
// each 16-bit word (that part is not a Modbus choice, every register is one
// big-endian uint16 on the wire).
func splitWords(raw uint32, wordOrder string) []uint16 {
	hi, lo := uint16(raw>>16), uint16(raw)
	if wordOrder == "little" {
		return []uint16{lo, hi}
	}
	return []uint16{hi, lo}
}
