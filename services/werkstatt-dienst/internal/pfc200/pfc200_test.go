package pfc200_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/pfc200"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// Die Skripte rufen "ssh" auf: das ist dann dieses Testprogramm (Durchreiche).
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "ssh" {
		os.Exit(durchreiche.Shim(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

// Die Zeiten der Tests: ein kurzer Takt, aber großzügige Fristen. Eine Frist
// begrenzt nur den Fehlerfall; im guten Fall endet jedes Warten mit dem
// Zustand, auf den es wartet. Knappe Fristen ließen die Tests unter Last
// wackeln (ein Test, der eine Frist wirklich ablaufen lässt, setzt sie selbst).
var kurz = pfc200.Zeiten{Takt: 20 * time.Millisecond, Verbinden: 20 * time.Second, Neustart: 2 * time.Minute, Netz: time.Minute, Programm: time.Minute,
	Tunnel: time.Minute, Schalter: 2 * time.Minute, SSHDienst: 2 * time.Minute, Firewall: 2 * time.Minute}

// testFrist begrenzt einen ganzen Lauf im Test (nur der Fehlerfall erreicht sie).
const testFrist = 10 * time.Minute

const fassung = "edge-industrie-2026.11.1"

var geheimCode = geheim.Neu("K7M2-XQ3P-9RTV")

type aufbau struct {
	p      *attrappe.PFC200
	b      *attrappe.Bruecke
	k      pfc200.Konfig
	f      freigabe.Freigabe
	id     *age.X25519Identity
	ablage *protokoll.Ablage
	r      *lauf.Laeufer
	log    *bytes.Buffer
	// ohneManifest: das Release trägt kein release.json.
	ohneManifest bool
	// manifestStatt ersetzt das Manifest des Release (mit seiner Signatur).
	manifestStatt, signaturStatt                 []byte
	manifestOhneTunnel, signaturOhneTunnel       []byte
	manifestAnderesTunnel, signaturAnderesTunnel []byte
}

func summe(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func neu(t *testing.T) *aufbau {
	t.Helper()
	a := &aufbau{log: &bytes.Buffer{}}
	log := logs.Neu(a.log, "json", nil)
	imager := attrappe.Schluessel(t)
	a.b = attrappe.NeueBruecke(t, imager.PublicKey())
	a.p = attrappe.NeuerPFC200(t)
	var ziele []netip.AddrPort
	for _, z := range []string{"192.168.1.17:22", "10.213.0.1:22", "10.213.0.1:8484", "10.213.0.1:502"} {
		ziele = append(ziele, netip.MustParseAddrPort(z))
	}
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: a.b.Adresse, HostDatei: filepath.Join(t.TempDir(), "h.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24"), netip.MustParsePrefix("10.213.0.2/24")},
		Ziele:             ziele, SSHQuellen: []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")}, Zeitlimit: 30 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	if _, _, err := wb.Bereit(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.b.AntwortenFunc, a.b.ZielFunc = a.p.Antworten, a.p.Ziel

	programm := []byte("\x7fELF vp-edge-industrie attrappe")
	tunnel := []byte("\x7fELF vp-wartung attrappe")
	skripte := attrappe.SkripteTarGzPFC200(t)
	manifest := attrappe.ManifestPFC200(fassung, 77, summe(programm), "industrie", summe(skripte), summe(tunnel))
	wurzel := attrappe.NeueSignierteWurzel(t)
	signatur := wurzel.SigniereManifest(t, manifest)
	a.manifestOhneTunnel = attrappe.ManifestPFC200(fassung, 77, summe(programm), "industrie", summe(skripte), "")
	a.signaturOhneTunnel = wurzel.SigniereManifest(t, a.manifestOhneTunnel)
	a.manifestAnderesTunnel = attrappe.ManifestPFC200(fassung, 77, summe(programm), "industrie", summe(skripte), strings.Repeat("0", 64))
	a.signaturAnderesTunnel = wurzel.SigniereManifest(t, a.manifestAnderesTunnel)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/edge/trust-set/trust-set.json":
			_, _ = w.Write(wurzel.TrustSet)
		case "/api/v1/edge/trust-set/trust-set.json.sig":
			_, _ = w.Write(wurzel.TrustSetSig)
		case "/edge/release.json", "/edge/release.json.sig":
			m, s := manifest, signatur
			if a.manifestStatt != nil {
				m, s = a.manifestStatt, a.signaturStatt
			}
			if a.ohneManifest {
				http.NotFound(w, r)
			} else if strings.HasSuffix(r.URL.Path, ".sig") {
				_, _ = w.Write(s)
			} else {
				_, _ = w.Write(m)
			}
		case "/edge/" + fassungen.IndustrieProgramm:
			_, _ = w.Write(programm)
		case "/edge/" + fassungen.IndustrieSkripteDatei:
			_, _ = w.Write(skripte)
		case "/edge/" + fassungen.WartungProgramm:
			_, _ = w.Write(tunnel)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	a.f = freigabe.Freigabe{Schema: freigabe.Schema, Kennung: "2026-11-pfc200-1", BoxArt: freigabe.PFC200, ErteiltVon: "Test",
		ErteiltAm: time.Now().Add(-time.Hour), GueltigBis: time.Now().Add(24 * time.Hour), Obergrenze: 5,
		EdgeIndustrie: freigabe.Industrie{Fassung: fassung, Quelle: srv.URL + "/edge/", ProgrammSha256: summe(programm), SkripteSha256: summe(skripte), WartungSha256: summe(tunnel)},
	}
	a.id, _ = age.GenerateX25519Identity()
	a.ablage, _ = protokoll.NeueAblage(filepath.Join(t.TempDir(), "laeufe"))
	a.r = lauf.NeuerLaeufer(a.ablage, log, metriken.Neu())
	arbeit, err := os.MkdirTemp("/tmp", "vpw-") // kurz: Pfade von Unix-Sockets höchstens 104 Zeichen (macOS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(arbeit) })
	a.k = pfc200.Konfig{
		Werkbank: wb, Fassungen: &fassungen.Ablage{Dir: filepath.Join(t.TempDir(), "fassungen"), Client: srv.Client(), Wurzel: wurzel.Wurzel},
		Arbeit: arbeit, LanNetz: netip.MustParsePrefix("10.213.0.1/24"), LanBruecke: netip.MustParseAddr("10.213.0.2"),
		DNS: []netip.Addr{netip.MustParseAddr("9.9.9.9"), netip.MustParseAddr("1.1.1.1")}, Zeitserver: []string{"ptbtime1.ptb.de", "ptbtime2.ptb.de"},
		Notfall:    rsaZeile(t) + " voltpilot-notfall",
		Empfaenger: a.id.Recipient(), WartungPub: "c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU=",
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Zeiten: kurz, Log: log, PortalURL: srv.URL,
	}
	return a
}

// rsaZeile ist ein öffentlicher RSA-Schlüssel als authorized_keys-Zeile (der
// SSH-Dienst des PFC200 nimmt kein Ed25519).
func rsaZeile(t *testing.T) string {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ssh.NewPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
}

// fahre führt einen Lauf aus und liefert die Eingaben, auf die er wartet.
func (a *aufbau) fahre(t *testing.T, e pfc200.Einstieg) (*lauf.Lauf, lauf.Zustand) {
	t.Helper()
	l := lauf.Neu(time.Now(), a.f.Kennung, freigabe.PFC200)
	pl, err := pfc200.NeuerLauf(a.k, a.f, l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Schliesse()
	ctx, cancel := context.WithTimeout(context.Background(), testFrist)
	defer cancel()
	fertig := make(chan lauf.Zustand, 1)
	go func() { fertig <- a.r.Fahre(ctx, l, nil, pl.Schritte(e)) }()
	for {
		select {
		case z := <-fertig:
			return l, z
		case <-time.After(10 * time.Millisecond):
			switch s := l.Stand(); {
			case s.Zustand == lauf.Wartet && s.WartetAuf == "tunnel_adresse":
				_ = l.Gib(ctx, "tunnel_adresse", "10.10.16.5")
			case s.Zustand == lauf.Wartet && s.WartetAuf == "probe":
				_ = l.Gib(ctx, "probe", "erledigt")
			}
		}
	}
}

func (a *aufbau) belege(t *testing.T, l *lauf.Lauf) map[string]protokoll.Beleg {
	t.Helper()
	es, err := a.ablage.Lies(l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]protokoll.Beleg{}
	for _, e := range es {
		if e.Art == protokoll.SchrittBelegt || e.Art == protokoll.SchrittGescheitert {
			out[e.Schritt] = e.Beleg
		}
	}
	return out
}

// protokollRoh ist das Protokoll des Laufs, wie es auf der Platte steht.
func (a *aufbau) protokollRoh(t *testing.T, l *lauf.Lauf) string {
	t.Helper()
	es, err := a.ablage.Lies(l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	roh, err := json.Marshal(es)
	if err != nil {
		t.Fatal(err)
	}
	return string(roh)
}

func wert(t *testing.T, b protokoll.Beleg, name string) string {
	t.Helper()
	v, ok := b.Wert(name)
	if !ok {
		t.Fatalf("Beleg ohne %s: %v", name, b)
	}
	return v
}

func (a *aufbau) entschluessle(t *testing.T, text string) string {
	t.Helper()
	r, err := age.Decrypt(armor.NewReader(strings.NewReader(text)), a.id)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r)
	return string(b)
}

// Ein ganzer Lauf ab Werk ohne API: vom Erkennen bis zu den Belegen für die
// Abnahme. Danach steht das Gerät so da, wie es ausgeliefert wird.
func TestLaufAbWerk(t *testing.T) {
	t.Parallel()
	a := neu(t)
	// Ein fremder Schlüssel, der ab Werk schon da ist, darf nicht bleiben.
	a.p.SchreibeDatei("/root/.ssh/authorized_keys", rsaZeile(t)+" fremd\n")
	// Reste eines früheren Laufs, die ein Werksreset stehen ließ.
	a.p.SchreibeDatei("/home/voltpilot/daten/geraeteschluessel-alt", "alt\n")
	l, z := a.fahre(t, pfc200.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s im Schritt %s: %s\nBeleg: %v\nAufrufe:\n%s", z, l.Stand().Schritt, l.Stand().Grund, a.belege(t, l)[l.Stand().Schritt], strings.Join(a.p.Aufrufe(), "\n"))
	}
	b := a.belege(t, l)
	for _, s := range []string{"erkennen", "docker", "fassungen", "internet", "zugaenge", "notfall", "programm", "tunnel_schluessel", "tunnel_adresse", "tunnel", "netze", "neustart", "probe", "internet_weg", "uebergabe"} {
		if b[s].Leer() {
			t.Errorf("Schritt %s ohne Beleg", s)
		}
	}
	// Kein Schritt und keine Prüfung für SPS oder Firmware.
	for _, s := range l.Stand().Erledigt {
		if strings.Contains(s, "sps") || strings.Contains(s, "koppel") || strings.Contains(s, "firmware") {
			t.Errorf("Schritt %s gehört nicht in den Lauf", s)
		}
	}
	if fw := wert(t, b["erkennen"], "firmware"); fw != "03.10.08(22)" {
		t.Errorf("Firmware im Beleg %q", fw)
	}

	if a.p.Datei("/home/voltpilot/daten/geraeteschluessel-alt") != "" || !strings.Contains(wert(t, b["programm"], "reste"), "entfernt") {
		t.Error("die Reste eines früheren Laufs sind noch da")
	}
	if strings.TrimSpace(a.p.Datei("/home/voltpilot/daten/ref")) != "edge-k7m2xq3" {
		t.Errorf("Referenz auf dem Gerät: %q", a.p.Datei("/home/voltpilot/daten/ref"))
	}

	// Zugänge: drei Passwörter, nur verschlüsselt; das Gerät nimmt sie an, die ab Werk nicht.
	klar := a.entschluessle(t, wert(t, b["zugaenge"], "passwort_age"))
	zeilen := strings.Split(strings.TrimSpace(klar), "\n")
	if len(zeilen) != 3 {
		t.Fatalf("entschlüsselt %d Zeilen", len(zeilen))
	}
	for i, u := range []string{"root", "admin", "user"} {
		name, pw, ok := strings.Cut(zeilen[i], ": ")
		if !ok || name != u || len(pw) != 24 {
			t.Fatalf("Zeile %d: Benutzer %q", i, name)
		}
		if !a.p.NimmtAn(u, pw) {
			t.Errorf("das Gerät nimmt das neue Passwort von %s nicht an", u)
		}
		for _, wo := range []string{a.log.String(), strings.Join(a.p.Befehle(), "\n"), strings.Join(a.p.Aufrufe(), "\n"), a.protokollRoh(t, l)} {
			if strings.Contains(wo, pw) {
				t.Errorf("das Passwort von %s steht im Klartext in Log, Befehlen, Aufrufen oder Protokoll", u)
			}
		}
	}
	if a.p.NimmtAn("root", "wago") || a.p.NimmtAn("admin", "wago") || a.p.NimmtAn("user", "user") {
		t.Error("ein Werkspasswort gilt noch")
	}
	if a.p.Lies("ssh/password-request-state") != "disabled" {
		t.Error("Anmeldung mit Passwort nicht aus")
	}

	// Dauerhaft bleibt genau der Notfall-Schlüssel.
	keys := strings.TrimSpace(a.p.Datei("/root/.ssh/authorized_keys"))
	if strings.Count(keys, "\n") != 0 || !strings.HasSuffix(keys, "voltpilot-notfall") {
		t.Errorf("dauerhafte Schlüssel am Ende: %q", keys)
	}

	// Netze, Firewall, Uhr, Start.
	if a.p.Lies("netz/bruecken") != `{"br0":["X1"],"br1":["X2"]}` || a.p.Lies("netz/ip.br1") != "static 10.213.0.1 255.255.255.0" || a.p.Lies("netz/ip.br0") != "" {
		t.Errorf("Netze: %q %q %q", a.p.Lies("netz/bruecken"), a.p.Lies("netz/ip.br1"), a.p.Lies("netz/ip.br0"))
	}
	if a.p.Lies("fw/an") != "enabled" || a.p.Lies("boot/intern") != "enabled" || a.p.Lies("ntp/state") != "enabled" {
		t.Errorf("Firewall %q, Start intern %q, Zeitabgleich %q", a.p.Lies("fw/an"), a.p.Lies("boot/intern"), a.p.Lies("ntp/state"))
	}
	for _, d := range []string{"ssh", "https", "http", "codesysr", "codesysw", "modbus_tcp", "opcua", "ftp", "iocheck", "snmp"} {
		if a.p.Lies("fw/dienst/"+d+"/br0") != "off" {
			t.Errorf("Dienst %s am Kundennetz nicht zu", d)
		}
		soll := "off"
		if d == "ssh" || d == "https" || d == "codesysr" {
			soll = "on"
		}
		if a.p.Lies("fw/dienst/"+d+"/br1") != soll {
			t.Errorf("Dienst %s am Anlagennetz: %q, Soll %s", d, a.p.Lies("fw/dienst/"+d+"/br1"), soll)
		}
	}
	if v := a.p.Lies("uhr/versatz"); v != "0" {
		t.Errorf("Uhr nicht gestellt (Versatz %s)", v)
	}
	// Das Werkstatt-Internet ist wieder heraus.
	if a.p.Lies("gw/1.state") != "disabled" || a.p.Lies("dns") != "" {
		t.Errorf("Werkstatt-Internet steht noch: %q %q", a.p.Lies("gw/1.state"), a.p.Lies("dns"))
	}

	// Die Belege für die Abnahme: je Prüfung einer, dazu die Sätze für den Betreiber.
	u := b["uebergabe"]
	for _, p := range pfc200.Pruefungen {
		if wert(t, u, "pruefung_"+p) == "" {
			t.Errorf("Prüfung %s ohne Beleg", p)
		}
	}
	if !strings.Contains(wert(t, u, "zugaenge"), "Box-Passwörter") || !strings.Contains(wert(t, u, "zugaenge"), "admin") || !strings.Contains(wert(t, u, "codesys"), "X2") {
		t.Errorf("Hinweise an der Übergabe: %v", u)
	}
	if !strings.Contains(wert(t, u, "versand"), "Nicht versenden") {
		t.Error("der Satz zum Versand fehlt")
	}
	// Nie angefasst: Docker, die SPS.
	for _, z := range a.p.Aufrufe() {
		if strings.Contains(z, "docker") || strings.Contains(z, "codesys") && !strings.Contains(z, "--set-if") {
			t.Errorf("Aufruf %q", z)
		}
	}
	for _, z := range a.p.Befehle() {
		if strings.Contains(z, "PlcLogic") || strings.Contains(z, "init.d/runtime") || strings.Contains(z, "config_docker") {
			t.Errorf("Befehl fasst die Steuerung an: %q", z)
		}
	}
}

type falschesPortal struct {
	mu          sync.Mutex
	abnahmen    []portal.Abnahme
	geschlossen []string
	codeFuer    []string // für welches Gerät der Dienst einen Code holte
	stand       portal.BoxStand
	standFehler error
}

func (p *falschesPortal) CodeHolenFuer(_ context.Context, ref string, _ bool, geraet string) (portal.Code, error) {
	p.mu.Lock()
	p.codeFuer = append(p.codeFuer, geraet)
	p.mu.Unlock()
	return portal.Code{Code: geheimCode, EdgeRef: ref, Freigabe: "2026-11-pfc200-1", GueltigBis: time.Now().Add(10 * time.Minute)}, nil
}

func (p *falschesPortal) FensterSchliessen(_ context.Context, id string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.geschlossen = append(p.geschlossen, id)
	return false, nil
}

func (p *falschesPortal) AbnahmeSchreiben(_ context.Context, ref string, a portal.Abnahme) (portal.Angenommen, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.abnahmen = append(p.abnahmen, a)
	return portal.Angenommen{ID: "abn-1", EdgeRef: ref, FreigabeID: "f-1", EinloesungID: "e-1"}, nil
}

func (p *falschesPortal) BoxStandLesen(context.Context, string) (portal.BoxStand, error) {
	return p.stand, p.standFehler
}

type falscheProbe struct {
	p      *attrappe.PFC200
	host   string
	server wartung.Server
	ziel   netip.AddrPort
}

func (f *falscheProbe) Fingerabdruck() string { return "SHA256:technikerzugangwerkstattdienst" }

func (f *falscheProbe) Anmelden(_ context.Context, s wartung.Server, ziel netip.AddrPort) (wartung.Anmeldung, error) {
	f.server, f.ziel = s, ziel
	f.p.Protokolliere("Anmeldung: Schluessel " + f.Fingerabdruck() + " (Fenster werkstatt-dienst) von 10.10.32.9")
	return wartung.Anmeldung{HostSchluessel: f.host, Versuche: 1, Dauer: time.Second}, nil
}

func (f *falscheProbe) NachEnde(context.Context, wartung.Server, netip.AddrPort) (string, error) {
	f.p.Protokolliere("Sitzung beendet (Fenster werkstatt-dienst, von 10.10.32.9): Schluessel gestrichen")
	return "Connection timed out (TCP-Aufbau an 10.10.16.7:2222 nach 10s ohne Antwort, Versuch 1)", nil
}

const antwortEinloesung = `{"schema":"vp-werkstatt-einloesung.v1","edgeRef":"edge-k7m2xq3","freigabe":"2026-11-pfc200-1","tunnelErgebnis":"hinterlegt",
"tunnel":{"adresse":"10.10.16.7","serverPublicKey":"c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU=","serverEndpunkt":"wartung.voltpilot.de","serverPort":51820},
"probe":{"fensterId":"fenster-1","technikerName":"Werkstatt-Dienst","ende":"2026-11-20T12:00:00Z"},"geraeteSchluessel":{"sha256":"abc"}}`

// Mit API: Die Box löst den Code selbst ein, der Dienst macht die Probe durch
// den Tunnel und schreibt die Abnahme mit Gerät, Angaben und den drei
// verschlüsselten Passwörtern.
func TestLaufMitApiUndProbeUeberDenTunnel(t *testing.T) {
	t.Parallel()
	a := neu(t)
	ptl := &falschesPortal{}
	a.k.Portal = ptl
	probe := &falscheProbe{p: a.p}
	a.k.Probe = probe
	var code, wg string
	a.p.Anmelden = func(c, w, host string) (string, int) {
		code, wg, probe.host = c, w, host
		return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0
	}
	l, z := a.fahre(t, pfc200.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v\n%s", z, l.Stand(), a.log.String())
	}
	if code != geheimCode.Offenbaren() || wg != a.p.WgPub || probe.host != a.p.Host() {
		t.Fatalf("werkstatt-anmelden bekam Code %v, Schlüssel %q, Host %q", code != "", wg, probe.host)
	}
	for _, z := range a.p.Befehle() {
		if strings.Contains(z, geheimCode.Offenbaren()) {
			t.Fatal("der Einmal-Code steht in einem Befehl")
		}
	}
	if probe.ziel.String() != "10.10.16.7:2222" || probe.server.Endpunkt != "wartung.voltpilot.de:51820" || len(ptl.geschlossen) != 1 {
		t.Fatalf("Probe gegen %+v %s, geschlossen %v", probe.server, probe.ziel, ptl.geschlossen)
	}
	if len(ptl.abnahmen) != 1 {
		t.Fatalf("%d Abnahmen", len(ptl.abnahmen))
	}
	if len(ptl.codeFuer) != 1 || ptl.codeFuer[0] != "pfc200" {
		t.Fatalf("Code geholt für %v, erwartet einmal für pfc200", ptl.codeFuer)
	}
	an := ptl.abnahmen[0]
	if an.Geraet != "pfc200" || an.Angaben["firmware"] != "03.10.08(22)" || an.Angaben["artikel"] != "750-8212" || an.Angaben["seriennummer"] == "" ||
		an.Fassung != fassung || an.HostSchluessel != a.p.Host() || an.LanNetz != "10.213.0.1/24" {
		t.Fatalf("Abnahme %+v", an)
	}
	if len(an.Belege) != len(pfc200.Pruefungen) || !strings.Contains(an.Belege["host_schluessel"], "(gleich)") || !strings.Contains(an.Belege["fenster_zu"], "Connection timed out") {
		t.Fatalf("Belege %v", an.Belege)
	}
	if n := strings.Count(strings.TrimSpace(a.entschluessle(t, an.PasswortAge)), "\n"); n != 2 {
		t.Fatalf("an der Abnahme stehen %d Passwörter", n+1)
	}
	// Was die API an einer Abnahme annimmt (WerkstattService): der age-Text
	// höchstens 4000 Zeichen, höchstens 12 Angaben mit einfachem Namen und
	// höchstens 200 Zeichen, je Beleg höchstens 2000.
	if len(an.PasswortAge) > 4000 {
		t.Fatalf("der age-Text der drei Zugänge hat %d Zeichen, die API nimmt 4000", len(an.PasswortAge))
	}
	if len(an.Angaben) > 12 {
		t.Fatalf("%d Angaben", len(an.Angaben))
	}
	name := regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	for k, v := range an.Angaben {
		if !name.MatchString(k) || len(v) > 200 || strings.Contains(v, "-----BEGIN") {
			t.Fatalf("Angabe %q = %q nimmt die API nicht", k, v)
		}
	}
	for k, v := range an.Belege {
		if len(v) > 2000 || strings.TrimSpace(v) == "" {
			t.Fatalf("Beleg %q hat %d Zeichen", k, len(v))
		}
	}
	if l.Stand().Box != "edge-k7m2xq3" {
		t.Fatalf("Stand nennt die Box nicht: %+v", l.Stand())
	}
}

// halt fährt einen Lauf, der anhalten muss, und gibt Fall und Stand zurück.
func (a *aufbau) halt(t *testing.T, schritt, fall string) lauf.Stand {
	t.Helper()
	l, z := a.fahre(t, pfc200.AbWerk)
	s := l.Stand()
	if z != lauf.Angehalten || s.Schritt != schritt || s.Fall != fall {
		t.Fatalf("Zustand %s, Schritt %s, Fall %s (%s), erwartet %s/%s\n%s", z, s.Schritt, s.Fall, s.Grund, schritt, fall, a.log.String())
	}
	if s.Loesung == nil || len(s.Loesung.Schritte) == 0 {
		t.Fatalf("Fall %s ohne Lösung", fall)
	}
	return s
}

// unveraendert: Der Lauf hat am Gerät nichts geändert.
func (a *aufbau) unveraendert(t *testing.T) {
	t.Helper()
	if z := a.p.Lies("aufrufe"); z != "" {
		t.Fatalf("das Gerät wurde geändert:\n%s", z)
	}
	if !a.p.NimmtAn("root", "wago") {
		t.Fatal("das Werkspasswort von root gilt nicht mehr")
	}
}

func TestErkennenHaeltAnOhneZuAendern(t *testing.T) {
	t.Parallel()
	t.Run("kein 750-8212", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.Setze("artikel", "750-8100")
		s := a.halt(t, "erkennen", faelle.PFCFalschesGeraet)
		a.unveraendert(t)
		if !s.Loesung.ZurSeite {
			t.Fatal("nicht zur Seite")
		}
	})
	t.Run("schon Edge Industrie", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.SchreibeDatei("/etc/init.d/vp-edge-industrie", "#!/bin/sh\n")
		a.halt(t, "erkennen", faelle.PFCSchonEingerichtet)
		a.unveraendert(t)
	})
	t.Run("Notfall-Schlüssel Ed25519", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.k.Notfall = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey())))
		s := a.halt(t, "erkennen", faelle.PFCNotfallSchluessel)
		a.unveraendert(t)
		if !strings.Contains(s.Grund, "RSA und ECDSA") {
			t.Fatalf("Grund %q", s.Grund)
		}
	})
	t.Run("ein Passwort nicht mehr ab Werk", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.Setze("benutzer/admin.hash", "$6$fremd$"+strings.Repeat("a", 86))
		a.halt(t, "erkennen", faelle.PasswortFremd)
		if z := a.p.Lies("aufrufe"); z != "" {
			t.Fatalf("das Gerät wurde geändert:\n%s", z)
		}
	})
	t.Run("Werkspasswort abgewiesen, fremdes Gerät", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.k.Spuren = a.ablage
		a.p.Setze("benutzer/root.hash", "$6$fremd$"+strings.Repeat("a", 86))
		s := a.halt(t, "erkennen", faelle.PasswortFremd)
		if strings.Contains(s.Handgriff, "Werksreset") || !s.Loesung.ZurSeite {
			t.Fatalf("ein fremdes Gerät darf niemand zurücksetzen: %q", s.Handgriff)
		}
	})
}

// erkennenBisZumWarten startet den Schritt erkennen und wartet, bis der Lauf
// mit dem Fall wartet. Gewartet wird auf den Zustand, nicht auf eine Zeit:
// Die Schleife endet, wenn der Lauf wartet, wenn er vorher endet (dann ist
// der Test gescheitert) oder mit der Frist des ganzen Tests. Wie lange
// erkennen bis dahin braucht, spielt keine Rolle.
func (a *aufbau) erkennenBisZumWarten(t *testing.T, fall string) (*lauf.Lauf, <-chan lauf.Zustand, lauf.Stand) {
	t.Helper()
	l := lauf.Neu(time.Now(), a.f.Kennung, freigabe.PFC200)
	pl, err := pfc200.NeuerLauf(a.k, a.f, l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testFrist)
	t.Cleanup(func() { cancel(); pl.Schliesse() })
	fertig := make(chan lauf.Zustand, 1)
	go func() { fertig <- a.r.Fahre(ctx, l, nil, pl.Schritte(pfc200.AbWerk)[:1]) }()
	takt := time.NewTicker(5 * time.Millisecond)
	defer takt.Stop()
	for {
		select {
		case z := <-fertig:
			t.Fatalf("der Lauf endete (%s), ohne mit %s zu warten: %+v\n%s", z, fall, l.Stand(), a.log.String())
		case <-ctx.Done():
			t.Fatalf("der Lauf wartet nach %s nicht mit %s: %+v\n%s", testFrist, fall, l.Stand(), a.log.String())
		case <-takt.C:
			if s := l.Stand(); s.Zustand == lauf.Wartet && s.Fall == fall {
				return l, fertig, s
			}
		}
	}
}

// Läuft Docker, schaltet der Schritt docker ihn mit dem Werkzeug der Firmware
// aus, statt anzuhalten; fremde Container fasst er dabei nie an.
func TestDockerAusschalten(t *testing.T) {
	t.Parallel()
	t.Run("läuft mit fremden Containern: wird ausgeschaltet, Container bleiben stehen", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.Setze("docker/install", "installed")
		a.p.Setze("docker/aktiv", "active")
		a.p.Setze("docker/laeuft", "1")
		a.p.Setze("docker/container", "mqttbroker\teclipse-mosquitto:2\tUp 3 days\nnanoclient\tubirch/ubirch-client:latest\tUp 3 days")
		l, z := a.fahre(t, pfc200.AbWerk)
		if z != lauf.Fertig {
			t.Fatalf("Zustand %s im Schritt %s: %s\n%s", z, l.Stand().Schritt, l.Stand().Grund, a.log.String())
		}
		b := a.belege(t, l)
		if v := wert(t, b["docker"], "container_vorher"); !strings.Contains(v, "mqttbroker") || !strings.Contains(v, "nanoclient") {
			t.Fatalf("Container vor dem Ausschalten im Beleg: %q", v)
		}
		if v := wert(t, b["docker"], "docker_nachher"); !strings.Contains(v, "inactive") {
			t.Fatalf("Docker-Stand nachher im Beleg: %q", v)
		}
		var dockerAufrufe []string
		for _, z := range a.p.Aufrufe() {
			if strings.Contains(z, "docker") {
				dockerAufrufe = append(dockerAufrufe, z)
			}
		}
		// Genau "config_docker deactivate": nie "remove" oder "install" (die
		// laut Firmware-Quelltext das Paket deinstallieren und /home/docker
		// löschen) und nie "activate" (das wäre das Gegenteil).
		if len(dockerAufrufe) != 1 || !strings.HasSuffix(strings.TrimSpace(dockerAufrufe[0]), "config_docker deactivate") {
			t.Fatalf("Docker-Aufrufe: %v, erwartet genau einen (config_docker deactivate)", dockerAufrufe)
		}
		// Die Container selbst stehen der Attrappe nach weiter, der Dienst hat sie nie gelöscht.
		if a.p.Lies("docker/container") == "" {
			t.Error("die Containerliste der Attrappe ist weg: der Dienst darf keinen Container anfassen")
		}
	})

	t.Run("läuft ohne Container: wird trotzdem ausgeschaltet", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.Setze("docker/install", "installed")
		a.p.Setze("docker/aktiv", "active")
		a.p.Setze("docker/laeuft", "1")
		l, z := a.fahre(t, pfc200.AbWerk)
		if z != lauf.Fertig {
			t.Fatalf("Zustand %s im Schritt %s: %s\n%s", z, l.Stand().Schritt, l.Stand().Grund, a.log.String())
		}
		b := a.belege(t, l)
		if v := wert(t, b["docker"], "container_vorher"); v != "keine" {
			t.Fatalf("Container vor dem Ausschalten im Beleg: %q", v)
		}
	})

	t.Run("schon aus: der Dienst ändert nichts", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		l, z := a.fahre(t, pfc200.AbWerk)
		if z != lauf.Fertig {
			t.Fatalf("Zustand %s im Schritt %s: %s\n%s", z, l.Stand().Schritt, l.Stand().Grund, a.log.String())
		}
		b := a.belege(t, l)
		if v := wert(t, b["docker"], "docker"); !strings.Contains(v, "schon aus") {
			t.Fatalf("Beleg docker: %q", v)
		}
		for _, z := range a.p.Aufrufe() {
			if strings.Contains(z, "docker") {
				t.Errorf("Aufruf %q, obwohl Docker schon aus war", z)
			}
		}
	})

	t.Run("Ausschalten scheitert: der Lauf hält mit pfc_docker_an an, nichts gelöscht", func(t *testing.T) {
		t.Parallel()
		a := neu(t)
		a.p.Setze("docker/install", "installed")
		a.p.Setze("docker/aktiv", "active")
		a.p.Setze("docker/laeuft", "1")
		a.p.Setze("docker/scheitert", "1")
		s := a.halt(t, "docker", faelle.PFCDockerAn)
		if !strings.Contains(s.Grund, "Docker") {
			t.Fatalf("Grund: %q", s.Grund)
		}
		if a.p.Lies("docker/aktiv") != "active" {
			t.Error("Docker steht nach dem gescheiterten Ausschalten nicht mehr als aktiv")
		}
		if !a.p.NimmtAn("root", "wago") {
			t.Error("das Werkspasswort von root gilt nicht mehr, obwohl der Lauf beim Schritt docker angehalten hat")
		}
	})
}

// Der Schalter steht nach dem Handgriff „feste Adresse“ noch auf STOP: Der
// Lauf zeigt den Fall, wartet und macht von selbst weiter.
func TestErkennenWartetAufDenSchalter(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.p.Setze("schalter", "stop")
	l, fertig, s := a.erkennenBisZumWarten(t, faelle.PFCSchalterStop)
	if s.WartetAuf != "schalter_run" || s.Loesung == nil || !s.Loesung.Selbst || !strings.Contains(s.Loesung.Schritte[0], "RUN") {
		t.Fatalf("Stand beim Warten: %+v", s)
	}
	// Solange der Schalter auf STOP steht, bleibt der Lauf im Warten.
	if z := l.Stand().Zustand; z != lauf.Wartet {
		t.Fatalf("Zustand %s, obwohl der Schalter noch auf STOP steht", z)
	}
	a.p.Setze("schalter", "run")
	if z := <-fertig; z != lauf.Fertig || l.Stand().Fall != "" {
		t.Fatalf("Zustand %s, Fall %q: %+v", z, l.Stand().Fall, l.Stand())
	}
	a.unveraendert(t)
}

// Das Kabel steckt in X1: Der Lauf wartet, bis es in X2 steckt. Nach dem
// Trennen der Buchsen wäre das Gerät an X1 sonst weg.
func TestErkennenWartetAufDasKabelInX2(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.p.Setze("netz/kabel", "X1")
	l, fertig, s := a.erkennenBisZumWarten(t, faelle.PFCKabelX1)
	if s.WartetAuf != "kabel_x2" || s.Loesung == nil || !s.Loesung.Selbst || !strings.Contains(s.Loesung.Schritte[0], "X2") {
		t.Fatalf("Stand beim Warten: %+v", s)
	}
	a.p.Setze("netz/kabel", "X2")
	if z := <-fertig; z != lauf.Fertig || l.Stand().Fall != "" {
		t.Fatalf("Zustand %s, Fall %q: %+v", z, l.Stand().Fall, l.Stand())
	}
	a.unveraendert(t)
}

// Ohne Weg ins Internet hält der Lauf an, bevor ein Zugang geändert ist.
func TestKeinInternetHaeltVorDenZugaengenAn(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.p.Setze("internet", "nein")
	// Dieser Test lässt die Frist für das Netz wirklich ablaufen: kurz.
	a.k.Zeiten.Netz = 2 * time.Second
	a.halt(t, "internet", faelle.KeinInternet)
	if !a.p.NimmtAn("root", "wago") || a.p.Lies("ssh/password-request-state") == "disabled" {
		t.Fatal("ein Zugang wurde geändert")
	}
}

// Produktion lässt VP_WERKSTATT_PORTAL_URL leer und setzt VP_WERKSTATT_API_URL
// auf die Portal-API im Cluster: konfig.Lies lässt PortalURL dann auf diese
// Adresse zurückfallen (Fehlerbild kein_internet, 25.11.2026: Standardweg über
// die Brücke stand, curl scheiterte mit "Could not resolve host:
// api.voltpilot-prod.svc.cluster.local"). l.k.PortalURL ist genau diese
// Adresse, über die der DIENST SELBST sein Vertrauens-Set lädt (hier der
// Testserver srv, wie neu() ihn setzt - stünde in Produktion für die nur im
// Cluster aufgelöste Portal-API). Das Gerät hinter der Werkbank-Brücke kann
// so eine Adresse nie auflösen: Der Internet-Check und das dauerhaft
// eingespielte portal_url müssen immer die öffentliche, vom Gerät aus
// erreichbare Adresse verwenden (GeraetPortalURL, hier ihre Vorgabe), nie die
// des Dienstes im Cluster.
func TestInternetUndEingespieltesPortalSindNieDieClusterAdresseDesDienstes(t *testing.T) {
	t.Parallel()
	a := neu(t)
	// a.k.PortalURL ist bereits srv.URL (neu()): die Adresse, über die der
	// Dienst selbst das Vertrauens-Set lädt. a.k.GeraetPortalURL bleibt leer:
	// Dann gilt für das Gerät die Vorgabe https://portal.voltpilot.de.
	l, z := a.fahre(t, pfc200.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s im Schritt %s: %s", z, l.Stand().Schritt, l.Stand().Grund)
	}
	clusterAdresse := strings.TrimPrefix(strings.TrimPrefix(a.k.PortalURL, "https://"), "http://")
	for _, c := range a.p.Befehle() {
		if strings.Contains(c, clusterAdresse) {
			t.Errorf("Befehl ans Gerät nennt die Adresse des Dienstes im Cluster (%s): %q", clusterAdresse, c)
		}
	}
	var internetBefehl string
	for _, c := range a.p.Befehle() {
		if strings.Contains(c, "/api/v1/edge/trust-set/trust-set.json") {
			internetBefehl = c
		}
	}
	if !strings.Contains(internetBefehl, "https://portal.voltpilot.de/api/v1/edge/trust-set/trust-set.json") {
		t.Fatalf("der Internet-Check zielt nicht auf das öffentliche Portal: %q", internetBefehl)
	}
	if konfig := a.p.Datei("/home/voltpilot/konfig"); !strings.Contains(konfig, "portal_url = https://portal.voltpilot.de") {
		t.Fatalf("das eingespielte portal_url auf der Box: %q", konfig)
	}
}

// Eine nicht signierte Fassung richtet der Dienst auf einem PFC200 gar nicht
// erst ein: Der Lauf hält an, bevor sich am Gerät etwas ändert.
func TestNichtSignierteFassungWirdNichtEingerichtet(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.ohneManifest = true
	s := a.halt(t, "fassungen", faelle.FassungNichtBereit)
	if !strings.Contains(s.Grund, "nicht signiert") {
		t.Fatalf("Grund %q", s.Grund)
	}
	a.unveraendert(t)
}

// Das Gerät meldet nach dem Einspielen nicht den bestätigten Stand der
// Fassung: eingerichtet, aber keine Abnahme (Entscheid 5c).
func TestNichtUpdateBereitBekommtKeineAbnahme(t *testing.T) {
	t.Parallel()
	a := neu(t)
	ptl := &falschesPortal{}
	a.k.Portal = ptl
	a.k.Probe = &falscheProbe{p: a.p, host: a.p.Host()}
	a.p.Anmelden = func(string, string, string) (string, int) { return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0 }
	a.p.BestaetigterStand = 0
	s := a.halt(t, "uebergabe", faelle.NichtUpdateBereit)
	if len(ptl.abnahmen) != 0 || !strings.Contains(s.Grund, "nicht update-bereit") {
		t.Fatalf("Abnahmen %d, Grund %q", len(ptl.abnahmen), s.Grund)
	}
}

// Das Tunnel-Programm läuft als root und öffnet den Fernzugang: Seine
// Prüfsumme muss im SIGNIERTEN Manifest stehen und zur Freigabe passen, sonst
// hält der Lauf an, bevor irgendetwas auf das Gerät geht.
func TestTunnelProgrammNurAusDemSigniertenManifest(t *testing.T) {
	t.Parallel()
	for name, waehle := range map[string]func(a *aufbau){
		"Manifest ohne Tunnel-Programm":        func(a *aufbau) { a.manifestStatt, a.signaturStatt = a.manifestOhneTunnel, a.signaturOhneTunnel },
		"Manifest mit anderem Tunnel-Programm": func(a *aufbau) { a.manifestStatt, a.signaturStatt = a.manifestAnderesTunnel, a.signaturAnderesTunnel },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			a := neu(t)
			waehle(a)
			s := a.halt(t, "fassungen", faelle.FassungNichtBereit)
			if !strings.Contains(s.Grund, "Tunnel-Programm") {
				t.Fatalf("Grund %q", s.Grund)
			}
			a.unveraendert(t)
		})
	}
}

// Halb eingerichtet: Ein Lauf dieser Werkstatt hat die Zugänge gesetzt und
// nicht übergeben. Steckt das Gerät wieder an (unter der festen Adresse, das
// Werkspasswort abgewiesen), nennt der Dienst den Werksreset; für ein fremdes
// Gerät nie.
func TestHalbEingerichtetNenntDenWerksreset(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.k.Spuren = a.ablage
	// Der erste Lauf scheitert nach den Zugängen (die Fassung meldet eine andere Version).
	a.p.Version = "edge-industrie-2026.10.9"
	a.halt(t, "programm", faelle.SchrittGescheitert)
	if a.p.NimmtAn("root", "wago") {
		t.Fatal("der erste Lauf hat die Zugänge nicht gesetzt")
	}
	// Neu angesteckt: derselbe Host-Schlüssel, dieselbe MAC.
	s := a.halt(t, "erkennen", faelle.PFCPasswort)
	if !strings.HasPrefix(s.Handgriff, "Werksreset:") || !s.Loesung.Selbst || s.Vorher == nil || !s.Vorher.Ersetzt {
		t.Fatalf("Handgriff %q, Lösung %+v, vorher %+v", s.Handgriff, s.Loesung, s.Vorher)
	}
	text := strings.Join(s.Loesung.Schritte, " ")
	for _, w := range []string{"RESET", "rot und grün", "STOP", "8 Sekunden", "RUN", "192.168.1.17"} {
		if !strings.Contains(text, w) {
			t.Errorf("die Lösung nennt %q nicht: %s", w, text)
		}
	}
}

// Die Probe über den Tunnel scheitert am Host-Schlüssel: keine Abnahme.
func TestAndererHostSchluesselImTunnelHaeltAn(t *testing.T) {
	t.Parallel()
	a := neu(t)
	ptl := &falschesPortal{}
	a.k.Portal = ptl
	a.k.Probe = &falscheProbe{p: a.p, host: "SHA256:einanderesgeraet"}
	a.p.Anmelden = func(string, string, string) (string, int) { return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0 }
	s := a.halt(t, "probe", faelle.SchrittGescheitert)
	if !strings.Contains(s.Grund, "zwei verschiedene Geräte") || len(ptl.abnahmen) != 0 {
		t.Fatalf("Grund %q, Abnahmen %d", s.Grund, len(ptl.abnahmen))
	}
}
