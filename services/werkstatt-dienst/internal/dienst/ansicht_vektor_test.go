package dienst

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

const ansichtVektor = "../../../../docs/contracts/werkstatt-ansicht-v1.example.json"

// TestAnsichtVektor erzeugt den Vektor der Ansicht, die der Dienst an das
// Portal meldet (docs/contracts/werkstatt-ansicht-v1.md), Byte für Byte aus den
// echten Strukturen. Die API (WerkstattAnsichtVertragTest) und der Test der
// Werkstatt-Bildschirme im Portal lesen ihn. Neu schreiben: VP_VEKTOR_SCHREIBEN=1.
func TestAnsichtVektor(t *testing.T) {
	zeit := time.Date(2026, 11, 2, 10, 12, 0, 0, time.UTC)
	var st werkbank.Status
	if err := json.Unmarshal([]byte(`{"schema":"vp-werkbank-status.v1","fassung":"werkbank-2026.11.1","zeit":"2026-11-02T10:11:58Z",
"werkstatt":{"schnittstelle":"eth0","kabel":true,"adressen":["192.168.8.2/24","192.168.1.2/24","10.213.0.2/24"]},
"netz":{"schnittstelle":"wlan0","oben":true,"adressen":["192.168.0.50/24"],"energiesparen":"aus"},
"durchleitung":{"ip_forward":true,"firewall":true},"antworten":[{"adresse":"192.168.1.1","macs":["94:83:c4:12:34:56"]}]}`), &st); err != nil {
		t.Fatal(err)
	}
	f := freigabe.Freigabe{Schema: freigabe.Schema, Kennung: "2026-11-mango-1", BoxArt: freigabe.Mango, ErteiltVon: "Admin",
		ErteiltAm: time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC), GueltigBis: time.Date(2026, 11, 30, 8, 0, 0, 0, time.UTC), Obergrenze: 20,
		OpenWrt: freigabe.Abbild{Fassung: "25.12.5", Datei: "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
			Sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Quelle: "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"},
		EdgeLight: freigabe.Programm{Fassung: "edge-light-2026.11.1", Quelle: "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-light-2026.11.1/",
			ProgrammSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", SkripteSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}
	a := Ansicht{Schema: AnsichtSchema, Zeit: zeit,
		Werkbank: WerkbankAnsicht{Adresse: "192.168.0.50", Bereit: true, Fassung: "werkbank-2026.11.1",
			HostSchluessel: "SHA256:QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQc", Status: &st, StatusZeit: zeit.Add(-2 * time.Second)},
		Freigabe:  FreigabeAnsicht{Laufend: true, Freigabe: &f, Boxen: 3},
		Anschluss: "eine Mango mit frischem OpenWrt",
		Lauf: &lauf.Stand{Kennung: "2026-11-02T10-05-00-mango", Freigabe: "2026-11-mango-1", BoxArt: "mango", Box: "edge-k7m2xq3",
			Beginn: zeit.Add(-7 * time.Minute), Zustand: lauf.Laeuft, Schritt: "programm", Titel: "Edge Light einspielen",
			Erledigt: []string{"erkennen", "fassungen", "internet", "passwort", "notfall"}},
	}
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	if os.Getenv("VP_VEKTOR_SCHREIBEN") == "1" {
		if err := os.WriteFile(ansichtVektor, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	alt, err := os.ReadFile(ansichtVektor)
	if err != nil {
		t.Fatal(err)
	}
	if string(alt) != string(b) {
		t.Fatalf("Vektor weicht ab (VP_VEKTOR_SCHREIBEN=1 schreibt ihn neu):\n%s", b)
	}
}
