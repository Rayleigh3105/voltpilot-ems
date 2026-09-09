package agent

// P4: der BMS-Block des Deye (0x00D2..0x00DF) auf dem Weg von Layer 1 in den
// Herzschlag.
//
// Layer 1 dekodiert die Register und veroeffentlicht sie als `bms_*`-Kanaele
// NEBEN der Messung auf edge/telemetry. Der Kern nimmt sie mit, ohne dass ein
// einziger Messkanal dazukommt - der eingefrorene v1-Telemetrievertrag bleibt
// unberuehrt - und traegt sie als reine SICHTBARKEIT im `sources`-Block des
// Status-Herzschlags weiter.
//
// Was hier bewiesen wird:
//   1. Ohne Kopplung entsteht KEIN Feld (nicht "0 %", nicht "BMS-Typ PYLON").
//   2. Mit Kopplung reisen genau die gemeldeten Kanaele, unveraendert.
//   3. Die Kanaele werden NIE zu Messkanaelen (Puffer/Verlauf/Kacheln).
//   4. Eine verschwundene Kopplung hoert auf, Zahlen zu behaupten.

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// newBmsTestAgent is a gate agent that HAS a primary inverter, so the sources
// heartbeat carries its entry (the block the BMS view rides on).
func newBmsTestAgent(t *testing.T) *Agent {
	t.Helper()
	a := newGateTestAgent(t)
	a.inv = &inverter.Selection{Brand: "deye", Model: "sun-30k-sg02hp3", Family: "hybrid_3p"}
	return a
}

// coupledSample is what deye-decode publishes for a CAN-coupled battery: the
// site measurement PLUS the BMS block's own channels.
const coupledSample = `{"ts":%q,"pv_power_kw":6.1,"load_kw":4.3,"power_kw":1.2,` +
	`"soc_pct":47,"soc_source":"bms","bms_soc_pct":47,"bms_voltage_v":642,` +
	`"bms_current_a":-30,"bms_charge_limit_a":270,"bms_discharge_limit_a":342,` +
	`"bms_alarm":0,"bms_fault":0,"bms_type":10}`

// uncoupledSample is the live Muehlfeldweg answer: the very same plant with the
// BMS block reading fourteen zeros - so Layer 1 publishes no bms_* channel.
const uncoupledSample = `{"ts":%q,"pv_power_kw":6.1,"load_kw":4.3,"power_kw":1.2,"soc_pct":47}`

func TestBmsBlockAbsentWithoutCoupling(t *testing.T) {
	a := newBmsTestAgent(t)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(uncoupledSample, time.Now().UTC().Format(time.RFC3339))))

	if got := a.State.Get().BmsReading; got != nil {
		t.Fatalf("BmsReading = %v, want nil - an uncoupled BMS says NOTHING", got)
	}
	sum := a.sourcesSummary()
	if sum == nil || len(sum.Entries) == 0 {
		t.Fatal("the primary inverter must still appear in the sources block")
	}
	if sum.Entries[0].Bms != nil {
		t.Fatalf("heartbeat carried a bms block for an uncoupled plant: %v", sum.Entries[0].Bms)
	}
}

func TestBmsBlockTravelsOnTheHeartbeatWhenCoupled(t *testing.T) {
	a := newBmsTestAgent(t)
	now := time.Now().UTC()
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(coupledSample, now.Format(time.RFC3339))))

	want := map[string]float64{
		"bms_soc_pct": 47, "bms_voltage_v": 642, "bms_current_a": -30,
		"bms_charge_limit_a": 270, "bms_discharge_limit_a": 342,
		"bms_alarm": 0, "bms_fault": 0, "bms_type": 10,
	}
	got := a.State.Get().BmsReading
	if len(got) != len(want) {
		t.Fatalf("BmsReading = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("BmsReading[%s] = %v, want %v", k, got[k], v)
		}
	}

	sum := a.sourcesSummary()
	if sum == nil || len(sum.Entries) == 0 || sum.Entries[0].Kind != "primary" {
		t.Fatalf("primary entry missing: %+v", sum)
	}
	e := sum.Entries[0]
	if e.Bms["bms_soc_pct"] != 47 || e.Bms["bms_type"] != 10 {
		t.Fatalf("heartbeat bms block = %v", e.Bms)
	}
	// A COPY: a later sample must never rewrite a heartbeat already assembled.
	e.Bms["bms_soc_pct"] = 99
	if a.State.Get().BmsReading["bms_soc_pct"] != 47 {
		t.Fatal("the heartbeat shares its map with the state snapshot")
	}
}

func TestBmsChannelsAreNeverMeasurementChannels(t *testing.T) {
	a := newGateTestAgent(t)
	now := time.Now().UTC()
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(coupledSample, now.Format(time.RFC3339))))

	// The primary's displayed reading is the frozen five-channel set - a bms_*
	// key there would mean the v1 contract had quietly grown a channel.
	for k := range a.State.Get().LastReading {
		if len(k) > 4 && k[:4] == "bms_" {
			t.Fatalf("bms channel %q leaked into the measurement reading", k)
		}
	}
	// And a sample that carries ONLY bms_* channels is not a measurement at
	// all: it must be skipped exactly like an empty one (nothing buffered).
	b := newGateTestAgent(t)
	b.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(`{"ts":%q,"bms_soc_pct":47}`, now.Format(time.RFC3339))))
	if got := b.buf.Pending(); got != 0 {
		t.Fatalf("buffer pending = %d, want 0 - bms_* alone is not a measurement", got)
	}
	if b.State.Get().BmsReading != nil {
		t.Fatal("a skipped sample must not commit a BMS reading either")
	}
}

func TestBmsBlockStopsClaimingWhenTheCouplingGoesAway(t *testing.T) {
	a := newGateTestAgent(t)
	t0 := time.Now().UTC().Add(-time.Minute)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(coupledSample, t0.Format(time.RFC3339))))
	if a.State.Get().BmsReading == nil {
		t.Fatal("precondition: the coupled sample must land")
	}
	// The CAN link dropped: Layer 1 publishes the same plant WITHOUT bms_*.
	// No hold-last here - a limit nobody is granting any more must not be shown.
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(fmt.Sprintf(uncoupledSample, t0.Add(5*time.Second).Format(time.RFC3339))))
	if got := a.State.Get().BmsReading; got != nil {
		t.Fatalf("BmsReading = %v after the coupling went away, want nil", got)
	}
}

func TestBmsChannelsDropsJunkAndBoundsTheSet(t *testing.T) {
	// A malformed value is DROPPED, never coerced; a non-bms key is ignored;
	// the bare prefix is not a channel name; the set is bounded.
	got := bmsChannels([]byte(`{"soc_pct":47,"bms_":1,"bms_soc_pct":47,"bms_text":"x","bms_null":null}`))
	if len(got) != 1 || got["bms_soc_pct"] != 47 {
		t.Fatalf("bmsChannels = %v, want only bms_soc_pct", got)
	}
	if bmsChannels([]byte(`not json`)) != nil {
		t.Fatal("a malformed payload must yield nothing")
	}
	payload := `{`
	for i := 0; i < maxBmsChannels+10; i++ {
		if i > 0 {
			payload += ","
		}
		payload += fmt.Sprintf(`"bms_c%d":%d`, i, i)
	}
	payload += `}`
	capped := bmsChannels([]byte(payload))
	if n := len(capped); n != maxBmsChannels {
		t.Fatalf("bounded set = %d channels, want %d", n, maxBmsChannels)
	}
	// The cap is DETERMINISTIC (sorted keys): the same channels survive every
	// sample, so a misbehaving flow cannot look like a flickering BMS.
	if !reflect.DeepEqual(capped, bmsChannels([]byte(payload))) {
		t.Fatal("the cap dropped different channels on a second pass")
	}
}
