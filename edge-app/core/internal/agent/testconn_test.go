package agent

import (
	"encoding/json"
	"net/http/httptest"
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
// on edge/test-read/result with the request's id and a canned outcome. The
// answer callback also sees whether the request asked for the multi-inverter
// unit-id probe (probe_units=true).
func nodeRedStub(t *testing.T, busAddr string, answer func(reqID string, probe bool) testconn.Result) {
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
			RequestID  string `json:"request_id"`
			ProbeUnits bool   `json:"probe_units"`
		}
		if json.Unmarshal(msg.Payload(), &req) != nil || req.RequestID == "" {
			return
		}
		res := answer(req.RequestID, req.ProbeUnits)
		var out struct {
			RequestID  string            `json:"request_id"`
			OK         bool              `json:"ok"`
			ErrorCode  string            `json:"error_code,omitempty"`
			Message    string            `json:"message,omitempty"`
			Reading    *testconn.Reading `json:"reading,omitempty"`
			FoundUnits []int             `json:"found_units,omitempty"`
		}
		out.RequestID = req.RequestID
		out.OK = res.OK
		out.ErrorCode = res.ErrorCode
		out.Message = res.Message
		out.Reading = res.Reading
		out.FoundUnits = res.FoundUnits
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
	nodeRedStub(t, addr, func(reqID string, _ bool) testconn.Result {
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
	nodeRedStub(t, addr, func(reqID string, _ bool) testconn.Result {
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

// --- multi-inverter unit-ID probe (ProbeUnits) ---

// The probe round trip: the request carries probe_units=true (so the flow scans
// instead of reading once) and the found unit ids come back correlated.
func TestProbeUnitsRoundTripCarriesFlagAndFoundUnits(t *testing.T) {
	a, addr := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	nodeRedStub(t, addr, func(reqID string, probe bool) testconn.Result {
		if !probe {
			return testconn.Result{OK: false, ErrorCode: testconn.ErrInvalidResponse, Message: "probe_units flag missing"}
		}
		return testconn.Result{OK: true, FoundUnits: []int{1, 2}}
	})

	res := a.ProbeUnits(testconn.Request{
		Brand: "fronius_sunspec", Model: "fronius-eco-27-3-s",
		Connection: testconn.Connection{"ip": "192.168.210.40", "unit_id": 1},
	})
	if !res.OK || len(res.FoundUnits) != 2 || res.FoundUnits[0] != 1 || res.FoundUnits[1] != 2 {
		t.Fatalf("probe round-trip wrong: %+v", res)
	}
}

// The probe only exists for fronius_sunspec: any other transport is refused
// before any I/O (there is no unit-id fan-out to scan).
func TestProbeUnitsRejectsNonSunspecTransport(t *testing.T) {
	a, _ := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	res := a.ProbeUnits(testconn.Request{
		Brand: "generic_modbus", Model: "sunspec",
		Connection: testconn.Connection{"ip": "192.168.0.70"},
	})
	if res.OK || res.ErrorCode != testconn.ErrInvalidRequest || res.Message == "" {
		t.Fatalf("expected invalid_request with a message, got %+v", res)
	}
}

// With no responder the probe is bounded and classified as a timeout.
func TestProbeUnitsTimesOutWhenNoResponder(t *testing.T) {
	old := probeUnitsTimeout
	probeUnitsTimeout = 250 * time.Millisecond
	t.Cleanup(func() { probeUnitsTimeout = old })

	a, _ := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	start := time.Now()
	res := a.ProbeUnits(testconn.Request{
		Brand: "fronius_sunspec", Model: "fronius-eco-27-3-s",
		Connection: testconn.Connection{"ip": "192.168.210.40"},
	})
	if res.OK || res.ErrorCode != testconn.ErrTimeout {
		t.Fatalf("expected timeout, got %+v", res)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout not bounded: %v", elapsed)
	}
}

// The D11 control short-test: a go-e test with control_test=true ADDITIONALLY
// re-writes the charger's current amp value and reads it back - proving the
// write path without changing anything. The check runs in the CORE (the single
// go-e writer), independent of the control flags (the wizard proves the path
// BEFORE arming them); a plain test (no flag) never writes.
func TestTestConnectionGoeControlCheck(t *testing.T) {
	fake := &fakeGoeServer{frc: 2, amp: 10, psm: 2}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	a, addr := startTestConnAgent(t, config.Config{DataDir: t.TempDir()})
	a.goeDoer = goeHTTPDoer{c: srv.Client()}
	nodeRedStub(t, addr, func(reqID string, _ bool) testconn.Result {
		return testconn.Result{OK: true, Reading: &testconn.Reading{LoadKw: fptr(6.9)}}
	})

	req := testconn.Request{
		Role: "consumer", Brand: "go-e", Model: "goe_http_api",
		Connection:  testconn.Connection{"ip": host, "port": float64(port)},
		ControlTest: true,
	}
	res := a.TestConnection(req)
	if !res.OK || res.ControlCheck == nil || !res.ControlCheck.OK {
		t.Fatalf("expected read + confirmed control check, got %+v (check %+v)", res, res.ControlCheck)
	}
	if res.ControlCheck.Key != "amp" || res.ControlCheck.Value != 10 {
		t.Fatalf("the check must re-write the CURRENT amp (10), got %+v", res.ControlCheck)
	}
	// Non-disruptive by construction: the charger state is unchanged.
	if psm, frc, amp := fake.phaseSnapshot(); psm != 2 || frc != 2 || amp != 10 {
		t.Fatalf("control check must change NOTHING: psm=%d frc=%d amp=%d", psm, frc, amp)
	}
	if res.ControlCheck.PhaseSwitchMode == nil || *res.ControlCheck.PhaseSwitchMode != 2 {
		t.Fatalf("the check should surface the phase position, got %+v", res.ControlCheck.PhaseSwitchMode)
	}

	// WITHOUT the flag: byte-identical old behavior - no check, no write.
	before := fake.setCalls
	res2 := a.TestConnection(testconn.Request{
		Role: "consumer", Brand: "go-e", Model: "goe_http_api",
		Connection: testconn.Connection{"ip": host, "port": float64(port)},
	})
	if res2.ControlCheck != nil {
		t.Fatalf("no control_test flag -> no check, got %+v", res2.ControlCheck)
	}
	if fake.setCalls != before {
		t.Fatalf("a plain test must never write, got %d extra sets", fake.setCalls-before)
	}

	// A failed check is HONEST but never flips the read result: point the
	// check at a dead port via a fresh doer.
	a.goeDoer = goeHTTPDoer{c: srv.Client()}
	res3 := a.TestConnection(testconn.Request{
		Role: "consumer", Brand: "go-e", Model: "goe_http_api",
		Connection:  testconn.Connection{"ip": "127.0.0.1", "port": float64(1)},
		ControlTest: true,
	})
	if !res3.OK || res3.ControlCheck == nil || res3.ControlCheck.OK {
		t.Fatalf("a failed check must not flip the read result, got %+v (check %+v)", res3, res3.ControlCheck)
	}
	if res3.ControlCheck.ErrorCode == "" || res3.ControlCheck.Message == "" {
		t.Fatalf("a failed check must name its error, got %+v", res3.ControlCheck)
	}
}
