package dienst_test

import (
	"bytes"
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// standPortal antwortet nur auf BoxStandLesen; alles andere braucht der
// Prüflauf an einer halb eingerichteten Box nicht.
type standPortal struct {
	stand map[string]portal.BoxStand
}

func (p *standPortal) CodeHolen(context.Context, string, bool) (portal.Code, error) {
	return portal.Code{}, errors.New("nicht in diesem Test")
}
func (p *standPortal) FensterSchliessen(context.Context, string) (bool, error) {
	return false, errors.New("nicht in diesem Test")
}
func (p *standPortal) AbnahmeSchreiben(context.Context, string, portal.Abnahme) (portal.Angenommen, error) {
	return portal.Angenommen{}, errors.New("nicht in diesem Test")
}
func (p *standPortal) BoxStandLesen(_ context.Context, ref string) (portal.BoxStand, error) {
	st, ok := p.stand[ref]
	if !ok {
		return portal.BoxStand{}, errors.New("Portal nicht erreicht")
	}
	return st, nil
}

type werkbankAufbau struct {
	d      *dienst.Dienst
	b      *attrappe.Bruecke
	m      *attrappe.Mango
	ablage *protokoll.Ablage
	mk     *mango.Konfig
	mu     sync.Mutex
	jetzt  time.Time
}

func (w *werkbankAufbau) uhr() time.Time { w.mu.Lock(); defer w.mu.Unlock(); return w.jetzt }
func (w *werkbankAufbau) spaeter(d time.Duration) {
	w.mu.Lock()
	w.jetzt = w.jetzt.Add(d)
	w.mu.Unlock()
}

// werkbank baut Brücke, Mango, Dienst und eine laufende Freigabe, deren
// Dateien es nicht gibt: Ein Lauf ab Werk oder ab OpenWrt endet also nach
// erkennen bei den Fassungen, ohne die Box zu ändern.
func werkbankMit(t *testing.T, m *attrappe.Mango, p mango.Portal) *werkbankAufbau {
	t.Helper()
	imager := attrappe.Schluessel(t)
	b := attrappe.NeueBruecke(t, imager.PublicKey())
	b.AntwortenFunc, b.ZielFunc = m.Antworten, m.Ziel
	var logbuf bytes.Buffer
	log := logs.Neu(&logbuf, "text", nil)
	var ziele []netip.AddrPort
	for _, z := range []string{"192.168.8.1:22", "192.168.8.1:80", "192.168.1.1:22", "192.168.1.1:80", "10.213.0.1:22"} {
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
	reg := metriken.Neu()
	frei := filepath.Join(t.TempDir(), "freigabe.json")
	ohneNetz := strings.ReplaceAll(freigabeJSON, "https://git.tecmaxx.de/x/", "https://127.0.0.1:1/")
	ohneNetz = strings.ReplaceAll(ohneNetz, "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/", "https://127.0.0.1:1/")
	_ = os.WriteFile(frei, []byte(ohneNetz), 0o644)
	id, _ := age.GenerateX25519Identity()
	arbeit, _ := os.MkdirTemp("/tmp", "vpw-")
	t.Cleanup(func() { _ = os.RemoveAll(arbeit) })
	w := &werkbankAufbau{b: b, m: m, ablage: ablage, jetzt: time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)}
	w.mk = &mango.Konfig{Werkbank: wb, Fassungen: &fassungen.Ablage{Dir: t.TempDir()}, Arbeit: arbeit,
		LanNetz: netip.MustParsePrefix("10.213.0.1/24"), LanBruecke: netip.MustParseAddr("10.213.0.2"),
		Notfall: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()))), Empfaenger: id.Recipient(),
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Bauart: "mipsle", Portal: p, Spuren: ablage,
		Zeiten: mango.Zeiten{Takt: 10 * time.Millisecond, Verbinden: 2 * time.Second}, Log: log}
	w.d = dienst.Neu(&dienst.Dienst{Log: log, Werkbank: wb, Adresse: b.Adresse, Freigaben: freigabe.Datei{Pfad: frei}, Ablage: ablage,
		Laeufer: lauf.NeuerLaeufer(ablage, log, reg), Takt: time.Second, Jetzt: w.uhr, Mango: w.mk}, reg)
	return w
}

// bisEnde wartet, bis der Lauf am Anschluss zu Ende ist.
func (w *werkbankAufbau) bisEnde(t *testing.T) lauf.Stand {
	t.Helper()
	for i := 0; ; i++ {
		if s := w.d.Ansicht().Lauf; s != nil && (s.Zustand == lauf.Angehalten || s.Zustand == lauf.Fertig) {
			for j := 0; j < 200 && strings.Contains(w.d.Ansicht().Anschluss, "arbeitet"); j++ {
				w.d.Runde(context.Background())
				time.Sleep(5 * time.Millisecond)
			}
			return *s
		}
		if i > 1000 {
			t.Fatalf("Lauf endet nicht: %+v", w.d.Ansicht())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (w *werkbankAufbau) laeufe(t *testing.T) []string {
	t.Helper()
	l, err := w.ablage.Laeufe()
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// Lauf 2026-11-05-113810-d74e nachgestellt: Die Mango startet gerade und
// zeigt im Preinit-Fenster kurz 192.168.1.1. Früher begann der Dienst sofort
// einen Lauf „ab OpenWrt“, der Sekunden später mit „No route to host“ anhielt
// und die MAC bis zum Abziehen sperrte. Jetzt beginnt kein Lauf, bis die Box
// zwei Takte lang unter derselben Adresse steht und SSH annimmt.
func TestStartfensterBeginntKeinenLauf(t *testing.T) {
	m := attrappe.NeueMango(t, false)
	m.SetzeStartet(true)
	w := werkbankMit(t, m, nil)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		w.d.Runde(ctx)
		if a := w.d.Ansicht(); a.Lauf != nil {
			t.Fatalf("Lauf im Startfenster begonnen: %+v", a.Lauf)
		}
	}
	if a := w.d.Ansicht(); !strings.Contains(a.Anschluss, "startet noch") || !strings.Contains(a.Anschluss, "No route to host") {
		t.Fatalf("Anschluss: %s", a.Anschluss)
	}
	if n := w.laeufe(t); len(n) != 0 {
		t.Fatalf("Läufe im Protokoll: %v (zählen gegen die Obergrenze)", n)
	}
	m.SetzeStartet(false) // fertig gestartet: GL-Firmware unter 192.168.8.1
	w.d.Runde(ctx)
	if w.d.Ansicht().Lauf != nil {
		t.Fatal("Lauf beim ersten Takt unter der neuen Adresse")
	}
	w.d.Runde(ctx)
	if w.d.Ansicht().Lauf == nil {
		t.Fatalf("kein Lauf: %s", w.d.Ansicht().Anschluss)
	}
	s := w.bisEnde(t)
	if s.Schritt != "fassungen" || strings.Join(s.Erledigt, ",") != "erkennen" {
		t.Fatalf("%+v", s)
	}
	es, _ := w.ablage.Lies(s.Kennung)
	if es[0].Angaben["einstieg"] != "werk" || es[0].Angaben["adresse"] != "192.168.8.1" {
		t.Fatalf("%+v", es[0].Angaben)
	}
}

// Lauf 2026-11-05-115040-8287 nachgestellt: Nach dem Reset antwortet die
// GL-Firmware auf ARP, Dropbear aber noch nicht (Connection refused). Der
// Dienst wartet; kommt SSH nach der Startfrist nie, nennt der Lauf den
// Startlader statt „zur Seite legen“.
func TestSSHNochZuWartetDannStartlader(t *testing.T) {
	m := attrappe.NeueMango(t, false)
	m.SetzeSSHZu(true)
	w := werkbankMit(t, m, nil)
	ctx := context.Background()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	if a := w.d.Ansicht(); a.Lauf != nil || !strings.Contains(a.Anschluss, "Connection refused") {
		t.Fatalf("%+v", a)
	}
	w.spaeter(dienst.StartFrist + time.Second)
	w.d.Runde(ctx)
	if w.d.Ansicht().Lauf == nil {
		t.Fatalf("nach der Startfrist kein Lauf: %s", w.d.Ansicht().Anschluss)
	}
	s := w.bisEnde(t)
	if s.Schritt != "erkennen" || !strings.HasPrefix(s.Handgriff, "Startlader") || !strings.Contains(s.Grund, "kein SSH") {
		t.Fatalf("%+v", s)
	}
}

// Mango 2 vom 05.11.: gebraucht gekauft, GL-Firmware mit dem Passwort des
// Vorbesitzers (Lauf 114140-ee92). Ein Handgriff, Zurücksetzen; danach ist sie
// ab Werk, und der Dienst beginnt von selbst einen neuen Lauf.
func TestGebrauchteGLMangoZuruecksetzenUndWeiter(t *testing.T) {
	m := attrappe.NeueMango(t, false)
	m.RootPasswortAbWerk = true
	w := werkbankMit(t, m, nil)
	ctx := context.Background()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	s := w.bisEnde(t)
	if !strings.HasPrefix(s.Handgriff, "Zurücksetzen:") || !strings.Contains(s.Grund, "verlangt ein Passwort") {
		t.Fatalf("%+v", s)
	}
	w.d.Runde(ctx)
	if !strings.Contains(w.d.Ansicht().Anschluss, "hatte schon ihren Lauf") {
		t.Fatalf("nicht gesperrt: %s", w.d.Ansicht().Anschluss)
	}
	// Reset: Die Mango ist während des Neustarts vom Netz, dann ab Werk.
	m.Zuruecksetzen(t)
	w.d.Runde(ctx)
	m.Einstecken()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	if w.d.Ansicht().Lauf == nil || w.d.Ansicht().Lauf.Kennung == s.Kennung {
		t.Fatalf("kein neuer Lauf nach dem Reset: %s", w.d.Ansicht().Anschluss)
	}
	n := w.bisEnde(t)
	if n.Schritt != "fassungen" || strings.Join(n.Erledigt, ",") != "erkennen" {
		t.Fatalf("neuer Lauf: %+v", n)
	}
}

// halberLauf schreibt das Protokoll eines Laufs, der dieser MAC ein Passwort
// gesetzt hat und vor der Übergabe anhielt (wie der Lauf, der edge-pmzasg2
// am 04.11. anlegte).
func halberLauf(t *testing.T, a *protokoll.Ablage, mac, host string, bis ...string) {
	t.Helper()
	k := "2026-11-04-162800-ab12"
	_ = a.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBegonnen, Angaben: map[string]string{"mac": mac, "einstieg": "openwrt", "freigabe": "2026-11-mango-1"}})
	_ = a.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.SchrittBelegt, Schritt: "erkennen", Beleg: protokoll.Beleg{}.Mit("mac", mac).Mit("host_schluessel", "ssh-rsa "+host)})
	for _, s := range bis {
		b := protokoll.Beleg{}.Mit("x", "y")
		if s == "programm" {
			b = b.Mit("referenz", "edge-k7m2xq3 (Prüfzeichen gültig)")
		}
		_ = a.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.SchrittBelegt, Schritt: s, Beleg: b})
	}
	_ = a.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBeendet, Zustand: "angehalten", Grund: "Der Dienst wurde neu gestartet"})
}

var bisLan = []string{"fassungen", "internet", "passwort", "notfall", "programm", "tunnel_schluessel", "einloesen", "tunnel", "lan"}

// Mango 1 vom 05.11.: ein Lauf dieser Werkstatt kam bis zum LAN-Netz und
// hielt an. Der Dienst erkennt sie (MAC, Host-Schlüssel, im Portal nicht
// abgenommen, nicht gekoppelt), meldet sich nicht an und nennt den Handgriff
// Zurücksetzen; nach dem Reset steht sie frisch unter 192.168.1.1 und ihr
// neuer Lauf beginnt von selbst.
func TestHalbeEigeneBoxImLanZuruecksetzenUndNeu(t *testing.T) {
	m := attrappe.NeueMango(t, true)
	m.HalbEingerichtet("10.213.0.1", "werkstatt-passwort-vom-04-11")
	p := &standPortal{stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3"}}}
	w := werkbankMit(t, m, p)
	halberLauf(t, w.ablage, m.MAC, m.HostOpenWrt(), bisLan...)
	ctx := context.Background()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	s := w.bisEnde(t)
	if !strings.HasPrefix(s.Handgriff, "Zurücksetzen:") || !strings.Contains(s.Grund, "2026-11-04-162800-ab12") ||
		!strings.Contains(s.Grund, "nicht abgenommen und nicht gekoppelt") {
		t.Fatalf("%+v", s)
	}
	for _, b := range m.Befehle() {
		t.Fatalf("an der Box ausgeführt: %s", b)
	}
	es, _ := w.ablage.Lies(s.Kennung)
	if es[0].Angaben["einstieg"] != "lan" {
		t.Fatalf("%+v", es[0].Angaben)
	}
	m.Zuruecksetzen(t)
	w.d.Runde(ctx)
	m.Einstecken()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	if w.d.Ansicht().Lauf == nil || w.d.Ansicht().Lauf.Kennung == s.Kennung {
		t.Fatalf("kein neuer Lauf nach dem Reset: %s", w.d.Ansicht().Anschluss)
	}
	n := w.bisEnde(t)
	es, _ = w.ablage.Lies(n.Kennung)
	if es[0].Angaben["einstieg"] != "openwrt" || n.Schritt != "fassungen" {
		t.Fatalf("neuer Lauf: %+v %+v", es[0].Angaben, n)
	}
}

// Die Sicherheitslinie: abgenommen, gekoppelt, Portal stumm, anderer
// Host-Schlüssel, fertiger Lauf oder kein eigener Lauf - dann nie
// Zurücksetzen, sondern wie bisher „nicht anfassen“.
func TestEingerichteteBoxImLanNieZuruecksetzen(t *testing.T) {
	for name, f := range map[string]struct {
		stand  map[string]portal.BoxStand
		host   func(m *attrappe.Mango) string
		bis    []string
		ohne   bool // kein Lauf im Protokoll
		grund  string
		keiner bool // gar kein Lauf, nur der Satz am Anschluss
	}{
		"abgenommen":   {stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3", Abgenommen: true}}, bis: bisLan, grund: "abgenommen"},
		"gekoppelt":    {stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3", Gekoppelt: true}}, bis: bisLan, grund: "gekoppelt"},
		"Portal stumm": {stand: map[string]portal.BoxStand{}, bis: bisLan, grund: "das Portal sagt nicht"},
		"anderer Host-Schlüssel": {stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3"}}, bis: bisLan,
			host: func(*attrappe.Mango) string { return "SHA256:einanderer" }, grund: "nicht nachweislich dieselbe Box"},
		"fertiger Lauf": {bis: append(append([]string{}, bisLan...), "neustart", "probe", "internet_weg", "uebergabe"), keiner: true},
		"kein Lauf":     {ohne: true, keiner: true},
		"ohne Passwort": {bis: []string{"fassungen", "internet"}, keiner: true},
	} {
		t.Run(name, func(t *testing.T) {
			m := attrappe.NeueMango(t, true)
			m.HalbEingerichtet("10.213.0.1", "unbekannt")
			w := werkbankMit(t, m, &standPortal{stand: f.stand})
			host := m.HostOpenWrt()
			if f.host != nil {
				host = f.host(m)
			}
			if !f.ohne {
				halberLauf(t, w.ablage, m.MAC, host, f.bis...)
			}
			vorher := len(w.laeufe(t))
			ctx := context.Background()
			w.d.Runde(ctx)
			w.d.Runde(ctx)
			if f.keiner {
				if a := w.d.Ansicht(); a.Lauf != nil || !strings.Contains(a.Anschluss, "eingerichtete Box") || len(w.laeufe(t)) != vorher {
					t.Fatalf("%+v", a)
				}
				return
			}
			s := w.bisEnde(t)
			if strings.HasPrefix(s.Handgriff, "Zurücksetzen") || !strings.Contains(s.Grund, f.grund) || !strings.Contains(s.Grund, "nicht zurücksetzen") {
				t.Fatalf("%+v", s)
			}
			if len(m.Befehle()) != 0 {
				t.Fatalf("an der Box ausgeführt: %v", m.Befehle())
			}
		})
	}
}

// Lauf 2026-11-05-114050-9ef8 nachgestellt: Der Status kommt über die offene
// Sitzung, eine neue Verbindung zur Brücke nicht. Früher begann der Lauf und
// hielt nach einer Minute an; jetzt beginnt keiner, die Seite nennt die Brücke.
func TestBrueckeNichtErreichbarBeginntKeinenLauf(t *testing.T) {
	m := attrappe.NeueMango(t, false)
	w := werkbankMit(t, m, nil)
	ctx := context.Background()
	w.d.Runde(ctx)
	w.b.NeueAbweisen()
	for i := 0; i < 2; i++ {
		w.spaeter(dienst.StartFrist)
		w.d.Runde(ctx)
	}
	a := w.d.Ansicht()
	if a.Lauf != nil || a.AnschlussFall != "bruecke_nicht_bereit" || a.AnschlussLoesung == nil || !strings.Contains(a.Anschluss, "nicht erreichbar") {
		t.Fatalf("%+v %s", a.Lauf, a.Anschluss)
	}
	if n := w.laeufe(t); len(n) != 0 {
		t.Fatalf("Läufe: %v", n)
	}
}
