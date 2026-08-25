package measurements

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var testID = Identity{"00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"}

func config(rev int64, tenant string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":%d,"catalog_version":"2026.08.25.1","selections":[{"point_key":"goe.api_v2.nrg","cadence_s":30}]}`, tenant, testID.SiteID, testID.DeviceID, rev))
}
func batch(at time.Time) []byte {
	return []byte(fmt.Sprintf(`{"catalog_version":"2026.08.25.1","observed_at":"%s","samples":[{"point_key":"goe.api_v2.nrg","raw":17,"decoded":17,"quality":"good"}]}`, at.Format(time.RFC3339Nano)))
}

func multiBatch(at time.Time, count int) []byte {
	samples := make([]map[string]any, count)
	for i := range samples {
		samples[i] = map[string]any{"point_key": fmt.Sprintf("test.p%d", i), "raw": i, "quality": "good"}
	}
	raw, _ := json.Marshal(map[string]any{"catalog_version": "2026.08.25.1",
		"observed_at": at, "samples": samples})
	return raw
}

func TestConfigIdentityAndRevisionAreStrict(t *testing.T) {
	if _, e := ParseConfig(config(2, testID.TenantID), testID, 1); e != nil {
		t.Fatal(e)
	}
	if _, e := ParseConfig(config(1, testID.TenantID), testID, 1); e == nil {
		t.Fatal("stale accepted")
	}
	if _, e := ParseConfig(config(2, "10000000-0000-0000-0000-000000000001"), testID, 1); e == nil {
		t.Fatal("foreign accepted")
	}
}

func TestCustomConfigCarriesExecutableDefinitionOnlyForCustomKeys(t *testing.T) {
	raw := []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[{"point_key":"custom.abc","cadence_s":30,"definition":{"label":"Test","sourceKind":"modbus_input","address":42,"selector":"input:0x002a","valueType":"uint16","widthBits":16,"signed":false,"endian":"big","scale":1,"unit":"V","cadenceS":30,"retentionClass":"unclassified","readOnly":true,"requestCostMs":400}}]}`,
		testID.TenantID, testID.SiteID, testID.DeviceID))
	c, err := ParseConfig(raw, testID, 1)
	if err != nil || len(c.Selections[0].Definition) == 0 {
		t.Fatalf("custom definition lost: %#v %v", c, err)
	}
	if _, err = ParseConfig([]byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[{"point_key":"goe.api_v2.alw","cadence_s":30,"definition":{}}]}`,
		testID.TenantID, testID.SiteID, testID.DeviceID)), testID, 1); err == nil {
		t.Fatal("catalog point accepted custom definition")
	}
}
func TestOutboxReplaysInOrderAndReportsBoundedDrop(t *testing.T) {
	dir := t.TempDir()
	o, e := OpenOutbox(dir, 2)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if _, e = o.Append(batch(now.Add(time.Duration(i)*time.Second)), testID); e != nil {
			t.Fatal(e)
		}
	}
	if o.Pending() != 2 {
		t.Fatalf("pending %d", o.Pending())
	}
	first, _ := o.Next()
	var p map[string]any
	if json.Unmarshal(first.Raw, &p) != nil {
		t.Fatal("json")
	}
	if p["sequence"].(float64) != 1 || p["gap"] != true || p["dropped_samples"].(float64) != 1 {
		t.Fatalf("unexpected %#v", p)
	}
	if e = o.Ack(first.Sequence); e != nil {
		t.Fatal(e)
	}
	second, _ := o.Next()
	if second.Sequence != 2 {
		t.Fatal("out of order")
	}
	var clean map[string]any
	if json.Unmarshal(second.Raw, &clean) != nil || clean["gap"] != false || clean["dropped_samples"].(float64) != 0 {
		t.Fatalf("drop episode repeated %#v", clean)
	}
	// Reopening is the reconnect/restart path: replay remains ordered and the
	// next sequence never rewinds onto an existing envelope.
	reopened, e := OpenOutbox(dir, 2)
	if e != nil {
		t.Fatal(e)
	}
	third, e := reopened.Append(batch(now.Add(4*time.Second)), testID)
	if e != nil || third.Sequence != 3 {
		t.Fatalf("sequence did not recover: %#v %v", third, e)
	}
}
func TestNoRawMeansNoSample(t *testing.T) {
	o, _ := OpenOutbox(t.TempDir(), 2)
	bad := []byte(`{"catalog_version":"2026.08.25.1","observed_at":"2026-08-25T12:00:00Z","samples":[{"point_key":"x","decoded":1,"quality":"good"}]}`)
	if _, e := o.Append(bad, testID); e == nil {
		t.Fatal("invented raw accepted")
	}
}

func TestBackpressureNeverEvictsInFlightOrClearsLaterDrops(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 2; i++ {
		if _, err = o.Append(batch(now.Add(time.Duration(i)*time.Second)), testID); err != nil {
			t.Fatal(err)
		}
	}
	first, ok := o.Next()
	if !ok || first.Sequence != 0 {
		t.Fatalf("first in-flight envelope = %#v", first)
	}
	// While sequence 0 waits for PUBACK, bounded eviction must skip it and
	// remove sequence 1. Acking 0 did not report that later loss.
	if _, err = o.Append(batch(now.Add(2*time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	if err = o.Ack(first.Sequence); err != nil {
		t.Fatal(err)
	}
	second, ok := o.Next()
	var payload map[string]any
	badSecond := !ok || second.Sequence != 2 || json.Unmarshal(second.Raw, &payload) != nil ||
		payload["gap"] != true || payload["dropped_samples"].(float64) != 1
	if badSecond {
		t.Fatalf("later loss was hidden: %#v %#v", second, payload)
	}
	// Another eviction while sequence 2 carries the first loss leaves the new
	// loss pending after its PUBACK.
	_, _ = o.Append(batch(now.Add(3*time.Second)), testID)
	_, _ = o.Append(batch(now.Add(4*time.Second)), testID)
	if err = o.Ack(second.Sequence); err != nil {
		t.Fatal(err)
	}
	third, ok := o.Next()
	payload = nil
	badThird := !ok || third.Sequence != 4 || json.Unmarshal(third.Raw, &payload) != nil ||
		payload["dropped_samples"].(float64) != 1
	if badThird {
		t.Fatalf("concurrent drop was cleared: %#v %#v", third, payload)
	}
}

func TestEvictionCountsSamplesNotEnvelopeFiles(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err = o.Append(multiBatch(now, 7), testID); err != nil {
		t.Fatal(err)
	}
	if _, err = o.Append(batch(now.Add(time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	if _, err = o.Append(batch(now.Add(2*time.Second)), testID); err != nil {
		t.Fatal(err)
	}
	next, ok := o.Next()
	var payload struct {
		Dropped int64 `json:"dropped_samples"`
	}
	if !ok || json.Unmarshal(next.Raw, &payload) != nil || payload.Dropped != 7 {
		t.Fatalf("lost samples were not counted exactly: %#v %#v", next, payload)
	}
}

func TestPreparedEvictionRecoversBothCrashSidesExactly(t *testing.T) {
	for _, tc := range []struct {
		name       string
		fileExists bool
		want       int64
	}{
		{"before-remove", true, 0}, {"after-remove", false, 9},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			name := "00000000000000000000.json"
			if tc.fileExists {
				if err := os.WriteFile(filepath.Join(dir, name), batch(time.Now().UTC()), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			state, _ := json.Marshal(diskState{NextSequence: 1, PendingDropFile: name, PendingDropSamples: 9})
			if err := os.WriteFile(filepath.Join(dir, "state.json"), state, 0o644); err != nil {
				t.Fatal(err)
			}
			o, err := OpenOutbox(dir, 2)
			if err != nil {
				t.Fatal(err)
			}
			if o.state.Dropped != tc.want || o.state.PendingDropFile != "" {
				t.Fatalf("recovery state = %#v", o.state)
			}
		})
	}
}
