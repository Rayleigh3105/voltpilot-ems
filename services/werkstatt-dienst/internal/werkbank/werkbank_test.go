package werkbank_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

type aufbau struct {
	b                              *attrappe.Bruecke
	k                              werkbank.Konfig
	status, weiter, pflege, imager ssh.Signer
}

func neu(t *testing.T) aufbau {
	t.Helper()
	a := aufbau{status: attrappe.Schluessel(t), weiter: attrappe.Schluessel(t), pflege: attrappe.Schluessel(t), imager: attrappe.Schluessel(t)}
	a.b = attrappe.NeueBruecke(t, a.imager.PublicKey())
	notfall := attrappe.Schluessel(t)
	a.k = werkbank.Konfig{
		Adresse:           a.b.Adresse,
		HostDatei:         filepath.Join(t.TempDir(), "werkbank-hostschluessel.pub"),
		Status:            a.status,
		Weiterleitung:     a.weiter,
		Pflege:            a.pflege,
		Einrichten:        a.imager,
		Notfall:           strings.TrimSpace(string(ssh.MarshalAuthorizedKey(notfall.PublicKey()))) + " voltpilot-notfall",
		Netz:              "wlan0",
		Werkstatt:         "eth0",
		WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24"), netip.MustParsePrefix("192.168.1.2/24"), netip.MustParsePrefix("10.213.0.2/24")},
		Ziele:             []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22"), netip.MustParseAddrPort("192.168.8.1:80"), netip.MustParseAddrPort("192.168.1.1:22"), netip.MustParseAddrPort("192.168.1.1:80"), netip.MustParseAddrPort("10.213.0.1:22"), netip.MustParseAddrPort("10.213.0.1:8484")},
		SSHQuellen:        []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")},
		Zeitlimit:         5 * time.Second,
	}
	return a
}

func (a aufbau) client(t *testing.T) *werkbank.Client {
	t.Helper()
	c, err := werkbank.Neu(a.k, logs.Neu(io.Discard, "text", nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Schliesse)
	return c
}

func TestErstesEinrichtenDannPflegeDannNichts(t *testing.T) {
	a := neu(t)
	c := a.client(t)
	ctx := context.Background()
	if _, err := c.Status(ctx); !werkbank.Abgewiesen(err) {
		t.Fatalf("vor dem Einrichten: %v", err)
	}
	s, erg, err := c.Bereit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := c.Paket()
	if erg == nil || erg.Weg != "eingerichtet" || s.Fassung != p.Fassung || a.b.Fassung() != p.Fassung {
		t.Fatalf("Ergebnis %+v, Status %+v", erg, s)
	}
	// Die Zeilen in authorized_keys: jeder Schlüssel mit seiner Einschränkung.
	zeilen := map[string]attrappe.Zeile{}
	for _, z := range a.b.Zeilen() {
		zeilen[z.Kommentar] = z
	}
	opt := func(name string) string { return strings.Join(zeilen[name].Optionen, ",") }
	if o := opt(werkbank.NameStatus); o != `restrict,command="sudo -n /usr/local/sbin/vp-werkbank-status"` {
		t.Errorf("Status: %s", o)
	}
	if o := opt(werkbank.NameWeiterleitung); !strings.HasPrefix(o, `restrict,port-forwarding,command="/bin/false",permitopen="192.168.8.1:22"`) || strings.Count(o, "permitopen") != 6 {
		t.Errorf("Weiterleitung: %s", o)
	}
	if o := opt(werkbank.NamePflege); o != `restrict,command="/usr/local/bin/vp-werkbank-pflege"` {
		t.Errorf("Pflege: %s", o)
	}
	if o := opt("voltpilot-notfall"); o != "no-agent-forwarding,no-X11-forwarding,no-user-rc" {
		t.Errorf("Notfall: %s", o)
	}
	// Host-Schlüssel beim ersten Kontakt festgehalten
	b, err := os.ReadFile(a.k.HostDatei)
	if err != nil {
		t.Fatal(err)
	}
	if pk, _, _, _, _ := ssh.ParseAuthorizedKey(b); pk == nil || ssh.FingerprintSHA256(pk) != ssh.FingerprintSHA256(a.b.Host.PublicKey()) || c.HostSchluessel() != ssh.FingerprintSHA256(pk) {
		t.Fatal("Host-Schlüssel nicht festgehalten")
	}

	// Der Imager-Benutzer kommt danach nicht mehr herein: alte Fassung → Pflege
	a.b.SetzeFassung("aaaaaaaaaaaaaaaa")
	_, erg, err = c.Bereit(ctx)
	if err != nil || erg == nil || erg.Weg != "gepflegt" {
		t.Fatalf("Pflege: %+v %v", erg, err)
	}
	// gleiche Fassung: nichts zu tun
	_, erg, err = c.Bereit(ctx)
	if err != nil || erg != nil {
		t.Fatalf("ohne Änderung: %+v %v", erg, err)
	}
	ein, gepf := a.b.Zaehler()
	if ein != 1 || gepf != 1 {
		t.Fatalf("eingerichtet %d, gepflegt %d", ein, gepf)
	}
}

func TestFremderHostSchluesselRichtetNieEin(t *testing.T) {
	a := neu(t)
	fremd := attrappe.Schluessel(t)
	_ = os.WriteFile(a.k.HostDatei, ssh.MarshalAuthorizedKey(fremd.PublicKey()), 0o600)
	c := a.client(t)
	_, _, err := c.Bereit(context.Background())
	var hf werkbank.HostFremd
	if !errors.As(err, &hf) {
		t.Fatalf("erwartet HostFremd, bekommen %v", err)
	}
	if e, _ := a.b.Zaehler(); e != 0 {
		t.Fatal("trotz fremdem Host-Schlüssel eingerichtet")
	}
	// fest konfigurierter Fingerabdruck
	a2 := neu(t)
	a2.k.HostSchluessel = ssh.FingerprintSHA256(fremd.PublicKey())
	if _, err := a2.client(t).Status(context.Background()); !errors.As(err, &hf) {
		t.Fatalf("Pin: %v", err)
	}
}

func TestOhneWerkstattSchluesselKeinEinrichten(t *testing.T) {
	a := neu(t)
	a.k.Einrichten = nil
	if _, _, err := a.client(t).Bereit(context.Background()); err == nil || !strings.Contains(err.Error(), "kein Werkstatt-Schlüssel") {
		t.Fatalf("%v", err)
	}
}

func TestEinrichtenScheitertMitGrund(t *testing.T) {
	a := neu(t)
	a.b.EinrichtenScheitert = true
	_, _, err := a.client(t).Bereit(context.Background())
	if err == nil || !strings.Contains(err.Error(), "SSH-Konfiguration ungültig") {
		t.Fatalf("%v", err)
	}
}

func TestWeiterleitungNurZuWerkstattZielen(t *testing.T) {
	a := neu(t)
	// Eine "Box" hinter der Brücke: ein Lauscher, der sich meldet.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("SSH-2.0-dropbear_2025.89\r\n"))
			_ = c.Close()
		}
	}()
	a.b.Ziele["192.168.1.1:22"] = ln.Addr().String()
	c := a.client(t)
	ctx := context.Background()
	if _, _, err := c.Bereit(ctx); err != nil {
		t.Fatal(err)
	}
	conn, err := c.Dial(ctx, netip.MustParseAddrPort("192.168.1.1:22"))
	if err != nil {
		t.Fatal(err)
	}
	gruss, _ := io.ReadAll(conn)
	_ = conn.Close()
	if !strings.HasPrefix(string(gruss), "SSH-2.0-dropbear") {
		t.Fatalf("Gruß %q", gruss)
	}
	// Ziel, das der Dienst nicht kennt: abgelehnt, bevor die Brücke gefragt wird
	vorher := len(a.b.Befehle())
	if _, err := c.Dial(ctx, netip.MustParseAddrPort("192.168.0.1:22")); err == nil || !strings.Contains(err.Error(), "keine Werkstatt-Adresse") {
		t.Fatalf("%v", err)
	}
	if len(a.b.Befehle()) != vorher {
		t.Fatal("Brücke wurde trotzdem gefragt")
	}
	// erlaubtes Ziel, an dem niemand antwortet: Grund der Brücke
	if _, err := c.Dial(ctx, netip.MustParseAddrPort("10.213.0.1:8484")); err == nil || !strings.Contains(err.Error(), "No route to host") {
		t.Fatalf("%v", err)
	}
}

// Die Attrappe setzt permitopen durch: der Status-Schlüssel darf nicht
// weiterleiten, der Weiterleitungs-Schlüssel nur zu seinen Zielen.
func TestBrueckeSetztEinschraenkungenDurch(t *testing.T) {
	a := neu(t)
	c := a.client(t)
	if _, _, err := c.Bereit(context.Background()); err != nil {
		t.Fatal(err)
	}
	verbinde := func(s ssh.Signer) *ssh.Client {
		cl, err := ssh.Dial("tcp", a.b.Adresse, &ssh.ClientConfig{User: "werkstatt", Auth: []ssh.AuthMethod{ssh.PublicKeys(s)}, HostKeyCallback: ssh.InsecureIgnoreHostKey()})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cl.Close() })
		return cl
	}
	if _, err := verbinde(a.status).Dial("tcp", "192.168.1.1:22"); err == nil || !strings.Contains(err.Error(), "prohibited") {
		t.Fatalf("Status-Schlüssel leitet weiter: %v", err)
	}
	if _, err := verbinde(a.weiter).Dial("tcp", "192.168.0.1:80"); err == nil || !strings.Contains(err.Error(), "prohibited") {
		t.Fatalf("Weiterleitung zu fremdem Ziel: %v", err)
	}
	s, _ := verbinde(a.pflege).NewSession()
	out, _ := s.CombinedOutput("id")
	if !strings.Contains(string(out), "kennt nur: einrichten") {
		t.Fatalf("Pflege-Schlüssel führt anderes aus: %s", out)
	}
}
