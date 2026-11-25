package direktvermarkter_test

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

func TestEmbeddedProfilesLoad(t *testing.T) {
	if err := direktvermarkter.Err(); err != nil {
		t.Fatal(err)
	}
	if len(direktvermarkter.All()) == 0 {
		t.Fatal("no partner profiles embedded")
	}
}

// TestLuoxProfileMatchesTheCatalog pins the packaged view's content: a
// regression here means either catalog/direktvermarkter/profiles/luox.json
// or package_edge_runtime.py's resolution of F3/F8 changed without this test
// (and the catalog's own test_runtime_derivative_resolves_open_questions)
// being updated together.
func TestLuoxProfileMatchesTheCatalog(t *testing.T) {
	p, ok := direktvermarkter.For("luox")
	if !ok {
		t.Fatal("luox not embedded")
	}
	if p.Modbus.Unit != 1 {
		t.Errorf("unit = %d, want 1", p.Modbus.Unit)
	}
	if p.Modbus.WordOrder != "little" {
		t.Errorf("wortfolge = %q, want the resolved provisional default 'little' (F3 open)", p.Modbus.WordOrder)
	}
	if p.Modbus.Connections != 2 {
		t.Errorf("verbindungen = %d, want 2", p.Modbus.Connections)
	}
	wantFC := map[int]bool{3: true, 4: true, 6: true, 16: true}
	if len(p.Modbus.Functions) != len(wantFC) {
		t.Errorf("funktionen = %v, want %v", p.Modbus.Functions, wantFC)
	}
	for _, fc := range p.Modbus.Functions {
		if !wantFC[fc] {
			t.Errorf("unexpected function code %d", fc)
		}
	}
	if p.Rules.WatchdogDeadlineS != 900 {
		t.Errorf("lebenszeichen_frist_s = %d, want 900", p.Rules.WatchdogDeadlineS)
	}
	if p.Rules.RestPct != 100 {
		t.Errorf("ruhewert_pct = %d, want 100", p.Rules.RestPct)
	}
	if p.Rules.OnStale != "ausnahme_0x0b" {
		t.Errorf("bei_veraltet = %q, want the resolved provisional default (F8 open)", p.Rules.OnStale)
	}

	setpoint, ok := p.ByMeaning("vermarkter_vorgabe_pct")
	if !ok {
		t.Fatal("vermarkter_vorgabe_pct not in register map")
	}
	if setpoint.Table != "holding" || setpoint.Address != 2 || setpoint.Type != "u16" {
		t.Errorf("vermarkter_vorgabe_pct = %+v", setpoint)
	}
	if setpoint.Band == nil || *setpoint.Band != [2]int{0, 100} {
		t.Errorf("vermarkter_vorgabe_pct band = %v, want [0 100]", setpoint.Band)
	}

	watchdog, ok := p.ByMeaning("lebenszeichen")
	if !ok {
		t.Fatal("lebenszeichen not in register map")
	}
	if watchdog.Table != "holding" || watchdog.Address != 3 || watchdog.Type != "u32" || watchdog.Words() != 2 {
		t.Errorf("lebenszeichen = %+v", watchdog)
	}
	if watchdog.Band != nil {
		t.Errorf("lebenszeichen must not carry a band (no bound in the Lumenaza table)")
	}

	for _, meaning := range []string{"nvp_einspeisung_w", "erzeugung_w", "netzbetreiber_vorgabe_pct", "referenz_w"} {
		r, ok := p.ByMeaning(meaning)
		if !ok {
			t.Errorf("%s not in register map", meaning)
			continue
		}
		if r.Table != "input" {
			t.Errorf("%s: table = %q, want input (FC 4, no write path)", meaning, r.Table)
		}
		if r.Band != nil {
			t.Errorf("%s: an input register must not carry a band", meaning)
		}
	}

	if _, ok := p.RegisterAt("holding", 2); !ok {
		t.Error("RegisterAt(holding, 2) should find vermarkter_vorgabe_pct")
	}
	if _, ok := p.RegisterAt("holding", 4); !ok {
		t.Error("RegisterAt(holding, 4) should find lebenszeichen's second word (address 3-4)")
	}
	if _, ok := p.RegisterAt("holding", 5); ok {
		t.Error("RegisterAt(holding, 5) should find nothing - no meaning there")
	}
}
