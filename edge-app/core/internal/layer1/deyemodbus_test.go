package layer1

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// A Deye over the Modbus TCP of its logger stick (field 25.11.2026: newer
// sticks offer no Solarman V5 on 8899): the same read plan, decoder and
// control as over Solarman, only the session is plain Modbus TCP (MBAP, unit
// 1, no logger serial). The device here is a Modbus TCP server with the
// registers of the Solarman tests (liveLV, remoteDeye) - simulator evidence,
// no hardware acceptance.

func deyeModbusAuswahl(t *testing.T, r *rig, g *schreibGeraet, extra map[string]any) {
	t.Helper()
	conn := map[string]any{"ip": "127.0.0.1", "port": g.port(), "unit_id": 1, "mb_slave_id": 1}
	for k, v := range extra {
		conn[k] = v
	}
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "brand": "deye", "model": "sun-12k-sg04lp3",
		"family": "hybrid_3p", "communication": "deye_modbus_tcp", "control_tier": 3, "rated_kw": 12, "connection": conn})
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
}

func setzeRegister(g *schreibGeraet, regs map[uint16]uint16) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for a, v := range regs {
		g.regs[a] = v
	}
}

func TestDeyeUeberModbusTCPLiestWieUeberSolarman(t *testing.T) {
	g := startSchreibGeraet(t)
	setzeRegister(g, map[uint16]uint16{
		0x0000: 0x0005,
		0x024b: 5230, 0x024c: 57, 0x024e: 0xfa24, // -1500 W
		0x026b: 0xf704, 0x02c4: 0xffff, // -2300 W
		0x028d: 1800, 0x02a0: 1000, 0x02a1: 1200,
	})
	r := newRig(t, Options{})
	deyeModbusAuswahl(t, r, g, nil)

	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	want := map[string]float64{"pv_power_kw": 2.2, "load_kw": 1.8, "power_kw": -2.3, "soc_pct": 57, "battery_power_kw": -1.5}
	for k, v := range want {
		if got, ok := msg[k].(float64); !ok || got != v {
			t.Errorf("%s = %v, want %v (Nachricht %v)", k, msg[k], v, msg)
		}
	}
	if n := r.sim.Requests(); n != 0 {
		t.Fatalf("the Solarman logger was asked %d times", n)
	}
	if w := g.geschrieben(); len(w) != 0 {
		t.Fatalf("reading wrote %v", w)
	}
}

// The Deye control over the stick: planned as the Deye it is (remote path of
// hybrid_3p, released in freigaben), written in FC 16 over Modbus TCP, handed
// back when control ends - the Solarman logger is never asked.
func TestDeyeUeberModbusTCPSteuertWieUeberSolarman(t *testing.T) {
	g := startSchreibGeraet(t)
	setzeRegister(g, map[uint16]uint16{0x0000: 0x0006, 0x044d: 0xffff, 0x0451: 2})
	r, l, _ := steuerRig(t)
	deyeModbusAuswahl(t, r, g, nil)

	m := readbackUntil(t, r, l, nil, func(m map[string]any) bool { return m["all_match"] == true })
	if m["control_path"] != "remote" || m["wrote"] != true || m["certified"] != true {
		t.Fatalf("Rueckmeldung: %v", m)
	}
	w := g.geschrieben()
	if len(w) == 0 || slices.ContainsFunc(w, func(fc byte) bool { return fc != 16 }) {
		t.Fatalf("Schreibrahmen %v (erwartet FC16)", w)
	}
	if g.reg(0x044c) == 0 {
		t.Fatal("Fernsteuerung 1100 nicht gesetzt")
	}
	readbackUntil(t, r, l, map[string]any{"control_enabled": false}, func(m map[string]any) bool {
		return m["mode"] == "release" && m["all_match"] == true
	})
	if v := g.reg(0x044c); v != 0 {
		t.Fatalf("1100 nach der Rueckgabe = %d", v)
	}
	if n := r.sim.Requests(); n != 0 {
		t.Fatalf("the Solarman logger was asked %d times", n)
	}
}

// Without the Edge Light release nothing is written over the stick either.
func TestDeyeUeberModbusTCPOhneFreigabeSchreibtNichts(t *testing.T) {
	alt := freigaben
	freigaben = nil
	t.Cleanup(func() { freigaben = alt })
	g := startSchreibGeraet(t)
	setzeRegister(g, map[uint16]uint16{0x0000: 0x0006, 0x044d: 0xffff, 0x0451: 2})
	r, l, _ := steuerRig(t)
	deyeModbusAuswahl(t, r, g, nil)
	readbackUntil(t, r, l, nil, func(m map[string]any) bool { return m["blocked"] == true })
	if w := g.geschrieben(); len(w) != 0 {
		t.Fatalf("ohne Freigabe geschrieben: %v", w)
	}
}
