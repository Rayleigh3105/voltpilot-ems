package fassungen_test

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
)

func TestPruefeManifest(t *testing.T) {
	sha := strings.Repeat("a", 64)
	m, sig := attrappe.Manifest("edge-light-2026.11.1", 77, sha)
	st, err := fassungen.PruefeManifest(m, sig, "edge-light-2026.11.1", "mipsle", sha)
	if err != nil || st.ReleaseSeq != 77 || st.StateSchema != 1 || st.SigniertVon != "rel-2026-a" {
		t.Fatalf("%+v %v", st, err)
	}
	for name, f := range map[string]func() error{
		"andere Fassung": func() error {
			_, err := fassungen.PruefeManifest(m, sig, "edge-light-2026.11.2", "mipsle", sha)
			return err
		},
		"anderes Programm": func() error {
			_, err := fassungen.PruefeManifest(m, sig, "edge-light-2026.11.1", "mipsle", strings.Repeat("b", 64))
			return err
		},
		"andere Bauart": func() error {
			_, err := fassungen.PruefeManifest(m, sig, "edge-light-2026.11.1", "arm64", sha)
			return err
		},
		"fremde Signatur": func() error {
			_, err := fassungen.PruefeManifest(m, []byte(strings.Replace(string(sig), "rel-2026-a", "rel-2099-x", 1)),
				"edge-light-2026.11.1", "mipsle", sha)
			return err
		},
		"Signatur fuer ein Trust-Set": func() error {
			_, err := fassungen.PruefeManifest(m, []byte(strings.Replace(string(sig), `"release"`, `"trust-set"`, 1)),
				"edge-light-2026.11.1", "mipsle", sha)
			return err
		},
		"Docker-Manifest": func() error {
			_, err := fassungen.PruefeManifest([]byte(strings.Replace(string(m), `"light"`, `"compose"`, 1)), sig,
				"edge-light-2026.11.1", "mipsle", sha)
			return err
		},
	} {
		if f() == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

// Ein Manifest für den PFC200 nennt die Update-Linie industrie und das
// Programm für linux/arm; eines der Mango gilt für ihn nicht, und umgekehrt.
func TestPruefeManifestPFC200(t *testing.T) {
	sha := strings.Repeat("a", 64)
	_, sig := attrappe.Manifest("edge-industrie-2026.11.1", 77, sha)
	sk, wa := strings.Repeat("b", 64), strings.Repeat("c", 64)
	m := attrappe.ManifestPFC200("edge-industrie-2026.11.1", 77, sha, "industrie", sk, wa)
	st, err := fassungen.PruefeManifestFuer(m, sig, "edge-industrie-2026.11.1", "arm", sha, fassungen.BackendsPFC200...)
	if err != nil || st.ReleaseSeq != 77 {
		t.Fatalf("%+v %v", st, err)
	}
	// Skriptstand und Tunnel-Programm müssen im Manifest stehen und zur Freigabe passen.
	if st, err := fassungen.PruefeManifestPFC200(m, sig, "edge-industrie-2026.11.1", sha, sk, wa); err != nil || st.ReleaseSeq != 77 {
		t.Fatalf("%+v %v", st, err)
	}
	for name, f := range map[string]func() error{
		"anderer Skriptstand": func() error {
			_, err := fassungen.PruefeManifestPFC200(m, sig, "edge-industrie-2026.11.1", sha, strings.Repeat("d", 64), wa)
			return err
		},
		"anderes Tunnel-Programm": func() error {
			_, err := fassungen.PruefeManifestPFC200(m, sig, "edge-industrie-2026.11.1", sha, sk, strings.Repeat("d", 64))
			return err
		},
		"Manifest ohne Tunnel-Programm": func() error {
			ohne := attrappe.ManifestPFC200("edge-industrie-2026.11.1", 77, sha, "industrie", sk, "")
			_, err := fassungen.PruefeManifestPFC200(ohne, sig, "edge-industrie-2026.11.1", sha, sk, wa)
			return err
		},
		"Manifest ohne Skriptstand": func() error {
			ohne := attrappe.ManifestPFC200("edge-industrie-2026.11.1", 77, sha, "industrie", "", wa)
			_, err := fassungen.PruefeManifestPFC200(ohne, sig, "edge-industrie-2026.11.1", sha, sk, wa)
			return err
		},
	} {
		if err := f(); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
	light := attrappe.ManifestPFC200("edge-industrie-2026.11.1", 77, sha, "light", sk, wa)
	if _, err := fassungen.PruefeManifestFuer(light, sig, "edge-industrie-2026.11.1", "arm", sha, fassungen.BackendsPFC200...); err == nil {
		t.Error("ein Manifest der Linie light gilt für den PFC200")
	}
	if _, err := fassungen.PruefeManifest(m, sig, "edge-industrie-2026.11.1", "arm", sha); err == nil || !strings.Contains(err.Error(), "Edge Light") {
		t.Errorf("ein Manifest der Linie industrie gilt für die Mango: %v", err)
	}
}
