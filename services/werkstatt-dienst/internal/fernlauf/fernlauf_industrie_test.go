package fernlauf_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fernlauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// Ein Fernlauf an einem WAGO PFC200 (Edge Industrie): dieselben Schritte wie
// an der Mango, gegen die Attrappe „PFC200“ mit echtem sh im Sandkasten. Die
// Skripte des Skriptstands sind Attrappen (die echten install.sh und
// fernlauf.sh prüft edge-industrie/test/fernlauf-probe.sh im Container).

const (
	altI = "edge-industrie-2026.11.5"
	neuI = "edge-industrie-2026.11.15"
)

type aufbauI struct {
	pfc *attrappe.PFC200
	p   *portalAttrappe
	d   *fernlauf.Dienst
	log *bytes.Buffer
}

type optionenI struct {
	ohneFernlaufSkript bool
	laeuft             string // Fassung, die die Box vor dem Lauf meldet (Vorgabe altI)
}

func baueIndustrie(t *testing.T, o optionenI) *aufbauI {
	t.Helper()
	if o.laeuft == "" {
		o.laeuft = altI
	}
	// Der Techniker-Zugang ist RSA (das Portal nimmt nur RSA an).
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	techniker, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	pfc := attrappe.NeuerPFC200ImFeld(t, ref, o.laeuft, 5, techniker.PublicKey())
	prog := attrappe.ProgrammPFC200(neuI)
	skripte := attrappe.SkripteTarGzPFC200(t)
	if o.ohneFernlaufSkript {
		skripte = attrappe.SkripteTarGzPFC200OhneFernlauf(t)
	}
	kette := attrappe.NeueSignierteWurzel(t)
	// Ein Manifest wie aus dem Release-Lauf: linux/arm, Linie industrie,
	// Skriptstand und Tunnel-Programm als eigene Felder.
	manifest := attrappe.ManifestPFC200(neuI, 6, summe(prog), "industrie", summe(skripte), strings.Repeat("7", 64))
	msig := kette.SigniereManifest(t, manifest)

	daten, err := os.MkdirTemp("", "fli")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daten) })
	fdir := filepath.Join(daten, "fassungen")
	_ = os.MkdirAll(filepath.Join(fdir, "manifest"), 0o700)
	for name, inhalt := range map[string][]byte{summe(prog): prog, summe(skripte): skripte, "manifest/" + neuI + ".json": manifest, "manifest/" + neuI + ".json.sig": msig} {
		if err := os.WriteFile(filepath.Join(fdir, name), inhalt, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/edge/trust-set/trust-set.json":
			_, _ = w.Write(kette.TrustSet)
		case "/api/v1/edge/trust-set/trust-set.json.sig":
			_, _ = w.Write(kette.TrustSetSig)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	p := &portalAttrappe{box: pfc, a: portal.FernlaufAuftrag{ID: id, Art: portal.FernlaufArt, EdgeRef: ref, FassungVorher: o.laeuft,
		Ziel:          portal.FernlaufZiel{Fassung: neuI, Quelle: "https://probe.invalid/edge/" + neuI + "/", ProgrammSha256: summe(prog), SkripteSha256: summe(skripte), ReleaseSeq: 6},
		TunnelAdresse: attrappe.TunnelAdressePFC, HostSchluessel: pfc.Host(), FensterID: "fenster-1", FensterEnde: time.Now().Add(30 * time.Minute),
		Server: portal.FernlaufServer{PublicKey: "c2VydmVy", Endpunkt: "wartung.example:51820", BoxNetz: "10.10.16.0/20"}, AkteurName: "admin"}}
	ablage, err := protokoll.NeueAblage(filepath.Join(daten, "fernlaeufe"))
	if err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	d := fernlauf.Neu(fernlauf.Konfig{
		Zugang: wartung.Zugang{Adresse: netip.MustParseAddr("10.10.32.50")}, SSH: techniker,
		Oeffne:    func(wartung.Zugang, wartung.Server) (wartung.Weg, error) { return pfc.Weg(), nil },
		Fassungen: &fassungen.Ablage{Dir: fdir, Wurzel: kette.Wurzel}, PortalURL: srv.URL, Bauart: "mipsle", Arbeit: filepath.Join(daten, "arbeit"),
		Portal: p, Ablage: ablage, Zeiten: kurz,
		Log: slog.New(slog.NewTextHandler(&log, nil)),
	})
	return &aufbauI{pfc: pfc, p: p, d: d, log: &log}
}

func (a *aufbauI) ergebnis(t *testing.T) portal.FernlaufErgebnis {
	t.Helper()
	a.d.Fahre(context.Background(), id)
	a.p.mu.Lock()
	defer a.p.mu.Unlock()
	if a.p.ergebnis == nil {
		t.Fatalf("kein Ergebnis gemeldet\n%s", a.log)
	}
	return *a.p.ergebnis
}

// unberuehrt prüft, was ein Fernlauf nie anfasst: Gerät, SPS, Tunnel, Identität.
func (a *aufbauI) unberuehrt(t *testing.T, vorher map[string]string) {
	t.Helper()
	if a.pfc.NeuGestartet() {
		t.Error("das Gerät wurde neu gestartet")
	}
	for _, b := range a.pfc.Befehle() {
		for _, nie := range []string{"reboot", "codesys", "vp-attrappe key", "vp-attrappe tunnel", "/etc/init.d/vp-wartung", "config_", "passwd", "firewall"} {
			if strings.Contains(b, nie) {
				t.Errorf("der Fernlauf rief auf dem Gerät %q auf: %s", nie, b)
			}
		}
	}
	for pfad, inhalt := range vorher {
		if a.pfc.Datei(pfad) != inhalt {
			t.Errorf("%s hat sich geändert", pfad)
		}
	}
}

func (a *aufbauI) eigenes() map[string]string {
	m := map[string]string{}
	for _, p := range []string{"/home/voltpilot/daten/ref", "/home/voltpilot/wartung/vp-wartung", "/etc/init.d/vp-wartung", "/root/.ssh/authorized_keys"} {
		m[p] = a.pfc.Datei(p)
	}
	return m
}

func TestIndustrieGutFall(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	vorher := a.eigenes()
	e := a.ergebnis(t)
	if e.Ergebnis != "fertig" || e.FassungVorher != altI || e.FassungNachher != neuI {
		t.Fatalf("Ergebnis %+v\n%s", e, a.log)
	}
	if got := strings.Join(a.p.belegt(), " "); got != "anmelden bestand fassungen sichern aufspielen neustart meldet_sich tunnel fenster_zu" {
		t.Fatalf("belegte Schritte: %s", got)
	}
	// Die neue Fassung liegt im Flash und läuft; neu gestartet wurde nur der Dienst, genau einmal.
	if v := strings.TrimSpace(a.pfc.Datei("/home/voltpilot/fassung/VERSION")); v != neuI {
		t.Errorf("im Flash liegt %q", v)
	}
	if info, _, _ := a.pfc.Meldung(); info != "vp-edge-core "+neuI {
		t.Errorf("die Box meldet %q", info)
	}
	if got := strings.TrimSpace(a.pfc.Lies("fernlauf.log")); got != "neustart" {
		t.Errorf("auf dem Gerät: %q, erwartet ein Neustart des Dienstes und keine Rücknahme", got)
	}
	a.unberuehrt(t, vorher)
	if !strings.Contains(e.Belege["neustart"], "Nur der Dienst neu gestartet") || !strings.Contains(e.Belege["aufspielen"], "SPS, Firewall und Tunnel nicht angefasst") {
		t.Errorf("Belege: %v", e.Belege)
	}
	if !strings.Contains(e.Belege["sichern"], "ohne Identität, Referenz und Tunnel") || len(e.Belege["sicherung_sha256"]) != 64 {
		t.Errorf("Beleg der Sicherung: %q %q", e.Belege["sichern"], e.Belege["sicherung_sha256"])
	}
	// Kein Schlüssel und keine Referenz-Datei in dem, was der Dienst meldet.
	for k, v := range e.Belege {
		if strings.Contains(v, "PRIVATE KEY") || strings.Contains(v, "ssh-rsa AAAA") {
			t.Errorf("Beleg %s trägt Schlüsselmaterial", k)
		}
	}
}

// Kommt die neue Fassung nicht hoch, spielt der Dienst die Sicherung zurück:
// Die alte läuft wieder, und wieder startet nur der Dienst.
func TestIndustrieZurueckWennDieNeueFassungNichtStartet(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	a.pfc.Setze("startet-nicht", neuI)
	vorher := a.eigenes()
	e := a.ergebnis(t)
	if e.Ergebnis != "zurueck" || e.Schritt != "neustart" || e.FassungNachher != altI {
		t.Fatalf("Ergebnis %+v\n%s", e, a.log)
	}
	if v := strings.TrimSpace(a.pfc.Datei("/home/voltpilot/fassung/VERSION")); v != altI {
		t.Errorf("im Flash liegt %q statt der alten Fassung", v)
	}
	if !strings.Contains(a.pfc.Datei("/home/voltpilot/daten/ota/current.json"), `"release_seq":5`) {
		t.Errorf("Stand nach der Rücknahme: %s", a.pfc.Datei("/home/voltpilot/daten/ota/current.json"))
	}
	if info, _, _ := a.pfc.Meldung(); info != "vp-edge-core "+altI {
		t.Errorf("die Box meldet %q", info)
	}
	if got := strings.Fields(a.pfc.Lies("fernlauf.log")); len(got) != 2 || got[0] != "neustart" || got[1] != "zurueck" {
		t.Errorf("auf dem Gerät: %v", got)
	}
	a.unberuehrt(t, vorher)
}

// Scheitert auch die Rücknahme, ist der Stand offen - nie „zurück“.
func TestIndustrieOffenWennDieRuecknahmeScheitert(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	a.pfc.Setze("startet-nicht", neuI)
	a.pfc.Setze("zurueck-scheitert", "1")
	e := a.ergebnis(t)
	if e.Ergebnis != "offen" || !strings.Contains(e.Grund, "Rücknahme gescheitert") {
		t.Fatalf("Ergebnis %+v", e)
	}
	if a.pfc.NeuGestartet() {
		t.Error("das Gerät wurde neu gestartet")
	}
}

// aendertNichts: Der Lauf endete, bevor am Gerät etwas geschrieben wurde.
func (a *aufbauI) aendertNichts(t *testing.T, e portal.FernlaufErgebnis, schritt, grund string) {
	t.Helper()
	if e.Ergebnis != "unveraendert" || e.Schritt != schritt || !strings.Contains(e.Grund, grund) {
		t.Fatalf("Ergebnis %+v, erwartet unveraendert im Schritt %s mit %q\n%s", e, schritt, grund, a.log)
	}
	for _, b := range a.pfc.Befehle() {
		if strings.Contains(b, "vp-attrappe install") || strings.Contains(b, "vp-attrappe neustart") || strings.Contains(b, "vp-attrappe zurueck") {
			t.Errorf("am Gerät lief trotzdem: %s", b)
		}
	}
	if a.pfc.NeuGestartet() {
		t.Error("das Gerät wurde neu gestartet")
	}
}

// Eine Fassung, deren Skriptstand fernlauf.sh nicht mitbringt, kann der Dienst
// nicht sichern und nicht zurücknehmen: Er spielt sie nicht auf.
func TestIndustrieFassungOhneFernlaufSkript(t *testing.T) {
	a := baueIndustrie(t, optionenI{ohneFernlaufSkript: true})
	a.aendertNichts(t, a.ergebnis(t), "fassungen", "bringt fernlauf.sh nicht mit")
}

// Edge Industrie kommt nie auf eine Box, die eine andere Linie meldet.
func TestIndustrieAndereLinie(t *testing.T) {
	a := baueIndustrie(t, optionenI{laeuft: "edge-light-2026.11.5"})
	a.aendertNichts(t, a.ergebnis(t), "bestand", "andere Linie")
}

func TestIndustrieInzwischenVerbunden(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	a.pfc.SchreibeDatei("/home/voltpilot/daten/identity/device.crt", "ZERTIFIKAT\n")
	a.aendertNichts(t, a.ergebnis(t), "bestand", "Inzwischen verbunden")
}

// Der Dienst glaubt dem Skript nicht blind: Stünde die Referenz der Box in
// der Sicherung, bricht er ab, bevor er aufspielt.
func TestIndustrieSicherungOhneIdentitaet(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	a.pfc.Setze("sicherung-mit-identitaet", "1")
	a.aendertNichts(t, a.ergebnis(t), "sichern", "home/voltpilot/daten/ref")
}

// Die Wächter oben sind nur etwas wert, wenn die Attrappe einen Neustart des
// Geräts auch merkt, und wenn sie die Befehle über SSH mitschreibt.
func TestAttrappeMerktNeustartUndBefehle(t *testing.T) {
	a := baueIndustrie(t, optionenI{})
	if a.pfc.NeuGestartet() {
		t.Fatal("frisch eingerichtet gilt das Gerät schon als neu gestartet")
	}
	e := a.ergebnis(t)
	if e.Ergebnis != "fertig" {
		t.Fatalf("Ergebnis %+v", e)
	}
	var install, status bool
	for _, b := range a.pfc.Befehle() {
		install = install || strings.Contains(b, "vp-attrappe install")
		status = status || strings.Contains(b, "vp-wartung status werte")
	}
	if !install || !status {
		t.Fatalf("die Attrappe hat die Befehle des Laufs nicht mitgeschrieben: %v", a.pfc.Befehle())
	}
	a.pfc.Lokal(t, "reboot", nil)
	if !a.pfc.NeuGestartet() {
		t.Fatal("die Attrappe merkt einen Neustart des Geräts nicht")
	}
}

// Die Mango bleibt die Mango: Eine Edge-Light-Fassung nimmt nie den Weg des PFC200.
func TestLinieEntscheidet(t *testing.T) {
	if !fernlauf.IstIndustrie("edge-industrie-2026.11.0") || fernlauf.IstIndustrie("edge-light-2026.11.0") || fernlauf.IstIndustrie("") {
		t.Fatal("Linie falsch erkannt")
	}
	for _, p := range fernlauf.GesichertIndustrie {
		if strings.Contains(p, "identity") || strings.Contains(p, "wartung") || strings.HasSuffix(p, "/ref") {
			t.Errorf("gesichert würde %s", p)
		}
	}
}

// Der Dienst und das echte Skript teilen wenige Worte und eine Liste. Dieser
// Test bindet sie aneinander: Wer fernlauf.sh ändert, sieht es hier.
func TestEchtesSkriptPasstZumDienst(t *testing.T) {
	roh, err := os.ReadFile("../../../../edge-industrie/fernlauf.sh")
	if err != nil {
		t.Fatal(err)
	}
	skript := string(roh)
	for _, w := range []string{
		`sichern | zurueck)`, `neustart)`, // die drei Befehle
		`echo \"zurueck: `,                 // daran erkennt der Dienst die gelungene Rücknahme
		`$DIENST restart`, `$DIENST start`, // neu startet nur der Dienst
	} {
		if !strings.Contains(skript, w) {
			t.Errorf("fernlauf.sh enthält %q nicht mehr", w)
		}
	}
	// Was das Skript sichert, ist genau, was der Dienst in einer Sicherung duldet.
	var imSkript []string
	for _, z := range strings.Split(skript, "\n") {
		for _, name := range []string{"DATEIEN=", "VERZEICHNISSE="} {
			if strings.HasPrefix(z, name) {
				imSkript = append(imSkript, strings.Fields(strings.Trim(strings.TrimPrefix(z, name), `"`))...)
			}
		}
	}
	if got, want := strings.Join(imSkript, " "), strings.Join(fernlauf.GesichertIndustrie, " "); got != want {
		t.Errorf("fernlauf.sh sichert\n  %s\nder Dienst duldet\n  %s", got, want)
	}
	// Nie ein Neustart des Geräts, nie die SPS-Laufzeit, nie der Tunnel.
	for _, z := range strings.Split(skript, "\n") {
		if strings.HasPrefix(strings.TrimSpace(z), "#") {
			continue
		}
		for _, nie := range []string{"reboot", "codesys", "vp-wartung", "identity", "passwd", "iptables", "nft "} {
			if strings.Contains(z, nie) {
				t.Errorf("fernlauf.sh fasst %q an: %s", nie, strings.TrimSpace(z))
			}
		}
	}
}
