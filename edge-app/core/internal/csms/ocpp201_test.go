package csms_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	ocpp2 "github.com/lorenzodonini/ocpp-go/ocpp2.0.1"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/availability"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/provisioning"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/transactions"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ladepunktsim"
)

// station201 is the device side of the OCPP 2.0.1 test client: a Device
// Model with the SampledDataCtrlr variables (B05/B06) and a base report (B07).
type station201 struct {
	mu   sync.Mutex
	vars map[string]string
	// refuse lists measurand values the station rejects (a unidirectional box
	// without export register or SoC).
	refuse map[string]bool
	cs     ocpp2.ChargingStation
}

func newStation201() *station201 {
	return &station201{vars: map[string]string{
		"SampledDataCtrlr/TxUpdatedMeasurands": "Energy.Active.Import.Register",
		"SampledDataCtrlr/TxStartedMeasurands": "",
		"SampledDataCtrlr/TxEndedMeasurands":   "",
		"SampledDataCtrlr/TxUpdatedInterval":   "60",
	}, refuse: map[string]bool{}}
}

func (st *station201) value(k string) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.vars[k]
}

func (st *station201) OnGetBaseReport(req *provisioning.GetBaseReportRequest) (*provisioning.GetBaseReportResponse, error) {
	go func() {
		_, _ = st.cs.NotifyReport(req.RequestID, types.NewDateTime(time.Now()), 0, func(r *provisioning.NotifyReportRequest) {
			r.ReportData = []provisioning.ReportData{
				{Component: types.Component{Name: "EVSE", EVSE: &types.EVSE{ID: 1}}, Variable: types.Variable{Name: "Power"},
					VariableAttribute: []provisioning.VariableAttribute{{Type: types.AttributeMaxSet, Value: "11000"}}},
				{Component: types.Component{Name: "SampledDataCtrlr"}, Variable: types.Variable{Name: "TxUpdatedInterval"},
					VariableAttribute: []provisioning.VariableAttribute{{Type: types.AttributeActual, Value: st.value("SampledDataCtrlr/TxUpdatedInterval")}}},
			}
		})
	}()
	return provisioning.NewGetBaseReportResponse(types.GenericDeviceModelStatusAccepted), nil
}

func (st *station201) OnGetReport(*provisioning.GetReportRequest) (*provisioning.GetReportResponse, error) {
	return nil, errors.New("not in this test")
}

func (st *station201) OnGetVariables(req *provisioning.GetVariablesRequest) (*provisioning.GetVariablesResponse, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	var out []provisioning.GetVariableResult
	// Answer in REVERSE order: the CSMS must match by name, not position.
	for i := len(req.GetVariableData) - 1; i >= 0; i-- {
		d := req.GetVariableData[i]
		v, ok := st.vars[d.Component.Name+"/"+d.Variable.Name]
		status := provisioning.GetVariableStatusAccepted
		if !ok {
			status = provisioning.GetVariableStatusUnknownVariable
		}
		out = append(out, provisioning.GetVariableResult{AttributeStatus: status, AttributeValue: v, Component: d.Component, Variable: d.Variable})
	}
	return provisioning.NewGetVariablesResponse(out), nil
}

func (st *station201) OnReset(*provisioning.ResetRequest) (*provisioning.ResetResponse, error) {
	return nil, errors.New("not in this test")
}

func (st *station201) OnSetNetworkProfile(*provisioning.SetNetworkProfileRequest) (*provisioning.SetNetworkProfileResponse, error) {
	return nil, errors.New("not in this test")
}

func (st *station201) OnSetVariables(req *provisioning.SetVariablesRequest) (*provisioning.SetVariablesResponse, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	var out []provisioning.SetVariableResult
	for _, d := range req.SetVariableData {
		k := d.Component.Name + "/" + d.Variable.Name
		status := provisioning.SetVariableStatusAccepted
		if _, ok := st.vars[k]; !ok {
			status = provisioning.SetVariableStatusUnknownVariable
		} else {
			for _, m := range strings.Split(d.AttributeValue, ",") {
				if st.refuse[m] {
					status = provisioning.SetVariableStatusRejected
				}
			}
		}
		if status == provisioning.SetVariableStatusAccepted {
			st.vars[k] = d.AttributeValue
		}
		out = append(out, provisioning.SetVariableResult{AttributeStatus: status, Component: d.Component, Variable: d.Variable})
	}
	return provisioning.NewSetVariablesResponse(out), nil
}

// connect201 dials the box as an OCPP 2.0.1 charging station (subprotocol
// "ocpp2.0.1") - the library client appends the id to the base endpoint.
func connect201(t *testing.T, endpoint, id string, st *station201) (ocpp2.ChargingStation, func()) {
	t.Helper()
	cs := ocpp2.NewChargingStation(id, nil, nil)
	st.cs = cs
	cs.SetProvisioningHandler(st)
	if err := cs.Start(endpoint); err != nil {
		t.Fatalf("2.0.1 station %s could not connect to %s: %v", id, endpoint, err)
	}
	stop := sync.OnceFunc(cs.Stop)
	t.Cleanup(stop)
	return cs, stop
}

func boot201(t *testing.T, cs ocpp2.ChargingStation) {
	t.Helper()
	resp, err := cs.BootNotification(provisioning.BootReasonPowerUp, "WB-201", "Simulator", func(r *provisioning.BootNotificationRequest) {
		r.ChargingStation.FirmwareVersion = "2.0.1-test"
		r.ChargingStation.SerialNumber = "S-201"
	})
	if err != nil || resp.Status != provisioning.RegistrationStatusAccepted {
		t.Fatalf("boot: %v %+v", err, resp)
	}
}

// messwerte turns the MP-34 simulator's reading into 2.0.1 sampled values:
// import register (Z2V) in kWh as Wh with multiplier 3, export register (Z2E)
// in kWh, power in kW/W, SoC in percent - every unit path once.
func messwerte(m ladepunktsim.Messung, ctx types.ReadingContext, at time.Time) []types.MeterValue {
	three := 3
	sv := []types.SampledValue{
		{Value: m.ZaehlerVerbrauchKwh, Measurand: types.MeasurandEnergyActiveImportRegister, Context: ctx,
			UnitOfMeasure: &types.UnitOfMeasure{Unit: "Wh", Multiplier: &three}},
		{Value: m.ZaehlerErzeugungKwh, Measurand: types.MeasurandEnergyActiveExportRegister, Context: ctx,
			UnitOfMeasure: &types.UnitOfMeasure{Unit: "kWh"}},
		{Value: m.LeistungBezugKw, Measurand: types.MeasurandPowerActiveImport, Context: ctx, UnitOfMeasure: &types.UnitOfMeasure{Unit: "kW"}},
		{Value: m.LeistungRueckspeisungKw * 1000, Measurand: types.MeasurandPowerActiveExport, Context: ctx, UnitOfMeasure: &types.UnitOfMeasure{Unit: "W"}},
	}
	if m.SocPct != nil {
		sv = append(sv, types.SampledValue{Value: *m.SocPct, Measurand: types.MeasurandSoC, Context: ctx, UnitOfMeasure: &types.UnitOfMeasure{Unit: "Percent"}})
	}
	return []types.MeterValue{{Timestamp: *types.NewDateTime(at), SampledValue: sv}}
}

type sampleSink struct {
	mu      sync.Mutex
	samples []csms.SampledReading
}

func (s *sampleSink) add(in []csms.SampledReading, _ time.Time) {
	s.mu.Lock()
	s.samples = append(s.samples, in...)
	s.mu.Unlock()
}

func (s *sampleSink) last(measurand string) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.samples) - 1; i >= 0; i-- {
		if s.samples[i].Measurand == measurand {
			return s.samples[i].Value, s.samples[i].Unit, true
		}
	}
	return "", "", false
}

func newServer201(t *testing.T, dir string, sink *sampleSink, ids ...string) (*csms.Server, string) {
	t.Helper()
	opts := csms.Options{Enabled: true, DataDir: dir, Log: quiet()}
	if sink != nil {
		opts.OnSampledValues = sink.add
	}
	s, err := csms.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if _, err := s.Add(csms.AddRequest{ID: id}); err != nil {
			t.Fatalf("add %s: %v", id, err)
		}
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	return s, fmt.Sprintf("ws://127.0.0.1:%d%s", snap.Port, snap.URLPath)
}

func charger(s *csms.Server, id string) (csms.ChargerState, bool) {
	for _, c := range s.Snapshot().Chargers {
		if c.ID == id {
			return c, true
		}
	}
	return csms.ChargerState{}, false
}

func connector1(s *csms.Server, id string) csms.Connector {
	c, _ := charger(s, id)
	if con := c.ConnectorByID(1); con != nil {
		return *con
	}
	return csms.Connector{}
}

// TestOCPP201StationBootsChargesReconnectsAndEnds is the MP-35 headline: an
// OCPP 2.0.1 station (ocpp-go client, meter from the MP-34 simulator) boots,
// gets its sampled data configured and read back, charges through
// TransactionEvent Started/Updated/Ended with both registers, loses its
// socket, reconnects, survives a box restart - and lands on the same internal
// charge-point state a 1.6 station produces.
func TestOCPP201StationBootsChargesReconnectsAndEnds(t *testing.T) {
	const id = "WB-201"
	// OCPP timestamps carry whole seconds and the box keeps only strictly
	// newer readings, so every station message gets its own second - all
	// within MaxLiveMeterAge before the box's real clock.
	stamp := time.Now().Add(-25 * time.Second).Truncate(time.Second)
	next := func() time.Time { stamp = stamp.Add(time.Second); return stamp }
	dir := t.TempDir()
	sink := &sampleSink{}
	s, endpoint := newServer201(t, dir, sink, id)
	stopServer := sync.OnceFunc(s.Stop)
	t.Cleanup(stopServer)

	st := newStation201()
	cs, drop := connect201(t, endpoint, id, st)
	boot201(t, cs)
	waitFor(t, "2.0.1 station connected", func() bool {
		c, _ := charger(s, id)
		return c.Connected && c.OCPPVersion == csms.OCPPVersion201 && c.Vendor == "Simulator" && c.Serial == "S-201"
	})

	// G01 after boot triggers the sampled-data configuration (B05) and its
	// read-back (B06).
	if _, err := cs.StatusNotification(types.NewDateTime(next()), availability.ConnectorStatusAvailable, 1, 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "metering configured", func() bool {
		m, ok := s.Metering201(id)
		return ok && m.Status == "confirmed"
	})
	if got := st.value("SampledDataCtrlr/TxUpdatedMeasurands"); !strings.Contains(got, "Energy.Active.Export.Register") || !strings.Contains(got, "SoC") {
		t.Fatalf("TxUpdatedMeasurands = %q, want both registers and SoC", got)
	}
	if got := st.value("SampledDataCtrlr/TxUpdatedInterval"); got != "10" {
		t.Fatalf("TxUpdatedInterval = %q, want 10", got)
	}
	if connector1(s, id).Status != csms.StatusAvailable {
		t.Fatalf("status = %q", connector1(s, id).Status)
	}

	// A 1.6 command to a 2.0.1 station is refused by name (profiles: MP-36).
	if err := s.ClearLimit(context.Background(), id, 1); !errors.Is(err, csms.ErrOCPP201Profiles) {
		t.Fatalf("ClearLimit on 2.0.1 station: %v, want ErrOCPP201Profiles", err)
	}

	// The MP-34 simulator plays the vehicle: 40 % of 60 kWh, charging 11 kW.
	lp, err := ladepunktsim.New(ladepunktsim.Faehigkeit{Nutzbarkeit: ladepunktsim.Bidirektional, V2H: true, LadeleistungKw: 11, RueckspeiseleistungKw: 10}, next())
	if err != nil {
		t.Fatal(err)
	}
	if err := lp.Anstecken(ladepunktsim.Fahrzeug{KapazitaetKwh: 60, SocPct: 40, MindestSocPct: 20, AbfahrtSocPct: 80, MaxLadeKw: 11, MaxEntladeKw: 10}); err != nil {
		t.Fatal(err)
	}
	// Some earlier feed-back so Z2E is a non-zero register.
	_ = lp.Befehlen(ladepunktsim.Befehl{Richtung: ladepunktsim.Entladen, LeistungKw: 5})
	lp.Schritt(30*time.Minute, ladepunktsim.Umgebung{HauslastKw: 6})

	if _, err := cs.StatusNotification(types.NewDateTime(next()), availability.ConnectorStatusOccupied, 1, 1); err != nil {
		t.Fatal(err)
	}
	evse := &types.EVSE{ID: 1}
	startMeter := lp.Messung()
	// E02: cable first, Started WITHOUT idToken -> no session yet.
	if _, err := cs.TransactionEvent(transactions.TransactionEventStarted, types.NewDateTime(next()), transactions.TriggerReasonCablePluggedIn, 0,
		transactions.Transaction{TransactionID: "tx-201-a", ChargingState: transactions.ChargingStateEVConnected},
		func(r *transactions.TransactionEventRequest) {
			r.Evse = evse
			r.MeterValue = messwerte(startMeter, types.ReadingContextTransactionBegin, next())
		}); err != nil {
		t.Fatal(err)
	}
	if con := connector1(s, id); con.Session != nil || con.Status != csms.StatusPreparing {
		t.Fatalf("before authorization: session=%+v status=%q", con.Session, con.Status)
	}

	// The idToken arrives: the session opens with the Started register.
	resp, err := cs.TransactionEvent(transactions.TransactionEventUpdated, types.NewDateTime(next()), transactions.TriggerReasonAuthorized, 1,
		transactions.Transaction{TransactionID: "tx-201-a"},
		func(r *transactions.TransactionEventRequest) {
			r.IDToken = &types.IdToken{IdToken: "KARTE-201", Type: types.IdTokenTypeISO14443}
		})
	if err != nil || resp.IDTokenInfo == nil || resp.IDTokenInfo.Status != types.AuthorizationStatusAccepted {
		t.Fatalf("authorized update: %v %+v", err, resp)
	}
	sess := connector1(s, id).Session
	wantStartWh := int(startMeter.ZaehlerVerbrauchKwh*1000 + 0.5)
	if sess == nil || sess.TransactionID != 1 || sess.StationTransactionID != "tx-201-a" || sess.MeterStartWh != wantStartWh || sess.MeterStartUnknown || !strings.HasPrefix(sess.TagRef, "tagref_") {
		t.Fatalf("session = %+v, want tx 1 / tx-201-a / %d Wh", sess, wantStartWh)
	}

	// J02: charging, both registers, power, SoC.
	_ = lp.Befehlen(ladepunktsim.Befehl{Richtung: ladepunktsim.Laden, LeistungKw: 11})
	lp.Schritt(15*time.Minute, ladepunktsim.Umgebung{})
	m := lp.Messung()
	if _, err := cs.TransactionEvent(transactions.TransactionEventUpdated, types.NewDateTime(next()), transactions.TriggerReasonChargingStateChanged, 2,
		transactions.Transaction{TransactionID: "tx-201-a", ChargingState: transactions.ChargingStateCharging},
		func(r *transactions.TransactionEventRequest) {
			r.MeterValue = messwerte(m, types.ReadingContextSamplePeriodic, next())
		}); err != nil {
		t.Fatal(err)
	}
	con := connector1(s, id)
	if con.Status != csms.StatusCharging || con.PowerKw == nil || *con.PowerKw != m.LeistungBezugKw ||
		con.EnergyKwh == nil || abs(*con.EnergyKwh-m.ZaehlerVerbrauchKwh) > 1e-9 || con.SocPct == nil || *con.SocPct != *m.SocPct {
		t.Fatalf("connector after charging update: status %q power %v energy %v soc %v, want %+v soc %v",
			con.Status, deref(con.PowerKw), deref(con.EnergyKwh), deref(con.SocPct), m, deref(m.SocPct))
	}
	// Z2E reaches the measurement runtime untouched, as for 1.6.
	if v, unit, ok := sink.last("Energy.Active.Export.Register"); !ok || unit != "kWh" || v != fmt.Sprint(m.ZaehlerErzeugungKwh) || m.ZaehlerErzeugungKwh <= 0 {
		t.Fatalf("export register sample = %q %q %v, want %v kWh", v, unit, ok, m.ZaehlerErzeugungKwh)
	}

	// Socket lost: connected goes false, the recorded session stays.
	drop()
	waitFor(t, "disconnect seen", func() bool { c, _ := charger(s, id); return !c.Connected })
	if connector1(s, id).Session == nil {
		t.Fatal("a dropped socket must keep the recorded session")
	}

	// Reconnect: same transaction continues on the same internal session.
	cs2, _ := connect201(t, endpoint, id, st)
	boot201(t, cs2)
	lp.Schritt(5*time.Minute, ladepunktsim.Umgebung{})
	m = lp.Messung()
	if _, err := cs2.TransactionEvent(transactions.TransactionEventUpdated, types.NewDateTime(next()), transactions.TriggerReasonMeterValuePeriodic, 3,
		transactions.Transaction{TransactionID: "tx-201-a", ChargingState: transactions.ChargingStateCharging},
		func(r *transactions.TransactionEventRequest) {
			r.MeterValue = messwerte(m, types.ReadingContextSamplePeriodic, next())
		}); err != nil {
		t.Fatal(err)
	}
	con = connector1(s, id)
	if con.Session == nil || con.Session.TransactionID != 1 || con.Session.Reconciling || abs(*con.EnergyKwh-m.ZaehlerVerbrauchKwh) > 1e-9 {
		t.Fatalf("after reconnect: %+v", con)
	}
	cs2.Stop()

	// Box restart mid-session: the station's transactionId was persisted.
	stopServer()
	s2, endpoint2 := newServer201(t, dir, sink) // the allowlist is persisted
	t.Cleanup(s2.Stop)
	if con := connector1(s2, id); con.Session == nil || con.Session.StationTransactionID != "tx-201-a" || !con.Session.Reconciling {
		t.Fatalf("restored session = %+v", con.Session)
	}
	cs3, _ := connect201(t, endpoint2, id, st)
	boot201(t, cs3)
	lp.Schritt(5*time.Minute, ladepunktsim.Umgebung{})
	m = lp.Messung()
	if _, err := cs3.TransactionEvent(transactions.TransactionEventUpdated, types.NewDateTime(next()), transactions.TriggerReasonMeterValuePeriodic, 4,
		transactions.Transaction{TransactionID: "tx-201-a", ChargingState: transactions.ChargingStateCharging},
		func(r *transactions.TransactionEventRequest) {
			r.MeterValue = messwerte(m, types.ReadingContextSamplePeriodic, next())
		}); err != nil {
		t.Fatal(err)
	}
	if con := connector1(s2, id); con.Session == nil || con.Session.TransactionID != 1 || con.Session.Reconciling {
		t.Fatalf("after box restart: %+v", con.Session)
	}

	// Ended (E06) with the final registers; cable still in -> Finishing.
	if _, err := cs3.StatusNotification(types.NewDateTime(next()), availability.ConnectorStatusOccupied, 1, 1); err != nil {
		t.Fatal(err)
	}
	m = lp.Messung()
	if _, err := cs3.TransactionEvent(transactions.TransactionEventEnded, types.NewDateTime(next()), transactions.TriggerReasonStopAuthorized, 5,
		transactions.Transaction{TransactionID: "tx-201-a", StoppedReason: transactions.ReasonLocal},
		func(r *transactions.TransactionEventRequest) {
			r.MeterValue = messwerte(m, types.ReadingContextTransactionEnd, next())
		}); err != nil {
		t.Fatal(err)
	}
	con = connector1(s2, id)
	if con.Session != nil || con.Status != csms.StatusFinishing || con.PowerKw != nil {
		t.Fatalf("after Ended: %+v", con)
	}
	if _, err := cs3.StatusNotification(types.NewDateTime(next()), availability.ConnectorStatusAvailable, 1, 1); err != nil {
		t.Fatal(err)
	}
	if con := connector1(s2, id); con.Status != csms.StatusAvailable {
		t.Fatalf("after unplug: %q", con.Status)
	}

	// J01 outside a transaction still updates the register.
	lp.Schritt(time.Minute, ladepunktsim.Umgebung{})
	if _, err := cs3.MeterValues(1, messwerte(lp.Messung(), types.ReadingContextSamplePeriodic, next())); err != nil {
		t.Fatal(err)
	}

	// Device Model: base report (B07), get/set (B05/B06).
	reqID, status, err := s2.RequestBaseReport201(context.Background(), id, string(provisioning.ReportTypeConfigurationInventory))
	if err != nil || status != "Accepted" || reqID < 1 {
		t.Fatalf("base report: %d %q %v", reqID, status, err)
	}
	waitFor(t, "notify report stored", func() bool { return s2.DeviceModel201(id)["EVSE@1/Power/MaxSet"] == "11000" })
	if got := s2.DeviceModel201(id)["SampledDataCtrlr/TxUpdatedInterval"]; got != "10" {
		t.Fatalf("reported interval %q", got)
	}
	vals, err := s2.GetVariables201(context.Background(), id, []csms.VariableRef201{
		{Component: "SampledDataCtrlr", Variable: "TxUpdatedInterval"}, {Component: "SampledDataCtrlr", Variable: "Gibtsnicht"}})
	if err != nil || len(vals) != 2 || vals[0].Status != "Accepted" || vals[0].Value != "10" || vals[1].Status != "UnknownVariable" {
		t.Fatalf("get variables: %+v %v", vals, err)
	}
	set, err := s2.SetVariables201(context.Background(), id, []csms.VariableSet201{{VariableRef201: csms.VariableRef201{Component: "SampledDataCtrlr", Variable: "TxUpdatedInterval"}, Value: "15"}})
	if err != nil || len(set) != 1 || set[0].Status != "Accepted" || st.value("SampledDataCtrlr/TxUpdatedInterval") != "15" {
		t.Fatalf("set variables: %+v %v", set, err)
	}
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// TestOCPP201StartWithoutRegisterIsUnknownNotZero: a station that opens the
// transaction without Energy.Active.Import.Register gives an UNKNOWN start,
// never 0 Wh (the session's delivered energy would otherwise be the register).
func TestOCPP201StartWithoutRegisterIsUnknownNotZero(t *testing.T) {
	const id = "WB-201-OHNE"
	s, endpoint := newServer201(t, t.TempDir(), nil, id)
	t.Cleanup(s.Stop)
	st := newStation201()
	cs, _ := connect201(t, endpoint, id, st)
	boot201(t, cs)
	if _, err := cs.TransactionEvent(transactions.TransactionEventStarted, types.NewDateTime(time.Now()), transactions.TriggerReasonAuthorized, 0,
		transactions.Transaction{TransactionID: "tx-ohne", ChargingState: transactions.ChargingStateCharging},
		func(r *transactions.TransactionEventRequest) {
			r.Evse = &types.EVSE{ID: 1}
			r.IDToken = &types.IdToken{IdToken: "", Type: types.IdTokenTypeNoAuthorization}
		}); err != nil {
		t.Fatal(err)
	}
	sess := connector1(s, id).Session
	if sess == nil || !sess.MeterStartUnknown || sess.MeterStartWh != 0 || sess.TagRef != "" {
		t.Fatalf("session = %+v, want unknown start and no card pseudonym", sess)
	}
}

// TestOCPP201StationThatRefusesMeasurandsGetsTheImportList: a unidirectional
// station without export register/SoC rejects the full list and keeps the
// import-only one; the read-back says what it holds.
func TestOCPP201StationThatRefusesMeasurandsGetsTheImportList(t *testing.T) {
	const id = "WB-201-UNI"
	s, endpoint := newServer201(t, t.TempDir(), nil, id)
	t.Cleanup(s.Stop)
	st := newStation201()
	st.refuse["Energy.Active.Export.Register"] = true
	st.refuse["SoC"] = true
	cs, _ := connect201(t, endpoint, id, st)
	boot201(t, cs)
	if _, err := cs.Heartbeat(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "metering configured", func() bool { _, ok := s.Metering201(id); return ok })
	m, _ := s.Metering201(id)
	if m.Status != "partial" || m.Values["TxUpdatedMeasurands"] != "Energy.Active.Import.Register,Power.Active.Import" ||
		m.Values["TxStartedMeasurands"] != "Energy.Active.Import.Register" || m.Values["TxUpdatedInterval"] != "10" {
		t.Fatalf("metering = %+v", m)
	}
}

// TestOneEndpointServesBothProtocols: the box keeps ONE port and path; the
// handshake decides. A 1.6 and a 2.0.1 station are connected at the same time,
// the station's first supported offer wins, an unregistered id is refused on
// either protocol, and an unknown subprotocol is still closed as before.
func TestOneEndpointServesBothProtocols(t *testing.T) {
	s, endpoint := newServer201(t, t.TempDir(), nil, "CP-16", "CP-201", "CP-PREF")
	t.Cleanup(s.Stop)

	cp16, _ := connectCP(t, endpoint, "CP-16")
	if _, err := cp16.BootNotification("Model-16", "Vendor-16"); err != nil {
		t.Fatal(err)
	}
	cs201, _ := connect201(t, endpoint, "CP-201", newStation201())
	boot201(t, cs201)
	waitFor(t, "both connected", func() bool {
		a, _ := charger(s, "CP-16")
		b, _ := charger(s, "CP-201")
		return a.Connected && a.OCPPVersion == "" && b.Connected && b.OCPPVersion == csms.OCPPVersion201
	})

	dial := func(id string, protos ...string) (string, int, error) {
		d := websocket.Dialer{Subprotocols: protos, HandshakeTimeout: 2 * time.Second}
		conn, resp, err := d.Dial(endpoint+"/"+id, http.Header{})
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		if err != nil {
			return "", code, err
		}
		defer conn.Close()
		return resp.Header.Get("Sec-WebSocket-Protocol"), code, nil
	}
	// A station offering both keeps 1.6, whatever its order (Bestandsschutz:
	// before MP-35 it got 1.6, and 2.0.1 has no profiles until MP-36).
	for _, offer := range [][]string{{"ocpp2.0.1", "ocpp1.6"}, {"ocpp1.6", "ocpp2.0.1"}} {
		if got, _, err := dial("CP-PREF", offer...); err != nil || got != "ocpp1.6" {
			t.Fatalf("offer %v: %q %v, want ocpp1.6", offer, got, err)
		}
		waitFor(t, "CP-PREF gone", func() bool { _, live := charger(s, "CP-PREF"); return live })
	}
	if got, _, err := dial("CP-PREF", "ocpp2.0.1"); err != nil || got != "ocpp2.0.1" {
		t.Fatalf("offer 2.0.1 only: %q %v", got, err)
	}
	for _, proto := range []string{"ocpp1.6", "ocpp2.0.1"} {
		if _, code, err := dial("FREMD", proto); err == nil || code != http.StatusUnauthorized {
			t.Fatalf("unregistered %s: code %d err %v, want 401", proto, code, err)
		}
	}
	// Bestand: no supported subprotocol -> upgraded, then closed with a
	// protocol error, exactly as the 1.6-only server did.
	d := websocket.Dialer{Subprotocols: []string{"ocpp1.5"}, HandshakeTimeout: 2 * time.Second}
	conn, _, err := d.Dial(endpoint+"/CP-PREF", http.Header{})
	if err != nil {
		t.Fatalf("unknown subprotocol dial: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	var ce *websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.CloseProtocolError {
		t.Fatalf("unknown subprotocol: %v, want close 1002", err)
	}
	conn.Close()

	// Device Model calls refuse a 1.6 station by name.
	if _, err := s.GetVariables201(context.Background(), "CP-16", nil); !errors.Is(err, csms.ErrNotOCPP201) {
		t.Fatalf("GetVariables201 on 1.6: %v", err)
	}
	// Both still talk.
	if _, err := cp16.Heartbeat(); err != nil {
		t.Fatalf("1.6 heartbeat: %v", err)
	}
	if _, err := cs201.Heartbeat(); err != nil {
		t.Fatalf("2.0.1 heartbeat: %v", err)
	}
}
