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
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
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
