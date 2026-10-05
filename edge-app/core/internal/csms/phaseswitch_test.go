package csms_test

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

func switchingPolicy(id string, revision int64, switching bool) ocppcontrol.Policy {
	return ocppcontrol.Policy{Revision: revision, Authorization: ocppcontrol.Authorization{Mode: "free"},
		PhaseLimitsA: []float64{16, 16, 16},
		Electrical: []ocppcontrol.Electrical{{ChargePointID: id, ConnectorID: 1, VoltageV: 230,
			Phases: []int{1, 2, 3}, MaxCurrentA: 16, PhaseSwitching: switching}}}
}

// TestOnePhaseNeedsTheOperatorAndTheStation - one-phase charging is sent only
// where the operator allowed it AND the station reported it can switch; the
// switch can be allowed while a vehicle is charging, because it changes no
// safety profile.
func TestOnePhaseNeedsTheOperatorAndTheStation(t *testing.T) {
	s, cp, st := goeStation(t, "GOE", nil)
	if err := s.Commission(ctx5(t), "GOE", 11, 11, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	tx, err := cp.StartTransaction(1, "CARD", 0, types.NewDateTime(time.Now().UTC()))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyLimitPhases(ctx5(t), "GOE", 1, tx.TransactionId, 2.5, 1); err == nil {
		t.Fatal("one phase without the operator's switch")
	}

	if err := s.SetControlPolicy(switchingPolicy("GOE", 2, true)); err != nil {
		t.Fatalf("allowing the switch must not need idle stations: %v", err)
	}
	if !s.ControlStatus(true, time.Now()).Stations[0].ProfilesAccepted {
		t.Fatal("allowing the switch must not invalidate the safety profiles")
	}
	if err := s.ApplyLimitPhases(ctx5(t), "GOE", 1, tx.TransactionId, 2.5, 1); err == nil {
		t.Fatal("one phase although the station never said it can switch")
	}

	st.mu.Lock()
	st.config[csms.KeyPhaseSwitch] = "true"
	st.mu.Unlock()
	if err := s.RefreshPhaseSwitch(ctx5(t), "GOE"); err != nil {
		t.Fatal(err)
	}
	status := s.ControlStatus(true, time.Now())
	if v := status.Stations[0].PhaseSwitchSupported; v == nil || !*v {
		t.Fatalf("support not recorded: %+v", status.Stations[0])
	}

	if err := s.ApplyLimitPhases(ctx5(t), "GOE", 1, tx.TransactionId, 2.5, 1); err != nil {
		t.Fatal(err)
	}
	p := txProfile(t, st)
	if p.rateUnit != types.ChargingRateUnitAmperes || p.phases != 1 || math.Abs(p.limitW-10.8) > 1e-9 {
		t.Fatalf("one-phase profile: %+v", p)
	}
	if got := s.ControlStatus(true, time.Now()).Stations[0].Connectors[0].Phases; got != 1 {
		t.Fatalf("commanded phases = %d", got)
	}
	cs, verdict, err := s.ReadBack(ctx5(t), "GOE", 1)
	if err != nil || verdict != csms.ReadbackOK || cs.LimitKw == nil || math.Abs(*cs.LimitKw-2.484) > 1e-9 {
		t.Fatalf("one-phase readback: %+v %s %v", cs, verdict, err)
	}

	// The band minimum must not floor below 6 A.
	if err := s.ApplyLimitPhases(ctx5(t), "GOE", 1, tx.TransactionId, 1.38, 1); err != nil {
		t.Fatal(err)
	}
	if p := txProfile(t, st); p.limitW != 6 {
		t.Fatalf("1.38 kW = %v A", p.limitW)
	}

	if err := s.ApplyLimitPhases(ctx5(t), "GOE", 1, tx.TransactionId, 5, 3); err != nil {
		t.Fatal(err)
	}
	if p := txProfile(t, st); p.phases != 3 || math.Abs(p.limitW-7.2) > 1e-9 {
		t.Fatalf("three-phase profile: %+v", p)
	}
	// The plain call keeps doing what it always did.
	if err := s.ApplyLimit(ctx5(t), "GOE", 1, tx.TransactionId, 5); err != nil {
		t.Fatal(err)
	}
	if p := txProfile(t, st); p.phases != 3 {
		t.Fatalf("plain profile: %+v", p)
	}
}

// TestTheInventoryAnswersThePhaseSwitch - a station that reports the key in
// its full configuration needs no extra question.
func TestTheInventoryAnswersThePhaseSwitch(t *testing.T) {
	s, _, _ := goeStation(t, "GOE", map[string]string{csms.KeyPhaseSwitch: "true"})
	if err := s.SetControlPolicy(switchingPolicy("GOE", 2, true)); err != nil {
		t.Fatal(err)
	}
	if err := s.Commission(ctx5(t), "GOE", 11, 11, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if v := s.ControlStatus(true, time.Now()).Stations[0].PhaseSwitchSupported; v == nil || !*v {
		t.Fatal("support not read from the inventory")
	}
}

// TestARefusedInventoryIsAskedForTheOneKey - only where switching is allowed.
func TestARefusedInventoryIsAskedForTheOneKey(t *testing.T) {
	s, _, st := goeStation(t, "GOE", map[string]string{csms.KeyPhaseSwitch: "false"})
	if err := s.SetControlPolicy(switchingPolicy("GOE", 2, true)); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	st.rejectFullConfiguration = true
	st.mu.Unlock()
	if err := s.Commission(ctx5(t), "GOE", 11, 11, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if v := s.ControlStatus(true, time.Now()).Stations[0].PhaseSwitchSupported; v == nil || *v {
		t.Fatal("an explicit false must be recorded as false")
	}
}

// goeStation is ampereStationWithPhaseLimits with the charge point handle, for
// a test that needs a running transaction.
func goeStation(t *testing.T, id string, config map[string]string) (*csms.Server, ocpp16.ChargePoint, *station) {
	t.Helper()
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, id)
	cp, st := connectStation(t, s, endpoint, id, func() time.Time { return now })
	st.mu.Lock()
	st.config[csms.KeyAllowedChargingRateUnit] = "Current"
	for k, v := range config {
		st.config[k] = v
	}
	st.mu.Unlock()
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusAvailable); err != nil {
		t.Fatal(err)
	}
	if err := s.SetControlPolicy(switchingPolicy(id, 1, false)); err != nil {
		t.Fatal(err)
	}
	return s, cp, st
}

func txProfile(t *testing.T, st *station) storedProfile {
	t.Helper()
	st.mu.Lock()
	defer st.mu.Unlock()
	p, ok := st.profiles[[2]int{1, csms.TxProfileID(1)}]
	if !ok {
		t.Fatal("no live profile")
	}
	return p
}
