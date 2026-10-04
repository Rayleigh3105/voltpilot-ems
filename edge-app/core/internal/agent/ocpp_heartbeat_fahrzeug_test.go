package agent

// MiSpeL MP-37b: the plugged vehicle reaches the cloud - whether it transfers
// bidirectionally (ev_needs.bidirectional, OCPP 2.1) and its state of charge
// with its own clock. Contract: docs/contracts/v2/mispel-ladepunkt-bidirektional.md
// § 5b; the vectors are shared with the cloud's ChargerApiTest.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ladepunktsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const fahrzeugVectors = "../../../../docs/contracts/v2/mispel-ladepunkt-fahrzeug-vectors.json"

// fahrzeugKeys are the heartbeat keys this contract owns; every other key of
// the connector entry belongs to older contracts.
var fahrzeugKeys = []string{"bidirectional", "soc_pct", "soc_measured_at"}

func TestTheVehicleReportFollowsTheSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(fahrzeugVectors)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Jetzt  time.Time `json:"jetzt"`
		Faelle []struct {
			Name string                     `json:"name"`
			Box  *csms.Connector            `json:"box"`
			Edge map[string]json.RawMessage `json:"edge"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, f := range doc.Faelle {
		if f.Box == nil {
			continue // a payload only the cloud's intake knows
		}
		ran++
		t.Run(f.Name, func(t *testing.T) {
			soc, at := ocppVehicleSoc(*f.Box, doc.Jetzt)
			con := state.OcppConnector{ID: 1, SocPct: soc, Bidirectional: ocppVehicleBidirectional(*f.Box)}
			if !at.IsZero() {
				con.SocMeasuredAtMs = at.UnixMilli()
			}
			entry := chargerEntry(state.OcppCharger{ID: "saeule-1", Connectors: []state.OcppConnector{con}})
			b, err := json.Marshal(entry.Connectors[0])
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatal(err)
			}
			for _, k := range fahrzeugKeys {
				want, wantOK := f.Edge[k]
				have, haveOK := got[k]
				if wantOK != haveOK {
					t.Fatalf("%s: present = %v, want %v (%s)", k, haveOK, wantOK, b)
				}
				if wantOK && !sameJSON(t, want, have) {
					t.Fatalf("%s = %s, want %s", k, have, want)
				}
			}
		})
	}
	if ran < 6 {
		t.Fatalf("only %d box cases ran - the vector file lost its cases", ran)
	}
}

func sameJSON(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		t.Fatalf("unreadable JSON %s / %s", a, b)
	}
	xb, _ := json.Marshal(x)
	yb, _ := json.Marshal(y)
	return string(xb) == string(yb)
}

// End to end on the simulator: a 2.1 station with the MP-34 vehicle
// (ladepunktsim) and a 1.6 station share one box. The heartbeat carries the
// 2.1 vehicle's BPT mode and its SoC; the 1.6 plug carries NO bidirectional
// key - unknown, not "no"; unplugging the 2.1 vehicle takes the statement
// away again. Simulator evidence is not a hardware test bench.
func TestTheHeartbeatCarriesTheBidirectionalVehicleAndItsStateOfCharge(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	alt := ocppStation(t, a, "saeule-16", 1, 22)
	if err := alt.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ocpp.srv.Add(csmsAdd("saeule-21", 1, 11)); err != nil {
		t.Fatal(err)
	}
	st := dial21(t, ocppEndpoint(a), "saeule-21")
	boot := st.callOK("BootNotification", map[string]any{"reason": "PowerUp",
		"chargingStation": map[string]string{"model": "V2X-Box", "vendorName": "Testclient21"}})
	if boot["status"] != "Accepted" {
		t.Fatalf("boot: %v", boot)
	}
	waitUntil(t, "the 2.1 station is on the 2.1 lane", func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID("saeule-21")
		return ok && c.Connected && c.OCPPVersion == csms.OCPPVersion21
	})
	now := time.Now()
	st.callOK("StatusNotification", map[string]any{"timestamp": ts21(now), "connectorStatus": "Occupied", "evseId": 1, "connectorId": 1})
	st.callOK("TransactionEvent", map[string]any{"eventType": "Started", "timestamp": ts21(now), "triggerReason": "Authorized",
		"seqNo": 0, "transactionInfo": map[string]any{"transactionId": "tx-37b", "chargingState": "EVConnected"},
		"evse": map[string]int{"id": 1, "connectorId": 1}, "idToken": map[string]string{"idToken": "KARTE-37B", "type": "ISO14443"}})

	v := ladepunktsim.Fahrzeug{KapazitaetKwh: 60, SocPct: 40, MindestSocPct: 20, AbfahrtSocPct: 80, MaxLadeKw: 11, MaxEntladeKw: 10}
	needs := st.callOK("NotifyEVChargingNeeds", map[string]any{"evseId": 1, "timestamp": ts21(time.Now()), "chargingNeeds": map[string]any{
		"requestedEnergyTransfer": "DC_BPT", "availableEnergyTransfer": []string{"DC", "DC_BPT"}, "controlMode": "DynamicControl",
		"v2xChargingParameters": map[string]any{"maxChargePower": v.MaxLadeKw * 1000, "maxDischargePower": v.MaxEntladeKw * 1000, "targetSoC": v.AbfahrtSocPct},
		"dcChargingParameters":  map[string]any{"evMaxCurrent": 125, "evMaxVoltage": 450, "evEnergyCapacity": v.KapazitaetKwh * 1000, "stateOfCharge": v.SocPct},
	}})
	if needs["status"] != "NoChargingProfile" {
		t.Fatalf("NotifyEVChargingNeeds answered %v", needs)
	}
	waitUntil(t, "the vehicle report reached the connector", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("saeule-21")
		return len(c.Connectors) > 0 && c.Connectors[0].EV != nil
	})

	plugs := heartbeatPlugs(t, a)
	v21 := plugs["saeule-21"]
	if string(v21["bidirectional"]) != "true" {
		t.Fatalf("2.1 BPT vehicle: bidirectional = %s, want true (%v)", v21["bidirectional"], v21)
	}
	if string(v21["soc_pct"]) != "40" {
		t.Fatalf("2.1 vehicle: soc_pct = %s, want the simulator's 40", v21["soc_pct"])
	}
	var socAt string
	if err := json.Unmarshal(v21["soc_measured_at"], &socAt); err != nil {
		t.Fatalf("soc_measured_at = %s: %v", v21["soc_measured_at"], err)
	}
	if at, err := time.Parse(time.RFC3339, socAt); err != nil || time.Since(at) > time.Minute {
		t.Fatalf("soc_measured_at = %q: the SoC must carry its own, current clock", socAt)
	}
	for _, k := range fahrzeugKeys {
		if _, ok := plugs["saeule-16"][k]; ok {
			t.Fatalf("1.6 plug carries %q = %s - unknown must stay absent", k, plugs["saeule-16"][k])
		}
	}

	st.callOK("TransactionEvent", map[string]any{"eventType": "Ended", "timestamp": ts21(time.Now()), "triggerReason": "EVDeparted",
		"seqNo": 1, "transactionInfo": map[string]any{"transactionId": "tx-37b", "stoppedReason": "EVDisconnected"},
		"evse": map[string]int{"id": 1, "connectorId": 1}})
	st.callOK("StatusNotification", map[string]any{"timestamp": ts21(time.Now()), "connectorStatus": "Available", "evseId": 1, "connectorId": 1})
	waitUntil(t, "the vehicle report is gone with the vehicle", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("saeule-21")
		return len(c.Connectors) > 0 && c.Connectors[0].EV == nil
	})
	for _, k := range fahrzeugKeys {
		if _, ok := heartbeatPlugs(t, a)["saeule-21"][k]; ok {
			t.Fatalf("free plug still carries %q - the next vehicle is another one", k)
		}
	}
}

// heartbeatPlugs serializes the heartbeat block and returns plug 1 of every
// station, as the cloud receives it.
func heartbeatPlugs(t *testing.T, a *Agent) map[string]map[string]json.RawMessage {
	t.Helper()
	a.ocppStep(context.Background())
	raw, err := json.Marshal(a.chargersSummary())
	if err != nil {
		t.Fatal(err)
	}
	var sum struct {
		Chargers []struct {
			ID         string                       `json:"id"`
			Connectors []map[string]json.RawMessage `json:"connectors"`
		} `json:"chargers"`
	}
	if err := json.Unmarshal(raw, &sum); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]json.RawMessage{}
	for _, c := range sum.Chargers {
		if len(c.Connectors) > 0 {
			out[c.ID] = c.Connectors[0]
		}
	}
	return out
}

func ts21(at time.Time) string { return at.UTC().Format(time.RFC3339) }

// station21 is a raw OCPP-J 2.1 test client (ocpp-go has no 2.1 client), the
// same shape as the csms package's own: it answers the box's Device Model and
// profile calls and nothing else.
type station21 struct {
	t       *testing.T
	conn    *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	waiting map[string]chan []json.RawMessage
}

func dial21(t *testing.T, endpoint, id string) *station21 {
	t.Helper()
	d := websocket.Dialer{Subprotocols: []string{"ocpp2.1"}, HandshakeTimeout: 2 * time.Second}
	var conn *websocket.Conn
	for deadline := time.Now().Add(5 * time.Second); ; {
		c, resp, err := d.Dial(endpoint+"/"+id, http.Header{})
		if err == nil {
			if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "ocpp2.1" {
				t.Fatalf("negotiated %q, want ocpp2.1", got)
			}
			conn = c
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("dial 2.1: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	st := &station21{t: t, conn: conn, waiting: map[string]chan []json.RawMessage{}}
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

func (st *station21) answer(id, action string, payload json.RawMessage) {
	type ref struct {
		Component struct {
			Name string `json:"name"`
		} `json:"component"`
		Variable struct {
			Name string `json:"name"`
		} `json:"variable"`
	}
	switch action {
	case "SetVariables", "GetVariables":
		var req struct {
			Set []ref `json:"setVariableData"`
			Get []ref `json:"getVariableData"`
		}
		_ = json.Unmarshal(payload, &req)
		status, key, list := "Accepted", "setVariableResult", req.Set
		if action == "GetVariables" {
			status, key, list = "UnknownVariable", "getVariableResult", req.Get
		}
		out := []map[string]any{}
		for _, v := range list {
			out = append(out, map[string]any{"attributeStatus": status,
				"component": map[string]string{"name": v.Component.Name}, "variable": map[string]string{"name": v.Variable.Name}})
		}
		st.write([]any{3, id, map[string]any{key: out}})
	case "SetChargingProfile":
		st.write([]any{3, id, map[string]string{"status": "Accepted"}})
	default:
		st.write([]any{4, id, "NotImplemented", "", map[string]any{}})
	}
}

func (st *station21) callOK(action string, payload any) map[string]any {
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
		if string(f[0]) != "3" {
			st.t.Fatalf("%s: box answered with CALLERROR %s", action, f)
		}
		var out map[string]any
		_ = json.Unmarshal(f[2], &out)
		return out
	case <-time.After(3 * time.Second):
		st.t.Fatalf("%s: no answer from the box", action)
		return nil
	}
}
