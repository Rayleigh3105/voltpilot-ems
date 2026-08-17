package inverter

import "fmt"

// The DEVICE'S OWN feed-in limit at the grid connection point - a foreign truth
// inside the customer's inverter that we READ and never write („Grenzen &
// Wächter" Stufe 0, Vierer #4).
//
// WHY THIS EXISTS: at Anlage Herzogau the Deye held an installer cap of 33,0 kW
// in register 0x00E7 while 70 kW were configured in the portal. That
// discrepancy was invisible through two investigation rounds - not because the
// data was hard to get, but because nobody read the register (scout
// vp-herzogau-runde2-m6 §3 K1 / §7 point 4). One register read a day closes it.
//
// ⚠ THE REGISTER FACTS ARE A CROSS-SIDE TWIN of `DEYE_EXPORT_LIMIT` in
// edge-app/nodered/inverter-routing.js (which builds the read plan) - the
// address AND the scale must match, or the decoded value is off by 10x. Change
// both together; `TestExportLimitRegisterMatchesTheNodeRedTable` reads the JS
// table by PATH and compares.
//
// ⚠ WHY hybrid_1p IS DELIBERATELY ABSENT (this is the honesty rule of the whole
// feature, not an omission): on that family the feed-in-cap register IS
// „Max Sell Power" (0x00F5), which our OWN discharge lever writes
// (inverter-control-routing.js DEYE_CONTROL_REG.hybrid_1p.maxSellPower ===
// exportLimit). Reading it back would report OUR commanded value as „the limit
// the device itself holds" - a fabricated foreign truth. A family we cannot
// read honestly reports NOTHING, and the surfaces say „unbekannt".
//
// The other families are absent for the plain reason that their register maps
// carry no trustworthy feed-in cap: string/micro expose only an active-power
// PERCENT (0x0028, not a kW cap at the connection point), and the non-Deye
// transports (Fronius Solar API / SunSpec, Kostal, go-e, Shelly) are read
// through other protocols entirely.
type ExportLimitRegister struct {
	// Addr is the holding-register address (FC3).
	Addr int
	// Scale converts the raw register word to WATTS (raw * Scale = W).
	Scale float64
	// Label is the register's name in the manufacturer's map, for the log and
	// the operator-facing register hint ("0x00e7").
	Label string
}

// exportLimitRegisters is keyed by REGISTER-MAP FAMILY, not by model - the map
// is what decides where a value lives.
var exportLimitRegisters = map[string]ExportLimitRegister{
	// Deye 3-phase hybrid (SG04LP3 LV + SG01HP3 HV): „Grid Max Export power",
	// a DEDICATED feed-in cap, separate from maxSellPower (0x008F). Fixed
	// scale 10 (register = W / 10), independent of the LV/HV power class.
	FamHybrid3p: {Addr: 0x00e7, Scale: 10, Label: "0x00e7"},
}

// ExportLimitRegisterFor returns the family's own feed-in-cap register, or
// ok=false when the family has none we may TRUST (see the type doc). A caller
// that gets ok=false must report nothing at all - never a fabricated 0 and
// never „the device has no limit".
func ExportLimitRegisterFor(family string) (ExportLimitRegister, bool) {
	r, ok := exportLimitRegisters[family]
	return r, ok
}

// DecodeExportLimitKw turns one raw register word into kW at the grid
// connection point. The register is an unsigned word on every family we read,
// so there is no sign to interpret - a value of 0 is a VALUE („this inverter
// may not feed in at all"), never an absence.
func (r ExportLimitRegister) DecodeExportLimitKw(raw uint16) float64 {
	return float64(raw) * r.Scale / 1000
}

// String is the log/diagnostic form.
func (r ExportLimitRegister) String() string {
	return fmt.Sprintf("%s (x%g W)", r.Label, r.Scale)
}
