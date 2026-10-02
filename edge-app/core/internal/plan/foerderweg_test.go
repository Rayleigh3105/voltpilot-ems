package plan

import (
	"testing"
	"time"
)

// MiSpeL MP-14: the Förderweg decides whether grid_charge_allowed may release
// the EEG clamp (contract mispel-foerderweg.md § 1, column "Netzladen").
// One row per Förderweg and per value of grid_charge_allowed, plus the
// fail-safe rows: an absent field, an unknown value and no plan clamp.
func TestFoerderwegDecidesSolarOnlyCharge(t *testing.T) {
	slot := `{ "start": "2026-10-02T09:00:00Z", "battery_setpoint_kw": 5.0 }`
	parse := func(extra string) *Plan {
		t.Helper()
		p, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15`+extra+`,"slots":[`+slot+`]}`), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct {
		foerderweg string // "" = field absent
		grid       string // "" = field absent
		solarOnly  bool
	}{
		{FoerderwegEinspeiseverguetung, "true", true},
		{FoerderwegEinspeiseverguetung, "false", true},
		{FoerderwegAusschliesslichkeit, "true", true},
		{FoerderwegAusschliesslichkeit, "false", true},
		{FoerderwegAbgrenzung, "true", false},
		{FoerderwegAbgrenzung, "false", true},
		{FoerderwegAbgrenzung, "", true},
		{FoerderwegPauschal, "true", false},
		{FoerderwegPauschal, "false", true},
		{FoerderwegUngefoerdert, "true", false},
		{FoerderwegUngefoerdert, "false", true},
		{"", "true", true},  // old cloud: no Förderweg, grid charge never released
		{"", "false", true}, // old cloud, EEG site
		{"", "", true},
		{"marktpraemie_neu", "true", true}, // a value the box does not know
	}
	for _, c := range cases {
		extra := ""
		if c.grid != "" {
			extra += `,"grid_charge_allowed":` + c.grid
		}
		if c.foerderweg != "" {
			extra += `,"foerderweg":"` + c.foerderweg + `"`
		}
		p := parse(extra)
		if p.Foerderweg != c.foerderweg {
			t.Fatalf("%q: parsed Förderweg %q", c.foerderweg, p.Foerderweg)
		}
		if got := p.SolarOnlyCharge(); got != c.solarOnly {
			t.Errorf("foerderweg=%q grid_charge_allowed=%q: SolarOnlyCharge=%v, want %v", c.foerderweg, c.grid, got, c.solarOnly)
		}
		v := p.FoerderwegView()
		if v.SolarOnly != c.solarOnly || v.Foerderweg != c.foerderweg || v.Bekannt != FoerderwegBekannt(c.foerderweg) {
			t.Errorf("view for %q/%q: %+v", c.foerderweg, c.grid, v)
		}
	}
	var none *Plan
	if !none.SolarOnlyCharge() || !none.FoerderwegView().SolarOnly {
		t.Fatal("no plan must clamp (lädt sicherheitshalber nur mit Sonnenstrom)")
	}
	if FoerderwegBekannt("") || FoerderwegBekannt("marktpraemie_neu") || !FoerderwegBekannt(FoerderwegPauschal) {
		t.Fatal("only the contract's five values are known")
	}
}

// The Förderweg survives the disk round-trip (restart without network) and
// reaches the local view with the plan fields behind the decision.
func TestFoerderwegPersistedAndInView(t *testing.T) {
	slot := `{ "start": "2026-10-02T09:00:00Z", "battery_setpoint_kw": 5.0 }`
	p, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"generated_at":"2026-10-02T09:00:00Z",`+
		`"grid_charge_allowed":false,"foerderweg":"marktpraemie_ausschliesslichkeit",`+
		`"strict_exclusivity":true,"strict_exclusivity_tolerance_kwh":0.25,"grid_export_limit_kw":30,"slots":[`+slot+`]}`),
		time.Date(2026, 10, 2, 9, 1, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	back, err := s.Load()
	if err != nil || back == nil {
		t.Fatalf("load after restart: %v %v", back, err)
	}
	if back.Foerderweg != FoerderwegAusschliesslichkeit || !back.SolarOnlyCharge() {
		t.Fatalf("persisted plan lost the Förderweg: %+v", back)
	}
	v := back.BuildView(time.Date(2026, 10, 2, 9, 5, 0, 0, time.UTC)).Foerderweg
	if v.Foerderweg != FoerderwegAusschliesslichkeit || !v.Bekannt || !v.SolarOnly || !v.StrictExclusivity ||
		v.StrictToleranceKwh == nil || *v.StrictToleranceKwh != 0.25 ||
		v.GridChargeAllowed == nil || *v.GridChargeAllowed || v.GridExportLimitKw == nil || *v.GridExportLimitKw != 30 {
		t.Fatalf("view: %+v", v)
	}
}
