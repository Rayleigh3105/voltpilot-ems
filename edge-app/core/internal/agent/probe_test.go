package agent

// Probe-Kanal, Geraete-Seite (Einheitsmodell Stufe 0b).
//
// Was diese Tests schuetzen: dass die Box selbst entscheidet, ob sie an einem
// Kundengeraet anklopft. Die REGELN liegen in `internal/probe` und sind dort
// einzeln getestet; hier geht es um die Verdrahtung - was am Ende wirklich auf
// dem lokalen Bus landet, was die Cloud als Antwort bekommt, und vor allem, was
// GAR NICHT passiert.

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

const (
	probeTenant = "00000000-0000-0000-0000-000000000001"
	probeSite   = "00000000-0000-0000-0000-000000000002"
	probeDevice = "00000000-0000-0000-0000-000000000003"
)

// probeBox is a bus-only agent with the probe wiring the full Start does, plus
// the answer seam so a test asserts on the CONTRACT BYTES the box would put on
// the wire.
type probeBox struct {
	a       *Agent
	addr    string
	answers chan probe.Result
}

func startProbeBox(t *testing.T) *probeBox {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	if err := a.Bus.Subscribe(localbus.TopicProbeResult, 11, a.onProbeBusResult); err != nil {
		t.Fatalf("subscribe probe result: %v", err)
	}
	a.setEntityIdentity(probeTenant, probeSite, probeDevice)
	box := &probeBox{a: a, addr: addr, answers: make(chan probe.Result, 4)}
	a.probePublish = func(payload []byte) error {
		var res probe.Result
		if err := json.Unmarshal(payload, &res); err != nil {
			t.Errorf("the box published something that is not a probe result: %v", err)
			return nil
		}
		box.answers <- res
		return nil
	}
	return box
}

// answer waits briefly for the box's cloud answer; nil = the box answered
// nothing at all (which for some cases is exactly the point).
func (b *probeBox) answer(t *testing.T) *probe.Result {
	t.Helper()
	select {
	case res := <-b.answers:
		return &res
	case <-time.After(3 * time.Second):
		return nil
	}
}

// probeStub plays the vp-modbus-probe node: it subscribes the local-bus probe
// request, records it, and answers whatever the callback returns.
func probeStub(t *testing.T, busAddr string, seen chan<- probeBusRequest,
	answer func(req probeBusRequest) []probeBusResult) {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-probe-stub").
		SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("stub connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	tok := client.Subscribe(localbus.TopicProbeRequest, 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			var req probeBusRequest
			if json.Unmarshal(msg.Payload(), &req) != nil || req.RequestID == "" {
				return
			}
			if seen != nil {
				select {
				case seen <- req:
				default:
				}
			}
			if answer == nil {
				return
			}
			raw, _ := json.Marshal(probeBusResponse{
				RequestID: req.RequestID, Results: answer(req)})
			client.Publish(localbus.TopicProbeResult, 1, false, raw)
		})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("stub subscribe: %v", tok.Error())
	}
}

func probeEnvelope(t *testing.T, mutate func(m map[string]any)) []byte {
	t.Helper()
	m := map[string]any{
		"schema_version": "1.0",
		"type":           "probe_request",
		"tenant_id":      probeTenant,
		"site_id":        probeSite,
		"device_id":      probeDevice,
		"request_id":     "9f2c41ab77d0e315",
		"requested_at":   time.Now().UTC().Format(time.RFC3339),
		"ops": []map[string]any{{
			"op": "read", "id": "soc", "transport": "modbus_tcp",
			"host": "192.168.0.28", "register_kind": "holding",
			"address": 588, "data_type": "u16",
		}},
	}
	if mutate != nil {
		mutate(m)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func f64(v float64) *float64 { return &v }

// A request that names ANOTHER device is discarded outright: it is neither
// executed nor answered. An answer would confirm this device's existence to a
// mis-addressed sender.
func TestProbeForeignIdentityIsNeitherExecutedNorAnswered(t *testing.T) {
	for _, field := range []string{"tenant_id", "site_id", "device_id"} {
		box := startProbeBox(t)
		seen := make(chan probeBusRequest, 1)
		probeStub(t, box.addr, seen, nil)

		box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
			m[field] = "99999999-9999-9999-9999-999999999999"
		}))

		if res := box.answer(t); res != nil {
			t.Fatalf("a foreign %s must not be answered: %+v", field, res)
		}
		select {
		case req := <-seen:
			t.Fatalf("a foreign %s reached the read flow: %+v", field, req)
		default:
		}
	}
}

// The redelivery case the non-retained + requested_at pair exists for: the
// broker hands over a QoS1 message from an hour ago, and the box must NOT knock
// on the customer's device for a question nobody is waiting for any more.
func TestProbeExpiredRequestIsDiscardedNotExecuted(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, nil)

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["requested_at"] = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	}))

	if res := box.answer(t); res != nil {
		t.Fatalf("an expired request must not be answered: %+v", res)
	}
	select {
	case req := <-seen:
		t.Fatalf("an expired request reached the read flow: %+v", req)
	default:
	}
}

// A malformed envelope is dropped by the parser before anything else happens.
func TestProbeMalformedRequestIsDropped(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, nil)

	box.a.onProbeRequest([]byte("kein json"))
	box.a.onProbeRequest([]byte(`{"schema_version":"9.9","type":"probe_request"}`))
	box.a.onProbeRequest(nil)

	if res := box.answer(t); res != nil {
		t.Fatalf("a malformed request must not be answered: %+v", res)
	}
	select {
	case req := <-seen:
		t.Fatalf("a malformed request reached the read flow: %+v", req)
	default:
	}
}

// The rate limit is OUR decision, not the device's - so it IS answered, and the
// device is not touched.
func TestProbeRateLimitIsAnsweredAndStopsBeforeTheDevice(t *testing.T) {
	box := startProbeBox(t)
	box.a.probeLimiter = probe.NewLimiter(time.Minute, 2)
	seen := make(chan probeBusRequest, 8)
	probeStub(t, box.addr, seen, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{ID: "soc", OK: true, Raw: f64(94), Registers: []int{94}}}
	})

	for i := 0; i < 2; i++ {
		box.a.onProbeRequest(probeEnvelope(t, nil))
		res := box.answer(t)
		if res == nil || res.ErrorCode != "" {
			t.Fatalf("request %d should have run: %+v", i, res)
		}
	}
	box.a.onProbeRequest(probeEnvelope(t, nil))
	res := box.answer(t)
	if res == nil {
		t.Fatalf("a throttled probe must still be ANSWERED - silence is a riddle")
	}
	if res.ErrorCode != probe.ErrRateLimited || res.Message == "" {
		t.Fatalf("the refusal must name itself: %+v", res)
	}
	if len(res.Results) != 0 {
		t.Fatalf("nothing ran, so nothing is reported per op: %+v", res.Results)
	}
	if len(seen) != 2 {
		t.Fatalf("the throttled request must not reach the device: %d read runs", len(seen))
	}
}

// A public target is refused BEFORE any I/O - the box does not take the cloud's
// word for where it may knock.
func TestProbePublicTargetIsRefusedWithoutTouchingTheNetwork(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, nil)

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		m["ops"].([]map[string]any)[0]["host"] = "8.8.8.8"
	}))

	res := box.answer(t)
	if res == nil || len(res.Results) != 1 {
		t.Fatalf("a refused op is still reported: %+v", res)
	}
	if res.Results[0].OK || res.Results[0].ErrorCode != probe.ErrInvalidRequest {
		t.Fatalf("want invalid_request, got %+v", res.Results[0])
	}
	if res.Results[0].Message == "" {
		t.Fatalf("the customer must learn WHY - the address is fixable")
	}
	if res.Results[0].Value != nil || res.Results[0].Raw != nil {
		t.Fatalf("a refused op must never carry a value")
	}
	select {
	case req := <-seen:
		t.Fatalf("a public target reached the read flow: %+v", req)
	default:
	}
}

// The happy path: raw AND scaled value travel back, plus the register words -
// the pair that makes a scaling or word-order mistake visible.
func TestProbeRoundTripCarriesRawRegistersAndScaledValue(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{
			ID: req.Ops[0].ID, OK: true, Raw: f64(1000), Registers: []int{0x03, 0xe8},
		}}
	})

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		op := m["ops"].([]map[string]any)[0]
		op["register_kind"] = "input"
		op["data_type"] = "s32"
		op["word_order"] = "little"
		op["unit_id"] = 71
		op["port"] = 1502
		op["scale"] = 0.1
		op["offset"] = -5.0
	}))

	req := <-seen
	if len(req.Ops) != 1 {
		t.Fatalf("one op expected: %+v", req.Ops)
	}
	// The plan the read flow receives must carry exactly what the cloud asked
	// for, including the defaults the contract states.
	got := req.Ops[0]
	if got.FC != probeFnReadInput || got.Port != 1502 || got.UnitID != 71 ||
		got.Address != 588 || got.DataType != "s32" || got.WordOrder != "little" {
		t.Fatalf("the read plan lost something: %+v", got)
	}

	res := box.answer(t)
	if res == nil || len(res.Results) != 1 || !res.Results[0].OK {
		t.Fatalf("want one ok result: %+v", res)
	}
	line := res.Results[0]
	if line.Raw == nil || *line.Raw != 1000 {
		t.Fatalf("raw must travel verbatim: %+v", line.Raw)
	}
	if line.Value == nil || *line.Value < 94.99 || *line.Value > 95.01 {
		t.Fatalf("the DISPLAY scaling is applied in the core: %+v", line.Value)
	}
	if len(line.Registers) != 2 {
		t.Fatalf("the register words must travel: %+v", line.Registers)
	}
	if res.SchemaVersion != "1.0" || res.Type != "probe_result" ||
		res.DeviceID != probeDevice || res.RequestID != "9f2c41ab77d0e315" {
		t.Fatalf("the answer envelope must be contract-shaped: %+v", res)
	}
}

// A classified failure travels verbatim and carries NO value - the box never
// dresses a failed read as a 0.
func TestProbeErrorClassTravelsVerbatimWithoutAValue(t *testing.T) {
	box := startProbeBox(t)
	probeStub(t, box.addr, nil, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{
			ID: req.Ops[0].ID, OK: false, ErrorCode: probe.ErrNoAnswer,
			Message: "Das Gerät antwortet nicht auf diese Anfrage.",
		}}
	})

	box.a.onProbeRequest(probeEnvelope(t, nil))
	res := box.answer(t)
	if res == nil || len(res.Results) != 1 {
		t.Fatalf("want one result: %+v", res)
	}
	line := res.Results[0]
	if line.OK || line.ErrorCode != probe.ErrNoAnswer || line.Message == "" {
		t.Fatalf("the class must reach the cloud verbatim: %+v", line)
	}
	if line.Value != nil || line.Raw != nil {
		t.Fatalf("a failed read must never carry a value: %+v", line)
	}
}

// An answer without a class is not turned into a success - it lands in the
// honest "we do not understand this" bucket.
func TestProbeAnswerWithoutAClassIsNeverASuccess(t *testing.T) {
	box := startProbeBox(t)
	probeStub(t, box.addr, nil, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{ID: req.Ops[0].ID, OK: false}}
	})

	box.a.onProbeRequest(probeEnvelope(t, nil))
	res := box.answer(t)
	if res == nil || len(res.Results) != 1 {
		t.Fatalf("want one result: %+v", res)
	}
	if res.Results[0].OK || res.Results[0].ErrorCode != probe.ErrInvalidResponse {
		t.Fatalf("want invalid_response, got %+v", res.Results[0])
	}
	// The same holds for an "ok" that carries no number at all.
	box2 := startProbeBox(t)
	probeStub(t, box2.addr, nil, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{ID: req.Ops[0].ID, OK: true}}
	})
	box2.a.onProbeRequest(probeEnvelope(t, nil))
	res = box2.answer(t)
	if res == nil || res.Results[0].OK {
		t.Fatalf("an ok without a value is not a value: %+v", res)
	}
}

// No read flow at all (Node-RED down / no probe node deployed): every step is
// answered as a TIMEOUT, never left as a zero value that would read like 0.
func TestProbeWithoutAReadFlowReadsAsTimeout(t *testing.T) {
	old := probeExchangeTimeout
	probeExchangeTimeout = 300 * time.Millisecond
	t.Cleanup(func() { probeExchangeTimeout = old })

	box := startProbeBox(t)
	box.a.onProbeRequest(probeEnvelope(t, nil))

	res := box.answer(t)
	if res == nil || len(res.Results) != 1 {
		t.Fatalf("want one result: %+v", res)
	}
	if res.Results[0].OK || res.Results[0].ErrorCode != probe.ErrTimeout {
		t.Fatalf("want timeout, got %+v", res.Results[0])
	}
	if res.Results[0].Value != nil {
		t.Fatalf("a timeout must never carry a value")
	}
}

// ⚠ THE SOCKET DISCIPLINE, asserted where it can actually be broken: the CORE
// must never dial the customer's device itself. It hands the read to the local
// bus, where lib/modbus-conn serializes it with the running poll; a second
// socket from here would displace exactly the poll the customer is watching.
//
// The proof is a real listener the op points at: it must see ZERO connections
// while the bus DOES see the read plan.
func TestProbeNeverDialsTheDeviceFromTheCore(t *testing.T) {
	old := probeExchangeTimeout
	probeExchangeTimeout = 500 * time.Millisecond
	t.Cleanup(func() { probeExchangeTimeout = old })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	dialed := make(chan struct{}, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			dialed <- struct{}{}
			c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port

	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	// A stub that RECORDS but never answers: the core must still not take the
	// read into its own hands when the flow stays silent.
	probeStub(t, box.addr, seen, nil)

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		op := m["ops"].([]map[string]any)[0]
		op["host"] = "127.0.0.1"
		op["port"] = port
	}))

	req := <-seen
	if len(req.Ops) != 1 || req.Ops[0].Port != port {
		t.Fatalf("the read plan must reach the bus: %+v", req.Ops)
	}
	if res := box.answer(t); res == nil || res.Results[0].ErrorCode != probe.ErrTimeout {
		t.Fatalf("a silent flow ends as a timeout: %+v", res)
	}
	select {
	case <-dialed:
		t.Fatalf("the CORE opened its own socket to the device - it must never " +
			"leave the shared per-target queue")
	default:
	}
}

// A duplicate op id would make one reading silently describe the other's
// register, so the later one is refused BY NAME - and only it.
func TestProbeDuplicateOpIdIsRefusedByName(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, func(req probeBusRequest) []probeBusResult {
		return []probeBusResult{{ID: "soc", OK: true, Raw: f64(1), Registers: []int{1}}}
	})

	box.a.onProbeRequest(probeEnvelope(t, func(m map[string]any) {
		op := m["ops"].([]map[string]any)[0]
		second := map[string]any{}
		for k, v := range op {
			second[k] = v
		}
		second["address"] = 999
		m["ops"] = []map[string]any{op, second}
	}))

	res := box.answer(t)
	if res == nil || len(res.Results) != 2 {
		t.Fatalf("both steps are reported: %+v", res)
	}
	if !res.Results[0].OK {
		t.Fatalf("the first occurrence keeps the name: %+v", res.Results[0])
	}
	if res.Results[1].ErrorCode != probe.ErrInvalidRequest || res.Results[1].Message == "" {
		t.Fatalf("the duplicate must be refused by name: %+v", res.Results[1])
	}
	req := <-seen
	if len(req.Ops) != 1 {
		t.Fatalf("only the admitted step reaches the read flow: %+v", req.Ops)
	}
}

// The COMMITTED contract fixture, executed through the real handler: the ops of
// the published example reach the read flow with the plan the contract
// describes, and the answer carries the scaling the fixture asks for.
//
// The expiry window is widened here on purpose - this test is about EXECUTION,
// and the fixture carries a fixed stamp. Expiry has its own test above.
func TestProbeContractExampleIsExecutedAsSpecified(t *testing.T) {
	oldWindow := probeWindow
	probeWindow = 100 * 365 * 24 * time.Hour
	t.Cleanup(func() { probeWindow = oldWindow })

	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..",
		"docs", "contracts", "examples", "mqtt-probe.valid.read.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, func(req probeBusRequest) []probeBusResult {
		out := make([]probeBusResult, 0, len(req.Ops))
		for _, op := range req.Ops {
			switch op.ID {
			case "soc":
				out = append(out, probeBusResult{ID: op.ID, OK: true,
					Raw: f64(94), Registers: []int{94}})
			default:
				out = append(out, probeBusResult{ID: op.ID, OK: true,
					Raw: f64(3000), Registers: []int{0x0b, 0xb8}})
			}
		}
		return out
	})

	box.a.onProbeRequest(raw)

	req := <-seen
	if len(req.Ops) != 2 {
		t.Fatalf("both fixture ops must be admitted: %+v", req.Ops)
	}
	if req.Ops[0].FC != probeFnReadHolding || req.Ops[0].Address != 588 {
		t.Fatalf("holding/FC3 plan: %+v", req.Ops[0])
	}
	// The second fixture op omits port/unit and asks for input registers.
	if req.Ops[1].FC != probeFnReadInput || req.Ops[1].Port != 502 ||
		req.Ops[1].UnitID != 1 || req.Ops[1].WordOrder != "little" {
		t.Fatalf("input/FC4 plan with contract defaults: %+v", req.Ops[1])
	}

	res := box.answer(t)
	if res == nil || len(res.Results) != 2 {
		t.Fatalf("want two results: %+v", res)
	}
	if res.Results[0].Value == nil || *res.Results[0].Value != 94 {
		t.Fatalf("no scaling stated -> raw == value: %+v", res.Results[0].Value)
	}
	// scale 0.1, offset -273.15 from the fixture.
	if res.Results[1].Value == nil ||
		*res.Results[1].Value < 26.84 || *res.Results[1].Value > 26.86 {
		t.Fatalf("the fixture's scaling must be applied: %+v", res.Results[1].Value)
	}
}

// ⚠ THE ROUTER MUST NOT BLOCK. The cloud link runs paho with
// SetOrderMatters(true), so incoming downlinks are dispatched SEQUENTIALLY on
// one goroutine: a probe that waited out its local-bus round trip there would
// stall the plan, the entity registry, the flow deployment and the OTA
// assignment for as long as a customer's device stays silent.
func TestProbeHandlerReturnsImmediatelyEvenWhileTheReadIsPending(t *testing.T) {
	old := probeExchangeTimeout
	// Comfortably shorter than the answer wait below, so the assertion is about
	// the ROUTER returning fast and never about a race between two deadlines.
	probeExchangeTimeout = 400 * time.Millisecond
	t.Cleanup(func() { probeExchangeTimeout = old })

	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 1)
	probeStub(t, box.addr, seen, nil) // records, never answers

	started := time.Now()
	box.a.onProbeRequest(probeEnvelope(t, nil))
	elapsed := time.Since(started)

	if elapsed > 500*time.Millisecond {
		t.Fatalf("the link's message router was blocked for %v - every other "+
			"downlink would have waited that long", elapsed)
	}
	// ...and the work really did happen, so this is not a vacuous test.
	if req := <-seen; len(req.Ops) != 1 {
		t.Fatalf("the read still has to reach the flow: %+v", req)
	}
	if res := box.answer(t); res == nil || res.Results[0].ErrorCode != probe.ErrTimeout {
		t.Fatalf("and the answer still arrives: %+v", res)
	}
}

// ⚠ A QoS1 DUPLICATE arriving while the first run is still in flight must NOT
// read the customer's device a second time. Non-retained + requested_at only
// stop a LATE redelivery; this is the concurrent one.
func TestProbeConcurrentDuplicateDeliveryReadsTheDeviceOnce(t *testing.T) {
	box := startProbeBox(t)
	seen := make(chan probeBusRequest, 4)
	release := make(chan struct{})
	// A flow that HOLDS its answer, so both deliveries overlap for sure.
	probeStub(t, box.addr, seen, func(req probeBusRequest) []probeBusResult {
		<-release
		return []probeBusResult{{ID: "soc", OK: true, Raw: f64(94), Registers: []int{94}}}
	})

	payload := probeEnvelope(t, nil) // same request_id both times
	box.a.onProbeRequest(payload)
	if req := <-seen; len(req.Ops) != 1 {
		t.Fatalf("the first delivery must run: %+v", req)
	}
	box.a.onProbeRequest(payload)

	close(release)
	res := box.answer(t)
	if res == nil || !res.Results[0].OK {
		t.Fatalf("the run in flight answers for both: %+v", res)
	}
	if extra := box.answer(t); extra != nil {
		t.Fatalf("a duplicate must not produce a second answer: %+v", extra)
	}
	select {
	case req := <-seen:
		t.Fatalf("the device was read a SECOND time for one question: %+v", req)
	default:
	}
	// ...and once it is done, the same id may of course be used again.
	if ch := box.a.claimProbe("9f2c41ab77d0e315"); ch == nil {
		t.Fatalf("a finished probe must release its correlation")
	}
}

// --- Stufe 1: der Verbindungstest geht durch die BOX-EIGENE Maschinerie ----

func TestAConnectionTestUsesTheSamePathAsTheLocalButton(t *testing.T) {
	a := newGateTestAgent(t)
	// Der lokale Test antwortet, ohne dass ein Geraet existiert: ohne
	// Lese-Flow endet er in seinem eigenen Timeout - und genau DIESES Urteil
	// muss der Probe-Kanal durchreichen, statt ein eigenes zu erfinden.
	res := a.runProbeTestConnection(probe.Op{
		Op: probe.OpTestConnection, ID: "verbindung", Brand: "deye",
		Model:      "sun-30k-sg01hp3",
		Connection: []byte(`{"ip":"192.168.0.28","port":8899,"serial":"2985159064","mb_slave_id":1}`),
	})
	if res.OK {
		t.Fatalf("ohne Geraet kann der Test nicht bestehen: %+v", res)
	}
	if res.ErrorCode == "" || res.Message == "" {
		t.Fatalf("jeder Fehlschlag traegt Klasse UND deutschen Satz: %+v", res)
	}
	if res.Reading != nil {
		t.Fatal("ein Fehlschlag traegt NIE einen Messwert")
	}
}

func TestAnInvalidSelectionIsRefusedByTheCatalogNotByTheDevice(t *testing.T) {
	a := newGateTestAgent(t)
	res := a.runProbeTestConnection(probe.Op{
		Op: probe.OpTestConnection, ID: "verbindung", Brand: "gibt-es-nicht",
		Connection: []byte(`{"ip":"192.168.0.28"}`),
	})
	if res.OK || res.ErrorCode != probe.ErrInvalidRequest {
		t.Fatalf("res = %+v", res)
	}
	// Der Satz nennt das konkrete Problem, nicht nur „ungueltig".
	if !strings.Contains(res.Message, "Marke") {
		t.Fatalf("Grund = %q", res.Message)
	}
}
