package csms

import (
	"math"
	"testing"
)

func f(v float64) *float64 { return &v }

func eq(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil:
		t.Fatalf("%s: got nil, want %v", name, *want)
	case want == nil:
		t.Fatalf("%s: got %v, want nil (an absent measurand is NEVER a zero one)", name, *got)
	case math.Abs(*got-*want) > 1e-9:
		t.Fatalf("%s: got %v, want %v", name, *got, *want)
	}
}

// TestParseMeterValuesUnits pins the OCPP 1.6 unit defaults. Every one of them
// has bitten somebody: a station that omits the unit means W for power and Wh
// for energy - never kilo.
func TestParseMeterValuesUnits(t *testing.T) {
	cases := []struct {
		name    string
		in      []SampledReading
		power   *float64
		energy  *float64
		soc     *float64
		dropped int
	}{
		{
			name:  "watts and watt-hours",
			in:    []SampledReading{{Value: "41000", Measurand: MeasurandPowerActiveImport, Unit: "W"}, {Value: "12500", Measurand: MeasurandEnergyImportRegister, Unit: "Wh"}},
			power: f(41), energy: f(12.5),
		},
		{
			name:  "kilo units are taken as they are",
			in:    []SampledReading{{Value: "41", Measurand: MeasurandPowerActiveImport, Unit: "kW"}, {Value: "12.5", Measurand: MeasurandEnergyImportRegister, Unit: "kWh"}},
			power: f(41), energy: f(12.5),
		},
		{
			name:  "an absent unit is the spec default, not kilo",
			in:    []SampledReading{{Value: "7400", Measurand: MeasurandPowerActiveImport}, {Value: "1000", Measurand: MeasurandEnergyImportRegister}},
			power: f(7.4), energy: f(1),
		},
		{
			name:   "an absent measurand IS the energy register (spec default)",
			in:     []SampledReading{{Value: "9000"}},
			energy: f(9),
		},
		{
			name: "soc rides along",
			in:   []SampledReading{{Value: "64", Measurand: MeasurandSoC, Unit: "Percent"}},
			soc:  f(64),
		},
		{
			name:    "an unusable power unit is dropped, never coerced",
			in:      []SampledReading{{Value: "16", Measurand: MeasurandPowerActiveImport, Unit: "A"}},
			dropped: 1,
		},
		{
			name:    "garbage numbers are dropped and counted",
			in:      []SampledReading{{Value: "n/a", Measurand: MeasurandPowerActiveImport, Unit: "W"}, {Value: "NaN", Measurand: MeasurandSoC}},
			dropped: 2,
		},
		{
			name:    "a soc outside [0,100] is refused",
			in:      []SampledReading{{Value: "127", Measurand: MeasurandSoC}, {Value: "-1", Measurand: MeasurandSoC}},
			dropped: 2,
		},
		{
			name: "0 % is a legitimate EV state of charge",
			in:   []SampledReading{{Value: "0", Measurand: MeasurandSoC}},
			soc:  f(0),
		},
		{
			name: "measurands we do not use are simply ignored, not counted as drops",
			in:   []SampledReading{{Value: "230.1", Measurand: "Voltage", Unit: "V"}, {Value: "kaputt", Measurand: "Temperature"}},
		},
		{
			name:  "a later sample of the same measurand wins",
			in:    []SampledReading{{Value: "1000", Measurand: MeasurandPowerActiveImport, Unit: "W"}, {Value: "2000", Measurand: MeasurandPowerActiveImport, Unit: "W"}},
			power: f(2),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseMeterValues(tc.in)
			eq(t, "power", got.PowerKw, tc.power)
			eq(t, "energy", got.EnergyKwh, tc.energy)
			eq(t, "soc", got.SocPct, tc.soc)
			if got.Dropped != tc.dropped {
				t.Fatalf("dropped = %d, want %d", got.Dropped, tc.dropped)
			}
		})
	}
}

// TestPerPhasePowerIsNotTheTotal: a station that reports L1/L2/L3 separately
// reports THREE numbers, none of which is the connector's power. Taking one
// would understate the draw by two thirds - and understating a claim on a
// shared budget is the one direction that trips a fuse.
func TestPerPhasePowerIsNotTheTotal(t *testing.T) {
	got := ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1"},
		{Value: "3700", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L2"},
		{Value: "3700", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L3"},
	})
	eq(t, "phase sum", got.PowerKw, f(11.0))

	// An UNPHASED total always wins over the per-phase samples: summing on top
	// of a reported total would double-count.
	got = ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1"},
		{Value: "11000", Measurand: MeasurandPowerActiveImport, Unit: "W"},
	})
	eq(t, "unphased wins", got.PowerKw, f(11))

	// A phase-to-phase label is NOT one of the three line phases and is left
	// alone rather than summed into something meaningless.
	got = ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1-L2"},
	})
	eq(t, "L1-L2 ignored", got.PowerKw, nil)

	// A per-phase ENERGY register is not the connector's total either.
	got = ParseMeterValues([]SampledReading{
		{Value: "1000", Measurand: MeasurandEnergyImportRegister, Unit: "Wh", Phase: "L1"},
	})
	eq(t, "phased energy ignored", got.EnergyKwh, nil)
}

// TestLineToNeutralPowerIsThePhasePower is W-06 (audit probe A2b): many
// stations meter each phase's power against neutral. "L1-N" IS phase 1 - the
// old parser dropped the whole message's power, and „Nur Sonne" paused.
func TestLineToNeutralPowerIsThePhasePower(t *testing.T) {
	got := ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1-N"},
		{Value: "3700", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L2-N"},
		{Value: "3700", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L3-N"},
	})
	eq(t, "L1-N+L2-N+L3-N", got.PowerKw, f(11.0))

	// The same phase under both labels counts once, never twice.
	got = ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1"},
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1-N"},
	})
	eq(t, "L1 = L1-N", got.PowerKw, f(3.6))
}

// TestPowerFromCurrentAndVoltage is W-06 (audit probe A2a): a station that
// meters current and voltage but no power gets its power from them, phase by
// phase - and NEVER from a guessed voltage.
func TestPowerFromCurrentAndVoltage(t *testing.T) {
	got := ParseMeterValues([]SampledReading{
		{Value: "12345", Measurand: MeasurandEnergyImportRegister, Unit: "Wh"},
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L1"},
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L2"},
		{Value: "15.5", Measurand: "Current.Import", Unit: "A", Phase: "L3"},
		{Value: "230", Measurand: "Voltage", Unit: "V", Phase: "L1-N"},
		{Value: "230", Measurand: "Voltage", Unit: "V", Phase: "L2-N"},
		{Value: "230", Measurand: "Voltage", Unit: "V", Phase: "L3-N"},
	})
	eq(t, "Σ I×U", got.PowerKw, f(10.925))
	eq(t, "energy kept", got.EnergyKwh, f(12.345))

	// One phase charging, the unused phases at 0 A need no voltage of their own;
	// an unphased voltage stands for every phase.
	got = ParseMeterValues([]SampledReading{
		{Value: "16", Measurand: "Current.Import", Phase: "L1"},
		{Value: "0", Measurand: "Current.Import", Phase: "L2"},
		{Value: "232", Measurand: "Voltage"},
	})
	eq(t, "one phase", got.PowerKw, f(3.712))

	// Unphased current and voltage: a single-phase station.
	got = ParseMeterValues([]SampledReading{
		{Value: "10", Measurand: "Current.Import", Unit: "A"},
		{Value: "230", Measurand: "Voltage", Unit: "V"},
	})
	eq(t, "unphased pair", got.PowerKw, f(2.3))

	// A measured power always wins over the stand-in.
	got = ParseMeterValues([]SampledReading{
		{Value: "7000", Measurand: MeasurandPowerActiveImport, Unit: "W"},
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L1"},
		{Value: "230", Measurand: "Voltage", Unit: "V", Phase: "L1-N"},
	})
	eq(t, "power wins", got.PowerKw, f(7))

	// A phase with current but no voltage: no power - not 230 V by guess, and
	// not the partial sum of the other phases.
	got = ParseMeterValues([]SampledReading{
		{Value: "12345", Measurand: MeasurandEnergyImportRegister, Unit: "Wh"},
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L1"},
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L2"},
		{Value: "230", Measurand: "Voltage", Unit: "V", Phase: "L1-N"},
	})
	eq(t, "voltage missing", got.PowerKw, nil)
	got = ParseMeterValues([]SampledReading{
		{Value: "16", Measurand: "Current.Import", Unit: "A"},
	})
	eq(t, "current only", got.PowerKw, nil)

	// A 0-V filler is no voltage, and is counted as dropped.
	got = ParseMeterValues([]SampledReading{
		{Value: "16", Measurand: "Current.Import", Unit: "A", Phase: "L1"},
		{Value: "0", Measurand: "Voltage", Unit: "V", Phase: "L1-N"},
	})
	eq(t, "0 V filler", got.PowerKw, nil)
	if got.Dropped != 1 {
		t.Fatalf("0 V filler dropped = %d, want 1", got.Dropped)
	}
}

// TestEmptyReading: a message that carried nothing we use must be recognisable
// as such, so a connector's last good values are kept rather than blanked.
func TestEmptyReading(t *testing.T) {
	if !ParseMeterValues(nil).Empty() {
		t.Fatal("a nil sample list must be empty")
	}
	if !ParseMeterValues([]SampledReading{{Value: "230", Measurand: "Voltage", Unit: "V"}}).Empty() {
		t.Fatal("a voltage-only message must be empty for our purposes")
	}
	if ParseMeterValues([]SampledReading{{Value: "0", Measurand: MeasurandPowerActiveImport, Unit: "W"}}).Empty() {
		t.Fatal("a measured 0 W is a VALUE, not an absence")
	}
}
