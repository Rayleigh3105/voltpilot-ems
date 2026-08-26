package agent

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

func TestMeasurementConfigCallbackReportsOnlyDurableAdoptionAndRecognizesRestartReplay(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	id := measurements.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	a.setMeasurementIdentity(id.TenantID, id.SiteID, id.DeviceID)
	payload := measurementConfigPayload(id, 7, "goe.api_v2.nrg")

	if !a.onMeasurementConfig(payload) {
		t.Fatal("valid config was not reported as durably adopted")
	}
	path := filepath.Join(cfg.DataDir, "measurement-config.json")
	stored, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(stored, payload) {
		t.Fatalf("stored measurement config = %q, err=%v", stored, err)
	}
	if a.measurementRevision != 7 || !bytes.Equal(a.measurementConfig, payload) {
		t.Fatalf("in-memory adoption revision=%d payload=%q", a.measurementRevision, a.measurementConfig)
	}
	if !a.onMeasurementConfig(payload) {
		t.Fatal("same-process QoS1 replay of the exact durable document must be ACKable")
	}
	if a.onMeasurementConfig(measurementConfigPayload(id, 7, "goe.api_v2.eto")) {
		t.Fatal("different content at the applied revision must remain unacknowledged")
	}

	// New reloads the durable document before a cloud link can connect. The
	// retained QoS1 replay is therefore a decided duplicate, not a second apply.
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	restarted.measurementIdentity = id
	if restarted.measurementRevision != 7 || !restarted.onMeasurementConfig(payload) {
		t.Fatal("restart did not recognize the exact durable measurement config")
	}

	bad := &Agent{
		Cfg:                 config.Config{DataDir: filepath.Join(t.TempDir(), "missing")},
		measurementIdentity: id,
		Bus:                 a.Bus,
	}
	if bad.onMeasurementConfig(measurementConfigPayload(id, 8, "goe.api_v2.nrg")) {
		t.Fatal("persistence failure must not be reported as adopted or ACKable")
	}
	if bad.measurementRevision != 0 || len(bad.measurementConfig) != 0 {
		t.Fatal("failed persistence advanced the applied state")
	}
}

func TestMeasurementConfigRestartReplayStillValidatesCurrentIdentity(t *testing.T) {
	id := measurements.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	payload := measurementConfigPayload(id, 7, "goe.api_v2.nrg")
	a := &Agent{
		measurementIdentity: measurements.Identity{TenantID: id.TenantID, SiteID: id.SiteID, DeviceID: "other-device"},
		measurementRevision: 7,
		measurementConfig:   payload,
	}
	if a.onMeasurementConfig(payload) {
		t.Fatal("byte-identical config for an old identity must not be ACKed after re-enrollment")
	}
}

func measurementConfigPayload(id measurements.Identity, revision int64, point string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":%d,"catalog_version":"2026.08.25.1","selections":[{"point_key":"%s","cadence_s":30}]}`,
		id.TenantID, id.SiteID, id.DeviceID, revision, point))
}
