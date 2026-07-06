package agent

// Live-path SoC plausibility gate: a garbage inverter read (the captain's
// real "1.270 %" dashboard tile) must never be displayed or published
// anywhere. onLocalTelemetry is the single choke point every live surface
// hangs off - the dashboard tiles + energy flow (state snapshot), the live
// charts (history ring), the cloud publish (store-and-forward buffer), the
// status heartbeat (lastRawSoc) and the setpoint guards (lastReading) - so
// the gate is proven there: an implausible sample changes NONE of them, and
// the next good sample updates all of them normally.

import (
	"fmt"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

func newGateTestAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)
	return a
}

// livePaths captures every consumer of a local telemetry sample.
type livePaths struct {
	socTile   float64 // state snapshot -> dashboard tiles / energy flow
	lastTel   time.Time
	pending   int // store-and-forward buffer -> cloud publish
	ringLen   int // history ring -> live charts
	guardSoc  float64
	rawSocSet bool
	rawSocVal float64
}

func capturePaths(a *Agent) livePaths {
	snap := a.State.Get()
	a.mu.Lock()
	defer a.mu.Unlock()
	p := livePaths{
		socTile:  snap.SocPct,
		lastTel:  snap.LastTelemetry,
		pending:  a.buf.Pending(),
		ringLen:  len(a.hist.Recent(time.Hour, time.Now())),
		guardSoc: a.lastReading.SocPct,
	}
	if a.lastRawSoc != nil {
		p.rawSocSet, p.rawSocVal = true, *a.lastRawSoc
	}
	return p
}

func TestImplausibleSocSampleIsDroppedFromEveryLivePath(t *testing.T) {
	a := newGateTestAgent(t)
	pub := func(soc float64) {
		a.onLocalTelemetry(localbus.TopicTelemetry,
			[]byte(fmt.Sprintf(`{"soc_pct": %v, "pv_power_kw": 3.2, "load_kw": 1.1, "power_kw": -2.1}`, soc)))
	}

	pub(54.5)
	good := capturePaths(a)
	if good.socTile != 54.5 || good.pending != 1 || good.ringLen != 1 {
		t.Fatalf("good sample not ingested: %+v", good)
	}
	if !good.rawSocSet || good.rawSocVal != 54.5 || good.guardSoc != 54.5 {
		t.Fatalf("good sample did not reach status/guard readings: %+v", good)
	}

	// The captain's real symptom (raw 1270 rendered as "1.270 %"), plus the
	// exact-0 empty-answer signature: both drop, every path keeps last-good.
	for _, garbage := range []float64{1270, 0, -3, 100.5} {
		pub(garbage)
		got := capturePaths(a)
		if got != good {
			t.Fatalf("implausible soc %v leaked into a live path:\n got %+v\nwant %+v", garbage, got, good)
		}
	}
	if !good.lastTel.Equal(a.State.Get().LastTelemetry) {
		t.Fatal("freshness must not advance on a dropped sample (the staleness UI depends on it)")
	}

	// A new good read updates every path normally again.
	pub(56)
	after := capturePaths(a)
	if after.socTile != 56 || after.pending != 2 || after.ringLen != 2 ||
		after.guardSoc != 56 || !after.rawSocSet || after.rawSocVal != 56 {
		t.Fatalf("good sample after garbage did not update the live paths: %+v", after)
	}
	if !after.lastTel.After(good.lastTel) && !after.lastTel.Equal(good.lastTel) {
		t.Fatalf("freshness did not advance on the good sample")
	}

	// A sample WITHOUT SoC (string/micro inverters, no battery) is ungated: a
	// genuine 0 kW night reading must stay a real, kept reading.
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 0}`))
	if got := capturePaths(a); got.ringLen != 3 || got.pending != 3 {
		t.Fatalf("soc-less sample was wrongly gated: %+v", got)
	}
	// The guard reading for the soc-less sample carries "unknown", never a
	// fabricated number.
	a.mu.Lock()
	socUnknown := math.IsNaN(a.lastReading.SocPct)
	a.mu.Unlock()
	if !socUnknown {
		t.Fatal("soc-less sample must leave the guard SoC unknown")
	}
}
