package history

import (
	"encoding/json"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }

func TestBatteryKwFromPowerBalance(t *testing.T) {
	// grid = load - pv + battery  =>  battery = grid - load + pv.
	// Midday surplus charging: pv 5, load 1, grid 0 (all PV used locally +
	// charging) -> battery = 0 - 1 + 5 = 4 kW in (charging).
	s := Sample{PvKw: f(5), LoadKw: f(1), GridKw: f(0)}
	b, ok := s.BatteryKw()
	if !ok || b != 4 {
		t.Fatalf("battery = %v (ok=%v), want 4", b, ok)
	}
	// Evening discharge: pv 0, load 2, grid 0 -> battery = -2 (discharging).
	s = Sample{PvKw: f(0), LoadKw: f(2), GridKw: f(0)}
	if b, ok := s.BatteryKw(); !ok || b != -2 {
		t.Fatalf("battery = %v, want -2", b)
	}
	// Missing a field -> undefined.
	if _, ok := (Sample{PvKw: f(1)}).BatteryKw(); ok {
		t.Fatal("battery must be undefined without grid+load+pv")
	}
}

func TestMarshalOmitsMissingAndEmitsMeasuredBattery(t *testing.T) {
	ts := time.UnixMilli(1_700_000_000_000)
	// grid/load/pv all present but NO measured battery: since the 2026-07-17
	// house-consumption standard the wire `batt` is the MEASURED register only
	// - the balance derivation (here -2 - 1 + 3.14159) must NOT be emitted
	// (honest gap; BatteryKw() stays available as an internal diagnostic).
	raw, err := json.Marshal(Sample{Ts: ts, PvKw: f(3.14159), LoadKw: f(1), GridKw: f(-2)})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["t"].(float64) != 1_700_000_000_000 {
		t.Fatalf("t: %v", m["t"])
	}
	if m["pv"].(float64) != 3.142 { // rounded to 3 decimals
		t.Fatalf("pv rounding: %v", m["pv"])
	}
	if _, ok := m["soc"]; ok {
		t.Fatal("absent soc must be omitted, not zero")
	}
	if _, ok := m["batt"]; ok {
		t.Fatalf("derived battery must never be emitted; got batt=%v", m["batt"])
	}

	// With the measured register present, `batt` is exactly that value - even
	// when it disagrees with the balance derivation (measured wins).
	raw, err = json.Marshal(Sample{Ts: ts, PvKw: f(3), LoadKw: f(1), GridKw: f(-2), BattKw: f(-8.5004)})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["batt"].(float64) != -8.5 { // rounded, and NOT the derived 0
		t.Fatalf("batt: %v, want the measured -8.5", m["batt"])
	}
}

func TestRingEvictsOldestAndWindows(t *testing.T) {
	r := New(3)
	base := time.Now()
	for i := 0; i < 5; i++ {
		r.Add(Sample{Ts: base.Add(time.Duration(i) * time.Second), PvKw: f(float64(i))})
	}
	if r.Len() != 3 {
		t.Fatalf("len = %d, want 3 (cap)", r.Len())
	}
	latest, ok := r.Latest()
	if !ok || *latest.PvKw != 4 {
		t.Fatalf("latest pv = %v", latest.PvKw)
	}
	// Since the 3rd-from-last timestamp we should get the 2 newest.
	got := r.Since(base.Add(2500 * time.Millisecond))
	if len(got) != 2 {
		t.Fatalf("since window = %d, want 2", len(got))
	}
	if *got[0].PvKw != 3 || *got[1].PvKw != 4 {
		t.Fatalf("since order/values: %v %v", got[0].PvKw, got[1].PvKw)
	}
}

func TestPurgeThroughDropsOldSamplesKeepsNew(t *testing.T) {
	r := New(10)
	base := time.Date(2026, 7, 6, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 6; i++ {
		r.Add(Sample{Ts: base.Add(time.Duration(i) * time.Minute)})
	}
	r.PurgeThrough(base.Add(3 * time.Minute)) // drops minutes 0..3
	if r.Len() != 2 {
		t.Fatalf("len = %d, want 2", r.Len())
	}
	got := r.Since(time.Time{})
	if !got[0].Ts.Equal(base.Add(4*time.Minute)) || !got[1].Ts.Equal(base.Add(5*time.Minute)) {
		t.Fatalf("survivors wrong: %v", got)
	}
	// Idempotent + empty-safe.
	r.PurgeThrough(base.Add(time.Hour))
	if r.Len() != 0 {
		t.Fatalf("len after full purge = %d", r.Len())
	}
	r.PurgeThrough(base)
}
