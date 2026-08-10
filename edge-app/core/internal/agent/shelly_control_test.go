package agent

// Integration tests for the Shelly consumer-control executor against
// in-process stubs of BOTH generation dialects, with and without metering:
// plan slot / arbitrated wish -> executor -> HTTP -> readback -> confirmed;
// the cycle guard holds a quick restart with its reason; failsafe OFF at
// staleness; the Stufe-2-vs-3 difference (measured power telemetry vs none);
// dialect detected once + persisted; flags off = byte-identical.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// shellyFakeGen2 is a minimal in-process Gen2+ RPC Shelly (Plus 1 / Plus 1PM).
type shellyFakeGen2 struct {
	mu              sync.Mutex
	metering        bool
	on              bool
	apowerW         float64
	setCalls        int
	shellyCalls     int
	lastToggleAfter int
}

func (f *shellyFakeGen2) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/shelly":
			f.shellyCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "shellyplus1pm-x", "model": "SNSW-001P16EU", "gen": 2,
				"app": "Plus1PM", "auth_en": false,
			})
		case "/rpc/Switch.GetStatus":
			st := map[string]any{"id": 0, "output": f.on}
			if f.metering {
				p := 0.0
				if f.on {
					p = f.apowerW
				}
				st["apower"] = p
			}
			_ = json.NewEncoder(w).Encode(st)
		case "/rpc/Switch.Set":
			f.setCalls++
			was := f.on
			f.on = r.URL.Query().Get("on") == "true"
			if f.on {
				f.lastToggleAfter, _ = strconv.Atoi(r.URL.Query().Get("toggle_after"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"was_on": was})
		default:
			w.WriteHeader(404)
		}
	})
}

func (f *shellyFakeGen2) snapshot() (on bool, setCalls, shellyCalls, toggleAfter int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on, f.setCalls, f.shellyCalls, f.lastToggleAfter
}

// shellyFakeGen1 is a minimal in-process Gen1 Shelly (Shelly 1 / 1PM).
type shellyFakeGen1 struct {
	mu       sync.Mutex
	metering bool
	on       bool
	powerW   float64
	setCalls int
}

func (f *shellyFakeGen1) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/shelly":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "SHSW-1", "mac": "AABB", "auth": false, "fw": "x",
			})
		case r.URL.Path == "/status":
			st := map[string]any{"relays": []map[string]any{{"ison": f.on}}}
			if f.metering {
				p := 0.0
				if f.on {
					p = f.powerW
				}
				st["meters"] = []map[string]any{{"power": p, "is_valid": true}}
			} else {
				st["meters"] = []map[string]any{{"power": 0.0, "is_valid": false}}
			}
			_ = json.NewEncoder(w).Encode(st)
		case strings.HasPrefix(r.URL.Path, "/relay/"):
			f.setCalls++
			f.on = r.URL.Query().Get("turn") == "on"
			_ = json.NewEncoder(w).Encode(map[string]any{"ison": f.on})
		default:
			w.WriteHeader(404)
		}
	})
}

func (f *shellyFakeGen1) snapshot() (on bool, setCalls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on, f.setCalls
}

// rodShellyRegistry builds a one-entity registry: a heating rod behind a
// Shelly at the fake's address. metering steers the declared measure caps.
func rodShellyRegistry(id, ip string, port int, metering bool, minOffSeconds float64) entities.Registry {
	maxKw := 3.0
	driver := json.RawMessage(fmt.Sprintf(
		`{"brand":"shelly","communication":"shelly_http","connection":{"ip":%q,"port":%d}}`, ip, port))
	e := entities.Entity{
		ID: id, Type: entities.TypeHeatingRod, Label: "Heizstab",
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: entities.CmdOnOff}},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
			Failsafe: entities.Failsafe{Behavior: "off"},
		},
		Driver: driver,
	}
	if metering {
		e.Capabilities.Measure = []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}}
	}
	if minOffSeconds > 0 {
		e.Guards.Limits.MinOffSeconds = &minOffSeconds
	}
	return entities.Registry{Revision: "rev-shelly", Entities: []entities.Entity{e}}
}

// submitOnOffWish replaces the current flow wish (on_off shape - the command
// form the cloud resolves for relay consumers).
func submitOnOffWish(arb *desired.Arbiter, id string, on bool, req string) {
	arb.SubmitInternal(&desired.Desired{
		EntityID: id, RequestID: req,
		Source:        desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority:      desired.ClassFlow,
		TTL:           time.Hour,
		IssuedAt:      time.Now().UTC(),
		Commands:      entities.Commands{OnOff: &on},
		RequestedType: entities.CmdOnOff,
	})
	arb.Tick()
}

// shellyAgent wires a minimal agent for one deterministic pass.
func shellyAgent(t *testing.T, reg entities.Registry, arb *desired.Arbiter,
	client *http.Client) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	return &Agent{Cfg: cfg, entRegistry: reg, arb: arb,
		shellyDoer: goeHTTPDoer{c: client}}
}

// busObserver subscribes one topic and collects JSON payloads.
func busObserver(t *testing.T, addr, clientID, topic string) (func() []map[string]any, pahomqtt.Client) {
	t.Helper()
	sub := pahoClient(t, addr, clientID)
	var mu sync.Mutex
	var msgs []map[string]any
	if tok := sub.Subscribe(topic, 1, func(_ pahomqtt.Client, m pahomqtt.Message) {
		var p map[string]any
		if json.Unmarshal(m.Payload(), &p) == nil {
			mu.Lock()
			msgs = append(msgs, p)
			mu.Unlock()
		}
	}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), msgs...)
	}, sub
}

// The Stufe-2 chain on a Gen2 METERING Shelly: an arbitrated on_off command ->
// Switch.Set with the dead-man timer -> readback all_match -> the MEASURED
// power published as per-entity telemetry (the ledger's INTEGRATED evidence).
func TestShellyGen2MeteringExecutesAndPublishesPowerTelemetry(t *testing.T) {
	fake := &shellyFakeGen2{metering: true, apowerW: 2980}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-shelly-2pm"
	reg := rodShellyRegistry(id, host, port, true, 0)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, id, true, "r1")

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	readbacks, sub1 := busObserver(t, addr, "sh-rb", entities.ReadbackTopic(id))
	defer sub1.Disconnect(0)
	telems, sub2 := busObserver(t, addr, "sh-tel", entities.TelemetryTopic(id))
	defer sub2.Disconnect(0)

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	on, setCalls, _, toggleAfter := fake.snapshot()
	if !on || setCalls != 1 {
		t.Fatalf("relay must be switched on once, got on=%v calls=%d", on, setCalls)
	}
	if toggleAfter != shelly.DefaultOnTimerS {
		t.Fatalf("the ON write must arm the dead-man timer, got %d", toggleAfter)
	}
	waitFor(t, 3*time.Second, "readback + telemetry published", func() bool {
		return len(readbacks()) > 0 && len(telems()) > 0
	})
	rb := readbacks()[len(readbacks())-1]
	if rb["all_match"] != true || rb["adapter"] != "shelly_http" || rb["metering"] != true {
		t.Fatalf("unexpected readback: %v", rb)
	}
	tel := telems()[len(telems())-1]
	ch, _ := tel["channels"].(map[string]any)
	if ch == nil || ch["power_kw"] != 2.98 {
		t.Fatalf("measured power must ride entity telemetry (Stufe 2), got %v", tel)
	}
}

// The Stufe-3 contrast on a Gen1 NON-metering Shelly: the relay readback
// confirms the runtime (all_match), but NO power value is ever published -
// the ledger then honestly derives "angenommen" (Nennleistung x Zeit).
func TestShellyGen1NonMeteringConfirmsRuntimeWithoutPower(t *testing.T) {
	fake := &shellyFakeGen1{metering: false}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-shelly-gen1"
	reg := rodShellyRegistry(id, host, port, false, 0)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, id, true, "r1")

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	readbacks, sub1 := busObserver(t, addr, "sh1-rb", entities.ReadbackTopic(id))
	defer sub1.Disconnect(0)
	telems, sub2 := busObserver(t, addr, "sh1-tel", entities.TelemetryTopic(id))
	defer sub2.Disconnect(0)

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	if on, calls := fake.snapshot(); !on || calls != 1 {
		t.Fatalf("relay must be on, got on=%v calls=%d", on, calls)
	}
	waitFor(t, 3*time.Second, "readback published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	if rb["all_match"] != true || rb["metering"] != false {
		t.Fatalf("runtime must be confirmed WITHOUT a metering claim: %v", rb)
	}
	if _, hasPower := rb["power_kw"]; hasPower {
		t.Fatalf("a non-metering readback must not carry a power value: %v", rb)
	}
	// Give the bus a moment; NO telemetry may ever appear (never a fabricated
	// load - the ledger stays at Stufe 3 "angenommen").
	time.Sleep(300 * time.Millisecond)
	if got := telems(); len(got) != 0 {
		t.Fatalf("non-metering Shelly must publish NO power telemetry, got %v", got)
	}
}

// The dialect is detected ONCE, persisted, and survives an agent restart -
// including across executor passes (the re-assert re-writes, but never
// re-probes /shelly).
func TestShellyDialectDetectedOncePersistedAcrossRestart(t *testing.T) {
	fake := &shellyFakeGen2{metering: true, apowerW: 1000}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-shelly-persist"
	reg := rodShellyRegistry(id, host, port, true, 0)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, id, true, "r1")

	a := shellyAgent(t, reg, arb, srv.Client())
	dataDir := a.Cfg.DataDir
	// Two passes with fresh fingerprint maps = two full executes.
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	if _, _, shellyCalls, _ := fake.snapshot(); shellyCalls != 1 {
		t.Fatalf("the dialect must be detected exactly once, got %d /shelly probes", shellyCalls)
	}
	// A NEW agent over the SAME data dir (= a reboot) reuses the persisted
	// identity - no re-detect.
	b := shellyAgent(t, reg, arb, srv.Client())
	b.Cfg.DataDir = dataDir
	b.runShellyControlPass(context.Background(), b.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	if _, _, shellyCalls, _ := fake.snapshot(); shellyCalls != 1 {
		t.Fatalf("a reboot must reuse the persisted dialect, got %d /shelly probes", shellyCalls)
	}
}

// The cycle guard (Mindestpause) holds a too-quick restart UPSTREAM with its
// honest reason; the driver then keeps the relay off - the central protection
// layer for a heating rod.
func TestShellyCycleGuardHoldsQuickRestartWithReason(t *testing.T) {
	fake := &shellyFakeGen2{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-shelly-cycle"
	reg := rodShellyRegistry(id, host, port, false, 600)
	arb := minimalArbiter(reg)
	a := shellyAgent(t, reg, arb, srv.Client())
	fp, la := map[string]string{}, map[string]time.Time{}

	// Run.
	submitOnOffWish(arb, id, true, "r1")
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, la, time.Now())
	if on, _, _, _ := fake.snapshot(); !on {
		t.Fatal("expected the rod to run")
	}
	// Stop, then an immediate restart: the Mindestpause holds it.
	submitOnOffWish(arb, id, false, "r2")
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, la, time.Now())
	submitOnOffWish(arb, id, true, "r3")
	dec, ok := arb.DecisionFor(id)
	if !ok || dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOff {
		t.Fatalf("expected the min-off hold with its reason, got %+v ok=%v", dec.Cycle, ok)
	}
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, la, time.Now())
	if on, _, _, _ := fake.snapshot(); on {
		t.Fatal("the held restart must keep the relay OFF")
	}
	// The heartbeat's consumers block names the hold (waiting + guard_min_off).
	sum := a.consumersSummary()
	if sum == nil || sum[id].State != "waiting" || sum[id].ReasonCode != guards.CycleReasonMinOff {
		t.Fatalf("the hold must be named in the consumers block, got %+v", sum[id])
	}
}

// Failsafe at staleness is OFF (§4.2 - a rod without a fresh command must not
// keep heating), deliberately NOT the go-e neutral release.
func TestShellyFailsafeStalenessWritesOff(t *testing.T) {
	fake := &shellyFakeGen2{on: true} // running under some old/external command
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-shelly-stale"
	reg := rodShellyRegistry(id, host, port, false, 0)
	arb := minimalArbiter(reg) // NO desire -> no decision -> stale

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	readbacks, sub := busObserver(t, addr, "sh-stale", entities.ReadbackTopic(id))
	defer sub.Disconnect(0)

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	if on, calls, _, _ := fake.snapshot(); on || calls != 1 {
		t.Fatalf("staleness must write the relay OFF, got on=%v calls=%d", on, calls)
	}
	waitFor(t, 3*time.Second, "readback published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	if rb["mode"] != "off" || rb["all_match"] != true {
		t.Fatalf("the failsafe off must be confirmed: %v", rb)
	}
	if reason, _ := rb["reason"].(string); !strings.Contains(reason, "Failsafe") {
		t.Fatalf("the failsafe must name itself: %v", rb)
	}
}

// shellyFailDoer fails the test if the executor ever calls it.
type shellyFailDoer struct{ t *testing.T }

func (d shellyFailDoer) Get(context.Context, string) (int, []byte, error) {
	d.t.Fatal("no HTTP expected on this path")
	return 0, nil, nil
}

// With the consumer flag off (the default) the pass issues ZERO HTTP and
// leaves no state behind - byte-identical to a build without the driver.
func TestShellyConsumerFlagOffIsByteIdentical(t *testing.T) {
	id := "rod-shelly-off"
	reg := rodShellyRegistry(id, "127.0.0.1", 1, true, 0)
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, id, true, "r1")
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = false // the Inkrement-5 master switch stays OFF
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, shellyDoer: shellyFailDoer{t}}
	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	// No identity store file may exist - nothing ran.
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "shelly-devices.json")); !os.IsNotExist(err) {
		t.Fatalf("flag off must leave no shelly state file behind (err=%v)", err)
	}
}

// The plan path end to end: a v2 plan slot commands the rod -> arbiter ->
// executor -> HTTP -> readback (the C1-rig shape on the shelly driver).
func TestShellyPlanSlotExecutesOverTheRealPlanPath(t *testing.T) {
	fake := &shellyFakeGen2{metering: true, apowerW: 2980}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-1" // the id the plan below names

	a := newGateTestAgent(t)
	a.Cfg.ControlEnabled = true
	a.Cfg.ConsumerControlEnabled = true
	a.shellyDoer = goeHTTPDoer{c: srv.Client()}
	a.setEntityIdentity("t", "s", "d")
	reg := rodShellyRegistry(id, host, port, true, 0)
	a.applyEntityRegistry(reg)

	raw, _ := json.Marshal(map[string]any{
		"schema_version": "2.0",
		"tenant_id":      "t", "site_id": "s", "device_id": "d",
		"plan_id":      "11111111-2222-3333-4444-555555555555",
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"slot_minutes": 15,
		"entities": []map[string]any{{
			"entity_id": id, "kind": "consumer",
			"slots": []map[string]any{{
				"start":    time.Now().UTC().Format(time.RFC3339),
				"commands": map[string]any{"on_off": true},
			}},
		}},
	})
	a.onPlanV2(raw)
	a.runPlanExecutors(time.Now().UTC())
	a.arb.Tick()

	a.runShellyControlPass(context.Background(), a.shellyDoer, map[string]string{}, map[string]time.Time{}, time.Now())
	on, setCalls, _, toggleAfter := fake.snapshot()
	if !on || setCalls != 1 || toggleAfter != shelly.DefaultOnTimerS {
		t.Fatalf("plan slot must switch the rod on with the dead-man timer, got on=%v calls=%d timer=%d",
			on, setCalls, toggleAfter)
	}
}

// The D11 connection test through the REAL TestConnection dispatch: identify
// (gen + metering), read, and the switch test ONLY while the relay is off.
func TestShellyConnectionTestSwitchTestsOnlyWhileOff(t *testing.T) {
	fake := &shellyFakeGen1{metering: true, powerW: 2500}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	a := newGateTestAgent(t)
	a.shellyDoer = goeHTTPDoer{c: srv.Client()}
	req := testconn.Request{
		Role: "consumer", Brand: inverter.BrandShelly, Model: inverter.FamShellyHTTP,
		Connection:  testconn.Connection{"ip": host, "port": port},
		ControlTest: true,
	}

	// Relay OFF: the value-identical off-write runs and passes.
	res := a.TestConnection(req)
	if !res.OK || res.ControlCheck == nil || !res.ControlCheck.OK || res.ControlCheck.Skipped {
		t.Fatalf("off-relay test must run the switch test: %+v cc=%+v", res, res.ControlCheck)
	}
	if res.ControlCheck.Gen != 1 || res.ControlCheck.Metering == nil || !*res.ControlCheck.Metering {
		t.Fatalf("capability facts missing: %+v", res.ControlCheck)
	}
	if _, calls := fake.snapshot(); calls != 1 {
		t.Fatalf("expected exactly one value-identical write, got %d", calls)
	}

	// Relay ON: read-only + honest skip, and the running cycle is never
	// interrupted.
	fake.mu.Lock()
	fake.on = true
	fake.mu.Unlock()
	res = a.TestConnection(req)
	if !res.OK || res.ControlCheck == nil || res.ControlCheck.OK || !res.ControlCheck.Skipped {
		t.Fatalf("on-relay test must skip the switch test: %+v", res.ControlCheck)
	}
	if !strings.Contains(res.ControlCheck.Message, "übersprungen") {
		t.Fatalf("the skip must be honestly named: %q", res.ControlCheck.Message)
	}
	if on, calls := fake.snapshot(); !on || calls != 1 {
		t.Fatalf("a running relay must never be written (on=%v calls=%d)", on, calls)
	}
	// The metering reading rides the test result (load_kw = 2.5 kW).
	if res.Reading == nil || res.Reading.LoadKw == nil || *res.Reading.LoadKw != 2.5 {
		t.Fatalf("the measured load must ride the reading: %+v", res.Reading)
	}
}

// The shelly source poll publishes the honest per-class reading: a metering
// source carries relay_on + load_kw (real values); a NON-metering source
// carries ONLY relay_on - never a fabricated load. Exactly this distinction
// is what device_source_status.load_kw feeds cloud-side (the D3 capability
// hint behind the ledger's Stufe 2 vs 3).
func TestShellySourcePollPublishesHonestReadings(t *testing.T) {
	metering := &shellyFakeGen2{metering: true, apowerW: 2000, on: true}
	srvM := httptest.NewServer(metering.handler())
	defer srvM.Close()
	hostM, portM := splitHostPort(t, srvM.URL)
	bare := &shellyFakeGen1{metering: false, on: true}
	srvB := httptest.NewServer(bare.handler())
	defer srvB.Close()
	hostB, portB := splitHostPort(t, srvB.URL)

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	obsM, s1 := busObserver(t, addr, "src-m", sources.TopicPrefix+"src-m1/telemetry")
	defer s1.Disconnect(0)
	obsB, s2 := busObserver(t, addr, "src-b", sources.TopicPrefix+"src-b1/telemetry")
	defer s2.Disconnect(0)

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a := &Agent{Cfg: cfg, Bus: bus,
		shellyDoer: goeHTTPDoer{c: &http.Client{Timeout: 5 * time.Second}}}
	a.srcs = []sources.Source{
		{ID: "src-m1", Role: sources.RoleConsumer, Communication: inverter.CommShellyHTTP,
			Connection: inverter.Connection{IP: hostM, Port: portM}},
		{ID: "src-b1", Role: sources.RoleConsumer, Communication: inverter.CommShellyHTTP,
			Connection: inverter.Connection{IP: hostB, Port: portB}},
	}
	a.runShellySourcePass(context.Background(), a.shellyDoerRef())

	waitFor(t, 3*time.Second, "both source readings published", func() bool {
		return len(obsM()) > 0 && len(obsB()) > 0
	})
	m := obsM()[len(obsM())-1]
	if m["relay_on"] != true || m["load_kw"] != 2.0 {
		t.Fatalf("metering source reading wrong: %v", m)
	}
	b := obsB()[len(obsB())-1]
	if b["relay_on"] != true {
		t.Fatalf("relay state must ride the non-metering reading: %v", b)
	}
	if _, has := b["load_kw"]; has {
		t.Fatalf("a non-metering source must never claim a load: %v", b)
	}
}
