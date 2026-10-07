package agent

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// „Sonne + Speicher" at the Edge-Light pilot: go-e per OCPP, the Deye
// SUN-12K-SG04LP3 only READ over Solarman (edge-light/docs/paritaet.md, C:
// Deye-Steuerung offen). The model carries no model/device approval, and the
// Go Layer 1 never publishes edge/control/readback, so State.Control stays
// empty. Since the observed battery (ocpp_release_observed_test.go, Kapitän
// 07.10.2026) the pilot is no longer „Nur Sonne": the box releases the
// battery it watches. The rules around it - commanded with/without readback,
// the floor, the effect latch, Not-Aus - live in ocpp_release_observed_test.go;
// this is the pilot's own case. Same site, same plan, same measurements; the
// readiness comes from the REAL applySetpoint. Only the simulator stands
// behind these numbers; the real evidence is the pilot of 04.10.2026.
func TestEdgeLightPilotReleasesItsObservedDeye(t *testing.T) {
	a, _ := releaseCoverAgent(t)
	uncommandedDeye(t, a)
	releaseHome(t, a, lastmgmt.StorageBeforeCars)
	s1 := releaseStation(t, a, "GOE-1")
	for i := 0; i < 4; i++ {
		// held=false: Edge Light's Layer 1 sends no readback at all.
		observedTick(t, a, s1, 80, false, selfConsumption)
	}
	nearKwSoon(t, "3 kW sun + 5 kW from the observed Deye", drawOf(s1, 1), 8)

	if snap := a.State.Get(); snap.Control != nil {
		t.Fatalf("precondition: no readback on Edge Light, got %+v", *snap.Control)
	}
	if ok, observed, _ := a.releaseReady.get(time.Now().UTC(), a.releaseReadyWindow()); ok || !observed {
		t.Fatalf("the battery tick reports OBSERVED, not commanded: ok %v observed %v", ok, observed)
	}
	v, _ := a.ocpp.release.Last()
	if v.Mode != lastmgmt.ReleaseObserved || !strings.Contains(v.Reason, "beobachtet") {
		t.Fatalf("mode %q (%s), want %q", v.Mode, v.Reason, lastmgmt.ReleaseObserved)
	}
	if hb := a.chargersSummary(); hb.StorageReleaseMode != string(lastmgmt.ReleaseObserved) {
		t.Fatalf("the heartbeat carries the stage: %q", hb.StorageReleaseMode)
	}
	// Steuerstand (docs/contracts/speicher-steuerstand.md): without a readback
	// there is no `control` block - and still the cloud learns that VoltPilot
	// only observes this Deye, so the optimizer plans its self-consumption.
	if sum := controlSummary(a.State.Get()); sum != nil {
		t.Fatalf("no readback, no control block: %+v", *sum)
	}
	if bc := a.batteryControlSummary(); bc == nil || bc.State != batteryControlObserved ||
		bc.ControlEnabled || bc.Certified {
		t.Fatalf("the heartbeat must report the observed Deye: %+v", bc)
	}
}
