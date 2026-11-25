package dienst

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
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
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/pfc200"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"

	"golang.org/x/crypto/ssh"
)

const ansichtZustaendePFC200 = "../../../../docs/contracts/werkstatt-ansicht-v1.zustaende-pfc200.json"

const zustaendeFreigabePFC200 = `{"schema":"vp-werkstatt-freigabe.v1","kennung":"2026-11-pfc200-1","box_art":"pfc200","erteilt_von":"Regel: neueste Fassung",
"erteilt_am":"2026-11-04T10:01:23Z","gueltig_bis":"2026-12-04T10:01:23Z","obergrenze":20,
"edge_industrie":{"fassung":"edge-industrie-2026.11.0","quelle":"https://git.tecmaxx.de/x/","programm_sha256":"4444444444444444444444444444444444444444444444444444444444444444","skripte_sha256":"5555555555555555555555555555555555555555555555555555555555555555","wartung_sha256":"6666666666666666666666666666666666666666666666666666666666666666"}}`

// keinPortal steht für die Portal-API: Mit ihr löst die Box ihren Code selbst
// ein (Schritt einloesen statt tunnel_adresse). Aufgerufen wird hier nichts,
// die Schritte tun in diesem Test nichts am Gerät.
type keinPortal struct{}

var errKeinPortal = errors.New("kein Portal im Test")

func (keinPortal) CodeHolenFuer(context.Context, string, bool, string) (portal.Code, error) {
	return portal.Code{}, errKeinPortal
}
func (keinPortal) FensterSchliessen(context.Context, string) (bool, error) {
	return false, errKeinPortal
}
func (keinPortal) AbnahmeSchreiben(context.Context, string, portal.Abnahme) (portal.Angenommen, error) {
	return portal.Angenommen{}, errKeinPortal
}
func (keinPortal) BoxStandLesen(context.Context, string) (portal.BoxStand, error) {
	return portal.BoxStand{}, errKeinPortal
}

// TestAnsichtZustaendePFC200 erzeugt die Ansicht in jedem Zustand eines Laufs
// am WAGO PFC200, aus dem Dienst selbst (Brücke als Attrappe, die Schrittfolge
// des echten Laufs mit der Portal-API, Schritte ohne Gerät): der Anschluss
// ohne Antwort (mit dem Handgriff „feste Adresse“), jeder Schritt laufend, die
// zwei Handgriffe, auf die ein Lauf wartet (Schalter auf RUN, Kabel in X2),
// jeder Fall, mit dem ein Lauf am PFC200 anhält, und fertig.
// Der Test der Werkstatt-Bildschirme im Portal zeichnet jeden Zustand.
// Die Mango hat ihren eigenen Vektor (TestAnsichtZustaende); er bleibt, wie er ist.
// Neu schreiben: VP_VEKTOR_SCHREIBEN=1.
func TestAnsichtZustaendePFC200(t *testing.T) {
	jetzt := time.Date(2026, 11, 4, 10, 29, 0, 0, time.UTC)
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	b.Kabel, b.Antworten = true, []map[string]any{}
	log := logs.Neu(&bytes.Buffer{}, "text", nil)
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: b.Adresse, HostDatei: filepath.Join(t.TempDir(), "host.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24")},
		Ziele:             []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22"), netip.MustParseAddrPort("192.168.1.17:22")},
		SSHQuellen:        []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")},
		Zeitlimit:         5 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	ablage, _ := protokoll.NeueAblage(t.TempDir())
	reg := metriken.Neu()
	dir := t.TempDir()
	for name, inhalt := range map[string]string{"mango.json": zustaendeFreigabe, "pfc200.json": zustaendeFreigabePFC200} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(inhalt), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	notfall, err := ssh.NewPublicKey(&ec.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pk := pfc200.Konfig{Werkbank: wb, Arbeit: t.TempDir(), LanNetz: netip.MustParsePrefix("10.213.0.1/24"),
		Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(notfall))), Portal: keinPortal{}, Log: log}
	laeufer := lauf.NeuerLaeufer(ablage, log, reg)
	laeufer.Jetzt = func() time.Time { return jetzt }
	d := Neu(&Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Ablage: ablage,
		Freigaben: freigabe.Datei{Pfad: filepath.Join(dir, "mango.json")}, FreigabenPFC200: freigabe.Datei{Pfad: filepath.Join(dir, "pfc200.json")},
		Laeufer: laeufer, PFC200: &pk, Takt: time.Second, Jetzt: func() time.Time { return jetzt }}, reg)
	ctx, cancel := context.WithCancel(context.Background())
	var laufen sync.WaitGroup
	defer func() { cancel(); laufen.Wait() }() // vor dem Aufräumen der Ablage

	zustaende := map[string]Ansicht{}
	halte := func(name, kennung string) {
		t.Helper()
		a := d.Ansicht()
		a.Werkbank.Adresse, a.Werkbank.HostSchluessel = "192.168.0.157:22", "SHA256:QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQc"
		// Die Fassung der Brücke hängt an den Wegwerf-Schlüsseln und an ihren Zielen.
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
	f, err := freigabe.Lies([]byte(zustaendeFreigabePFC200))
	if err != nil {
		t.Fatal(err)
	}
	pl, err := pfc200.NeuerLauf(pk, f, "zustaende")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pl.Schliesse)
	echte := pl.Schritte(pfc200.AbWerk)
	const box = "edge-k7m2xq3"
	// Was erkennen an einem Gerät ab Werk belegt (Namen wie im echten Schritt).
	abWerk := protokoll.Beleg{}.Mit("mac", "00:30:de:43:b8:7b").Mit("adresse", pfc200.FesteAdresse.String()).
		Mit("modell", "WAGO "+pfc200.Artikel).Mit("firmware", "03.10.08(22)").Mit("werkspasswoerter", "root, admin, user ab Werk")
	belegt := func(st lauf.Schritt) lauf.Schritt {
		st.Tun = func(_ context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
			switch st.Kennung {
			case "erkennen":
				return abWerk, nil
			case "zugaenge":
				return protokoll.Beleg{}.Mit("werkspasswort", "abgewiesen an SSH (root, admin, user)").
					Mit("passwort_anmeldung", "aus (root mit dem neuen Passwort abgewiesen, Anmeldung nur mit Schlüssel)"), nil
			case "programm":
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
	fahre := func(schritte []lauf.Schritt, fertig func(lauf.Stand) bool) *lauf.Lauf {
		t.Helper()
		l := lauf.Neu(jetzt, f.Kennung, freigabe.PFC200)
		laufen.Add(1)
		go func() { defer laufen.Done(); laeufer.Fahre(ctx, l, nil, schritte) }()
		for i := 0; !fertig(l.Stand()); i++ {
			if i > 2000 {
				t.Fatalf("Lauf kommt nicht an: %+v", l.Stand())
			}
			time.Sleep(5 * time.Millisecond)
		}
		return l
	}
	zustand := func(z lauf.Zustand, schritt string) func(lauf.Stand) bool {
		return func(s lauf.Stand) bool { return s.Zustand == z && (schritt == "" || s.Schritt == schritt) }
	}
	zeige := func(name string, l *lauf.Lauf, aktiv bool) {
		t.Helper()
		d.mu.Lock()
		d.aktiv, d.letzter = nil, l
		d.ansicht.AnschlussGeraet = ""
		if aktiv {
			d.aktiv = &aktiverLauf{l: l}
			d.ansicht.AnschlussGeraet = freigabe.PFC200
		}
		d.mu.Unlock()
		halte(name, "2026-11-04-102855-pfc2")
	}

	// Kabel steckt, niemand antwortet: Ein PFC200 ab Werk hat keine Adresse.
	// Die Lösung nennt beide Geräte, für den PFC200 mit dem Handgriff „feste Adresse“.
	d.Runde(ctx)
	halte("ohne_antwort", "")
	if a := zustaende["ohne_antwort"]; a.AnschlussFall != faelle.KeineBox || a.FreigabePFC200 == nil || !a.FreigabePFC200.Laufend {
		t.Fatalf("ohne Antwort: Fall %q (%s), Brücke %+v, Freigabe für den PFC200 %+v", a.AnschlussFall, a.Anschluss, a.Werkbank, a.FreigabePFC200)
	}
	// Der PFC200 antwortet unter 192.168.1.17: Die erste Runde merkt ihn sich
	// und wartet, bis er zweimal gleich antwortet (eine zweite begänne den Lauf).
	b.Antworten = []map[string]any{{"adresse": pfc200.FesteAdresse.String(), "macs": []string{"00:30:de:43:b8:7b"}}}
	d.Runde(ctx)
	halte("startet", "")
	if a := zustaende["startet"]; a.AnschlussFall != faelle.Startet || a.AnschlussGeraet != freigabe.PFC200 {
		t.Fatalf("PFC200 am Kabel: Fall %q, Gerät %q, %s", a.AnschlussFall, a.AnschlussGeraet, a.Anschluss)
	}
	d.mu.Lock()
	d.kandidat = nil
	d.amAnschluss("", "")
	d.mu.Unlock()

	// Der Lauf in jedem seiner Schritte.
	for i, st := range echte {
		zeige("laeuft_"+st.Kennung, fahre(bis(i, haengt), zustand(lauf.Laeuft, st.Kennung)), true)
	}
	// Der Lauf wartet auf einen Handgriff am Gerät und sieht selbst nach.
	nie := func(c context.Context) (bool, error) { return false, c.Err() }
	zeige("wartet_schalter_run", fahre(bis(index("erkennen"), func(c context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, k.WarteBis(c, "schalter_run", faelle.PFCSchalterStop, pfc200.SchalterAufRun, time.Hour, nie)
	}), zustand(lauf.Wartet, "erkennen")), true)
	zeige("wartet_kabel_x2", fahre(bis(index("erkennen"), func(c context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, k.WarteBis(c, "kabel_x2", faelle.PFCKabelX1, pfc200.KabelInX2+" (Kabel jetzt: X1)", time.Hour, nie)
	}), zustand(lauf.Wartet, "erkennen")), true)
	// Nach dem Neustart steht der Schalter wieder auf STOP: derselbe Handgriff mitten im Lauf.
	zeige("wartet_schalter_run_nach_neustart", fahre(bis(index("neustart"), func(c context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, k.WarteBis(c, "schalter_run", faelle.PFCSchalterStop, pfc200.SchalterAufRun, time.Hour, nie)
	}), zustand(lauf.Wartet, "neustart")), true)

	// Angehalten beim Erkennen, je Fall mit dem Handgriff des echten Laufs.
	halb := protokoll.Beleg{}.Mit("mac", "00:30:de:43:b8:7b").Mit("adresse", pfc200.FesteAdresse.String()).
		Mit("werkspasswort", "abgewiesen").Mit("lauf_vorher", "2026-11-04-092800-ab12").Mit("referenz_vorher", "edge-zz9988g").Mit("zuruecksetzen", "ja")
	fremd := protokoll.Beleg{}.Mit("mac", "00:30:de:43:b8:7b").Mit("adresse", pfc200.FesteAdresse.String()).Mit("werkspasswort", "abgewiesen")
	for name, e := range map[string]struct {
		beleg protokoll.Beleg
		h     lauf.Handgriff
	}{
		"angehalten_pfc_passwort": {halb, lauf.Handgriff{Was: pfc200.Werksreset, Fall: faelle.PFCPasswort,
			Grund: "Diesen PFC200 hat der Lauf 2026-11-04-092800-ab12 begonnen und nicht fertig gemacht."}},
		"angehalten_passwort_fremd": {fremd, lauf.Handgriff{Was: pfc200.ZurSeite, Fall: faelle.PasswortFremd,
			Grund: "Das Werkspasswort wird abgewiesen, und kein Lauf dieser Werkstatt kennt das Gerät."}},
		"angehalten_pfc_docker_an": {abWerk, lauf.Handgriff{Was: pfc200.DockerAus, Fall: faelle.PFCDockerAn,
			Grund: "Docker ist nach dem Ausschalten weiter active (Dienst läuft: ja)"}},
		"angehalten_pfc_falsches_geraet": {nil, lauf.Handgriff{Was: pfc200.ZurSeite, Fall: faelle.PFCFalschesGeraet,
			Grund: "Das Gerät ist kein PFC200 750-8212 (Bestellnummer \"750-8101\")."}},
		"angehalten_pfc_schon_eingerichtet": {abWerk, lauf.Handgriff{Was: pfc200.ZurSeite, Fall: faelle.PFCSchonEingerichtet,
			Grund: "Auf dem Gerät liegt schon ein Dienst von VoltPilot: kein Werkszustand."}},
		"angehalten_pfc_notfall_schluessel": {nil, lauf.Handgriff{Was: pfc200.ZurSeite, Fall: faelle.PFCNotfallSchluessel,
			Grund: "Der Notfall-Schlüssel ist von der Art ssh-ed25519; der SSH-Dienst des PFC200 nimmt nur RSA und ECDSA."}},
	} {
		zeige(name, fahre(bis(0, func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
			return e.beleg, e.h
		}), zustand(lauf.Angehalten, "")), false)
	}
	// Gescheitert mitten im Lauf: nach dem Neustart kein Tunnel.
	zeige("angehalten_beim_neustart", fahre(bis(index("neustart"), func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		return nil, errors.New("kein frischer Handshake am Tunnel nach dem Neustart")
	}), zustand(lauf.Angehalten, "")), false)
	zeige("fertig", fahre(bis(len(echte), nil), zustand(lauf.Fertig, "")), false)

	for name, a := range zustaende {
		if a.Lauf != nil && a.Lauf.Erledigt == nil {
			t.Errorf("%s: erledigt ist nil und geht als null ans Portal (Vertrag: Liste)", name)
		}
		if a.Lauf != nil && a.Lauf.BoxArt != freigabe.PFC200 {
			t.Errorf("%s: box_art %q", name, a.Lauf.BoxArt)
		}
		if a.FreigabePFC200 == nil || a.FreigabePFC200.Freigabe == nil || a.FreigabePFC200.Freigabe.EdgeIndustrie.Fassung == "" {
			t.Errorf("%s: ohne freigabe_pfc200", name)
		}
	}
	// Ein Lauf am PFC200 hat keinen Schritt für die SPS und keinen für die Firmware.
	for _, st := range echte {
		if strings.Contains(st.Kennung, "sps") || strings.Contains(st.Kennung, "koppel") || strings.Contains(st.Kennung, "firmware") {
			t.Errorf("Schritt %s gehört nicht in die Werkstatt", st.Kennung)
		}
	}
	out, err := json.MarshalIndent(zustaende, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out = append(out, '\n')
	if os.Getenv("VP_VEKTOR_SCHREIBEN") == "1" {
		if err := os.WriteFile(ansichtZustaendePFC200, out, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	alt, err := os.ReadFile(ansichtZustaendePFC200)
	if err != nil {
		t.Fatal(err)
	}
	if string(alt) != string(out) {
		t.Fatalf("Zustände weichen ab (VP_VEKTOR_SCHREIBEN=1 schreibt sie neu):\n%s", out)
	}
}
