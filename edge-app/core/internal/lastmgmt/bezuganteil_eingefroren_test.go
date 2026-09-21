package lastmgmt

// AP-15 IP-20: the frozen connection-point value counts as blind for the
// charging budget of the LEADING box, too (B2) - the same building block as the
// feed-in watchdog (guards.Einfrierprobe), one probe, two users.

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// The meter freezes at 10:00:00 at 367 kW import and keeps sending it every
// 5 s with a fresh timestamp. At 10:00:00 the box lowers its charge park from
// 30 to 10 kW while the vehicles draw 30 kW: -20 kW that MUST show at the
// meter. Fresh up to 10:00:59 (the probe needs 60 s), at 10:01:00 blind half
// way down the ramp (the age counts from the last change), at 10:01:30 on the
// share of 20 kW - 90 s after the freeze, as on the feed-in side (R9).
func TestFuehrendeBoxEingefrorenerZaehlerAufDenAnteil(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	set := Settings{GridLimitKw: 550, HouseReserveKw: 300, MaxHouseLoadKw: 473}
	tr, p := NewBudgetTracker(), &guards.Einfrierprobe{}
	p.Wert(t0.Add(-5*time.Second), 366.8)
	tr.Observe(t0.Add(-5*time.Second), 366.8, 0, true)
	for s := 0; s <= 240; s++ {
		now := t0.Add(time.Duration(s) * time.Second)
		if s%5 == 0 {
			grid := 367.0
			if s >= 150 { // the meter is back
				grid = 360 + float64(s%7)
			}
			p.Wert(now, grid)
			tr.Observe(now, grid, 0, true)
		}
		if s == 0 {
			p.Verstellt(now, -guards.WirksamGesenkt(30, 10, 30))
		}
		an := BezugAnteil{AnteilKw: 20, Fuehrt: true}
		if seit, ok := p.Eingefroren(now); ok {
			an.EingefrorenSeit = seit
		}
		v := tr.BudgetAnteil(now, set, an)
		switch {
		case s < 60:
			if !v.Measured() || v.AnteilBinds || v.Kw != 128 {
				t.Fatalf("second %d: fresh timestamps, the probe needs 60 s - today's loop 128 kW, got %+v", s, v)
			}
		case s < 90:
			want := round3(128 - (128-20)*float64(s-30)/60)
			if v.Mode != BudgetContracting || !v.Blind || v.Kw != want {
				t.Fatalf("second %d: frozen, ramp without hold to %.3f kW, got %+v", s, want, v)
			}
			if !strings.Contains(v.Reason, "eingefroren") {
				t.Fatalf("second %d: the sentence names the frozen value: %s", s, v.Reason)
			}
		case s < 150:
			if v.Mode != BudgetContracting && v.Mode != BudgetSafe || v.Kw != 20 {
				t.Fatalf("second %d: on the share of 20 kW, got %+v", s, v)
			}
		default:
			if !v.Measured() || v.AnteilBinds {
				t.Fatalf("second %d: the value moves again - today's loop, got %+v", s, v)
			}
		}
	}
}

// No false alarm: a leading box that adjusts nothing sees the same value for
// ten minutes - healthy, today's loop throughout.
func TestFuehrendeBoxRuhendeAnlageKeinFehlalarm(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	set := Settings{GridLimitKw: 550, HouseReserveKw: 300, MaxHouseLoadKw: 473}
	tr, p := NewBudgetTracker(), &guards.Einfrierprobe{}
	for s := 0; s <= 600; s++ {
		now := t0.Add(time.Duration(s) * time.Second)
		if s%5 == 0 {
			p.Wert(now, 367)
			tr.Observe(now, 367, 0, true)
		}
		if s == 100 { // a raise of the allocation only permits
			p.Verstellt(now, -guards.WirksamGesenkt(10, 30, 10))
		}
		an := BezugAnteil{AnteilKw: 20, Fuehrt: true}
		if seit, ok := p.Eingefroren(now); ok {
			t.Fatalf("second %d: frozen since %v - false alarm", s, seit)
		}
		if v := tr.BudgetAnteil(now, set, an); !v.Measured() {
			t.Fatalf("second %d: %+v", s, v)
		}
	}
}
