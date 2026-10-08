// Package deyedecode is the Go twin of edge-app/nodered/deye/deye-decode.js:
// the Deye register maps (four families) and the decode of raw register
// blocks into the flat edge/telemetry reading - including every plausibility
// rule (the SoC gate with its three cases, the BMS coupling, the
// voltage-based SoC estimate, the HV/LV power scale).
//
// It exists for Edge Light (edge-light/), which reads the inverter without
// Node-RED. The JS module stays the source of truth: both sides are pinned to
// edge-app/nodered/deye/deye-decode-vectors.json, which is GENERATED from the
// JS module (deye-decode-vectors.gen.js). Change the JS, regenerate, and this
// package's tests say whether the twin has to follow.
//
// Arithmetic deliberately mirrors JavaScript, operation for operation: the
// same float64 order (raw*scale, then *hv, then /1000) and Math.round's
// "half towards +Infinity" (jsRound) instead of Go's math.Round. Otherwise a
// boundary value would round differently on the box than in Node-RED.
//
// Register addresses are authoritative from davidrapan/ha-solarman (see the
// JS module's header); signs stay VERIFY-on-device (invert_grid_sign /
// invert_batt_sign).
package deyedecode

// Family identifiers (the routing key the inverter selection carries).
const (
	FamilyString   = "string"
	FamilyHybrid1P = "hybrid_1p"
	FamilyHybrid3P = "hybrid_3p"
	FamilyMicro    = "micro"
)

// The device-identity register and its LV/HV codes (ha-solarman
// AUTODETECTION_DEYE): LV -> PV/battery scale 1, HV -> 10.
const deviceReg = 0x0000

var (
	deviceTypesLV = []int{0x0005, 0x0500}
	deviceTypesHV = []int{0x0006, 0x0007, 0x0600, 0x0008, 0x0601}
)

// The BMS block a CAN-coupled battery fills (P4), 0x00D2..0x00DF.
const (
	bmsBlockStart = 0x00d2
	bmsBlockCount = 0x000e
	bmsSocReg     = 0x00d6
)

// ReadSpec is one block of a family's per-poll read plan.
type ReadSpec struct {
	Start    int  `json:"start"`
	Count    int  `json:"count"`
	Optional bool `json:"optional,omitempty"`
}

// field is one register spec (deye-decode.js field objects).
type field struct {
	addr   int
	addrs  []int
	bits   int
	signed bool
	scale  float64 // 1 where the JS spec leaves it undefined
	sum    bool
	pct    bool // kind: 'pct'
	hv     bool // hvScale: true
	// hvFactor is the BMS current's inverted dual scale [1, 0.1]: on HV the
	// value is multiplied by it, on LV by 1. hasHVFactor marks its presence.
	hvFactor    float64
	hasHVFactor bool
	code        bool // a bitfield/id - rounded to an integer, never to 0,1
}

type namedField struct {
	name string
	f    field
}

// family is one register map.
type family struct {
	label      string
	hasBattery bool
	reads      []ReadSpec
	hasScale   bool // scaleReg present (hybrid_3p)
	soc        *field
	battVolt   *field
	batt       *field
	grid       *field
	gridFb     *field
	load       *field
	pv         *field
	bms        []namedField // decode order = the JS key order
}

func f16(addr int, signed bool, scale float64) *field {
	return &field{addr: addr, bits: 16, signed: signed, scale: scale}
}

var families = map[string]*family{
	// String grid-tie inverter: only its own AC output (0x0050/0x0051,
	// 32-bit low-word-first, x0.1 -> W) = total PV generation.
	FamilyString: {
		label: "String / netzgekoppelt (ohne Speicher)",
		reads: []ReadSpec{{Start: 0x0050, Count: 0x0002}},
		pv:    &field{addr: 0x0050, bits: 32, scale: 0.1},
	},

	// Single-phase hybrid, "low" map (SG03LP1).
	FamilyHybrid1P: {
		label:      "Hybrid 1-phasig (SG03LP1, low map)",
		hasBattery: true,
		reads:      []ReadSpec{{Start: 0x00a9, Count: 0x0016}},
		grid:       f16(0x00a9, true, 1),
		load:       f16(0x00b2, false, 1),
		soc:        &field{addr: 0x00b8, bits: 16, scale: 1, pct: true},
		battVolt:   f16(0x00b7, false, 0.01),
		pv:         &field{addrs: []int{0x00ba, 0x00bb}, bits: 16, scale: 1, sum: true},
		batt:       f16(0x00be, true, 1),
	},

	// Three-phase hybrid, "high" map (SG04LP3 LV / SG01HP3 HV). Grid = the
	// EXTERNAL CT total at the connection point; the "Grid Power" alias is the
	// fallback for reads that do not cover the external high word.
	FamilyHybrid3P: {
		label:      "Hybrid 3-phasig (SG04LP3 LV / SG01HP3 HV, high map, bis 4 MPPT)",
		hasBattery: true,
		reads: []ReadSpec{
			{Start: deviceReg, Count: 0x0001},
			{Start: 0x024b, Count: 0x007a},
			{Start: bmsBlockStart, Count: bmsBlockCount, Optional: true},
		},
		hasScale: true,
		soc:      &field{addr: 0x024c, bits: 16, scale: 1, pct: true},
		battVolt: &field{addr: 0x024b, bits: 16, scale: 0.01, hv: true},
		batt:     &field{addr: 0x024e, bits: 16, signed: true, scale: 1, hv: true},
		grid:     &field{addrs: []int{0x026b, 0x02c4}, bits: 32, signed: true, scale: 1},
		gridFb:   &field{addrs: []int{0x0271, 0x02b2}, bits: 32, signed: true, scale: 1},
		load:     &field{addrs: []int{0x028d, 0x0293}, bits: 32, signed: true, scale: 1},
		pv:       &field{addrs: []int{0x02a0, 0x02a1, 0x02a2, 0x02a3}, bits: 16, scale: 1, sum: true, hv: true},
		bms: []namedField{
			{"bms_charge_voltage_v", field{addr: 0x00d2, bits: 16, scale: 0.01, hv: true}},
			{"bms_discharge_voltage_v", field{addr: 0x00d3, bits: 16, scale: 0.01, hv: true}},
			{"bms_charge_limit_a", field{addr: 0x00d4, bits: 16, scale: 1}},
			{"bms_discharge_limit_a", field{addr: 0x00d5, bits: 16, scale: 1}},
			{"bms_soc_pct", field{addr: bmsSocReg, bits: 16, scale: 1, pct: true}},
			{"bms_voltage_v", field{addr: 0x00d7, bits: 16, scale: 0.01, hv: true}},
			{"bms_current_a", field{addr: 0x00d8, bits: 16, signed: true, scale: 1, hvFactor: 0.1, hasHVFactor: true}},
			{"bms_max_charge_limit_a", field{addr: 0x00da, bits: 16, scale: 1}},
			{"bms_max_discharge_limit_a", field{addr: 0x00db, bits: 16, scale: 1}},
			{"bms_alarm", field{addr: 0x00dc, bits: 16, scale: 1, code: true}},
			{"bms_fault", field{addr: 0x00dd, bits: 16, scale: 1, code: true}},
			{"bms_type", field{addr: 0x00df, bits: 16, scale: 1, code: true}},
		},
	},

	// Micro-inverter (SUN*G3): AC output 0x0056/0x0057 (32-bit, x0.1 -> W).
	FamilyMicro: {
		label: "Mikrowechselrichter (SUN*G3, Erzeugung + Leistungsbegrenzung)",
		reads: []ReadSpec{{Start: 0x0056, Count: 0x0002}},
		pv:    &field{addr: 0x0056, bits: 32, scale: 0.1},
	},
}

// Known reports whether family has a register map.
func Known(familyName string) bool {
	_, ok := families[familyName]
	return ok
}

// Label is the German label of a family ("" when unknown).
func Label(familyName string) string {
	if f, ok := families[familyName]; ok {
		return f.label
	}
	return ""
}

// HasBattery reports whether the family carries a battery.
func HasBattery(familyName string) bool {
	f, ok := families[familyName]
	return ok && f.hasBattery
}

// PlanReads is the family's per-poll read plan (empty for an unknown family).
func PlanReads(familyName string) []ReadSpec {
	f, ok := families[familyName]
	if !ok {
		return []ReadSpec{}
	}
	return append([]ReadSpec(nil), f.reads...)
}
