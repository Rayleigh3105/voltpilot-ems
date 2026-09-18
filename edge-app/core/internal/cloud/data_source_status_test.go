package cloud

import (
	"encoding/json"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"testing"
)

func TestSourceStatusIsAdditiveToLegacyHeartbeat(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "unchanged-version")
	rows := []datasourcestatus.Status{{ID: "DQ-4", Health: "ok", SamplesPerMin: 3}}
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, StatusExtension{DataSources: rows}); err != nil {
		t.Fatal(err)
	}
	wire := sink.last(t)
	raw, _ := json.Marshal(wire)
	// The old reader's fields retain their shape and version; unknown extensions are ignored.
	var legacy struct {
		SchemaVersion string `json:"schema_version"`
		TenantID      string `json:"tenant_id"`
		Online        bool   `json:"online"`
		Version       string `json:"version"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.SchemaVersion != "1.0" || legacy.TenantID != testTenant || !legacy.Online || legacy.Version != "unchanged-version" {
		t.Fatalf("legacy: %+v", legacy)
	}
	if _, ok := wire["data_sources"]; !ok {
		t.Fatal("source block missing")
	}
}
