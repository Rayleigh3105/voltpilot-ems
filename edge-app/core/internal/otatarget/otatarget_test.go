package otatarget

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func envelopeJSON(t *testing.T, mutate func(map[string]any)) []byte {
	t.Helper()
	env := map[string]any{
		"schema_version": SchemaVersion,
		"type":           EnvelopeType,
		"tenant_id":      "00000000-0000-0000-0000-000000000001",
		"site_id":        "00000000-0000-0000-0000-000000000002",
		"device_id":      "00000000-0000-0000-0000-000000000003",
		"release":        "edge-2026.08.0",
		"release_seq":    12,
		"manifest_b64":   base64.StdEncoding.EncodeToString([]byte(`{"release":"edge-2026.08.0"}`)),
		"signature_b64":  base64.StdEncoding.EncodeToString([]byte(`{"alg":"ed25519"}`)),
	}
	if mutate != nil {
		mutate(env)
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestManifestBytesSurviveVerbatim is THE property this package exists for: the
// signature goes over the exact bytes, so whatever went in must come out
// unchanged - a re-serialization anywhere on the way breaks the chain silently.
func TestManifestBytesSurviveVerbatim(t *testing.T) {
	// Deliberately "untidy" bytes: key order, whitespace and a trailing newline
	// that any re-serialization would normalize away.
	manifest := []byte("{\n  \"z\": 1,\n  \"a\":   2\n}\n")
	raw := envelopeJSON(t, func(m map[string]any) {
		m["manifest_b64"] = base64.StdEncoding.EncodeToString(manifest)
	})
	env, err := ParseEnvelope(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(env.Manifest) != string(manifest) {
		t.Fatalf("Manifest-Bytes wurden veraendert:\n got %q\nwant %q", env.Manifest, manifest)
	}
}

func TestEnvelopeRejections(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"fremde schema_version", func(m map[string]any) { m["schema_version"] = "2.0" }, "schema_version"},
		{"falscher Typ", func(m map[string]any) { m["type"] = "irgendwas" }, "Typ"},
		{"keine UUID", func(m map[string]any) { m["device_id"] = "nicht-uuid" }, "device_id"},
		{"Release ohne Schema", func(m map[string]any) { m["release"] = "3bf8c038a1b2" }, "release"},
		{"Sequenz 0", func(m map[string]any) { m["release_seq"] = 0 }, "release_seq"},
		{"Signatur fehlt", func(m map[string]any) { delete(m, "signature_b64") }, "gehoeren zusammen"},
		{"Manifest fehlt", func(m map[string]any) { delete(m, "manifest_b64") }, "gehoeren zusammen"},
		{"kaputtes Base64", func(m map[string]any) { m["manifest_b64"] = "!!!nicht base64!!!" }, "Base64"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseEnvelope(envelopeJSON(t, c.mutate))
			if err == nil {
				t.Fatal("wurde angenommen")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("Grund nennt %q nicht: %v", c.want, err)
			}
		})
	}
	if _, err := ParseEnvelope(nil); err == nil {
		t.Error("eine leere Nutzlast ist keine Zuweisung (sie NIMMT eine zurueck)")
	}
	if _, err := ParseEnvelope([]byte("kein json")); err == nil {
		t.Error("Nicht-JSON muss abgelehnt werden")
	}
	big := make([]byte, MaxEnvelopeBytes+1)
	if _, err := ParseEnvelope(big); err == nil || !strings.Contains(err.Error(), "zu gross") {
		t.Errorf("die Groessengrenze muss greifen: %v", err)
	}
}

func TestStoreRoundTripIsByteExactAndClearable(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if _, err := s.Load(); !os.IsNotExist(err) {
		t.Fatalf("ohne Zuweisung muss Load 'nicht vorhanden' melden: %v", err)
	}
	// Clear ohne Zuweisung ist ein No-op, kein Fehler (retained-clear kann
	// mehrfach ankommen).
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}

	raw := envelopeJSON(t, nil)
	if err := s.Save(raw); err != nil {
		t.Fatal(err)
	}
	back, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != string(raw) {
		t.Fatal("die abgelegten Bytes sind nicht die empfangenen")
	}
	// Und kein temporaeres Bruchstueck bleibt liegen (tmp + rename).
	if _, err := os.Stat(s.Path() + ".tmp"); !os.IsNotExist(err) {
		t.Error("die tmp-Datei muss durch das Rename verschwunden sein")
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); !os.IsNotExist(err) {
		t.Fatal("nach Clear darf nichts mehr da sein")
	}
}
