package layer1

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The plant of Werner Schramm (06.11.2026) end to end through Layer 1: the
// three KACO Powador TL3 answer with their REAL register images (the shared
// SunSpec vectors) and the three Shelly meters with their REAL status answers
// (the shellyem vectors).

func thisDir() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Dir(here)
}

// schrammKaco returns the register map of the n-th real KACO (0..2).
func schrammKaco(t *testing.T, n int) map[uint16]uint16 {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(thisDir(), "..", "..", "..", "nodered", "sunspec", "sunspec-live-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			Name      string               `json:"name"`
			Registers [][2]json.RawMessage `json:"registers"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	seen := -1
	for _, c := range doc.Cases {
		if !strings.HasPrefix(c.Name, "Schramm: ") {
			continue
		}
		seen++
		if seen != n {
			continue
		}
		m := map[uint16]uint16{}
		for _, seg := range c.Registers {
			var addr int
			var words []int
			_ = json.Unmarshal(seg[0], &addr)
			_ = json.Unmarshal(seg[1], &words)
			for i, w := range words {
				m[uint16(addr+i)] = uint16(w)
			}
		}
		return m
	}
	t.Fatalf("Schramm-KACO %d fehlt in den Vektoren", n)
	return nil
}

// schrammShelly returns the real Shelly.GetStatus answer of the n-th meter
// (0 = grid point Pro 3EM-400, 1 = UV Halle, 2 = UV Keller).
func schrammShelly(t *testing.T, n int) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(thisDir(), "..", "shellyem", "testdata", "shelly-em-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			Name   string          `json:"name"`
			Status json.RawMessage `json:"status"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Cases[n].Status
}

// shellySim serves one status answer; every other path is a 404 and counted,
// so a test sees any request that is not the read-only status RPC.
type shellySim struct {
	srv     *httptest.Server
	status  atomic.Value // []byte
	code    atomic.Int32
	foreign atomic.Int32
	hits    atomic.Int32
}

func startShellySim(t *testing.T, body []byte) *shellySim {
	t.Helper()
	s := &shellySim{}
	s.status.Store(body)
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/rpc/Shelly.GetStatus" {
			s.foreign.Add(1)
			http.NotFound(w, r)
			return
		}
		s.hits.Add(1)
		if c := s.code.Load(); c != 0 {
			w.WriteHeader(int(c))
			return
		}
		_, _ = w.Write(s.status.Load().([]byte))
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *shellySim) addr() (string, string) {
	h, p, _ := net.SplitHostPort(strings.TrimPrefix(s.srv.URL, "http://"))
	return h, p
}

func kacoSunSpecSel(host string, port any, conn map[string]any) map[string]any {
	c := map[string]any{"ip": host, "port": port, "unit_id": 1, "model_type": "auto"}
	for k, v := range conn {
		c[k] = v
	}
	return map[string]any{"brand": "kaco", "model": "powador-14.0-tl3", "family": "sunspec_live", "communication": "sunspec_tcp", "connection": c}
}

func shellyMeterSel(host string, port any, conn map[string]any) map[string]any {
	c := map[string]any{"ip": host, "port": port}
	for k, v := range conn {
		c[k] = v
	}
	return map[string]any{"brand": "shelly", "model": "shelly-pro-3em", "family": "shelly_em_triphase", "communication": "shelly_em_http", "connection": c}
}

func asSource(sel map[string]any, id, role string) map[string]any {
	sel["id"], sel["role"], sel["interval_s"] = id, role, 5
	return sel
}

func (r *rig) collectReceipts() {
	r.t.Helper()
	if err := r.bus.Subscribe(datasourcestatus.Topic, 951, func(topic string, p []byte) {
		r.mu.Lock()
		r.msgs[topic] = append(r.msgs[topic], append([]byte(nil), p...))
		r.mu.Unlock()
	}); err != nil {
		r.t.Fatal(err)
	}
}

func TestAKacoSunSpecSelectionIsReadOntoTheBus(t *testing.T) {
	sim := startHuaweiSim(t, schrammKaco(t, 0))
	r := newRig(t, Options{})
	host, port := sim.addr()
	raw, _ := json.Marshal(kacoSunSpecSel(host, port, nil))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 1.19 || len(msg) != 2 {
		t.Fatalf("KACO als Wechselrichter: pv_power_kw 1,19 + ts, nichts sonst: %v", msg)
	}
	if st := decodeJSON(t, r.wait(localbus.TopicStatus, 1, 2*time.Second)[0]); st["inverter_link"] != "up" {
		t.Fatalf("status: %v", st)
	}
	sim.mu.Lock()
	units := append([]byte(nil), sim.units...)
	sim.mu.Unlock()
	if len(units) != 6 {
		t.Fatalf("eine Lesung = sechs FC3-Anfragen (SID, zwei Koepfe, zwei Bodies, Ende): %d", len(units))
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d zweite Verbindungen", n)
	}
}

func TestSchrammSourcesAreReadByRoleAndLeaveReceipts(t *testing.T) {
	k2, k3 := startHuaweiSim(t, schrammKaco(t, 1)), startHuaweiSim(t, schrammKaco(t, 2))
	netz, halle, keller := startShellySim(t, schrammShelly(t, 0)), startShellySim(t, schrammShelly(t, 1)), startShellySim(t, schrammShelly(t, 2))
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 150 * time.Millisecond})
	r.collectSources()
	r.collectReceipts()
	h2, p2 := k2.addr()
	h3, p3 := k3.addr()
	hn, pn := netz.addr()
	hh, ph := halle.addr()
	hk, pk := keller.addr()
	cfg := sourcesConfig(
		asSource(kacoSunSpecSel(h2, p2, nil), "src-wr2", "pv-generation"),
		asSource(kacoSunSpecSel(h3, p3, nil), "src-wr3", "pv-generation"),
		func() map[string]any {
			s := asSource(shellyMeterSel(hn, pn, nil), "src-netz", "grid-meter")
			s["data_source_id"] = "DQ-7"
			return s
		}(),
		asSource(shellyMeterSel(hh, ph, nil), "src-halle", "consumer"),
		asSource(shellyMeterSel(hk, pk, map[string]any{"invert_grid_sign": true}), "src-keller", "consumer"),
		asSource(shellyMeterSel(hk, pk, nil), "src-falsch", "pv-generation"),
	)
	if err := r.bus.Publish(sources.TopicConfig, cfg, true); err != nil {
		t.Fatal(err)
	}
	// A meter carries its details next to the role's channel (Unterverteilungen
	// B1): the counters in kWh and the power per phase - the real answers of
	// Schramm's three meters. With invert_grid_sign (src-keller) the phases turn
	// and the counters swap: "returned" is then what that part drew.
	want := map[string]map[string]float64{
		"src-wr2": {"pv_power_kw": 1.67},
		"src-wr3": {"pv_power_kw": 1.64},
		"src-netz": {"power_kw": 6.994, "energy_kwh": 42654.393, "energy_export_kwh": 80964.02,
			"power_l1_kw": 2.918, "power_l2_kw": 2.237, "power_l3_kw": 1.839},
		"src-halle": {"load_kw": 12.024, "energy_kwh": 70802.308, "energy_export_kwh": 1.069,
			"power_l1_kw": 4.021, "power_l2_kw": 4.407, "power_l3_kw": 3.596},
		"src-keller": {"load_kw": -0.071, "energy_kwh": 6.8, "energy_export_kwh": 7647.388,
			"power_l1_kw": -0.057, "power_l2_kw": -0.015, "power_l3_kw": 0.001},
	}
	samples := map[string]int{}
	for id, w := range want {
		msg := decodeJSON(t, r.wait(sources.TopicPrefix+id+"/telemetry", 1, 5*time.Second)[0])
		if len(msg) != len(w)+1 {
			t.Fatalf("%s: %v, erwartet genau %v + ts", id, msg, w)
		}
		for k, v := range w {
			if msg[k] != v {
				t.Fatalf("%s: %v, erwartet %s=%v + ts", id, msg, k, v)
			}
		}
		samples[id] = len(w)
	}
	samples["DQ-7"] = samples["src-netz"]
	if n := r.count(sources.TopicPrefix + "src-falsch/telemetry"); n != 0 {
		t.Fatalf("ein Zaehler als Erzeuger liefert nichts: %d", n)
	}
	// Receipts: one per read, by DQ id when the push named one.
	receipts := r.wait(datasourcestatus.Topic, 5, 5*time.Second)
	byID := map[string]datasourcestatus.Event{}
	for _, raw := range receipts {
		var ev datasourcestatus.Event
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("Beleg: %s", raw)
		}
		key := ev.ID
		if key == "" {
			key = ev.SourceID
		}
		byID[key] = ev
		if ev.EventID == "" || ev.Ts.IsZero() || ev.Requests == nil {
			t.Fatalf("Beleg unvollstaendig: %s", raw)
		}
	}
	for id, req := range map[string]int{"src-wr2": 6, "src-wr3": 6, "DQ-7": 1, "src-halle": 1, "src-keller": 1} {
		ev, ok := byID[id]
		if !ok || ev.Failed || ev.Samples != samples[id] || *ev.Requests != req {
			t.Fatalf("Beleg %s: %+v (Anfragen %d erwartet)", id, ev, req)
		}
	}
	if _, ok := byID["src-netz"]; ok {
		t.Fatal("eine zugeordnete Quelle meldet sich mit ihrer DQ-Kennung, nicht mit der lokalen")
	}
	for _, s := range []*shellySim{netz, halle, keller} {
		if n := s.foreign.Load(); n != 0 {
			t.Fatalf("%d Anfragen ausser Shelly.GetStatus - nur lesen", n)
		}
	}
}

func TestAFailingShellyMeterLeavesAFailedReceiptAndNoValue(t *testing.T) {
	sim := startShellySim(t, schrammShelly(t, 0))
	sim.code.Store(401)
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 150 * time.Millisecond})
	r.collectSources()
	r.collectReceipts()
	h, p := sim.addr()
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(asSource(shellyMeterSel(h, p, nil), "src-netz", "grid-meter")), true); err != nil {
		t.Fatal(err)
	}
	var ev datasourcestatus.Event
	_ = json.Unmarshal(r.wait(datasourcestatus.Topic, 1, 5*time.Second)[0], &ev)
	if !ev.Failed || ev.ErrorClass != "invalid_response" || ev.Samples != 0 || ev.SourceID != "src-netz" {
		t.Fatalf("geschuetzter Shelly: %+v", ev)
	}
	time.Sleep(200 * time.Millisecond)
	if r.count(sources.TopicPrefix+"src-netz/telemetry") != 0 {
		t.Fatal("ohne Antwort kein Wert")
	}
	// A dead address: unreachable.
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(asSource(shellyMeterSel(dh, dp, nil), "src-tot", "grid-meter")), true); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, raw := range r.wait(datasourcestatus.Topic, 1, time.Second) {
			var e datasourcestatus.Event
			_ = json.Unmarshal(raw, &e)
			if e.SourceID == "src-tot" {
				if !e.Failed || e.ErrorClass != "unreachable" {
					t.Fatalf("toter Zaehler: %+v", e)
				}
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("kein Beleg fuer den toten Zaehler")
}

func TestSunSpecAndShellyMeterConnectionTests(t *testing.T) {
	kaco := startHuaweiSim(t, schrammKaco(t, 0))
	netz := startShellySim(t, schrammShelly(t, 0))
	halle := startShellySim(t, schrammShelly(t, 1))
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, ConnectTimeout: 400 * time.Millisecond, ReadTimeout: 300 * time.Millisecond, HTTPTimeout: 400 * time.Millisecond})
	kh, kp := kaco.addr()

	ok := testRead(t, r, "kaco", kacoSunSpecSel(kh, kp, nil))
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["pv_kw"] != 1.19 || len(rd) != 1 {
		t.Fatalf("KACO-Test: %v", ok)
	}
	// Fronius Eco keeps its persisted id - the same way.
	fro := kacoSunSpecSel(kh, kp, nil)
	fro["brand"], fro["communication"] = "fronius_sunspec", "fronius_sunspec"
	if res := testRead(t, r, "fronius", fro); res["ok"] != true {
		t.Fatalf("fronius_sunspec: %v", res)
	}
	// No SunSpec device behind the address: an image without "SunS".
	kaco.set(map[uint16]uint16{40000: 0, 40001: 0, 50000: 0, 50001: 0, 0: 0, 1: 0})
	if res := testRead(t, r, "nosuns", kacoSunSpecSel(kh, kp, nil)); res["error_code"] != "invalid_response" ||
		!strings.Contains(res["message"].(string), "SunS") {
		t.Fatalf("kein SunSpec: %v", res)
	}
	kaco.mu.Lock()
	kaco.silent = true
	kaco.mu.Unlock()
	if res := testRead(t, r, "silent", kacoSunSpecSel(kh, kp, nil)); res["error_code"] != "no_answer" {
		t.Fatalf("stummer KACO (nachts): %v", res)
	}
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", kacoSunSpecSel(dh, dp, nil)); res["error_code"] != "unreachable" {
		t.Fatalf("geschlossener Port: %v", res)
	}

	nh, np := netz.addr()
	grid := func() map[string]any { s := shellyMeterSel(nh, np, nil); s["role"] = "grid-meter"; return s }()
	if res := testRead(t, r, "netz", grid); res["ok"] != true || res["reading"].(map[string]any)["grid_kw"] != 6.994 {
		t.Fatalf("Netz-Zaehler: %v", res)
	}
	hh, hp := halle.addr()
	sub := func() map[string]any { s := shellyMeterSel(hh, hp, nil); s["role"] = "consumer"; return s }()
	if res := testRead(t, r, "halle", sub); res["ok"] != true || res["reading"].(map[string]any)["load_kw"] != 12.024 {
		t.Fatalf("Unterzaehler: %v", res)
	}
	halle.code.Store(401)
	if res := testRead(t, r, "geschuetzt", sub); res["error_code"] != "invalid_response" ||
		!strings.Contains(res["message"].(string), "Passwortschutz") {
		t.Fatalf("Passwortschutz: %v", res)
	}
	halle.code.Store(0)
	halle.status.Store([]byte(`{"em1:0":{"act_power":12},"em1:1":{"act_power":3}}`))
	if res := testRead(t, r, "mono", sub); res["error_code"] != "invalid_response" ||
		!strings.Contains(res["message"].(string), "monophase") {
		t.Fatalf("Einzelkanaele: %v", res)
	}
	if res := testRead(t, r, "dead-shelly", shellyMeterSel(dh, dp, nil)); res["error_code"] != "unreachable" {
		t.Fatalf("toter Zaehler: %v", res)
	}
	if netz.foreign.Load()+halle.foreign.Load() != 0 {
		t.Fatal("ein Verbindungstest liest nur Shelly.GetStatus")
	}
}

// The KOSTAL PIKO 20 at Schramm (192.168.1.122, added 07.11.2026 as a further
// Erzeuger): Edge Light reads it as a source over the same /api/dxs.json bundle
// as the primary path - pv_power_kw only, one request per read, a receipt per
// read. Before, the source was "NICHT VERDRAHTET" and the portal waited for its
// first value forever.
func TestSchrammPikoIsReadAsAnErzeugerSource(t *testing.T) {
	p := startPikoSim(t)
	o := fastKostalDxs()
	o.SourcesFirstPoll, o.SourcesPoll = 50*time.Millisecond, 150*time.Millisecond
	r := newRig(t, o)
	r.collectSources()
	r.collectReceipts()
	h, port := p.hostPort()
	piko := asSource(pikoDxsSel(h, port), "src-piko", "pv-generation")
	piko["data_source_id"] = "DQ-9"
	falsch := asSource(pikoDxsSel(h, port), "src-piko-netz", "grid-meter")
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(piko, falsch), true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(sources.TopicPrefix+"src-piko/telemetry", 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 1.235 || len(msg) != 2 {
		t.Fatalf("PIKO als Erzeuger: nur pv_power_kw + ts: %v", msg)
	}
	var ev datasourcestatus.Event
	_ = json.Unmarshal(r.wait(datasourcestatus.Topic, 1, 5*time.Second)[0], &ev)
	if ev.ID != "DQ-9" || ev.Failed || ev.Samples != 1 || ev.Requests == nil || *ev.Requests != 1 {
		t.Fatalf("Beleg: %+v", ev)
	}
	if n := r.count(sources.TopicPrefix + "src-piko-netz/telemetry"); n != 0 {
		t.Fatalf("ein PIKO als Netz-Zaehler liefert nichts: %d", n)
	}

	// Night: the webserver answers without the AC id - a failed read, never 0.
	p.mu.Lock()
	delete(p.values, 67109120)
	p.mu.Unlock()
	if e := r.receiptWhere(t, func(e datasourcestatus.Event) bool { return e.Failed }); e.ErrorClass != "invalid_response" || e.Samples != 0 {
		t.Fatalf("PIKO nachts: %+v", e)
	}
	// An unreachable webserver: unreachable.
	dh, dp, _ := net.SplitHostPort(freeAddr(t))
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(asSource(pikoDxsSel(dh, dp), "src-piko-tot", "pv-generation")), true); err != nil {
		t.Fatal(err)
	}
	if e := r.receiptWhere(t, func(e datasourcestatus.Event) bool { return e.SourceID == "src-piko-tot" }); !e.Failed || e.ErrorClass != "unreachable" {
		t.Fatalf("toter PIKO: %+v", e)
	}
}

// receiptWhere waits up to 5 s for a read receipt that matches.
func (r *rig) receiptWhere(t *testing.T, match func(datasourcestatus.Event) bool) datasourcestatus.Event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, raw := range r.wait(datasourcestatus.Topic, 1, time.Second) {
			var e datasourcestatus.Event
			_ = json.Unmarshal(raw, &e)
			if match(e) {
				return e
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("kein passender Lese-Beleg")
	return datasourcestatus.Event{}
}
