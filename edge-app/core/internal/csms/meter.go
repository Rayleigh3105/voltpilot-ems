package csms

import (
	"math"
	"strconv"
	"strings"
)

// SampledReading is ONE sampled value out of an OCPP MeterValues message, in
// plain types (the ocpp-go SampledValue mapped 1:1 in ocppmap.go). Keeping the
// parser on plain strings is what lets it be unit-tested without the library
// and without a socket.
type SampledReading struct {
	Value     string
	Measurand string
	Unit      string
	Phase     string
	Context   string
}

// MeterReading is what one MeterValues message told us about a connector. A
// field the station did not report stays nil — an absent measurand is NEVER a
// zero one (the house rule that made the Deye SoC honest).
type MeterReading struct {
	PowerKw   *float64
	EnergyKwh *float64
	SocPct    *float64
	// Dropped counts sampled values this parser refused (unparseable number,
	// implausible SoC, unusable unit). The caller logs it rate-limited; a
	// silent drop is a riddle.
	Dropped int
}

// Empty reports whether the reading carries no usable measurand at all.
func (m MeterReading) Empty() bool {
	return m.PowerKw == nil && m.EnergyKwh == nil && m.SocPct == nil
}

// OCPP 1.6 measurand + unit vocabulary this parser understands. Everything
// else is ignored (not an error: a station may sample voltage, current,
// temperature and frequency, all of which are simply none of our business).
const (
	MeasurandPowerActiveImport    = "Power.Active.Import"
	MeasurandEnergyImportRegister = "Energy.Active.Import.Register"
	MeasurandSoC                  = "SoC"
)

// ParseMeterValues folds the sampled values of ONE MeterValues message into a
// reading. The rules are the OCPP 1.6 defaults, spelled out because each one
// has bitten somebody somewhere:
//
//   - an ABSENT measurand means Energy.Active.Import.Register (spec default) —
//     the single most common shape on cheap firmware;
//   - an ABSENT unit means the spec default for the measurand (W for power,
//     Wh for energy, Percent for SoC), never "kilo";
//   - a PER-PHASE power sample is not the total: an unphased sample always
//     wins, and only if there is none do L1+L2+L3 get summed (that sum IS the
//     three-phase total; any other phase label is left alone);
//   - a later sample of the same measurand overwrites an earlier one;
//   - a value that is not a finite number is DROPPED and counted, never
//     stored as 0.
func ParseMeterValues(samples []SampledReading) MeterReading {
	var out MeterReading
	phasePower := map[string]float64{}

	for _, s := range samples {
		measurand := strings.TrimSpace(s.Measurand)
		if measurand == "" {
			measurand = MeasurandEnergyImportRegister
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(s.Value), 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			// Only count a drop for a measurand we would have used - a
			// garbage temperature reading is not our problem.
			if measurand == MeasurandPowerActiveImport ||
				measurand == MeasurandEnergyImportRegister ||
				measurand == MeasurandSoC {
				out.Dropped++
			}
			continue
		}
		unit := strings.TrimSpace(s.Unit)
		phase := strings.TrimSpace(s.Phase)

		switch measurand {
		case MeasurandPowerActiveImport:
			kw, ok := powerToKw(v, unit)
			if !ok {
				out.Dropped++
				continue
			}
			if phase == "" {
				out.PowerKw = &kw
			} else if isLinePhase(phase) {
				phasePower[phase] = kw
			}
		case MeasurandEnergyImportRegister:
			kwh, ok := energyToKwh(v, unit)
			if !ok {
				out.Dropped++
				continue
			}
			// A per-phase energy register is not the connector's total; only
			// the unphased register counts.
			if phase == "" {
				out.EnergyKwh = &kwh
			}
		case MeasurandSoC:
			// The plausibility band is [0,100]: unlike a battery inverter's
			// SoC (where a 0 meant "the logger could not reach the device",
			// hence the (0,100] rule), an EV legitimately arrives at 0 %.
			// Outside the band the whole sample is refused.
			if unit != "" && unit != "Percent" {
				out.Dropped++
				continue
			}
			if v < 0 || v > 100 {
				out.Dropped++
				continue
			}
			soc := v
			out.SocPct = &soc
		}
	}

	// Only fall back to the phase sum when no unphased total was reported.
	if out.PowerKw == nil && len(phasePower) > 0 {
		sum := 0.0
		for _, kw := range phasePower {
			sum += kw
		}
		out.PowerKw = &sum
	}
	return out
}

// isLinePhase reports whether p is one of the three LINE phases whose powers
// sum to the total. "L1-N"/"L1-L2"/"N" are deliberately excluded: summing
// those double-counts or measures something else entirely.
func isLinePhase(p string) bool { return p == "L1" || p == "L2" || p == "L3" }

// powerToKw converts an active-power sample to kW. The OCPP default unit for a
// power measurand is W.
func powerToKw(v float64, unit string) (float64, bool) {
	switch unit {
	case "", "W":
		return v / 1000, true
	case "kW":
		return v, true
	}
	return 0, false
}

// energyToKwh converts an energy-register sample to kWh. The OCPP default unit
// for an energy measurand is Wh.
func energyToKwh(v float64, unit string) (float64, bool) {
	switch unit {
	case "", "Wh":
		return v / 1000, true
	case "kWh":
		return v, true
	}
	return 0, false
}
