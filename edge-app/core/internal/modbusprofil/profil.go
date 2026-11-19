// Package modbusprofil is the Go twin of the generic Modbus TCP read path of
// the Docker box (edge-app/nodered/modbus-tcp.js, the source of truth): the
// value decode of a generic read (registerCount/decodeValue), the register
// PROFILES that map a read block onto the flat edge/telemetry reading
// (profileRead/decodeProfile), and the plain register read of the probe
// channel (vp-palette/nodes/vp-modbus-probe.js readPlan/classify/runOps,
// probe.go).
//
// Pure: no socket, no bus, no clock. The wire protocol is internal/modbustcp;
// the reads themselves run in internal/layer1 under the lane of the device.
// Both sides are held to edge-app/nodered/modbus-tcp-vectors.json, which
// modbus-tcp-vectors.gen.js produces from the JS modules.
package modbusprofil

import (
	"math"
)

// The function codes a generic read uses.
const (
	FcReadHolding = 3
	FcReadInput   = 4
)

// RegisterCount is how many 16-bit words a data type occupies (1 or 2), or 0
// for an unknown type. The count of a generic read is DERIVED from the data
// type - there is deliberately no free quantity field.
func RegisterCount(dataType string) int {
	switch dataType {
	case "u16", "s16":
		return 1
	case "u32", "s32", "float32":
		return 2
	}
	return 0
}

// DecodeValue decodes register words per data type and word order. 16-bit
// types read regs[0]; 32-bit types combine two words - "little" = low word
// first (CD AB), anything else = high word first (AB CD); the byte order inside
// a register is always big-endian. ok=false for missing words, an unknown type
// or a non-finite float - never NaN or Inf.
func DecodeValue(regs []uint16, dataType, wordOrder string) (float64, bool) {
	words := RegisterCount(dataType)
	if words == 0 || len(regs) < words {
		return 0, false
	}
	w0 := regs[0]
	switch dataType {
	case "u16":
		return float64(w0), true
	case "s16":
		return float64(int16(w0)), true
	}
	hi, lo := w0, regs[1]
	if wordOrder == "little" {
		hi, lo = lo, hi
	}
	raw := uint32(hi)<<16 | uint32(lo)
	switch dataType {
	case "u32":
		return float64(raw), true
	case "s32":
		return float64(int32(raw)), true
	}
	f := float64(math.Float32frombits(raw))
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// Read is the block a profile reads.
type Read struct {
	FC    int `json:"fc"`
	Addr  int `json:"addr"`
	Count int `json:"count"`
}

// Result is a decoded profile block: the flat reading for edge/telemetry and
// the measured battery power (+ charge / - discharge), which goes on the LOCAL
// bus only (the core's house-load balance with a Netz meter) - the cloud never
// receives it.
type Result struct {
	Reading map[string]float64 `json:"reading"`
	BattKw  float64            `json:"batt_kw"`
}

// ProfileSunSpec is the compact SunSpec-style block of the edge/sim inverter
// (edge/sim/sunspec-sim.js) and generic Modbus inverters exposing this layout,
// FC3 holding registers 0..8:
//
//	Addr | Name                | Enc.
//	-----+---------------------+--------------------------
//	 0   | grid_power          | int16, 0.01 kW, +import
//	 1   | pv_power            | int16, 0.01 kW, >=0
//	 2   | load_power          | int16, 0.01 kW, >=0
//	 3   | battery_power       | int16, 0.01 kW, +charge
//	 4   | soc                 | uint16, 0.1 %
//	 5   | wmax_lim_pct        | uint16, 0.01 % (sf -2)
//	 6   | grid_conn_nameplate | uint16, 0.01 kW
//
// A real SunSpec inverter is NOT read this way - that is the model discovery
// of internal/sunspeclive (sunspec_tcp / fronius_sunspec).
const ProfileSunSpec = "sunspec"

// profiles maps a profile id (the selection's family) to its block.
var profiles = map[string]Read{
	ProfileSunSpec: {FC: FcReadHolding, Addr: 0, Count: 9},
}

// ProfileRead is the block a profile reads; ok=false for an unknown profile.
func ProfileRead(profile string) (Read, bool) {
	r, ok := profiles[profile]
	return r, ok
}

// DecodeProfile decodes a block per profile; nil for an unknown profile or a
// block too short to decode.
func DecodeProfile(profile string, regs []uint16) *Result {
	if profile != ProfileSunSpec || len(regs) < 7 {
		return nil
	}
	s16 := func(i int) float64 { return float64(int16(regs[i])) }
	gridKw := s16(0) / 100 // + import / - export
	pvKw := s16(1) / 100
	loadKw := s16(2) / 100
	socPct := float64(regs[4]) / 10
	wmaxLimPct := float64(regs[5]) / 100 // the observed §14a limit in %
	gridConnKw := float64(regs[6]) / 100
	gridLimitKw := (wmaxLimPct / 100) * gridConnKw
	return &Result{
		Reading: map[string]float64{
			"power_kw":      round3(gridKw),
			"pv_power_kw":   round3(pvKw),
			"load_kw":       round3(loadKw),
			"soc_pct":       round1(socPct),
			"grid_limit_kw": round3(gridLimitKw),
		},
		BattKw: round3(s16(3) / 100),
	}
}

// JavaScript's Math.round(x * 1000) / 1000. The explicit float64() on the
// product forbids the fused multiply-add Go may emit on arm64, which would
// round a half differently than JavaScript and the softfloat MIPS Mango.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func round3(x float64) float64 { return noNegZero(jsRound(float64(x*1000)) / 1000) }
func round1(x float64) float64 { return noNegZero(jsRound(float64(x*10)) / 10) }

// noNegZero: JSON.stringify(-0) is "0"; Go would write "-0".
func noNegZero(x float64) float64 {
	if x == 0 {
		return 0
	}
	return x
}
