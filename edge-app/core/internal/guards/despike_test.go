package guards

import (
	"testing"
	"time"
)

// feed pushes one measurement value for a single channel at time now and
// reports whether it was kept (true) or dropped (false).
func feed(d *Despiker, channel string, v float64, now time.Time) bool {
	m := map[string]float64{channel: v}
	d.Accept(m, now)
	_, kept := m[channel]
	return kept
}

// TestDespikeSocSingleSpikeIsDropped is the captain's exact symptom: a steady
// 94 %, one bogus 2 % for a single sample, then back to 94 %. The 2 must be
// dropped; the 94 that follows must be kept.
func TestDespikeSocSingleSpikeIsDropped(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	if !feed(d, "soc_pct", 94, t0) {
		t.Fatal("first SoC sample must be accepted as the baseline")
	}
	if feed(d, "soc_pct", 2, t0.Add(step)) {
		t.Fatal("the 2 %% spike must be dropped")
	}
	if !feed(d, "soc_pct", 94, t0.Add(2*step)) {
		t.Fatal("the return to 94 %% must be accepted")
	}
	if got := d.DroppedTotal(); got != 1 {
		t.Fatalf("dropped total = %d, want 1", got)
	}
}

// TestDespikeSocSteadyDischargePasses: a legitimate slow discharge (well within
// any C-rate) is never rejected.
func TestDespikeSocSteadyDischargePasses(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	soc := 94.0
	for i := 0; i < 20; i++ {
		soc -= 0.5 // 0.5 % per 10 s sample = a gentle discharge
		if !feed(d, "soc_pct", soc, t0.Add(time.Duration(i+1)*10*time.Second)) {
			t.Fatalf("steady discharge sample %d (%.1f %%) was wrongly dropped", i, soc)
		}
	}
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("dropped total = %d, want 0 on a clean discharge", got)
	}
}

// TestDespikeSocPersistentLevelConverges: a genuine step change (BMS resync)
// that PERSISTS is adopted after confirmCount consecutive agreeing samples.
func TestDespikeSocPersistentLevelConverges(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 10 * time.Second

	feed(d, "soc_pct", 94, t0)
	// Three samples at the new level 50. The first two are dropped (unconfirmed),
	// the third is adopted (confirmCount = 3).
	drops := 0
	for i := 1; i <= 3; i++ {
		if !feed(d, "soc_pct", 50, t0.Add(time.Duration(i)*step)) {
			drops++
		}
	}
	if drops != 2 {
		t.Fatalf("expected the first 2 of 3 confirming samples dropped, got %d dropped", drops)
	}
	// The level has converged: a further 50 (and small moves around it) pass.
	if !feed(d, "soc_pct", 50, t0.Add(4*step)) {
		t.Fatal("after confirmation the new level must be tracked")
	}
	if !feed(d, "soc_pct", 49.7, t0.Add(5*step)) {
		t.Fatal("a small move around the converged level must pass")
	}
}

// TestDespikeSocLongGapReboot: after a long silence (reboot) the first sample
// is accepted as a fresh baseline even if it is far from the pre-gap value.
func TestDespikeSocLongGapReboot(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)

	feed(d, "soc_pct", 94, t0)
	// Hours later the battery genuinely sits at 20 %; must NOT be rejected.
	if !feed(d, "soc_pct", 20, t0.Add(3*time.Hour)) {
		t.Fatal("first post-reboot sample must be accepted as a fresh baseline")
	}
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("dropped total = %d, want 0 across a reboot", got)
	}
}

// TestDespikeSocRateScalesWithElapsed: a change that is impossible over seconds
// becomes plausible over a longer (but sub-gapReset) interval.
func TestDespikeSocRateScalesWithElapsed(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)

	feed(d, "soc_pct", 90, t0)
	// A 40 %% move: rejected over 10 s (allowed ~15), ...
	if feed(d, "soc_pct", 50, t0.Add(10*time.Second)) {
		t.Fatal("40 %% over 10 s must be rejected")
	}
	d2 := NewDespiker()
	feed(d2, "soc_pct", 90, t0)
	// ... but accepted over 2 min (allowed ~125), well under gapReset.
	if !feed(d2, "soc_pct", 50, t0.Add(2*time.Minute)) {
		t.Fatal("40 %% over 2 min must be accepted")
	}
}

// TestDespikePowerSpikeAndReturnDropped: a gross single-sample power excursion
// (decode garbage) that immediately returns is dropped.
func TestDespikePowerSpikeAndReturnDropped(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	feed(d, "load_kw", 5, t0)
	if feed(d, "load_kw", 2000, t0.Add(step)) {
		t.Fatal("a 2000 kW garbage read must be dropped")
	}
	if !feed(d, "load_kw", 5.2, t0.Add(2*step)) {
		t.Fatal("the return to a normal load must be accepted")
	}
	if got := d.DroppedTotal(); got != 1 {
		t.Fatalf("dropped total = %d, want 1", got)
	}
}

// TestDespikePowerFastStepPasses: a genuinely fast but physically plausible
// power step (a big appliance switching on, a cloud edge) passes unfiltered -
// power is NOT rate-limited, only guarded against gross decode garbage.
func TestDespikePowerFastStepPasses(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	feed(d, "pv_power_kw", 2, t0)
	// A cloud clears: PV jumps 2 -> 45 kW in one sample. Must pass.
	if !feed(d, "pv_power_kw", 45, t0.Add(step)) {
		t.Fatal("a plausible fast PV step must pass unfiltered")
	}
	// A large load switches on: 45 -> 5 for load is fine too.
	feed(d, "load_kw", 3, t0)
	if !feed(d, "load_kw", 55, t0.Add(step)) {
		t.Fatal("a plausible fast load step must pass unfiltered")
	}
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("dropped total = %d, want 0 on genuine fast steps", got)
	}
}

// TestDespikeIndependentChannels: a SoC spike in a multi-channel sample drops
// ONLY the SoC value; the good power channels in the same sample survive.
func TestDespikeIndependentChannels(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	// Baseline.
	d.Accept(map[string]float64{"soc_pct": 94, "pv_power_kw": 3, "load_kw": 1}, t0)
	// Next sample: SoC glitches to 2, power channels are fine.
	m := map[string]float64{"soc_pct": 2, "pv_power_kw": 3.1, "load_kw": 1.1}
	d.Accept(m, t0.Add(step))
	if _, ok := m["soc_pct"]; ok {
		t.Fatal("the SoC spike must be dropped from the sample")
	}
	if m["pv_power_kw"] != 3.1 || m["load_kw"] != 1.1 {
		t.Fatalf("good power channels must survive a SoC spike: %+v", m)
	}
}

// TestDespikeUngatedChannelAlwaysPasses: grid_limit_kw has no configured gate
// (a §14a envelope change is a legitimate step), so it is never touched.
func TestDespikeUngatedChannelAlwaysPasses(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	feed(d, "grid_limit_kw", 11, t0)
	if !feed(d, "grid_limit_kw", 4.2, t0.Add(time.Second)) {
		t.Fatal("grid_limit_kw must never be gated")
	}
}
