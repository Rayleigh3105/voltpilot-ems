package layer1

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// huaweiSim is a SUN2000 behind a Smart Dongle: Modbus TCP FC3 from an
// absolute register image, ONE client at a time (a second connection is
// refused and counted), `refuse` blocks answered with exception 2, `silent`
// swallows every request.
type huaweiSim struct {
	ln      net.Listener
	mu      sync.Mutex
	regs    map[uint16]uint16
	refuse  map[uint16]bool
	silent  bool
	units   []byte
	busy    atomic.Int32
	refused atomic.Int32
}

func i32regs(v int32) (uint16, uint16) { return uint16(uint32(v) >> 16), uint16(uint32(v) & 0xffff) }

// kundenanlage is the scout's stand-in image: PV 2,692 kW DC, AC 1,792 kW,
// meter -9908 W (Huawei: - = drawing from the grid; 11 kW wallbox), SoC 68,6 %,
// battery charging 0,9 kW, running.
func kundenanlage() map[uint16]uint16 {
	m := map[uint16]uint16{37760: 686, 37761: 0, 37762: 2, 37763: 0, 37764: 0}
	put := func(a uint16, v int32) { m[a], m[a+1] = i32regs(v) }
	put(32064, 2692)
	put(32080, 1792)
	put(37113, -9908)
	put(37765, 900)
	return m
}

func startHuaweiSim(t *testing.T, regs map[uint16]uint16) *huaweiSim {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &huaweiSim{ln: ln, regs: regs, refuse: map[uint16]bool{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			if !s.busy.CompareAndSwap(0, 1) {
				s.refused.Add(1)
				_ = c.Close()
				continue
			}
			go func() {
				defer s.busy.Store(0)
				s.serve(c)
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *huaweiSim) addr() (string, string) {
	h, p, _ := net.SplitHostPort(s.ln.Addr().String())
	return h, p
}

func (s *huaweiSim) set(regs map[uint16]uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range regs {
		s.regs[k] = v
	}
}

func (s *huaweiSim) serve(c net.Conn) {
	defer c.Close()
	for {
		hdr := make([]byte, 7)
		if _, err := io.ReadFull(c, hdr); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[4:]))
		body := make([]byte, n-1)
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		s.mu.Lock()
		s.units = append(s.units, hdr[6])
		silent, refuse, regs := s.silent, s.refuse, s.regs
		addr := binary.BigEndian.Uint16(body[1:])
		count := binary.BigEndian.Uint16(body[3:])
		var resp []byte
		if body[0] != 3 || refuse[addr] {
			resp = []byte{body[0] | 0x80, 2}
		} else {
			resp = []byte{3, byte(count * 2)}
			for i := uint16(0); i < count; i++ {
				resp = binary.BigEndian.AppendUint16(resp, regs[addr+i])
			}
		}
		s.mu.Unlock()
		if silent {
			continue
		}
		out := make([]byte, 7, 7+len(resp))
		copy(out, hdr[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
		out[6] = hdr[6]
		_, _ = c.Write(append(out, resp...))
	}
}

func huaweiSel(host string, port any, conn map[string]any) map[string]any {
	c := map[string]any{"ip": host, "port": port, "unit_id": 1}
	for k, v := range conn {
		c[k] = v
	}
	return map[string]any{"brand": "huawei", "model": "sun2000-m1", "family": "huawei_sun2000_luna", "communication": "huawei_modbus", "connection": c}
}

func (r *rig) selectHuawei(sim *huaweiSim, conn map[string]any) {
	r.t.Helper()
	host, port := sim.addr()
	raw, _ := json.Marshal(huaweiSel(host, port, conn))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func TestTheRetainedHuaweiSelectionDrivesTheReadOntoTheBus(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	r := newRig(t, Options{})
	r.selectHuawei(sim, map[string]any{"invert_grid_sign": true})

	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	// The flow's reading: decoded channels + battery_power_kw (local bus only)
	// + ts; the grid hatch turns Huawei's -9908 W into VoltPilot's +9,908 kW Bezug.
	for k, want := range map[string]float64{"pv_power_kw": 2.692, "power_kw": 9.908, "soc_pct": 68.6, "battery_power_kw": 0.9} {
		if msg[k] != want {
			t.Errorf("%s = %v, want %v (%v)", k, msg[k], want, msg)
		}
	}
	if _, has := msg["soc_source"]; has || len(msg) != 5 {
		t.Errorf("genau pv/power/soc/battery/ts, kein soc_source: %v", msg)
	}
	if ts, _ := msg["ts"].(string); len(ts) != len("2006-01-02T15:04:05.000Z") || !strings.HasSuffix(ts, "Z") {
		t.Errorf("ts wie Date.toISOString(): %v", msg["ts"])
	}
	st := decodeJSON(t, r.wait(localbus.TopicStatus, 1, 2*time.Second)[0])
	if st["inverter_link"] != "up" {
		t.Errorf("status: %v", st)
	}
	sim.mu.Lock()
	units := sim.units
	sim.mu.Unlock()
	if len(units) < 4 || units[0] != 1 {
		t.Errorf("die vier Bloecke muessen mit Unit 1 (aus dem Formular) gelesen werden: %v", units)
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d zweite Verbindungen - eine Sitzung je Takt, nie zwei", n)
	}
}

func TestHuaweiWithoutASmartPowerSensorDropsOnlyTheGridChannel(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	sim.mu.Lock()
	sim.refuse[37113] = true // no meter: the device answers ILLEGAL DATA ADDRESS
	sim.mu.Unlock()
	r := newRig(t, Options{})
	r.selectHuawei(sim, nil)
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if _, has := msg["power_kw"]; has {
		t.Fatalf("ohne Smart Power Sensor darf kein Netzwert erfunden werden: %v", msg)
	}
	if msg["pv_power_kw"] != 2.692 || msg["soc_pct"] != 68.6 || msg["battery_power_kw"] != 0.9 {
		t.Fatalf("die uebrigen Kanaele bleiben: %v", msg)
	}
}

func TestASilentHuaweiTurnsTheLinkDownAndPublishesNoValue(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	r := newRig(t, Options{LinkTimeout: 400 * time.Millisecond, ReadTimeout: 200 * time.Millisecond, ConnectTimeout: 200 * time.Millisecond})
	r.selectHuawei(sim, nil)
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)
	n := r.count(localbus.TopicTelemetry)
	sim.mu.Lock()
	sim.silent = true
	sim.mu.Unlock()
	time.Sleep(300 * time.Millisecond) // an in-flight answered poll may still land
	n2 := r.count(localbus.TopicTelemetry)
	statuses := r.wait(localbus.TopicStatus, 2, 5*time.Second)
	if decodeJSON(t, statuses[len(statuses)-1])["inverter_link"] != "down" {
		t.Fatalf("nach %s Stille muss down kommen: %s", r.rt.opts.LinkTimeout, statuses)
	}
	time.Sleep(400 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) > n2 || n2 > n+1 {
		t.Fatalf("ein stummes Geraet liefert keinen Wert (%d -> %d -> %d)", n, n2, r.count(localbus.TopicTelemetry))
	}
}

func TestHuaweiConnectionTestClassifiesHonestly(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, ConnectTimeout: 400 * time.Millisecond, ReadTimeout: 300 * time.Millisecond})
	host, port := sim.addr()

	ok := testRead(t, r, "ok", huaweiSel(host, port, map[string]any{"invert_grid_sign": true}))
	if ok["ok"] != true {
		t.Fatalf("gesunder Huawei: %v", ok)
	}
	rd, _ := ok["reading"].(map[string]any)
	if rd["pv_kw"] != 2.692 || rd["grid_kw"] != 9.908 || rd["soc_pct"] != 68.6 || len(rd) != 3 {
		t.Errorf("Messwert im Test (PV, Netz mit Klappe, SoC): %v", rd)
	}
	// Without the hatch the Huawei sign is handed through: - = Bezug would be wrong in VoltPilot.
	raw := testRead(t, r, "raw", huaweiSel(host, port, nil))
	if rdr, _ := raw["reading"].(map[string]any); rdr["grid_kw"] != -9.908 {
		t.Errorf("ohne Klappe das Huawei-Vorzeichen: %v", raw["reading"])
	}
	// A grid meter shows only Netzbezug.
	grid := testRead(t, r, "grid", func() map[string]any { s := huaweiSel(host, port, nil); s["role"] = "grid-meter"; return s }())
	if rdg, _ := grid["reading"].(map[string]any); grid["ok"] != true || len(rdg) != 1 || rdg["grid_kw"] != -9.908 {
		t.Errorf("Rolle Netz-Zaehler: %v", grid)
	}
	// Unit 2 is a form value and reaches the wire.
	testRead(t, r, "unit", huaweiSel(host, port, map[string]any{"unit_id": 2}))
	sim.mu.Lock()
	lastUnit := sim.units[len(sim.units)-1]
	sim.mu.Unlock()
	if lastUnit != 2 {
		t.Errorf("Unit-ID aus dem Formular: %d", lastUnit)
	}

	// Every block refused (wrong unit / Modbus TCP not enabled): invalid_response with a sentence.
	sim.mu.Lock()
	for _, a := range []uint16{32064, 32080, 37113, 37760} {
		sim.refuse[a] = true
	}
	sim.mu.Unlock()
	if res := testRead(t, r, "refused", huaweiSel(host, port, nil)); res["error_code"] != "invalid_response" || !strings.Contains(res["message"].(string), "Unit-ID") {
		t.Errorf("alle Bloecke abgelehnt: %v", res)
	}
	sim.mu.Lock()
	sim.refuse = map[uint16]bool{}
	sim.silent = true
	sim.mu.Unlock()
	if res := testRead(t, r, "silent", huaweiSel(host, port, nil)); res["error_code"] != "no_answer" {
		t.Errorf("stummer Server: %v", res)
	}
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", huaweiSel(dh, dp, nil)); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port: %v", res)
	}
	if res := testRead(t, r, "noip", huaweiSel(" ", 502, nil)); res["error_code"] != "invalid_request" || res["message"] != "keine IP-Adresse" {
		t.Errorf("ohne IP: %v", res)
	}
	bad := huaweiSel(host, port, nil)
	bad["family"] = "huawei_irgendwas"
	if res := testRead(t, r, "fam", bad); res["error_code"] != "invalid_request" || res["message"] != "unbekannte Huawei-Familie: huawei_irgendwas" {
		t.Errorf("fremde Familie: %v", res)
	}
}

func TestHuaweiPollAndConnectionTestShareTheOneClientLane(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	r := newRig(t, Options{FirstPoll: 10 * time.Millisecond, Poll: 30 * time.Millisecond})
	r.selectHuawei(sim, nil)
	r.wait(localbus.TopicTelemetry, 2, 5*time.Second)
	host, port := sim.addr()
	for i := 0; i < 15; i++ {
		if res := testRead(t, r, "t"+itoa(i), huaweiSel(host, port, nil)); res["ok"] != true {
			t.Fatalf("Test %d neben dem Poll: %v", i, res)
		}
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen - Poll und Test kollidierten am Ein-Client-Dongle", n)
	}
}

func huaweiSource(id, role, host string, port any, conn map[string]any) map[string]any {
	s := huaweiSel(host, port, conn)
	s["id"] = id
	s["role"] = role
	s["interval_s"] = 5
	return s
}

func TestAHuaweiSourceIsReadByItsRole(t *testing.T) {
	sim := startHuaweiSim(t, kundenanlage())
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 100 * time.Millisecond})
	r.collectSources()
	host, port := sim.addr()
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(
		huaweiSource("src-pv", "pv-generation", host, port, nil),
		huaweiSource("src-netz", "grid-meter", host, port, map[string]any{"invert_grid_sign": true}),
		huaweiSource("src-last", "consumer", host, port, nil),
	), true); err != nil {
		t.Fatal(err)
	}
	pv := decodeJSON(t, r.wait(sources.TopicPrefix+"src-pv/telemetry", 1, 5*time.Second)[0])
	if pv["pv_power_kw"] != 2.692 || len(pv) != 2 {
		t.Fatalf("Erzeuger-Quelle: nur pv_power_kw + ts: %v", pv)
	}
	netz := decodeJSON(t, r.wait(sources.TopicPrefix+"src-netz/telemetry", 1, 5*time.Second)[0])
	if netz["power_kw"] != 9.908 || len(netz) != 2 {
		t.Fatalf("Netz-Quelle: nur power_kw (mit Klappe) + ts: %v", netz)
	}
	time.Sleep(300 * time.Millisecond)
	if r.count(sources.TopicPrefix+"src-last/telemetry") != 0 {
		t.Fatal("ein Wechselrichter als Verbraucher liefert keinen load_kw - nichts veroeffentlichen")
	}
	if r.count(localbus.TopicTelemetry) != 0 || r.count(localbus.TopicStatus) != 0 {
		t.Fatal("eine Energiequelle schreibt weder edge/telemetry noch edge/status")
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen - drei Quellen an einem Dongle muessen sich die Spur teilen", n)
	}
}
