package agent

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The OCPP executor is exercised WITHOUT bringing up the whole agent (no local
// bus, no cloud, no enrollment): the charge-point path touches only Cfg, State
// and its own runtime, so a minimal agent is both sufficient and honest about
// what is under test.
func ocppAgent(t *testing.T, tune func(*config.Config)) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.OcppEnabled = true
	cfg.OcppPort = 0 // a free one
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	if tune != nil {
		tune(&cfg)
	}
	// Der Lastspitzen-Zähler gehört zur Ausstattung des echten Agenten und
	// speist seit Stufe 4 die FAHRPLAN-Bahn des Ladebudgets; ohne ihn wäre
	// diese Attrappe an genau der Stelle unrealistisch.
	a := &Agent{Cfg: cfg, State: state.New("rig-ref", "test"), peak: guards.NewPeakTracker()}
	if err := a.startOcpp(context.Background()); err != nil {
		t.Fatalf("startOcpp: %v", err)
	}
	t.Cleanup(a.stopOcpp)
	return a
}

// site writes the mockups' running example into the agent's settings.
func ocppSite(t *testing.T, a *Agent, houseReserve float64) {
	t.Helper()
	set := lastmgmt.Settings{
		GridLimitKw: 277, HouseReserveKw: houseReserve, MarginPct: 10,
		MinPowerKw: 30, RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 180,
	}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

func ocppEndpoint(a *Agent) string {
	snap := a.ocpp.srv.Snapshot()
	return fmt.Sprintf("ws://127.0.0.1:%d%s", snap.Port, snap.URLPath)
}

// register + connect a simulated station.
func ocppStation(t *testing.T, a *Agent, id string, connectors int, ratedKw float64) *ocppsim.Station {
	t.Helper()
	if _, err := a.ocpp.srv.Add(csmsAdd(id, connectors, ratedKw)); err != nil {
		t.Fatalf("register %s: %v", id, err)
	}
	st := ocppsim.New(ocppsim.Config{ID: id, Connectors: connectors})
	if err := st.Connect(ocppEndpoint(a)); err != nil {
		t.Fatalf("station %s: %v", id, err)
	}
	t.Cleanup(st.Stop)
	waitUntil(t, "the CSMS saw "+id, func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID(id)
		return ok && c.Connected && len(c.Connectors) == connectors
	})
	return st
}

// csmsAdd builds the registration request for a rig station.
func csmsAdd(id string, connectors int, ratedKw float64) csms.AddRequest {
	return csms.AddRequest{ID: id, Connectors: connectors, RatedKw: ratedKw}
}

// findProfile returns the limit (W) of the station's profile of that purpose,
// failing the test when it is absent.
func findProfile(t *testing.T, st *ocppsim.Station, purpose string) float64 {
	t.Helper()
	if w := findProfileSoft(st, purpose); w > 0 {
		return w
	}
	t.Fatalf("no %s at the station: %+v", purpose, st.Profiles())
	return 0
}

func findProfileSoft(st *ocppsim.Station, purpose string) float64 {
	for _, p := range st.Profiles() {
		if p.Purpose == purpose {
			return p.LimitW
		}
	}
	return 0
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func nearKw(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.05 {
		t.Fatalf("%s = %.3f kW, want %.3f kW", what, got, want)
	}
}

// TestTheFlagOffLeavesTheBoxByteForByteAsItWas.
func TestTheFlagOffLeavesTheBoxByteForByteAsItWas(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.OcppEnabled = false
	a := &Agent{Cfg: cfg, State: state.New("ref", "test")}
	if err := a.startOcpp(context.Background()); err != nil {
		t.Fatalf("startOcpp with the flag off: %v", err)
	}
	if a.ocpp != nil {
		t.Fatal("a runtime was created with the flag off")
	}
	if a.State.Get().Ocpp != nil {
		t.Fatal("the snapshot gained an OCPP block with the flag off")
	}
	a.stopOcpp() // must not panic
}

// TestTheBudgetIsHeldAtTheStations is the headline of the whole feature, and
// it is asserted at the STATIONS - what they will actually draw - not at the
// acknowledgements.
//
// The mockups' scenario, arithmetic and all: 277 kW connection, 10 % margin,
// 167 kW building -> 82.3 kW for charging; 30 kW Mindestleistung; three
// vehicles that would each take 240 kW. Two charge at 41.15 kW, one waits.
func TestTheBudgetIsHeldAtTheStations(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	s2 := ocppStation(t, a, "SAEULE-2", 2, 240)

	car := ocppsim.Vehicle{DemandKw: 240, MinKw: 5}
	if err := s1.Plug(1, car); err != nil {
		t.Fatalf("plug: %v", err)
	}
	if err := s1.Plug(2, car); err != nil {
		t.Fatalf("plug: %v", err)
	}
	if err := s2.Plug(1, car); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "three sessions known", func() bool {
		n := 0
		for _, c := range a.ocpp.srv.Snapshot().Chargers {
			n += len(c.ActiveConnectors())
		}
		return n == 3
	})

	a.ocppStep(context.Background())

	total := s1.TotalDrawKw() + s2.TotalDrawKw()
	budget := 82.3
	if total > budget+0.05 {
		t.Fatalf("the stations draw %.3f kW against a %.1f kW budget", total, budget)
	}
	nearKw(t, "site draw", total, budget)

	charging, waiting := 0, 0
	for _, st := range []*ocppsim.Station{s1, s2} {
		for c := 1; c <= 2; c++ {
			switch kw := st.DrawKw(c); {
			case kw == 0:
			case kw >= 30:
				charging++
				nearKw(t, "an admitted vehicle", kw, 41.15)
			default:
				t.Fatalf("a vehicle is starving at %.3f kW (below the 30 kW Mindestleistung)", kw)
			}
		}
	}
	for _, c := range a.State.Get().Ocpp.Chargers {
		for _, con := range c.Connectors {
			if con.Reason == lastmgmt.ReasonBudget {
				waiting++
				if con.ReasonText == "" {
					t.Fatalf("%s#%d waits without a sentence", c.ID, con.ID)
				}
			}
		}
	}
	if charging != 2 || waiting != 1 {
		t.Fatalf("got %d charging / %d waiting, want 2/1", charging, waiting)
	}
}

// TestTheSafeDefaultIsInstalledAndReDepositedWhenTheSiteGrows: the emergency
// default is a SITE-wide figure, so a station arriving changes it for
// everyone - and everyone must be re-commissioned with the new, smaller value.
func TestTheSafeDefaultIsInstalledAndReDepositedWhenTheSiteGrows(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	a.ocppStep(context.Background())

	// (277 - 180) / 2 plugs, floored.
	firstDefault := findProfile(t, s1, "TxDefaultProfile")
	nearKw(t, "safe default with two plugs", firstDefault/1000, 48.5)

	// A second station doubles the plug count -> the share halves.
	s2 := ocppStation(t, a, "SAEULE-2", 2, 240)
	a.ocppStep(context.Background())
	waitUntil(t, "both stations carry the smaller default", func() bool {
		return math.Abs(findProfileSoft(s1, "TxDefaultProfile")/1000-24.25) < 0.05 &&
			math.Abs(findProfileSoft(s2, "TxDefaultProfile")/1000-24.25) < 0.05
	})

	// And the invariant that makes it an emergency default at all: every plug
	// on the site running it at once, on top of the worst building load, still
	// fits under the connection.
	info := a.State.Get().Ocpp
	if info.ConnectorCount != 4 {
		t.Fatalf("connector count = %d, want 4", info.ConnectorCount)
	}
	if !info.SafeDefaultHolds {
		t.Fatalf("the emergency default does not hold: %+v", info)
	}
	if info.SafeWorstCaseKw > info.GridLimitKw+0.001 {
		t.Fatalf("worst case %.3f exceeds the connection %.3f", info.SafeWorstCaseKw, info.GridLimitKw)
	}
}

// TestWithoutTheControlSwitchesTheProtectionIsStillInstalled is the two-gate
// rule: the PROTECTIVE profiles go in whenever the server runs (they only ever
// reduce), the LIVE allocation needs the plant's control switches - and the
// surface SAYS which one is missing.
func TestWithoutTheControlSwitchesTheProtectionIsStillInstalled(t *testing.T) {
	a := ocppAgent(t, func(c *config.Config) { c.ConsumerControlEnabled = false })
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 2, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())

	// The protection is there ...
	if findProfileSoft(s1, "TxDefaultProfile") <= 0 {
		t.Fatal("the safe default was not installed while control is gated off")
	}
	if findProfileSoft(s1, "ChargePointMaxProfile") <= 0 {
		t.Fatal("the station cap was not installed while control is gated off")
	}
	// ... the live allocation is NOT ...
	for _, p := range s1.Profiles() {
		if p.Purpose == "TxProfile" {
			t.Fatalf("a live limit was written while control is gated off: %+v", p)
		}
	}
	// ... and the vehicle runs on the safe default, which is under the budget.
	nearKw(t, "the gated vehicle", s1.DrawKw(1), 48.5)

	// ... and the surface says WHY: a refusal nobody can see is a riddle.
	info := a.State.Get().Ocpp
	if info.ControlEnabled {
		t.Fatal("the state claims the live allocation is on")
	}
	if info.ControlNote == "" {
		t.Fatal("the live allocation is off without a reason")
	}

	// The global stop names ITSELF, not the consumer switch.
	b := ocppAgent(t, func(c *config.Config) { c.ControlEnabled = false })
	if _, note := b.ocppControlAllowed(); note == "" || note == info.ControlNote {
		t.Fatalf("the global stop must name itself: %q vs %q", note, info.ControlNote)
	}
}

// TestAnEndedSessionLosesItsLimit: OCPP says a station drops a TxProfile with
// its transaction, but a firmware that keeps it would let the NEXT vehicle
// silently inherit the previous one's limit.
func TestAnEndedSessionLosesItsLimit(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "session", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())
	if findProfileSoft(s1, "TxProfile") <= 0 {
		t.Fatal("no live limit was written")
	}

	if err := s1.Unplug(1); err != nil {
		t.Fatalf("unplug: %v", err)
	}
	waitUntil(t, "the session closed", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 0
	})
	a.ocppStep(context.Background())
	waitUntil(t, "the live limit is gone", func() bool {
		for _, p := range s1.Profiles() {
			if p.Purpose == "TxProfile" {
				return false
			}
		}
		return true
	})
}

// TestAnAmpereOnlyStationGetsNoLimitAndSaysWhy - the product refuses to guess
// voltage and phase count, and that refusal must be VISIBLE.
func TestAnAmpereOnlyStationGetsNoLimitAndSaysWhy(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	if _, err := a.ocpp.srv.Add(csmsAdd("SAEULE-A", 1, 22)); err != nil {
		t.Fatalf("register: %v", err)
	}
	st := ocppsim.New(ocppsim.Config{ID: "SAEULE-A", Connectors: 1, AmpsOnly: true})
	if err := st.Connect(ocppEndpoint(a)); err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(st.Stop)
	waitUntil(t, "connected", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-A")
		return ok && c.Connected
	})
	a.ocppStep(context.Background())

	if len(st.Profiles()) != 0 {
		t.Fatalf("a limit was written to a station we cannot address: %+v", st.Profiles())
	}
	info := a.State.Get().Ocpp
	if len(info.Chargers) != 1 || info.Chargers[0].Ready {
		t.Fatalf("the station is reported ready: %+v", info.Chargers)
	}
	if info.Chargers[0].Note == "" {
		t.Fatal("refused without a reason on the surface")
	}
}

// TestAnUnreachableStationIsNotTreatedAsDrawingNothing: its share is already
// accounted for by the emergency-default arithmetic. Handing it to the others
// would double-spend it.
func TestAnUnreachableStationIsNotTreatedAsDrawingNothing(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	s2 := ocppStation(t, a, "SAEULE-2", 1, 240)
	car := ocppsim.Vehicle{DemandKw: 240, MinKw: 5}
	if err := s1.Plug(1, car); err != nil {
		t.Fatalf("plug: %v", err)
	}
	if err := s2.Plug(1, car); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "two sessions", func() bool {
		n := 0
		for _, c := range a.ocpp.srv.Snapshot().Chargers {
			n += len(c.ActiveConnectors())
		}
		return n == 2
	})
	a.ocppStep(context.Background())
	nearKw(t, "each of two", s1.DrawKw(1), 41.15)

	// Station 2 vanishes. Its session STAYS recorded (a dead socket says
	// nothing about the car), but it is no longer a claimant - and station 1
	// must NOT be handed its share, because station 2 is still holding its own
	// safe default.
	s2.Stop()
	waitUntil(t, "the disconnect is recorded", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-2")
		return !c.Connected
	})
	a.ocppStep(context.Background())

	// Two stations, one plug each -> the emergency default is (277-180)/2 =
	// 48.5 kW. Station 2 is holding it, so only 82.3 - 48.5 = 33.8 kW is ours
	// to hand out.
	got := s1.DrawKw(1)
	nearKw(t, "station 1 after the other vanished", got, 33.8)
	info := a.State.Get().Ocpp
	nearKw(t, "reserved for the unreachable station", info.ReservedKw, 48.5)
	// The sum of what the site can now draw still fits: 33.8 (ours) + 48.5
	// (theirs) + 167 (the building) = 249.3, the planable power.
	if info.AllocatedKw+info.ReservedKw > info.BudgetKw+0.05 {
		t.Fatalf("allocated %.3f + reserved %.3f exceeds the budget %.3f",
			info.AllocatedKw, info.ReservedKw, info.BudgetKw)
	}
}

// TestTheStateSnapshotNeverInventsAMeasurement: an absent measurand is not a
// zero one, on this surface as everywhere else.
func TestTheStateSnapshotNeverInventsAMeasurement(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	ocppStation(t, a, "SAEULE-1", 2, 240)
	a.ocppStep(context.Background())

	info := a.State.Get().Ocpp
	if info == nil {
		t.Fatal("no OCPP block")
	}
	if info.MeasuredKw != nil {
		t.Fatalf("a measurement was invented before any station reported one: %v", *info.MeasuredKw)
	}
	if info.Endpoint == "" {
		t.Fatal("the endpoint is not shown")
	}
	if len(info.Chargers) != 1 || len(info.Chargers[0].Connectors) != 2 {
		t.Fatalf("chargers: %+v", info.Chargers)
	}
	for _, con := range info.Chargers[0].Connectors {
		if con.PowerKw != nil || con.EnergyKwh != nil || con.SocPct != nil {
			t.Fatalf("connector %d carries invented measurements: %+v", con.ID, con)
		}
		if con.AllocatedKw != nil {
			t.Fatalf("an idle connector was given an allocation: %+v", con)
		}
	}
	nearKw(t, "budget on the surface", info.BudgetKw, 82.3)
	// One station with two plugs: (277 - 180) / 2, floored.
	nearKw(t, "safe default on the surface", info.SafeDefaultKw, 48.5)
}
