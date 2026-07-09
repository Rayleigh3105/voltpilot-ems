package agent

import (
	"encoding/json"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// startTestConnAgent brings up a bus-only agent AND wires the test-read result
// subscription (which the full Start does), so TestConnection round-trips work.
func startTestConnAgent(t *testing.T, cfg config.Config) (*Agent, string) {
	t.Helper()
	a, addr := startBusOnlyAgent(t, cfg)
	if err := a.Bus.Subscribe(localbus.TopicTestReadResult, 5, a.onTestReadResult); err != nil {
		t.Fatalf("subscribe test-read result: %v", err)
	}
	return a, addr
}

// nodeRedStub plays Node-RED: it subscribes edge/test-read/request and answers
// on edge/test-read/result with the request's id and a canned outcome.
func nodeRedStub(t *testing.T, busAddr string, answer func(reqID string) testconn.Result) {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-nodered-stub").
		SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("stub connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	if tok := client.Subscribe(localbus.TopicTestReadRequest, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		var req struct {
			RequestID string `json:"request_id"`
		}
		if json.Unmarshal(msg.Payload(), &req) != nil || req.RequestID == "" {
			return
		}
		res := answer(req.RequestID)
		var out struct {
			RequestID string            `json:"request_id"`
			OK        bool              `json:"ok"`
			ErrorCode string            `json:"error_code,omitempty"`
			Message   string            `json:"message,omitempty"`
			Reading   *testconn.Reading `json:"reading,omitempty"`
		}
		out.RequestID = req.RequestID
		out.OK = res.OK
		out.ErrorCode = res.ErrorCode
		out.Message = res.Message
		out.Reading = res.Reading
		raw, _ := json.Marshal(out)
		client.Publish(localbus.TopicTestReadResult, 1, false, raw)
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("stub subscribe: %v", tok.Error())
	}
}

func fptr(v float64) *float64 { return &v }

// A "Verbindung testen" round-trip: the core publishes the request, Node-RED
// answers with the matching request_id, and TestConnection returns the decoded
// reading correlated to that request.
func TestTestConnectionRoundTripCorrelatesResult(t *testing.T) {
	a, addr := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	nodeRedStub(t, addr, func(reqID string) testconn.Result {
		return testconn.Result{OK: true, Reading: &testconn.Reading{PvKw: fptr(4.8), SocPct: fptr(62)}}
	})

	res := a.TestConnection(testconn.Request{
		Role:       "pv-generation",
		Brand:      "generic_modbus",
		Model:      "sunspec",
		Connection: testconn.Connection{"ip": "192.168.0.70"},
	})
	if !res.OK || res.Reading == nil || res.Reading.PvKw == nil || *res.Reading.PvKw != 4.8 {
		t.Fatalf("round-trip result wrong: %+v", res)
	}
}

// A classified error from Node-RED (e.g. unreachable) is passed through verbatim.
func TestTestConnectionPassesThroughClassifiedError(t *testing.T) {
	a, addr := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	nodeRedStub(t, addr, func(reqID string) testconn.Result {
		return testconn.Result{OK: false, ErrorCode: testconn.ErrUnreachable}
	})

	res := a.TestConnection(testconn.Request{
		Brand: "generic_modbus", Model: "sunspec",
		Connection: testconn.Connection{"ip": "192.168.0.70"},
	})
	if res.OK || res.ErrorCode != testconn.ErrUnreachable {
		t.Fatalf("expected unreachable, got %+v", res)
	}
}

// With no responder the round-trip is bounded and classified as a timeout.
func TestTestConnectionTimesOutWhenNoResponder(t *testing.T) {
	old := testReadTimeout
	testReadTimeout = 250 * time.Millisecond
	t.Cleanup(func() { testReadTimeout = old })

	a, _ := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	start := time.Now()
	res := a.TestConnection(testconn.Request{
		Brand: "generic_modbus", Model: "sunspec",
		Connection: testconn.Connection{"ip": "192.168.0.70"},
	})
	if res.OK || res.ErrorCode != testconn.ErrTimeout {
		t.Fatalf("expected timeout, got %+v", res)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout not bounded: %v", elapsed)
	}
}

// A malformed connection form is rejected before any device I/O with a specific
// German hint (invalid_request), not a timeout.
func TestTestConnectionRejectsInvalidFormWithoutIO(t *testing.T) {
	a, _ := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	// Missing IP -> the catalog normalize refuses it.
	res := a.TestConnection(testconn.Request{
		Brand: "generic_modbus", Model: "sunspec",
		Connection: testconn.Connection{},
	})
	if res.OK || res.ErrorCode != testconn.ErrInvalidRequest || res.Message == "" {
		t.Fatalf("expected invalid_request with a message, got %+v", res)
	}
}
