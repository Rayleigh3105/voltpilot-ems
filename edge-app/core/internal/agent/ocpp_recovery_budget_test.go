package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// A recovered transaction is not a live allocator claimant until a matching
// fresh report arrives. Its station can nevertheless keep drawing the default.
// Exercise the budget and allocator together so that share cannot be spent twice.
func TestReconcilingSessionsKeepFallbackBudgetReserved(t *testing.T) {
	for _, connected := range []bool{false, true} {
		name := "disconnected"
		if connected {
			name = "connected awaiting reconciliation"
		}
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
			set := lastmgmt.Settings{GridLimitKw: 30, HouseReserveKw: 5,
				MaxHouseLoadKw: 5, MarginPct: 10, MinPowerKw: 1}.WithDefaults()
			snap := csms.Snapshot{Chargers: []csms.ChargerState{
				{Charger: csms.Charger{ID: "recovering", Connectors: 1, RatedKw: 22},
					Connected: connected, Connectors: []csms.Connector{{ID: 1,
						Status: csms.StatusCharging, Session: &csms.Session{TransactionID: 1, Reconciling: true}}}},
				{Charger: csms.Charger{ID: "ready", Connectors: 1, RatedKw: 22},
					Connected: true, Connectors: []csms.Connector{{ID: 1,
						Status: csms.StatusCharging, Session: &csms.Session{TransactionID: 2}}}},
			}}
			safe := lastmgmt.DeriveSafeDefault(set.GridLimitKw, set.MaxHouseLoadKw, snap.ConnectorCount())
			a := &Agent{ocpp: &ocppRuntime{budget: lastmgmt.NewBudgetTracker()}}
			verdict, reserved := a.ocppBudget(now, set, snap, safe)
			nearKw(t, "recovered session fallback reserved once", reserved, 12.5)
			allocatable := ocppAllocatable(verdict, reserved)
			sessions, _ := ocppSessions(snap, allocatable, set)
			if len(sessions) != 1 || sessions[0].Key != "ready#1" {
				t.Fatalf("only the reconciled session may receive an allocation: %+v", sessions)
			}
			plan := lastmgmt.Decide(lastmgmt.Input{Settings: set, Sessions: sessions, BudgetKw: &allocatable, Now: now})
			allocated := 0.0
			for _, allocation := range plan.Allocations {
				allocated += allocation.Kw
			}
			nearKw(t, "remaining session allocation", allocated, 9.5)
			if allocated+safe.PerConnectorKw+set.HouseReserveKw > set.GridLimitKw*(1-set.MarginPct/100)+0.001 {
				t.Fatal("live allocation and recovered fallback exceed the connection budget")
			}

			// The net meter already contains the recovery draw. ChargingTotal
			// must not add it back, and the measured budget must not deduct it twice.
			snap.Chargers[1].Connectors[0].PowerKw = &allocated
			snap.Chargers[1].Connectors[0].MeteredAt = now
			charging, complete := snap.ChargingTotal(now, ocppMeterMaxAge)
			nearKw(t, "only allocated charging is added back", charging, allocated)
			if !complete {
				t.Fatal("recovery is accounted for in the measured rest load")
			}
			a.ocpp.budget.Observe(now, set.HouseReserveKw+safe.PerConnectorKw+allocated, charging, complete)
			verdict, reserved = a.ocppBudget(now, set, snap, safe)
			if !verdict.Measured() {
				t.Fatalf("expected measured budget: %+v", verdict)
			}
			nearKw(t, "no double subtraction while measuring", reserved, 0)
			nearKw(t, "same safe remaining allocation", ocppAllocatable(verdict, reserved), 9.5)

			// Once the transaction is reconciled it can receive a live share.
			snap.Chargers[0].Connected = true
			snap.Chargers[0].Connectors[0].Session.Reconciling = false
			a.ocpp.budget = lastmgmt.NewBudgetTracker()
			verdict, reserved = a.ocppBudget(now, set, snap, safe)
			nearKw(t, "reconciled session releases fallback reservation", reserved, 0)
			sessions, _ = ocppSessions(snap, verdict.Kw, set)
			if len(sessions) != 2 {
				t.Fatalf("both reconciled sessions must participate: %+v", sessions)
			}
		})
	}
}
