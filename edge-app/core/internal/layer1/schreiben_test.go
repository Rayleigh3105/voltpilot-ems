package layer1

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// schreibGeraet is a one-client Modbus TCP device with holding registers and
// coils: FC1/FC3 read, FC5/FC6/FC16 write. `ignore` acknowledges writes
// without applying them (the firmware that accepts and drops a frame). A
// second client is refused only while the first one is still connected: the
// device first gives a session whose client has just closed the moment to
// notice that (the switch test opens one session per op back to back, and
// refusing at once raced with the end of the previous one).
type schreibGeraet struct {
	ln      net.Listener
	mu      sync.Mutex
	regs    map[uint16]uint16
	coils   map[uint16]bool
	ignore  bool
	writes  []byte // function codes of the write frames received
	busy    atomic.Int32
	refused atomic.Int32
}

func startSchreibGeraet(t *testing.T) *schreibGeraet {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	g := &schreibGeraet{ln: ln, regs: map[uint16]uint16{}, coils: map[uint16]bool{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			if !g.acquire() {
				g.refused.Add(1)
				_ = c.Close()
				continue
			}
			go func() {
				defer g.busy.Store(0)
				g.serve(c)
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return g
}

// acquire takes the one client slot, waiting briefly for a session that is
// ending; a client that stays connected keeps it and the newcomer is refused.
func (g *schreibGeraet) acquire() bool {
	for deadline := time.Now().Add(250 * time.Millisecond); ; {
		if g.busy.CompareAndSwap(0, 1) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (g *schreibGeraet) port() int {
	_, p, _ := net.SplitHostPort(g.ln.Addr().String())
	n, _ := strconv.Atoi(p)
	return n
}

func (g *schreibGeraet) reg(a uint16) uint16 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.regs[a]
}

func (g *schreibGeraet) geschrieben() []byte {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]byte(nil), g.writes...)
}

func (g *schreibGeraet) serve(c net.Conn) {
	defer c.Close()
	for {
		hdr := make([]byte, 7)
		if _, err := io.ReadFull(c, hdr); err != nil {
			return
		}
		body := make([]byte, int(binary.BigEndian.Uint16(hdr[4:]))-1)
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		fn, addr := body[0], binary.BigEndian.Uint16(body[1:])
		g.mu.Lock()
		var resp []byte
		switch fn {
		case 1:
			b := byte(0)
			if g.coils[addr] {
				b = 1
			}
			resp = []byte{1, 1, b}
		case 3:
			n := binary.BigEndian.Uint16(body[3:])
			resp = []byte{3, byte(2 * n)}
			for i := uint16(0); i < n; i++ {
				resp = binary.BigEndian.AppendUint16(resp, g.regs[addr+i])
			}
		case 5:
			g.writes = append(g.writes, fn)
			if !g.ignore {
				g.coils[addr] = binary.BigEndian.Uint16(body[3:]) == 0xff00
			}
			resp = append([]byte(nil), body[:5]...)
		case 6:
			g.writes = append(g.writes, fn)
			if !g.ignore {
				g.regs[addr] = binary.BigEndian.Uint16(body[3:])
			}
			resp = append([]byte(nil), body[:5]...)
		case 16:
			g.writes = append(g.writes, fn)
			n := binary.BigEndian.Uint16(body[3:])
			for i := uint16(0); i < n && !g.ignore; i++ {
				g.regs[addr+i] = binary.BigEndian.Uint16(body[6+2*i:])
			}
			resp = append([]byte(nil), body[:5]...)
		default:
			resp = []byte{fn | 0x80, 1}
		}
		g.mu.Unlock()
		out := make([]byte, 7, 7+len(resp))
		copy(out, hdr[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
		out[6] = hdr[6]
		_, _ = c.Write(append(out, resp...))
	}
}

// schreibAuftrag sends one order on topic and returns its answer.
func schreibAuftrag(t *testing.T, r *rig, l *busLog, topic, result string, auftrag map[string]any) map[string]any {
	t.Helper()
	before := l.count(result)
	raw, _ := json.Marshal(auftrag)
	if err := r.bus.Publish(topic, raw, false); err != nil {
		t.Fatal(err)
	}
	for _, m := range l.wait(t, result, before+1, 15*time.Second)[before:] {
		res := decodeJSON(t, m)
		if res["request_id"] == auftrag["request_id"] {
			return res
		}
	}
	t.Fatalf("keine Antwort auf %v", auftrag["request_id"])
	return nil
}

func TestThePlainModbusLaneWritesOnceAndReadsBack(t *testing.T) {
	g := startSchreibGeraet(t)
	g.regs[40100] = 10
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, WriteSettle: 20 * time.Millisecond})
	l := r.listen(localbus.TopicRegisterWriteResult)
	auftrag := func(id string, o map[string]any) map[string]any {
		out := map[string]any{"request_id": id, "mode": "apply", "kind": "holding", "addr": 40100, "value": 20,
			"host": "127.0.0.1", "port": g.port(), "unit_id": 1}
		for k, v := range o {
			out[k] = v
		}
		return out
	}
	send := func(id string, o map[string]any) map[string]any {
		return schreibAuftrag(t, r, l, localbus.TopicRegisterWriteRequest, localbus.TopicRegisterWriteResult, auftrag(id, o))
	}

	if res := send("vorschau", map[string]any{"mode": "dry_run", "value": 0}); res["ok"] != true || res["wrote"] != false ||
		res["before"] != 10.0 || res["after"] != nil || len(g.geschrieben()) != 0 {
		t.Fatalf("Vorschau liest nur: %v", res)
	}
	if res := send("fc16", nil); res["ok"] != true || res["wrote"] != true || res["before"] != 10.0 || res["after"] != 20.0 ||
		g.reg(40100) != 20 || g.geschrieben()[0] != 16 {
		t.Fatalf("Schreiben mit FC16: %v (Schreibrahmen %v)", res, g.geschrieben())
	}
	if res := send("fc6", map[string]any{"value": 21, "write_fc": 6}); res["after"] != 21.0 || g.geschrieben()[1] != 6 {
		t.Fatalf("Schreiben mit FC6: %v (Schreibrahmen %v)", res, g.geschrieben())
	}
	if res := send("spule", map[string]any{"kind": "coil", "addr": 3, "value": 1}); res["ok"] != true ||
		res["before"] != 0.0 || res["after"] != 1.0 || g.geschrieben()[2] != 5 {
		t.Fatalf("Spule: %v (Schreibrahmen %v)", res, g.geschrieben())
	}
	if res := send("vorbedingung", map[string]any{"value": 99, "expected_before": 5}); res["error_code"] != "precondition" ||
		res["wrote"] != false || g.reg(40100) != 21 || len(g.geschrieben()) != 3 ||
		res["message"] != "Das Register steht inzwischen auf 21, erwartet wurde 5. Es wurde NICHTS geschrieben." {
		t.Fatalf("Vorbedingung verfehlt: %v", res)
	}
	g.mu.Lock()
	g.ignore = true
	g.mu.Unlock()
	if res := send("ignoriert", map[string]any{"value": 30}); res["ok"] != true || res["wrote"] != true || res["after"] != 21.0 {
		t.Fatalf("Geraet uebernimmt nicht: ehrliches after statt erfundenem Erfolg: %v", res)
	}
	if res := send("netz", map[string]any{"host": "8.8.8.8"}); res["error_code"] != "invalid_request" || res["wrote"] != false {
		t.Fatalf("Ziel ausserhalb des Kundennetzes: %v", res)
	}
	zu, _ := strconv.Atoi(freeAddrPort(t))
	if res := send("zu", map[string]any{"port": zu}); res["error_code"] != "unreachable" || res["wrote"] != false ||
		!strings.Contains(res["message"].(string), "Verbindung fehlgeschlagen") {
		t.Fatalf("geschlossener Port: %v", res)
	}
	if n := g.refused.Load(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen", n)
	}
}

func TestTheDeyeLaneWritesOverTheLoggerOfThePoll(t *testing.T) {
	r := newRig(t, Options{Poll: 40 * time.Millisecond, FirstPoll: 10 * time.Millisecond, WriteSettle: 20 * time.Millisecond})
	l := r.listen(localbus.TopicInstallerWriteResult)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{0x00e7: 3300})
	r.selectDeye("hybrid_3p", nil)
	r.wait(localbus.TopicTelemetry, 1, 5*time.Second)
	send := func(id string, o map[string]any) map[string]any {
		a := map[string]any{"request_id": id, "mode": "apply", "addr": 0x00e7, "value": 7000}
		for k, v := range o {
			a[k] = v
		}
		return schreibAuftrag(t, r, l, localbus.TopicInstallerWriteRequest, localbus.TopicInstallerWriteResult, a)
	}

	if res := send("vorschau", map[string]any{"mode": "dry_run", "value": 0}); res["ok"] != true || res["wrote"] != false ||
		res["before"] != 3300.0 || len(r.sim.Writes()) != 0 {
		t.Fatalf("Vorschau: %v", res)
	}
	if res := send("fc16", nil); res["ok"] != true || res["wrote"] != true || res["before"] != 3300.0 || res["after"] != 7000.0 {
		t.Fatalf("Schreiben: %v", res)
	}
	if w := r.sim.Writes(); len(w) != 1 || w[0].Fn != 0x10 || w[0].Start != 0x00e7 || len(w[0].Values) != 1 || w[0].Values[0] != 7000 {
		t.Fatalf("genau ein FC16-Rahmen mit einem Wort: %+v", w)
	}
	if res := send("vorbedingung", map[string]any{"value": 1, "expected_before": 3300}); res["error_code"] != "precondition" ||
		res["wrote"] != false || len(r.sim.Writes()) != 1 {
		t.Fatalf("Vorbedingung verfehlt: %v", res)
	}
	r.sim.IgnoreWrites(true)
	if res := send("ignoriert", map[string]any{"value": 5000}); res["ok"] != true || res["after"] != 7000.0 {
		t.Fatalf("Logger nimmt an, Geraet uebernimmt nicht: %v", res)
	}
	r.sim.IgnoreWrites(false)

	// control_write_fc 6: the one documented exception to FC16.
	r.selectDeye("hybrid_3p", map[string]any{"control_write_fc": 6})
	time.Sleep(100 * time.Millisecond)
	if res := send("fc6", map[string]any{"value": 6500}); res["after"] != 6500.0 {
		t.Fatalf("FC6: %v", res)
	}
	if w := r.sim.Writes(); w[len(w)-1].Fn != 0x06 {
		t.Fatalf("FC6 erwartet: %+v", w[len(w)-1])
	}
	if n := r.sim.RefusedConnections(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen: Schreibauftrag und Poll haben den Ein-Client-Logger gleichzeitig belegt", n)
	}

	r.sim.SetSilent(true)
	if res := send("still", nil); res["ok"] != false || res["wrote"] != false || res["error_code"] != "unreachable" {
		t.Fatalf("stummer Logger: nichts geschrieben, benannt: %v", res)
	}
	r.sim.SetSilent(false)

	if res := send("kaputt", map[string]any{"addr": 70000}); res["error_code"] != "invalid_request" {
		t.Fatalf("unzulaessige Adresse: %v", res)
	}
	raw, _ := json.Marshal(huaweiSel("127.0.0.1", 502, nil))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if res := send("huawei", nil); res["error_code"] != "invalid_request" ||
		!strings.Contains(res["message"].(string), "nicht über den Solarman-Logger") {
		t.Fatalf("ein Huawei wird hierueber nicht beschrieben: %v", res)
	}
}
