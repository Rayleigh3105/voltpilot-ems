package layer1

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// Die Lesewege der Teilstufe 4 (Fronius Solar API, KOSTAL PLENTICORE, KACO
// App-Schnittstelle, KACO NH3) Ende zu Ende ueber den lokalen Bus: Auswahl
// -> Messwert, Verbindungstest, Quelle -> edge/sources/<id>/telemetry, gegen
// gestellte Geraete.

// tabellenGeraet is a Modbus TCP device with one register table per function
// code (FC3 holding, FC4 input), answering only its unit id; a request outside
// the table is exception 2.
type tabellenGeraet struct {
	mu      sync.Mutex
	unit    byte
	tabelle map[byte]map[int]uint16
	port    string
}

func starteTabellenGeraet(t *testing.T, unit byte, tabelle map[byte]map[int]uint16) *tabellenGeraet {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	g := &tabellenGeraet{unit: unit, tabelle: tabelle, port: port}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go g.bediene(c)
		}
	}()
	return g
}

func (g *tabellenGeraet) bediene(c net.Conn) {
	defer c.Close()
	for {
		head := make([]byte, 7)
		if _, err := io.ReadFull(c, head); err != nil {
			return
		}
		pdu := make([]byte, int(binary.BigEndian.Uint16(head[4:6]))-1)
		if _, err := io.ReadFull(c, pdu); err != nil {
			return
		}
		fc, start, count := pdu[0], int(binary.BigEndian.Uint16(pdu[1:3])), int(binary.BigEndian.Uint16(pdu[3:5]))
		g.mu.Lock()
		antwort := []byte{fc, byte(2 * count)}
		tab := g.tabelle[fc]
		switch {
		case head[6] != g.unit:
			antwort = []byte{fc | 0x80, 0x0b}
		case tab == nil:
			antwort = []byte{fc | 0x80, 0x01}
		default:
			for i := 0; i < count; i++ {
				v, ok := tab[start+i]
				if !ok {
					antwort = []byte{fc | 0x80, 0x02}
					break
				}
				antwort = binary.BigEndian.AppendUint16(antwort, v)
			}
		}
		g.mu.Unlock()
		frame := append([]byte{head[0], head[1], 0, 0}, binary.BigEndian.AppendUint16(nil, uint16(len(antwort)+1))...)
		if _, err := c.Write(append(append(frame, head[6]), antwort...)); err != nil {
			return
		}
	}
}

func bereich(von, bis int) map[int]uint16 {
	m := map[int]uint16{}
	for a := von; a <= bis; a++ {
		m[a] = 0
	}
	return m
}

func (r *rig) waehle(sel map[string]any) {
	r.t.Helper()
	raw, _ := json.Marshal(sel)
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) quellen(entries ...map[string]any) {
	r.t.Helper()
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(entries...), true); err != nil {
		r.t.Fatal(err)
	}
}

func hostPortOf(t *testing.T, url string) (string, string) {
	t.Helper()
	h, p, err := net.SplitHostPort(strings.TrimPrefix(url, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	return h, p
}

func lesewegeOptionen() Options {
	return Options{Poll: time.Hour, FirstPoll: time.Hour, LinkTimeout: time.Second, HTTPTimeout: 500 * time.Millisecond,
		SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 150 * time.Millisecond}
}

// --- Fronius Solar API ----------------------------------------------------

func TestFroniusSolarAPIIsReadLikeTheFlow(t *testing.T) {
	var mu sync.Mutex
	body := `{"Head":{"Status":{"Code":0}},"Body":{"Data":{"Site":{"P_PV":5300,"P_Grid":-1200,"P_Load":-900,"P_Akku":-3200},"Inverters":{"1":{"SOC":62.44}}}}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/solar_api/v1/GetPowerFlowRealtimeData.fcgi" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	host, port := hostPortOf(t, srv.URL)
	sel := func() map[string]any {
		return map[string]any{"brand": "fronius", "model": "gen24", "family": "fronius_solar_api", "communication": "fronius_solar_api",
			"connection": map[string]any{"ip": host, "port": port}}
	}
	r := newRig(t, lesewegeOptionen())
	r.collectSources()

	r.waehle(sel())
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["power_kw"] != -1.2 || msg["pv_power_kw"] != 5.3 || msg["load_kw"] != 0.9 || msg["soc_pct"] != 62.4 || len(msg) != 5 {
		t.Fatalf("Fronius-Messwert (P_Akku nie veroeffentlicht): %v", msg)
	}

	ok := testRead(t, r, "ok", sel())
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["pv_kw"] != 5.3 || rd["load_kw"] != 0.9 || rd["grid_kw"] != -1.2 {
		t.Fatalf("Verbindungstest: %v", ok)
	}
	zu := sel()
	zu["connection"] = map[string]any{"ip": "127.0.0.1", "port": freeAddrPort(t)}
	if res := testRead(t, r, "zu", zu); res["error_code"] != "fronius_api" {
		t.Errorf("jeder Fehler der Solar API ist fronius_api: %v", res)
	}
	mu.Lock()
	body = `{"Head":{"Status":{"Code":8}},"Body":{"Data":{"Site":{"P_PV":1}}}}`
	mu.Unlock()
	if res := testRead(t, r, "bad", sel()); res["error_code"] != "fronius_api" {
		t.Errorf("BadStatus: %v", res)
	}
	mu.Lock()
	body = `{"Head":{"Status":{"Code":0}},"Body":{"Data":{"Site":{"P_PV":5300,"P_Grid":-1200,"P_Load":-900}}}}`
	mu.Unlock()

	// Als Quelle: der Erzeuger bekommt seine PV, ein Verbraucher die Last.
	r.quellen(
		map[string]any{"id": "src-fr", "role": "pv-generation", "family": "fronius_solar_api", "communication": "fronius_solar_api",
			"connection": map[string]any{"ip": host, "port": port}},
		map[string]any{"id": "src-fr-last", "role": "consumer", "family": "fronius_solar_api", "communication": "fronius_solar_api",
			"connection": map[string]any{"ip": host, "port": port}},
	)
	pv := decodeJSON(t, r.wait(sources.TopicPrefix+"src-fr/telemetry", 1, 5*time.Second)[0])
	last := decodeJSON(t, r.wait(sources.TopicPrefix+"src-fr-last/telemetry", 1, 5*time.Second)[0])
	if pv["pv_power_kw"] != 5.3 || len(pv) != 2 || last["load_kw"] != 0.9 || len(last) != 2 {
		t.Fatalf("Quellen: %v %v", pv, last)
	}
}

// --- KOSTAL PLENTICORE --------------------------------------------------------

func plenticoreBild() map[int]uint16 {
	m := map[int]uint16{5: 0, 56: 6, 57: 0}
	f32 := func(a int, v float32) { b := math.Float32bits(v); m[a], m[a+1] = uint16(b), uint16(b>>16) } // little (CDAB)
	f32(252, -1830.5)
	for a, v := range bereich(514, 588) {
		m[a] = v
	}
	m[514] = 62
	m[582] = uint16(0x10000 - 3200) // laedt 3,2 kW (Register: - laden)
	for a, v := range bereich(1068, 1083) {
		m[a] = v
	}
	m[1082] = 0x03 // KSEM
	return m
}

func TestKostalPlenticoreIsReadLikeTheFlow(t *testing.T) {
	g := starteTabellenGeraet(t, 71, map[byte]map[int]uint16{3: plenticoreBild()})
	sel := func(conn map[string]any) map[string]any {
		c := map[string]any{"ip": "127.0.0.1", "port": g.port}
		for k, v := range conn {
			c[k] = v
		}
		return map[string]any{"brand": "kostal", "model": "plenticore-bi", "family": "kostal_plenticore", "communication": "kostal_modbus", "connection": c}
	}
	r := newRig(t, lesewegeOptionen())
	r.waehle(sel(nil)) // Unit-ID 71 aus der Vorgabe des Herstellers
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["soc_pct"] != 62.0 || msg["power_kw"] != -1.83 || msg["battery_power_kw"] != 3.2 || len(msg) != 4 {
		t.Fatalf("PLENTICORE-Messwert (keine PV, keine Last): %v", msg)
	}

	ok := testRead(t, r, "ok", sel(nil))
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["soc_pct"] != 62.0 || rd["grid_kw"] != -1.83 || rd["pv_kw"] != nil {
		t.Fatalf("Verbindungstest: %v", ok)
	}
	if res := testRead(t, r, "unit", sel(map[string]any{"unit_id": 5})); res["error_code"] != "invalid_response" {
		t.Errorf("falsche Unit-ID: jeder Block abgelehnt = invalid_response, got %v", res)
	}
	if res := testRead(t, r, "zu", sel(map[string]any{"port": freeAddrPort(t)})); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port = unreachable, got %v", res)
	}
	g.mu.Lock()
	g.tabelle[3][1082] = 0xff // kein Sensor
	g.mu.Unlock()
	if res := testRead(t, r, "ohne-sensor", sel(nil)); res["reading"].(map[string]any)["grid_kw"] != nil {
		t.Errorf("ohne Sensor kein Netzwert (nie eine erfundene 0): %v", res)
	}
}

// --- KACO NH3 (AISWEI-Registerkarte) -------------------------------------------

func TestKacoNH3IsReadLikeTheFlow(t *testing.T) {
	input := bereich(1000, 1027)
	for a, v := range bereich(1600, 1624) {
		input[a] = v
	}
	input[1601] = 4200                                                    // PV 4200 W
	input[1618], input[1619] = 0xffff, uint16(0x10000-2500)               // Batterie -2500 W (laedt)
	input[1621] = 6250                                                    // SoC 62,50 %
	holding := map[int]uint16{6433: 0xffff, 6434: uint16(0x10000 - 1800)} // Netz -1800 W
	g := starteTabellenGeraet(t, 1, map[byte]map[int]uint16{4: input, 3: holding})
	sel := map[string]any{"brand": "kaco", "model": "nh3", "family": "kaco_nh3", "communication": "kaco_modbus",
		"connection": map[string]any{"ip": "127.0.0.1", "port": g.port}}
	r := newRig(t, lesewegeOptionen())
	r.collectSources()
	r.waehle(sel)
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 4.2 || msg["power_kw"] != -1.8 || msg["soc_pct"] != 62.5 || msg["battery_power_kw"] != 2.5 || len(msg) != 5 {
		t.Fatalf("NH3-Messwert: %v", msg)
	}
	if res := testRead(t, r, "ok", sel); res["ok"] != true {
		t.Fatalf("Verbindungstest: %v", res)
	}
	r.quellen(map[string]any{"id": "src-nh3", "role": "grid-meter", "family": "kaco_nh3", "communication": "kaco_modbus",
		"connection": map[string]any{"ip": "127.0.0.1", "port": g.port, "unit_id": 1}})
	netz := decodeJSON(t, r.wait(sources.TopicPrefix+"src-nh3/telemetry", 1, 5*time.Second)[0])
	if netz["power_kw"] != -1.8 || len(netz) != 2 {
		t.Fatalf("NH3 als Netz-Zaehler: %v", netz)
	}
}

// --- KACO App-Schnittstelle (HTTP 8484) ---------------------------------------

func TestKacoHTTPIsReadLikeTheFlow(t *testing.T) {
	var mu sync.Mutex
	var abrufe []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		abrufe = append(abrufe, req.URL.RequestURI())
		mu.Unlock()
		q := req.URL.Query()
		switch {
		case req.URL.Path == "/getdev.cgi" && q.Get("device") == "2":
			_, _ = io.WriteString(w, `{"inv":[{"isn":"B 77/1","add":3,"rate":10000}]}`)
		case req.URL.Path == "/getdevdata.cgi" && q.Get("sn") == "B 77/1":
			switch q.Get("device") {
			case "2":
				_, _ = io.WriteString(w, `{"pac":4800,"vpv":[3850,4120],"ipv":[612,503]}`)
			case "3":
				_, _ = io.WriteString(w, `{"pac":-900}`)
			case "4":
				_, _ = io.WriteString(w, `{"pb":-2100,"soc":64}`)
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	host, port := hostPortOf(t, srv.URL)
	sel := func(family string) map[string]any {
		return map[string]any{"brand": "kaco", "model": "nh3", "family": family, "communication": "kaco_http",
			"connection": map[string]any{"ip": host, "port": port}}
	}
	r := newRig(t, lesewegeOptionen())
	r.collectSources()
	r.waehle(sel("kaco_http_hybrid"))
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	// PV aus den Strings: 385,0 V x 6,12 A + 412,0 V x 5,03 A = 4428,56 W.
	if msg["pv_power_kw"] != 4.429 || msg["power_kw"] != -0.9 || msg["soc_pct"] != 64.0 || msg["battery_power_kw"] != 2.1 || len(msg) != 5 {
		t.Fatalf("KACO-Messwert (Hybrid): %v", msg)
	}
	mu.Lock()
	if len(abrufe) != 4 || !strings.HasPrefix(abrufe[0], "/getdev.cgi") || !strings.Contains(strings.Join(abrufe, " "), "sn=B%2077%2F1") {
		t.Errorf("Inventar zuerst, dann drei Abrufe mit kodierter Seriennummer: %v", abrufe)
	}
	mu.Unlock()

	ok := testRead(t, r, "ok", sel("kaco_http"))
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || ok["serial"] != "B 77/1" || rd["pv_kw"] != 4.8 {
		t.Fatalf("Verbindungstest gibt die gefundene Seriennummer zurueck: %v", ok)
	}
	zu := sel("kaco_http")
	zu["connection"] = map[string]any{"ip": "127.0.0.1", "port": freeAddrPort(t)}
	if res := testRead(t, r, "zu", zu); res["error_code"] != "invalid_response" {
		t.Errorf("jeder Fehler ist invalid_response wie readKaco: %v", res)
	}

	r.quellen(map[string]any{"id": "src-kaco", "role": "pv-generation", "family": "kaco_http", "communication": "kaco_http",
		"connection": map[string]any{"ip": host, "port": port, "serial": "B 77/1"}})
	pv := decodeJSON(t, r.wait(sources.TopicPrefix+"src-kaco/telemetry", 1, 5*time.Second)[0])
	if pv["pv_power_kw"] != 4.8 || len(pv) != 2 {
		t.Fatalf("KACO als Erzeuger: %v", pv)
	}
}

// --- Deye ueber den Solarman-Logger als weitere Quelle --------------------

func TestADeyeSourceIsReadOverItsLogger(t *testing.T) {
	r := newRig(t, lesewegeOptionen())
	liveLV(r.sim)
	r.collectSources()
	c := deyeSel(r, nil)["connection"]
	r.quellen(
		map[string]any{"id": "src-deye", "role": "pv-generation", "family": "hybrid_3p", "communication": "solarman_v5", "connection": c},
		map[string]any{"id": "src-deye-netz", "role": "grid-meter", "family": "hybrid_3p", "communication": "solarman_v5", "connection": c},
		map[string]any{"id": "src-deye-ohne", "role": "pv-generation", "family": "hybrid_3p", "communication": "solarman_v5",
			"connection": map[string]any{"ip": "127.0.0.1", "port": 1}},
	)
	pv := decodeJSON(t, r.wait(sources.TopicPrefix+"src-deye/telemetry", 1, 5*time.Second)[0])
	netz := decodeJSON(t, r.wait(sources.TopicPrefix+"src-deye-netz/telemetry", 1, 5*time.Second)[0])
	if pv["pv_power_kw"] != 2.2 || len(pv) != 2 || netz["power_kw"] != -2.3 || len(netz) != 2 {
		t.Fatalf("Deye-Quelle: %v %v", pv, netz)
	}
	if r.count(sources.TopicPrefix+"src-deye-ohne/telemetry") != 0 {
		t.Fatal("ohne Seriennummer wird nichts verdrahtet")
	}
}

// --- Suche nach weiteren Wechselrichtern (Fronius Datamanager) ----------------

// datamanager answers the SunSpec marker at 40000 for units 1 and 2; unit 3
// answers only after the probe's timeout (a slow inverter), every other unit
// and base is an exception. It records each probed (unit, address).
type datamanager struct {
	mu     sync.Mutex
	probes []string
	port   string
}

func starteDatamanager(t *testing.T, spaet time.Duration) *datamanager {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	d := &datamanager{port: port}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				for {
					req := make([]byte, 12)
					if _, err := io.ReadFull(c, req); err != nil {
						return
					}
					unit, adr := req[6], int(binary.BigEndian.Uint16(req[8:]))
					d.mu.Lock()
					d.probes = append(d.probes, strconv.Itoa(int(unit))+"@"+strconv.Itoa(adr))
					d.mu.Unlock()
					antwort := []byte{0x83, 0x0b}
					if (unit == 1 || unit == 2 || unit == 3) && adr == 40000 {
						antwort = []byte{0x03, 4, 0x53, 0x75, 0x6e, 0x53}
					}
					frame := append([]byte{req[0], req[1], 0, 0}, binary.BigEndian.AppendUint16(nil, uint16(len(antwort)+1))...)
					frame = append(append(frame, unit), antwort...)
					if unit == 3 {
						time.Sleep(spaet) // after the probe's timeout: a late answer
					}
					if _, err := c.Write(frame); err != nil {
						return
					}
				}
			}()
		}
	}()
	return d
}

func TestTheUnitSearchFindsEveryInverterOfADatamanager(t *testing.T) {
	d := starteDatamanager(t, 300*time.Millisecond)
	opts := lesewegeOptionen()
	opts.ProbeIDTimeout = 150 * time.Millisecond
	r := newRig(t, opts)
	sel := func(comm, port string) map[string]any {
		return map[string]any{"brand": "fronius", "model": "eco", "family": "sunspec_live", "communication": comm,
			"probe_units": true, "connection": map[string]any{"ip": "127.0.0.1", "port": port}}
	}
	res := testRead(t, r, "suche", sel("fronius_sunspec", d.port))
	units, _ := res["found_units"].([]any)
	if res["ok"] != true || len(units) != 2 || units[0] != 1.0 || units[1] != 2.0 {
		t.Fatalf("Unit 1 und 2, nicht 3 (zu spaet) und nicht 4 (die spaete Antwort gehoert Unit 3): %v", res)
	}
	d.mu.Lock()
	probes := strings.Join(d.probes, " ")
	d.mu.Unlock()
	if !strings.HasPrefix(probes, "1@40000 2@40000 3@40000 4@40000") || strings.Contains(probes, "2@50000") {
		t.Errorf("nach dem ersten Fund bleibt die Suche auf 40000: %s", probes)
	}
	if res := testRead(t, r, "kein-sunspec", sel("kaco_http", d.port)); res["error_code"] != "invalid_request" {
		t.Errorf("nur SunSpec: %v", res)
	}
	if res := testRead(t, r, "zu", sel("sunspec_tcp", freeAddrPort(t))); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port: %v", res)
	}
}

// --- Schalt-Test (Freigabe-Assistent) -----------------------------------------

func TestTheSwitchTestWritesOnceAndReadsBack(t *testing.T) {
	g := startSchreibGeraet(t)
	r := newRig(t, lesewegeOptionen())
	l := r.listen(localbus.TopicSwitchResult)
	raw, _ := json.Marshal(map[string]any{"request_id": "sw1", "ops": []any{
		map[string]any{"id": "ein", "host": "127.0.0.1", "port": g.port(), "unit_id": 1, "fc": 5, "address": 3, "value": 1, "readback_address": 3},
		map[string]any{"id": "reg", "host": "127.0.0.1", "port": g.port(), "unit_id": 1, "fc": 6, "address": 40100, "value": 22},
		map[string]any{"id": "kaputt", "host": "127.0.0.1", "fc": 3, "address": 1, "value": 1},
	}})
	if err := r.bus.Publish(localbus.TopicSwitchRequest, raw, false); err != nil {
		t.Fatal(err)
	}
	var res struct {
		RequestID string           `json:"request_id"`
		Results   []map[string]any `json:"results"`
	}
	_ = json.Unmarshal(l.wait(t, localbus.TopicSwitchResult, 1, 5*time.Second)[0], &res)
	if res.RequestID != "sw1" || len(res.Results) != 3 {
		t.Fatalf("Ergebnis: %+v", res)
	}
	if e := res.Results[0]; e["id"] != "ein" || e["ok"] != true || e["readback"] != 1.0 {
		t.Errorf("Spule ein, zurueckgelesen: %v", e)
	}
	if e := res.Results[1]; e["ok"] != true || e["readback"] != nil || g.reg(40100) != 22 {
		t.Errorf("Register mit FC6, ohne Zuruecklesen: %v (Register %d)", e, g.reg(40100))
	}
	if e := res.Results[2]; e["ok"] != false || e["error_code"] != "invalid_request" {
		t.Errorf("FC3 ist kein Schaltbefehl: %v", e)
	}
	if fcs := g.geschrieben(); len(fcs) != 2 || fcs[0] != 5 || fcs[1] != 6 {
		t.Errorf("genau zwei Schreibrahmen (FC5, FC6): %v", fcs)
	}
}
