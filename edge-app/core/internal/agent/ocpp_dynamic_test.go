package agent

import (
	"context"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// Stufe 2: the budget follows the MEASURED connection point.
//
// Everything below feeds the executor through the SAME entry point
// onLocalTelemetry uses (a.ocppObserve with a measurements map), so what is
// under test is the real wiring, and it is asserted at the STATIONS - what
// they will actually draw - not at an acknowledgement.

// measureSite publishes the stations' meter values, waits until the CSMS has
// them, and then feeds ONE paired connection-point sample: the building load
// plus whatever the charge points are drawing. That pairing is the control law.
func measureSite(t *testing.T, a *Agent, houseKw float64, stations ...*ocppsim.Station) {
	t.Helper()
	// ⚠ It re-publishes on every poll, because a real station meters
	// CONTINUOUSLY and the settle condition needs that: the executor's own loop
	// may change a limit in the background, and a sample taken before that
	// change describes the previous regime (csms.Connector.MeterInTransit).
	// Publishing once and then only waiting would wait for a report nobody is
	// sending.
	publishAndSettle(t, a, stations...)
	// The synthetic grid reading is built from the charge points' OWN reported
	// power, exactly as a real meter would see it - and exactly the number the
	// tracker adds back, so the pair is self-consistent even while the
	// executor's own loop is re-allocating in the background.
	now := time.Now().UTC()
	charging, _ := a.ocpp.srv.Snapshot().ChargingTotal(now, ocppMeterMaxAge)
	a.ocppObserve(now, map[string]float64{"power_kw": houseKw + charging}, nil)
}

// TestTheMeasuredBudgetReplacesTheMaintainedReserveAtTheStations is the
// headline of Stufe 2: the same site, the same three cars - the maintained
// 167 kW building reserve gives two of them a charge, the MEASURED 20 kW
// building gives all three one, and the site still never exceeds its budget.
func TestTheMeasuredBudgetReplacesTheMaintainedReserveAtTheStations(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	s2 := ocppStation(t, a, "SAEULE-2", 2, 240)

	car := ocppsim.Vehicle{DemandKw: 240, MinKw: 5}
	for _, p := range []struct {
		st  *ocppsim.Station
		con int
	}{{s1, 1}, {s1, 2}, {s2, 1}} {
		if err := p.st.Plug(p.con, car); err != nil {
			t.Fatalf("plug: %v", err)
		}
	}
	waitUntil(t, "three sessions known", func() bool {
		n := 0
		for _, c := range a.ocpp.srv.Snapshot().Chargers {
			n += len(c.ActiveConnectors())
		}
		return n == 3
	})

	// Stufe 1: the maintained reserve leaves 82,3 kW, so one car waits.
	a.ocppStep(context.Background())
	if got := a.State.Get().Ocpp.BudgetMode; got != string(lastmgmt.BudgetStatic) {
		t.Fatalf("budget mode = %q before any measurement, want statisch", got)
	}
	nearKwSoon(t, "static site draw", func() float64 { return s1.TotalDrawKw() + s2.TotalDrawKw() }, 82.3)

	// Now the box MEASURES the connection point: the building is only taking
	// 20 kW, so 249,3 - 20 = 229,3 kW may charge.
	measureSite(t, a, 20, s1, s2)
	a.ocppStep(context.Background())

	info := a.State.Get().Ocpp
	if info.BudgetMode != string(lastmgmt.BudgetMeasured) {
		t.Fatalf("budget mode = %q (%s)", info.BudgetMode, info.BudgetNote)
	}
	nearKw(t, "budget", info.BudgetKw, 229.3)
	if info.SiteLoadKw == nil {
		t.Fatal("the measured rest of the site must be shown")
	}
	nearKw(t, "measured rest of the site", *info.SiteLoadKw, 20)

	total := nearKwSoon(t, "site draw", func() float64 { return s1.TotalDrawKw() + s2.TotalDrawKw() }, 229.3)
	if total > info.BudgetKw+0.05 {
		t.Fatalf("the stations draw %.3f kW against a %.1f kW budget", total, info.BudgetKw)
	}
	charging := 0
	for _, st := range []*ocppsim.Station{s1, s2} {
		for c := 1; c <= 2; c++ {
			if kw := st.DrawKw(c); kw > 0 {
				charging++
				if kw < 30 {
					t.Fatalf("a vehicle is starving at %.3f kW", kw)
				}
			}
		}
	}
	if charging != 3 {
		t.Fatalf("%d vehicles charge, want 3 - the measurement freed the power for the third", charging)
	}
}

// TestGrantingTheBudgetDoesNotShrinkTheBudget is the stability argument at the
// wiring level: the charge points' own draw is inside the measured grid power,
// so a loop that did not add it back would cut the cars it just served.
func TestGrantingTheBudgetDoesNotShrinkTheBudget(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	for i := 0; i < 4; i++ {
		measureSite(t, a, 20, s1)
		a.ocppStep(context.Background())
		info := a.State.Get().Ocpp
		if info.BudgetMode != string(lastmgmt.BudgetMeasured) {
			t.Fatalf("pass %d: mode %q (%s)", i, info.BudgetMode, info.BudgetNote)
		}
		nearKw(t, "budget while the car draws it", info.BudgetKw, 229.3)
		nearKwSoon(t, "the car's draw", drawOf(s1, 1), 229.3)
	}
}

// TestAChargingConnectorThatStopsMeteringFallsBackInsteadOfOscillating: the
// completeness rule, at the wiring level. A head we authorised but cannot
// measure must never drive the loop.
func TestAChargingConnectorThatStopsMeteringFallsBackInsteadOfOscillating(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// The station never publishes a meter value, so the pairing is impossible.
	a.ocppObserve(time.Now().UTC(), map[string]float64{"power_kw": 60}, nil)
	a.ocppStep(context.Background())

	info := a.State.Get().Ocpp
	if info.BudgetMode != string(lastmgmt.BudgetStatic) {
		t.Fatalf("mode = %q, want the static fallback (%s)", info.BudgetMode, info.BudgetNote)
	}
	nearKw(t, "budget", info.BudgetKw, 82.3)
	if info.SiteLoadKw != nil {
		t.Fatal("no usable measurement, so no measured rest may be claimed")
	}
	nearKwSoon(t, "the car's draw", drawOf(s1, 1), 82.3)
}

// TestTheUnreachableReserveIsNotSubtractedTwiceWhileMeasuring: an unreachable
// station's draw is already inside the measured grid power.
func TestTheUnreachableReserveIsNotSubtractedTwiceWhileMeasuring(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	// SAEULE-2 is registered with two plugs but never connects.
	if _, err := a.ocpp.srv.Add(csmsAdd("SAEULE-2", 2, 240)); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// Blind (no measurement): the unreachable plugs' emergency share is held
	// back - 4 plugs on site, (277-180)/4 = 24,25 kW each, 2 unreachable.
	a.ocppStep(context.Background())
	if got := a.State.Get().Ocpp.ReservedKw; got < 48 || got > 49 {
		t.Fatalf("reserved = %v kW, want ~48,5 while blind", got)
	}

	// Measured: the same power is already in the grid reading, so reserving it
	// again would spend it twice.
	measureSite(t, a, 20, s1)
	a.ocppStep(context.Background())
	info := a.State.Get().Ocpp
	if info.BudgetMode != string(lastmgmt.BudgetMeasured) {
		t.Fatalf("mode = %q (%s)", info.BudgetMode, info.BudgetNote)
	}
	if info.ReservedKw != 0 {
		t.Fatalf("reserved = %v kW while measuring, want 0", info.ReservedKw)
	}
}

// TestTheGridOperatorsEnvelopeReachesTheStations: §14a rides the same
// telemetry channel and is most-restrictive-wins.
func TestTheGridOperatorsEnvelopeReachesTheStations(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	measureSite(t, a, 20, s1)
	a.ocppStep(context.Background())
	nearKw(t, "budget without an envelope", a.State.Get().Ocpp.BudgetKw, 229.3)

	// The grid operator dims the connection point to 100 kW.
	if err := s1.PublishMeterValues(); err != nil {
		t.Fatalf("meter values: %v", err)
	}
	now := time.Now().UTC()
	charging, _ := a.ocpp.srv.Snapshot().ChargingTotal(now, ocppMeterMaxAge)
	a.ocppObserve(now, map[string]float64{"power_kw": 20 + charging, "grid_limit_kw": 100}, nil)
	a.ocppStep(context.Background())

	info := a.State.Get().Ocpp
	if !info.Grid14aBinds || info.Grid14aKw == nil || *info.Grid14aKw != 100 {
		t.Fatalf("the envelope must bind: %+v", info)
	}
	nearKw(t, "budget under §14a", info.BudgetKw, 70) // 100*0,9 - 20
	got := nearKwSoon(t, "the car's draw", drawOf(s1, 1), 70)
	if got > 90 {
		t.Fatalf("the site draws %.1f kW against a 100 kW envelope", got)
	}
}

// TestABuildingLoadStepWakesTheExecutorOutOfBand: waiting out a 20 s tick
// would leave the site over its planned import.
func TestABuildingLoadStepWakesTheExecutorOutOfBand(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	measureSite(t, a, 20, s1)
	a.ocppStep(context.Background())
	drain(a.ocpp.wake)

	// A wobble is not worth a pass.
	measureSite(t, a, 22, s1)
	if woken(a.ocpp.wake) {
		t.Fatal("a 2 kW wobble woke the executor")
	}
	// A machine switching on is.
	measureSite(t, a, 150, s1)
	if !woken(a.ocpp.wake) {
		t.Fatal("a 130 kW building step must wake the executor at once")
	}
}

// TestTheFlagOffMeansNoBudgetTrackerAtAll: a box without charge points pays
// nothing for any of this.
func TestTheFlagOffMeansNoBudgetTrackerAtAll(t *testing.T) {
	a := &Agent{}
	// The telemetry choke point calls this on EVERY sample.
	a.ocppObserve(time.Now().UTC(), map[string]float64{"power_kw": 42}, nil)
	if a.ocpp != nil {
		t.Fatal("no runtime must exist with the flag off")
	}
}

func drain(ch chan struct{}) {
	select {
	case <-ch:
	default:
	}
}

func woken(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}
