package agent

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
)

func ocppConnectorOf(a *Agent, id string, connector int) (state.OcppConnector, bool) {
	for _, c := range a.ocppInfo().Chargers {
		if c.ID != id {
			continue
		}
		for _, con := range c.Connectors {
			if con.ID == connector {
				return con, true
			}
		}
	}
	return state.OcppConnector{}, false
}

// TestAPluggedCarWithoutTransactionIsNamedAndTheBoostRefusalSaysTheWayOut is
// the box half of „Auto steckt, kein Ladevorgang“: the station reports a car
// (SuspendedEVSE) but the box holds no transaction - the state seen at a pilot
// site after a start was refused during the set-up. The heartbeat names it
// (`kein_ladevorgang` with its sentence) instead of a bare SuspendedEVSE that
// reads as „wartet“, and the refused boost says to plug in again. Once a real
// charge runs, the word is gone.
func TestAPluggedCarWithoutTransactionIsNamedAndTheBoostRefusalSaysTheWayOut(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	st := ocppStation(t, a, "SAEULE-1", 1, 11)

	if err := st.ReportStatus(1, core.ChargePointStatusSuspendedEVSE, core.NoError); err != nil {
		t.Fatalf("status: %v", err)
	}
	waitUntil(t, "der Stecker meldet kein_ladevorgang", func() bool {
		con, ok := ocppConnectorOf(a, "SAEULE-1", 1)
		return ok && con.Reason == lastmgmt.ReasonNoSession
	})
	con, _ := ocppConnectorOf(a, "SAEULE-1", 1)
	if con.Charging || con.SessionSince != 0 || con.AllocatedKw != nil {
		t.Fatalf("ohne Transaktion: %+v", con)
	}
	if con.ReasonText != lastmgmt.NoSessionText {
		t.Fatalf("Satz %q, want %q", con.ReasonText, lastmgmt.NoSessionText)
	}

	_, err := a.OcppBoost(lastmgmt.BoostRequest{ChargePointID: "SAEULE-1", Connector: 1, Minutes: 5})
	if err == nil || !strings.Contains(err.Error(), "Stecker kurz ziehen und wieder einstecken") {
		t.Fatalf("Ablehnung ohne Ausweg: %v", err)
	}

	// Neu einstecken: ein echter Ladevorgang beginnt, das Wort verschwindet.
	if err := st.Unplug(1); err != nil {
		t.Fatalf("unplug: %v", err)
	}
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "ein Ladevorgang läuft", func() bool {
		con, ok := ocppConnectorOf(a, "SAEULE-1", 1)
		return ok && con.Charging && con.SessionSince != 0
	})
	if con, _ := ocppConnectorOf(a, "SAEULE-1", 1); con.Reason == lastmgmt.ReasonNoSession {
		t.Fatalf("laufender Ladevorgang trägt noch kein_ladevorgang: %+v", con)
	}
}

// A free plug (Available) is not „kein Ladevorgang“ - no car, nothing to do.
func TestAFreePlugIsNotNamedNoSession(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	st := ocppStation(t, a, "SAEULE-1", 1, 11)
	if err := st.ReportStatus(1, core.ChargePointStatusAvailable, core.NoError); err != nil {
		t.Fatalf("status: %v", err)
	}
	waitUntil(t, "der Stecker meldet Available", func() bool {
		con, ok := ocppConnectorOf(a, "SAEULE-1", 1)
		return ok && con.Status == "Available"
	})
	if con, _ := ocppConnectorOf(a, "SAEULE-1", 1); con.Reason != "" {
		t.Fatalf("freier Stecker mit Grund: %+v", con)
	}
}
