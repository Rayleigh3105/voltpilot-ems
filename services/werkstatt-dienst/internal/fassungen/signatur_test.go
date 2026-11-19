package fassungen_test

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
)

// kaputt veraendert verlaesslich (nicht inhaltsabhaengig) ein Byte der
// rohen Ed25519-Signatur in einer abgetrennten Signaturdatei.
func kaputt(t *testing.T, sig []byte) []byte {
	t.Helper()
	var s struct {
		SchemaVersion string `json:"schema_version"`
		Alg           string `json:"alg"`
		KeyID         string `json:"key_id"`
		Domain        string `json:"domain"`
		Signature     string `json:"signature"`
	}
	if err := json.Unmarshal(sig, &s); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(s.Signature)
	if err != nil {
		t.Fatal(err)
	}
	raw[0] ^= 0xFF
	s.Signature = base64.StdEncoding.EncodeToString(raw)
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPruefeSignatur(t *testing.T) {
	wurzel := attrappe.NeueSignierteWurzel(t)
	manifest, _ := attrappe.Manifest("edge-light-2026.11.1", 77, strings.Repeat("a", 64))
	manifestSig := wurzel.SigniereManifest(t, manifest)
	ablage := &fassungen.Ablage{Wurzel: wurzel.Wurzel}

	signiertVon, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, manifest, manifestSig)
	if err != nil || signiertVon != "rel-2026-a" {
		t.Fatalf("gueltige Kette: %q %v", signiertVon, err)
	}

	for name, f := range map[string]func() error{
		"verfaelschte Manifest-Signatur": func() error {
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, manifest, kaputt(t, manifestSig))
			return err
		},
		"verfaelschtes Manifest": func() error {
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, append(append([]byte{}, manifest...), ' '), manifestSig)
			return err
		},
		"verfaelschte Vertrauens-Set-Signatur": func() error {
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, kaputt(t, wurzel.TrustSetSig), manifest, manifestSig)
			return err
		},
		"verfaelschtes Vertrauens-Set": func() error {
			_, err := ablage.PruefeSignatur(append(append([]byte{}, wurzel.TrustSet...), ' '), wurzel.TrustSetSig, manifest, manifestSig)
			return err
		},
		"fehlende Manifest-Signatur": func() error {
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, manifest, nil)
			return err
		},
		"fehlendes Manifest": func() error {
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, nil, manifestSig)
			return err
		},
		"fehlendes Vertrauens-Set": func() error {
			_, err := ablage.PruefeSignatur(nil, nil, manifest, manifestSig)
			return err
		},
		"mit fremdem Release-Schluessel signiert": func() error {
			fremd := attrappe.NeueSignierteWurzel(t)
			fremdeSig := fremd.SigniereManifest(t, manifest)
			_, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, manifest, fremdeSig)
			return err
		},
		"mit fremder Wurzel signiertes Vertrauens-Set": func() error {
			fremd := attrappe.NeueSignierteWurzel(t)
			_, err := ablage.PruefeSignatur(fremd.TrustSet, fremd.TrustSetSig, manifest, manifestSig)
			return err
		},
	} {
		if f() == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

// Die eingebackene Produktionswurzel lehnt die Attrappen-Signatur von
// [attrappe.Manifest] ab (key_id "rel-2026-a", Signatur "AAAA") - die
// Pruefung ist echt, kein Blankoscheck.
func TestPruefeSignaturGegenDieEchteWurzelLehntDieAttrappeAb(t *testing.T) {
	wurzel := attrappe.NeueSignierteWurzel(t)
	manifest, fakeSig := attrappe.Manifest("edge-light-2026.11.1", 77, strings.Repeat("a", 64))
	ablage := &fassungen.Ablage{} // kein Wurzel-Feld: nimmt GebackeneWurzel()
	if _, err := ablage.PruefeSignatur(wurzel.TrustSet, wurzel.TrustSetSig, manifest, fakeSig); err == nil {
		t.Fatal("Attrappen-Signatur gegen die echte Wurzel angenommen")
	}
}

func TestGebackeneWurzel(t *testing.T) {
	ks, err := fassungen.GebackeneWurzel()
	if err != nil {
		t.Fatal(err)
	}
	if len(ks.Keys) == 0 {
		t.Fatal("keine Schluessel")
	}
}

// Die hier eingebackene Produktionswurzel muss byte-gleich mit der des Cores
// bleiben (edge-app/core/internal/otaverify/rootkeys.json): eine Rotation,
// die hier vergessen wird, soll diesen Test rot machen statt die Werkstatt
// leise mit der alten Wurzel weiterlaufen zu lassen.
func TestRootkeysBleibenSynchronMitDemCore(t *testing.T) {
	hier, err := os.ReadFile("rootkeys.json")
	if err != nil {
		t.Fatal(err)
	}
	dort, err := os.ReadFile("../../../../edge-app/core/internal/otaverify/rootkeys.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(hier) != string(dort) {
		t.Fatal("services/werkstatt-dienst/internal/fassungen/rootkeys.json weicht von edge-app/core/internal/otaverify/rootkeys.json ab - nach einer Rotation beide Kopien aktualisieren")
	}
}
