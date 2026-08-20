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

	// A phase-to-neutral / phase-to-phase label is NOT one of the three line
	// phases and is left alone rather than summed into something meaningless.
	got = ParseMeterValues([]SampledReading{
		{Value: "3600", Measurand: MeasurandPowerActiveImport, Unit: "W", Phase: "L1-N"},
	})
	eq(t, "L1-N ignored", got.PowerKw, nil)

	// A per-phase ENERGY register is not the connector's total either.
	got = ParseMeterValues([]SampledReading{
		{Value: "1000", Measurand: MeasurandEnergyImportRegister, Unit: "Wh", Phase: "L1"},
	})
	eq(t, "phased energy ignored", got.EnergyKwh, nil)
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
