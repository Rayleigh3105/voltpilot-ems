package plan

import (
	"testing"
	"time"
)

// MiSpeL MP-45: strict_exclusivity / strict_exclusivity_tolerance_kwh are
// parsed, survive the disk round-trip, and are OFF unless the cloud says so -
// off is the default (FK3), the switch is the operator's and never inferred.
func TestParseStrictExclusivity(t *testing.T) {
	slot := `{ "start": "2026-10-02T09:00:00Z", "battery_setpoint_kw": 5.0 }`
	parse := func(extra string) *Plan {
		t.Helper()
		p, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"grid_charge_allowed":false`+
			extra+`,"slots":[`+slot+`]}`), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	if p := parse(``); p.StrictExclusivityCharge() || p.StrictToleranceKw() != 0 {
		t.Fatalf("absent field must stay off (FK3): %+v", p)
	}
	var none *Plan
	if none.StrictExclusivityCharge() || none.StrictToleranceKw() != 0 {
		t.Fatal("no plan must stay off")
	}
	if p := parse(`,"strict_exclusivity":false,"strict_exclusivity_tolerance_kwh":0.5`); p.StrictExclusivityCharge() ||
		p.StrictToleranceKw() != 0 {
		t.Fatalf("explicit false must stay off and carry no tolerance: %+v", p)
	}

	on := parse(`,"strict_exclusivity":true,"strict_exclusivity_tolerance_kwh":0.25`)
	if !on.StrictExclusivityCharge() {
		t.Fatal("strict_exclusivity=true must switch the strict clamp on")
	}
	// 0.25 kWh per quarter hour = 1 kW of import while charging.
	if got := on.StrictToleranceKw(); got != 1 {
		t.Fatalf("tolerance 0.25 kWh / 0.25 h = 1 kW, got %v", got)
	}
	if p := parse(`,"strict_exclusivity":true`); !p.StrictExclusivityCharge() || p.StrictToleranceKw() != 0 {
		t.Fatalf("strict without tolerance = tolerance 0: %+v", p)
	}
	if p := parse(`,"strict_exclusivity":true,"strict_exclusivity_tolerance_kwh":-1`); p.StrictToleranceKw() != 0 {
		t.Fatalf("a negative tolerance is dropped (strictest), got %v", p.StrictToleranceKw())
	}

	// Disk round-trip (restart): the posture survives.
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(on); err != nil {
		t.Fatal(err)
	}
	s2, _ := NewStore(dir)
	back, err := s2.Load()
	if err != nil || back == nil {
		t.Fatalf("load after restart: %v %v", back, err)
	}
	if !back.StrictExclusivityCharge() || back.StrictToleranceKw() != 1 {
		t.Fatalf("persisted plan lost the strict posture: %+v", back)
	}
}
