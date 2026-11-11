package dienst

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"

	"golang.org/x/crypto/ssh"
)

const ansichtZustaende = "../../../../docs/contracts/werkstatt-ansicht-v1.zustaende.json"

const zustaendeFreigabe = `{"schema":"vp-werkstatt-freigabe.v1","kennung":"2026-11-mango-1","box_art":"mango","erteilt_von":"Betreiber",
"erteilt_am":"2026-11-04T10:01:23Z","gueltig_bis":"2026-12-04T10:01:23Z","obergrenze":20,
"openwrt":{"fassung":"25.12.5","datei":"openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin","sha256":"1111111111111111111111111111111111111111111111111111111111111111","quelle":"https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"},
"edge_light":{"fassung":"edge-light-2026.11.0","quelle":"https://git.tecmaxx.de/x/","programm_sha256":"2222222222222222222222222222222222222222222222222222222222222222","skripte_sha256":"3333333333333333333333333333333333333333333333333333333333333333"}}`

// TestAnsichtZustaende erzeugt die Ansicht, wie der Dienst sie am 04.11.2026
// um 10:28–10:29Z meldete, aus dem Dienst selbst (Brücke als Attrappe, echte
// Läufe mit Schritten ohne Box): Brücke ohne und mit Kabel, leere und volle
// `antworten`, ein am Schritt `erkennen` angehaltener Lauf (nichts erledigt),
// ein Lauf, der gerade mit `erkennen` beginnt, und einer in `wiedererkennen`.
// Dazu jeder weitere Zustand eines Laufs in der Folge des echten Laufs: jeder
// Schritt laufend, „Dein Schritt“ (Tunnel-Adresse, Probe), gescheitert mitten
// im Lauf, Handgriff Startlader, fertig.
// Der Test der Werkstatt-Bildschirme im Portal zeichnet jeden Zustand.
// Gleich gemacht werden nur Werte, die je Testlauf wechseln (Adresse und
// Host-Schlüssel und Fassung der Attrappe, Zufallsteil der Laufkennung).
// Neu schreiben: VP_VEKTOR_SCHREIBEN=1.
func TestAnsichtZustaende(t *testing.T) {
	jetzt := time.Date(2026, 11, 4, 10, 29, 0, 0, time.UTC)
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	b.Kabel, b.Antworten = false, []map[string]any{}
	log := logs.Neu(&bytes.Buffer{}, "text", nil)
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: b.Adresse, HostDatei: filepath.Join(t.TempDir(), "host.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24")},
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
	if err := os.WriteFile(frei, []byte(zustaendeFreigabe), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Neu(&Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Freigaben: freigabe.Datei{Pfad: frei}, Ablage: ablage,
		Takt: time.Second, Jetzt: func() time.Time { return jetzt }}, reg)
	laeufer := lauf.NeuerLaeufer(ablage, log, reg)
	laeufer.Jetzt = func() time.Time { return jetzt }
	ctx, cancel := context.WithCancel(context.Background())
	var laufen sync.WaitGroup
	defer func() { cancel(); laufen.Wait() }() // vor dem Aufräumen der Ablage

	zustaende := map[string]Ansicht{}
	halte := func(name, kennung string) {
		t.Helper()
		a := d.Ansicht()
		a.Werkbank.Adresse, a.Werkbank.HostSchluessel = "192.168.0.157:22", "SHA256:QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQc"
		// Die Fassung der Brücke hängt an den Wegwerf-Schlüsseln: die echte von 10:29Z.
		a.Werkbank.Fassung = "7124660edc034247"
		if a.Werkbank.Status != nil {
			st := *a.Werkbank.Status
			st.Fassung = a.Werkbank.Fassung
			a.Werkbank.Status = &st
		}
		if a.Werkbank.Einrichten != nil {
			e := *a.Werkbank.Einrichten
			e.Fassung = a.Werkbank.Fassung
			a.Werkbank.Einrichten = &e
		}
		if a.Lauf != nil {
			s := *a.Lauf
			s.Kennung = kennung
			a.Lauf = &s
		}
		zustaende[name] = a
	}
	// Die Schritte in der Folge des echten Laufs (ab Werk, ohne Portal-API: die
	// Tunnel-Adresse kommt aus dem Portal); Tun ist ersetzt, eine Box gibt es nicht.
	f, err := freigabe.Lies([]byte(zustaendeFreigabe))
	if err != nil {
		t.Fatal(err)
	}
	ml, err := mango.NeuerLauf(mango.Konfig{Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()))),
		Arbeit: t.TempDir(), Log: log}, f, "zustaende")
	if err != nil {
		t.Fatal(err)
	}
	echte := ml.Schritte(mango.AbWerk)
	const box = "edge-5t2dcy6"
	belegt := func(st lauf.Schritt) lauf.Schritt {
		st.Tun = func(_ context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
			if st.Kennung == "programm" {
				k.Box(box)
			}
			return protokoll.Beleg{}.Mit(st.Kennung, "belegt"), nil
		}
		return st
	}
	// bis: alle Schritte vor i belegt, Schritt i tut tun.
	bis := func(i int, tun func(context.Context, *lauf.Kontext) (protokoll.Beleg, error)) []lauf.Schritt {
		var r []lauf.Schritt
		for _, st := range echte[:i] {
			r = append(r, belegt(st))
		}
		if i < len(echte) {
			st := echte[i]
			st.Frist, st.Tun = time.Hour, tun
			r = append(r, st)
		}
		return r
	}
	haengt := func(c context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
		<-c.Done()
		return nil, c.Err()
	}
	index := func(k string) int {
		for i, st := range echte {
			if st.Kennung == k {
				return i
			}
		}
		t.Fatalf("kein Schritt %s", k)
		return 0
	}
	// fahre startet einen Lauf und wartet, bis sein Stand fertig erfüllt.
	fahre := func(schritte []lauf.Schritt, fertig func(lauf.Stand) bool) *lauf.Lauf {
		t.Helper()
		l := lauf.Neu(jetzt, "2026-11-mango-1", "mango")
		laufen.Add(1)
		go func() { defer laufen.Done(); laeufer.Fahre(ctx, l, nil, schritte) }()
		for i := 0; !fertig(l.Stand()); i++ {
			if i > 500 {
				t.Fatalf("Lauf kommt nicht an: %+v", l.Stand())
			}
			time.Sleep(5 * time.Millisecond)
		}
		return l
	}
	zustand := func(z lauf.Zustand, schritt string) func(lauf.Stand) bool {
		return func(s lauf.Stand) bool { return s.Zustand == z && (schritt == "" || s.Schritt == schritt) }
	}
	zeige := func(name, kennung string, l *lauf.Lauf, aktiv bool) {
		t.Helper()
		d.mu.Lock()
		d.aktiv, d.letzter = nil, l
		if aktiv {
			d.aktiv = &aktiverLauf{l: l}
		}
		d.mu.Unlock()
		halte(name, kennung)
	}

	// Brücke ohne Kabel, niemand antwortet, noch kein Lauf.
	d.Runde(ctx)
	halte("ohne_kabel", "")
	// Kabel steckt, die Mango antwortet an 192.168.8.1.
	b.Kabel, b.Antworten = true, []map[string]any{{"adresse": "192.168.8.1", "macs": []string{"94:83:c4:17:47:e3"}}}
	d.Runde(ctx)
	halte("mit_kabel", "")
	// Am Anschluss, ohne Lauf: die Mango startet noch; die Brücke meldet Unterspannung.
	d.mu.Lock()
	d.amAnschluss(faelle.Startet, "Mango erkannt unter 192.168.8.1; der Dienst wartet, bis sie fertig gestartet ist. Nicht abziehen.")
	d.mu.Unlock()
	halte("startet", "")
	d.mu.Lock()
	d.unterspannung = true
	d.amAnschluss(faelle.Startet, "Mango erkannt unter 192.168.8.1; der Dienst wartet, bis sie fertig gestartet ist. Nicht abziehen.")
	d.unterspannung = false
	d.mu.Unlock()
	halte("unterspannung", "")
	d.mu.Lock()
	d.amAnschluss("", "")
	d.mu.Unlock()
	// 10:28:08Z: erkennen scheitert nach seiner Frist, der Lauf hält an (nichts erledigt).
	zeige("angehalten_beim_erkennen", "2026-11-04-102805-cf8d", fahre(bis(0, func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, errors.New("Brücke 192.168.0.157:22 nicht erreichbar: dial tcp 192.168.0.157:22: i/o timeout")
	}), zustand(lauf.Angehalten, "")), false)
	// 10:28:58Z: der nächste Lauf, in jedem seiner Schritte.
	for i, st := range echte {
		zeige("laeuft_"+st.Kennung, "2026-11-04-102855-049e", fahre(bis(i, haengt), zustand(lauf.Laeuft, st.Kennung)), true)
	}
	// Dein Schritt: Tunnel-Adresse und Probe im Portal.
	zeige("wartet_tunnel_adresse", "2026-11-04-102855-049e", fahre(bis(index("tunnel_adresse"), func(c context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
		_, err := k.Warte(c, "tunnel_adresse", mango.HinweisTunnel(box, "QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ="))
		return nil, err
	}), zustand(lauf.Wartet, "tunnel_adresse")), true)
	zeige("wartet_probe", "2026-11-04-102855-049e", fahre(bis(index("probe"), func(c context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
		_, err := k.Warte(c, "probe", mango.HinweisProbe(box, "SHA256:QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQc"))
		return nil, err
	}), zustand(lauf.Wartet, "probe")), true)
	// Gescheitert mitten im Lauf, mit Handgriff Startlader, und fertig.
	zeige("angehalten_beim_neustart", "2026-11-04-102855-049e", fahre(bis(index("neustart"), func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, errors.New("kein frischer Handshake an wg_wartung nach dem Neustart")
	}), zustand(lauf.Angehalten, "")), false)
	zeige("angehalten_startlader", "2026-11-04-102855-049e", fahre(bis(index("openwrt"), func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, lauf.Handgriff{Was: "Startlader (Handgriff M4): Mango vom Strom, Reset-Knopf halten und Strom stecken, bis die Leuchte fünfmal blinkt.",
			Grund: "Die Mango nimmt das Abbild nicht an.", Fall: faelle.AbbildAbgelehnt}
	}), zustand(lauf.Angehalten, "")), false)
	// Zurücksetzen: eine gebrauchte GL-Mango und eine halb eingerichtete Box
	// dieser Werkstatt; zur Seite: ein fremdes Passwort.
	for name, h := range map[string]lauf.Handgriff{
		"angehalten_gl_passwort": {Was: mango.Zuruecksetzen, Fall: faelle.GLPasswort, Grund: "Die Mango verlangt ein Passwort: Jemand hat ihre Werksfirmware schon eingerichtet."},
		"angehalten_halb_eigene": {Was: mango.Zuruecksetzen, Fall: faelle.HalbEigene, Grund: "Diese Mango hat der Lauf 2026-11-04-162800-ab12 begonnen und nicht fertig gemacht."},
		"angehalten_passwort_fremd": {Was: "Mango abziehen und zur Seite legen; den Grund im Portal oder beim Betreiber melden.", Fall: faelle.PasswortFremd,
			Grund: "Das Gerät unter 192.168.1.1 verlangt ein Passwort: kein frisches OpenWrt."},
	} {
		zeige(name, "2026-11-04-102855-049e", fahre(bis(0, func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
			return nil, h
		}), zustand(lauf.Angehalten, "")), false)
	}
	zeige("fertig", "2026-11-04-102855-049e", fahre(bis(len(echte), nil), zustand(lauf.Fertig, "")), false)

	for name, a := range zustaende {
		if a.Lauf != nil && a.Lauf.Erledigt == nil {
			t.Errorf("%s: erledigt ist nil und geht als null ans Portal (Vertrag: Liste)", name)
		}
	}
	out, err := json.MarshalIndent(zustaende, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out = append(out, '\n')
	if os.Getenv("VP_VEKTOR_SCHREIBEN") == "1" {
		if err := os.WriteFile(ansichtZustaende, out, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	alt, err := os.ReadFile(ansichtZustaende)
	if err != nil {
		t.Fatal(err)
	}
	if string(alt) != string(out) {
		t.Fatalf("Zustände weichen ab (VP_VEKTOR_SCHREIBEN=1 schreibt sie neu):\n%s", out)
	}
}
