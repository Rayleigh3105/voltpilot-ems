package fernlauf_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fernlauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// Die Skripte rufen "ssh" auf: das ist dann dieses Testprogramm (Durchreiche).
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "ssh" {
		os.Exit(durchreiche.Shim(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

const (
	ref = "edge-k7m2xq3"
	alt = "edge-light-2026.11.5"
	neu = "edge-light-2026.11.15"
	id  = "0b5e7c1a-1111-4aaa-8bbb-0123456789ab"
)

var kurz = fernlauf.Zeiten{Takt: 10 * time.Millisecond, Versuch: 2 * time.Second, Anmelden: 3 * time.Second,
	Programm: 2 * time.Second, MeldetSich: 2 * time.Second, Reserve: time.Minute}

// ---- Portal-Attrappe ---------------------------------------------------------

type portalAttrappe struct {
	box *attrappe.FeldBox
	a   portal.FernlaufAuftrag

	mu       sync.Mutex
	schritte []string
	zeilen   []string
	ergebnis *portal.FernlaufErgebnis
	zu       int
}

func (p *portalAttrappe) FernlaufBeginnen(_ context.Context, auftrag string) (portal.FernlaufAuftrag, error) {
	if auftrag != id {
		return portal.FernlaufAuftrag{}, portal.Abgelehnt{Status: 404, Message: "unbekannt"}
	}
	return p.a, nil
}

func (p *portalAttrappe) FernlaufSchritt(_ context.Context, _ string, schritt, zustand, zeile string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.schritte = append(p.schritte, schritt+":"+zustand)
	p.zeilen = append(p.zeilen, zeile)
	return nil
}

func (p *portalAttrappe) FernlaufMeldungLesen(context.Context, string) (portal.FernlaufMeldung, error) {
	info, start, zert := p.box.Meldung()
	return portal.FernlaufMeldung{DeviceInfo: info, CsrUpdatedAt: start, ZuletztAbgefragtAm: start.Add(time.Millisecond), Zertifikat: zert}, nil
}

func (p *portalAttrappe) FernlaufErgebnisMelden(_ context.Context, _ string, e portal.FernlaufErgebnis) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ergebnis = &e
	return nil
}

func (p *portalAttrappe) FernlaufFensterSchliessen(context.Context, string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.zu++
	return p.zu > 1, nil
}

func (p *portalAttrappe) belegt() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, s := range p.schritte {
		if k, ok := strings.CutSuffix(s, ":belegt"); ok {
			out = append(out, k)
		}
	}
	return out
}

func summe(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// ---- Aufbau ------------------------------------------------------------------

type aufbau struct {
	box    *attrappe.FeldBox
	p      *portalAttrappe
	d      *fernlauf.Dienst
	ablage *protokoll.Ablage
	log    *bytes.Buffer
	daten  string
}

type option func(*optionen)

type optionen struct {
	fremderSigner bool
	hostFalsch    bool
	zielSeq       int64
}

func baue(t *testing.T, opts ...option) *aufbau {
	t.Helper()
	o := optionen{zielSeq: 6}
	for _, f := range opts {
		f(&o)
	}
	techniker := rsaSigner(t)
	box := attrappe.NeueFeldBox(t, ref, alt, 5, techniker.PublicKey())
	box.SchluesselNach = 2
	prog := box.ProgrammFuer(neu)
	skripte := attrappe.SkripteTarGz(t)

	kette := attrappe.NeueSignierteWurzel(t)
	set, setSig := kette.TrustSet, kette.TrustSetSig
	signer := kette
	if o.fremderSigner {
		signer = attrappe.NeueSignierteWurzel(t) // dieselbe Kennung rel-2026-a, anderer Schlüssel: nicht echt
	}
	manifest := []byte(fmt.Sprintf(`{"schema_version":"1.0","release":"%s","release_seq":%d,"target_commit":"5b28311b4c0d",`+
		`"artifacts":[{"type":"binary","name":"vp-edge-light","arch":"linux/mipsle","sha256":"%s","size":%d,"gz_sha256":"%s","gz_size":4}],`+
		`"min_from_seq":0,"allow_downgrade":false,"state_schema":1,"compat":{"backends":["light"]},"signing_key_id":"rel-2026-a",`+
		`"skripte":{"name":"edge-light-openwrt.tar.gz","sha256":"%s","size":%d}}`, neu, o.zielSeq, summe(prog), len(prog), strings.Repeat("9c", 32), summe(skripte), len(skripte)))
	msig := signer.SigniereManifest(t, manifest)

	// Kurz (Unix-Socket der Durchreiche), wie die Tests in internal/mango.
	daten, err := os.MkdirTemp("", "fl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daten) })
	fdir := filepath.Join(daten, "fassungen")
	_ = os.MkdirAll(filepath.Join(fdir, "manifest"), 0o700)
	for name, inhalt := range map[string][]byte{summe(prog): prog, summe(skripte): skripte, "manifest/" + neu + ".json": manifest, "manifest/" + neu + ".json.sig": msig} {
		if err := os.WriteFile(filepath.Join(fdir, name), inhalt, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/edge/trust-set/trust-set.json":
			_, _ = w.Write(set)
		case "/api/v1/edge/trust-set/trust-set.json.sig":
			_, _ = w.Write(setSig)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	host := box.HostFingerabdruck()
	if o.hostFalsch {
		host = "SHA256:" + strings.Repeat("A", 43)
	}
	p := &portalAttrappe{box: box, a: portal.FernlaufAuftrag{ID: id, Art: portal.FernlaufArt, EdgeRef: ref, FassungVorher: alt,
		Ziel:          portal.FernlaufZiel{Fassung: neu, Quelle: "https://probe.invalid/edge/" + neu + "/", ProgrammSha256: summe(prog), SkripteSha256: summe(skripte), ReleaseSeq: o.zielSeq},
		TunnelAdresse: "10.10.16.5", HostSchluessel: host, FensterID: "fenster-1", FensterEnde: time.Now().Add(30 * time.Minute),
		Server: portal.FernlaufServer{PublicKey: "c2VydmVy", Endpunkt: "wartung.example:51820", BoxNetz: "10.10.16.0/20"}, AkteurName: "admin"}}

	ablage, err := protokoll.NeueAblage(filepath.Join(daten, "fernlaeufe"))
	if err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	d := fernlauf.Neu(fernlauf.Konfig{
		Zugang: wartung.Zugang{Adresse: netip.MustParseAddr("10.10.32.50")}, SSH: techniker,
		Oeffne:    func(wartung.Zugang, wartung.Server) (wartung.Weg, error) { return box.Weg(), nil },
		Fassungen: &fassungen.Ablage{Dir: fdir, Wurzel: kette.Wurzel}, PortalURL: srv.URL, Bauart: "mipsle", Arbeit: filepath.Join(daten, "arbeit"),
		Portal: p, Ablage: ablage, Zeiten: kurz,
		Log: slog.New(slog.NewTextHandler(&log, nil)),
	})
	return &aufbau{box: box, p: p, d: d, ablage: ablage, log: &log, daten: daten}
}

func rsaSigner(t *testing.T) ssh.Signer {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (a *aufbau) fahre(t *testing.T) portal.FernlaufErgebnis {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	a.d.Fahre(ctx, id)
	if a.p.ergebnis == nil {
		t.Fatalf("kein Ergebnis gemeldet; Log:\n%s", a.log)
	}
	if a.p.zu != 1 {
		t.Errorf("Fenster %d-mal geschlossen, erwartet einmal", a.p.zu)
	}
	if !strings.HasSuffix(strings.Join(a.p.schritte, " "), "fenster_zu:belegt") {
		t.Errorf("fenster_zu nicht zuletzt: %v", a.p.schritte)
	}
	a.keinGeheimnis(t)
	return *a.p.ergebnis
}

// keinGeheimnis: weder der Geräteschlüssel noch das WLAN-Kennwort der Box
// steht in Log, Protokoll, Schritten oder Ergebnis.
func (a *aufbau) keinGeheimnis(t *testing.T) {
	t.Helper()
	var alles strings.Builder
	alles.WriteString(a.log.String())
	alles.WriteString(strings.Join(a.p.zeilen, "\n"))
	e, _ := json.Marshal(a.p.ergebnis)
	alles.Write(e)
	_ = filepath.Walk(filepath.Join(a.daten, "fernlaeufe"), func(p string, i os.FileInfo, err error) error {
		if err == nil && !i.IsDir() {
			b, _ := os.ReadFile(p)
			alles.Write(b)
		}
		return nil
	})
	for _, v := range []string{"GEHEIM", "PRIVATE KEY", "WLAN-KENNWORT"} {
		if strings.Contains(alles.String(), v) {
			t.Errorf("%q steht in Log, Protokoll oder Meldung", v)
		}
	}
	for _, b := range a.box.Befehle() {
		if strings.Contains(b, "identity") && !strings.Contains(b, "identity/device.crt") {
			t.Errorf("ein Befehl fasst die Identität an: %q", b)
		}
		if strings.Contains(b, "wireless") && strings.HasPrefix(b, "tar ") {
			t.Errorf("die Sicherung nimmt die WLAN-Einstellung mit: %q", b)
		}
	}
	m, _ := filepath.Glob(filepath.Join(a.daten, "arbeit", "fl-*"))
	if len(m) > 0 {
		t.Errorf("Arbeitsverzeichnis mit der Sicherung liegt noch: %v", m)
	}
}

func veraendernd(befehle []string) []string {
	var out []string
	for _, b := range befehle {
		if b == "vp-attrappe install" || strings.Contains(b, "restart") || strings.Contains(b, "tar -xzf") || strings.Contains(b, "uci set") {
			out = append(out, b)
		}
	}
	return out
}

// ---- Fälle -------------------------------------------------------------------

func TestFernlaufBringtDieNeuesteFassung(t *testing.T) {
	a := baue(t)
	e := a.fahre(t)
	if e.Ergebnis != "fertig" || e.FassungVorher != alt || e.FassungNachher != neu {
		t.Fatalf("Ergebnis %+v; Log:\n%s", e, a.log)
	}
	if got := strings.Join(a.p.belegt(), " "); got != "anmelden bestand fassungen sichern aufspielen neustart meldet_sich tunnel fenster_zu" {
		t.Errorf("belegte Schritte: %s", got)
	}
	if v, land := a.box.Fassung(); v != neu || land != "DE" {
		t.Errorf("Box läuft %s, Land %q", v, land)
	}
	if !strings.Contains(e.Belege["fassungen"], "gegen die eingebackene Wurzel geprüft") {
		t.Errorf("Beleg fassungen: %q", e.Belege["fassungen"])
	}
	if !strings.Contains(e.Belege["anmelden"], a.box.HostFingerabdruck()) {
		t.Errorf("Beleg anmelden: %q", e.Belege["anmelden"])
	}
	if a.box.Datei("etc/vp-edge-light/identity/device.key") == "" {
		t.Error("die Identität der Box ist weg")
	}
	// Die Identität ging nie in die Sicherung.
	for _, b := range a.box.Befehle() {
		if strings.HasPrefix(b, "tar -czf") && (strings.Contains(b, "identity") || strings.Contains(b, " etc/vp-edge-light ") || strings.Contains(b, "/ref")) {
			t.Errorf("Sicherung: %q", b)
		}
	}
	es, err := a.ablage.Lies(mustEinLauf(t, a.ablage))
	if err != nil || es[0].Angaben["auftrag"] != id || es[len(es)-1].Zustand != "fertig" {
		t.Errorf("Protokoll: %+v %v", es, err)
	}
	if an := a.d.Ansicht(); an.Aktiv != nil || an.Letzter == nil || an.Letzter.Ergebnis != "fertig" || !an.Bereit {
		t.Errorf("Ansicht: %+v", an)
	}
}

func mustEinLauf(t *testing.T, ab *protokoll.Ablage) string {
	t.Helper()
	l, err := ab.Laeufe()
	if err != nil || len(l) != 1 {
		t.Fatalf("Läufe: %v %v", l, err)
	}
	return l[0]
}

func TestFernlaufNimmtZurueckWennDieNeueFassungFalschStartet(t *testing.T) {
	a := baue(t)
	vorher := map[string]string{}
	for _, p := range []string{"usr/libexec/vp-edge-light/boot.sh", "etc/crontabs/root", "etc/config/firewall", "etc/vp-edge-light/ota/current.json",
		"etc/vp-edge-light/ota/trust-set.json", "usr/share/vp-edge-light/vp-edge-light-linux-mipsle.gz"} {
		vorher[p] = a.box.Datei(p)
	}
	a.box.StartetFalsch = "edge-light-2026.11.14"
	e := a.fahre(t)
	if e.Ergebnis != "zurueck" || e.Schritt != "neustart" || e.FassungNachher != alt {
		t.Fatalf("Ergebnis %+v; Log:\n%s", e, a.log)
	}
	if !strings.Contains(e.Grund, "edge-light-2026.11.14") {
		t.Errorf("Grund: %q", e.Grund)
	}
	if v, land := a.box.Fassung(); v != alt || land != "" {
		t.Errorf("nach der Rücknahme läuft %s, Land %q", v, land)
	}
	for p, s := range vorher {
		if got := a.box.Datei(p); got != s {
			t.Errorf("%s nach der Rücknahme %q, vorher %q", p, got, s)
		}
	}
	for _, p := range []string{"usr/libexec/vp-edge-light/einrichtung-wlan.sh", "etc/hotplug.d/iface/91-vp-einrichtung"} {
		if a.box.Datei(p) != "" {
			t.Errorf("%s blieb nach der Rücknahme liegen", p)
		}
	}
	if !strings.Contains(strings.Join(a.p.belegt(), " "), "zurueck") {
		t.Errorf("zurueck nicht belegt: %v", a.p.schritte)
	}
}

func TestFernlaufNimmtZurueckWennAmTunnelEtwasFehlt(t *testing.T) {
	a := baue(t)
	a.box.TunnelNachInstall = true
	e := a.fahre(t)
	if e.Ergebnis != "zurueck" || e.Schritt != "tunnel" || !strings.Contains(e.Grund, "SSH 2222") {
		t.Fatalf("Ergebnis %+v; Log:\n%s", e, a.log)
	}
	if v, _ := a.box.Fassung(); v != alt {
		t.Errorf("läuft %s", v)
	}
}

func TestFernlaufMitFalscherSignaturAendertNichts(t *testing.T) {
	a := baue(t, func(o *optionen) { o.fremderSigner = true })
	e := a.fahre(t)
	if e.Ergebnis != "unveraendert" || e.Schritt != "fassungen" || !strings.Contains(e.Grund, "nicht echt") {
		t.Fatalf("Ergebnis %+v; Log:\n%s", e, a.log)
	}
	if v := veraendernd(a.box.Befehle()); len(v) > 0 {
		t.Errorf("an der Box geändert: %v", v)
	}
}

func TestFernlaufNurAufwaerts(t *testing.T) {
	a := baue(t, func(o *optionen) { o.zielSeq = 5 })
	e := a.fahre(t)
	if e.Ergebnis != "unveraendert" || e.Schritt != "bestand" || !strings.Contains(e.Grund, "nur aufwärts") {
		t.Fatalf("Ergebnis %+v", e)
	}
	if v := veraendernd(a.box.Befehle()); len(v) > 0 {
		t.Errorf("an der Box geändert: %v", v)
	}
}

func TestFernlaufInzwischenVerbunden(t *testing.T) {
	a := baue(t)
	a.box.Zertifikat = true
	e := a.fahre(t)
	if e.Ergebnis != "unveraendert" || !strings.Contains(e.Grund, "Inzwischen verbunden") {
		t.Fatalf("Ergebnis %+v", e)
	}
	if v := veraendernd(a.box.Befehle()); len(v) > 0 {
		t.Errorf("an der Box geändert: %v", v)
	}
}

func TestFernlaufAndererHostSchluessel(t *testing.T) {
	a := baue(t, func(o *optionen) { o.hostFalsch = true })
	e := a.fahre(t)
	if e.Ergebnis != "unveraendert" || e.Schritt != "anmelden" || !strings.Contains(e.Grund, "Host-Schlüssel der Box ist") {
		t.Fatalf("Ergebnis %+v", e)
	}
	if len(a.box.Befehle()) != 0 {
		t.Errorf("Befehle an einer fremden Box: %v", a.box.Befehle())
	}
}

func TestFernlaufNichtBereitOhneTechnikerZugang(t *testing.T) {
	d := fernlauf.Neu(fernlauf.Konfig{Portal: &portalAttrappe{}})
	a := d.Ansicht()
	if a.Bereit || !strings.Contains(a.Grund, "VP_WERKSTATT_TECHNIKER_ADRESSE") {
		t.Fatalf("Ansicht: %+v", a)
	}
	d.Annehmen(context.Background(), id)
	if d.Ansicht().Wartend != 0 {
		t.Error("ohne Zugang eingereiht")
	}
}

func TestVokabularWieImVektor(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/werkstatt-fernlauf.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Schritte   []struct{ ID string } `json:"schritte"`
		Ergebnisse []string              `json:"ergebnisse"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, x := range v.Schritte {
		s = append(s, x.ID)
	}
	if strings.Join(s, " ") != strings.Join(fernlauf.Schritte, " ") {
		t.Errorf("Schritte %v, Vektor %v", fernlauf.Schritte, s)
	}
	if strings.Join(v.Ergebnisse, " ") != strings.Join(fernlauf.Ergebnisse, " ") {
		t.Errorf("Ergebnisse %v, Vektor %v", fernlauf.Ergebnisse, v.Ergebnisse)
	}
}
