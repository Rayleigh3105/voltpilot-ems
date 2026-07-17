package agent

// Agent-level physical-envelope gate: with the captain's inverter (a 12 kW Deye
// hybrid) selected, an UNBALANCED ~26 kW single-sample grid spike - which the
// rate gate lets through at a slow cadence on any preset - must never surface on
// the derived battery curve (battery = grid - load + pv) or anywhere else. The
// envelope holds the offending grid channel to its last in-envelope value, so
// all four lines stay continuous, regardless of the despike preset. And with NO
// inverter selected, the envelope is inactive and the same spike passes.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// select12kHybrid picks the captain's SUN-12K-SG04LP3 so the physical envelope
// (PV 26 kW, battery 20 kW) is active.
func select12kHybrid(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye,
		Model: "sun-12k-sg04lp3",
		Connection: inverter.Connection{
			IP:     "192.168.0.28",
			Serial: "2985159064",
		},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	if !a.envelope.Active() {
		t.Fatal("the envelope must be active after selecting a rated model")
	}
}

// derivedBattery mirrors history.Sample.BatteryKw (grid - load + pv) so the test
// asserts the exact value the dashboard's green line renders.
func derivedBattery(grid, load, pv float64) float64 { return grid - load + pv }

func TestAgentEnvelopeHoldsCaptainsGridSpikeAtAnyPreset(t *testing.T) {
	a := newGateTestAgent(t)
	select12kHybrid(t, a)
	// The samples below carry no battery_power_kw, so under the default-on
	// house-consumption standard a hybrid would drop its load channel (honest
	// absence) and the derived-battery bound could not compute. This test
	// exercises exactly the RAW-LOAD path's protection (the derived battery is
	// display-era legacy kept as a diagnostic), so declare the expert opt-out.
	optOut(t, a)
	// Use "Aus" so the rate gate is fully OFF: whatever catches the spike is the
	// physical envelope alone, proving it is preset-independent.
	if _, err := a.SetDespike(guards.DespikeSettings{Preset: guards.PresetOff}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().UTC().Add(-time.Minute)
	pub := func(grid, load, pv float64, at time.Time) {
		a.onLocalTelemetry(localbus.TopicTelemetry, []byte(fmt.Sprintf(
			`{"ts":%q,"power_kw":%v,"load_kw":%v,"pv_power_kw":%v}`,
			at.Format(time.RFC3339), grid, load, pv)))
	}
	battOf := func() float64 {
		s, ok := a.hist.Latest()
		if !ok {
			t.Fatal("history ring is empty")
		}
		b, ok := s.BatteryKw()
		if !ok {
			t.Fatal("battery not derivable from the latest sample")
		}
		return b
	}

	// A steady, balanced series: grid 4, load 5, pv 1 -> battery = 0.
	pub(4, 5, 1, t0)
	if got := battOf(); got != 0 {
		t.Fatalf("baseline derived battery = %v, want 0", got)
	}
	// The captain's spike: grid jumps to 26, load/pv steady. Derived battery would
	// be 26 - 5 + 1 = 22 kW (> 20 kW bound). The envelope holds grid to 4, so the
	// recorded battery stays 0 - the green line does not move.
	pub(26, 5, 1, t0.Add(10*time.Second))
	if got := battOf(); got != derivedBattery(4, 5, 1) {
		t.Fatalf("the grid spike leaked into the derived battery: got %v, want 0 (held)", got)
	}
	if snap := a.State.Get(); snap.DespikedDropped != 1 {
		t.Fatalf("exactly the spike must be counted, DespikedDropped = %d", snap.DespikedDropped)
	}
	// It was the ENVELOPE (not the disabled rate gate) that caught it.
	if a.despiker.DroppedTotal() != 0 || a.envelope.DroppedTotal() != 1 {
		t.Fatalf("the envelope must be the gate that fired: despiker=%d envelope=%d",
			a.despiker.DroppedTotal(), a.envelope.DroppedTotal())
	}
	// The return to a normal grid value resumes normally.
	pub(4.2, 5, 1, t0.Add(20*time.Second))
	if got := battOf(); got != derivedBattery(4.2, 5, 1) {
		t.Fatalf("normal series did not resume after the spike: got %v", got)
	}
	// The per-channel counter attributes the drop to the grid channel.
	if by := a.GetDespike().Counters["power_kw"]; by != 1 {
		t.Fatalf("grid channel counter = %d, want 1", by)
	}
}

func TestAgentEnvelopeInactiveWithoutInverterPassesSpike(t *testing.T) {
	a := newGateTestAgent(t)
	// No inverter selected -> the envelope is inactive. Use "Aus" so the rate gate
	// does not fire either: the spike must pass through onto the derived battery.
	if _, err := a.SetDespike(guards.DespikeSettings{Preset: guards.PresetOff}); err != nil {
		t.Fatal(err)
	}
	if a.envelope.Active() {
		t.Fatal("the envelope must be inactive with no inverter selected")
	}
	t0 := time.Now().UTC().Add(-time.Minute)
	pub := func(grid, load, pv float64, at time.Time) {
		a.onLocalTelemetry(localbus.TopicTelemetry, []byte(fmt.Sprintf(
			`{"ts":%q,"power_kw":%v,"load_kw":%v,"pv_power_kw":%v}`,
			at.Format(time.RFC3339), grid, load, pv)))
	}
	pub(4, 5, 1, t0)
	pub(26, 5, 1, t0.Add(10*time.Second))
	s, _ := a.hist.Latest()
	b, _ := s.BatteryKw()
	if b != derivedBattery(26, 5, 1) {
		t.Fatalf("with no envelope and the gate off, the spike must pass: battery = %v, want 22", b)
	}
	if a.State.Get().DespikedDropped != 0 {
		t.Fatalf("nothing must be dropped with envelope inactive + gate off, got %d", a.State.Get().DespikedDropped)
	}
}
