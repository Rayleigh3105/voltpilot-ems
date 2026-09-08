package agent

import (
	"context"
	"fmt"
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
	nearKwSoon(t, "paused without sun", drawOf(st, 1), 0)

	a.onChargingBoost([]byte(boostPayload(false, time.Now())))
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())
	nearKwSoon(t, "the portal override reached the allocator", drawOf(st, 1), 229.3)

	a.onChargingBoost([]byte(boostPayload(true, time.Now())))
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())
	nearKwSoon(t, "and its withdrawal too", drawOf(st, 1), 0)
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
	if full, paused := a.ocpp.boostKeys(time.Now().UTC()); len(full)+len(paused) != 0 {
		t.Fatalf("an empty plug must not carry an override: %v %v", full, paused)
	}
}

// pausePayload is the P3b sibling: same envelope, `action: "pause"`.
func pausePayload(at time.Time) string {
	return `{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	  "charge_point_id":"SAEULE-1","connector_id":1,"action":"pause",
	  "requested_at":"` + at.UTC().Format(time.RFC3339) + `"}`
}

// TestTheSecondDirectionPausesExactlyOneChargeAndGivesItBack (P3b, E5) -
// measured AT THE STATION, never on a receipt: „Laden pausieren" holds THIS
// charge at 0 kW while the physical lane is wide open, and „Automatik
// fortsetzen" (the SAME cancel) hands it straight back.
func TestTheSecondDirectionPausesExactlyOneChargeAndGivesItBack(t *testing.T) {
	a, st := boostAgent(t)
	// Plenty of sun, so nothing but the customer's own hand can hold it.
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	minKwSoon(t, "the charge must be running before it can be paused", drawOf(st, 1), 100)

	a.onChargingBoost([]byte(pausePayload(time.Now())))
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	nearKwSoon(t, "the paused charge draws nothing", drawOf(st, 1), 0)

	// ⚠ Und der Grund NENNT den Hebel: „wartet - kein Überschuss" schickte den
	// Kunden zu seiner Quellen-Wahl statt zu seinem eigenen Eingriff.
	plan := a.ocpp.previousPlan()
	alloc, ok := plan.Get("SAEULE-1#1")
	if !ok || alloc.Reason != lastmgmt.ReasonManual {
		t.Fatalf("the pause must name itself, got %+v (ok=%v)", alloc, ok)
	}
	if _, paused := a.ocpp.boostKeys(time.Now().UTC()); len(paused) != 1 {
		t.Fatalf("the surface must see the running pause, got %v", paused)
	}

	a.onChargingBoost([]byte(boostPayload(true, time.Now())))
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	minKwSoon(t, "„Automatik fortsetzen“ must give the charge back", drawOf(st, 1), 100)
}

// TestAPauseLeavesEveryOtherChargeUntouched - the whole promise of the dialog:
// „andere Ladepunkte laden weiter".
func TestAPauseLeavesEveryOtherChargeUntouched(t *testing.T) {
	a, st := boostAgent(t)
	st2 := ocppStation(t, a, "SAEULE-2", 1, 240)
	if err := st2.Plug(1, ocppsim.Vehicle{DemandKw: 100, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the second session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-2")
		return len(c.ActiveConnectors()) == 1
	})
	measureSurplus(t, a, 20, 260, 0, st, st2)
	a.ocppStep(context.Background())
	before := minKwSoon(t, "the neighbour must be charging first", drawOf(st2, 1), 50)

	a.onChargingBoost([]byte(pausePayload(time.Now())))
	measureSurplus(t, a, 20, 260, 0, st, st2)
	a.ocppStep(context.Background())
	nearKwSoon(t, "the addressed charge pauses", drawOf(st, 1), 0)
	minKwSoon(t, fmt.Sprintf("the neighbour must keep its %.3f kW", before), drawOf(st2, 1), before-0.5)
}

// TestAPauseEndsWhenTheVehicleLeaves - the session binding of BOTH directions:
// „endet spätestens beim Abstecken", and a NEW vehicle never inherits it.
func TestAPauseEndsWhenTheVehicleLeaves(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	a.onChargingBoost([]byte(pausePayload(time.Now())))
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	nearKwSoon(t, "paused", drawOf(st, 1), 0)

	if err := st.Unplug(1); err != nil {
		t.Fatalf("unplug: %v", err)
	}
	waitUntil(t, "the session ended", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 0
	})
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("re-plug: %v", err)
	}
	waitUntil(t, "the next session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	minKwSoon(t, "the NEXT vehicle must not inherit the pause", drawOf(st, 1), 100)
}

// TestAConfigWithoutAnActionIsStillTheOldBoost - the compatibility promise of
// the whole Paket, proven at the station: a cloud that does not send `action`
// grants exactly the override of before.
func TestAConfigWithoutAnActionIsStillTheOldBoost(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 0, 0, st) // no sun: only a boost can move it
	a.ocppStep(context.Background())
	nearKwSoon(t, "paused without sun", drawOf(st, 1), 0)

	a.onChargingBoost([]byte(boostPayload(false, time.Now())))
	measureSurplus(t, a, 20, 0, 0, st)
	a.ocppStep(context.Background())
	minKwSoon(t, "an action-less envelope must still boost", drawOf(st, 1), 100)
	full, paused := a.ocpp.boostKeys(time.Now().UTC())
	if len(full) != 1 || len(paused) != 0 {
		t.Fatalf("it must count as a FULL override, got full=%v paused=%v", full, paused)
	}
}
