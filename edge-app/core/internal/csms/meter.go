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
	Value     string `json:"value"`
	Measurand string `json:"measurand"`
	Unit      string `json:"unit,omitempty"`
	Phase     string `json:"phase,omitempty"`
	Context   string `json:"context,omitempty"`
	Format    string `json:"format,omitempty"`
	Location  string `json:"location,omitempty"`
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
// else is ignored (not an error: a station may sample temperature and
// frequency, which are simply none of our business). Current and voltage only
// stand in for a missing power value (W-06).
const (
	MeasurandPowerActiveImport    = "Power.Active.Import"
	MeasurandEnergyImportRegister = "Energy.Active.Import.Register"
	MeasurandSoC                  = "SoC"
	MeasurandCurrentImport        = "Current.Import"
	MeasurandVoltage              = "Voltage"
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
//     wins, and only if there is none do the three line phases get summed
//     (that sum IS the three-phase total). "L1" and "L1-N" name the same
//     phase - many stations meter phase power against neutral - and count
//     once; "L1-L2" and "N" are left alone;
//   - a station that reports no power at all but current AND voltage gets its
//     power from them, phase by phase (W-06): Σ I × U. That is the apparent
//     power, which an EV charger's near-unity power factor makes the active
//     one. A phase without a voltage is NOT given a nominal 230 V - then there
//     is no power, never a guessed one;
//   - a later sample of the same measurand overwrites an earlier one;
//   - a value that is not a finite number is DROPPED and counted, never
//     stored as 0.
func ParseMeterValues(samples []SampledReading) MeterReading {
	var out MeterReading
	phasePower := map[string]float64{}
	phaseCurrent, phaseVoltage := map[string]float64{}, map[string]float64{}
	var current, voltage *float64

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
				measurand == MeasurandSoC ||
				measurand == MeasurandCurrentImport ||
				measurand == MeasurandVoltage {
				out.Dropped++
			}
			continue
		}
		unit := strings.TrimSpace(s.Unit)
		phase := strings.TrimSpace(s.Phase)
		line, isLine := linePhase(phase)

		switch measurand {
		case MeasurandPowerActiveImport:
			kw, ok := powerToKw(v, unit)
			if !ok {
				out.Dropped++
				continue
			}
			if phase == "" {
				out.PowerKw = &kw
			} else if isLine {
				phasePower[line] = kw
			}
		case MeasurandCurrentImport:
			if (unit != "" && unit != "A") || v < 0 {
				out.Dropped++
				continue
			}
			if phase == "" {
				a := v
				current = &a
			} else if isLine {
				phaseCurrent[line] = v
			}
		case MeasurandVoltage:
			// 0 V on a live phase is a firmware filler, not a measurement.
			if (unit != "" && unit != "V") || v <= 0 {
				out.Dropped++
				continue
			}
			if phase == "" {
				u := v
				voltage = &u
			} else if isLine {
				phaseVoltage[line] = v
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
	if out.PowerKw == nil {
		out.PowerKw = powerFromCurrent(current, voltage, phaseCurrent, phaseVoltage)
	}
	return out
}

// powerFromCurrent is the W-06 stand-in: Σ I × U over the reported phases, or
// I × U of the unphased pair. nil when any phase that carries current has no
// voltage to go with it - a partial sum would understate the draw.
func powerFromCurrent(current, voltage *float64, phaseCurrent, phaseVoltage map[string]float64) *float64 {
	if len(phaseCurrent) > 0 {
		sumW := 0.0
		for line, a := range phaseCurrent {
			if a == 0 {
				continue
			}
			u, ok := phaseVoltage[line]
			if !ok && voltage != nil {
				u, ok = *voltage, true
			}
			if !ok {
				return nil
			}
			sumW += a * u
		}
		kw := sumW / 1000
		return &kw
	}
	if current != nil && voltage != nil {
		kw := *current * *voltage / 1000
		return &kw
	}
	return nil
}

// linePhase maps a phase label to the LINE phase it measures: "L1" and the
// line-to-neutral "L1-N" are both phase 1. "L1-L2"/"N" are deliberately not a
// line phase: summing those double-counts or measures something else entirely.
func linePhase(p string) (string, bool) {
	switch p {
	case "L1", "L1-N":
		return "L1", true
	case "L2", "L2-N":
		return "L2", true
	case "L3", "L3-N":
		return "L3", true
	}
	return "", false
}

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
