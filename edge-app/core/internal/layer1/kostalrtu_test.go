package layer1

import (
	"encoding/binary"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// gatewaySim is a transparent RS485-to-Ethernet gateway with ONE PIKO at
// `unitID` behind it: it answers a well-formed FC03 request for its own
// unit id from a configured register map, and stays silent (or answers a
// Modbus exception) otherwise - like an RS485 bus without that unit.
type gatewaySim struct {
	ln       net.Listener
	mu       sync.Mutex
	unitID   byte
	regs     map[int]uint16 // address -> word
	silent   bool
	requests int
}

func startGatewaySim(t *testing.T, unitID byte, regs map[int]uint16) *gatewaySim {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	g := &gatewaySim{ln: ln, unitID: unitID, regs: regs}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go g.serve(c)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return g
}

func (g *gatewaySim) serve(c net.Conn) {
	defer c.Close()
	buf := make([]byte, 8)
	n, err := c.Read(buf)
	g.mu.Lock()
	g.requests++
	unitID, regs, silent := g.unitID, g.regs, g.silent
	g.mu.Unlock()
	if err != nil || n < 8 || silent {
		time.Sleep(500 * time.Millisecond)
		return
	}
	addr, start, count := buf[0], binary.BigEndian.Uint16(buf[2:4]), binary.BigEndian.Uint16(buf[4:6])
	if addr != unitID {
		time.Sleep(200 * time.Millisecond)
		return
	}
	data := make([]byte, 0, 3+2*count)
	data = append(data, addr, 0x03, byte(count*2))
	for i := 0; i < int(count); i++ {
		w := regs[int(start)+i] // 0 for an unconfigured address, like a real unused register
		data = append(data, byte(w>>8), byte(w))
	}
	crc := solarmanv5.CRC16(data)
	data = append(data, byte(crc&0xff), byte(crc>>8))
	time.Sleep(20 * time.Millisecond)
	_, _ = c.Write(data)
}

func (g *gatewaySim) hostPort() (string, string) {
	h, p, _ := net.SplitHostPort(g.ln.Addr().String())
	return h, p
}

func pikoRtuSel(host string, port, unitID any, crossCheckIP string) map[string]any {
	conn := map[string]any{"ip": host, "port": port, "unit_id": unitID}
	if crossCheckIP != "" {
		conn["cross_check_ip"] = crossCheckIP
	}
	return map[string]any{"brand": "kostal", "model": "piko-20", "family": "kostal_piko_rtu", "communication": "kostal_piko_rtu", "connection": conn}
}

func fastKostalRtu() Options {
	return Options{Poll: time.Hour, FirstPoll: time.Hour, LinkTimeout: 600 * time.Millisecond, KostalRtuTimeout: 400 * time.Millisecond}
}

func TestKostalPikoRtuSelectionDrivesTheReadOntoTheBus(t *testing.T) {
	g := startGatewaySim(t, 1, map[int]uint16{30030: 1234}) // register label 30031 -> address 30030
	r := newRig(t, fastKostalRtu())
	host, port := g.hostPort()
	raw, _ := json.Marshal(pikoRtuSel(host, port, 1, ""))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 1.234 || len(msg) != 2 {
		t.Fatalf("PIKO-Messwert (Modbus RTU): nur pv_power_kw + ts: %v", msg)
	}
}

func TestKostalPikoRtuWrongUnitIDPublishesNothing(t *testing.T) {
	g := startGatewaySim(t, 7, map[int]uint16{30030: 1234})
	r := newRig(t, fastKostalRtu())
	host, port := g.hostPort()
	raw, _ := json.Marshal(pikoRtuSel(host, port, 1, "")) // configured 1, device sits at 7
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(900 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) != 0 {
		t.Fatal("falsche Geraeteadresse darf nichts veroeffentlichen")
	}
}

func TestKostalPikoRtuConnectionTestClassifiesHonestlyAndCrossChecks(t *testing.T) {
	g := startGatewaySim(t, 1, map[int]uint16{
		30030: 1234, // AC total power (label 30031)
		30043: 20000,
	})
	r := newRig(t, fastKostalRtu())
	host, port := g.hostPort()

	// Without a cross-check IP: a plain, honest "no cross-check" note.
	ok := testRead(t, r, "ok", pikoRtuSel(host, port, 1, ""))
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["pv_kw"] != 1.234 {
		t.Fatalf("gesunder PIKO ueber RTU: %v", ok)
	}
	if msg, _ := ok["message"].(string); !strings.Contains(msg, "1.234 kW") || !strings.Contains(msg, "keine Gegenprobe") {
		t.Errorf("ohne Gegenprobe-IP muss das ehrlich benannt werden: %v", ok)
	}

	// With a cross-check IP set but unreachable on the fixed Web-API port 80
	// (a real PIKO's dxs.json is always port 80, no port field on this
	// optional cross-check address - cross_check_ip only): an honest note,
	// never a failed test (the RTU read already succeeded on its own).
	unreachable := freeAddr(t)
	uh, _, _ := net.SplitHostPort(unreachable)
	cross := testRead(t, r, "cross", pikoRtuSel(host, port, 1, uh))
	if msg, _ := cross["message"].(string); cross["ok"] != true || !strings.Contains(msg, "nicht erreichbar") {
		t.Errorf("unerreichbare Gegenprobe darf den Test nicht scheitern lassen, nur ehrlich benennen: %v", cross)
	}

	if res := testRead(t, r, "wrongunit", pikoRtuSel(host, port, 9, "")); res["error_code"] != "invalid_response" && res["error_code"] != "no_answer" {
		t.Errorf("falsche Geraeteadresse: %v", res)
	}
	if res := testRead(t, r, "range", pikoRtuSel(host, port, 999, "")); res["error_code"] != "invalid_request" {
		t.Errorf("Geraeteadresse ausserhalb 1-247: %v", res)
	}
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", pikoRtuSel(dh, dp, 1, "")); res["error_code"] != "unreachable" {
		t.Errorf("Wandler nicht erreichbar: %v", res)
	}
	if res := testRead(t, r, "noip", pikoRtuSel("", 8899, 1, "")); res["error_code"] != "invalid_request" || res["message"] != "keine IP-Adresse" {
		t.Errorf("ohne IP: %v", res)
	}
}
