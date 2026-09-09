package agent

import (
	"context"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// THE PAIRING, at the wiring (the rig's L15b defect, 2026-09-01).
//
// `ocppObserve` pairs the connection-point sample with the charging power of
// the SAME moment - that pairing IS the control law. It is only real while both
// halves describe the same regime: the grid meter follows a changed charging
// power within its own cadence, the station's MeterValues arrive on ITS
// cadence. Right after a limit changes the two disagree by exactly the
// commanded step, and because the smoothing window takes the trailing MAXIMUM,
// ONE such sample would govern the budget AND the surplus for a whole minute
// (the staircase, reproduced without a rig in internal/lastmgmt).
//
// The rule is csms.Connector.MeterInTransit; here it is asserted on the real
// path, against a real station.
//
// ⚠ The control flags are OFF on purpose: this test is about the OBSERVATION
// half, and a live allocation running in the background would move the
// station's draw underneath the assertions.
func TestAGridSampleIsNotPairedWithAPreChangeChargingPower(t *testing.T) {
	a := ocppAgent(t, func(c *config.Config) {
		c.ControlEnabled = false
		c.ConsumerControlEnabled = false
	})
	ocppSite(t, a, 0)
	st := ocppStation(t, a, "SAEULE-B1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	// The station starts LIMITED, so the poisoning step below is an INCREASE -
	// the direction that matters. (A decrease mispairs too, but there the
	// trailing maximum discards the sample on its own: it is conservative
	// against OVER-estimating the surplus, never against under-estimating it.)
	tx := transactionOf(t, a, "SAEULE-B1", 1)
	a.ocppStep(context.Background())
	if err := a.ocpp.srv.ApplyLimit(context.Background(), "SAEULE-B1", 1, tx, 8); err != nil {
		t.Fatalf("apply: %v", err)
	}
	waitUntil(t, "the station holds its first limit", func() bool {
		return st.TotalDrawKw() > 7 && st.TotalDrawKw() < 9
	})

	// The site EXPORTS 12 kW while the battery takes 10 kW: the whole measured
	// surplus is 22 kW (the rig's L15b constellation).
	const houseKw, batteryKw = -12.0, 10.0
	feed := func() {
		batt := batteryKw
		a.ocppObserve(time.Now().UTC(),
			map[string]float64{"power_kw": houseKw + st.TotalDrawKw()}, &batt)
	}
	surplus := func() lastmgmt.SurplusVerdict {
		return a.ocpp.budget.Surplus(time.Now().UTC(),
			lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	}

	// A SETTLED pair: the station has reported the draw the meter is seeing.
	publishAndSettle(t, a, st)
	feed()
	before := surplus()
	if before.TotalKw == nil {
		t.Fatal("the lane must be measured after a settled pair")
	}
	nearKw(t, "the measured surplus", *before.TotalKw, 22)

	// Now the limit is RAISED and the station follows it at once - but its
	// MeterValues still report the old, smaller draw. Pairing the new grid
	// reading with that old charging power reads the 22 kW surplus as 8 kW, and
	// the trailing MAXIMUM would keep that reading for a whole
	// BudgetSmoothWindow: the staircase.
	if err := a.ocpp.srv.ApplyLimit(context.Background(), "SAEULE-B1", 1, tx, 22); err != nil {
		t.Fatalf("apply: %v", err)
	}
	waitUntil(t, "the station followed the raised limit", func() bool {
		return st.TotalDrawKw() > 21
	})
	feed() // deliberately WITHOUT publishing meter values first

	after := surplus()
	if after.TotalKw == nil {
		t.Fatal("the poisoned SAMPLE is dropped, never the lane")
	}
	nearKw(t, "the surplus after a mispaired sample", *after.TotalKw, 22)

	// And once the station reports under its new limit, the pair is real again
	// - the drop lasts one metering cadence, not a smoothing window.
	publishAndSettle(t, a, st)
	feed()
	settled := surplus()
	if settled.TotalKw == nil {
		t.Fatal("a settled pair must measure the lane")
	}
	nearKw(t, "the surplus once the station caught up", *settled.TotalKw, 22)
}

// publishAndSettle makes the stations report their CURRENT draw and waits until
// the CSMS counts the total as a complete, SETTLED measurement - i.e. every
// claiming connector has reported under the limit it currently holds.
//
// ⚠ It publishes inside the poll, not once before it: a station meters
// continuously, and the executor may re-command a limit in the background - a
// single report before the wait can be left behind by a change that arrives a
// millisecond later.
func publishAndSettle(t *testing.T, a *Agent, stations ...*ocppsim.Station) {
	t.Helper()
	waitUntil(t, "the CSMS has a measurement for every charging connector", func() bool {
		for _, st := range stations {
			if err := st.PublishMeterValues(); err != nil {
				t.Fatalf("meter values: %v", err)
			}
		}
		_, complete := a.ocpp.srv.Snapshot().ChargingTotal(time.Now().UTC(), ocppMeterMaxAge)
		return complete
	})
}

func transactionOf(t *testing.T, a *Agent, id string, connector int) int {
	t.Helper()
	c, ok := a.ocpp.srv.Snapshot().ChargerByID(id)
	if !ok {
		t.Fatalf("station %s unknown", id)
	}
	for _, con := range c.ActiveConnectors() {
		if con.ID == connector && con.Session != nil {
			return con.Session.TransactionID
		}
	}
	t.Fatalf("no live transaction on %s#%d", id, connector)
	return 0
}
