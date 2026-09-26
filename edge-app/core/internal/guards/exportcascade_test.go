package guards

import (
	"math"
	"testing"
	"time"
)

// A small closed loop for the cascade (concept §6.3), per simulated second:
//   - the PLANT: total PV follows min(available, cap) with the Fronius'
//     WMaxLimPct ramp (first order, tau 2 s);
//   - the INNER loop: the leader regulates its own meter to grid 0 inside
//     [0 ; ceiling] (E↑) within seconds - or not at all (a device that ignores
//     the surplus, the F11 failure);
//   - the OUTER loop: this watchdog, measured every 5 s, ticked every 10 s.
type cascadePlant struct {
	availKw, loadKw, ceilingKw, socPct float64
	absorbs                            bool // the inner loop takes the surplus
	cascade                            bool // the watchdog knows about the inner loop
	economic                           bool // the limit is a negative-price slot's 0 kW
	loadStepAt, loadStepKw             float64
	limitKw                            float64
	seconds                            int
	slotEvery                          int // a new slot every n seconds (0 = one slot)
}

type cascadeSample struct {
	t, exportKw, battKw, capKw, pvKw float64
	cascade                          string
}

func runCascade(p cascadePlant) []cascadeSample {
	t0 := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	l := NewExportLimiter()
	pv, batt := p.availKw, 0.0
	capKw := math.Inf(1)
	var out []cascadeSample
	var last ExportCap
	for s := 0; s <= p.seconds; s++ {
		now := t0.Add(time.Duration(s) * time.Second)
		load := p.loadKw
		if p.loadStepAt > 0 && float64(s) >= p.loadStepAt {
			load += p.loadStepKw
		}
		pv += (math.Min(p.availKw, capKw) - pv) * (1 - math.Exp(-1/2.0))
		target := 0.0
		if p.absorbs {
			target = math.Max(0, math.Min(p.ceilingKw, pv-load))
		}
		batt += (target - batt) * (1 - math.Exp(-1/0.5))
		grid := load + batt - pv
		if s%5 == 0 {
			l.Observe(now, grid, pv)
		}
		if s%10 == 2 {
			slot := t0
			if p.slotEvery > 0 {
				slot = t0.Add(time.Duration(s/p.slotEvery*p.slotEvery) * time.Second)
			}
			inner := InnerLoop{}
			if p.cascade {
				inner = InnerLoop{Active: true, CeilingKw: p.ceilingKw, BatteryKw: batt,
					SocPct: p.socPct, SocMaxPct: 95, Slot: slot, Economic: p.economic}
			}
			limit := p.limitKw
			last = l.CapCascade(now, &limit, 0, inner)
			capKw = last.CapKw
		}
		out = append(out, cascadeSample{t: float64(s), exportKw: -grid, battKw: batt, capKw: capKw, pvKw: pv,
			cascade: last.Cascade})
	}
	return out
}

// F8 at the rule level, and the reason the cascade exists: negative price,
// limit 0 kW, the leader stores the surplus itself. As two equal regulators the
// watchdog aims one margin below the device's own target and ratchets the PV
// down while the battery could have taken it; as a cascade the battery charges
// at its ceiling and the PV is throttled to export 0 ± 0,5 kW.
func TestCascadeLetsTheStorageChargeFirstAtALimitOfZero(t *testing.T) {
	base := cascadePlant{availKw: 84, loadKw: 5, ceilingKw: 30, socPct: 50, absorbs: true, limitKw: 0, seconds: 600,
		economic: true}

	equal := base
	fought := runCascade(equal)
	if end := fought[len(fought)-1]; end.battKw > 20 {
		t.Fatalf("premise: without the cascade the watchdog ratchets the plant down (battery %.1f kW)", end.battKw)
	}

	cas := base
	cas.cascade = true
	res := runCascade(cas)
	var reversals int
	dir := 0.0
	for i, smp := range res {
		if smp.t < 180 {
			continue
		}
		if smp.exportKw > 0.5 || smp.exportKw < -0.5 {
			t.Fatalf("t=%v s: export %.2f kW outside 0 ± 0,5 kW", smp.t, smp.exportKw)
		}
		if smp.battKw < 29 {
			t.Fatalf("t=%v s: the storage must charge at its ceiling, got %.2f kW", smp.t, smp.battKw)
		}
		if smp.pvKw > 36 {
			t.Fatalf("t=%v s: the PV must be throttled, got %.2f kW", smp.t, smp.pvKw)
		}
		if d := smp.capKw - res[i-1].capKw; math.Abs(d) > 1e-9 {
			if dir != 0 && math.Signbit(d) != math.Signbit(dir) {
				reversals++
			}
			dir = d
		}
	}
	// The two loops must not swing: in steady state the cap may settle, not
	// oscillate (a reversal every other tick would be ~40 in these 420 s).
	if reversals > 4 {
		t.Fatalf("inner and outer loop swing: %d cap reversals in steady state", reversals)
	}
}

// F7 at the rule level: limit 30 kW, the storage is full - there is no inner
// loop left to wait for, so the watchdog regulates at once.
func TestCascadeRegulatesAtOnceWhenTheStorageIsFull(t *testing.T) {
	res := runCascade(cascadePlant{availKw: 74, loadKw: 5, ceilingKw: 30, socPct: 100,
		absorbs: true, cascade: true, limitKw: 30, seconds: 120})
	for _, smp := range res {
		if smp.t >= 20 && smp.exportKw > 30.5 {
			t.Fatalf("t=%v s: export %.2f kW above 30,5 kW after 20 s", smp.t, smp.exportKw)
		}
	}
	if res[len(res)-1].cascade != CascadeOuter {
		t.Fatalf("a full storage leaves the watchdog in charge, got %q", res[len(res)-1].cascade)
	}
}

// A storage that has headroom but does not take the surplus (a meter that does
// not see the second PV system): a wallbox is unplugged, the export jumps over
// the 30 kW limit. The watchdog waits ONE tick for the inner loop, then takes
// over for the rest of the slot - F7's 20 s hold - and the next slot tries again.
func TestCascadeTakesOverFromAnInnerLoopThatDoesNotAbsorb(t *testing.T) {
	res := runCascade(cascadePlant{availKw: 60, loadKw: 15, ceilingKw: 30, socPct: 50,
		absorbs: false, cascade: true, limitKw: 30, seconds: 1000, slotEvery: 900,
		loadStepAt: 100, loadStepKw: -10})
	for _, smp := range res {
		if smp.t >= 20 && (smp.t < 100 || smp.t >= 120) && smp.t < 900 && smp.exportKw > 30.5 {
			t.Fatalf("t=%v s: export %.2f kW - the limit must be back within 20 s", smp.t, smp.exportKw)
		}
		if smp.t >= 20 && smp.exportKw > 30.5+10.5 {
			t.Fatalf("t=%v s: export %.2f kW", smp.t, smp.exportKw)
		}
	}
	if got := res[800].cascade; got != CascadeInnerFailed {
		t.Fatalf("the failure is latched for the slot, got %q", got)
	}
	if got := res[905].cascade; got == CascadeInnerFailed {
		t.Fatalf("a new slot must re-arm the inner loop, got %q", got)
	}
}

// A zero-export site (a registered limit of 0 kW) never bets on the inner loop:
// the watchdog releases one Abstand at a time, the storage pulls the PV up step
// by step, and the export stays at 0 ± 0,5 kW throughout.
func TestCascadeAtAZeroExportSiteCreepsWithoutExporting(t *testing.T) {
	res := runCascade(cascadePlant{availKw: 84, loadKw: 5, ceilingKw: 30, socPct: 50,
		absorbs: true, cascade: true, limitKw: 0, seconds: 1800})
	for _, smp := range res {
		if smp.t >= 20 && (smp.exportKw > 0.5 || smp.exportKw < -0.5) {
			t.Fatalf("t=%v s: export %.2f kW outside 0 ± 0,5 kW", smp.t, smp.exportKw)
		}
	}
	if end := res[len(res)-1]; end.battKw < 29 {
		t.Fatalf("the storage must reach its ceiling on a zero-export site, got %.2f kW", end.battKw)
	}
}

// Without an inner loop CapCascade is Cap, sample for sample.
func TestCapCascadeWithoutAnInnerLoopIsCap(t *testing.T) {
	a, b := runCascade(cascadePlant{availKw: 84, loadKw: 5, ceilingKw: 30, socPct: 50, absorbs: true,
		limitKw: 30, seconds: 300}), []cascadeSample(nil)
	l := NewExportLimiter()
	t0 := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	pv, batt, capKw := 84.0, 0.0, math.Inf(1)
	for s := 0; s <= 300; s++ {
		now := t0.Add(time.Duration(s) * time.Second)
		pv += (math.Min(84, capKw) - pv) * (1 - math.Exp(-1/2.0))
		batt += (math.Max(0, math.Min(30, pv-5)) - batt) * (1 - math.Exp(-1/0.5))
		grid := 5 + batt - pv
		if s%5 == 0 {
			l.Observe(now, grid, pv)
		}
		if s%10 == 2 {
			limit := 30.0
			capKw = l.Cap(now, &limit, 0).CapKw
		}
		b = append(b, cascadeSample{t: float64(s), exportKw: -grid, battKw: batt, capKw: capKw, pvKw: pv})
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("sample %d differs: %+v vs %+v", i, a[i], b[i])
		}
	}
}

func TestHeadroomIsZeroWhenAnythingIsUnknown(t *testing.T) {
	ok := InnerLoop{Active: true, CeilingKw: 30, BatteryKw: 10, SocPct: 50, SocMaxPct: 95}
	if h := ok.HeadroomKw(); math.Abs(h-(30-10-CascadeGapKw)) > 1e-9 {
		t.Fatalf("headroom %.3f", h)
	}
	for name, in := range map[string]InnerLoop{
		"inactive":        {CeilingKw: 30, BatteryKw: 10, SocPct: 50},
		"battery unknown": {Active: true, CeilingKw: 30, BatteryKw: math.NaN(), SocPct: 50},
		"soc unknown":     {Active: true, CeilingKw: 30, BatteryKw: 10, SocPct: math.NaN()},
		"soc at the top":  {Active: true, CeilingKw: 30, BatteryKw: 10, SocPct: 95, SocMaxPct: 95},
		"at the ceiling":  {Active: true, CeilingKw: 30, BatteryKw: 29.8, SocPct: 50},
	} {
		if h := in.HeadroomKw(); h != 0 {
			t.Fatalf("%s: an unknown or saturated storage must not hold the watchdog back, got %.3f", name, h)
		}
	}
}
