package dienst_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/pfc200"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

var freigabePFC = `{"schema":"vp-werkstatt-freigabe.v1","kennung":"2026-11-pfc200-1","box_art":"pfc200","erteilt_von":"Betreiber",
"erteilt_am":"2026-11-10T08:00:00Z","gueltig_bis":"2026-11-11T08:00:00Z","obergrenze":5,
"edge_industrie":{"fassung":"edge-industrie-2026.11.1","quelle":"https://127.0.0.1:1/","programm_sha256":"` + sha1 + `","skripte_sha256":"` + sha2 + `","wartung_sha256":"` + sha3 + `"}}`

var sha1, sha2, sha3 = strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)

// beideGeraete baut einen Dienst, der Mango und PFC200 einrichtet, mit je
// einer laufenden Freigabe, deren Dateien es nicht gibt: Ein Lauf endet nach
// erkennen bei den Fassungen, ohne das Gerät zu ändern.
func beideGeraete(t *testing.T) (*dienst.Dienst, *attrappe.Bruecke, *protokoll.Ablage) {
	t.Helper()
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	log := logs.Neu(&bytes.Buffer{}, "text", nil)
	var ziele []netip.AddrPort
	for _, z := range []string{"192.168.8.1:22", "192.168.8.1:80", "192.168.1.1:22", "192.168.1.1:80", "10.213.0.1:22", "10.213.0.1:8484", "192.168.1.17:22", "10.213.0.1:502"} {
		ziele = append(ziele, netip.MustParseAddrPort(z))
	}
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: b.Adresse, HostDatei: filepath.Join(t.TempDir(), "host.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24"), netip.MustParsePrefix("10.213.0.2/24")},
		Ziele:             ziele, SSHQuellen: []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")}, Zeitlimit: 5 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	ablage, _ := protokoll.NeueAblage(t.TempDir())
	dir := t.TempDir()
	ohneNetz := strings.ReplaceAll(freigabeJSON, "https://git.tecmaxx.de/x/", "https://127.0.0.1:1/")
	ohneNetz = strings.ReplaceAll(ohneNetz, "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/", "https://127.0.0.1:1/")
	_ = os.WriteFile(filepath.Join(dir, "mango.json"), []byte(ohneNetz), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "pfc200.json"), []byte(freigabePFC), 0o644)
	id, _ := age.GenerateX25519Identity()
	arbeit, _ := os.MkdirTemp("/tmp", "vpw-")
	t.Cleanup(func() { _ = os.RemoveAll(arbeit) })
	lan, bruecke := netip.MustParsePrefix("10.213.0.1/24"), netip.MustParseAddr("10.213.0.2")
	ablageF := &fassungen.Ablage{Dir: t.TempDir()}
	// Der Notfall-Schlüssel für den PFC200: ECDSA (kein Ed25519).
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	notfallPub, _ := ssh.NewPublicKey(&ec.PublicKey)
	mk := &mango.Konfig{Werkbank: wb, Fassungen: ablageF, Arbeit: arbeit, LanNetz: lan, LanBruecke: bruecke,
		Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()))), Empfaenger: id.Recipient(),
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Bauart: "mipsle", Spuren: ablage,
		Zeiten: mango.Zeiten{Takt: 10 * time.Millisecond, Verbinden: 2 * time.Second}, Log: log}
	pk := &pfc200.Konfig{Werkbank: wb, Fassungen: ablageF, Arbeit: arbeit, LanNetz: lan, LanBruecke: bruecke,
		Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(notfallPub))), Empfaenger: id.Recipient(),
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Spuren: ablage,
		Zeiten: pfc200.Zeiten{Takt: 10 * time.Millisecond, Verbinden: 2 * time.Second, Schalter: time.Second}, Log: log}
	reg := metriken.Neu()
	jetzt := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	d := dienst.Neu(&dienst.Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Ablage: ablage,
		Freigaben: freigabe.Datei{Pfad: filepath.Join(dir, "mango.json")}, FreigabenPFC200: freigabe.Datei{Pfad: filepath.Join(dir, "pfc200.json")},
		Laeufer: lauf.NeuerLaeufer(ablage, log, reg), Takt: time.Second, Jetzt: func() time.Time { return jetzt }, Mango: mk, PFC200: pk}, reg)
	d.SchliesseOffene()
	return d, b, ablage
}

func bisEnde(t *testing.T, d *dienst.Dienst) lauf.Stand {
	t.Helper()
	for i := 0; ; i++ {
		if s := d.Ansicht().Lauf; s != nil && (s.Zustand == lauf.Angehalten || s.Zustand == lauf.Fertig) {
			for j := 0; j < 200 && strings.Contains(d.Ansicht().Anschluss, "arbeitet"); j++ {
				d.Runde(context.Background())
				time.Sleep(5 * time.Millisecond)
			}
			return *s
		}
		if i > 1500 {
			t.Fatalf("Lauf endet nicht: %+v", d.Ansicht())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Antwortet am Kabel niemand, steht der Handgriff „feste Adresse“ immer da:
// Ein PFC200 ab Werk hat ohne ihn keine Adresse, der Dienst sähe ihn nie.
func TestOhneAntwortStehtDerHandgriffFesteAdresseDa(t *testing.T) {
	d, b, _ := beideGeraete(t)
	b.Kabel = true
	b.AntwortenFunc = func() []map[string]any { return nil }
	d.Runde(context.Background())
	a := d.Ansicht()
	if a.AnschlussFall != faelle.KeineBox || a.AnschlussLoesung == nil {
		t.Fatalf("%+v", a)
	}
	text := strings.Join(a.AnschlussLoesung.Schritte, " ") + " " + a.Anschluss
	for _, w := range []string{"STOP", "8 Sekunden", "RUN", "192.168.1.17", "Mango"} {
		if !strings.Contains(text, w) {
			t.Errorf("ohne %q: %s", w, text)
		}
	}
	if a.FreigabePFC200 == nil || !a.FreigabePFC200.Laufend || a.FreigabePFC200.Freigabe.BoxArt != "pfc200" || !a.Freigabe.Laufend || a.Freigabe.Freigabe.BoxArt != "mango" {
		t.Fatalf("Freigaben: %+v / %+v", a.Freigabe, a.FreigabePFC200)
	}
}

// Ein PFC200 unter der festen Adresse bekommt den Lauf des PFC200, unter
// seiner eigenen Freigabe; die Fälle sprechen vom PFC200.
func TestPFC200AmAnschlussBekommtSeinenLauf(t *testing.T) {
	d, b, ablage := beideGeraete(t)
	p := attrappe.NeuerPFC200(t)
	b.Kabel = true
	b.AntwortenFunc, b.ZielFunc = p.Antworten, p.Ziel
	ctx := context.Background()
	d.Runde(ctx)
	a := d.Ansicht()
	if a.Lauf != nil || a.AnschlussGeraet != "pfc200" || a.AnschlussFall != faelle.Startet || !strings.Contains(a.Anschluss, "PFC200 erkannt unter 192.168.1.17") ||
		!strings.Contains(a.AnschlussLoesung.Titel, "PFC200") {
		t.Fatalf("erster Takt: %+v / %+v", a, a.AnschlussLoesung)
	}
	d.Runde(ctx)
	s := bisEnde(t, d)
	if s.BoxArt != "pfc200" || s.Freigabe != "2026-11-pfc200-1" || s.Schritt != "fassungen" || s.Fall != faelle.FassungNichtBereit ||
		!strings.Contains(s.Loesung.Schritte[0], "PFC200") || s.Vorher == nil || !strings.Contains(s.Vorher.System, "03.10.08") {
		t.Fatalf("Lauf: %+v / %+v / %+v", s, s.Loesung, s.Vorher)
	}
	if z := p.Lies("aufrufe"); z != "" {
		t.Fatalf("das Gerät wurde geändert:\n%s", z)
	}
	// Der Lauf zählt unter der Freigabe des PFC200, nicht unter der der Mango.
	if n, _ := ablage.Begonnen("2026-11-pfc200-1"); n != 1 {
		t.Fatalf("%d Läufe unter der Freigabe des PFC200", n)
	}
	if n, _ := ablage.Begonnen("2026-11-mango-1"); n != 0 {
		t.Fatalf("%d Läufe unter der Freigabe der Mango", n)
	}
	// Danach ist er gesperrt, bis er abgezogen war.
	d.Runde(ctx)
	if a := d.Ansicht(); a.AnschlussFall != faelle.Gesperrt || !strings.Contains(a.AnschlussLoesung.Titel, "PFC200") {
		t.Fatalf("nach dem Lauf: %+v", a)
	}
}

// Ohne Freigabe für den PFC200 beginnt für ihn kein Lauf, auch wenn die der
// Mango läuft.
func TestPFC200OhneEigeneFreigabeBeginntNicht(t *testing.T) {
	d, b, _ := beideGeraete(t)
	d.FreigabenPFC200 = freigabe.Datei{Pfad: filepath.Join(t.TempDir(), "fehlt.json")}
	p := attrappe.NeuerPFC200(t)
	b.Kabel = true
	b.AntwortenFunc, b.ZielFunc = p.Antworten, p.Ziel
	for i := 0; i < 3; i++ {
		d.Runde(context.Background())
	}
	a := d.Ansicht()
	if a.Lauf != nil || a.AnschlussFall != faelle.NichtFreigegeben || !strings.Contains(a.Anschluss, "PFC200 erkannt") || !a.Freigabe.Laufend {
		t.Fatalf("%+v", a)
	}
}

// Eine Mango am selben Dienst bekommt weiter den Lauf der Mango.
func TestMangoNebenDemPFC200BekommtIhrenLauf(t *testing.T) {
	d, b, _ := beideGeraete(t)
	m := attrappe.NeueMango(t, true)
	b.Kabel = true
	b.AntwortenFunc, b.ZielFunc = m.Antworten, m.Ziel
	d.Runde(context.Background())
	if a := d.Ansicht(); a.AnschlussGeraet != "mango" || !strings.Contains(a.AnschlussLoesung.Titel, "Mango") {
		t.Fatalf("%+v / %+v", a, a.AnschlussLoesung)
	}
	d.Runde(context.Background())
	if s := bisEnde(t, d); s.BoxArt != "mango" || s.Freigabe != "2026-11-mango-1" || s.Schritt != "fassungen" || !strings.Contains(s.Loesung.Schritte[0], "Mango") {
		t.Fatalf("%+v / %+v", s, s.Loesung)
	}
}
