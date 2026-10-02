package csms_test

// MiSpeL MP-37: the OCPP 2.1 lane. ocpp-go has no 2.1 client, so the station
// here is a raw OCPP-J 2.1 test client (gorilla websocket, 2.1 JSON shapes)
// that answers the box's calls itself; the vehicle behind it is the MP-34
// simulator (ladepunktsim). Simulator evidence is not a hardware test bench:
// the test with a real V2X wallbox stays open (Bauplan § 8, MP-37/MP-42).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ladepunktsim"
)

type station21 struct {
	t    *testing.T
	conn *websocket.Conn

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	vars    map[string]string
	waiting map[string]chan []json.RawMessage
	// profiles are the SetChargingProfile payloads the box sent; the
	// station answers each with profileStatus.
	profiles      []json.RawMessage
	profileStatus string
}

func connect21(t *testing.T, endpoint, id string) *station21 {
	t.Helper()
	d := websocket.Dialer{Subprotocols: []string{"ocpp2.1"}, HandshakeTimeout: 2 * time.Second}
	conn, resp, err := d.Dial(endpoint+"/"+id, http.Header{})
	if err != nil {
		t.Fatalf("dial 2.1: %v", err)
	}
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "ocpp2.1" {
		t.Fatalf("negotiated %q, want ocpp2.1", got)
	}
	st := &station21{t: t, conn: conn, vars: map[string]string{}, waiting: map[string]chan []json.RawMessage{},
		profileStatus: "Accepted"}
	go st.read()
	t.Cleanup(func() { _ = conn.Close() })
	return st
}

func (st *station21) write(frame any) {
	b, _ := json.Marshal(frame)
	st.writeMu.Lock()
	defer st.writeMu.Unlock()
	_ = st.conn.WriteMessage(websocket.TextMessage, b)
}

func (st *station21) read() {
	for {
		_, data, err := st.conn.ReadMessage()
		if err != nil {
			return
		}
		var frame []json.RawMessage
		if json.Unmarshal(data, &frame) != nil || len(frame) < 3 {
			continue
		}
		var id string
		_ = json.Unmarshal(frame[1], &id)
		switch string(frame[0]) {
		case "3", "4":
			st.mu.Lock()
			ch := st.waiting[id]
			delete(st.waiting, id)
			st.mu.Unlock()
			if ch != nil {
				ch <- frame
			}
		case "2":
			var action string
			_ = json.Unmarshal(frame[2], &action)
			st.answer(id, action, frame[3])
		}
	}
}

// answer plays the station side of the box's calls: Device Model values are
// kept and read back, SetChargingProfile is recorded and answered.
func (st *station21) answer(id, action string, payload json.RawMessage) {
	type ref struct {
		Component struct {
			Name string `json:"name"`
		} `json:"component"`
		Variable struct {
			Name string `json:"name"`
		} `json:"variable"`
		AttributeValue string `json:"attributeValue"`
	}
	switch action {
	case "SetVariables":
		var req struct {
			SetVariableData []ref `json:"setVariableData"`
		}
		_ = json.Unmarshal(payload, &req)
		var out []map[string]any
		st.mu.Lock()
		for _, v := range req.SetVariableData {
			st.vars[v.Component.Name+"/"+v.Variable.Name] = v.AttributeValue
			out = append(out, map[string]any{"attributeStatus": "Accepted",
				"component": map[string]string{"name": v.Component.Name}, "variable": map[string]string{"name": v.Variable.Name}})
		}
		st.mu.Unlock()
		st.write([]any{3, id, map[string]any{"setVariableResult": out}})
	case "GetVariables":
		var req struct {
			GetVariableData []ref `json:"getVariableData"`
		}
		_ = json.Unmarshal(payload, &req)
		var out []map[string]any
		st.mu.Lock()
		for _, v := range req.GetVariableData {
			r := map[string]any{"component": map[string]string{"name": v.Component.Name}, "variable": map[string]string{"name": v.Variable.Name}}
			if val, ok := st.vars[v.Component.Name+"/"+v.Variable.Name]; ok {
				r["attributeStatus"], r["attributeValue"] = "Accepted", val
			} else {
				r["attributeStatus"] = "UnknownVariable"
			}
			out = append(out, r)
		}
		st.mu.Unlock()
		st.write([]any{3, id, map[string]any{"getVariableResult": out}})
	case "SetChargingProfile":
		st.mu.Lock()
		st.profiles = append(st.profiles, payload)
		status := st.profileStatus
		st.mu.Unlock()
		st.write([]any{3, id, map[string]string{"status": status}})
	default:
		st.write([]any{4, id, "NotImplemented", "", map[string]any{}})
	}
}

// call sends one CALL and returns the box's answer frame (CALLRESULT or
// CALLERROR).
func (st *station21) call(action string, payload any) []json.RawMessage {
	st.t.Helper()
	st.mu.Lock()
	st.nextID++
	id := "st21-" + strconv.Itoa(st.nextID)
	ch := make(chan []json.RawMessage, 1)
	st.waiting[id] = ch
	st.mu.Unlock()
	st.write([]any{2, id, action, payload})
	select {
	case f := <-ch:
		return f
	case <-time.After(3 * time.Second):
		st.t.Fatalf("%s: no answer from the box", action)
		return nil
	}
}

func (st *station21) callOK(action string, payload any) map[string]any {
	st.t.Helper()
	f := st.call(action, payload)
	if string(f[0]) != "3" {
		st.t.Fatalf("%s: box answered with CALLERROR %s", action, f)
	}
	var out map[string]any
	_ = json.Unmarshal(f[2], &out)
	return out
}

func (st *station21) sentProfiles() []json.RawMessage {
	st.mu.Lock()
	defer st.mu.Unlock()
	return append([]json.RawMessage(nil), st.profiles...)
}

func newServer21(t *testing.T, discharge bool, ids ...string) (*csms.Server, string) {
	t.Helper()
	s, err := csms.New(csms.Options{Enabled: true, DataDir: t.TempDir(), Log: quiet(), V2XDischarge: discharge})
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
	t.Cleanup(s.Stop)
	snap := s.Snapshot()
	return s, fmt.Sprintf("ws://127.0.0.1:%d%s", snap.Port, snap.URLPath)
}

func ts(at time.Time) string { return at.UTC().Format(time.RFC3339) }

// plugIn21 boots a 2.1 station and opens a session on EVSE 1 with a 2.1
// TransactionEvent (station transactionId "tx-21").
func plugIn21(t *testing.T, s *csms.Server, st *station21, id string) {
	t.Helper()
	boot := st.callOK("BootNotification", map[string]any{"reason": "PowerUp",
		"chargingStation": map[string]string{"model": "V2X-Box", "vendorName": "Testclient21"}})
	if boot["status"] != "Accepted" {
		t.Fatalf("boot: %v", boot)
	}
	waitFor(t, "2.1 connected", func() bool {
		c, _ := charger(s, id)
		return c.Connected && c.OCPPVersion == csms.OCPPVersion21
	})
	now := time.Now()
	st.callOK("StatusNotification", map[string]any{"timestamp": ts(now), "connectorStatus": "Occupied", "evseId": 1, "connectorId": 1})
	waitFor(t, "metering configured over the Device Model", func() bool {
		m, ok := s.Metering201(id)
		return ok && m.Status == "confirmed"
	})
	resp := st.callOK("TransactionEvent", map[string]any{"eventType": "Started", "timestamp": ts(now), "triggerReason": "Authorized",
		"seqNo": 0, "transactionInfo": map[string]any{"transactionId": "tx-21", "chargingState": "EVConnected"},
		"evse": map[string]int{"id": 1, "connectorId": 1}, "idToken": map[string]string{"idToken": "KARTE-21", "type": "ISO14443"},
		"meterValue": []any{map[string]any{"timestamp": ts(now), "sampledValue": []any{
			map[string]any{"value": 1000, "measurand": "Energy.Active.Import.Register", "context": "Transaction.Begin", "unitOfMeasure": map[string]any{"unit": "Wh"}}}}}})
	if info, _ := resp["idTokenInfo"].(map[string]any); info["status"] != "Accepted" {
		t.Fatalf("Started: %v", resp)
	}
	waitFor(t, "session open", func() bool {
		con := connector1(s, id)
		return con.Session != nil && con.Session.StationTransactionID == "tx-21"
	})
}

// TestOCPP21NegotiatesAndReportsISO15118Data: a station offering only
// ocpp2.1 lands on the 2.1 lane; one offering 2.0.1 as well keeps 2.0.1
// (Bestandsschutz, as 1.6 before it). The vehicle's ISO 15118-20 data from
// NotifyEVChargingNeeds land on the connector in the box's units, a 2.1-only
// trigger reason does not cost the meter values, and unplugging clears them.
func TestOCPP21NegotiatesAndReportsISO15118Data(t *testing.T) {
	const id = "CP-21"
	s, endpoint := newServer21(t, false, id, "CP-PREF")

	dial := func(protos ...string) string {
		d := websocket.Dialer{Subprotocols: protos, HandshakeTimeout: 2 * time.Second}
		conn, resp, err := d.Dial(endpoint+"/CP-PREF", http.Header{})
		if err != nil {
			t.Fatalf("dial %v: %v", protos, err)
		}
		defer conn.Close()
		got := resp.Header.Get("Sec-WebSocket-Protocol")
		_ = conn.Close()
		waitFor(t, "CP-PREF gone", func() bool { c, _ := charger(s, "CP-PREF"); return !c.Connected })
		return got
	}
	for _, c := range []struct {
		offer []string
		want  string
	}{
		{[]string{"ocpp2.1"}, "ocpp2.1"},
		{[]string{"ocpp2.1", "ocpp2.0.1"}, "ocpp2.0.1"},
		{[]string{"ocpp2.0.1", "ocpp2.1"}, "ocpp2.0.1"},
		{[]string{"ocpp2.1", "ocpp1.6"}, "ocpp1.6"},
		{[]string{"ocpp2.1", "ocpp2.0.1", "ocpp1.6"}, "ocpp1.6"},
	} {
		if got := dial(c.offer...); got != c.want {
			t.Fatalf("offer %v: negotiated %q, want %q", c.offer, got, c.want)
		}
	}

	st := connect21(t, endpoint, id)
	plugIn21(t, s, st, id)

	// The MP-34 vehicle: 40 % of 60 kWh, reserve 20 %, 80 % at departure,
	// 11 kW charging, 10 kW feeding back - reported over DC_BPT.
	v := ladepunktsim.Fahrzeug{KapazitaetKwh: 60, SocPct: 40, MindestSocPct: 20, AbfahrtSocPct: 80, MaxLadeKw: 11, MaxEntladeKw: 10}
	departure := time.Date(2026, 10, 3, 7, 30, 0, 0, time.UTC)
	needs := st.callOK("NotifyEVChargingNeeds", map[string]any{"evseId": 1, "timestamp": ts(time.Now()), "chargingNeeds": map[string]any{
		"requestedEnergyTransfer": "DC_BPT", "availableEnergyTransfer": []string{"DC", "DC_BPT"},
		"controlMode": "DynamicControl", "departureTime": ts(departure),
		"v2xChargingParameters": map[string]any{
			"maxChargePower": v.MaxLadeKw * 1000, "maxDischargePower": v.MaxEntladeKw * 1000,
			"evTargetEnergyRequest": (v.AbfahrtSocPct - v.SocPct) / 100 * v.KapazitaetKwh * 1000,
			"evMinV2XEnergyRequest": (v.MindestSocPct - v.SocPct) / 100 * v.KapazitaetKwh * 1000,
			"targetSoC":             v.AbfahrtSocPct},
		"dcChargingParameters": map[string]any{"evMaxCurrent": 125, "evMaxVoltage": 450,
			"evEnergyCapacity": v.KapazitaetKwh * 1000, "stateOfCharge": v.SocPct},
	}})
	if needs["status"] != "NoChargingProfile" {
		t.Fatalf("NotifyEVChargingNeeds answered %v, want NoChargingProfile", needs)
	}
	ev := connector1(s, id).EV
	if ev == nil {
		t.Fatal("ISO 15118-20 data did not reach the connector")
	}
	checks := []struct {
		name string
		got  *float64
		want float64
	}{
		{"soc_pct", ev.SocPct, 40}, {"target_soc_pct", ev.TargetSocPct, 80}, {"capacity_kwh", ev.CapacityKwh, 60},
		{"target_energy_kwh", ev.TargetEnergyKwh, 24}, {"min_v2x_energy_kwh", ev.MinV2XEnergyKwh, -12},
		{"max_charge_kw", ev.MaxChargeKw, 11}, {"max_discharge_kw", ev.MaxDischargeKw, 10},
	}
	for _, c := range checks {
		if c.got == nil || abs(*c.got-c.want) > 1e-9 {
			t.Fatalf("%s = %v, want %v", c.name, deref(c.got), c.want)
		}
	}
	if !ev.Bidirectional || ev.EnergyTransfer != "DC_BPT" || ev.ControlMode != "DynamicControl" ||
		ev.DepartureAt == nil || !ev.DepartureAt.Equal(departure) || ev.MinChargeKw != nil || ev.MinEnergyKwh != nil {
		t.Fatalf("ev = %+v", ev)
	}

	// A 2.1-only trigger reason: the event and its meter values still arrive.
	f := st.call("TransactionEvent", map[string]any{"eventType": "Updated", "timestamp": ts(time.Now()), "triggerReason": "OperationModeChanged",
		"seqNo": 1, "transactionInfo": map[string]any{"transactionId": "tx-21", "chargingState": "Charging"},
		"evse": map[string]int{"id": 1, "connectorId": 1},
		"meterValue": []any{map[string]any{"timestamp": ts(time.Now()), "sampledValue": []any{
			map[string]any{"value": 7400, "measurand": "Power.Active.Import", "unitOfMeasure": map[string]any{"unit": "W"}}}}}})
	if string(f[0]) != "3" {
		t.Fatalf("TransactionEvent with 2.1 trigger reason refused: %s", f)
	}
	waitFor(t, "meter value of the 2.1 event", func() bool {
		con := connector1(s, id)
		return con.PowerKw != nil && abs(*con.PowerKw-7.4) < 1e-9 && con.Status == csms.StatusCharging
	})

	// A report the box cannot read is Rejected, the stored one stays.
	if r := st.callOK("NotifyEVChargingNeeds", map[string]any{"evseId": 1, "chargingNeeds": map[string]any{}}); r["status"] != "Rejected" {
		t.Fatalf("empty needs answered %v", r)
	}
	if connector1(s, id).EV == nil {
		t.Fatal("a refused report wiped the stored one")
	}

	st.callOK("TransactionEvent", map[string]any{"eventType": "Ended", "timestamp": ts(time.Now()), "triggerReason": "EVDeparted",
		"seqNo": 2, "transactionInfo": map[string]any{"transactionId": "tx-21", "stoppedReason": "EVDisconnected"},
		"evse": map[string]int{"id": 1, "connectorId": 1}})
	st.callOK("StatusNotification", map[string]any{"timestamp": ts(time.Now()), "connectorStatus": "Available", "evseId": 1, "connectorId": 1})
	waitFor(t, "vehicle data cleared after unplugging", func() bool {
		con := connector1(s, id)
		return con.EV == nil && con.Session == nil
	})
}

// TestOCPP21DischargeSetpointOnlyBehindTheSwitch: the V2X profile (negative
// setpoint) is refused before anything is sent while the switch is off; with
// it on, it reaches the 2.1 station in the 2.1 shape and the station's
// answer is what the box records. A 2.0.1 station never gets one.
func TestOCPP21DischargeSetpointOnlyBehindTheSwitch(t *testing.T) {
	const id = "CP-21"
	ctx := context.Background()

	off, endpointOff := newServer21(t, false, id)
	stOff := connect21(t, endpointOff, id)
	plugIn21(t, off, stOff, id)
	if _, err := off.SetV2XSetpoint21(ctx, id, 1, -3.5); !errors.Is(err, csms.ErrV2XDischargeOff) {
		t.Fatalf("switch off: err = %v, want ErrV2XDischargeOff", err)
	}
	time.Sleep(200 * time.Millisecond)
	if p := stOff.sentProfiles(); len(p) != 0 {
		t.Fatalf("switch off, yet the station got %d profiles: %s", len(p), p)
	}
	if connector1(off, id).V2X != nil {
		t.Fatal("switch off, yet a setpoint is recorded")
	}

	on, endpointOn := newServer21(t, true, id, "CP-201")
	st := connect21(t, endpointOn, id)
	plugIn21(t, on, st, id)
	got, err := on.SetV2XSetpoint21(ctx, id, 1, -3.5)
	if err != nil || got.Status != "Accepted" || got.SetpointKw != -3.5 {
		t.Fatalf("discharge setpoint: %+v %v", got, err)
	}
	sent := st.sentProfiles()
	if len(sent) != 1 {
		t.Fatalf("station got %d profiles, want 1", len(sent))
	}
	var req struct {
		EvseID          int `json:"evseId"`
		ChargingProfile struct {
			ID                     int    `json:"id"`
			ChargingProfilePurpose string `json:"chargingProfilePurpose"`
			TransactionID          string `json:"transactionId"`
			ChargingSchedule       []struct {
				Duration               int    `json:"duration"`
				ChargingRateUnit       string `json:"chargingRateUnit"`
				ChargingSchedulePeriod []struct {
					StartPeriod    int      `json:"startPeriod"`
					OperationMode  string   `json:"operationMode"`
					Setpoint       *float64 `json:"setpoint"`
					DischargeLimit *float64 `json:"dischargeLimit"`
					Limit          *float64 `json:"limit"`
				} `json:"chargingSchedulePeriod"`
			} `json:"chargingSchedule"`
		} `json:"chargingProfile"`
	}
	if err := json.Unmarshal(sent[0], &req); err != nil {
		t.Fatal(err)
	}
	p := req.ChargingProfile
	if req.EvseID != 1 || p.ID != csms.TxProfileID(1) || p.ChargingProfilePurpose != "TxProfile" || p.TransactionID != "tx-21" ||
		len(p.ChargingSchedule) != 1 || p.ChargingSchedule[0].Duration != 120 || p.ChargingSchedule[0].ChargingRateUnit != "W" ||
		len(p.ChargingSchedule[0].ChargingSchedulePeriod) != 1 {
		t.Fatalf("profile shape: %s", sent[0])
	}
	per := p.ChargingSchedule[0].ChargingSchedulePeriod[0]
	if per.OperationMode != "CentralSetpoint" || per.Setpoint == nil || *per.Setpoint != -3500 ||
		per.DischargeLimit == nil || *per.DischargeLimit != -3500 || per.Limit == nil || *per.Limit != 0 {
		t.Fatalf("period: %s", sent[0])
	}
	if v := connector1(on, id).V2X; v == nil || v.Status != "Accepted" || v.SetpointKw != -3.5 {
		t.Fatalf("recorded setpoint: %+v", v)
	}

	// The station's own refusal is what the box records - not the wish.
	st.mu.Lock()
	st.profileStatus = "Rejected"
	st.mu.Unlock()
	if got, err := on.SetV2XSetpoint21(ctx, id, 1, -2); err != nil || got.Status != "Rejected" {
		t.Fatalf("refused setpoint: %+v %v", got, err)
	}
	if v := connector1(on, id).V2X; v == nil || v.Status != "Rejected" || v.SetpointKw != -2 {
		t.Fatalf("recorded refusal: %+v", v)
	}

	// A 2.0.1 station has no setpoint: refused, nothing sent.
	cs201, _ := connect201(t, endpointOn, "CP-201", newStation201())
	boot201(t, cs201)
	waitFor(t, "2.0.1 connected", func() bool { c, _ := charger(on, "CP-201"); return c.Connected })
	if _, err := on.SetV2XSetpoint21(ctx, "CP-201", 1, -3.5); !errors.Is(err, csms.ErrNotOCPP21) {
		t.Fatalf("2.0.1 station: err = %v, want ErrNotOCPP21", err)
	}
}
