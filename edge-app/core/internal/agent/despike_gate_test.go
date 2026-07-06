package agent

// Agent-level despike gate: a transient in-band garbage read (the captain's
// SoC dropping from 94 % to 2 % for one sample and back) must never surface on
// ANY live path - the dashboard tiles + energy flow (state snapshot), the live
// charts (history ring) or the cloud (store-and-forward buffer). onLocalTelemetry
// is the single choke point, so the gate is proven there end to end, feeding the
// bus payload exactly as a Layer-1 flow would.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

func TestAgentDespikesSocSpikeFromEveryLivePath(t *testing.T) {
	a := newGateTestAgent(t)
	// Anchor just before now so the samples fall inside the history ring's
	// trailing-hour window while keeping the inter-sample deltas deterministic.
	t0 := time.Now().UTC().Add(-time.Minute)
	// A SoC-only stream (a hybrid battery with nothing else wired) makes the
	// captain's symptom exact: the spike sample carries ONLY the bogus 2, so a
	// dropped SoC leaves the sample empty and nothing is recorded at all.
	pub := func(soc float64, at time.Time) {
		a.onLocalTelemetry(localbus.TopicTelemetry,
			[]byte(fmt.Sprintf(`{"ts":%q,"soc_pct":%v}`, at.Format(time.RFC3339), soc)))
	}

	pub(94, t0)
	base := capturePaths(a)
	if base.socTile != 94 || base.pending != 1 || base.ringLen != 1 || base.rawSocVal != 94 {
		t.Fatalf("baseline sample not ingested: %+v", base)
	}

	// The one bogus 2 % sample: it must change NOTHING on ANY live path.
	pub(2, t0.Add(5*time.Second))
	got := capturePaths(a)
	if got != base {
		t.Fatalf("the 2 %% spike leaked into a live path:\n got %+v\nwant %+v", got, base)
	}
	if a.State.Get().DespikedDropped != 1 {
		t.Fatalf("despike counter = %d, want 1", a.State.Get().DespikedDropped)
	}

	// The steady value resumes normally: the good 94 that follows is recorded.
	pub(94, t0.Add(10*time.Second))
	after := capturePaths(a)
	if after.socTile != 94 || after.pending != 2 || after.ringLen != 2 {
		t.Fatalf("steady value after the spike did not resume: %+v", after)
	}
}

// A SoC glitch inside a multi-channel sample drops ONLY SoC; the good power
// channels in the same sample are still recorded (the whole sample is not lost).
func TestAgentDespikeKeepsGoodChannelsOfAGlitchySample(t *testing.T) {
	a := newGateTestAgent(t)
	t0 := time.Now().UTC().Add(-time.Minute)

	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(`{"ts":%q,"soc_pct":94,"pv_power_kw":3.0,"load_kw":1.0}`, t0.Format(time.RFC3339))))
	// SoC glitches; PV steps up plausibly at the same time.
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(`{"ts":%q,"soc_pct":2,"pv_power_kw":4.5,"load_kw":1.1}`,
			t0.Add(5*time.Second).Format(time.RFC3339))))

	snap := a.State.Get()
	if snap.SocPct != 94 {
		t.Fatalf("SoC tile should keep last-good 94, got %v", snap.SocPct)
	}
	if snap.PvKw != 4.5 {
		t.Fatalf("good PV value in the glitchy sample was lost, got %v", snap.PvKw)
	}
	// Both samples were recorded (the second kept its good channels).
	if got := capturePaths(a); got.pending != 2 || got.ringLen != 2 {
		t.Fatalf("glitchy sample should still be recorded with its good channels: %+v", got)
	}
}
