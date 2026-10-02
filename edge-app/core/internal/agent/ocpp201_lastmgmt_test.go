package agent

import (
	"context"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// ocppStation201 registers and connects an OCPP 2.0.1 rig station (MiSpeL
// MP-36) - the twin of ocppStation.
func ocppStation201(t *testing.T, a *Agent, id string, connectors int, ratedKw float64) *ocppsim.Station201 {
	t.Helper()
	if _, err := a.ocpp.srv.Add(csmsAdd(id, connectors, ratedKw)); err != nil {
		t.Fatalf("register %s: %v", id, err)
	}
	st := ocppsim.NewStation201(ocppsim.Config{ID: id, Connectors: connectors})
	t.Cleanup(st.Stop)
	for deadline := time.Now().Add(5 * time.Second); ; {
		err := st.Connect(ocppEndpoint(a))
		if err == nil {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("station %s: %v", id, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitUntil(t, "the CSMS saw "+id+" over 2.0.1", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID(id)
		return ok && c.Connected && c.OCPPVersion == csms.OCPPVersion201 && len(c.Connectors) == connectors
	})
	return st
}

// TestA16AndA201StationShareOneBudget is the MP-36 load-management proof: a
// 1.6 and a 2.0.1 station under ONE site budget. The same agent step
// commissions both (two permanent profiles each), divides the budget between
// the two sessions by the same rules, and both simulated meters stay within
// it - the 2.0.1 station is steered exactly like the 1.6 one.
func TestA16AndA201StationShareOneBudget(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s16 := ocppStation(t, a, "SAEULE-16", 1, 240)
	s201 := ocppStation201(t, a, "SAEULE-201", 1, 240)

	car := ocppsim.Vehicle{DemandKw: 240, MinKw: 5}
	if err := s16.Plug(1, car); err != nil {
		t.Fatalf("plug 1.6: %v", err)
	}
	if err := s201.Plug(1, car); err != nil {
		t.Fatalf("plug 2.0.1: %v", err)
	}
	waitUntil(t, "two sessions known", func() bool {
		n := 0
		for _, c := range a.ocpp.srv.Snapshot().Chargers {
			n += len(c.ActiveConnectors())
		}
		return n == 2
	})

	a.ocppStep(context.Background())

	budget := 82.3
	total := nearKwSoon(t, "site draw", func() float64 { return s16.TotalDrawKw() + s201.TotalDrawKw() }, budget)
	if total > budget+0.05 {
		t.Fatalf("the stations draw %.3f kW against a %.1f kW budget", total, budget)
	}
	nearKw(t, "the 1.6 vehicle", s16.DrawKw(1), budget/2)
	nearKw(t, "the 2.0.1 vehicle", s201.DrawKw(1), budget/2)

	for _, st := range []interface{ Profiles() []ocppsim.Profile }{s16, s201} {
		purposes := map[string]int{}
		for _, p := range st.Profiles() {
			purposes[p.Purpose]++
		}
		if purposes[ocppsim.PurposeMax] != 1 || purposes[ocppsim.PurposeTxDefault] != 1 || purposes[ocppsim.PurposeTx] != 1 {
			t.Fatalf("profile stack %+v, want one Max, one TxDefault, one Tx", st.Profiles())
		}
	}
	// The safe default is the SAME site-wide figure on both protocols.
	var def16, def201 float64
	for _, p := range s16.Profiles() {
		if p.Purpose == ocppsim.PurposeTxDefault {
			def16 = p.LimitW
		}
	}
	for _, p := range s201.Profiles() {
		if p.Purpose == ocppsim.PurposeTxDefault {
			def201 = p.LimitW
		}
	}
	if def16 <= 0 || def16 != def201 {
		t.Fatalf("safe default 1.6 = %.0f W, 2.0.1 = %.0f W - must be the same", def16, def201)
	}
	for _, c := range a.ocpp.srv.Snapshot().Chargers {
		if c.CommissionError != "" || c.CommissionedAt.IsZero() {
			t.Fatalf("%s (ocpp %q) not commissioned: %s", c.ID, c.OCPPVersion, c.CommissionError)
		}
	}

	// The 2.0.1 session ends: its live profile goes (station and box), the
	// next step gives the freed budget to the 1.6 vehicle.
	if err := s201.Unplug(1); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "2.0.1 session closed", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-201")
		return len(c.ActiveConnectors()) == 0
	})
	a.ocppStep(context.Background())
	minKwSoon(t, "the 1.6 vehicle after the 2.0.1 session ended", drawOf(s16, 1), budget/2+1)
	if got := s16.DrawKw(1); got > budget+0.05 {
		t.Fatalf("the 1.6 vehicle draws %.3f kW against a %.1f kW budget", got, budget)
	}
	for _, p := range s201.Profiles() {
		if p.Purpose == ocppsim.PurposeTx {
			t.Fatalf("an ended 2.0.1 session left a live profile: %+v", p)
		}
	}
}
