package csms_test

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/smartcharging"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// The MP-35 test station answers the Smart-Charging use cases too since
// MP-36, so a ClearLimit reaches it like any other station.
func (st *station201) OnClearChargingProfile(*smartcharging.ClearChargingProfileRequest) (*smartcharging.ClearChargingProfileResponse, error) {
	return smartcharging.NewClearChargingProfileResponse(smartcharging.ClearChargingProfileStatusUnknown), nil
}

func (st *station201) OnGetChargingProfiles(*smartcharging.GetChargingProfilesRequest) (*smartcharging.GetChargingProfilesResponse, error) {
	return smartcharging.NewGetChargingProfilesResponse(smartcharging.GetChargingProfileStatusNoProfiles), nil
}

func (st *station201) OnGetCompositeSchedule(r *smartcharging.GetCompositeScheduleRequest) (*smartcharging.GetCompositeScheduleResponse, error) {
	return smartcharging.NewGetCompositeScheduleResponse(smartcharging.GetCompositeScheduleStatusRejected, r.EvseID), nil
}

func (st *station201) OnSetChargingProfile(*smartcharging.SetChargingProfileRequest) (*smartcharging.SetChargingProfileResponse, error) {
	return smartcharging.NewSetChargingProfileResponse(smartcharging.ChargingProfileStatusRejected), nil
}

// skewClock is the simulated station's clock: real time plus an offset the
// test moves forward (the box keeps real time).
type skewClock struct{ offset atomic.Int64 }

func (c *skewClock) now() time.Time          { return time.Now().UTC().Add(time.Duration(c.offset.Load())) }
func (c *skewClock) advance(d time.Duration) { c.offset.Add(int64(d)) }

func sim201(t *testing.T, endpoint, id string, clock *skewClock) *ocppsim.Station201 {
	t.Helper()
	st := ocppsim.NewStation201(ocppsim.Config{ID: id, Connectors: 2, Now: clock.now})
	t.Cleanup(st.Stop)
	if err := st.Connect(endpoint); err != nil {
		t.Fatalf("2.0.1 station %s: %v", id, err)
	}
	return st
}

func profileOf(st *ocppsim.Station201, id int) (ocppsim.Profile, bool) {
	for _, p := range st.Profiles() {
		if p.ID == id {
			return p, true
		}
	}
	return ocppsim.Profile{}, false
}

func sessionTx(s *csms.Server, id string, evse int) int {
	c, _ := charger(s, id)
	if con := c.ConnectorByID(evse); con != nil && con.Session != nil {
		return con.Session.TransactionID
	}
	return 0
}

// TestOCPP201ProfilesSetChangeAndClear is the MP-36 headline on the csms
// level: the SAME Commission / ApplyLimit / ReadBack / ClearLimit that steer
// a 1.6 station install the two permanent profiles on a 2.0.1 station
// (ChargingStationMaxProfile, TxDefaultProfile), push the live TxProfile bound
// to the station's own transactionId, change it in place, read it back and
// remove it - and the simulated meter obeys every step.
func TestOCPP201ProfilesSetChangeAndClear(t *testing.T) {
	const id = "WB-201-P"
	s, endpoint := newServer201(t, t.TempDir(), nil, id)
	defer s.Stop()
	clock := &skewClock{}
	st := sim201(t, endpoint, id, clock)
	waitFor(t, "2.0.1 station connected", func() bool {
		c, ok := charger(s, id)
		return ok && c.Connected && c.OCPPVersion == csms.OCPPVersion201
	})

	if err := s.Commission(ctx5(t), id, 22, 4.2, csms.DefaultMeterInterval); err != nil {
		t.Fatalf("commission over 2.0.1: %v", err)
	}
	c, _ := charger(s, id)
	if c.CommissionError != "" || c.CommissionedAt.IsZero() || kwStr(c.MaxKw) != "22.000 kW" || kwStr(c.DefaultKw) != "4.200 kW" {
		t.Fatalf("commissioned = %+v", c)
	}
	if !c.Capabilities.Read || !c.Capabilities.WattsAllowed || c.Capabilities.MaxStackLevel != 8 || c.Capabilities.MaxPeriods != 24 {
		t.Fatalf("capabilities from SmartChargingCtrlr = %+v", c.Capabilities)
	}
	maxP, okMax := profileOf(st, csms.ProfileIDMax)
	def, okDef := profileOf(st, csms.ProfileIDTxDefault)
	if !okMax || maxP.Purpose != ocppsim.PurposeMax || maxP.ConnectorD != 0 || maxP.LimitW != 22000 || maxP.StackLevel != 0 {
		t.Fatalf("station max profile = %+v (%v)", maxP, okMax)
	}
	if !okDef || def.Purpose != ocppsim.PurposeTxDefault || def.ConnectorD != 0 || def.LimitW != 4200 || def.Duration != 0 {
		t.Fatalf("tx default profile = %+v (%v)", def, okDef)
	}
	if len(st.Profiles()) != 2 {
		t.Fatalf("after commissioning the station holds %+v, want exactly Max + TxDefault", st.Profiles())
	}

	// Before a transaction there is nothing to bind a TxProfile to.
	if err := s.ApplyLimit(ctx5(t), id, 1, 0, 7); err == nil {
		t.Fatal("a TxProfile without a transaction of the station was sent")
	}

	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session opened", func() bool { return sessionTx(s, id, 1) > 0 })
	tx := sessionTx(s, id, 1)
	if got := st.DrawKw(1); got != 4.2 {
		t.Fatalf("without a live profile the vehicle draws %.3f kW, want the TxDefault 4.2", got)
	}

	// SET: the live allocation, bound to the station's transactionId. On the
	// wire it starts one minute in the past and runs that much longer, so it
	// still ends where the box's fuse says (toProfile201, #1395).
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 7); err != nil {
		t.Fatalf("apply over 2.0.1: %v", err)
	}
	live, ok := profileOf(st, csms.TxProfileID(1))
	if !ok || live.Purpose != ocppsim.PurposeTx || live.ConnectorD != 1 || live.LimitW != 7000 || live.Duration != csms.TxProfileDuration+time.Minute {
		t.Fatalf("tx profile = %+v (%v)", live, ok)
	}
	if got := st.DrawKw(1); got != 7 {
		t.Fatalf("draw = %.3f kW, want 7", got)
	}
	if con := connector1(s, id); con.CommandStatus != "Accepted" || kwStr(con.CommandedKw) != "7.000 kW" {
		t.Fatalf("recorded command = %q %s", con.CommandStatus, kwStr(con.CommandedKw))
	}
	if _, verdict, err := s.ReadBack(ctx5(t), id, 1); err != nil || verdict != csms.ReadbackOK {
		t.Fatalf("readback = %q %v", verdict, err)
	}
	report, err := s.ChargingProfiles201(ctx5(t), id, nil)
	if err != nil || len(report) != 3 {
		t.Fatalf("K09 report = %+v %v, want Max, TxDefault, TxProfile", report, err)
	}
	for _, p := range report {
		if p.ID == csms.TxProfileID(1) && (p.TransactionID != id+"-tx-1" || p.Purpose != "TxProfile" || p.EVSE != 1) {
			t.Fatalf("reported tx profile = %+v", p)
		}
		if p.ID == csms.ProfileIDMax && p.Purpose != "ChargingStationMaxProfile" {
			t.Fatalf("reported max profile = %+v", p)
		}
	}

	// CHANGE: same id, replaced in place - never a second live profile.
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 3.5); err != nil {
		t.Fatal(err)
	}
	if got := st.DrawKw(1); got != 3.5 || len(st.Profiles()) != 3 {
		t.Fatalf("after change: draw %.3f kW, profiles %+v", got, st.Profiles())
	}
	// A pause is a limit of 0, not a missing limit.
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 0); err != nil || st.DrawKw(1) != 0 {
		t.Fatalf("pause: %v, draw %.3f", err, st.DrawKw(1))
	}
	// The site cap holds above any allocation.
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 50); err != nil {
		t.Fatal(err)
	}
	if p, _ := profileOf(st, csms.TxProfileID(1)); p.LimitW != 22000 {
		t.Fatalf("an allocation above the station maximum was sent as %.0f W", p.LimitW)
	}

	// CLEAR: the live profile goes, the safe default takes over.
	if err := s.ClearLimit(ctx5(t), id, 1); err != nil {
		t.Fatal(err)
	}
	if _, still := profileOf(st, csms.TxProfileID(1)); still || st.DrawKw(1) != 4.2 {
		t.Fatalf("after clear: profiles %+v draw %.3f", st.Profiles(), st.DrawKw(1))
	}
	if con := connector1(s, id); con.CommandedKw != nil || con.CommandStatus != "" {
		t.Fatalf("a cleared connector still claims a command: %+v", con)
	}
	report, err = s.ChargingProfiles201(ctx5(t), id, nil)
	if err != nil || len(report) != 2 {
		t.Fatalf("K09 after clear = %+v %v", report, err)
	}
}

// TestOCPP201ConnectionLossDuringAProfile: the box goes silent while a 2.0.1
// station holds a live profile. The station falls back to the TxDefault ON
// ITS OWN once the 120-second fuse has run out; the box refuses to command
// the station while it is gone and after it returns until it has been
// commissioned on the new connection - the same guard as 1.6.
func TestOCPP201ConnectionLossDuringAProfile(t *testing.T) {
	const id = "WB-201-L"
	s, endpoint := newServer201(t, t.TempDir(), nil, id)
	defer s.Stop()
	clock := &skewClock{}
	st := sim201(t, endpoint, id, clock)
	waitFor(t, "connected", func() bool { c, ok := charger(s, id); return ok && c.Connected })
	if err := s.Commission(ctx5(t), id, 22, 4.2, csms.DefaultMeterInterval); err != nil {
		t.Fatal(err)
	}
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session", func() bool { return sessionTx(s, id, 1) > 0 })
	tx := sessionTx(s, id, 1)
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 9); err != nil || st.DrawKw(1) != 9 {
		t.Fatalf("apply: %v draw %.3f", err, st.DrawKw(1))
	}

	st.Stop()
	waitFor(t, "disconnect seen", func() bool { c, _ := charger(s, id); return !c.Connected })
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 9); !errors.Is(err, csms.ErrNotConnected) {
		t.Fatalf("apply while gone: %v, want ErrNotConnected", err)
	}
	if got := st.DrawKw(1); got != 9 {
		t.Fatalf("inside the fuse the station keeps the last limit, draws %.3f", got)
	}
	clock.advance(csms.TxProfileDuration + time.Second)
	if got := st.DrawKw(1); got != 4.2 {
		t.Fatalf("after the fuse the station draws %.3f kW, want the TxDefault 4.2", got)
	}
	// The rig's station clock ran ahead only to let the fuse burn; it is back
	// in step with the box for the rest of the case.
	clock.advance(-(csms.TxProfileDuration + time.Second))

	// Back on a new connection (network loss, no reboot: the transaction
	// runs on): no command before the safety profiles are re-installed on
	// THIS connection.
	if err := st.Reconnect(endpoint); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "reconnected", func() bool { c, _ := charger(s, id); return c.Connected })
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 9); err == nil {
		t.Fatal("a reconnected 2.0.1 station was commanded before re-commissioning")
	}
	if err := s.Commission(ctx5(t), id, 22, 4.2, csms.DefaultMeterInterval); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyLimit(ctx5(t), id, 1, tx, 6); err != nil || st.DrawKw(1) != 6 {
		t.Fatalf("after re-commissioning: %v draw %.3f", err, st.DrawKw(1))
	}
}

// TestOCPP201AuthorizationGuardIsTheSameAsFor16: with the card allowlist on,
// commissioning tightens the station's own authorization exactly like the 1.6
// keys - written through the Device Model and read back.
func TestOCPP201AuthorizationGuardIsTheSameAsFor16(t *testing.T) {
	const id = "WB-201-A"
	s, endpoint := newServer201(t, t.TempDir(), nil, id)
	defer s.Stop()
	if err := s.SetControlPolicy(ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "allowlist"}}); err != nil {
		t.Fatal(err)
	}
	st := sim201(t, endpoint, id, &skewClock{})
	waitFor(t, "connected", func() bool { c, ok := charger(s, id); return ok && c.Connected })
	if err := s.Commission(ctx5(t), id, 22, 4.2, csms.DefaultMeterInterval); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"AuthCtrlr/OfflineTxForUnknownIdEnabled": "false", "AuthCacheCtrlr/Enabled": "false",
		"AuthCtrlr/LocalPreAuthorize": "false", "AuthCtrlr/LocalAuthorizeOffline": "false",
		"LocalAuthListCtrlr/Enabled": "false", "TxCtrlr/StopTxOnInvalidId": "true",
		"TxCtrlr/MaxEnergyOnInvalidId": "0", "AuthCtrlr/AuthorizeRemoteStart": "true",
	}
	for k, v := range want {
		if got := st.Var(k); got != v {
			t.Fatalf("%s = %q, want %q", k, got, v)
		}
	}
	for _, k := range []string{"AllowOfflineTxForUnknownId", "StopTransactionOnInvalidId", "AuthorizeRemoteTxRequests"} {
		if csms.Config201Variable(k) == "" {
			t.Fatalf("1.6 key %s has no 2.0.1 variable", k)
		}
	}
}
