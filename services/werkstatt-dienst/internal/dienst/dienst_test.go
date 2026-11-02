package dienst_test

import (
	"bytes"
	"context"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"

	"filippo.io/age"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
)

const freigabeJSON = `{"schema":"vp-werkstatt-freigabe.v1","kennung":"2026-11-mango-1","box_art":"mango","erteilt_von":"Betreiber",
"erteilt_am":"2026-11-02T08:00:00Z","gueltig_bis":"2026-11-30T23:00:00Z","obergrenze":20,
"openwrt":{"fassung":"25.12.5","datei":"openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin","sha256":"1111111111111111111111111111111111111111111111111111111111111111","quelle":"https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"},
"edge_light":{"fassung":"edge-light-2026.11.1","quelle":"https://git.tecmaxx.de/x/","programm_sha256":"2222222222222222222222222222222222222222222222222222222222222222","skripte_sha256":"3333333333333333333333333333333333333333333333333333333333333333"}}`

type aufbau struct {
	d    *dienst.Dienst
	b    *attrappe.Bruecke
	reg  *metriken.Register
	log  *bytes.Buffer
	frei string
}

func neu(t *testing.T, jetzt time.Time) aufbau {
	t.Helper()
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	var logbuf bytes.Buffer
	log := logs.Neu(&logbuf, "text", nil)
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: b.Adresse, HostDatei: filepath.Join(t.TempDir(), "host.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24")},
		Ziele:             []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22")},
		SSHQuellen:        []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")},
		Zeitlimit:         5 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	ablage, _ := protokoll.NeueAblage(t.TempDir())
	reg := metriken.Neu()
	frei := filepath.Join(t.TempDir(), "freigabe.json")
	d := dienst.Neu(&dienst.Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Freigaben: freigabe.Datei{Pfad: frei}, Ablage: ablage, Takt: time.Second, Jetzt: func() time.Time { return jetzt }}, reg)
	return aufbau{d: d, b: b, reg: reg, log: &logbuf, frei: frei}
}

func (a aufbau) metriken() string {
	var m bytes.Buffer
	_ = a.reg.Schreibe(&m)
	return m.String()
}

func TestRundeRichtetBrueckeEinUndLiestFreigabe(t *testing.T) {
	a := neu(t, time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC))
	a.b.Antworten = []map[string]any{{"adresse": "192.168.8.1", "macs": []string{"94:83:c4:01:02:03"}}}
	m := a.metriken()
	if !strings.Contains(m, "vp_werkstatt_werkbank_bereit 0") || strings.Contains(m, "\nvp_werkstatt_werkbank_status_alter_seconds ") {
		t.Fatalf("vor der ersten Runde:\n%s", m)
	}
	a.d.Runde(context.Background())
	an := a.d.Ansicht()
	if !an.Werkbank.Bereit || an.Werkbank.Einrichten == nil || an.Werkbank.Einrichten.Weg != "eingerichtet" || an.Werkbank.HostSchluessel == "" {
		t.Fatalf("%+v", an.Werkbank)
	}
	if an.Freigabe.Laufend || !strings.Contains(an.Freigabe.Grund, "nicht freigegeben") {
		t.Fatalf("%+v", an.Freigabe)
	}
	_ = os.WriteFile(a.frei, []byte(freigabeJSON), 0o644)
	a.d.Runde(context.Background())
	an = a.d.Ansicht()
	if !an.Freigabe.Laufend || an.Freigabe.Freigabe.Kennung != "2026-11-mango-1" {
		t.Fatalf("%+v", an.Freigabe)
	}
	m = a.metriken()
	for _, w := range []string{"vp_werkstatt_werkbank_bereit 1", "vp_werkstatt_freigabe_laufend 1", "vp_werkstatt_werkbank_kabel 1", "vp_werkstatt_werkbank_geraete 1", `vp_werkstatt_werkbank_einrichten_total{ergebnis="ok"} 1`, "\nvp_werkstatt_werkbank_status_alter_seconds 0\n"} {
		if !strings.Contains(m, w) {
			t.Errorf("ohne %q:\n%s", w, m)
		}
	}
	if strings.Contains(m, "94:83") {
		t.Fatal("MAC in den Metriken")
	}
	// Zustandswechsel stehen einmal im Log, nicht je Takt
	a.d.Runde(context.Background())
	if n := strings.Count(a.log.String(), "Brücke bereit"); n != 1 {
		t.Fatalf("Brücke bereit %d mal geloggt:\n%s", n, a.log.String())
	}
}

func TestGescheitertesEinrichtenPausiert(t *testing.T) {
	a := neu(t, time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC))
	a.b.EinrichtenScheitert = true
	a.d.Runde(context.Background())
	a.d.Runde(context.Background())
	if e, _ := a.b.Zaehler(); e != 0 {
		t.Fatal("trotzdem eingerichtet")
	}
	n := 0
	for _, b := range a.b.Befehle() {
		if strings.HasPrefix(b, "imager: sudo") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("in der Pause noch einmal eingerichtet (%d Versuche)", n)
	}
	an := a.d.Ansicht()
	if an.Werkbank.Bereit || an.Werkbank.Einrichten == nil || an.Werkbank.Einrichten.Weg != "gescheitert" {
		t.Fatalf("%+v", an.Werkbank)
	}
	if !strings.Contains(a.metriken(), `vp_werkstatt_werkbank_einrichten_total{ergebnis="fehler"} 1`) {
		t.Fatal(a.metriken())
	}
}

func TestReadinessFolgtDerSchleife(t *testing.T) {
	a := neu(t, time.Now())
	if a.d.Bereit() {
		t.Fatal("bereit vor dem Start")
	}
	ctx, cancel := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() { a.d.Laufe(ctx); close(fertig) }()
	for i := 0; !a.d.Bereit(); i++ {
		if i > 200 {
			t.Fatal("nie bereit")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-fertig
	if a.d.Bereit() {
		t.Fatal("bereit nach dem Ende")
	}
	_ = io.Discard
}

// Mit einer Mango am Anschluss: Lauf nur mit Freigabe, nie an einer
// eingerichteten Box, nach dem Ende gesperrt bis zum Abziehen.
func TestLaufAmAnschluss(t *testing.T) {
	jetzt := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	m := attrappe.NeueMango(t, false)
	b.AntwortenFunc, b.ZielFunc = m.Antworten, m.Ziel
	var logbuf bytes.Buffer
	log := logs.Neu(&logbuf, "text", nil)
	ziele := []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22"), netip.MustParseAddrPort("192.168.8.1:80"), netip.MustParseAddrPort("192.168.1.1:22")}
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: b.Adresse, HostDatei: filepath.Join(t.TempDir(), "host.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0", WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24")},
		Ziele: ziele, SSHQuellen: []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")}, Zeitlimit: 5 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	ablage, _ := protokoll.NeueAblage(t.TempDir())
	reg := metriken.Neu()
	frei := filepath.Join(t.TempDir(), "freigabe.json")
	id, _ := age.GenerateX25519Identity()
	arbeit, _ := os.MkdirTemp("/tmp", "vpw-")
	t.Cleanup(func() { _ = os.RemoveAll(arbeit) })
	mk := &mango.Konfig{Werkbank: wb, Fassungen: &fassungen.Ablage{Dir: t.TempDir()}, Arbeit: arbeit,
		LanNetz: netip.MustParsePrefix("10.213.0.1/24"), LanBruecke: netip.MustParseAddr("10.213.0.2"),
		Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()))), Empfaenger: id.Recipient(),
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Bauart: "mipsle", Zeiten: mango.Zeiten{Takt: 10 * time.Millisecond, Verbinden: 2 * time.Second}, Log: log}
	d := dienst.Neu(&dienst.Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Freigaben: freigabe.Datei{Pfad: frei}, Ablage: ablage,
		Laeufer: lauf.NeuerLaeufer(ablage, log, reg), Takt: time.Second, Jetzt: func() time.Time { return jetzt }, Mango: mk}, reg)
	ctx := context.Background()

	d.Runde(ctx)
	if a := d.Ansicht(); !strings.Contains(a.Anschluss, "nicht freigegeben") || a.Lauf != nil {
		t.Fatalf("ohne Freigabe: %+v", a)
	}
	// Die Freigabe nennt Dateien, die es nicht gibt: Der Lauf beginnt, erkennt
	// die Mango und hält bei den Fassungen an - ohne sie anzufassen.
	ohneNetz := strings.ReplaceAll(freigabeJSON, "https://git.tecmaxx.de/x/", "https://127.0.0.1:1/")
	ohneNetz = strings.ReplaceAll(ohneNetz, "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/", "https://127.0.0.1:1/")
	if strings.Contains(ohneNetz, "https://downloads") || strings.Contains(ohneNetz, "tecmaxx") {
		t.Fatal("der Test darf nicht ins Internet")
	}
	_ = os.WriteFile(frei, []byte(ohneNetz), 0o644)
	d.Runde(ctx)
	a := d.Ansicht()
	if a.Lauf == nil || !strings.Contains(a.Anschluss, "Nicht abziehen") {
		t.Fatalf("kein Lauf: %+v", a)
	}
	for i := 0; d.Ansicht().Lauf.Zustand != lauf.Angehalten; i++ {
		if i > 500 {
			t.Fatalf("Lauf endet nicht: %+v", d.Ansicht().Lauf)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if s := d.Ansicht().Lauf; s.Schritt != "fassungen" || strings.Join(s.Erledigt, ",") != "erkennen" {
		t.Fatalf("%+v", s)
	}
	for _, x := range m.Befehle() {
		if strings.Contains(x, "cat >") || strings.Contains(x, "sysupgrade") {
			t.Fatalf("Box angefasst: %s", x)
		}
	}
	es, _ := ablage.Lies(d.Ansicht().Lauf.Kennung)
	if es[0].Angaben["einstieg"] != "werk" || es[0].Angaben["freigabe"] != "2026-11-mango-1" || !strings.Contains(es[0].Angaben["openwrt"], "25.12.5") {
		t.Fatalf("erster Eintrag %+v", es[0])
	}
	// gleich wieder: gesperrt, bis abgezogen (der Lauf räumt gerade noch auf)
	for i := 0; ; i++ {
		d.Runde(ctx)
		if a := d.Ansicht(); strings.Contains(a.Anschluss, "hatte schon ihren Lauf") {
			break
		} else if i > 100 {
			t.Fatalf("nicht gesperrt: %s", a.Anschluss)
		}
		time.Sleep(10 * time.Millisecond)
	}
	n, _ := ablage.Laeufe()
	m.Abziehen()
	d.Runde(ctx)
	m.Einstecken()
	m.SetzeAdresse("10.213.0.1")
	d.Runde(ctx)
	if a := d.Ansicht(); !strings.Contains(a.Anschluss, "eingerichtete Box") {
		t.Fatalf("eingerichtete Box: %s", a.Anschluss)
	}
	if n2, _ := ablage.Laeufe(); len(n2) != len(n) {
		t.Fatal("an einer eingerichteten Box einen Lauf begonnen")
	}
	if err := d.Eingabe(ctx, "tunnel_adresse", "10.10.16.5"); err == nil {
		t.Fatal("Eingabe ohne Lauf angenommen")
	}
}

func TestOffeneLaeufeNachNeustart(t *testing.T) {
	a := neu(t, time.Now())
	_ = a.d.Ablage.Schreibe(protokoll.Eintrag{Lauf: "2026-11-02-090000-ab12", Art: protokoll.LaufBegonnen})
	_ = a.d.Ablage.Schreibe(protokoll.Eintrag{Lauf: "2026-11-02-090000-ab12", Art: protokoll.SchrittBegonnen, Schritt: "passwort"})
	a.d.SchliesseOffene()
	es, _ := a.d.Ablage.Lies("2026-11-02-090000-ab12")
	if l := es[len(es)-1]; l.Art != protokoll.LaufBeendet || l.Zustand != "angehalten" || !strings.Contains(l.Grund, "neu gestartet") {
		t.Fatalf("%+v", l)
	}
	if o, _ := a.d.Ablage.Offene(); len(o) != 0 {
		t.Fatal(o)
	}
}
