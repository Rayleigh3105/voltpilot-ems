package layer1

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// The Fronius curtailment end to end over the local bus: a SunSpec device
// (models 1, 103, 120, 123 at 40000) behind the one-client write device.

func froniusSunspec(g *schreibGeraet) {
	g.mu.Lock()
	defer g.mu.Unlock()
	put := func(a, v uint16) { g.regs[a] = v }
	put(40000, 0x5375)
	put(40001, 0x6e53)
	put(40002, 1)
	put(40003, 66)
	put(40070, 103)
	put(40071, 50)
	put(40122, 120)
	put(40123, 26)
	put(40125, 27000) // WRtg 27 kW, SF 0
	put(40150, 123)
	put(40151, 24)
	put(40155, 10000)  // WMaxLimPct 100 %
	put(40173, 0xfffe) // WMaxLimPct_SF -2
	put(40176, 0xffff)
}

// vorlauf moves the runtime's clock forward (the observation of a unit runs
// at most once a minute).
var vorlauf atomic.Int64

func abregelRig(t *testing.T) (*rig, *busLog, *schreibGeraet) {
	t.Helper()
	vorlauf.Store(0)
	g := startSchreibGeraet(t)
	froniusSunspec(g)
	r := newRig(t, Options{Poll: time.Hour, SourcesPoll: time.Hour, SourcesFirstPoll: time.Hour,
		Now: func() time.Time { return time.Now().Add(time.Duration(vorlauf.Load())) }})
	l := r.listen(localbus.TopicControlReadback)
	if err := r.bus.Publish(TopicSourcesConfig, sourcesConfig(map[string]any{"id": "fro1", "role": "pv-generation",
		"brand": "fronius", "model": "fronius_eco_27", "family": "fronius_eco", "communication": "fronius_sunspec",
		"connection": map[string]any{"ip": "127.0.0.1", "port": g.port(), "unit_id": 1}}), true); err != nil {
		t.Fatal(err)
	}
	return r, l, g
}

func abregelSollwert(r *rig) {
	sp := map[string]any{"battery_setpoint_kw": 0, "source": "schedule",
		"ts":              time.Now().Add(time.Duration(vorlauf.Load())).UTC().Format(time.RFC3339),
		"control_enabled": true, "pv_limit_kw": 20,
		"curtail": map[string]any{"control_enabled": true, "pv_uncontrolled_kw": 4,
			"sources": []any{map[string]any{"id": "fro1", "certified": true, "capacity_kwp": 27}}}}
	raw, _ := json.Marshal(sp)
	_ = r.bus.Publish(localbus.TopicSetpoint, raw, true)
}

func abregelBis(t *testing.T, r *rig, l *busLog, ok func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	seen := 0
	for time.Now().Before(deadline) {
		abregelSollwert(r)
		time.Sleep(150 * time.Millisecond)
		vorlauf.Add(int64(20 * time.Second))
		l.mu.Lock()
		msgs := l.msgs[localbus.TopicControlReadback]
		l.mu.Unlock()
		for ; seen < len(msgs); seen++ {
			var m map[string]any
			_ = json.Unmarshal(msgs[seen], &m)
			if m["curtail"] == true && ok(m) {
				return m
			}
		}
	}
	t.Fatalf("keine passende Abregel-Rueckmeldung (%d gesehen)", seen)
	return nil
}

// Without the Edge Light release the unit is discovered and read back, the
// readback names why, and no write frame reaches the device.
func TestAbregelnOhneFreigabeSchreibtNichts(t *testing.T) {
	r, l, g := abregelRig(t)
	m := abregelBis(t, r, l, func(m map[string]any) bool {
		reason, _ := m["reason"].(string)
		return strings.Contains(reason, "Edge Light")
	})
	if m["source_id"] != "fro1" || m["unit_key"] != "127.0.0.1:"+strconv.Itoa(g.port())+"#1" {
		t.Fatalf("Rueckmeldung: %v", m)
	}
	if w := g.geschrieben(); len(w) != 0 {
		t.Fatalf("ohne Freigabe geschrieben: %v", w)
	}
}

// The bench build writes the Model 123 limit as ONE FC16 block (16 kW of the
// 20-kW plant cap after 4 kW uncontrolled = 59,26 % of 27 kW) and confirms it.
func TestAbregelnPruefstandSchreibtBlockUndBestaetigt(t *testing.T) {
	pruefstand(t)
	r, l, g := abregelRig(t)
	m := abregelBis(t, r, l, func(m map[string]any) bool { return m["all_match"] == true })
	if m["applied"] != true && m["applied"] != false {
		t.Fatalf("Rueckmeldung: %v", m)
	}
	if w := g.geschrieben(); len(w) == 0 || w[0] != 16 {
		t.Fatalf("Schreibrahmen %v (erwartet FC16)", w)
	}
	if v := g.reg(40155); v != 5926 {
		t.Fatalf("WMaxLimPct = %d, erwartet 5926", v)
	}
	if g.reg(40157) != 60 || g.reg(40159) != 1 {
		t.Fatalf("Revert %d, Freigabe %d", g.reg(40157), g.reg(40159))
	}
}
