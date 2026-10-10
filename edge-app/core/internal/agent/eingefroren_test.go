package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// AP-15 IP-20 on the agent: ONE probe, fed from the telemetry path and from
// the box's own published adjustments, answers both watchdogs. R9 frozen:
// Box Halle 1 (fuehrt) sees -98 kW at 13:10:00 and from then on the same
// number with fresh timestamps; the published setpoint stops a measured 10 kW
// discharge at 13:10:00.
func TestEinfrierprobeAmAgentR9(t *testing.T) {
	t0 := time.Date(2027, 6, 13, 13, 10, 0, 0, time.UTC)
	mitDok := func(t *testing.T) *Agent {
		a, err := New(halle1Cfg(t, "fuehrt"))
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	speise := func(a *Agent, bis int) {
		for s := 0; s <= bis; s += 5 {
			batt := -10.0
			if s > 0 {
				batt = 0
			}
			a.einfrierWert(t0.Add(time.Duration(s)*time.Second), map[string]float64{"power_kw": -98, "pv_power_kw": 83}, &batt)
		}
	}

	t.Run("eingefroren nach 60 s, seit dem letzten Wechsel", func(t *testing.T) {
		a := mitDok(t)
		speise(a, 0)
		a.einfrierSollwert(t0, true, nil, 83, 0, false) // first setpoint: the battery 10 -> 0
		speise(a, 60)
		if seit := a.eingefrorenSeit(t0.Add(59 * time.Second)); !seit.IsZero() {
			t.Fatalf("59 s: not yet, got %v", seit)
		}
		if seit := a.eingefrorenSeit(t0.Add(60 * time.Second)); !seit.Equal(t0) {
			t.Fatalf("60 s: frozen since 13:10:00, got %v", seit)
		}
		// both watchdogs read the same verdict
		an := a.bezugAnteil()
		an.EingefrorenSeit = a.eingefrorenSeit(t0.Add(60 * time.Second))
		v := lastmgmt.NewBudgetTracker().BudgetAnteil(t0.Add(60*time.Second), lastmgmt.Settings{GridLimitKw: 550}, *an)
		if !v.AnteilBinds {
			t.Fatalf("the Bezugswaechter hears the probe: %+v", v)
		}
	})

	t.Run("Regelung aus: nichts verstellt, nie eingefroren", func(t *testing.T) {
		a := mitDok(t)
		speise(a, 0)
		a.einfrierSollwert(t0, false, nil, 83, 0, false)
		speise(a, 300)
		if seit := a.eingefrorenSeit(t0.Add(300 * time.Second)); !seit.IsZero() {
			t.Fatalf("control off: nothing reached the meter, got frozen since %v", seit)
		}
	})

	t.Run("nativer Speicher: kein Wattwert der Box", func(t *testing.T) {
		a := mitDok(t)
		speise(a, 0)
		a.einfrierSollwert(t0, true, nil, 83, 0, true)
		speise(a, 300)
		if seit := a.eingefrorenSeit(t0.Add(300 * time.Second)); !seit.IsZero() {
			t.Fatalf("native: got frozen since %v", seit)
		}
	})

	t.Run("PV-Kappe ueber der Erzeugung, Anheben, Ladepunkt ueber dem Bezug: nichts wirksam", func(t *testing.T) {
		a := mitDok(t)
		speise(a, 0)
		k80, k70, k78 := 80.0, 70.0, 78.0
		a.einfrierSollwert(t0, true, &k80, 30, -10, false)                                                  // first: the battery stays
		a.einfrierSollwert(t0, true, &k70, 30, -10, false)                                                  // 80 -> 70 at 30 kW: nothing
		a.einfrierSollwert(t0, true, &k78, 83, -10, false)                                                  // raise: nothing
		a.einfrierLadepunkte(t0, &lastmgmt.Plan{AllocatedKw: 22}, &lastmgmt.Plan{AllocatedKw: 11}, 5, true) // above the draw
		speise(a, 300)
		if seit := a.eingefrorenSeit(t0.Add(300 * time.Second)); !seit.IsZero() {
			t.Fatalf("no effective adjustment: got frozen since %v", seit)
		}
	})

	t.Run("ohne Dokument: nichts gefuettert, nie eingefroren", func(t *testing.T) {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		a, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		speise(a, 0)
		a.einfrierSollwert(t0, true, nil, 83, 0, false)
		speise(a, 300)
		if seit := a.eingefrorenSeit(t0.Add(300 * time.Second)); !seit.IsZero() {
			t.Fatalf("without a document the probe is never fed, got %v", seit)
		}
	})
}
