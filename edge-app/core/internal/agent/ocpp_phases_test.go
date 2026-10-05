package agent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// This file proves the Phasenumschaltung AT THE STATION: which phase count
// the box really put on the wire, and what the vehicle then really draws.

const rigPhaseWait = 300 * time.Millisecond

// goeRig is the Edge-Light pilot in small: a 24 kW house connection, one
// amps-only go-e on three phases at 16 A, „Nur Sonnenstrom", cars before the
// battery, and switching allowed - with the pacing shortened for the rig.
func goeRig(t *testing.T, switching, stationCanSwitch bool) (*Agent, *ocppsim.Station) {
	t.Helper()
	a := ocppAgent(t, nil)
	// The pilot entered the three-phase minimum as Mindestleistung je Auto.
	set := lastmgmt.Settings{GridLimitKw: 24, MarginPct: 10, RotationPeriod: 15 * time.Minute, MinPowerKw: 4.2,
		SurplusPolicy: lastmgmt.PolicySolarOnly, StoragePriority: lastmgmt.CarsBeforeStorage}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.phaseDwell, a.ocpp.phasePause = rigPhaseWait, rigPhaseWait
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatal(err)
	}
	// Like the pilot: a 4.2 kW minimum left behind at the charge point by an
	// earlier „Sonne + Mindestleistung", now under „Nur Sonnenstrom".
	if _, err := a.ocpp.srv.Add(csms.AddRequest{ID: "GOE", Connectors: 1, RatedKw: 11, MinKw: 4.2}); err != nil {
		t.Fatal(err)
	}
	st := ocppsim.New(ocppsim.Config{ID: "GOE", Connectors: 1, AmpsOnly: true, AmpsVoltageV: 230,
		PhaseSwitch: stationCanSwitch})
	t.Cleanup(st.Stop)
	for deadline := time.Now().Add(5 * time.Second); ; {
		err := st.Connect(ocppEndpoint(a))
		if err == nil {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitUntil(t, "the CSMS saw the go-e", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("GOE")
		return ok && c.Connected && len(c.Connectors) == 1
	})
	if err := a.ocpp.srv.SetControlPolicy(ocppcontrol.Policy{Revision: 1,
		Authorization: ocppcontrol.Authorization{Mode: "free"}, PhaseLimitsA: []float64{16, 16, 16},
		Electrical: []ocppcontrol.Electrical{{ChargePointID: "GOE", ConnectorID: 1, VoltageV: 230,
			Phases: []int{1, 2, 3}, MaxCurrentA: 16, PhaseSwitching: switching}}}); err != nil {
		t.Fatal(err)
	}
	// The policy change nudges the background loop, which commissions too; a
	// start during a commissioning is refused (phase limits gate the start).
	// So the rig plugs only once the setup has settled.
	a.ocppStep(context.Background())
	var settled time.Time
	waitUntil(t, "the go-e is commissioned and settled", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("GOE")
		if c.CommissionedAt.IsZero() || !c.CommissionedAt.Equal(settled) {
			settled = c.CommissionedAt
			time.Sleep(300 * time.Millisecond)
			return false
		}
		return true
	})
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 1.3}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("GOE")
		if len(c.ActiveConnectors()) == 1 {
			break
		}
		if !time.Now().Before(deadline) {
			raw, _ := json.Marshal(c)
			t.Fatalf("the session never started: %s", raw)
		}
	}
	return a, st
}

// sunStep measures one moment of sun and lets the box decide.
func sunStep(t *testing.T, a *Agent, st *ocppsim.Station, houseKw, pvKw float64) {
	t.Helper()
	measureSurplus(t, a, houseKw, pvKw, 0, st)
	a.ocppStep(context.Background())
}

// goeView is the go-e's plug as the surface renders it.
func goeView(t *testing.T, a *Agent) state.OcppConnector {
	t.Helper()
	for _, c := range a.State.Get().Ocpp.Chargers {
		for _, con := range c.Connectors {
			if c.ID == "GOE" && con.ID == 1 {
				return con
			}
		}
	}
	t.Fatal("the go-e is not in the view")
	return state.OcppConnector{}
}

func txPhases(st *ocppsim.Station) int {
	for _, p := range st.Profiles() {
		if p.Purpose == ocppsim.PurposeTx {
			return p.Phases
		}
	}
	return 0
}

// TestASmallSurplusSwitchesTheGoeToOnePhase is the pilot's question: 2.5 kW of
// sun is below the three-phase minimum, so the car charges on one phase - after
// the switch had its dwell, and never on three phases from the grid meanwhile.
//
// ⚠ The rig only ever LOWERS the sun: the surplus is the minimum of the last
// minute (budget.go), so a rising sun reaches the allocator a minute later,
// and the held one-phase ceiling is proven in lastmgmt instead.
func TestASmallSurplusSwitchesTheGoeToOnePhase(t *testing.T) {
	a, st := goeRig(t, true, true)

	// 7 kW of sun: three phases, no switch needed.
	sunStep(t, a, st, 0.5, 7.5)
	nearKwSoon(t, "three phases (10.1 A × 3 × 230 V)", drawOf(st, 1), 6.969)
	if got := txPhases(st); got != 3 {
		t.Fatalf("numberPhases on the wire = %d, want 3", got)
	}

	// A cloud, 2.5 kW left: one phase is wanted, the dwell holds three - and
	// three phases cannot charge 2.5 kW, so the car waits.
	sunStep(t, a, st, 0.5, 3)
	nearKwSoon(t, "held on three phases, nothing from the grid", drawOf(st, 1), 0)
	if con := goeView(t, a); con.Phases != 3 || con.PhaseNote != ocppPhaseHoldText {
		t.Fatalf("the hold must be visible: %+v", con)
	}

	time.Sleep(rigPhaseWait + 50*time.Millisecond)
	sunStep(t, a, st, 0.5, 3)
	nearKwSoon(t, "one phase follows the sun (10.8 A × 230 V)", drawOf(st, 1), 2.484)
	if got := txPhases(st); got != 1 {
		t.Fatalf("numberPhases on the wire = %d, want 1", got)
	}
	if con := goeView(t, a); con.Phases != 1 || con.PhaseNote != "" {
		t.Fatalf("%+v", con)
	}

	// Below 6 A on one phase: a pause, and a pause never switches.
	sunStep(t, a, st, 0.5, 1.5)
	nearKwSoon(t, "paused", drawOf(st, 1), 0)
	time.Sleep(rigPhaseWait + 50*time.Millisecond)
	sunStep(t, a, st, 0.5, 1.5)
	if got := txPhases(st); got != 1 {
		t.Fatalf("a pause switched the phases: %d", got)
	}
}

// TestWithoutTheStationsWordTheGoeStaysOnThreePhases - the operator's switch
// alone is not enough: a station that does not report it can switch keeps
// charging exactly as before.
func TestWithoutTheStationsWordTheGoeStaysOnThreePhases(t *testing.T) {
	a, st := goeRig(t, true, false)
	sunStep(t, a, st, 0.5, 5)
	nearKwSoon(t, "three phases as always (6.5 A)", drawOf(st, 1), 4.485)
	for i := 0; i < 2; i++ {
		sunStep(t, a, st, 0.5, 3)
		time.Sleep(rigPhaseWait + 50*time.Millisecond)
	}
	nearKwSoon(t, "below the three-phase minimum it waits", drawOf(st, 1), 0)
	if got := txPhases(st); got != 3 {
		t.Fatalf("numberPhases = %d", got)
	}
}

// TestTheWaitingSentenceNamesTheStationsOwnSource - the site default here is
// „Schnell laden", the go-e's own lane „Nur Sonnenstrom"; the sentence must
// name the lane that actually holds the car.
func TestTheWaitingSentenceNamesTheStationsOwnSource(t *testing.T) {
	a, st := goeRig(t, false, true)
	own := "nur_sonne"
	if _, err := a.ocpp.srv.Update("GOE", csms.UpdateRequest{Source: &own}); err != nil {
		t.Fatal(err)
	}
	p := string(lastmgmt.PolicyFast)
	if _, err := a.OcppSaveSettings(lastmgmt.SettingsRequest{SurplusPolicy: &p}); err != nil {
		t.Fatal(err)
	}
	sunStep(t, a, st, 0.5, 0)
	nearKwSoon(t, "no sun, no charge", drawOf(st, 1), 0)
	if got := goeView(t, a).ReasonText; got != "wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)" {
		t.Fatalf("sentence = %q", got)
	}
}

// TestWithoutTheOperatorsSwitchNothingChanges - the compatibility promise.
func TestWithoutTheOperatorsSwitchNothingChanges(t *testing.T) {
	a, st := goeRig(t, false, true)
	for i := 0; i < 2; i++ {
		sunStep(t, a, st, 0.5, 3)
		time.Sleep(rigPhaseWait + 50*time.Millisecond)
	}
	nearKwSoon(t, "below the three-phase minimum it waits", drawOf(st, 1), 0)
	if con := goeView(t, a); con.Phases != 0 || con.PhaseNote != "" {
		t.Fatalf("a plug that may not switch shows no phase: %+v", con)
	}
}
