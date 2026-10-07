package deyedecode

import "math"

// Drop rules: WHY the SoC gate refused a read (deye-decode.js).
const (
	// RuleNoAnswer: the whole measurement block is zeros - the logger's empty
	// answer. Hard drop, opt-in or not.
	RuleNoAnswer = "no_answer"
	// RuleMissing: the block is alive and only the SoC is an exact 0 (the BMS
	// reports nothing). The ONLY case allow_missing_soc may keep.
	RuleMissing = "missing"
	// RuleOutOfRange: a SoC outside (0,100] - a broken frame. Hard drop.
	RuleOutOfRange = "out_of_range"
)

// SoC provenance on the LOCAL bus (never a cloud field).
const (
	SocSourceBMS     = "bms"
	SocSourceVoltage = "voltage"
)

// Estimate clamp: 0 is the empty-answer signature both plausibility gates key
// on, so an estimated 0 would be dropped at the next choke point.
const (
	socEstimateMinPct = 1
	socEstimateMaxPct = 100
)

// Block is one completed register read ({start, regs} in the JS module).
type Block struct {
	Start int
	Regs  []uint16
}

// VoltRange is the pack's two ends for the voltage-based SoC estimate.
type VoltRange struct {
	VEmpty float64
	VFull  float64
}

// Config is the decode configuration (the reader's cfg object).
type Config struct {
	Family          string
	InvertGridSign  bool
	InvertBattSign  bool
	AllowMissingSoc bool
	// PowerScale is the MANUAL HV/LV override: 1 or 10 wins, anything else
	// means auto-detect from the device-identity register.
	PowerScale float64
	// SocFromVoltage is the raw configured pair; Valid() applies the JS rules.
	SocFromVoltage *VoltRange
}

// Estimate is a voltage-based SoC estimate.
type Estimate struct {
	SocPct   float64 `json:"soc_pct"`
	VoltageV float64 `json:"voltage_v"`
}

// BMSSoc is the coupled BMS's own measured SoC.
type BMSSoc struct {
	SocPct float64 `json:"soc_pct"`
}

// Drop names the channel the SoC gate refused, the rule, and the evidence.
type Drop struct {
	Channel  string    `json:"channel"`
	Rule     string    `json:"rule"`
	Raw      *uint16   `json:"raw,omitempty"`
	Value    *float64  `json:"value,omitempty"`
	BMS      *BMSSoc   `json:"bms,omitempty"`
	Estimate *Estimate `json:"estimate,omitempty"`
}

// Verbose is decodeVerbose's result: Reading never carries the dropped
// channel; Drop says what was dropped.
type Verbose struct {
	Reading map[string]float64
	BattKw  *float64
	Drop    *Drop
}

// Result is decode's result: the publishable reading, its SoC provenance
// ("" = the inverter's own SoC register) and the measured battery power.
type Result struct {
	Reading   map[string]float64
	SocSource string
	BattKw    *float64
}

// --- JavaScript-faithful arithmetic ------------------------------------------

// jsRound is Math.round: half towards +Infinity (Go's math.Round rounds half
// away from zero, which differs for negative ties).
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func round3(x float64) float64 { return jsRound(x*1000) / 1000 }
func round1(x float64) float64 { return jsRound(x*10) / 10 }

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// SocPlausible: a battery SoC is a percentage in (0, 100]; an exact 0 is the
// logger's empty-answer signature. The Go twin guards.SocPlausible keeps the
// same rule at the core's ingest.
func SocPlausible(pct float64) bool {
	return finite(pct) && pct > 0 && pct <= 100
}

// readReg looks an absolute register up across the blocks.
func readReg(blocks []Block, addr int) (uint16, bool) {
	for _, b := range blocks {
		off := addr - b.Start
		if off >= 0 && off < len(b.Regs) {
			return b.Regs[off], true
		}
	}
	return 0, false
}

func s16(v uint16) float64 { return float64(int16(v)) }
func u16(v uint16) float64 { return float64(v) }

// fieldValue resolves a field into its SCALED physical value (W, %, V, A).
func fieldValue(blocks []Block, f *field) (float64, bool) {
	var raw float64
	switch {
	case f.bits == 32:
		loAddr, hiAddr := f.addr, f.addr+1
		if f.addrs != nil {
			loAddr, hiAddr = f.addrs[0], f.addrs[1]
		}
		lo, ok1 := readReg(blocks, loAddr)
		hi, ok2 := readReg(blocks, hiAddr)
		if !ok1 || !ok2 {
			return 0, false
		}
		raw = float64(hi)*65536 + float64(lo) // LOW-WORD-FIRST
		if f.signed && raw > 0x7fffffff {
			raw -= 0x100000000
		}
	case f.sum:
		for _, a := range f.addrs {
			v, ok := readReg(blocks, a)
			if !ok {
				return 0, false
			}
			if f.signed {
				raw += s16(v)
			} else {
				raw += u16(v)
			}
		}
	default:
		v, ok := readReg(blocks, f.addr)
		if !ok {
			return 0, false
		}
		if f.signed {
			raw = s16(v)
		} else {
			raw = u16(v)
		}
	}
	return raw * f.scale, true
}

// scaleClass reads the LV/HV class from the device-identity register.
func scaleClass(blocks []Block, fam *family) (float64, bool) {
	if !fam.hasScale {
		return 0, false
	}
	code, ok := readReg(blocks, deviceReg)
	if !ok {
		return 0, false
	}
	for _, c := range deviceTypesHV {
		if int(code) == c {
			return 10, true
		}
	}
	for _, c := range deviceTypesLV {
		if int(code) == c {
			return 1, true
		}
	}
	return 0, false
}

func fieldAddrs(f *field) []int {
	if f.addrs != nil {
		return f.addrs
	}
	if f.bits == 32 {
		return []int{f.addr, f.addr + 1}
	}
	return []int{f.addr}
}

// blockAlive: did the plant's POWER channels move, or is this the logger's
// all-zero empty answer? soc (under judgement) and battVolt (an estimate
// input only) are deliberately not witnesses.
func blockAlive(blocks []Block, fam *family) bool {
	for _, f := range []*field{fam.grid, fam.gridFb, fam.load, fam.pv, fam.batt} {
		if f == nil {
			continue
		}
		for _, a := range fieldAddrs(f) {
			if v, ok := readReg(blocks, a); ok && v != 0 {
				return true
			}
		}
	}
	return false
}

// bmsCoupled: is there a BMS behind the block at all? Fourteen zeros (or no
// block) are the "no CAN coupling" signature.
func bmsCoupled(blocks []Block, fam *family) bool {
	if len(fam.bms) == 0 {
		return false
	}
	for a := bmsBlockStart; a < bmsBlockStart+bmsBlockCount; a++ {
		if v, ok := readReg(blocks, a); ok && v != 0 {
			return true
		}
	}
	return false
}

// socFromVoltageConfig validates the configured pair (nil = no estimate).
func socFromVoltageConfig(cfg Config) *VoltRange {
	r := cfg.SocFromVoltage
	if r == nil || !finite(r.VEmpty) || !finite(r.VFull) {
		return nil
	}
	if !(r.VEmpty > 0) || !(r.VFull > r.VEmpty) {
		return nil
	}
	return r
}

// estimateSocFromVoltage interpolates linearly, rounds to 0,1 % and clamps to
// [1, 100]. ok=false for an unusable voltage - never a fabricated value.
func estimateSocFromVoltage(volts float64, haveVolts bool, r *VoltRange) (float64, bool) {
	if r == nil || !haveVolts || !finite(volts) || volts <= 0 {
		return 0, false
	}
	pct := ((volts - r.VEmpty) / (r.VFull - r.VEmpty)) * 100
	if !finite(pct) {
		return 0, false
	}
	return math.Max(socEstimateMinPct, math.Min(socEstimateMaxPct, round1(pct))), true
}

// DecodeVerbose is decodeVerbose: the reading plus WHAT the SoC gate dropped
// and why. ok=false only for an unknown family.
func DecodeVerbose(blocks []Block, cfg Config) (*Verbose, bool) {
	fam, known := families[cfg.Family]
	if !known {
		return nil, false
	}

	// HV/LV multiplier for PV + battery: manual override 1|10 wins, else
	// auto-detect from 0x0000, else 1 - never a fabricated class.
	hvScale := 1.0
	if cfg.PowerScale == 1 || cfg.PowerScale == 10 {
		hvScale = cfg.PowerScale
	} else if detected, ok := scaleClass(blocks, fam); ok {
		hvScale = detected
	}
	isHV := hvScale == 10
	hvMult := func(f *field) float64 {
		if f.hasHVFactor {
			if isHV {
				return f.hvFactor
			}
			return 1
		}
		if f.hv {
			return hvScale
		}
		return 1
	}
	toKw := func(f *field, invert bool) (float64, bool) {
		w, ok := fieldValue(blocks, f)
		if !ok {
			return 0, false
		}
		if invert {
			w = -w
		}
		return round3((w * hvMult(f)) / 1000), true
	}
	scaled := func(f *field) (float64, bool) {
		v, ok := fieldValue(blocks, f)
		if !ok {
			return 0, false
		}
		return v * hvMult(f), true
	}

	out := &Verbose{Reading: map[string]float64{}}

	// The coupled BMS's channels first: 0x00D6 is also the gate's second way
	// out of `missing`, and both must be the same number.
	bmsSoc, haveBmsSoc := 0.0, false
	if bmsCoupled(blocks, fam) {
		for i := range fam.bms {
			nf := &fam.bms[i]
			v, ok := scaled(&nf.f)
			if !ok || !finite(v) {
				continue
			}
			if nf.f.pct && !SocPlausible(v) {
				continue
			}
			if nf.f.code {
				out.Reading[nf.name] = jsRound(v)
			} else {
				out.Reading[nf.name] = round1(v)
			}
		}
		if v, ok := out.Reading["bms_soc_pct"]; ok && SocPlausible(v) {
			bmsSoc, haveBmsSoc = v, true
		}
	}

	var socPct float64
	haveSoc := false
	if fam.hasBattery && fam.soc != nil {
		s, ok := fieldValue(blocks, fam.soc)
		if ok && SocPlausible(s) {
			socPct, haveSoc = round1(s), true
		} else {
			d := &Drop{Channel: "soc_pct", Rule: RuleOutOfRange}
			if ok && finite(s) {
				v := round1(s)
				d.Value = &v
				if v == 0 {
					if blockAlive(blocks, fam) {
						d.Rule = RuleMissing
					} else {
						d.Rule = RuleNoAnswer
					}
				}
			}
			if raw, rok := readReg(blocks, fam.soc.addr); rok {
				d.Raw = &raw
			}
			if d.Rule == RuleMissing {
				if haveBmsSoc {
					d.BMS = &BMSSoc{SocPct: bmsSoc}
				}
				if fam.battVolt != nil {
					if vr := socFromVoltageConfig(cfg); vr != nil {
						volts, vok := scaled(fam.battVolt)
						if est, eok := estimateSocFromVoltage(volts, vok, vr); eok {
							d.Estimate = &Estimate{SocPct: est, VoltageV: round1(volts)}
						}
					}
				}
			}
			out.Drop = d
		}
	}

	if fam.pv != nil {
		if kw, ok := toKw(fam.pv, false); ok {
			out.Reading["pv_power_kw"] = kw
		}
	}
	if fam.load != nil {
		if kw, ok := toKw(fam.load, false); ok {
			out.Reading["load_kw"] = kw
		}
	}
	if fam.grid != nil {
		kw, ok := toKw(fam.grid, cfg.InvertGridSign)
		if !ok && fam.gridFb != nil {
			kw, ok = toKw(fam.gridFb, cfg.InvertGridSign)
		}
		if ok {
			out.Reading["power_kw"] = kw
		}
	}
	if haveSoc {
		out.Reading["soc_pct"] = socPct
	}
	if fam.hasBattery && fam.batt != nil {
		if kw, ok := toKw(fam.batt, cfg.InvertBattSign); ok {
			out.BattKw = &kw
		}
	}
	return out, true
}

// Decode is decode(): the publishable reading, or nil when the read must be
// dropped (an implausible SoC that no rule may keep, or an unknown family).
func Decode(blocks []Block, cfg Config) *Result {
	v, ok := DecodeVerbose(blocks, cfg)
	if !ok {
		return nil
	}
	if v.Drop == nil {
		return &Result{Reading: v.Reading, BattKw: v.BattKw}
	}
	// The coupled BMS answered where the headline register did not (P4): a
	// MEASURED SoC, no opt-in needed.
	if v.Drop.Rule == RuleMissing && v.Drop.BMS != nil {
		v.Reading["soc_pct"] = v.Drop.BMS.SocPct
		return &Result{Reading: v.Reading, SocSource: SocSourceBMS, BattKw: v.BattKw}
	}
	if cfg.AllowMissingSoc && v.Drop.Rule == RuleMissing {
		if v.Drop.Estimate != nil {
			v.Reading["soc_pct"] = v.Drop.Estimate.SocPct
			return &Result{Reading: v.Reading, SocSource: SocSourceVoltage, BattKw: v.BattKw}
		}
		return &Result{Reading: v.Reading, BattKw: v.BattKw}
	}
	return nil
}
