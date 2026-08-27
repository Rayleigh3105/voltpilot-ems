package agent

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

// The per-component binding (Geraeteseite Stufe 3c) selects the DEVICE a point
// is read over, and the resolution happens in Node-RED. The core's whole job is
// to hand the document over UNCHANGED - a re-serialized plan could reorder or
// drop the binding, and Layer 1 would then read a component's register over the
// primary inverter without anyone noticing.
func TestTheComponentBindingReachesLayerOneByteForByte(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	id := measurements.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	a.setMeasurementIdentity(id.TenantID, id.SiteID, id.DeviceID)

	var mu sync.Mutex
	var seen [][]byte
	if err := a.Bus.Subscribe(measurements.LocalConfigTopic, 91, func(_ string, payload []byte) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, append([]byte(nil), payload...))
	}); err != nil {
		t.Fatal(err)
	}

	payload := []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s",`+
		`"revision":11,"catalog_version":"2026.08.25.1","selections":[`+
		`{"point_key":"sunspec.model_103.w","cadence_s":30,"entity_id":"00000000-0000-0000-0000-0000000000a1"},`+
		`{"point_key":"goe.api_v2.nrg","cadence_s":30}]}`, id.TenantID, id.SiteID, id.DeviceID))
	if !a.onMeasurementConfig(payload) {
		t.Fatal("per-component plan was not adopted")
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		got := len(seen)
		mu.Unlock()
		if got > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("published %d local configs, want exactly 1", len(seen))
	}
	if !bytes.Equal(seen[0], payload) {
		t.Fatalf("local config is not byte-identical:\n got %s\nwant %s", seen[0], payload)
	}
}

// A binding the cloud sends in a shape the contract does not allow is a broken
// document, not a missing component: nothing is published and nothing adopted.
func TestAMalformedBindingNeverReachesLayerOne(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	id := measurements.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	a.setMeasurementIdentity(id.TenantID, id.SiteID, id.DeviceID)

	var mu sync.Mutex
	published := 0
	if err := a.Bus.Subscribe(measurements.LocalConfigTopic, 92, func(string, []byte) {
		mu.Lock()
		published++
		mu.Unlock()
	}); err != nil {
		t.Fatal(err)
	}

	payload := []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s",`+
		`"revision":11,"catalog_version":"2026.08.25.1","selections":[`+
		`{"point_key":"sunspec.model_103.w","cadence_s":30,"entity_id":"../../etc"}]}`,
		id.TenantID, id.SiteID, id.DeviceID))
	if a.onMeasurementConfig(payload) {
		t.Fatal("a malformed entity_id was adopted")
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if published != 0 {
		t.Fatalf("published %d local configs for a refused document", published)
	}
	if a.measurementRevision != 0 {
		t.Fatalf("refused document advanced the applied revision to %d", a.measurementRevision)
	}
}
