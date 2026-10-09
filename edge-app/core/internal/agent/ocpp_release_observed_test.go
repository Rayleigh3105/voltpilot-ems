package agent

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// „Sonne + Speicher" with a battery VoltPilot does NOT command (Kapitän
// 07.10.2026): the box commands only the wallbox, watches SoC and battery
// power, and takes the release back at the floor or when the site imports.
// Same site, same plan, same measurements as the Edge-Light pilot
// (ocpp_release_light_test.go); the readiness comes from the REAL
// applySetpoint, never from a hand-set note. Only the simulator
// stands behind these numbers (ocppsim) - no bench, no real inverter.

// observedTick is one pass of both executors: the battery tick reports its
// readiness, then the charge-point pass decides. SoC socPct against a 30-%
// floor, PV 4 kW, house 1 kW; battKw is what the inverter is measured doing.
func observedTick(t *testing.T, a *Agent, s1 *ocppsim.Station, socPct float64, held bool,
	battKw func(carKw float64) float64) {
	t.Helper()
	floor := 30.0
	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = releasePlan(now, &floor)
	a.lastReading = guards.Reading{SocPct: socPct, PvKw: 4, LoadKw: 1, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	if held {
		a.State.Update(func(s *state.Snapshot) {
			s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
		})
	}
	a.applySetpoint(now)
	measureSurplus(t, a, 1, 4, battKw(drawOf(s1, 1)()), s1)
	a.ocppStep(context.Background())
}

// selfConsumption is an inverter in its own self-consumption regulation: it
// covers whatever the car takes beyond the 3 kW of sun.
func selfConsumption(carKw float64) float64 {
	if carKw > 3.5 {
		return -(carKw - 3)
	}
	return 0
}

// notCovering is an inverter that does NOT follow the house (a forced mode,
// a hold, a ToU program): the car's draw beyond the sun comes from the grid.
func notCovering(float64) float64 { return 0 }

// uncommandedDeye selects the Edge-Light pilot's model, which carries no
// model/device approval - VoltPilot reads it but never writes it.
func uncommandedDeye(t *testing.T, a *Agent) {
	t.Helper()
	selectDeyeFamily(t, a, "sun-12k-sg04lp3")
	if a.controlCertified(a.currentFamily()) {
		t.Fatal("precondition: the Deye must be uncertified")
	}
}

func TestSonneSpeicherReleasesAnObservedBatteryAndKeepsTheCommandedRule(t *testing.T) {
	cases := map[string]struct {
		setup    func(t *testing.T, a *Agent)
		held     bool
		wantMode lastmgmt.ReleaseMode
		wantKw   float64
		wantNote string
	}{
		"Docker-Box: gesteuert, Rücklesung bestätigt": {nil, true, lastmgmt.ReleaseActive, 8,
			"darf bis 30 % entladen"},
		"gesteuert, aber ohne bestätigte Rücklesung": {nil, false, lastmgmt.ReleaseBatteryPath, 3,
			"ohne bestätigte Rückmeldung"},
		// Deye without device approval, only read, no readback: the
		// Edge-Light pilot, TestEdgeLightPilotReleasesItsObservedDeye.
		// A readback that arrives anyway (Node-RED reads back on a Docker
		// box) does not make an unapproved battery a commanded one.
		"Docker-Box ohne Gerätefreigabe, Rücklesung vorhanden": {uncommandedDeye, true,
			lastmgmt.ReleaseObserved, 8, "beobachtet"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a, _ := releaseCoverAgent(t)
			if c.setup != nil {
				c.setup(t, a)
			}
			releaseHome(t, a, lastmgmt.StorageBeforeCars)
			s1 := releaseStation(t, a, "GOE-1")
			for i := 0; i < 4; i++ {
				observedTick(t, a, s1, 80, c.held, selfConsumption)
			}
			nearKwSoon(t, "what the car may draw", drawOf(s1, 1), c.wantKw)
			v, _ := a.ocpp.release.Last()
			if v.Mode != c.wantMode || !strings.Contains(v.Reason, c.wantNote) {
				t.Fatalf("mode %q (%s), want %q with %q", v.Mode, v.Reason, c.wantMode, c.wantNote)
			}
			if hb := a.chargersSummary(); hb.StorageReleaseMode != string(c.wantMode) {
				t.Fatalf("the heartbeat carries the stage: %q", hb.StorageReleaseMode)
			}
		})
	}
}

func TestAnObservedBatteryIsTakenBackAtItsFloor(t *testing.T) {
	a, _ := releaseCoverAgent(t)
	uncommandedDeye(t, a)
	releaseHome(t, a, lastmgmt.StorageBeforeCars)
	s1 := releaseStation(t, a, "GOE-1")
	for i := 0; i < 4; i++ {
		observedTick(t, a, s1, 80, false, selfConsumption)
	}
	nearKwSoon(t, "3 kW sun + 5 kW observed battery", drawOf(s1, 1), 8)

	// The battery reaches its floor: from the next pass on, the car gets the
	// sun only, and the battery is served first.
	for i := 0; i < 4; i++ {
		observedTick(t, a, s1, 30.4, false, selfConsumption)
	}
	nearKwSoon(t, "only the sun at the floor", drawOf(s1, 1), 3)
	v, _ := a.ocpp.release.Last()
	if v.Active || !v.StorageFirst || v.Mode != lastmgmt.ReleaseAtFloor {
		t.Fatalf("at the floor: %+v", v)
	}
}

func TestAnObservedReleaseIsWithdrawnWhenTheSiteImports(t *testing.T) {
	a, _ := releaseCoverAgent(t)
	uncommandedDeye(t, a)
	releaseHome(t, a, lastmgmt.StorageBeforeCars)
	s1 := releaseStation(t, a, "GOE-1")
	for i := 0; i < 4; i++ {
		observedTick(t, a, s1, 80, false, selfConsumption)
	}
	nearKwSoon(t, "released", drawOf(s1, 1), 8)

	// The inverter stops covering the car: the box MEASURES the import (8 kW
	// car + 1 kW house − 4 kW sun = 5 kW from the grid), and this pass starts
	// the effect window through the real wiring (ocppObserveReleaseEffect).
	observedTick(t, a, s1, 80, false, notCovering)
	now := time.Now().UTC()
	_, grid, measured := a.ocpp.budget.ReleaseFacts(now)
	if !measured || grid <= lastmgmt.ReleaseImportToleranceKw {
		t.Fatalf("the box must measure the import: grid %v measured %v", grid, measured)
	}
	used := a.ocpp.previousPlan().StorageReleaseUsedKw
	if used < lastmgmt.ReleaseMinKw {
		t.Fatalf("the car draws released power: used %v", used)
	}
	// The 90-s window cannot pass in a unit test: the gate is driven with an
	// explicit timestamp, on the box's own measured facts.
	if !a.ocpp.release.ObserveEffect(now.Add(lastmgmt.ReleaseEffectWindow+time.Second), used, grid, measured) {
		t.Fatal("90 s of import while releasing must latch the observed release off")
	}
	for i := 0; i < 3; i++ {
		observedTick(t, a, s1, 80, false, notCovering)
	}
	nearKwSoon(t, "back to the sun only", drawOf(s1, 1), 3)
	v, _ := a.ocpp.release.Last()
	if v.Active || v.Mode != lastmgmt.ReleaseEffectLatch {
		t.Fatalf("latched: %+v", v)
	}
}

// Under the global stop the box writes nothing - neither the battery nor the
// wallboxes (ocppControlAllowed) - so nothing is observed or released.
func TestTheGlobalStopIsNoObservedBattery(t *testing.T) {
	a, _ := releaseCoverAgent(t, func(a *Agent) { a.Cfg.ControlEnabled = false })
	now := time.Now().UTC()
	floor := 30.0
	a.mu.Lock()
	a.currentPlan = releasePlan(now, &floor)
	a.lastReading = guards.Reading{SocPct: 80, PvKw: 4, LoadKw: 1, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.applySetpoint(now)
	ok, observed, note := a.releaseReady.get(now, a.releaseReadyWindow())
	if ok || observed || !strings.Contains(note, "Not-Aus") {
		t.Fatalf("Not-Aus: ok %v observed %v note %q", ok, observed, note)
	}
}

// No write lever: an observed battery is never lowered by the release cover,
// even while a car draws released power in a slot whose plan charges it.
func TestTheReleaseCoverNeverWritesAnObservedBattery(t *testing.T) {
	a, sub := releaseCoverAgent(t)
	uncommandedDeye(t, a)
	now := time.Now().UTC()
	yes, eff, max := true, 5.0, 5.0
	floor := 30.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &eff, ReleaseMaxDischargeKw: &max,
		Slots: []plan.Slot{{Start: now, BatterySetpointKw: 3, ReleaseFloorSocPct: &floor}},
	}
	a.lastReading = guards.Reading{SocPct: 80, PvKw: 6, LoadKw: 12, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	f, soc := 30.0, 80.0
	if v := a.ocpp.release.Decide(lastmgmt.ReleaseInput{
		Now: now, PlanFresh: true, MaxDischargeKw: &max, FloorPct: &f, SocPct: &soc,
		Measured: true, BatteryObserved: true, BmsDischargeKw: math.NaN(),
	}); v.Mode != lastmgmt.ReleaseObserved {
		t.Fatalf("precondition: %+v", v)
	}
	a.ocpp.setPlan(&lastmgmt.Plan{StorageReleaseUsedKw: 5})
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the plan's setpoint, untouched and not executed", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 3.0 && m["control_enabled"] == false
	})
	if snap := a.State.Get(); snap.ReleaseCoverKw != nil {
		t.Fatalf("no release cover on an observed battery: %v", *snap.ReleaseCoverKw)
	}
	if ok, observed, _ := a.releaseReady.get(now, a.releaseReadyWindow()); ok || !observed {
		t.Fatalf("the tick must report OBSERVED, not ready: ok %v observed %v", ok, observed)
	}
}
