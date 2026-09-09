package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The cloud must be able to SEE what the box decided - and it must see the
// box's OWN words, not a second rendering of the same verdict. The block rides
// the real path: two registered stations, one of them charging, through the
// executor and out as the heartbeat block.
func TestTheHeartbeatCarriesTheChargePointsAndTheBoxOwnWords(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	st := ocppStation(t, a, "saeule-1", 2, 240)
	ocppStation(t, a, "saeule-2", 2, 240)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the CSMS booked the session", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())

	sum := a.chargersSummary()
	if sum == nil {
		t.Fatal("a plant with charge points must report them")
	}
	var report struct {
		Revision int
		Enabled  bool
		Stations []json.RawMessage
	}
	if err := json.Unmarshal(sum.ControlStatus, &report); err != nil || len(report.Stations) != 2 || !report.Enabled {
		t.Fatalf("control evidence missing from actual cloud heartbeat: %s (%v)", sum.ControlStatus, err)
	}
	if len(sum.Chargers) != 2 {
		t.Fatalf("chargers = %d, want 2", len(sum.Chargers))
	}
	if !sum.Enabled || !sum.ControlEnabled {
		t.Fatalf("both gates are open on this rig: %+v", sum)
	}
	// The site half is the box's arithmetic, verbatim: 277 kW connection,
	// 10 % margin taken FROM it, 167 kW building load -> 82,3 kW budget.
	nearKw(t, "grid limit", sum.GridLimitKw, 277)
	nearKw(t, "budget", sum.BudgetKw, 82.3)
	if sum.ConnectorCount != 4 {
		t.Fatalf("connector count = %d, want 4", sum.ConnectorCount)
	}
	// The emergency default travels with the TERMS it was derived from, so the
	// customer can be shown the sum rather than a bare number - and with the
	// invariant itself: 4 x 24,25 kW + 180 kW = 277 kW <= 277 kW.
	if sum.SafeDefaultKw <= 0 || sum.SafeWorstCaseKw <= 0 || sum.MaxHouseLoadKw != 180 {
		t.Fatalf("the safe default must travel WITH its arithmetic: %+v", sum)
	}
	if !sum.SafeDefaultHolds {
		t.Fatalf("4 x %.3f + 180 = %.3f must hold under 277 kW", sum.SafeDefaultKw,
			sum.SafeWorstCaseKw)
	}

	// The charging connector carries its allocation AND the allocator's own
	// German sentence - the surface repeats it, it never re-words it.
	var found bool
	for _, c := range sum.Chargers {
		if c.ID != "saeule-1" {
			continue
		}
		if !c.Connected || !c.Ready {
			t.Fatalf("saeule-1 is connected and commissioned: %+v", c)
		}
		for _, con := range c.Connectors {
			if con.ID != 1 {
				continue
			}
			found = true
			if !con.Charging || con.AllocatedKw == nil || *con.AllocatedKw <= 0 {
				t.Fatalf("the charging plug must carry its allocation: %+v", con)
			}
			if con.Reason == "" || con.ReasonText == "" {
				t.Fatalf("machine word AND German sentence: %+v", con)
			}
			if con.SessionSince == "" {
				t.Fatal("a running session carries its start")
			}
		}
	}
	if !found {
		t.Fatal("connector 1 of saeule-1 is missing from the block")
	}
}

// A box without a single registered charge point sends NO block at all, so its
// heartbeat is byte-identical to the one it sent before this feature existed.
func TestABoxWithoutChargePointsSendsNoBlockAtAll(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	if sum := a.chargersSummary(); sum != nil {
		t.Fatalf("an empty allowlist must report nothing, got %+v", sum)
	}
	// And a box whose OCPP flag was never on has no runtime at all.
	plain := &Agent{Cfg: a.Cfg, State: a.State}
	if sum := plain.chargersSummary(); sum != nil {
		t.Fatalf("a box without the feature reports nothing, got %+v", sum)
	}
}

// Absent measurements stay ABSENT on the wire - never a fabricated 0. A
// registered station that has never spoken has no power, no energy, no SoC and
// no last-seen stamp, and the JSON must simply omit them.
func TestAbsentChargerMeasurementsAreOmittedNotZeroed(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	if _, err := a.ocpp.srv.Add(csmsAdd("saeule-still", 1, 22)); err != nil {
		t.Fatal(err)
	}
	sum := a.chargersSummary()
	if sum == nil || len(sum.Chargers) != 1 {
		t.Fatalf("a registered station is reported even before it speaks: %+v", sum)
	}
	raw, err := json.Marshal(sum)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"\"power_kw\"", "\"soc_pct\"", "\"energy_kwh\"",
		"\"last_seen\"", "\"measured_kw\""} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("%s must be omitted while unknown: %s", forbidden, raw)
		}
	}
	if sum.Chargers[0].Note == "" {
		t.Fatal("a station that has not reported must say so, never look ready")
	}
}

// The gate rule lives ONCE, on the snapshot, so the web layer and the heartbeat
// cannot drift into two answers: a registered-but-silent station does not count
// as a delivering component, a station that has ever been seen does, and it
// keeps counting across a dropped socket.
func TestTheChargePointGateRuleIsOneRuleOnTheSnapshot(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	if _, err := a.ocpp.srv.Add(csmsAdd("saeule-1", 1, 22)); err != nil {
		t.Fatal(err)
	}
	a.publishOcppState()
	if a.State.Get().HasReportedChargePoint() {
		t.Fatal("a name on the allowlist is not a component that delivers data")
	}
	ocppStation(t, a, "saeule-2", 1, 22)
	a.publishOcppState()
	if !a.State.Get().HasReportedChargePoint() {
		t.Fatal("a station that reported itself opens the gate")
	}
	// Force the "seen once, socket gone" shape.
	snap := a.State.Get()
	for i := range snap.Ocpp.Chargers {
		snap.Ocpp.Chargers[i].Connected = false
		if snap.Ocpp.Chargers[i].ID == "saeule-2" {
			snap.Ocpp.Chargers[i].LastSeenMs = time.Now().UnixMilli()
		}
	}
	a.State.Update(func(s *state.Snapshot) { s.Ocpp = snap.Ocpp })
	if !a.State.Get().HasReportedChargePoint() {
		t.Fatal("a flapping socket must not re-lock a step that was passed")
	}
}

// Cockpit Phase 1 / E2: the heartbeat carries the RUNNING session's own
// balance and the AGE of the measurement - both facts only the box could form.
//
// `energy_kwh` next to them is a CUMULATIVE register; what flowed in THIS
// charge is derivable only where the register reading at StartTransaction is
// known, and the cloud had to join the Slice-10 journal for it. `metered_at`
// is the other half: without it no surface can tell a live kilowatt from one
// that stopped moving half an hour ago.
func TestTheHeartbeatCarriesTheSessionBalanceAndTheAgeOfTheMeasurement(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	st := ocppStation(t, a, "saeule-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 5}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the CSMS booked the session", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())
	if err := st.PublishMeterValues(); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the meter values arrived", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return len(c.Connectors) > 0 && !c.Connectors[0].MeteredAt.IsZero()
	})

	sum := a.chargersSummary()
	if sum == nil || len(sum.Chargers) != 1 || len(sum.Chargers[0].Connectors) == 0 {
		t.Fatalf("summary = %+v", sum)
	}
	con := sum.Chargers[0].Connectors[0]
	if con.MeteredAt == "" {
		t.Fatal("a measured connector must carry the age of its measurement")
	}
	if _, err := time.Parse(time.RFC3339, con.MeteredAt); err != nil {
		t.Fatalf("metered_at = %q: %v", con.MeteredAt, err)
	}
	if con.SessionKwh == nil {
		t.Fatal("a running session with a register must carry its own balance")
	}
	if *con.SessionKwh < 0 {
		t.Fatalf("session_kwh = %v, a balance is never negative", *con.SessionKwh)
	}
	if con.EnergyKwh != nil && *con.SessionKwh > *con.EnergyKwh {
		t.Fatalf("the session balance (%v) cannot exceed the register (%v)",
			*con.SessionKwh, *con.EnergyKwh)
	}
}

// A station that never metered carries NEITHER field - absent stays absent,
// never a fabricated 0 or an epoch stamp (the rule the neighbouring
// measurements already follow).
func TestAnUnmeteredConnectorCarriesNoBalanceAndNoAge(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	st := ocppStation(t, a, "saeule-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 5}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the CSMS booked the session", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 1
	})
	sum := a.chargersSummary()
	raw, err := json.Marshal(sum)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"\"session_kwh\"", "\"metered_at\""} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("%s must be omitted while unknown: %s", forbidden, raw)
		}
	}
}

// THE PRIVACY PROMISE OF P7, on the ONE path that leaves the box: the heartbeat
// carries the card's PSEUDONYM and never its plaintext.
//
// ⚠ It asserts on the SERIALIZED bytes, not on a field: a future field that
// happened to carry the idTag would pass a field check and still ship the
// plaintext to the cloud.
//
// ⚠ And the plaintext does not even reach the box's own LAN surface: `/api/ocpp`
// serializes `state.OcppInfo`, which carries only the pseudonym, and the idTag
// never leaves the `csms` package. The rig pins that half (L15a).
func TestTheHeartbeatCarriesThePseudonymAndNeverThePlaintextCard(t *testing.T) {
	const karte = "GEHEIME-KARTE-4711"
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	st := ocppStation(t, a, "saeule-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5, IdTag: karte}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the CSMS booked the session", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())

	sum := a.chargersSummary()
	if sum == nil || len(sum.Chargers) != 1 || len(sum.Chargers[0].Connectors) != 1 {
		t.Fatalf("the rig station must report its one connector: %+v", sum)
	}
	ref := sum.Chargers[0].Connectors[0].TagRef
	if !strings.HasPrefix(ref, "tagref_") {
		t.Fatalf("the heartbeat must carry the box's pseudonym, got %q", ref)
	}
	raw, err := json.Marshal(sum)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), karte) {
		t.Fatalf("the plaintext card must NEVER leave the box: %s", raw)
	}
	// And it is stable: the same card at the same box is the same pseudonym, or
	// a customer's profile would stop matching between two charges.
	if err := st.Unplug(1); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the session closed", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 0
	})
	// Distinguish the new session from a duplicate Start at OCPP second resolution.
	time.Sleep(time.Second)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5, IdTag: karte}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the CSMS booked the second session", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-1")
		return ok && len(c.ActiveConnectors()) == 1
	})
	a.ocppStep(context.Background())
	again := a.chargersSummary()
	if got := again.Chargers[0].Connectors[0].TagRef; got != ref {
		t.Fatalf("the same card must keep its pseudonym: %q vs %q", got, ref)
	}
}
