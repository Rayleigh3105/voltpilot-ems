package konfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func umgebung(m map[string]string) Umgebung {
	return func(k string) string { return m[k] }
}

func TestVorgaben(t *testing.T) {
	k, err := Lies(umgebung(nil), true)
	if err != nil {
		t.Fatal(err)
	}
	if k.Schnittstelle != "wg-wartung" || k.Tabelle != "voltpilot_wartung" || k.BoxNetz.String() != "10.10.16.0/20" ||
		k.TechnikerNetz.String() != "10.10.32.0/24" || k.Intervall != 30*time.Second || k.MaxFenster != 24*time.Hour ||
		k.MaxEntfernen != 10 || len(k.Ports) != 2 || !k.VerbindungenProtokollieren ||
		k.Zustand != "/var/lib/vp-tunnel-dienst" || k.ClientID != "voltpilot-tunnel-dienst" {
		t.Fatalf("%+v", k)
	}
}

func TestSecretAusSystemdCredential(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "client-secret"), []byte("geheim\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	k, err := Lies(umgebung(map[string]string{
		"VP_TUNNEL_API_URL": "https://portal.voltpilot.de", "VP_TUNNEL_TOKEN_URL": "https://portal.voltpilot.de/auth/t",
		"CREDENTIALS_DIRECTORY": dir, "STATE_DIRECTORY": "/var/lib/x",
	}), false)
	if err != nil {
		t.Fatal(err)
	}
	if k.ClientSecret != "geheim" || k.Zustand != "/var/lib/x" {
		t.Fatalf("%+v", k)
	}
}

func TestFehlerWerdenGesammeltGemeldet(t *testing.T) {
	_, err := Lies(umgebung(map[string]string{
		"VP_TUNNEL_BOX_NETZ":       "10.10.0.0/16",
		"VP_TUNNEL_TECHNIKER_NETZ": "10.10.32.0/24",
		"VP_TUNNEL_PORTS":          "2222,abc",
		"VP_TUNNEL_MAX_FENSTER":    "30d",
		"VP_TUNNEL_SCHNITTSTELLE":  "wg wartung",
	}), false)
	if err == nil {
		t.Fatal("erwartet Fehler")
	}
	for _, teil := range []string{"überschneiden", "VP_TUNNEL_PORTS", "VP_TUNNEL_MAX_FENSTER", "VP_TUNNEL_SCHNITTSTELLE",
		"VP_TUNNEL_API_URL", "Client-Secret"} {
		if !strings.Contains(err.Error(), teil) {
			t.Errorf("Meldung ohne %q: %v", teil, err)
		}
	}
	if _, err := Lies(umgebung(map[string]string{"VP_TUNNEL_BOX_NETZ": "10.10.16.5/20"}), true); err == nil {
		t.Error("Netz mit Host-Bits erwartet abgelehnt")
	}
}
