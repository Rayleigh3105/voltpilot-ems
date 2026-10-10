package measurements

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOutboxProvenanceChooses21OnlyWhenPresent(t *testing.T) {
	for _, tc := range []struct{ name, revision, entity, version string }{
		{"legacy", "", "", "2.0"},
		{"revision zero", "0", "", "2.1"},
		{"revision only", "7", "", "2.1"},
		{"entity only", "", `"00000000-0000-0000-0000-0000000000a1"`, "2.1"},
		{"both", "7", `"00000000-0000-0000-0000-0000000000a1"`, "2.1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var local map[string]json.RawMessage
			if err := json.Unmarshal(batch(time.Now().UTC()), &local); err != nil {
				t.Fatal(err)
			}
			if tc.revision != "" {
				local["applied_revision"] = json.RawMessage(tc.revision)
			}
			if tc.entity != "" {
				local["samples"] = json.RawMessage(`[{"point_key":"goe.api_v2.nrg","raw":"9007199254740993","quality":"good","entity_id":` + tc.entity + `}]`)
			}
			raw, _ := json.Marshal(local)
			dir := t.TempDir()
			box, err := OpenOutbox(dir, 10)
			if err != nil {
				t.Fatal(err)
			}
			written, err := box.Append(raw, testID)
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				SchemaVersion   string          `json:"schema_version"`
				AppliedRevision json.RawMessage `json:"applied_revision"`
				Samples         []Sample        `json:"samples"`
			}
			if err := json.Unmarshal(written.Raw, &wire); err != nil {
				t.Fatal(err)
			}
			if wire.SchemaVersion != tc.version || string(wire.AppliedRevision) != tc.revision ||
				string(wire.Samples[0].EntityID) != tc.entity {
				t.Fatalf("provenance changed: %s", written.Raw)
			}
			reopened, err := OpenOutbox(dir, 10)
			if err != nil {
				t.Fatal(err)
			}
			replayed, ok := reopened.Next()
			if !ok || !bytes.Equal(written.Raw, replayed.Raw) {
				t.Fatalf("replay changed: %s", replayed.Raw)
			}
		})
	}
}

func TestOutboxReplaysPreUpdate20And21WithoutInventingProvenance(t *testing.T) {
	for _, fixture := range []string{"mqtt-measurement-samples.valid.json", "mqtt-measurement-samples-2.1.valid.ohne-herkunftsfelder.json"} {
		t.Run(fixture, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("../../../../docs/contracts/v2/examples", fixture))
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			// Put an already serialized pre-update envelope on disk, without Append.
			if err := os.WriteFile(filepath.Join(dir, "00000000000000000042.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			box, err := OpenOutbox(dir, 10)
			if err != nil {
				t.Fatal(err)
			}
			replayed, ok := box.Next()
			if !ok || !bytes.Equal(raw, replayed.Raw) {
				t.Fatalf("old envelope changed: %s", replayed.Raw)
			}
			if bytes.Contains(replayed.Raw, []byte("entity_id")) || bytes.Contains(replayed.Raw, []byte("applied_revision")) {
				t.Fatal("invented provenance")
			}
		})
	}
}

func TestOutboxRejectsMalformedProvenanceAndKeepsDuplicatePointRule(t *testing.T) {
	for _, field := range []string{"applied_revision", "entity_id"} {
		values := []string{"null", `""`, `"7"`, "-1", "1.5", "{}", "[]", "true"}
		if field == "entity_id" {
			values = append(values, `"K-5"`, "7")
		}
		for _, value := range values {
			t.Run(field+"="+value, func(t *testing.T) {
				raw := batch(time.Now().UTC())
				needle := `"catalog_version":`
				if field == "entity_id" {
					needle = `"point_key":`
				}
				raw = bytes.Replace(raw, []byte(needle), []byte(`"`+field+`":`+value+`,`+needle), 1)
				if _, err := parseBatch(raw); err == nil {
					t.Fatalf("accepted %s", raw)
				}
			})
		}
	}
	// AP-07 IP-18b: two DIFFERENT components at one point are a shared point
	// (one sample each); the same component twice stays a duplicate.
	shared := []byte(`{"catalog_version":"2026.08.25.1","observed_at":"2026-08-25T12:00:00Z","applied_revision":7,"samples":[{"point_key":"x","raw":1,"quality":"good","entity_id":"00000000-0000-0000-0000-0000000000a1"},{"point_key":"x","raw":1,"quality":"good","entity_id":"00000000-0000-0000-0000-0000000000b2"}]}`)
	if _, err := parseBatch(shared); err != nil {
		t.Fatalf("shared point refused: %v", err)
	}
	duplicate := bytes.Replace(shared, []byte("0000000000b2"), []byte("0000000000a1"), 1)
	if _, err := parseBatch(duplicate); err == nil {
		t.Fatal("duplicate point accepted")
	}
}
