// Package aiswei is the Go twin of edge-app/nodered/kaco/aiswei-decode.js:
// KACO's hybrid blueplanet NH3 over the AISWEI-native Modbus register map on
// the inverter's OWN Ethernet port (TCP 502, unit 1). It is the expert way
// beside the App-Schnittstelle (kacohttp) for an NH3 whose communication unit
// does not serve the 8484 API; it costs no cloud connection either.
//
// The map mixes input registers (FC4, document number - 30001) and holding
// registers (FC3, document number - 40001): every block carries its function
// code, and the two tables are separate address spaces. The battery register
// counts - charge / + discharge (the write setpoint's documented convention),
// the decode negates into VoltPilot's + charge / - discharge.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kaco/aiswei-decode-vectors.json, GENERATED from the JS module
// (aiswei-decode-vectors.gen.js); this package's test reads that file.
//
// Read only: the documented battery write path belongs to the locked control
// path, not here.
package aiswei

import "math"

// Family is the one register family.
const Family = "kaco_nh3"

// Known reports whether family is the family this decoder reads.
func Known(family string) bool { return family == Family }

// Defaults of the inverter's own Modbus TCP server.
const (
	DefaultPort   = 502
	DefaultUnitID = 1
)

const (
	inputBase   = 30001
	holdingBase = 40001
)

// Document numbers of the register map (AISWEI MB001 §3.3).
const (
	RegDeviceType    = 31001
	RegModbusAddress = 31002
	RegRatedPower    = 31028
	RegPvTotalW      = 31601
	RegETotal        = 31605
	RegBatteryState  = 31608
	RegBatteryV      = 31617
	RegBatteryA      = 31618
	RegBatteryPowerW = 31619
	RegSoc           = 31622
	RegSoh           = 31623
	RegGridTotalW    = 46434
)

func inputAddr(doc int) int   { return doc - inputBase }
func holdingAddr(doc int) int { return doc - holdingBase }

// ReadSpec is one block of a poll with its function code (3 or 4).
type ReadSpec struct {
	FC    int `json:"fc"`
	Start int `json:"start"`
	Count int `json:"count"`
}

// PlanReads is planReads: three blocks, each read on its own.
func PlanReads(family string) []ReadSpec {
	if !Known(family) {
		return nil
	}
	return []ReadSpec{
		{FC: 4, Start: inputAddr(RegDeviceType), Count: 28},
		{FC: 4, Start: inputAddr(RegPvTotalW), Count: 25},
		{FC: 3, Start: holdingAddr(RegGridTotalW), Count: 2},
	}
}

// Block is one block as read (a refused block is simply absent).
type Block struct {
	FC    int
	Start int
	Regs  []uint16
}

// Options mirrors decode's opts.
type Options struct {
	InvertGridSign bool
	InvertBattSign bool
}

// Meta is decode's diagnostic block (absent fields stay absent).
type Meta struct {
	DeviceType     *float64 `json:"device_type,omitempty"`
	ModbusAddress  *float64 `json:"modbus_address,omitempty"`
	RatedPower     *float64 `json:"rated_power,omitempty"`
	BatteryV       *float64 `json:"battery_v,omitempty"`
	BatteryA       *float64 `json:"battery_a,omitempty"`
	SohPct         *float64 `json:"soh_pct,omitempty"`
	BatteryState   *float64 `json:"battery_state,omitempty"`
	EnergyTotalKwh *float64 `json:"energy_total_kwh,omitempty"`
}

// Result is decode's answer: the reading (pv_power_kw from the DC side,
// power_kw from the smart meter, soc_pct), the battery power in VoltPilot's
// convention (local bus only) and the meta block.
type Result struct {
	Reading map[string]float64
	BattKw  *float64
	Meta    Meta
}

// Decode is decode(): nil when not a single channel decoded.
func Decode(blocks []Block, o Options) *Result {
	reading := map[string]float64{}
	if pv := u32At(blocks, 4, inputAddr(RegPvTotalW)); pv != nil {
		reading["pv_power_kw"] = round3(*pv / 1000)
	}
	if g := s32At(blocks, 3, holdingAddr(RegGridTotalW)); g != nil {
		sign := 1.0
		if o.InvertGridSign {
			sign = -1
		}
		reading["power_kw"] = round3(sign * *g / 1000)
	}
	if raw := regAt(blocks, 4, inputAddr(RegSoc)); raw != nil {
		if soc := float64(*raw) * 0.01; soc > 0 && soc <= 100 {
			reading["soc_pct"] = round1(soc)
		}
	}
	var battKw *float64
	if pb := s32At(blocks, 4, inputAddr(RegBatteryPowerW)); pb != nil {
		sign := -1.0 // default: negate
		if o.InvertBattSign {
			sign = 1
		}
		b := round3(sign * *pb / 1000)
		battKw = &b
	}
	var meta Meta
	meta.DeviceType = f(regAt(blocks, 4, inputAddr(RegDeviceType)))
	meta.ModbusAddress = f(regAt(blocks, 4, inputAddr(RegModbusAddress)))
	meta.RatedPower = f(regAt(blocks, 4, inputAddr(RegRatedPower)))
	meta.BatteryV = f(regAt(blocks, 4, inputAddr(RegBatteryV)))
	if a := regAt(blocks, 4, inputAddr(RegBatteryA)); a != nil {
		v := float64(int16(*a))
		meta.BatteryA = &v
	}
	meta.SohPct = f(regAt(blocks, 4, inputAddr(RegSoh)))
	meta.BatteryState = f(regAt(blocks, 4, inputAddr(RegBatteryState)))
	if e := u32At(blocks, 4, inputAddr(RegETotal)); e != nil {
		v := round1(*e * 0.1)
		meta.EnergyTotalKwh = &v
	}
	if len(reading) == 0 && battKw == nil {
		return nil
	}
	return &Result{Reading: reading, BattKw: battKw, Meta: meta}
}

// regAt is the raw register at the wire address in the table of fc.
func regAt(blocks []Block, fc, addr int) *uint16 {
	for _, b := range blocks {
		if b.FC != fc {
			continue
		}
		if i := addr - b.Start; i >= 0 && i < len(b.Regs) {
			v := b.Regs[i]
			return &v
		}
	}
	return nil
}

// u32At is two registers, high word first.
func u32At(blocks []Block, fc, addr int) *float64 {
	hi, lo := regAt(blocks, fc, addr), regAt(blocks, fc, addr+1)
	if hi == nil || lo == nil {
		return nil
	}
	v := float64(*hi)*0x10000 + float64(*lo)
	return &v
}

func s32At(blocks []Block, fc, addr int) *float64 {
	u := u32At(blocks, fc, addr)
	if u == nil {
		return nil
	}
	v := float64(int32(uint32(*u)))
	return &v
}

func f(v *uint16) *float64 {
	if v == nil {
		return nil
	}
	x := float64(*v)
	return &x
}

// jsRound is Math.round (half up).
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func noNegZero(x float64) float64 {
	if x == 0 {
		return 0
	}
	return x
}

func round3(x float64) float64 { return noNegZero(jsRound(float64(x*1000)) / 1000) }
func round1(x float64) float64 { return noNegZero(jsRound(float64(x*10)) / 10) }
