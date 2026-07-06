package agent

// Agent-level despike gate: a transient in-band garbage read (the captain's
// SoC dropping from 94 % to 2 % for one sample and back) must never surface as
// its garbage VALUE on any live path - the dashboard tiles + energy flow (state
// snapshot), the live charts (history ring) or the cloud (store-and-forward
// buffer). Per the captain's amendment the gate holds the last-good value in
// its place (continuous line, no gaps) rather than dropping the sample, so the
// spike's bogus number never appears while the series stays unbroken.
// onLocalTelemetry is the single choke point, so the gate is proven there end
// to end, feeding the bus payload exactly as a Layer-1 flow would.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

func TestAgentDespikesSocSpikeFromEveryLivePath(t *testing.T) {
	a := newGateTestAgent(t)
	// Anchor just before now so the samples fall inside the history ring's
	// trailing-hour window while keeping the inter-sample deltas deterministic.
	t0 := time.Now().UTC().Add(-time.Minute)
	// A SoC-only stream (a hybrid battery with nothing else wired) makes the
	// captain's symptom exact: the spike sample carries ONLY the bogus 2.
	pub := func(soc float64, at time.Time) {
		a.onLocalTelemetry(localbus.TopicTelemetry,
			[]byte(fmt.Sprintf(`{"ts":%q,"soc_pct":%v}`, at.Format(time.RFC3339), soc)))
	}

	pub(94, t0)
	base := capturePaths(a)
	if base.socTile != 94 || base.pending != 1 || base.ringLen != 1 || base.rawSocVal != 94 {
		t.Fatalf("baseline sample not ingested: %+v", base)
	}

	// The one bogus 2 % sample: the garbage VALUE must never surface. Hold-last
	// keeps every tile/reading at the last-good 94; the series stays continuous
	// (the sample IS recorded, but with 94), so there is no gap on the charts.
	pub(2, t0.Add(5*time.Second))
	got := capturePaths(a)
	if got.socTile != 94 || got.rawSocVal != 94 || got.guardSoc != 94 {
		t.Fatalf("the 2 %% spike leaked into a live path (should hold 94): %+v", got)
	}
	if got.pending != 2 || got.ringLen != 2 {
		t.Fatalf("hold-last must record a continuous sample (no gap): %+v", got)
	}
	if a.State.Get().DespikedDropped != 1 {
		t.Fatalf("despike counter = %d, want 1", a.State.Get().DespikedDropped)
	}

	// The steady value resumes normally: the good 94 that follows is recorded.
	pub(94, t0.Add(10*time.Second))
	after := capturePaths(a)
	if after.socTile != 94 || after.pending != 3 || after.ringLen != 3 {
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

// A live setting change (POST /api/despike -> SetDespike) tightens the power
// gate so an in-band load spike-and-return the default lets through is caught,
// held to the last-good value, on the ingest path - no restart.
func TestAgentDespikeLiveReconfigureTightensPowerGate(t *testing.T) {
	a := newGateTestAgent(t)
	t0 := time.Now().UTC().Add(-time.Minute)
	pub := func(load float64, at time.Time) {
		a.onLocalTelemetry(localbus.TopicTelemetry,
			[]byte(fmt.Sprintf(`{"ts":%q,"load_kw":%v}`, at.Format(time.RFC3339), load)))
	}

	// Default (Normal): a 45 kW load spike-and-return passes untouched (loose).
	pub(5, t0)
	pub(50, t0.Add(5*time.Second))
	if a.State.Get().LoadKw != 50 {
		t.Fatalf("Normal should pass the 45 kW step, tile = %v", a.State.Get().LoadKw)
	}
	pub(5, t0.Add(10*time.Second)) // returns; baseline settles back at 5
	if a.State.Get().DespikedDropped != 0 {
		t.Fatalf("Normal must not drop the spike-and-return, counter = %d", a.State.Get().DespikedDropped)
	}

	// Operator tightens to "Streng" live (no restart).
	if _, err := a.SetDespike(guards.DespikeSettings{Preset: guards.PresetStrict}); err != nil {
		t.Fatal(err)
	}
	pub(50, t0.Add(15*time.Second)) // the same-shaped spike is now caught
	if a.State.Get().LoadKw != 5 {
		t.Fatalf("Streng must catch the 45 kW spike and hold last-good 5, tile = %v", a.State.Get().LoadKw)
	}
	if a.State.Get().DespikedDropped != 1 {
		t.Fatalf("live tightening should have dropped exactly the spike, counter = %d", a.State.Get().DespikedDropped)
	}
}
