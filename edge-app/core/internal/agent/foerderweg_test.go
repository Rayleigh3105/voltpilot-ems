package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// MiSpeL MP-14 on the published setpoint, one case per Förderweg: the plan
// commands +20 kW charge with grid_charge_allowed=true while the plant
// measures pv 5 / load 4. Only a route that leaves grid charging to the
// customer (Abgrenzungs-, Pauschaloption, ungefördert) releases the EEG clamp;
// Einspeisevergütung, Ausschließlichkeitsoption, an absent and an unknown
// Förderweg keep the clamp and the adapter's grid-charge bit off - the box
// "lädt sicherheitshalber nur mit Sonnenstrom". Since EN-1 A (main,
// 02.11.2026) the clamp includes the Netzladen-Sperre: pv 5 - load 4 - the
// 1 kW reserve leaves no charge at all.
func TestSetpointFoerderwegDecidesGridCharge(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.GridChargeAllowed = true // device-local gate open: the PLAN must win
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	yes, no := true, false
	cases := []struct {
		name       string
		foerderweg string
		grid       *bool
		want       float64
		gridBit    bool
	}{
		{"Einspeisevergütung", plan.FoerderwegEinspeiseverguetung, &yes, 0, false},
		{"Ausschließlichkeitsoption", plan.FoerderwegAusschliesslichkeit, &yes, 0, false},
		{"Abgrenzungsoption, Netzladen eingestellt", plan.FoerderwegAbgrenzung, &yes, 20, true},
		{"Abgrenzungsoption, Netzladen aus", plan.FoerderwegAbgrenzung, &no, 0, false},
		{"Abgrenzungsoption, Feld grid_charge_allowed fehlt", plan.FoerderwegAbgrenzung, nil, 0, false},
		{"Pauschaloption, Netzladen eingestellt", plan.FoerderwegPauschal, &yes, 20, true},
		{"ungefördert, Netzladen eingestellt", plan.FoerderwegUngefoerdert, &yes, 20, true},
		{"Feld foerderweg fehlt (alte Cloud)", "", &yes, 0, false},
		{"unbekannter Förderweg", "marktpraemie_neu", &yes, 0, false},
	}
	for _, c := range cases {
		// Separator: a discharge slot first, so a case can never pass on the
		// previous case's message.
		now := time.Now().UTC()
		a.mu.Lock()
		a.currentPlan = freshPlan(now, -3, nil)
		a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
		a.mu.Unlock()
		a.applySetpoint(now)
		waitFor(t, 5*time.Second, "separator before "+c.name, func() bool {
			m, ok := sub.latest()
			v, _ := m["battery_setpoint_kw"].(float64)
			return ok && v < 0
		})
		p := freshPlan(now, 20, nil)
		p.Foerderweg = c.foerderweg
		p.GridChargeAllowed = c.grid
		a.mu.Lock()
		a.currentPlan = p
		a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
		a.mu.Unlock()
		a.applySetpoint(now)
		waitFor(t, 5*time.Second, c.name, func() bool {
			m, ok := sub.latest()
			return ok && m["battery_setpoint_kw"] == c.want && m["grid_charge_allowed"] == c.gridBit
		})
		if got := a.State.Get().SetpointKw; got != c.want {
			t.Fatalf("%s: snapshot setpoint %v, want %v", c.name, got, c.want)
		}
	}
}
