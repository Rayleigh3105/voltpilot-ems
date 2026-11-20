package layer1

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

// The control path end to end over the local bus against the simulated
// Solarman logger: setpoint -> plan -> executor -> wire -> readback.

// remoteDeye is a HV Deye whose firmware carries the PR-978 remote block.
func remoteDeye(sim *v5sim.Sim) {
	sim.Set(map[uint16]uint16{0x0000: 0x0006, 0x044d: 0xffff, 0x0451: 2})
}

func (r *rig) selectSteuerDeye() {
	r.t.Helper()
	_, port, _ := net.SplitHostPort(r.sim.Addr())
	p, _ := strconv.Atoi(port)
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "brand": "deye", "model": "sun-30k-sg01hp3",
		"family": "hybrid_3p", "communication": "solarman_v5", "control_tier": 3, "rated_kw": 30,
		"connection": map[string]any{"ip": "127.0.0.1", "port": p, "serial": testSerial, "mb_slave_id": 1}})
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) setpoint(over map[string]any) {
	r.t.Helper()
	sp := map[string]any{"battery_setpoint_kw": -1.5, "source": "schedule", "ts": time.Now().UTC().Format(time.RFC3339),
		"control_enabled": true, "device_certified": true, "soc_min_pct": 20, "soc_max_pct": 95}
	for k, v := range over {
		sp[k] = v
	}
	raw, _ := json.Marshal(sp)
	if err := r.bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

// readbackUntil republishes the setpoint until a readback satisfies ok.
func readbackUntil(t *testing.T, r *rig, l *busLog, over map[string]any, ok func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	seen := 0
	for time.Now().Before(deadline) {
		r.setpoint(over)
		time.Sleep(150 * time.Millisecond)
		l.mu.Lock()
		msgs := l.msgs[localbus.TopicControlReadback]
		l.mu.Unlock()
		for ; seen < len(msgs); seen++ {
			var m map[string]any
			_ = json.Unmarshal(msgs[seen], &m)
			if ok(m) {
				return m
			}
		}
	}
	t.Fatalf("keine passende Rueckmeldung (%d gesehen)", seen)
	return nil
}

func steuerRig(t *testing.T) (*rig, *busLog, string) {
	t.Helper()
	ablage := filepath.Join(t.TempDir(), "steuern.json")
	r := newRig(t, Options{SteuerAblage: ablage, Poll: time.Hour})
	return r, r.listen(localbus.TopicControlReadback), ablage
}

func pruefstand(t *testing.T) {
	t.Helper()
	pruefstandBuild.Store(true)
	t.Cleanup(func() { pruefstandBuild.Store(false) })
}

// Without the Edge Light release the device is probed and planned, the
// readback names why, and not one register is written - although the core
// says certified and control is enabled.
func TestSteuernOhneFreigabeSchreibtNichts(t *testing.T) {
	r, l, _ := steuerRig(t)
	remoteDeye(r.sim)
	r.selectSteuerDeye()
	m := readbackUntil(t, r, l, nil, func(m map[string]any) bool { return m["blocked"] == true })
	if reason, _ := m["reason"].(string); !strings.Contains(reason, "Edge Light") || !strings.Contains(reason, "Prüfstand") {
		t.Fatalf("Grund: %v", m)
	}
	if m["control_path"] != "remote" || m["certified"] != false {
		t.Fatalf("Rueckmeldung: %v", m)
	}
	if w := r.sim.Writes(); len(w) != 0 {
		t.Fatalf("ohne Freigabe geschrieben: %+v", w)
	}
}

// The bench build drives the remote block in the load-bearing order -
// watchdog first, enable last - reads it back, and a kill-off hands the
// device back with 1100 <- 0.
func TestSteuernPruefstandFernsteuerungUndRueckgabe(t *testing.T) {
	pruefstand(t)
	r, l, _ := steuerRig(t)
	remoteDeye(r.sim)
	r.selectSteuerDeye()
	m := readbackUntil(t, r, l, nil, func(m map[string]any) bool { return m["all_match"] == true })
	if m["control_path"] != "remote" || m["wrote"] != true || m["certified"] != true {
		t.Fatalf("Rueckmeldung: %v", m)
	}
	var order []uint16
	for _, w := range r.sim.Writes() {
		if w.Fn != 0x10 || len(w.Values) != 1 {
			t.Fatalf("Schreibrahmen %+v (erwartet FC16 mit einem Wort)", w)
		}
		order = append(order, w.Start)
	}
	if len(order) < 5 || order[0] != 0x044d || order[len(order)-1] != 0x044c {
		t.Fatalf("Reihenfolge %x: Totmann zuerst, Fernsteuerung zuletzt", order)
	}
	// -1.5 kW discharge on 30 kW: +50 units in 1109 (Deye + = discharge).
	if v := r.sim.Reg(0x0455); v != 50 {
		t.Fatalf("1109 = %d, erwartet 50", v)
	}
	readbackUntil(t, r, l, map[string]any{"control_enabled": false}, func(m map[string]any) bool {
		return m["mode"] == "release" && m["all_match"] == true
	})
	if v := r.sim.Reg(0x044c); v != 0 {
		t.Fatalf("1100 nach der Rueckgabe = %d", v)
	}
}

// A snapshot left in the durable store means a ToU session never handed
// back: at start the installer's values are restored and the snapshot cleared.
func TestSteuernAbsturzWiederherstellung(t *testing.T) {
	dir := t.TempDir()
	ablage := filepath.Join(dir, "steuern.json")
	sim, err := v5sim.Start("127.0.0.1:0", testSerial)
	if err != nil {
		t.Fatal(err)
	}
	defer sim.Close()
	_, port, _ := net.SplitHostPort(sim.Addr())
	p, _ := strconv.Atoi(port)
	sim.Set(map[uint16]uint16{0x008d: 0, 0x0092: 0x00ff})
	raw, _ := json.Marshal(map[string]any{"snapshot": map[string]any{"family": "hybrid_3p",
		"connection": map[string]any{"ip": "127.0.0.1", "port": p, "serial": testSerial, "mb_slave_id": 1, "control_write_fc": 16},
		"regs":       map[string]any{"141": 1, "146": 0}}})
	if err := os.WriteFile(ablage, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, Options{SteuerAblage: ablage, Poll: time.Hour})
	_ = r
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, _ := os.ReadFile(ablage); strings.Contains(string(b), `"snapshot":null`) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sim.Reg(0x008d) != 1 || sim.Reg(0x0092) != 0 {
		t.Fatalf("nicht wiederhergestellt: 0x8d=%d 0x92=%d", sim.Reg(0x008d), sim.Reg(0x0092))
	}
	if b, _ := os.ReadFile(ablage); !strings.Contains(string(b), `"snapshot":null`) {
		t.Fatalf("Snapshot nicht geloescht: %s", b)
	}
}
