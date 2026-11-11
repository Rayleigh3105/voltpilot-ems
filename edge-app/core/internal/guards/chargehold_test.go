package guards

import (
	"math"
	"testing"
	"time"
)

var chSlot = time.Date(2026, 10, 13, 10, 45, 0, 0, time.UTC)

func chAt(s float64) time.Time { return chSlot.Add(time.Duration(s * float64(time.Second))) }

// The bound: the load above the plan's base load is the consumer's share and
// no longer bounds the charge; a load below it is the real load.
func TestChargeHoldBoundsTheLoadByTheBase(t *testing.T) {
	h := NewChargeHolder()
	// 13.10. 13:00: Sonne 47 kW, Haus 37 kW mit dem Verbraucher, Grundlast 5 kW.
	ctl := surplusReading(47, 37)
	res := h.Apply(chAt(0), chSlot, 25, 5, true, ctl, ctl, 0, true)
	if !res.Active || res.Reading.LoadKw != 5 || res.ConsumerKw != 32 || res.BaseLoadKw != 5 {
		t.Fatalf("consumer above the base: want load 5 kW, consumer 32 kW, got %+v", res)
	}
	if res.Reading.PvKw != 47 || res.Reading.SocPct != ctl.SocPct {
		t.Fatalf("only the load is held: %+v", res.Reading)
	}
	// Without the consumer the house is below the base: the real load bounds.
	low := surplusReading(47, 3.5)
	if res := h.Apply(chAt(10), chSlot, 25, 5, true, low, low, 0, true); res.Reading.LoadKw != 3.5 || res.ConsumerKw != 0 {
		t.Fatalf("load below the base stays the real load, got %+v", res)
	}
	// The trim on the held reading keeps the planned charge: 47 - 5 = 42 kW room.
	tr := NewPriceTrimmer()
	if got := tr.Apply(chAt(0), 25, true, res.Reading); got.Active || got.Kw != 25 {
		t.Fatalf("trim on the held reading: want the plan's 25 kW, got %+v", got)
	}
	// And a cloud still trims at once: 28 kW of sun leave 23 kW above the base.
	cloud := surplusReading(28, 37)
	res = h.Apply(chAt(20), chSlot, 25, 5, true, cloud, cloud, 0, true)
	if got := tr.Apply(chAt(20), 25, true, res.Reading); !got.Active || got.Kw != 23 {
		t.Fatalf("cloud under the hold: want the charge on pv - base = 23 kW, got %+v", got)
	}
}

// Nothing to hold: no field, a discharge or rest, a broken value, a blind
// reading - the reading passes through untouched and the state is dropped.
func TestChargeHoldInactive(t *testing.T) {
	ctl := surplusReading(47, 37)
	cases := []struct {
		name     string
		kw, base float64
		hold     bool
		r        Reading
	}{
		{"kein Feld", 25, 5, false, ctl},
		{"Ruhe", 0, 5, true, ctl},
		{"Entladen", -3, 5, true, ctl},
		{"Grundlast negativ", 25, -1, true, ctl},
		{"Grundlast NaN", 25, math.NaN(), true, ctl},
		{"Sonne unbekannt", 25, 5, true, surplusReading(Unknown(), 37)},
		{"Last unbekannt", 25, 5, true, surplusReading(47, Unknown())},
	}
	for _, c := range cases {
		h := NewChargeHolder()
		res := h.Apply(chAt(0), chSlot, c.kw, c.base, c.hold, c.r, c.r, 0, true)
		if res.Active || !sameReading(res.Reading, c.r) {
			t.Errorf("%s: want inactive and the reading unchanged, got %+v", c.name, res)
		}
	}
}

// THE IMPORT GUARD: a consumer that steps down inside the dwell costs nothing;
// a load that does not yield raises the base to the measured load after the
// dwell - for the rest of the slot, and only there.
func TestChargeHoldImportGuard(t *testing.T) {
	h := NewChargeHolder()
	ctl := surplusReading(40, 25) // 5 kW Grundlast + 20 kW, die nicht ausweichen
	// Import 10 kW while the charge is held, the consumer does not step down.
	for s := 0.0; s < HoldYieldDwell.Seconds(); s += 10 {
		res := h.Apply(chAt(s), chSlot, 25, 5, true, ctl, ctl, 10, true)
		if res.BaseLoadKw != 5 {
			t.Fatalf("t=%.0f s: inside the dwell the base stays, got %+v", s, res)
		}
	}
	res := h.Apply(chAt(HoldYieldDwell.Seconds()), chSlot, 25, 5, true, ctl, ctl, 10, true)
	if res.BaseLoadKw != 25 || res.Reading.LoadKw != 25 || res.ConsumerKw != 0 {
		t.Fatalf("import stood for the dwell: want the base on the measured 25 kW, got %+v", res)
	}
	// The trim then bounds the charge by pv - load again: 15 kW, no import.
	if got := NewPriceTrimmer().Apply(chAt(61), 25, true, res.Reading); got.Kw != 15 {
		t.Fatalf("after the guard the trim takes the import back: want 15 kW, got %+v", got)
	}
	// A load that grows beyond that level later is held against again.
	more := surplusReading(40, 37)
	if res := h.Apply(chAt(120), chSlot, 25, 5, true, more, more, 0, true); res.Reading.LoadKw != 25 || res.ConsumerKw != 12 {
		t.Fatalf("a consumer above the raised base is held against: got %+v", res)
	}
	// The next slot starts from the plan's base again.
	next := chSlot.Add(15 * time.Minute)
	if res := h.Apply(next, next, 25, 5, true, ctl, ctl, 0, true); res.BaseLoadKw != 5 {
		t.Fatalf("new slot: want the plan's base, got %+v", res)
	}
}

// An import that breaks off restarts the clock, one inside the base-load
// coverage (no sun for the base) or within the margin does not count, and a
// stale grid value stops the clock - it never extends a hold on its own.
func TestChargeHoldImportClock(t *testing.T) {
	ctl := surplusReading(40, 30)
	h := NewChargeHolder()
	h.Apply(chAt(0), chSlot, 20, 5, true, ctl, ctl, 8, true)
	h.Apply(chAt(50), chSlot, 20, 5, true, ctl, ctl, 0.2, true) // the consumer stepped down
	if res := h.Apply(chAt(70), chSlot, 20, 5, true, ctl, ctl, 8, true); res.BaseLoadKw != 5 {
		t.Fatalf("an interrupted import restarts the clock, got %+v", res)
	}
	if res := h.Apply(chAt(125), chSlot, 20, 5, true, ctl, ctl, 8, false); res.BaseLoadKw != 5 {
		t.Fatalf("a stale grid value stops the clock, got %+v", res)
	}
	if res := h.Apply(chAt(190), chSlot, 20, 5, true, ctl, ctl, 8, true); res.BaseLoadKw != 5 {
		t.Fatalf("the clock restarted at the fresh value, got %+v", res)
	}
	// Dusk: 3 kW of sun for a 5 kW base - 2 kW of import are the base's own.
	dusk := surplusReading(3, 14)
	h = NewChargeHolder()
	for s := 0.0; s <= 2*HoldYieldDwell.Seconds(); s += 10 {
		if res := h.Apply(chAt(s), chSlot, 1, 5, true, dusk, dusk, 2+HoldImportMarginKw, true); res.BaseLoadKw != 5 {
			t.Fatalf("t=%.0f s: import within the base-load coverage is no grid charging, got %+v", s, res)
		}
	}
}

func sameReading(a, b Reading) bool {
	eq := func(x, y float64) bool { return x == y || (math.IsNaN(x) && math.IsNaN(y)) }
	return eq(a.PvKw, b.PvKw) && eq(a.LoadKw, b.LoadKw) && eq(a.SocPct, b.SocPct) && eq(a.GridLimitKw, b.GridLimitKw)
}

// While the charge is held, an import right after a raise is the consumer's to
// answer: the damper's charge-side exception stays silent. The discharge side
// is untouched.
func TestFollowDamperHoldChargeSilencesTheChargeSideException(t *testing.T) {
	p := deyeProfile()
	d := NewFollowDamper()
	d.HoldCharge(true)
	d.Observe(dampAt(0), -1.0, 18.0)
	d.Gate(dampAt(0), p, surplusReading(30, 5), dampAt(0))
	d.Commit(dampAt(0), 18)
	d.Commit(dampAt(10), 21) // a raise of the charge
	d.Observe(dampAt(14), 2.0, 19.0)
	if _, pair := d.Gate(dampAt(15), p, surplusReading(22, 5), dampAt(14)); pair == DampPairCostly {
		t.Fatal("held charge: an import after a raise must not take the command back at the meter")
	}
	// Discharge side: export after a deepened discharge still takes it back.
	d = NewFollowDamper()
	d.HoldCharge(true)
	d.Observe(dampAt(0), 1.0, -2.0)
	d.Gate(dampAt(0), p, surplusReading(1, 4), dampAt(0))
	d.Commit(dampAt(0), -2)
	d.Commit(dampAt(10), -3)
	d.Observe(dampAt(14), -1.5, -2.5)
	if _, pair := d.Gate(dampAt(15), p, surplusReading(1, 2), dampAt(14)); pair != DampPairCostly {
		t.Fatalf("the hold is charge-side only: export after a deepened discharge stays costly, got %v", pair)
	}
	// Release drops the flag with everything else.
	d.HoldCharge(true)
	d.Release()
	if d.holdCharge {
		t.Fatal("Release must drop the hold flag")
	}
}
