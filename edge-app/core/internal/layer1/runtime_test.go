package layer1

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

const testSerial = 2985159064

// rig is a real local bus (the core's embedded broker), a real MQTT client
// for Layer 1 and a simulated Solarman logger - everything but the core.
type rig struct {
	t    *testing.T
	bus  *localbus.Bus
	sim  *v5sim.Sim
	rt   *Runtime
	stop context.CancelFunc

	mu   sync.Mutex
	msgs map[string][][]byte
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func newRig(t *testing.T, opts Options) *rig {
	t.Helper()
	addr := freeAddr(t)
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	sim, err := v5sim.Start("127.0.0.1:0", testSerial)
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, bus: bus, sim: sim, msgs: map[string][][]byte{}}
	for i, topic := range []string{localbus.TopicTelemetry, localbus.TopicStatus, localbus.TopicTestReadResult} {
		topic := topic
		if err := bus.Subscribe(topic, 900+i, func(_ string, p []byte) {
			r.mu.Lock()
			r.msgs[topic] = append(r.msgs[topic], append([]byte(nil), p...))
			r.mu.Unlock()
		}); err != nil {
			t.Fatal(err)
		}
	}
	client, err := DialMQTT(addr, "vp-layer1-test")
	if err != nil {
		t.Fatal(err)
	}
	if opts.FirstPoll == 0 {
		opts.FirstPoll = 50 * time.Millisecond
	}
	if opts.Poll == 0 {
		opts.Poll = 150 * time.Millisecond
	}
	if opts.ConnectTimeout == 0 {
		opts.ConnectTimeout = 500 * time.Millisecond
	}
	if opts.ReadTimeout == 0 {
		opts.ReadTimeout = 400 * time.Millisecond
	}
	r.rt = New(client, opts)
	ctx, cancel := context.WithCancel(context.Background())
	r.stop = cancel
	go func() { _ = r.rt.Run(ctx) }()
	select {
	case <-r.rt.Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("Layer 1 wurde nicht bereit")
	}
	t.Cleanup(func() {
		cancel()
		client.Close()
		_ = sim.Close()
		_ = bus.Close()
	})
	return r
}

func (r *rig) selectDeye(family string, conn map[string]any) {
	r.t.Helper()
	_, port, _ := net.SplitHostPort(r.sim.Addr())
	c := map[string]any{"ip": "127.0.0.1", "port": port, "serial": testSerial, "mb_slave_id": 1}
	for k, v := range conn {
		c[k] = v
	}
	raw, _ := json.Marshal(map[string]any{
		"brand": "deye", "model": "sun-12k-sg04lp3", "family": family, "communication": "solarman_v5", "connection": c,
	})
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) wait(topic string, n int, within time.Duration) [][]byte {
	r.t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		got := r.msgs[topic]
		r.mu.Unlock()
		if len(got) >= n {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatalf("%s: weniger als %d Nachrichten in %s", topic, n, within)
	return nil
}

func (r *rig) count(topic string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.msgs[topic])
}

// liveLV is a hybrid_3p LV register picture: PV 2,2 kW, load 1,8 kW,
// export 2,3 kW at the connection point, battery discharging 1,5 kW, SoC 57 %.
func liveLV(sim *v5sim.Sim) {
	sim.Set(map[uint16]uint16{
		0x0000: 0x0005,
		0x024b: 5230, 0x024c: 57, 0x024e: 0xfa24, // -1500 W
		0x026b: 0xf704, 0x02c4: 0xffff, // -2300 W
		0x028d: 1800, 0x02a0: 1000, 0x02a1: 1200,
	})
}

func decodeJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("kein JSON: %s", raw)
	}
	return m
}

func TestTheRetainedSelectionDrivesTheDeyeReadOntoTheBus(t *testing.T) {
	r := newRig(t, Options{})
	liveLV(r.sim)
	r.selectDeye("hybrid_3p", nil)

	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	want := map[string]float64{"pv_power_kw": 2.2, "load_kw": 1.8, "power_kw": -2.3, "soc_pct": 57, "battery_power_kw": -1.5}
	for k, v := range want {
		if got, ok := msg[k].(float64); !ok || got != v {
			t.Errorf("%s = %v, want %v (Nachricht %v)", k, msg[k], v, msg)
		}
	}
	if ts, _ := msg["ts"].(string); len(ts) != len("2026-10-03T09:07:43.108Z") {
		t.Errorf("ts muss toISOString-Form haben, got %q", ts)
	}
	status := decodeJSON(t, r.wait(localbus.TopicStatus, 1, time.Second)[0])
	if status["inverter_link"] != "up" {
		t.Errorf("Status nach erster Messung = %v, want up", status)
	}
}

func TestASilentLoggerTurnsTheLinkDownOnceAndPublishesNoValue(t *testing.T) {
	r := newRig(t, Options{LinkTimeout: 400 * time.Millisecond})
	liveLV(r.sim)
	r.selectDeye("hybrid_3p", nil)
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)

	r.sim.SetSilent(true)
	before := r.count(localbus.TopicTelemetry)
	deadline := time.Now().Add(5 * time.Second)
	var down bool
	for time.Now().Before(deadline) && !down {
		r.mu.Lock()
		for _, raw := range r.msgs[localbus.TopicStatus] {
			if decodeJSON(t, raw)["inverter_link"] == "down" {
				down = true
			}
		}
		r.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	if !down {
		t.Fatal("ein stummer Logger muss nach der Frist inverter_link=down melden")
	}
	time.Sleep(600 * time.Millisecond)
	// At most one in-flight read could still land; never a stream of values.
	if extra := r.count(localbus.TopicTelemetry) - before; extra > 1 {
		t.Errorf("stummer Logger lieferte %d Messwerte", extra)
	}
	downs := 0
	r.mu.Lock()
	for _, raw := range r.msgs[localbus.TopicStatus] {
		if decodeJSON(t, raw)["inverter_link"] == "down" {
			downs++
		}
	}
	r.mu.Unlock()
	if downs != 1 {
		t.Errorf("down genau einmal melden, got %d", downs)
	}
}

func TestAnImplausibleSocPublishesNothing(t *testing.T) {
	r := newRig(t, Options{})
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{0x024c: 0}) // BMS meldet nichts, Block lebt
	r.selectDeye("hybrid_3p", nil)
	time.Sleep(800 * time.Millisecond)
	if n := r.count(localbus.TopicTelemetry); n != 0 {
		t.Fatalf("ohne Opt-in darf ein fehlender SoC keine Lesung durchlassen, got %d", n)
	}
	if r.sim.Requests() == 0 {
		t.Fatal("der Logger wurde gar nicht gefragt - der Test beweist nichts")
	}
}

func TestTheMissingSocOptInKeepsTheReadingWithoutAFabricatedSoc(t *testing.T) {
	r := newRig(t, Options{})
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{0x024c: 0})
	r.selectDeye("hybrid_3p", map[string]any{
		"allow_missing_soc": true,
		"soc_from_voltage":  map[string]any{"v_empty": 46, "v_full": 54},
	})
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["soc_source"] != "voltage" || msg["soc_pct"] != 78.8 {
		t.Fatalf("Schaetzung aus der Spannung erwartet (78,8 %%, voltage), got %v", msg)
	}
}

func TestAnUnportedTransportStaysIdleInsteadOfGuessing(t *testing.T) {
	r := newRig(t, Options{})
	raw, _ := json.Marshal(map[string]any{
		"brand": "fronius", "model": "x", "family": "fronius_solar_api", "communication": "fronius_solar_api",
		"connection": map[string]any{"ip": "127.0.0.1"},
	})
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) != 0 || r.count(localbus.TopicStatus) != 0 {
		t.Fatal("eine nicht portierte Anbindung darf nichts veroeffentlichen")
	}
}

func testRead(t *testing.T, r *rig, id string, sel map[string]any) map[string]any {
	t.Helper()
	sel["request_id"] = id
	raw, _ := json.Marshal(sel)
	before := r.count(localbus.TopicTestReadResult)
	if err := r.bus.Publish(localbus.TopicTestReadRequest, raw, false); err != nil {
		t.Fatal(err)
	}
	for _, m := range r.wait(localbus.TopicTestReadResult, before+1, 8*time.Second)[before:] {
		res := decodeJSON(t, m)
		if res["request_id"] == id {
			return res
		}
	}
	t.Fatalf("keine Antwort fuer %s", id)
	return nil
}

func deyeSel(r *rig, conn map[string]any) map[string]any {
	_, port, _ := net.SplitHostPort(r.sim.Addr())
	c := map[string]any{"ip": "127.0.0.1", "port": port, "serial": testSerial}
	for k, v := range conn {
		c[k] = v
	}
	return map[string]any{"brand": "deye", "model": "m", "family": "hybrid_3p", "communication": "solarman_v5", "connection": c}
}

func TestConnectionTestClassifiesLikeTestReadJS(t *testing.T) {
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour})
	liveLV(r.sim)

	ok := testRead(t, r, "ok", deyeSel(r, nil))
	if ok["ok"] != true {
		t.Fatalf("gesunder Logger: %v", ok)
	}
	reading, _ := ok["reading"].(map[string]any)
	if reading["pv_kw"] != 2.2 || reading["grid_kw"] != -2.3 || reading["soc_pct"] != 57.0 {
		t.Errorf("Messwerte im Test: %v", reading)
	}

	grid := testRead(t, r, "grid", func() map[string]any { s := deyeSel(r, nil); s["role"] = "grid-meter"; return s }())
	if gr, _ := grid["reading"].(map[string]any); len(gr) != 1 || gr["grid_kw"] != -2.3 {
		t.Errorf("Netz-Zaehler zeigt nur Netzbezug: %v", grid["reading"])
	}

	r.sim.Set(map[uint16]uint16{0x024c: 0})
	imp := testRead(t, r, "missing", deyeSel(r, map[string]any{"allow_missing_soc": true}))
	finding, _ := imp["finding"].(map[string]any)
	if imp["error_code"] != "implausible" || finding["rule"] != "missing" || imp["reading"] == nil {
		t.Errorf("fehlender SoC: Test sagt die Wahrheit trotz Opt-in, mit Messwerten + Befund, got %v", imp)
	}
	r.sim.Set(map[uint16]uint16{0x024c: 57})

	r.sim.SetSilent(true)
	if res := testRead(t, r, "silent", deyeSel(r, nil)); res["error_code"] != "no_answer" {
		t.Errorf("stummer Logger = no_answer, got %v", res)
	}
	r.sim.SetSilent(false)

	if res := testRead(t, r, "unreach", deyeSel(r, map[string]any{"port": freeAddrPort(t)})); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port = unreachable, got %v", res)
	}

	if res := testRead(t, r, "noserial", deyeSel(r, map[string]any{"serial": ""})); res["error_code"] != "invalid_request" || res["message"] != "Datenlogger-Seriennummer fehlt" {
		t.Errorf("fehlende Seriennummer = invalid_request mit Router-Satz, got %v", res)
	}

	other := map[string]any{"brand": "fronius", "model": "x", "family": "f", "communication": "fronius_solar_api", "connection": map[string]any{"ip": "1.2.3.4"}}
	if res := testRead(t, r, "unported", other); res["error_code"] != "invalid_request" || res["message"] == nil {
		t.Errorf("nicht portierte Anbindung = benanntes invalid_request statt Timeout, got %v", res)
	}
}

func freeAddrPort(t *testing.T) string {
	_, port, _ := net.SplitHostPort(freeAddr(t))
	return port
}

func TestPollAndConnectionTestNeverOpenTwoSocketsToOneLogger(t *testing.T) {
	r := newRig(t, Options{Poll: 30 * time.Millisecond, FirstPoll: 10 * time.Millisecond})
	liveLV(r.sim)
	r.selectDeye("hybrid_3p", nil)
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)
	for i := 0; i < 8; i++ {
		if res := testRead(t, r, "conc-"+string(rune('a'+i)), deyeSel(r, nil)); res["ok"] != true {
			t.Fatalf("Test %d waehrend laufender Polls: %v", i, res)
		}
	}
	if n := r.sim.RefusedConnections(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen: Poll und Test haben den Ein-Client-Logger gleichzeitig belegt", n)
	}
}
