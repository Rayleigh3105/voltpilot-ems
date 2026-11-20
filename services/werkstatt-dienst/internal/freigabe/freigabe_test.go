package freigabe

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const beispiel = `{
  "schema": "vp-werkstatt-freigabe.v1",
  "kennung": "2026-11-mango-1",
  "box_art": "mango",
  "erteilt_von": "Betreiber",
  "erteilt_am": "2026-11-02T08:00:00+01:00",
  "gueltig_bis": "2026-11-30T23:59:59+01:00",
  "obergrenze": 20,
  "openwrt": {
    "fassung": "25.12.5",
    "datei": "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000001",
    "quelle": "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"
  },
  "edge_light": {
    "fassung": "edge-light-2026.11.1",
    "quelle": "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-light-2026.11.1/",
    "programm_sha256": "0000000000000000000000000000000000000000000000000000000000000002",
    "skripte_sha256": "0000000000000000000000000000000000000000000000000000000000000003"
  }
}`

func TestBeispielGilt(t *testing.T) {
	f, err := Lies([]byte(beispiel))
	if err != nil {
		t.Fatal(err)
	}
	mitte := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	if err := f.Laufend(mitte, 0); err != nil {
		t.Fatal(err)
	}
	faelle := map[string]struct {
		jetzt time.Time
		boxen int
		grund string
	}{
		"vorher":     {time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), 0, "gilt erst ab"},
		"abgelaufen": {time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), 0, "abgelaufen"},
		"voll":       {mitte, 20, "Obergrenze von 20"},
	}
	for name, c := range faelle {
		var k Keine
		if err := f.Laufend(c.jetzt, c.boxen); !errors.As(err, &k) || !strings.Contains(err.Error(), c.grund) {
			t.Errorf("%s: %v", name, err)
		}
	}
	ende := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	f.BeendetAm = &ende
	if err := f.Laufend(mitte, 0); err == nil || !strings.Contains(err.Error(), "beendet") {
		t.Fatalf("Freigabe beenden wirkt nicht: %v", err)
	}
}

func TestUngueltig(t *testing.T) {
	faelle := map[string][2]string{
		"schema":     {`"vp-werkstatt-freigabe.v1"`, `"v0"`},
		"pi":         {`"box_art": "mango"`, `"box_art": "pi"`},
		"sha":        {`…0001"`, `…xyz"`},
		"datei":      {`squashfs-sysupgrade.bin`, `squashfs-factory.bin`},
		"fassung":    {`"edge-light-2026.11.1",`, `"edge-light-gabc",`},
		"http":       {`"https://downloads`, `"http://downloads`},
		"zu lang":    {`2026-11-30T23:59:59+01:00`, `2027-11-30T23:59:59+01:00`},
		"obergrenze": {`"obergrenze": 20`, `"obergrenze": 0`},
		"feld":       {`"obergrenze": 20`, `"obergrenze": 20, "stueckzahl": 5`},
		"leer von":   {`"erteilt_von": "Betreiber"`, `"erteilt_von": " "`},
	}
	for name, ers := range faelle {
		alt := strings.ReplaceAll(ers[0], "…", "000000000000000000000000000000000000000000000000000000000000")
		neu := strings.ReplaceAll(ers[1], "…", "000000000000000000000000000000000000000000000000000000000000")
		if !strings.Contains(beispiel, alt) {
			t.Fatalf("%s: %q nicht im Beispiel", name, alt)
		}
		if _, err := Lies([]byte(strings.Replace(beispiel, alt, neu, 1))); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

func TestDatei(t *testing.T) {
	dir := t.TempDir()
	d := Datei{Pfad: filepath.Join(dir, "freigabe.json")}
	var k Keine
	if _, err := d.Aktuell(); !errors.As(err, &k) {
		t.Fatalf("ohne Datei: %v", err)
	}
	_ = os.WriteFile(d.Pfad, []byte("\n"), 0o644)
	if _, err := d.Aktuell(); !errors.As(err, &k) {
		t.Fatalf("leere Datei: %v", err)
	}
	_ = os.WriteFile(d.Pfad, []byte(beispiel), 0o644)
	if f, err := d.Aktuell(); err != nil || f.Kennung != "2026-11-mango-1" {
		t.Fatalf("%v %v", f, err)
	}
	_ = os.WriteFile(d.Pfad, []byte("{kaputt"), 0o644)
	if _, err := d.Aktuell(); err == nil || errors.As(err, &k) {
		t.Fatalf("kaputte Datei ist keine fehlende Freigabe: %v", err)
	}
}

// Die Vorlage im Runbook muss der Dienst lesen können.
func TestBeispielDateiImRepo(t *testing.T) {
	b, err := os.ReadFile("../../deploy/freigabe.beispiel.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lies(b); err != nil {
		t.Fatal(err)
	}
}

const beispielPFC200 = `{
  "schema": "vp-werkstatt-freigabe.v1",
  "kennung": "2026-11-pfc200-1",
  "box_art": "pfc200",
  "erteilt_von": "Betreiber",
  "erteilt_am": "2026-11-02T08:00:00+01:00",
  "gueltig_bis": "2026-11-30T23:59:59+01:00",
  "obergrenze": 5,
  "edge_industrie": {
    "fassung": "edge-industrie-2026.11.1",
    "quelle": "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-industrie-2026.11.1/",
    "programm_sha256": "0000000000000000000000000000000000000000000000000000000000000002",
    "skripte_sha256": "0000000000000000000000000000000000000000000000000000000000000003",
    "wartung_sha256": "0000000000000000000000000000000000000000000000000000000000000004"
  }
}`

// Die Freigabe für den PFC200 nennt die Edge-Industrie-Fassung mit drei
// Prüfsummen und weder OpenWrt noch Edge Light; die der Mango bleibt, wie sie ist.
func TestFreigabePFC200(t *testing.T) {
	f, err := Lies([]byte(beispielPFC200))
	if err != nil || f.BoxArt != PFC200 || f.EdgeIndustrie.WartungSha256 == "" {
		t.Fatalf("%+v %v", f, err)
	}
	// Geschrieben und wieder gelesen: keine leeren Blöcke der Mango.
	if strings.Contains(beispielPFC200, "openwrt") {
		t.Fatal("das Beispiel nennt OpenWrt")
	}
	for name, aendern := range map[string]func(string) string{
		"Fassung der Mango-Linie": func(s string) string {
			return strings.Replace(s, `"fassung": "edge-industrie-2026.11.1"`, `"fassung": "edge-light-2026.11.1"`, 1)
		},
		"ohne Tunnel-Programm": func(s string) string {
			return strings.Replace(s, `"wartung_sha256": "000`, `"wartung_sha256": "xyz`, 1)
		},
		"mit Edge Light": func(s string) string {
			return strings.Replace(s, `"edge_industrie": {`, `"edge_light": {"fassung": "edge-light-2026.11.1", "quelle": "https://x/", "programm_sha256": "`+strings.Repeat("0", 64)+`", "skripte_sha256": "`+strings.Repeat("0", 64)+`"}, "edge_industrie": {`, 1)
		},
		"Quelle ohne https": func(s string) string { return strings.Replace(s, `"quelle": "https://`, `"quelle": "http://`, 1) },
	} {
		if _, err := Lies([]byte(aendern(beispielPFC200))); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
	// Eine Freigabe der Mango mit einem Block für den PFC200 gilt nicht.
	mit := strings.Replace(beispiel, `"edge_light": {`, `"edge_industrie": {"fassung": "edge-industrie-2026.11.1", "quelle": "https://x/", "programm_sha256": "`+strings.Repeat("0", 64)+`", "skripte_sha256": "`+strings.Repeat("0", 64)+`", "wartung_sha256": "`+strings.Repeat("0", 64)+`"}, "edge_light": {`, 1)
	if _, err := Lies([]byte(mit)); err == nil {
		t.Error("Freigabe der Mango mit edge_industrie: angenommen")
	}
}
