package plan_test

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// MiSpeL MP-22 (Pilot-Durchstich im Simulator, E6 = D): the box side of one
// month of the simulator plant. testdata/mispel-durchstich-2026-10.jsonl holds
// one line per Berlin day of October 2026 - the REAL schedule payload the
// optimizer published in Mischbetrieb (publisher.build_schedule_payload) plus
// the plant's PV and load for the payload's slots - written by
// services/optimization: python -m voltpilot_optimization.simulation.mispel_durchstich --schreiben.
//
// Proven here: every plan carries foerderweg=marktpraemie_abgrenzung with
// grid_charge_allowed=true, the box therefore releases the EEG clamp (MP-14)
// and executes every planned setpoint unchanged through the guard chain - so
// the meter values the simulation hands to the Rechenwerk are the ones the box
// would produce. The same plans under the Ausschließlichkeitsoption would have
// the grid charging clamped away (Festlegung MiSpeL, Anlage 1 S. 11; FK3).
func TestMispelDurchstichBoxKlemmtNachFoerderweg(t *testing.T) {
	f, err := os.Open("testdata/mispel-durchstich-2026-10.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	type tag struct {
		Nutzlast json.RawMessage `json:"nutzlast"`
		PvKw     []float64       `json:"pv_kw"`
		LastKw   []float64       `json:"last_kw"`
	}
	const maxKw = 30.0 // Speicher der Simulator-Anlage: 65 kWh / 30 kW
	var tage, slots int
	var geplantKwh, geklemmtAbgrenzungKwh, geklemmtAusschliesslichkeitKwh float64
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var d tag
		if err := json.Unmarshal(scanner.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		p, err := plan.Parse(d.Nutzlast, time.Time{})
		if err != nil {
			t.Fatalf("Tag %d: %v", tage+1, err)
		}
		if p.Foerderweg != plan.FoerderwegAbgrenzung || p.GridChargeAllowed == nil || !*p.GridChargeAllowed {
			t.Fatalf("Tag %d: Förderweg %q, grid_charge_allowed %v", tage+1, p.Foerderweg, p.GridChargeAllowed)
		}
		if p.SolarOnlyCharge() || p.StrictExclusivityCharge() {
			t.Fatalf("Tag %d: die Box klemmt trotz Abgrenzungsoption", tage+1)
		}
		if len(p.Slots) != len(d.PvKw) || len(p.Slots) != len(d.LastKw) {
			t.Fatalf("Tag %d: %d Slots, %d PV-, %d Lastwerte", tage+1, len(p.Slots), len(d.PvKw), len(d.LastKw))
		}
		ausschl := *p
		ausschl.Foerderweg = plan.FoerderwegAusschliesslichkeit
		for i, s := range p.Slots {
			r := guards.Reading{SocPct: guards.Unknown(), PvKw: d.PvKw[i], LoadKw: d.LastKw[i], GridLimitKw: guards.Unknown()}
			limits := guards.Limits{MaxChargeKw: maxKw, MaxDischargeKw: maxKw, SocMinPct: 0, SocMaxPct: 100,
				SolarOnlyCharge: p.SolarOnlyCharge(), StrictExclusivity: p.StrictExclusivityCharge()}
			kw := guards.Clamp(s.BatterySetpointKw, limits, r)
			if math.Abs(kw-s.BatterySetpointKw) > 1e-9 {
				t.Errorf("%s: geplant %.3f kW, die Box fährt %.3f kW", s.Start, s.BatterySetpointKw, kw)
			}
			if s.BatterySetpointKw > 0 {
				geplantKwh += s.BatterySetpointKw * 0.25
			}
			geklemmtAbgrenzungKwh += (s.BatterySetpointKw - kw) * 0.25
			limits.SolarOnlyCharge = ausschl.SolarOnlyCharge()
			geklemmtAusschliesslichkeitKwh += (s.BatterySetpointKw - guards.Clamp(s.BatterySetpointKw, limits, r)) * 0.25
			slots++
		}
		tage++
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if tage != 31 {
		t.Fatalf("Oktober 2026 hat 31 Tage, die Fixture %d", tage)
	}
	if geklemmtAbgrenzungKwh != 0 {
		t.Fatalf("Abgrenzungsoption: %.3f kWh geklemmt", geklemmtAbgrenzungKwh)
	}
	// Der Mischbetrieb lädt aus dem Netz - unter der Ausschließlichkeitsoption
	// nähme die Box genau diesen Teil weg (Laden <= gemessene PV).
	if geklemmtAusschliesslichkeitKwh <= 0 {
		t.Fatalf("dieselben Pläne unter Ausschließlichkeit: nichts geklemmt (%.3f kWh)", geklemmtAusschliesslichkeitKwh)
	}
	t.Logf("%d Tage, %d Viertelstunden: Laden geplant %.3f kWh; geklemmt bei Abgrenzung %.3f kWh, "+
		"bei Ausschließlichkeit %.3f kWh", tage, slots, geplantKwh, geklemmtAbgrenzungKwh, geklemmtAusschliesslichkeitKwh)
}
