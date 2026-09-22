package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// Exercise the real telemetry bridge as well as the wake-up. The signed
// battery sample must not collapse into the existing charge-only channel.
func TestBezugsrampeMessungUndWeckruf(t *testing.T) {
	a := anteilAgent(t, t.TempDir())
	now := time.Date(2027, 6, 14, 22, 0, 0, 0, time.UTC)
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 1, "40.0", "60.0", "fuehrt"), now), true, "", 1)
	srv, err := csms.New(csms.Options{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	set := lastmgmt.Settings{GridLimitKw: 550}.WithDefaults()
	a.ocpp = &ocppRuntime{srv: srv, settings: set, budget: lastmgmt.NewBudgetTracker(), wake: make(chan struct{}, 1)}
	batt := -100.0
	a.ocppObserve(now, map[string]float64{"power_kw": 373}, &batt)
	a.bezugSpeicherSoll(-100, true)
	an := lastmgmt.BezugAnteil{Fuehrt: true, AnteilKw: 77}
	a.ocpp.budget.BudgetAnteil(now, set, an)
	a.ocpp.budget.BudgetAnteil(now.Add(40*time.Second), set, an)
	a.bezugSpeicherSoll(0, true)
	select {
	case <-a.ocpp.wake:
	default:
		t.Fatal("battery rise did not wake park")
	}
	if got := a.ocpp.budget.BudgetAnteil(now.Add(50*time.Second), set, an).Kw; got != 7 {
		t.Fatalf("signed sample lost at ocppObserve: want 7, got %.3f", got)
	}
	a.bezugSpeicherSoll(-20, true)
	select {
	case <-a.ocpp.wake:
		t.Fatal("falling command woke park")
	default:
	}
}
