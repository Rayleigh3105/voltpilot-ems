package layer1

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The generic Modbus TCP way end to end over the real local bus, against a
// one-client Modbus TCP stand-in (huaweiSim serves FC3 from a register image
// and answers every other function with exception 2).

// simMittag is the compact SunSpec block of edge/sim at noon: export 2,5 kW,
// PV 5,2 kW, load 1,7 kW, battery charging 1,0 kW, SoC 65,5 %, §14a limit
// 100 % of 30 kW.
func simMittag() map[uint16]uint16 {
	return map[uint16]uint16{0: uint16(0x10000 - 250), 1: 520, 2: 170, 3: 100, 4: 655, 5: 10000, 6: 3000}
}

func modbusSel(host, port string, family string) map[string]any {
	return map[string]any{"brand": "generic_modbus", "model": "sunspec", "family": family, "communication": "modbus_tcp",
		"connection": map[string]any{"ip": host, "port": port, "unit_id": 1}}
}

func (r *rig) selectModbus(sim *huaweiSim, family string) {
	r.t.Helper()
	host, port := sim.addr()
	raw, _ := json.Marshal(modbusSel(host, port, family))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func TestTheGenericModbusSelectionIsReadLikeTheFlow(t *testing.T) {
	sim := startHuaweiSim(t, simMittag())
	r := newRig(t, Options{})
	r.selectModbus(sim, "sunspec")

	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	want := map[string]float64{"power_kw": -2.5, "pv_power_kw": 5.2, "load_kw": 1.7, "soc_pct": 65.5,
		"grid_limit_kw": 30, "battery_power_kw": 1}
	for k, v := range want {
		if msg[k] != v {
			t.Errorf("%s = %v, erwartet %v (%v)", k, msg[k], v, msg)
		}
	}
	if _, ok := msg["ts"].(string); !ok || len(msg) != len(want)+1 {
		t.Errorf("genau die Felder des Flows und ts: %v", msg)
	}
	status := decodeJSON(t, r.wait(localbus.TopicStatus, 1, 5*time.Second)[0])
	if status["inverter_link"] != "up" {
		t.Errorf("Link: %v", status)
	}
	sim.mu.Lock()
	units := append([]byte(nil), sim.units...)
	sim.mu.Unlock()
	if len(units) == 0 || units[0] != 1 {
		t.Errorf("Unit-ID der Lesung: %v", units)
	}
}

func TestAnUnknownModbusProfileStaysIdle(t *testing.T) {
	sim := startHuaweiSim(t, simMittag())
	r := newRig(t, Options{})
	r.selectModbus(sim, "kompakt2")
	time.Sleep(500 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) != 0 || len(sim.units) != 0 {
		t.Fatal("ein unbekanntes Profil liest nichts und erfindet nichts")
	}
}

func TestAGenericModbusSourceIsReadByItsRole(t *testing.T) {
	sim := startHuaweiSim(t, simMittag())
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 100 * time.Millisecond})
	r.collectSources()
	host, port := sim.addr()
	src := func(id, role string) map[string]any {
		s := modbusSel(host, port, "sunspec")
		s["id"], s["role"], s["interval_s"] = id, role, 5
		return s
	}
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(src("src-pv", "pv-generation"), src("src-netz", "grid-meter"),
		src("src-last", "consumer")), true); err != nil {
		t.Fatal(err)
	}
	pv := decodeJSON(t, r.wait(sources.TopicPrefix+"src-pv/telemetry", 1, 5*time.Second)[0])
	if pv["pv_power_kw"] != 5.2 || len(pv) != 2 {
		t.Fatalf("Erzeuger-Quelle: nur pv_power_kw + ts: %v", pv)
	}
	netz := decodeJSON(t, r.wait(sources.TopicPrefix+"src-netz/telemetry", 1, 5*time.Second)[0])
	if netz["power_kw"] != -2.5 || len(netz) != 2 {
		t.Fatalf("Netz-Quelle: nur power_kw (+ = Bezug) + ts: %v", netz)
	}
	time.Sleep(300 * time.Millisecond)
	if r.count(sources.TopicPrefix+"src-last/telemetry") != 0 {
		t.Fatal("als Verbraucher nicht verdrahtet (ReadsAsSource) - nichts veroeffentlichen")
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen - zwei Quellen an einem Geraet muessen sich die Spur teilen", n)
	}
}

func TestGenericModbusConnectionTestClassifiesLikeTestReadJS(t *testing.T) {
	sim := startHuaweiSim(t, simMittag())
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour})
	host, port := sim.addr()

	ok := testRead(t, r, "ok", modbusSel(host, port, "sunspec"))
	reading, _ := ok["reading"].(map[string]any)
	if ok["ok"] != true || reading["pv_kw"] != 5.2 || reading["grid_kw"] != -2.5 || reading["load_kw"] != 1.7 ||
		reading["soc_pct"] != 65.5 {
		t.Fatalf("gesundes Geraet: %v", ok)
	}
	grid := testRead(t, r, "grid", func() map[string]any { s := modbusSel(host, port, "sunspec"); s["role"] = "grid-meter"; return s }())
	if gr, _ := grid["reading"].(map[string]any); len(gr) != 1 || gr["grid_kw"] != -2.5 {
		t.Errorf("Netz-Zaehler zeigt nur Netzbezug: %v", grid["reading"])
	}

	sim.refuse[0] = true
	if res := testRead(t, r, "refused", modbusSel(host, port, "sunspec")); res["error_code"] != "invalid_response" {
		t.Errorf("Modbus-Ausnahme = invalid_response wie test-read.js, got %v", res)
	}
	sim.refuse[0] = false

	sim.mu.Lock()
	sim.silent = true
	sim.mu.Unlock()
	if res := testRead(t, r, "silent", modbusSel(host, port, "sunspec")); res["error_code"] != "no_answer" {
		t.Errorf("stummes Geraet = no_answer, got %v", res)
	}
	sim.mu.Lock()
	sim.silent = false
	sim.mu.Unlock()

	if res := testRead(t, r, "unreach", modbusSel("127.0.0.1", freeAddrPort(t), "sunspec")); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port = unreachable, got %v", res)
	}
	if res := testRead(t, r, "profile", modbusSel(host, port, "kompakt2")); res["error_code"] != "invalid_request" ||
		res["message"] != "unbekanntes Modbus-Profil: kompakt2" {
		t.Errorf("unbekanntes Profil = invalid_request mit Router-Satz, got %v", res)
	}
}

// probeResult sends one edge/probe/request and returns its answer.
func probeResult(t *testing.T, r *rig, l *busLog, id string, ops ...map[string]any) []map[string]any {
	t.Helper()
	before := l.count(localbus.TopicProbeResult)
	raw, _ := json.Marshal(map[string]any{"request_id": id, "ops": ops})
	if err := r.bus.Publish(localbus.TopicProbeRequest, raw, false); err != nil {
		t.Fatal(err)
	}
	for _, m := range l.wait(t, localbus.TopicProbeResult, before+1, 10*time.Second)[before:] {
		var res struct {
			RequestID string           `json:"request_id"`
			Results   []map[string]any `json:"results"`
		}
		if json.Unmarshal(m, &res) == nil && res.RequestID == id {
			return res.Results
		}
	}
	t.Fatalf("keine Probe-Antwort fuer %s", id)
	return nil
}

func TestTheProbeChannelReadsSingleRegistersLikeTheProbeNode(t *testing.T) {
	sim := startHuaweiSim(t, map[uint16]uint16{40083: 1234, 40084: 0xfffe, 40085: 0x4365, 40086: 0xb333})
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour})
	l := r.listen(localbus.TopicProbeResult)
	host, port := sim.addr()
	p, _ := strconv.Atoi(port)
	zu, _ := strconv.Atoi(freeAddrPort(t))
	op := func(id string, o map[string]any) map[string]any {
		out := map[string]any{"id": id, "host": host, "port": p, "unit_id": 1, "fc": 3, "address": 40083,
			"data_type": "u16", "word_order": "big"}
		for k, v := range o {
			out[k] = v
		}
		return out
	}
	res := probeResult(t, r, l, "p-1",
		op("u16", nil),
		op("s32", map[string]any{"address": 40083, "data_type": "s32", "word_order": "little"}),
		op("f32", map[string]any{"address": 40085, "data_type": "float32"}),
		op("fc4", map[string]any{"fc": 4}),
		op("typ", map[string]any{"data_type": "uint16"}),
		op("zu", map[string]any{"port": zu}),
		op("netz", map[string]any{"host": "8.8.8.8"}),
	)
	if len(res) != 7 {
		t.Fatalf("eine Antwort je Schritt, in der Reihenfolge der Frage: %v", res)
	}
	if r := res[0]; r["id"] != "u16" || r["ok"] != true || r["raw"] != 1234.0 || len(r["registers"].([]any)) != 1 {
		t.Errorf("u16: %v", r)
	}
	if r := res[1]; r["ok"] != true || r["raw"] != -129838.0 {
		t.Errorf("s32 little (niederwertiges Wort zuerst): %v", r)
	}
	if r := res[2]; r["ok"] != true || r["raw"] != 229.6999969482422 {
		t.Errorf("float32: %v", r)
	}
	if r := res[3]; r["ok"] != false || r["error_code"] != "no_answer" ||
		!strings.Contains(r["message"].(string), "dieses Register gibt es dort vermutlich nicht. (Modbus-Ausnahme 0x02)") {
		t.Errorf("Modbus-Ausnahme: %v", r)
	}
	if r := res[4]; r["error_code"] != "invalid_request" {
		t.Errorf("unbekannter Datentyp: %v", r)
	}
	if r := res[5]; r["error_code"] != "unreachable" ||
		!strings.HasPrefix(r["message"].(string), "Das Gerät ist unter dieser Adresse nicht erreichbar. (Verbindung fehlgeschlagen: ") {
		t.Errorf("geschlossener Port: %v", r)
	}
	if r := res[6]; r["error_code"] != "unreachable" {
		t.Errorf("Adresse ausserhalb des Kundennetzes wird nicht angesprochen: %v", r)
	}

	sim.mu.Lock()
	sim.silent = true
	sim.mu.Unlock()
	if r := probeResult(t, r, l, "p-2", op("still", nil))[0]; r["error_code"] != "no_answer" ||
		!strings.Contains(r["message"].(string), "(Antwort-Timeout (400 ms))") {
		t.Errorf("stummes Geraet: %v", r)
	}
}

func TestPollAndProbeShareTheOneClientLaneOfAGenericModbusDevice(t *testing.T) {
	sim := startHuaweiSim(t, simMittag())
	r := newRig(t, Options{Poll: 30 * time.Millisecond, FirstPoll: 10 * time.Millisecond})
	l := r.listen(localbus.TopicProbeResult)
	r.selectModbus(sim, "sunspec")
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)
	host, port := sim.addr()
	p, _ := strconv.Atoi(port)
	for i := 0; i < 6; i++ {
		res := probeResult(t, r, l, "lane-"+strconv.Itoa(i), map[string]any{"id": "x", "host": host, "port": p,
			"unit_id": 1, "fc": 3, "address": 1, "data_type": "u16", "word_order": "big"})
		if res[0]["ok"] != true || res[0]["raw"] != 520.0 {
			t.Fatalf("Probe %d waehrend laufender Polls: %v", i, res[0])
		}
		if res := testRead(t, r, "t-"+strconv.Itoa(i), modbusSel(host, port, "sunspec")); res["ok"] != true {
			t.Fatalf("Test %d waehrend laufender Polls: %v", i, res)
		}
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen: Poll, Test und Probe haben das Ein-Client-Geraet gleichzeitig belegt", n)
	}
}
