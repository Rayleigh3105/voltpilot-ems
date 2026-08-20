package agent

import (
	"context"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// The portal's „Jetzt voll laden" is a SECOND TRIGGER on the very same core the
// :8484 button uses - so what it may and may not do is proven once, and this
// file only proves that the downlink reaches it and that every refusal holds.

func boostAgent(t *testing.T) (*Agent, *ocppsim.Station) {
	t.Helper()
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()
	st := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	return a, st
}

func boostPayload(cancel bool, at time.Time) string {
	c := "false"
	if cancel {
		c = "true"
	}
	return `{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	  "charge_point_id":"SAEULE-1","connector_id":1,"cancel":` + c + `,
	  "requested_at":"` + at.UTC().Format(time.RFC3339) + `"}`
}

// TestThePortalOverrideReachesTheSameCoreAsTheLocalButton.
func TestThePortalOverrideReachesTheSameCoreAsTheLocalButton(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 0, 0, st) // no sun at all
	a.ocppStep(context.Background())
	nearKw(t, "paused without sun", st.DrawKw(1), 0)

	a.onChargingBoost([]byte(boostPayload(false, time.Now())))
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())
	nearKw(t, "the portal override reached the allocator", st.DrawKw(1), 229.3)

	a.onChargingBoost([]byte(boostPayload(true, time.Now())))
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())
	nearKw(t, "and its withdrawal too", st.DrawKw(1), 0)
}

// TestEveryRefusedOverrideChangesNothing: a foreign identity, an expired
// delivery and a malformed message must all leave the customer's priority
// exactly where it was - and none of them may answer the broker.
func TestEveryRefusedOverrideChangesNothing(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())

	for name, payload := range map[string]string{
		"fremdes Gerät": `{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"FREMD",
		  "charge_point_id":"SAEULE-1","connector_id":1,"requested_at":"` +
			time.Now().UTC().Format(time.RFC3339) + `"}`,
		// ⚠ The replay case: the broker redelivered a QoS1 message to a box
		// that was away. NON-retained alone would not stop this.
		"nachgeliefert": boostPayload(false, time.Now().Add(-chargingBoostTestWindow)),
		"kaputt":        `{`,
		"leer":          ``,
	} {
		a.onChargingBoost([]byte(payload))
		measureSurplus(t, a, 20, 0, 0, st)
		a.ocppStep(context.Background())
		if kw := st.DrawKw(1); kw > 0.05 {
			t.Fatalf("%s: the vehicle charges %v kW - the refusal did not hold", name, kw)
		}
	}
}

// chargingBoostTestWindow is a delay comfortably past the contract window.
const chargingBoostTestWindow = 10 * time.Minute

// TestAnOverrideForAnEmptyPlugIsRefused - a promise about a vehicle that is not
// there would be invented, and the downlink must not smuggle one in.
func TestAnOverrideForAnEmptyPlugIsRefused(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()
	ocppStation(t, a, "SAEULE-1", 1, 240)
	a.onChargingBoost([]byte(boostPayload(false, time.Now())))
	// Nothing to assert but the absence of a panic and of an override: the
	// surface has no session to show it on.
	if keys := a.ocpp.boostKeys(time.Now().UTC()); len(keys) != 0 {
		t.Fatalf("an empty plug must not carry an override: %v", keys)
	}
}
