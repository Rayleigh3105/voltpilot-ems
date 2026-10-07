package otaapply

// Die GETEILTEN Vektoren des Release-Manifests
// (docs/contracts/ota-release-manifest-vectors.json), hier auf dem Weg des
// Sidecars: echte Kette ueber [VerifyManifest] mit dem Trust-Set auf der
// Platte, dann [Decide]. Jeder compose-Fall muss die Sperre liefern, die die
// Vektoren nennen - und ein ok-Fall wird angewandt.

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

type manifestVector struct {
	Name     string            `json:"name"`
	Backend  string            `json:"backend"`
	Signatur string            `json:"signatur"`
	Erwartet otaverify.Outcome `json:"erwartet"`
	Sperre   string            `json:"sperre"`
	Manifest json.RawMessage   `json:"manifest"`
}

func TestManifestVectorsOnTheSidecarPath(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts",
		"ota-release-manifest-vectors.json"))
	if err != nil {
		t.Fatalf("Vektoren: %v", err)
	}
	var doc struct {
		Faelle []manifestVector `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	ran := 0
	for _, tc := range doc.Faelle {
		// Der Sidecar ist das compose-Backend; die light-Faelle gehoeren dem
		// kuenftigen Edge-Light-Pruefprogramm.
		if tc.Backend != BackendCompose {
			continue
		}
		ran++
		t.Run(tc.Name, func(t *testing.T) {
			dataDir, roots, rel := sidecarChain(t)
			doc := []byte(tc.Manifest)
			sig := signRelease(t, rel, doc)
			if tc.Signatur == "manipuliert" {
				doc = append(append([]byte{}, doc...), ' ')
			}
			v := VerifyManifest(dataDir, roots, doc, sig, "edge-2026.07.2-665d59b8", nil, testNow)
			if v.Outcome != tc.Erwartet {
				t.Fatalf("Urteil %s, erwartet %s: %s", v.Outcome, tc.Erwartet, v.Reason)
			}

			in := baseInput()
			in.Verdict = v
			d := Decide(in)
			switch tc.Erwartet {
			case otaverify.OutcomeOK:
				if d.Action != ActionApply {
					t.Fatalf("ok wird angewandt, ist %v/%v: %s", d.Action, d.Blocker, d.Reason)
				}
			case otaverify.OutcomeDeferred:
				if d.State != StateDeferred || d.Blocker != tc.Sperre {
					t.Fatalf("deferred mit Sperre %q, ist %v/%q: %s", tc.Sperre, d.State, d.Blocker, d.Reason)
				}
			case otaverify.OutcomeRejected:
				// Eine kaputte Kette oder Form bleibt ein Vorfall.
				if d.State != StateFailed || d.Blocker != BlockerChain {
					t.Fatalf("rejected = failed/kette, ist %v/%q", d.State, d.Blocker)
				}
			}
		})
	}
	if ran == 0 {
		t.Fatal("kein compose-Fall in den Vektoren")
	}
}

// sidecarChain legt Wurzel und root-signiertes Trust-Set so ab, wie sie auf
// der Box liegen, und gibt den Release-Schluessel zurueck.
func sidecarChain(t *testing.T) (string, *otaverify.KeySet, ed25519.PrivateKey) {
	t.Helper()
	dataDir := t.TempDir()
	rootPub, rootPriv, _ := ed25519.GenerateKey(nil)
	relPub, relPriv, _ := ed25519.GenerateKey(nil)
	roots := &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: "root-2026-a", Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(rootPub)}}}
	ts, _ := json.MarshalIndent(otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: "rel-2026-a", Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(relPub)}}}, "", "  ")
	dir := Dir(dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, FileTrustSet), ts, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, FileTrustSet+SigSuffix),
		signWith(t, rootPriv, "root-2026-a", otaverify.DomainTrustSet, ts), 0o644); err != nil {
		t.Fatal(err)
	}
	return dataDir, roots, relPriv
}

func signRelease(t *testing.T, rel ed25519.PrivateKey, doc []byte) []byte {
	return signWith(t, rel, "rel-2026-a", otaverify.DomainRelease, doc)
}

func signWith(t *testing.T, key ed25519.PrivateKey, keyID, domain string, doc []byte) []byte {
	t.Helper()
	in, err := otaverify.SigningInput(domain, doc)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(otaverify.Signature{SchemaVersion: otaverify.SignatureSchemaVersion,
		Alg: otaverify.AlgEd25519, KeyID: keyID, Domain: domain,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, in))})
	return raw
}
