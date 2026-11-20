// Package kostalplenticore is the Go twin of edge-app/nodered/kostal/kostal-decode.js:
// the KOSTAL PLENTICORE BI (battery inverter, no MPPTs) over the vendor's own
// Modbus TCP server (port 1502, unit 71) and the fixed register map of the
// official interface description. It reads battery power, SoC and - through
// an installed KOSTAL Smart Energy Meter - the grid power; deliberately no PV
// and no load (the BI has no PV, the core computes the house).
//
// Load-bearing facts (see the JS module's header): register 5 is the word
// order of two-word values (0 little = CDAB, the factory default; 1 big); the
// battery register counts + discharge / - charge, the OPPOSITE of VoltPilot's
// battery_power_kw, so the decode negates; the grid value is only published
// while a sensor is installed (register 1082 != 0xFF).
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kostal/kostal-decode-vectors.json, GENERATED from the JS
// module (kostal-decode-vectors.gen.js); this package's test reads that file.
//
// Read only: the control registers (external battery management) belong to a
// separate, gated path.
package kostalplenticore

import "math"

// Family is the one register family (PLENTICORE BI G1/G2).
const Family = "kostal_plenticore"

// Known reports whether family is the family this decoder reads.
func Known(family string) bool { return family == Family }

// Vendor defaults of the Modbus TCP server.
const (
	DefaultPort   = 1502
	DefaultUnitID = 71
)

// Register addresses (decimal, official doc §3.2/§3.4).
const (
	RegByteOrder         = 5
	RegInverterState     = 56
	RegPowermeterTotalW  = 252
	RegBatterySocPct     = 514
	RegInverterMaxPowerW = 531
	RegBatteryPowerW     = 582
	RegBatteryType       = 588
	RegBatteryCapacityWh = 1068
	RegBmsMaxChargeW     = 1076
	RegBmsMaxDischargeW  = 1078
	RegBatteryMgmtMode   = 1080
	RegSensorType        = 1082
)

// SensorNone is register 1082's "no sensor installed".
const SensorNone = 0xff

// ReadSpec is one FC3 block of a poll.
type ReadSpec struct {
	Start int `json:"start"`
	Count int `json:"count"`
}

// PlanReads is planReads: the five fixed FC3 blocks, each in its own request
// so a refused block only drops its channels.
func PlanReads(family string) []ReadSpec {
	if !Known(family) {
		return nil
	}
	return []ReadSpec{
		{Start: RegByteOrder, Count: 1},
		{Start: RegInverterState, Count: 2},
		{Start: RegPowermeterTotalW, Count: 2},
		{Start: RegBatterySocPct, Count: 75},
		{Start: RegBatteryCapacityWh, Count: 16},
	}
}

// Block is one block as read (a refused block is simply absent).
type Block struct {
	Start int
	Regs  []uint16
}

// Options mirrors decode's opts; ByteOrder is "little", "big" or anything
// else for auto (register 5).
type Options struct {
	InvertGridSign bool
	InvertBattSign bool
	ByteOrder      string
}

// Meta is decode's diagnostic block (nil = unreadable).
type Meta struct {
	ByteOrder             string   `json:"byte_order"`
	State                 *float64 `json:"state"`
	InverterMaxPowerW     *float64 `json:"inverter_max_power_w"`
	BatteryType           *float64 `json:"battery_type"`
	BatteryMgmtMode       *float64 `json:"battery_mgmt_mode"`
	SensorType            *float64 `json:"sensor_type"`
	BmsMaxChargeW         *float64 `json:"bms_max_charge_w"`
	BmsMaxDischargeW      *float64 `json:"bms_max_discharge_w"`
	BatteryWorkCapacityWh *float64 `json:"battery_work_capacity_wh"`
}

// Result is decode's answer: the reading (soc_pct, power_kw), the measured
// battery power in VoltPilot's convention (+ charge / - discharge; local bus
// only) and the meta block.
type Result struct {
	Reading map[string]float64
	BattKw  *float64
	Meta    Meta
}

// ResolveByteOrder is resolveByteOrder: an explicit setting wins; register 5 =
// 1 is big; anything else (0, unreadable, unknown) is the factory little.
func ResolveByteOrder(configured string, reg5 *uint16) string {
	if configured == "little" || configured == "big" {
		return configured
	}
	if reg5 != nil && *reg5 == 1 {
		return "big"
	}
	return "little"
}

// Decode is decode(): nil when not a single channel decoded.
func Decode(blocks []Block, o Options) *Result {
	order := ResolveByteOrder(o.ByteOrder, regAt(blocks, RegByteOrder))
	reading := map[string]float64{}
	if soc := regAt(blocks, RegBatterySocPct); soc != nil && *soc > 0 && *soc <= 100 {
		reading["soc_pct"] = round1(float64(*soc))
	}
	sensor := regAt(blocks, RegSensorType)
	if grid := f32At(blocks, RegPowermeterTotalW, order); grid != nil && sensor != nil && *sensor != SensorNone {
		sign := 1.0
		if o.InvertGridSign {
			sign = -1
		}
		reading["power_kw"] = round3(sign * *grid / 1000)
	}
	var battKw *float64
	if raw := regAt(blocks, RegBatteryPowerW); raw != nil {
		sign := 1.0
		if o.InvertBattSign {
			sign = -1
		}
		b := round3(sign * -float64(int16(*raw)) / 1000)
		battKw = &b
	}
	meta := Meta{
		ByteOrder:             order,
		State:                 u32At(blocks, RegInverterState, order),
		InverterMaxPowerW:     f(regAt(blocks, RegInverterMaxPowerW)),
		BatteryType:           f(regAt(blocks, RegBatteryType)),
		BatteryMgmtMode:       f(regAt(blocks, RegBatteryMgmtMode)),
		SensorType:            f(sensor),
		BmsMaxChargeW:         f32At(blocks, RegBmsMaxChargeW, order),
		BmsMaxDischargeW:      f32At(blocks, RegBmsMaxDischargeW, order),
		BatteryWorkCapacityWh: f32At(blocks, RegBatteryCapacityWh, order),
	}
	if len(reading) == 0 && battKw == nil {
		return nil
	}
	return &Result{Reading: reading, BattKw: battKw, Meta: meta}
}

// regAt is the raw register at addr, or nil when no block covers it.
func regAt(blocks []Block, addr int) *uint16 {
	for _, b := range blocks {
		if i := addr - b.Start; i >= 0 && i < len(b.Regs) {
			v := b.Regs[i]
			return &v
		}
	}
	return nil
}

// words2 is two registers in the word order as (hi, lo).
func words2(blocks []Block, addr int, order string) (uint16, uint16, bool) {
	w0, w1 := regAt(blocks, addr), regAt(blocks, addr+1)
	if w0 == nil || w1 == nil {
		return 0, 0, false
	}
	if order == "big" {
		return *w0, *w1, true
	}
	return *w1, *w0, true
}

func f32At(blocks []Block, addr int, order string) *float64 {
	hi, lo, ok := words2(blocks, addr, order)
	if !ok {
		return nil
	}
	v := float64(math.Float32frombits(uint32(hi)<<16 | uint32(lo)))
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

func u32At(blocks []Block, addr int, order string) *float64 {
	hi, lo, ok := words2(blocks, addr, order)
	if !ok {
		return nil
	}
	v := float64(hi)*0x10000 + float64(lo)
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
