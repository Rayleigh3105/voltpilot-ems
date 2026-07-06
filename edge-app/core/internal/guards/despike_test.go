package guards

import (
	"testing"
	"time"
)

// feed pushes one measurement value for a single channel at time now and
// reports whether it was accepted (true) or rejected/held (false). With
// hold-last the channel is never removed from the map, so "kept" means the
// value was NOT despiked (i.e. it does not appear in the drop list).
func feed(d *Despiker, channel string, v float64, now time.Time) bool {
	m := map[string]float64{channel: v}
	for _, dr := range d.Accept(m, now) {
		if dr.Channel == channel {
			return false
		}
	}
	return true
}

// TestDespikeSocSingleSpikeIsDropped is the captain's exact symptom: a steady
// 94 %, one bogus 2 % for a single sample, then back to 94 %. The 2 must be
// rejected (and held to the last-good 94); the 94 that follows must be kept.
func TestDespikeSocSingleSpikeIsDropped(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	if !feed(d, "soc_pct", 94, t0) {
		t.Fatal("first SoC sample must be accepted as the baseline")
	}
	// Hold-last: the map value is replaced with the last-good 94, not removed.
	m := map[string]float64{"soc_pct": 2}
	drops := d.Accept(m, t0.Add(step))
	if len(drops) != 1 || drops[0].Channel != "soc_pct" || drops[0].Held != 94 {
		t.Fatalf("the 2 %% spike must be dropped and held to 94, got %+v", drops)
	}
	if m["soc_pct"] != 94 {
		t.Fatalf("despiked SoC must be held-last to 94 (continuous line), got %v", m["soc_pct"])
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
// (decode garbage) that immediately returns is dropped and held-last.
func TestDespikePowerSpikeAndReturnDropped(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	feed(d, "load_kw", 5, t0)
	m := map[string]float64{"load_kw": 2000}
	drops := d.Accept(m, t0.Add(step))
	if len(drops) != 1 || m["load_kw"] != 5 {
		t.Fatalf("a 2000 kW garbage read must be dropped and held to 5, got drops=%+v m=%v", drops, m["load_kw"])
	}
	if !feed(d, "load_kw", 5.2, t0.Add(2*step)) {
		t.Fatal("the return to a normal load must be accepted")
	}
	if got := d.DroppedTotal(); got != 1 {
		t.Fatalf("dropped total = %d, want 1", got)
	}
}

// TestDespikePowerFastStepPasses: a genuinely fast but physically plausible
// power step (a big appliance switching on, a cloud edge) passes unfiltered at
// the default (Normal) preset - power is generously bounded, so real dynamics
// are never eaten.
func TestDespikePowerFastStepPasses(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	feed(d, "pv_power_kw", 2, t0)
	// A cloud clears: PV jumps 2 -> 45 kW in one sample. Must pass.
	if !feed(d, "pv_power_kw", 45, t0.Add(step)) {
		t.Fatal("a plausible fast PV step must pass unfiltered at the default preset")
	}
	// A large load switches on: 3 -> 55 for load is fine too.
	feed(d, "load_kw", 3, t0)
	if !feed(d, "load_kw", 55, t0.Add(step)) {
		t.Fatal("a plausible fast load step must pass unfiltered at the default preset")
	}
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("dropped total = %d, want 0 on genuine fast steps", got)
	}
}

// TestDespikeStrictCatchesWhatDefaultLetsThrough: a moderate in-band power
// spike-and-return that the default (Normal) preset passes is caught once the
// operator tightens the filter to "Streng".
func TestDespikeStrictCatchesWhatDefaultLetsThrough(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second
	// A 45 kW spike over 5 s and back. Normal allows margin 15 + 15 kW/s*5 = 90 kW,
	// so 45 passes; Streng allows 5 + 5*5 = 30 kW, so 45 is caught.
	spikeAndReturn := func(d *Despiker) (spikeKept, returnKept bool) {
		feed(d, "load_kw", 5, t0)
		spikeKept = feed(d, "load_kw", 50, t0.Add(step))
		returnKept = feed(d, "load_kw", 5.5, t0.Add(2*step))
		return
	}

	normal := NewDespikerWithSettings(PresetSettings(PresetNormal))
	if sk, _ := spikeAndReturn(normal); !sk {
		t.Fatal("Normal is deliberately loose: the 45 kW spike passes (never eats real dynamics)")
	}

	strict := NewDespikerWithSettings(PresetSettings(PresetStrict))
	if sk, _ := spikeAndReturn(strict); sk {
		t.Fatal("Streng must catch the 45 kW in-band spike the default lets through")
	}
	if got := strict.DroppedTotal(); got != 1 {
		t.Fatalf("strict dropped total = %d, want 1", got)
	}
}

// TestDespikeDisabledChannelPasses: the "Aus" preset (or a per-channel disable)
// never gates a channel, whatever the jump.
func TestDespikeDisabledChannelPasses(t *testing.T) {
	d := NewDespikerWithSettings(PresetSettings(PresetOff))
	t0 := time.Unix(1_700_000_000, 0)
	feed(d, "soc_pct", 94, t0)
	if !feed(d, "soc_pct", 2, t0.Add(5*time.Second)) {
		t.Fatal("a disabled SoC gate must pass even an implausible jump")
	}
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("dropped total = %d, want 0 with the gate off", got)
	}
}

// TestDespikeIndependentChannels: a SoC spike in a multi-channel sample holds
// ONLY the SoC value to last-good; the good power channels in the same sample
// survive unchanged.
func TestDespikeIndependentChannels(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	// Baseline.
	d.Accept(map[string]float64{"soc_pct": 94, "pv_power_kw": 3, "load_kw": 1}, t0)
	// Next sample: SoC glitches to 2, power channels are fine.
	m := map[string]float64{"soc_pct": 2, "pv_power_kw": 3.1, "load_kw": 1.1}
	d.Accept(m, t0.Add(step))
	if m["soc_pct"] != 94 {
		t.Fatalf("the SoC spike must be held to last-good 94, got %v", m["soc_pct"])
	}
	if m["pv_power_kw"] != 3.1 || m["load_kw"] != 1.1 {
		t.Fatalf("good power channels must survive a SoC spike: %+v", m)
	}
}

// TestDespikeGridLimitLegitStepPassesButGarbageIsCaught: grid_limit_kw is now
// gated, but tuned so a real (small) §14a envelope change passes immediately
// while a gross garbage value is caught (and held to last-good).
func TestDespikeGridLimitLegitStepPassesButGarbageIsCaught(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := time.Second

	feed(d, "grid_limit_kw", 11, t0)
	// A legitimate §14a dim to 4.2 kW (within the margin) passes immediately.
	if !feed(d, "grid_limit_kw", 4.2, t0.Add(step)) {
		t.Fatal("a legitimate §14a envelope change must pass immediately")
	}
	// A gross garbage read is caught and held to the last-good 4.2.
	m := map[string]float64{"grid_limit_kw": 900}
	d.Accept(m, t0.Add(2*step))
	if m["grid_limit_kw"] != 4.2 {
		t.Fatalf("a gross grid_limit garbage read must be held to last-good 4.2, got %v", m["grid_limit_kw"])
	}
}

// TestDespikePerChannelCounters: the per-channel rejection counters track which
// channel the filter is actually catching.
func TestDespikePerChannelCounters(t *testing.T) {
	d := NewDespiker()
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	feed(d, "soc_pct", 94, t0)
	feed(d, "load_kw", 5, t0)
	feed(d, "soc_pct", 2, t0.Add(step))      // dropped
	feed(d, "load_kw", 3000, t0.Add(step))   // dropped
	feed(d, "load_kw", 4000, t0.Add(2*step)) // dropped (still suspect vs 5)

	by := d.DroppedByChannel()
	if by["soc_pct"] != 1 {
		t.Fatalf("soc_pct counter = %d, want 1", by["soc_pct"])
	}
	if by["load_kw"] != 2 {
		t.Fatalf("load_kw counter = %d, want 2", by["load_kw"])
	}
}

// TestDespikeReconfigureAppliesLive: the same-shaped in-band spike-and-return is
// passed under Normal and caught under Streng once the operator tightens the
// filter live (no restart), and the running channel state carries across.
func TestDespikeReconfigureAppliesLive(t *testing.T) {
	d := NewDespikerWithSettings(PresetSettings(PresetNormal))
	t0 := time.Unix(1_700_000_000, 0)
	step := 5 * time.Second

	// Phase 1 under Normal: a 45 kW spike-and-return is not caught (loose).
	feed(d, "load_kw", 5, t0)
	feed(d, "load_kw", 50, t0.Add(step))
	feed(d, "load_kw", 5.5, t0.Add(2*step))
	if got := d.DroppedTotal(); got != 0 {
		t.Fatalf("Normal should pass the spike-and-return, dropped = %d", got)
	}

	// Tighten to Streng live; the same-shaped spike is now caught.
	d.Reconfigure(PresetSettings(PresetStrict))
	feed(d, "load_kw", 5, t0.Add(3*step)) // re-establish the steady baseline
	if feed(d, "load_kw", 50, t0.Add(4*step)) {
		t.Fatal("after tightening to Streng live, the 45 kW spike must be caught")
	}
	if got := d.DroppedTotal(); got != 1 {
		t.Fatalf("dropped total after live tightening = %d, want 1", got)
	}
}
