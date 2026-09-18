// Test bridge for MeasurementEdgeProvenanceTest. Drives the real durable
// Outbox on a temporary directory; no broker or service is started.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

func main() {
	if err := run(); err != nil {
		panic(err)
	}
}

func run() error {
	dir, err := os.MkdirTemp("", "vp-provenance-replay-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	var replay []json.RawMessage
	// Already serialized before the update: Next must keep these byte-identical.
	for i, fixture := range os.Args[2:] {
		raw, err := os.ReadFile(fixture)
		if err != nil {
			return err
		}
		legacyDir := filepath.Join(dir, fmt.Sprintf("legacy-%d", i))
		if err := os.Mkdir(legacyDir, 0700); err != nil {
			return err
		}
		var envelope struct {
			Sequence int64 `json:"sequence"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(legacyDir, fmt.Sprintf("%020d.json", envelope.Sequence)), raw, 0600); err != nil {
			return err
		}
		legacy, err := measurements.OpenOutbox(legacyDir, 10)
		if err != nil {
			return err
		}
		first, ok := legacy.Next()
		if !ok {
			return fmt.Errorf("legacy replay missing: %s", fixture)
		}
		replay = append(replay, first.Raw)
	}
	box, err := measurements.OpenOutbox(dir, 10)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var batches []json.RawMessage
	if err := json.Unmarshal(raw, &batches); err != nil {
		return err
	}
	id := measurements.Identity{TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID: "00000000-0000-0000-0000-000000000002", DeviceID: "00000000-0000-0000-0000-000000000003"}
	for _, batch := range batches {
		if _, err := box.Append(batch, id); err != nil {
			return err
		}
	}
	box, err = measurements.OpenOutbox(dir, 10)
	if err != nil {
		return err
	}
	for {
		envelope, ok := box.Next()
		if !ok {
			break
		}
		replay = append(replay, envelope.Raw)
		if err := box.Ack(envelope.Sequence); err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(replay)
}
