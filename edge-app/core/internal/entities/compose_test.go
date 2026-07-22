package entities

import "testing"

// pilotRegistry is the 3-entity set a v1->v2 migrated plant gets pushed
// (battery-hybrid + grid-meter + house-load), with exactly the measure
// capabilities the cloud composes.
func pilotRegistry() Registry {
	return Registry{
		Revision: "r1",
		Entities: []Entity{
			{ID: "batt", Type: TypeBatteryHybrid, Capabilities: Capabilities{Measure: []MeasureCap{
				{Channel: "soc_pct"}, {Channel: "pv_power_kw"}, {Channel: "battery_power_kw"},
			}}},
			{ID: "grid", Type: TypeGridMeter, Capabilities: Capabilities{Measure: []MeasureCap{
				{Channel: "power_kw"},
			}}},
			{ID: "haus", Type: TypeHouseLoad, Capabilities: Capabilities{Measure: []MeasureCap{
				{Channel: "power_kw"},
			}}},
		},
	}
}

func want(t *testing.T, got map[string]map[string]float64, entity, channel string, exp float64) {
	t.Helper()
	v, ok := got[entity][channel]
	if !ok {
		t.Fatalf("%s/%s missing, got %v", entity, channel, got)
	}
	if d := v - exp; d > 1e-9 || d < -1e-9 {
		t.Fatalf("%s/%s = %v, want %v", entity, channel, v, exp)
	}
}

func absent(t *testing.T, got map[string]map[string]float64, entity, channel string) {
	t.Helper()
	if v, ok := got[entity][channel]; ok {
		t.Fatalf("%s/%s should be absent, got %v", entity, channel, v)
	}
}

// The report §3 channel map, byte-for-byte the cloud fan-out's - incl. the
// derived battery power (power_kw - load_kw + pv_power_kw).
func TestComposeLocalDerivesTheThreeComposedEntities(t *testing.T) {
	got := ComposeLocal(pilotRegistry(), map[string]float64{
		"pv_power_kw": 5.85,
		"load_kw":     0.70,
		"power_kw":    -5.15, // exporting
		"soc_pct":     87,
	})
	want(t, got, "batt", "soc_pct", 87)
	want(t, got, "batt", "pv_power_kw", 5.85)
	// -5.15 - 0.70 + 5.85 = 0 (a balanced site: everything not consumed is fed in)
	want(t, got, "batt", "battery_power_kw", 0)
	want(t, got, "grid", "power_kw", -5.15)
	want(t, got, "haus", "power_kw", 0.70)
}

// A charging battery: grid 2.0 import, house 1.0, pv 4.0 -> battery +5.0 kW.
func TestComposeLocalBatteryPowerSignIsChargePositive(t *testing.T) {
	got := ComposeLocal(pilotRegistry(), map[string]float64{
		"pv_power_kw": 4, "load_kw": 1, "power_kw": 2, "soc_pct": 50,
	})
	want(t, got, "batt", "battery_power_kw", 5)
}

// Absent site channels produce NO entity value - never a fabricated 0. The
// derived battery power needs ALL THREE of its inputs.
func TestComposeLocalNullChannelYieldsNoValue(t *testing.T) {
	// A provable hybrid whose battery register was unreadable drops load_kw:
	// the derivation is then honestly not computable.
	got := ComposeLocal(pilotRegistry(), map[string]float64{
		"pv_power_kw": 4, "power_kw": 2,
	})
	want(t, got, "batt", "pv_power_kw", 4)
	want(t, got, "grid", "power_kw", 2)
	absent(t, got, "batt", "battery_power_kw")
	absent(t, got, "batt", "soc_pct")
	// No load_kw at all -> the house entity contributes nothing (it is omitted
	// entirely rather than carrying a zero).
	if _, ok := got["haus"]; ok {
		t.Fatalf("house entity should be omitted without load_kw, got %v", got["haus"])
	}
}

// A grid meter genuinely reading 0 kW is a VALUE, not an absence.
func TestComposeLocalKeepsARealZero(t *testing.T) {
	got := ComposeLocal(pilotRegistry(), map[string]float64{"power_kw": 0, "load_kw": 0})
	want(t, got, "grid", "power_kw", 0)
	want(t, got, "haus", "power_kw", 0)
}

// Only COMPOSED types are fed: a producer has its own source, a wallbox its own
// driver - neither may be filled from the site sample.
func TestComposeLocalTouchesOnlyComposedTypes(t *testing.T) {
	reg := Registry{Entities: []Entity{
		{ID: "pv2", Type: TypeProducer, Capabilities: Capabilities{Measure: []MeasureCap{{Channel: "pv_power_kw"}}}},
		{ID: "wb", Type: TypeWallbox, Capabilities: Capabilities{Measure: []MeasureCap{{Channel: "power_kw"}}}},
	}}
	got := ComposeLocal(reg, map[string]float64{"pv_power_kw": 4, "power_kw": 2, "load_kw": 1})
	if len(got) != 0 {
		t.Fatalf("only composed types may be fed, got %v", got)
	}
}

// Only channels the entity DECLARES are composed (the registry is the contract
// for what an entity reports).
func TestComposeLocalRespectsDeclaredCapabilities(t *testing.T) {
	reg := Registry{Entities: []Entity{
		{ID: "batt", Type: TypeBatteryHybrid, Capabilities: Capabilities{Measure: []MeasureCap{
			{Channel: "soc_pct"},
		}}},
	}}
	got := ComposeLocal(reg, map[string]float64{
		"pv_power_kw": 4, "load_kw": 1, "power_kw": 2, "soc_pct": 50,
	})
	want(t, got, "batt", "soc_pct", 50)
	absent(t, got, "batt", "pv_power_kw")
	absent(t, got, "batt", "battery_power_kw")
}

// A device without a pushed registry composes nothing (byte-for-byte v1).
func TestComposeLocalWithoutRegistryIsEmpty(t *testing.T) {
	got := ComposeLocal(Registry{}, map[string]float64{"power_kw": 2, "load_kw": 1, "pv_power_kw": 4})
	if len(got) != 0 {
		t.Fatalf("no registry must compose nothing, got %v", got)
	}
}

// house-load is CATEGORY-PINNED like the other composed types: it declares no
// actuate capability, so the "measure-only" inference would make it a METER and
// the topology read-model would fold the Hausverbrauch into the Netz node
// instead of emitting its own Verbraucher node. Must agree with the cloud type
// catalog (services/api .../entitytypes/catalog.json: category consumer).
func TestHouseLoadIsAConsumerNotAMeter(t *testing.T) {
	e := Entity{ID: "haus", Type: TypeHouseLoad,
		Capabilities: Capabilities{Measure: []MeasureCap{{Channel: "power_kw"}}},
		Guards:       Guards{Failsafe: Failsafe{Behavior: "measure-only"}}}
	if got := e.Category(); got != "consumer" {
		t.Fatalf("house-load category = %q, want consumer", got)
	}
	// Guard-safe: with no actuate capability nothing is commandable anyway.
	for _, cmd := range []string{CmdSetpointKw, CmdOnOff, CmdLimitKw, CmdLimitPct, CmdMode} {
		if e.Supports(cmd) {
			t.Fatalf("house-load must never accept %s", cmd)
		}
	}
	if got := (Entity{ID: "g", Type: TypeGridMeter}).Category(); got != "measure-only" {
		t.Fatalf("grid-meter category regressed: %q", got)
	}
}
