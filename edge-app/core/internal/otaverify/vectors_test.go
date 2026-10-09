package otaverify

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Die GETEILTEN Vektoren des Release-Manifests. Java liest dieselbe Datei
// (services/api ReleaseManifestVectorsTest); wer die Regel hier aendert,
// aendert beide Seiten und die Datei zusammen.

// manifestVector ist ein Fall aus docs/contracts/ota-release-manifest-vectors.json.
// otaapply liest dieselbe Datei fuer die Sperre des Sidecars.
type manifestVector struct {
	Name      string          `json:"name"`
	Backend   string          `json:"backend"`
	Signatur  string          `json:"signatur"`
	Erwartet  Outcome         `json:"erwartet"`
	Sperre    string          `json:"sperre"`
	Erzeugbar bool            `json:"erzeugbar"`
	Warum     string          `json:"warum"`
	Manifest  json.RawMessage `json:"manifest"`
}

func loadManifestVectors(t *testing.T) []manifestVector {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "docs", "contracts", "ota-release-manifest-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Vektoren: %v", err)
	}
	var doc struct {
		Faelle []manifestVector `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Vektoren sind kein JSON: %v", err)
	}
	if len(doc.Faelle) == 0 {
		t.Fatal("Vektoren ohne Faelle")
	}
	return doc.Faelle
}

// TestManifestVectors laeuft JEDEN Fall durch die volle Kette: die Bytes des
// Falls werden mit dem Wegwerf-Release-Schluessel signiert (bei
// signatur=manipuliert danach veraendert) und gegen das Backend des Falls
// geprueft.
func TestManifestVectors(t *testing.T) {
	seen := map[Outcome]int{}
	for _, tc := range loadManifestVectors(t) {
		t.Run(tc.Name, func(t *testing.T) {
			w := newWorld(t)
			doc := []byte(tc.Manifest)
			w.in.Manifest = doc
			w.in.ManifestSig = signDoc(t, w.rel, DomainRelease, doc)
			switch tc.Signatur {
			case "", "gueltig":
			case "manipuliert":
				w.in.Manifest = append(append([]byte{}, doc...), ' ')
			default:
				t.Fatalf("unbekannte Signatur-Angabe %q", tc.Signatur)
			}
			w.in.Backend = tc.Backend

			v := Verify(w.in)
			seen[v.Outcome]++
			if v.Outcome != tc.Erwartet {
				t.Fatalf("Urteil %s, erwartet %s (%s) - Grund: %s", v.Outcome, tc.Erwartet, tc.Warum, v.Reason)
			}
			if v.Outcome != OutcomeOK && v.Reason == "" {
				t.Fatal("ein Nicht-OK-Urteil ohne Grund ist nur ein Alarm")
			}
			// Die Sperre backend und BackendMismatch sind dieselbe Aussage.
			if want := tc.Sperre == "backend"; v.BackendMismatch != want {
				t.Fatalf("BackendMismatch=%v, die Vektoren sagen Sperre %q", v.BackendMismatch, tc.Sperre)
			}
			if tc.Erwartet == OutcomeDeferred && tc.Sperre == "" {
				t.Fatal("ein deferred-Fall muss seine Sperre nennen")
			}

			// Erzeugbar = was vp-ota manifest herausgeben darf.
			_, err := ParseManifestStrict(doc)
			if tc.Erzeugbar && err != nil {
				t.Fatalf("muss erzeugbar sein: %v", err)
			}
			if !tc.Erzeugbar && err == nil {
				t.Fatal("darf nicht erzeugbar sein")
			}
		})
	}
	// Die Datei muss alle drei Urteile tragen, sonst beweist sie nichts.
	for _, o := range []Outcome{OutcomeOK, OutcomeDeferred, OutcomeRejected} {
		if seen[o] == 0 {
			t.Errorf("kein Fall mit Urteil %s", o)
		}
	}
}
