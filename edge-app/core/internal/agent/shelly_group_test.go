package agent

// The executor of a Shelly OUTPUT SET (one heating rod over the three outputs
// of a Pro 3, switched in stages) over the real plan path: arbiter decision ->
// stage -> writes -> one readback -> published readback + heartbeat stage.
// The Pro 3 stub answers with the device's own bodies (VoltPilotGATE,
// 31.10.2026); the Shelly.GetStatus/GetConfig envelopes follow the Gen2 docs.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// pro3Stage is a stateful Pro 3 for the agent tests.
type pro3Stage struct {
	mu       sync.Mutex
	on       [3]bool
	initial  [3]string
	ignoreOn map[int]bool
	sets     []string
}

func newPro3Stage() *pro3Stage {
	return &pro3Stage{initial: [3]string{"match_input", "restore_last", "off"}, ignoreOn: map[int]bool{}}
}

func (d *pro3Stage) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.mu.Lock()
		defer d.mu.Unlock()
		q := r.URL.Query()
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"name":null,"id":"shellypro3-34987a484124","mac":"34987A484124",` +
				`"slot":1,"model":"SPSW-003XE16EU","gen":2,"fw_id":"20241011-114451/1.4.4-g6d2a586",` +
				`"ver":"1.4.4","app":"Pro3","auth_en":false,"auth_domain":null}`))
		case "/rpc/Shelly.GetStatus":
			parts := []string{`"ble":{}`}
			for i := 0; i < 3; i++ {
				parts = append(parts, `"switch:`+strconv.Itoa(i)+`":{"id":`+strconv.Itoa(i)+`, "source":"init", "output":`+
					strconv.FormatBool(d.on[i])+`,"temperature":{"tC":33.6, "tF":92.4}}`)
			}
			_, _ = w.Write([]byte("{" + strings.Join(parts, ",") + `,"sys":{}}`))
		case "/rpc/Shelly.GetConfig":
			parts := []string{}
			for i := 0; i < 3; i++ {
				parts = append(parts, `"switch:`+strconv.Itoa(i)+`":{"id":`+strconv.Itoa(i)+
					`,"name":null,"in_mode":"follow","initial_state":"`+d.initial[i]+`","auto_on":false,"auto_off":false}`)
			}
			_, _ = w.Write([]byte("{" + strings.Join(parts, ",") + "}"))
		case "/rpc/Switch.Set":
			id, _ := strconv.Atoi(q.Get("id"))
			on := q.Get("on") == "true"
			d.sets = append(d.sets, fmt.Sprintf("%d=%v", id, on))
			was := d.on[id]
			if !(on && d.ignoreOn[id]) {
				d.on[id] = on
			}
			_, _ = w.Write([]byte(`{"was_on":` + strconv.FormatBool(was) + `}`))
		case "/rpc/Switch.SetConfig":
			id, _ := strconv.Atoi(q.Get("id"))
			var c struct {
				InitialState string `json:"initial_state"`
			}
			_ = json.Unmarshal([]byte(q.Get("config")), &c)
			d.initial[id] = c.InitialState
			_, _ = w.Write([]byte(`{"restart_required":false}`))
		default:
			w.WriteHeader(404)
		}
	})
}

func (d *pro3Stage) snapshot() (on [3]bool, sets []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.on, append([]string(nil), d.sets...)
}

// stageRodRegistry is a heating rod over the three outputs (3 x 2.0 kW,
// stages 1/2/3) - the driver block the API composes for a Pro 3.
func stageRodRegistry(id, ip string, port int) entities.Registry {
	maxKw := 6.0
	driver := json.RawMessage(fmt.Sprintf(`{"brand":"shelly","communication":"shelly_http","connection":`+
		`{"ip":%q,"port":%d,"channels":[0,1,2],"output_kw":[2.0,2.0,2.0],"stages":[1,2,3]}}`, ip, port))
	return entities.Registry{Revision: "rev-stufen", Entities: []entities.Entity{{
		ID: id, Type: entities.TypeHeatingRod, Label: "Heizstab",
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
			{Command: entities.CmdOnOff}, {Command: entities.CmdSetpointKw}}},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
			Failsafe: entities.Failsafe{Behavior: "off"},
		},
		Driver: driver,
	}}}
}

func submitSetpointWish(arb *desired.Arbiter, id string, kw float64, req string) {
	arb.SubmitInternal(&desired.Desired{
		EntityID: id, RequestID: req,
		Source:        desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority:      desired.ClassFlow,
		TTL:           time.Hour,
		IssuedAt:      time.Now().UTC(),
		Commands:      entities.Commands{SetpointKw: &kw},
		RequestedType: entities.CmdSetpointKw,
	})
	arb.Tick()
}

func stageBus(t *testing.T, id string) (*localbus.Bus, func() []map[string]any, func()) {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	readbacks, sub := busObserver(t, addr, "stage-rb-"+id, entities.ReadbackTopic(id))
	return bus, readbacks, func() { sub.Disconnect(0); bus.Close() }
}

// A setpoint of one element's power runs exactly ONE phase; the readback and
// the heartbeat carry the confirmed stage with its kW (what the ledger counts).
func TestShellyStageSetpointRunsOnePhase(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-pro3"
	reg := stageRodRegistry(id, host, port)
	arb := minimalArbiter(reg)
	submitSetpointWish(arb, id, 2.0, "s1")
	bus, readbacks, done := stageBus(t, id)
	defer done()

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	on, sets := dev.snapshot()
	count := 0
	for _, o := range on {
		if o {
			count++
		}
	}
	if count != 1 || len(sets) != 3 {
		t.Fatalf("one phase must run, got outputs=%v writes=%v", on, sets)
	}
	waitFor(t, 3*time.Second, "readback published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	stage, _ := rb["stage"].(map[string]any)
	if rb["all_match"] != true || stage == nil || stage["commanded"] != 1.0 || stage["confirmed"] != 1.0 ||
		stage["confirmed_kw"] != 2.0 {
		t.Fatalf("readback = %v", rb)
	}
	hb := a.consumersSummary()[id]
	if hb.Stage == nil || *hb.Stage.Confirmed != 1 || *hb.Stage.ConfirmedKw != 2.0 || len(hb.Stage.OutputsOn) != 1 ||
		hb.Stage.MismatchSince != "" {
		t.Fatalf("heartbeat stage = %+v", hb.Stage)
	}
}

// One output that does not switch on (a dead contact on L2): the confirmed
// stage is two phases, the deviation is named with its start, nothing locks,
// and the re-assert writes the same output again (HZ-4 B).
func TestShellyStageOneOutputDisagreeingStaysVisible(t *testing.T) {
	dev := newPro3Stage()
	dev.ignoreOn[1] = true
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-pro3-l2"
	reg := stageRodRegistry(id, host, port)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, id, true, "o1")
	bus, readbacks, done := stageBus(t, id)
	defer done()

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	fp, asserted := map[string]string{}, map[string]time.Time{}
	t0 := time.Now()
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0)
	waitFor(t, 3*time.Second, "readback published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	stage, _ := rb["stage"].(map[string]any)
	regs, _ := rb["registers"].([]any)
	if rb["all_match"] != false || stage["confirmed"] != 2.0 || stage["confirmed_kw"] != 4.0 || len(regs) != 3 {
		t.Fatalf("readback = %v", rb)
	}
	l2 := regs[1].(map[string]any)
	if l2["channel"] != 1.0 || l2["match"] != false || l2["mismatch_since"] == nil {
		t.Fatalf("L2 register = %v", l2)
	}
	hb := a.consumersSummary()[id]
	if hb.Confirmed != nil || hb.Stage == nil || hb.Stage.MismatchSince == "" {
		// Confirmed rides the bus round trip (onEntityReadback); the stage is local.
		t.Fatalf("heartbeat = %+v stage=%+v", hb, hb.Stage)
	}

	// Nothing changed and the re-assert is not due: no write.
	_, before := dev.snapshot()
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0.Add(5*time.Second))
	if _, after := dev.snapshot(); len(after) != len(before) {
		t.Fatalf("an unchanged plan must not be re-written before the re-assert: %v", after[len(before):])
	}
	// The re-assert writes the same three outputs again - L2 included.
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0.Add(goeReassertInterval+time.Second))
	_, after := dev.snapshot()
	if strings.Join(after[len(before):], ",") != "0=true,1=true,2=true" {
		t.Fatalf("re-assert writes = %v", after[len(before):])
	}
}

// An output set over the outputs of a per-output component: two writers on one
// relay would undo each other - neither entity writes, both say why.
func TestShellyStageDoubleClaimDrivesNeither(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg := stageRodRegistry("rod-set", host, port)
	single := rodShellyRegistry("rod-single", host, port, false, 0).Entities[0]
	single.Driver = json.RawMessage(fmt.Sprintf(
		`{"brand":"shelly","communication":"shelly_http","connection":{"ip":%q,"port":%d,"channel":1}}`, host, port))
	reg.Entities = append(reg.Entities, single)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, "rod-set", true, "a")
	submitOnOffWish(arb, "rod-single", true, "b")
	bus, readbacks, done := stageBus(t, "rod-set")
	defer done()

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	if _, sets := dev.snapshot(); len(sets) != 0 {
		t.Fatalf("a doubly claimed output was written: %v", sets)
	}
	waitFor(t, 3*time.Second, "refusal published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	if rb["error_code"] != "invalid_request" ||
		rb["message"] != "Ausgang 1 gehört zu zwei Geräten - VoltPilot schaltet keines von beiden, bis jeder Ausgang genau einem Gerät gehört." {
		t.Fatalf("refusal = %v", rb)
	}
}

// The portal's connection test of an output set: every output's state from
// one status answer, as samples relay_on_<kanal> AND the ausgaenge block with
// the "nach Stromausfall" setting (HZ-5) - read, never changed.
func TestShellyStageConnectionTestReportsOutputsAndInitialState(t *testing.T) {
	dev := newPro3Stage()
	dev.on[2] = true
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	a := newGateTestAgent(t)
	a.shellyDoer = goeHTTPDoer{c: srv.Client()}
	conn, _ := json.Marshal(map[string]any{"ip": host, "port": port, "channels": []int{0, 1, 2}})
	line := a.runProbeTestConnection(probe.Op{
		Op: probe.OpTestConnection, ID: "verbindung", Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Family: inverter.FamShellyHTTP, Role: "consumer",
		Connection: conn,
	})
	if !line.OK || len(line.Samples) != 3 || len(line.Ausgaenge) != 3 {
		t.Fatalf("line = %+v", line)
	}
	for i, s := range line.Samples {
		want := 0.0
		if i == 2 {
			want = 1
		}
		if s.Channel != "relay_on_"+strconv.Itoa(i) || *s.Value != want || s.Count != 1 {
			t.Fatalf("sample %d = %+v", i, s)
		}
	}
	got := []string{}
	for _, o := range line.Ausgaenge {
		got = append(got, fmt.Sprintf("%d:%v:%s", o.Kanal, *o.Ein, o.NachStromausfall))
	}
	if strings.Join(got, ",") != "0:false:match_input,1:false:restore_last,2:true:off" {
		t.Fatalf("ausgaenge = %v", got)
	}
	if _, sets := dev.snapshot(); len(sets) != 0 {
		t.Fatalf("a connection test must not switch: %v", sets)
	}
}

// "Auf ‚aus' stellen" (HZ-5): the probe op writes the setting on every output
// and reports what the device holds afterwards. No switching command goes out.
func TestShellyNachStromausfallAusSetsEveryOutput(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	a := newGateTestAgent(t)
	a.shellyDoer = goeHTTPDoer{c: srv.Client()}
	conn, _ := json.Marshal(map[string]any{"ip": host, "port": port, "channels": []int{0, 1, 2}})
	op := probe.Op{Op: probe.OpNachStromausfallAus, ID: "aus", Brand: "shelly", Connection: conn}
	if code, msg := probe.ValidateOp(op); code != "" {
		t.Fatalf("op refused: %s %s", code, msg)
	}
	line := a.runShellyNachStromausfallAus(op)
	if !line.OK || len(line.Ausgaenge) != 3 {
		t.Fatalf("line = %+v", line)
	}
	for _, o := range line.Ausgaenge {
		if o.NachStromausfall != "off" || o.Ein != nil {
			t.Fatalf("ausgang = %+v", o)
		}
	}
	if _, sets := dev.snapshot(); len(sets) != 0 {
		t.Fatalf("a setting write must not switch: %v", sets)
	}
	if code, _ := probe.ValidateOp(probe.Op{Op: probe.OpNachStromausfallAus, ID: "x", Brand: "goe", Connection: conn}); code != probe.ErrNotSupported {
		t.Fatalf("a non-Shelly brand must be not_supported, got %q", code)
	}
}

// The source of an output set publishes the rod-level fact (relay_on = any
// output on) and the per-output states - never a load for a bare relay.
func TestShellyStageSourcePollReadsEveryOutput(t *testing.T) {
	dev := newPro3Stage()
	dev.on[1] = true
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	obs, sub := busObserver(t, addr, "src-set", sources.TopicPrefix+"src-set/telemetry")
	defer sub.Disconnect(0)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a := &Agent{Cfg: cfg, Bus: bus, shellyDoer: goeHTTPDoer{c: srv.Client()}}
	a.srcs = []sources.Source{{ID: "src-set", Role: sources.RoleConsumer, Communication: inverter.CommShellyHTTP,
		Connection: inverter.Connection{IP: host, Port: port, Channels: inverter.ChannelSetOf([]int{0, 1, 2})}}}
	a.runShellySourcePass(context.Background(), a.shellyDoerRef())
	waitFor(t, 3*time.Second, "source reading published", func() bool { return len(obs()) > 0 })
	m := obs()[len(obs())-1]
	outs, _ := m["outputs"].([]any)
	if m["relay_on"] != true || len(outs) != 3 || outs[1] != true || outs[0] != false {
		t.Fatalf("reading = %v", m)
	}
	if _, has := m["load_kw"]; has {
		t.Fatalf("a bare relay set must never claim a load: %v", m)
	}
}
