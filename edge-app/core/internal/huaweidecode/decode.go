// Package huaweidecode is the Go twin of edge-app/nodered/huawei/huawei-decode.js:
// the register map and the decoding of a Huawei SUN2000 (L1/M1/MB0/MAP0) with an
// attached LUNA2000 battery, read over the inverter's own Modbus TCP server
// (brand=huawei, communication=huawei_modbus).
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/huawei/huawei-decode-vectors.json, GENERATED from the JS
// module (huawei-decode-vectors.gen.js); this package's test reads that file by
// path. The arithmetic is JavaScript-faithful (Math.round = half towards
// +Infinity) like internal/deyedecode.
//
// What the module knows and this package repeats (see the JS header for the
// sources): every multi-register value is big-endian with the high word first;
// PV is the DC-side input power (32064), never the AC active power (32080),
// because the AC side of a hybrid already nets out the battery; the grid meter
// (37113) exists only with a Smart Power Sensor, so a refused block drops the
// channel instead of fabricating 0; a SoC outside (0, 100] is a comms artefact
// and is dropped. Read only - nothing here controls the inverter.
package huaweidecode

import "math"

// Register addresses (decimal), the module's REG.
const (
	RegInputPowerW                  = 32064 // I32 W: PV (DC-side) input power - the Erzeugung channel
	RegActivePowerW                 = 32080 // I32 W: AC active power (meta only - includes battery on a hybrid)
	RegMeterActivePowerW            = 37113 // I32 W: grid meter power, only meaningful with a Smart Power Sensor
	RegBatterySocPctX10             = 37760 // U16, x0.1 %: battery SoC
	RegBatteryRunningStatus         = 37762 // U16: battery running status (meta only)
	RegBatteryChargeDischargePowerW = 37765 // I32 W, + charging
)

// Defaults of the module.
const (
	DefaultPort   = 502
	DefaultUnitID = 0 // factory slave id on a direct WLAN/LAN connection; a Smart Dongle commonly uses 1
)

// Family is the one register family of the module (FAMILIES).
const Family = "huawei_sun2000_luna"

// Known reports whether family is a family this decoder reads.
func Known(family string) bool { return family == Family }

// ReadSpec is one FC3 block of the poll plan.
type ReadSpec struct {
	Start int
	Count int
}

// PlanReads is the module's planReads: the FC3 blocks one poll fetches, each
// read in its own request so a single refused block degrades to absent
// channels (the sensor-less grid block in particular). Empty for an unknown
// family.
func PlanReads(family string) []ReadSpec {
	if !Known(family) {
		return nil
	}
	return []ReadSpec{
		{Start: RegInputPowerW, Count: 2},
		{Start: RegActivePowerW, Count: 2},
		{Start: RegMeterActivePowerW, Count: 2},
		{Start: RegBatterySocPctX10, Count: 7},
	}
}

// Block is one answered FC3 block ({start, regs}); a failed block is absent.
type Block struct {
	Start int
	Regs  []uint16
}

// Options are the decode options ({invertGridSign, invertBattSign}).
type Options struct {
	InvertGridSign bool
	InvertBattSign bool
}

// Meta carries the diagnostic facts (the module's meta): nil = not read.
type Meta struct {
	ActivePowerW         *int32
	BatteryRunningStatus *uint16
}

// Result is the module's { reading, battKw, meta }. Reading carries ONLY the
// channels genuinely present (pv_power_kw, power_kw, soc_pct); BattKw is the
// measured battery power in VoltPilot convention (+ charge / - discharge),
// nil when unreadable.
type Result struct {
	Reading map[string]float64
	BattKw  *float64
	Meta    Meta
}

// --- JavaScript-faithful arithmetic ------------------------------------------

// jsRound is Math.round: half towards +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// float64(x*1000) keeps Go from fusing the product into the +0.5 of jsRound:
// an FMA (arm64) rounds -0.5 W to -0.001 kW where JavaScript and a MIPS box
// without FMA give 0 - the shared vectors are the guard.
func round3(x float64) float64 { return noNegZero(jsRound(float64(x*1000)) / 1000) }
func round1(x float64) float64 { return noNegZero(jsRound(float64(x*10)) / 10) }

// noNegZero: JSON.stringify(-0) is "0" in JavaScript, encoding/json writes
// "-0" - the bus payload must read the same on both boxes.
func noNegZero(x float64) float64 {
	if x == 0 {
		return 0
	}
	return x
}

// SocPlausible is the module's socPlausible: a SoC in (0, 100] is a fact,
// anything else a comms artefact.
func SocPlausible(p float64) bool {
	return !math.IsNaN(p) && !math.IsInf(p, 0) && p > 0 && p <= 100
}

// regAt is the module's regAt: the raw u16 at addr out of the block list, the
// FIRST covering block wins; ok=false when no block covers it.
func regAt(blocks []Block, addr int) (uint16, bool) {
	for _, b := range blocks {
		i := addr - b.Start
		if i >= 0 && i < len(b.Regs) {
			return b.Regs[i], true
		}
	}
	return 0, false
}

// i32At is the module's i32At: signed 32-bit, big-endian, high word first.
func i32At(blocks []Block, addr int) (int32, bool) {
	hi, ok1 := regAt(blocks, addr)
	lo, ok2 := regAt(blocks, addr+1)
	if !ok1 || !ok2 {
		return 0, false
	}
	return int32(uint32(hi)<<16 | uint32(lo)), true
}

// Decode is the module's decode: the flat edge/telemetry reading out of the
// answered blocks, nil when not a single channel (and no battery power)
// decoded - never an empty fabricated reading.
func Decode(blocks []Block, opts Options) *Result {
	reading := map[string]float64{}

	if pvW, ok := i32At(blocks, RegInputPowerW); ok {
		reading["pv_power_kw"] = round3(float64(pvW) / 1000)
	}

	if gridW, ok := i32At(blocks, RegMeterActivePowerW); ok {
		sign := 1.0
		if opts.InvertGridSign {
			sign = -1
		}
		reading["power_kw"] = round3((sign * float64(gridW)) / 1000)
	}

	if socRaw, ok := regAt(blocks, RegBatterySocPctX10); ok {
		socPct := float64(socRaw) / 10
		if SocPlausible(socPct) {
			reading["soc_pct"] = round1(socPct)
		}
	}

	var battKw *float64
	if battRaw, ok := i32At(blocks, RegBatteryChargeDischargePowerW); ok {
		sign := 1.0
		if opts.InvertBattSign {
			sign = -1
		}
		v := round3((sign * float64(battRaw)) / 1000)
		battKw = &v
	}

	var meta Meta
	if ac, ok := i32At(blocks, RegActivePowerW); ok {
		meta.ActivePowerW = &ac
	}
	if st, ok := regAt(blocks, RegBatteryRunningStatus); ok {
		meta.BatteryRunningStatus = &st
	}

	if len(reading) == 0 && battKw == nil {
		return nil
	}
	return &Result{Reading: reading, BattKw: battKw, Meta: meta}
}
