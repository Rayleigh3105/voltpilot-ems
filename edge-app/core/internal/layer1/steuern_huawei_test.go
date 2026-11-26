package layer1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// The Huawei control path end to end over the local bus against the simulated
// SUN2000 + LUNA2000 behind its Smart Dongle: setpoint -> HuaweiPlanen ->
// HuaweiAusfuehren -> FC6/FC16 on the wire -> readback. Edge Light and Edge
// Industrie run this same Layer 1 (internal/kernmain).

// feldanlage is the field device's window as read on 25.11.2026: mode 2,
// 47075 = 7000 W, 47077 = 3300 W - beside the measured values of kundenanlage.
func feldanlage() map[uint16]uint16 {
	m := kundenanlage()
	m[47086] = 2
	m[47075], m[47076] = 0, 7000
	m[47077], m[47078] = 0, 3300
	return m
}

func (s *huaweiSim) u32(a uint16) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int(uint32(s.regs[a])<<16 | uint32(s.regs[a+1]))
}

func (s *huaweiSim) geschrieben() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.writes...)
}

func huaweiSteuerRig(t *testing.T, ablage string) (*rig, *busLog) {
	t.Helper()
	if ablage == "" {
		ablage = filepath.Join(t.TempDir(), "steuern.json")
	}
	r := newRig(t, Options{SteuerAblage: ablage, Poll: time.Hour, FirstPoll: time.Hour, HuaweiConnectPause: 150 * time.Millisecond})
	return r, r.listen(localbus.TopicControlReadback)
}

func (r *rig) selectSteuerHuawei(sim *huaweiSim, model string) {
	r.t.Helper()
	host, port := sim.addr()
	p, _ := strconv.Atoi(port)
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "brand": "huawei", "model": model,
		"family": "huawei_sun2000_luna", "communication": "huawei_modbus",
		"connection": map[string]any{"ip": host, "port": p, "unit_id": 1}})
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func keinZwang(t *testing.T, sim *huaweiSim) {
	t.Helper()
	for _, w := range sim.geschrieben() {
		for _, verboten := range []string{"47083=", "47087=", "47100=", "47246=", "47247=", "47249="} {
			if strings.HasPrefix(w, verboten) {
				t.Fatalf("Zwangs-/Netzladeregister geschrieben: %v", sim.geschrieben())
			}
		}
	}
}

func huaweiAblage(t *testing.T, pfad string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(pfad)
	if err != nil {
		return nil
	}
	var d map[string]any
	_ = json.Unmarshal(raw, &d)
	h, _ := d["huawei"].(map[string]any)
	return h
}

// The released model: Halten writes the window, stores the device's own
// values first and reads back held; Not-Aus gives them back. The dongle is
// deaf right after the connect - the control session waits like the poll.
func TestHuaweiSteuernFensterpfadUndRueckgabe(t *testing.T) {
	sim := startHuaweiSim(t, feldanlage())
	sim.deaf = 100 * time.Millisecond
	ablage := filepath.Join(t.TempDir(), "steuern.json")
	r, l := huaweiSteuerRig(t, ablage)
	r.selectSteuerHuawei(sim, "sun2000-m1")

	m := readbackUntil(t, r, l, map[string]any{"battery_setpoint_kw": 0}, func(m map[string]any) bool {
		return m["verify"] == "held" && m["mode"] == "normal"
	})
	if sim.u32(47075) != 7000 || sim.u32(47077) != 0 || m["control_path"] != "huawei_fenster" || m["certified"] != true {
		t.Fatalf("Halten (nur 47077): 47075=%d 47077=%d %v", sim.u32(47075), sim.u32(47077), m)
	}
	h := huaweiAblage(t, ablage)
	if len(h) != 1 {
		t.Fatalf("Ausgangswerte in der Steuer-Ablage: %v", h)
	}
	for _, v := range h {
		regs, _ := v.(map[string]any)["regs"].(map[string]any)
		if regs["47077"] != 3300.0 || len(regs) != 1 {
			t.Fatalf("Ausgangswerte: %v", v)
		}
	}
	if sim.unheard.Load() != 0 {
		t.Fatalf("%d Anfragen in der tauben Zeit des Dongles", sim.unheard.Load())
	}

	// Decken: discharging back to the device's own 3300 W; 47075 untouched.
	readbackUntil(t, r, l, map[string]any{"battery_setpoint_kw": -1.2}, func(m map[string]any) bool {
		return m["verify"] == "held" && sim.u32(47077) == 3300 && sim.u32(47075) == 7000
	})

	// Not-Aus: the handback writes the originals and clears the store.
	m = readbackUntil(t, r, l, map[string]any{"control_enabled": false}, func(m map[string]any) bool {
		return m["mode"] == "release" && m["verify"] == "held"
	})
	if sim.u32(47075) != 7000 || sim.u32(47077) != 3300 || len(huaweiAblage(t, ablage)) != 0 || m["blocked"] != true {
		t.Fatalf("Rückgabe: 47075=%d 47077=%d Ablage=%v %v", sim.u32(47075), sim.u32(47077), huaweiAblage(t, ablage), m)
	}
	keinZwang(t, sim)
	for _, w := range sim.geschrieben() {
		if !strings.HasPrefix(w, "47077=") {
			t.Fatalf("nur die Entladegrenze (Option C): %v", sim.geschrieben())
		}
	}
}

// A positive setpoint with grid charging allowed only blocks discharging:
// 47077 = 0, the charge limit 47075 untouched, never a forced register.
func TestHuaweiSteuernNetzladenBleibtGesperrt(t *testing.T) {
	sim := startHuaweiSim(t, feldanlage())
	r, l := huaweiSteuerRig(t, "")
	r.selectSteuerHuawei(sim, "sun2000-m1")
	m := readbackUntil(t, r, l, map[string]any{"battery_setpoint_kw": 1.3, "grid_charge_allowed": true},
		func(m map[string]any) bool { return m["verify"] == "held" })
	if sim.u32(47075) != 7000 || sim.u32(47077) != 0 || !strings.Contains(m["reason"].(string), "sperrt nur das Entladen") {
		t.Fatalf("47075=%d 47077=%d %v", sim.u32(47075), sim.u32(47077), m)
	}
	keinZwang(t, sim)
}

// Another model of the family is not released: read only, the readback says why.
func TestHuaweiSteuernAnderesModellWirdNurGelesen(t *testing.T) {
	sim := startHuaweiSim(t, feldanlage())
	r, l := huaweiSteuerRig(t, "")
	r.selectSteuerHuawei(sim, "sun2000-l1")
	m := readbackUntil(t, r, l, map[string]any{"battery_setpoint_kw": 0}, func(m map[string]any) bool { return m["blocked"] == true })
	if !strings.Contains(m["reason"].(string), "noch nicht freigegeben") || len(sim.geschrieben()) != 0 {
		t.Fatalf("%v %v", m, sim.geschrieben())
	}
}

// Without a First-Light certificate nothing is written either.
func TestHuaweiSteuernOhneZertifikatSchreibtNichts(t *testing.T) {
	sim := startHuaweiSim(t, feldanlage())
	r, l := huaweiSteuerRig(t, "")
	r.selectSteuerHuawei(sim, "sun2000-m1")
	m := readbackUntil(t, r, l, map[string]any{"battery_setpoint_kw": 0, "device_certified": false},
		func(m map[string]any) bool { return m["blocked"] == true })
	if !strings.Contains(m["reason"].(string), "nicht zertifiziert") || len(sim.geschrieben()) != 0 {
		t.Fatalf("%v %v", m, sim.geschrieben())
	}
}

// A box that stopped while it held the battery gives the device its own
// values back at the next start - before any setpoint arrives.
func TestHuaweiSteuernNeustartGibtZurueck(t *testing.T) {
	sim := startHuaweiSim(t, feldanlage())
	sim.set(map[uint16]uint16{47075: 0, 47076: 0, 47077: 0, 47078: 0}) // the box held the battery
	host, port := sim.addr()
	p, _ := strconv.Atoi(port)
	ablage := filepath.Join(t.TempDir(), "steuern.json")
	raw, _ := json.Marshal(map[string]any{"huawei": map[string]any{netJoin(host, p): map[string]any{
		"ip": host, "port": p, "unit_id": 1, "captured_at": "2026-11-26T10:00:00.000Z",
		"regs": map[string]any{"47077": 3300}}}})
	if err := os.WriteFile(ablage, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	huaweiSteuerRig(t, ablage)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && (sim.u32(47077) != 3300 || len(huaweiAblage(t, ablage)) != 0) {
		time.Sleep(50 * time.Millisecond)
	}
	if sim.u32(47077) != 3300 || len(huaweiAblage(t, ablage)) != 0 {
		t.Fatalf("Neustart: 47077=%d Ablage=%v", sim.u32(47077), huaweiAblage(t, ablage))
	}
	keinZwang(t, sim)
}
