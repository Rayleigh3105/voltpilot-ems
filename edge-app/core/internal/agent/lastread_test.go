package agent

// "Zuletzt gelesen" (last-read display on the :8484 setup page): every bound
// device/source surfaces its most recent ACCEPTED reading + when it was read,
// without a parallel measurement store - the sources' freshness machinery
// (srcReadings) and the primary's telemetry choke point already track it.
// This proves:
//   - SourceLastReadings surfaces value + receive time per source; a source
//     that never delivered is ABSENT (never a fabricated value);
//   - the primary's snapshot LastReading carries the device's OWN values
//     (captured before multi-source aggregation), with per-channel presence;
//   - the display honors the gates: an implausible sample changes nothing, a
//     despiked channel holds its last accepted value (the raw spike is never
//     shown) while the sample's good channels still update.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

func TestSourceLastReadingsSurfaceValueAndTimestamp(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 40)
	netz := addNetz(t, a)
	never := addErzeuger(t, a, 10) // configured but never read

	before := time.Now().Add(-time.Second).UnixMilli()
	feedSource(a, erz.ID, 20.1)
	feedNetz(a, netz.ID, -3.4)
	after := time.Now().Add(time.Second).UnixMilli()

	got := a.SourceLastReadings()
	e, ok := got[erz.ID]
	if !ok || e.PvKw == nil || *e.PvKw != 20.1 || e.PowerKw != nil {
		t.Fatalf("Erzeuger reading wrong: %+v (ok=%v)", e, ok)
	}
	if e.ReadAtMs < before || e.ReadAtMs > after {
		t.Fatalf("Erzeuger ReadAtMs %d outside [%d, %d]", e.ReadAtMs, before, after)
	}
	n, ok := got[netz.ID]
	if !ok || n.PowerKw == nil || *n.PowerKw != -3.4 || n.PvKw != nil {
		t.Fatalf("Netz reading wrong: %+v (ok=%v)", n, ok)
	}
	if _, ok := got[never.ID]; ok {
		t.Fatalf("never-read source must be absent from the readings map")
	}
}

func TestPrimaryLastReadingIsTheDevicesOwnValuesNotTheComposite(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 40)
	feedSource(a, erz.ID, 30)
	feedPrimary(a, 20, 90, -5, 50)

	snap := a.State.Get()
	// The composite site reading aggregates the Erzeuger (the existing path)...
	if snap.PvKw != 50 || snap.LoadKw != 60 {
		t.Fatalf("composite wrong: pv=%v load=%v", snap.PvKw, snap.LoadKw)
	}
	// ...but the "Zuletzt gelesen" reading is the primary's OWN values.
	want := map[string]float64{"pv_power_kw": 20, "load_kw": 90, "power_kw": -5, "soc_pct": 50}
	if len(snap.LastReading) != len(want) {
		t.Fatalf("LastReading = %+v, want %+v", snap.LastReading, want)
	}
	for k, v := range want {
		if snap.LastReading[k] != v {
			t.Fatalf("LastReading[%s] = %v, want %v (full: %+v)", k, snap.LastReading[k], v, snap.LastReading)
		}
	}
}

func TestPrimaryLastReadingKeepsAbsentChannelsAbsent(t *testing.T) {
	a := newGateTestAgent(t)
	// A batteryless string inverter reports ONLY its generation - a genuine
	// night 0 must render, and SoC/load must not appear as fabricated zeros.
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 0}`))
	snap := a.State.Get()
	if len(snap.LastReading) != 1 {
		t.Fatalf("LastReading = %+v, want only pv_power_kw", snap.LastReading)
	}
	if v, ok := snap.LastReading["pv_power_kw"]; !ok || v != 0 {
		t.Fatalf("genuine 0 kW reading missing: %+v", snap.LastReading)
	}
}

func TestPrimaryLastReadingHonorsTheGates(t *testing.T) {
	a := newGateTestAgent(t)
	feedPrimary(a, 3.0, 1.0, -2.0, 94)
	base := a.State.Get()
	if base.LastReading["soc_pct"] != 94 {
		t.Fatalf("baseline not recorded: %+v", base.LastReading)
	}

	// An implausible SoC drops the WHOLE sample - the last-read display keeps
	// the previous reading and its timestamp.
	feedPrimary(a, 3.1, 1.1, -2.1, 1270)
	got := a.State.Get()
	if got.LastReading["soc_pct"] != 94 || got.LastReading["pv_power_kw"] != 3.0 {
		t.Fatalf("implausible sample leaked into LastReading: %+v", got.LastReading)
	}
	if !got.LastTelemetry.Equal(base.LastTelemetry) {
		t.Fatal("timestamp must not advance on a dropped sample")
	}

	// An in-band SoC spike (94 -> 2, the captain's real symptom) is despiked:
	// the raw 2 is NEVER shown - the channel holds its last accepted value -
	// while the same sample's good channels still update.
	feedPrimary(a, 3.5, 1.2, -2.2, 2)
	got = a.State.Get()
	if got.LastReading["soc_pct"] != 94 {
		t.Fatalf("despiked spike value shown in LastReading: %+v", got.LastReading)
	}
	if got.LastReading["pv_power_kw"] != 3.5 {
		t.Fatalf("good channel of a partially-gated sample not updated: %+v", got.LastReading)
	}
	if !got.LastTelemetry.After(base.LastTelemetry) {
		t.Fatal("timestamp should advance on a kept sample")
	}
}
