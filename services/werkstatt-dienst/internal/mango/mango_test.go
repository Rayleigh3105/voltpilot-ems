package mango_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// Die Skripte rufen "ssh" auf: das ist dann dieses Testprogramm (Durchreiche).
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "ssh" {
		os.Exit(durchreiche.Shim(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

var kurz = mango.Zeiten{Takt: 20 * time.Millisecond, Verbinden: 3 * time.Second, Sysupgrade: 5 * time.Second, Neustart: 5 * time.Second, Netz: 3 * time.Second, Programm: 3 * time.Second, Tunnel: 3 * time.Second}

type aufbau struct {
	m      *attrappe.Mango
	b      *attrappe.Bruecke
	k      mango.Konfig
	f      freigabe.Freigabe
	id     *age.X25519Identity
	ablage *protokoll.Ablage
	dir    string
	r      *lauf.Laeufer
	log    *bytes.Buffer
	abbild []byte
	// ohneManifest: das Release traegt kein release.json (Stufe 1).
	ohneManifest bool
}

func summe(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func neu(t *testing.T, abOpenWrt bool) *aufbau {
	t.Helper()
	a := &aufbau{log: &bytes.Buffer{}}
	log := logs.Neu(a.log, "json", nil)
	imager := attrappe.Schluessel(t)
	a.b = attrappe.NeueBruecke(t, imager.PublicKey())
	a.m = attrappe.NeueMango(t, abOpenWrt)
	a.m.BestaetigterStand = 77
	notfall := attrappe.Schluessel(t)
	ziele := []netip.AddrPort{}
	for _, z := range []string{"192.168.8.1:22", "192.168.8.1:80", "192.168.1.1:22", "192.168.1.1:80", "10.213.0.1:22", "10.213.0.1:8484"} {
		ziele = append(ziele, netip.MustParseAddrPort(z))
	}
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: a.b.Adresse, HostDatei: filepath.Join(t.TempDir(), "h.pub"),
		Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t), Einrichten: imager,
		Netz: "wlan0", Werkstatt: "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24"), netip.MustParsePrefix("10.213.0.2/24")},
		Ziele:             ziele, SSHQuellen: []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")}, Zeitlimit: 5 * time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(wb.Schliesse)
	if _, _, err := wb.Bereit(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.b.AntwortenFunc, a.b.ZielFunc = a.m.Antworten, a.m.Ziel

	// Die Freigabe mit drei Dateien, die ein HTTPS-Server ausliefert.
	a.abbild = make([]byte, 64*1024)
	_, _ = rand.Read(a.abbild)
	programm := []byte("\x7fELF vp-edge-light attrappe")
	skripte := attrappe.SkripteTarGz(t)
	manifest, signatur := attrappe.Manifest("edge-light-2026.11.1", 77, summe(programm))
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/edge/trust-set/trust-set.json":
			_, _ = w.Write([]byte(`{"schema_version":"1.0","keys":[{"key_id":"rel-2026-a"}]}`))
		case "/api/v1/edge/trust-set/trust-set.json.sig":
			_, _ = w.Write([]byte(`{"key_id":"root-2026-a","domain":"trust-set","signature":"AAAA"}`))
		case "/edge/release.json", "/edge/release.json.sig":
			if a.ohneManifest {
				http.NotFound(w, r)
			} else if strings.HasSuffix(r.URL.Path, ".sig") {
				_, _ = w.Write(signatur)
			} else {
				_, _ = w.Write(manifest)
			}
		case "/openwrt/openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin":
			_, _ = w.Write(a.abbild)
		case "/edge/vp-edge-light-linux-mipsle":
			_, _ = w.Write(programm)
		case "/edge/edge-light-openwrt.tar.gz":
			_, _ = w.Write(skripte)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	a.f = freigabe.Freigabe{Schema: freigabe.Schema, Kennung: "2026-11-mango-1", BoxArt: freigabe.Mango, ErteiltVon: "Test",
		ErteiltAm: time.Now().Add(-time.Hour), GueltigBis: time.Now().Add(24 * time.Hour), Obergrenze: 5,
		OpenWrt:   freigabe.Abbild{Fassung: "25.12.5", Datei: "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin", Sha256: summe(a.abbild), Quelle: srv.URL + "/openwrt/"},
		EdgeLight: freigabe.Programm{Fassung: "edge-light-2026.11.1", Quelle: srv.URL + "/edge/", ProgrammSha256: summe(programm), SkripteSha256: summe(skripte)},
	}
	a.id, _ = age.GenerateX25519Identity()
	a.dir = t.TempDir()
	a.ablage, _ = protokoll.NeueAblage(filepath.Join(a.dir, "laeufe"))
	a.r = lauf.NeuerLaeufer(a.ablage, log, metriken.Neu())
	arbeit, err := os.MkdirTemp("/tmp", "vpw-") // kurz: Pfade von Unix-Sockets höchstens 104 Zeichen (macOS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(arbeit) })
	a.k = mango.Konfig{
		Werkbank: wb, Fassungen: &fassungen.Ablage{Dir: filepath.Join(a.dir, "fassungen"), Client: srv.Client()},
		Arbeit: arbeit, LanNetz: netip.MustParsePrefix("10.213.0.1/24"), LanBruecke: netip.MustParseAddr("10.213.0.2"),
		DNS:        []netip.Addr{netip.MustParseAddr("9.9.9.9")},
		Notfall:    strings.TrimSpace(string(ssh.MarshalAuthorizedKey(notfall.PublicKey()))) + " voltpilot-notfall",
		Empfaenger: a.id.Recipient(), WartungPub: "c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU=",
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20"), Bauart: "mipsle", Zeiten: kurz, Log: log,
		PortalURL: srv.URL,
	}
	return a
}

// fahre führt einen Lauf aus; liefert die Tunnel-Adresse, sobald er darauf wartet.
func (a *aufbau) fahre(t *testing.T, e mango.Einstieg) (*lauf.Lauf, lauf.Zustand) {
	t.Helper()
	l := lauf.Neu(time.Now(), a.f.Kennung, "mango")
	ml, err := mango.NeuerLauf(a.k, a.f, l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	defer ml.Schliesse()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	fertig := make(chan lauf.Zustand, 1)
	go func() { fertig <- a.r.Fahre(ctx, l, nil, ml.Schritte(e)) }()
	for {
		select {
		case z := <-fertig:
			return l, z
		case <-time.After(10 * time.Millisecond):
			if s := l.Stand(); s.Zustand == lauf.Wartet && s.WartetAuf == "tunnel_adresse" {
				if !strings.Contains(s.Hinweis, "edge-k7m2xq3") || !strings.Contains(s.Hinweis, a.m.WgPub) {
					t.Errorf("Hinweis ohne Referenz und Schlüssel: %s", s.Hinweis)
				}
				_ = l.Gib(ctx, "tunnel_adresse", "10.10.16.5")
			}
			if s := l.Stand(); s.Zustand == lauf.Wartet && s.WartetAuf == "probe" {
				if !strings.Contains(s.Hinweis, "Werkstatt-Probe") || !strings.Contains(s.Hinweis, "SHA256:") {
					t.Errorf("Hinweis der Probe: %s", s.Hinweis)
				}
				_ = l.Gib(ctx, "probe", "weiß nicht") // abgelehnt, wartet weiter
				time.Sleep(20 * time.Millisecond)
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

func wert(t *testing.T, b protokoll.Beleg, name string) string {
	t.Helper()
	v, ok := b.Wert(name)
	if !ok {
		t.Fatalf("Beleg ohne %s: %v", name, b)
	}
	return v
}

func TestGanzerLaufAbWerk(t *testing.T) {
	a := neu(t, false)
	l, z := a.fahre(t, mango.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v\n%s", z, l.Stand(), a.log.String())
	}
	s := l.Stand()
	want := "erkennen fassungen openwrt wiedererkennen internet passwort notfall programm tunnel_schluessel tunnel_adresse tunnel lan neustart probe internet_weg uebergabe"
	if strings.Join(s.Erledigt, " ") != want {
		t.Fatalf("Schritte %v", s.Erledigt)
	}
	b := a.belege(t, l)
	if wert(t, b["openwrt"], "sha256_box") != summe(a.abbild) || wert(t, b["openwrt"], "sha256_dienst") != summe(a.abbild) {
		t.Fatal("Prüfsummen")
	}
	hostWerk := wert(t, b["erkennen"], "host_schluessel_werk")
	hostOW := wert(t, b["wiedererkennen"], "host_schluessel")
	if !strings.HasPrefix(hostOW, "ssh-rsa SHA256:") || hostOW == hostWerk {
		t.Fatalf("Host-Schlüssel nach OpenWrt %q (ab Werk %q)", hostOW, hostWerk)
	}
	if !strings.Contains(wert(t, b["neustart"], "host_schluessel"), strings.TrimPrefix(hostOW, "ssh-rsa ")) {
		t.Fatal("Host-Schlüssel nach dem Neustart nicht derselbe")
	}
	if wert(t, b["passwort"], "ohne_passwort") != "abgewiesen" {
		t.Fatal("ohne Passwort nicht abgewiesen")
	}
	// Das Passwort: auf der Box gesetzt, im Beleg nur verschlüsselt, nur für den age-Schlüssel lesbar.
	pw := a.m.Passwort()
	if len(pw) != 24 {
		t.Fatalf("Passwort auf der Box %q", pw)
	}
	klar, err := age.Decrypt(armor.NewReader(strings.NewReader(wert(t, b["passwort"], "passwort_age"))), a.id)
	if err != nil {
		t.Fatal(err)
	}
	k, _ := io.ReadAll(klar)
	if strings.TrimSpace(string(k)) != pw {
		t.Fatal("verschlüsseltes Passwort ist nicht das der Box")
	}
	var alles bytes.Buffer
	_ = filepath.Walk(a.dir, func(p string, i os.FileInfo, err error) error {
		if err == nil && !i.IsDir() && !strings.Contains(p, "fassungen") {
			d, _ := os.ReadFile(p)
			alles.Write(d)
		}
		return nil
	})
	if strings.Contains(alles.String(), pw) || strings.Contains(a.log.String(), pw) {
		t.Fatal("das Root-Passwort steht im Klartext in Protokoll oder Log")
	}
	if wert(t, b["notfall"], "zeilen") != "1" {
		t.Fatal("Notfall")
	}
	if !strings.Contains(wert(t, b["programm"], "install"), "Pruefsumme auf dem Geraet bestaetigt") || wert(t, b["programm"], "referenz") != "edge-k7m2xq3 (Prüfzeichen gültig)" {
		t.Fatalf("Programm %v", b["programm"])
	}
	if wert(t, b["tunnel_adresse"], "tunnel_adresse") != "10.10.16.5" || !strings.Contains(wert(t, b["tunnel"], "handshake"), "7 seconds ago") {
		t.Fatalf("Tunnel %v %v", b["tunnel_adresse"], b["tunnel"])
	}
	if wert(t, b["internet"], "standardweg") != "default via 192.168.1.2 dev br-lan" {
		t.Fatal("Werkstatt-Internet")
	}
	if !strings.Contains(wert(t, b["probe"], "probe"), "Fenster geschlossen") || !strings.Contains(wert(t, u0(b), "pruefung_fenster_zu"), "Schritt probe") {
		t.Fatalf("Probe: %v", b["probe"])
	}
	if wert(t, b["internet_weg"], "gateway") != "keiner" {
		t.Fatal("Werkstatt-Internet nicht entfernt")
	}
	phase, adr, gw, tunnel := a.m.Stand()
	if phase != "openwrt" || adr != "10.213.0.1" || gw != "" || tunnel != "10.10.16.5" {
		t.Fatalf("Mango am Ende: %s %s %q %s", phase, adr, gw, tunnel)
	}
	u := b["uebergabe"]
	for _, p := range mango.Pruefungen {
		if strings.TrimSpace(wert(t, u, "pruefung_"+p)) == "" {
			t.Errorf("Übergabe ohne Beleg für %s", p)
		}
	}
	if wert(t, u, "lan_netz") != "10.213.0.1/24" || wert(t, u, "fassung") != "edge-light-2026.11.1" {
		t.Fatalf("Übergabe %v", u)
	}
	// nie -F, immer erst -T
	befehle := strings.Join(a.m.Befehle(), "\n")
	if strings.Contains(befehle, "sysupgrade -F") || strings.Index(befehle, "sysupgrade -T") > strings.Index(befehle, "sysupgrade -n") {
		t.Fatal("sysupgrade-Reihenfolge")
	}
}

func TestLaufAbFrischemOpenWrt(t *testing.T) {
	a := neu(t, true)
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v", z, l.Stand())
	}
	if strings.Contains(strings.Join(a.m.Befehle(), "\n"), "sysupgrade") {
		t.Fatal("frisches OpenWrt noch einmal aufgespielt")
	}
	if _, ok := a.belege(t, l)["openwrt"]; ok {
		t.Fatal("Schritt openwrt im Lauf ab OpenWrt")
	}
}

func TestAbbruchregeln(t *testing.T) {
	faelle := []struct {
		name      string
		einstieg  mango.Einstieg
		richte    func(a *aufbau)
		schritt   string
		grund     string
		handgriff bool
		fall      string
	}{
		{"schon eingerichtet", mango.AbWerk, func(a *aufbau) { a.m.RootPasswortAbWerk = true }, "erkennen", "verlangt ein Passwort", true, "gl_passwort"},
		{"anderes Gerät", mango.AbWerk, func(a *aufbau) { a.m.Board = "glinet,gl-ar300m" }, "erkennen", "keine GL-MT300N-V2", true, "falsches_geraet"},
		{"keine GL-Firmware", mango.AbWerk, func(a *aufbau) { a.m.GL = "" }, "erkennen", "keine GL-Werksfirmware", true, "falsches_geraet"},
		{"zwei Geräte", mango.AbWerk, func(a *aufbau) { a.m.Zweite = true }, "erkennen", "mehrere Geräte", true, "zwei_geraete"},
		{"Abbild abgelehnt", mango.AbWerk, func(a *aufbau) { a.m.SysupgradeTestScheitert = true }, "openwrt", "nimmt das Abbild nicht an", true, "abbild_abgelehnt"},
		{"Prüfsumme auf der Box", mango.AbWerk, func(a *aufbau) { a.m.AbbildVerfaelschen = true }, "openwrt", "Prüfsumme auf der Box", false, "uebertragung"},
		{"falsche OpenWrt-Fassung", mango.AbWerk, func(a *aufbau) { a.m.OpenWrt = "24.10.4" }, "wiedererkennen", "statt 25.12.5", true, "openwrt_fassung"},
		{"Freigabe-Prüfsumme", mango.AbWerk, func(a *aufbau) { a.f.OpenWrt.Sha256 = strings.Repeat("0", 64) }, "fassungen", "nicht benutzt", false, "fassung_nicht_bereit"},
		{"falsche Programm-Fassung", mango.AbOpenWrt, func(a *aufbau) { a.m.Version = "edge-light-gabc1234" }, "programm", "die Freigabe nennt", false, "schritt_gescheitert"},
		{"Referenz ohne Prüfzeichen", mango.AbOpenWrt, func(a *aufbau) { a.m.Ref = "edge-k7m2xqz" }, "programm", "Prüfzeichen", false, "schritt_gescheitert"},
	}
	for _, f := range faelle {
		t.Run(f.name, func(t *testing.T) {
			a := neu(t, f.einstieg == mango.AbOpenWrt)
			f.richte(a)
			l, z := a.fahre(t, f.einstieg)
			s := l.Stand()
			if z != lauf.Angehalten || s.Schritt != f.schritt || !strings.Contains(s.Grund, f.grund) || (s.Handgriff != "") != f.handgriff ||
				s.Fall != f.fall || s.Loesung == nil || s.Loesung.Titel == "" {
				t.Fatalf("Zustand %s, Stand %+v", z, s)
			}
			if f.name == "Freigabe-Prüfsumme" && len(a.m.Befehle()) > 1 {
				t.Fatalf("Box angefasst trotz falscher Datei: %v", a.m.Befehle())
			}
		})
	}
}

func TestEinzeln(t *testing.T) {
	if _, err := mango.Einzeln(werkbank.Status{}); err == nil {
		t.Fatal("ohne Gerät")
	}
	s := werkbank.Status{Antworten: []werkbank.Antwort{{Adresse: "192.168.8.1", MACs: []string{"a"}}, {Adresse: "192.168.1.1", MACs: []string{"b"}}}}
	var h lauf.Handgriff
	if _, err := mango.Einzeln(s); err == nil || !errorsAs(err, &h) {
		t.Fatalf("zwei Adressen: %v", err)
	}
}

func u0(b map[string]protokoll.Beleg) protokoll.Beleg { return b["uebergabe"] }

func errorsAs(err error, h *lauf.Handgriff) bool {
	x, ok := err.(lauf.Handgriff)
	if ok {
		*h = x
	}
	return ok
}

func TestTunnelAdresse(t *testing.T) {
	n := netip.MustParsePrefix("10.10.16.0/20")
	for _, ok := range []string{"10.10.16.5", " 10.10.31.200 "} {
		if _, err := mango.PruefeTunnelAdresse(ok, n); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, nein := range []string{"10.10.16.0", "10.10.32.3", "192.168.1.1", "x", "10.10.16.5/32"} {
		if _, err := mango.PruefeTunnelAdresse(nein, n); err == nil {
			t.Errorf("%s angenommen", nein)
		}
	}
}

// Entscheid 5c als Prüfung (Konzept vp-edge-light-update, K5): eine Box, die
// keine Updates aus dem Portal annehmen kann, bekommt keine Abnahme - der Lauf
// endet an der Übergabe und nennt den Grund.
func TestOhneUpdateBereitschaftKeineAbnahme(t *testing.T) {
	for name, fall := range map[string]struct {
		vorbereiten func(a *aufbau)
		grund       string
	}{
		"Fassung nicht signiert": {func(a *aufbau) { a.ohneManifest = true }, "nicht signiert"},
		"kein Vertrauens-Set":    {func(a *aufbau) { a.m.OhneVertrauensSet = true }, "kein geprueftes Vertrauens-Set"},
		"Stand nicht gemeldet":   {func(a *aufbau) { a.m.BestaetigterStand = 0 }, "nicht den Stand 77"},
	} {
		t.Run(name, func(t *testing.T) {
			a := neu(t, true)
			fall.vorbereiten(a)
			l, z := a.fahre(t, mango.AbOpenWrt)
			s := l.Stand()
			if z == lauf.Fertig || s.Schritt != "uebergabe" || !strings.Contains(s.Grund, "nicht update-bereit") ||
				!strings.Contains(s.Grund, fall.grund) || !strings.Contains(s.Grund, "Entscheid 5c") {
				t.Fatalf("Zustand %s: %+v", z, s)
			}
			if v := wert(t, a.belege(t, l)["programm"], "update_bereit"); !strings.HasPrefix(v, "nein") {
				t.Fatalf("Beleg update_bereit: %q", v)
			}
		})
	}
}

// Ein Manifest, das ein anderes Programm beschreibt als die Freigabe, hält den
// Lauf schon beim Bereitlegen an - nichts geht auf die Box.
func TestEinFremdesManifestHaeltDenLaufAn(t *testing.T) {
	a := neu(t, true)
	a.f.EdgeLight.ProgrammSha256 = strings.Repeat("e", 64)
	l, z := a.fahre(t, mango.AbOpenWrt)
	s := l.Stand()
	if z == lauf.Fertig || s.Schritt != "fassungen" {
		t.Fatalf("Zustand %s: %+v", z, s)
	}
}

func TestUpdateBereitBelegNenntSchluesselUndStand(t *testing.T) {
	a := neu(t, true)
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v", z, l.Stand())
	}
	b := a.belege(t, l)
	if !strings.Contains(wert(t, b["fassungen"], "manifest"), "signiert (rel-2026-a), Stand 77") {
		t.Fatalf("Beleg manifest: %v", b["fassungen"])
	}
	u := wert(t, b["uebergabe"], "pruefung_update_bereit")
	if !strings.Contains(u, "rel-2026-a") || !strings.Contains(u, "Stand 77") {
		t.Fatalf("Beleg update_bereit: %q", u)
	}
	if !strings.Contains(wert(t, b["uebergabe"], "versand"), "Nicht versenden") {
		t.Fatal("der Versand-Satz fehlt")
	}
}
