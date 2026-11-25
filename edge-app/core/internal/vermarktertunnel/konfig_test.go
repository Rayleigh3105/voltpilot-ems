package vermarktertunnel

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func beispielZugang() Zugang {
	return Zugang{
		Gegenstelle:   Gegenstelle{Host: "vpn.luox-energy.de", Port: 1194, Protokoll: "udp"},
		TLSSchluessel: "tls_crypt",
		GueltigBis:    time.Date(2027, 6, 2, 0, 0, 0, 0, time.UTC),
		Fingerabdruck: "ab12cd",
	}
}

func beispielPfade() Pfade {
	return Pfade{Dir: "/etc/vp-edge-light/vermarkter", RAM: "/tmp/vp-vermarkter"}
}

// The generated configuration is the box's OWN, built from the validated
// facts - this test pins every security-relevant line of concept §8.
func TestOpenVPNKonfigTraegtDieSicherheitsregeln(t *testing.T) {
	raw, err := OpenVPNKonfig(beispielZugang(), beispielPfade(), KonfigOptionen{})
	if err != nil {
		t.Fatal(err)
	}
	konfig := string(raw)
	for _, zeile := range []string{
		"client\n",
		"dev vp_vermarkter\n",
		"proto udp\n",
		"remote vpn.luox-energy.de 1194\n",
		"connect-retry 5 300\n", // the growing back-off of baut_auf
		"remote-cert-tls server\n",
		"script-security 0\n",
		"route-nopull\n",
		"pull-filter ignore \"route \"\n",
		"pull-filter ignore \"route-ipv6 \"\n",
		"pull-filter ignore \"redirect-gateway\"\n",
		"pull-filter ignore \"dhcp-option \"\n",
		"pull-filter ignore \"block-outside-dns\"\n",
		"user nobody\n",
		"group nogroup\n",
		"keepalive 10 60\n",
		"ca /etc/vp-edge-light/vermarkter/zugang/ca.pem\n",
		"cert /etc/vp-edge-light/vermarkter/zugang/zertifikat.pem\n",
		"key /etc/vp-edge-light/vermarkter/zugang/schluessel.pem\n",
		"tls-crypt /etc/vp-edge-light/vermarkter/zugang/tls.key\n",
		"daemon\n",
		"writepid /tmp/vp-vermarkter/openvpn.pid\n",
		"status /tmp/vp-vermarkter/stand 10\n",
	} {
		if !strings.Contains(konfig, zeile) {
			t.Errorf("Konfiguration ohne %q", strings.TrimSpace(zeile))
		}
	}
	// No script hooks, no management surface, no pushed-anything acceptance.
	for _, verboten := range []string{"up ", "down ", "management", "redirect-gateway\ndev"} {
		for _, zeile := range strings.Split(konfig, "\n") {
			if strings.HasPrefix(zeile, verboten) {
				t.Errorf("Konfiguration traegt verbotene Zeile %q", zeile)
			}
		}
	}
}

func TestOpenVPNKonfigVarianten(t *testing.T) {
	z := beispielZugang()
	z.Gegenstelle.Protokoll = "tcp"
	z.TLSSchluessel = "tls_auth"
	raw, err := OpenVPNKonfig(z, beispielPfade(), KonfigOptionen{Nutzer: "-", Gruppe: "-"})
	if err != nil {
		t.Fatal(err)
	}
	konfig := string(raw)
	if !strings.Contains(konfig, "proto tcp-client\n") {
		t.Error("tcp wird nicht als tcp-client gewaehlt")
	}
	if !strings.Contains(konfig, "tls-auth /etc/vp-edge-light/vermarkter/zugang/tls.key 1\n") {
		t.Error("tls-auth ohne Client-Richtung 1")
	}
	if strings.Contains(konfig, "user ") || strings.Contains(konfig, "group ") {
		t.Error("Nutzer '-' soll die Direktive weglassen")
	}

	z.TLSSchluessel = "keine"
	raw, err = OpenVPNKonfig(z, beispielPfade(), KonfigOptionen{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "tls.key") {
		t.Error("ohne TLS-Schluessel darf keine tls-Zeile entstehen")
	}
}

// A delivered host must never be able to smuggle extra directives into the
// generated file (newline, space, quote) - the validation and the generator
// both refuse it.
func TestOpenVPNKonfigVerweigertEinschleusen(t *testing.T) {
	for _, host := range []string{"a b", "a\nredirect-gateway", `a"b`, "", "-remote"} {
		z := beispielZugang()
		z.Gegenstelle.Host = host
		if _, err := OpenVPNKonfig(z, beispielPfade(), KonfigOptionen{}); err == nil {
			t.Errorf("Host %q angenommen", host)
		}
	}
}

func schreibeZugang(t *testing.T, dir string, z string, pem bool) {
	t.Helper()
	zdir := filepath.Join(dir, ZugangOrdner)
	if err := os.MkdirAll(zdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(zdir, ZugangDatei), []byte(z), 0o600); err != nil {
		t.Fatal(err)
	}
	if pem {
		for _, name := range []string{CADatei, ZertifikatDatei, SchluesselDatei, TLSSchluesselDatei} {
			inhalt := "-----BEGIN TEST-----\nAAA\n-----END TEST-----\n"
			if err := os.WriteFile(filepath.Join(zdir, name), []byte(inhalt), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

const gueltigerZugang = `{"gegenstelle":{"host":"vpn.luox-energy.de","port":1194,"protokoll":"udp"},` +
	`"tls_schluessel":"tls_crypt","gueltig_bis":"2027-06-02T00:00:00Z","fingerabdruck":"ab"}`

func TestLadeZugang(t *testing.T) {
	dir := t.TempDir()
	if _, ok, err := LadeZugang(dir); ok || err != nil {
		t.Fatalf("leerer Ordner: ok=%v err=%v, want ohne_zugang", ok, err)
	}
	schreibeZugang(t, dir, gueltigerZugang, true)
	z, ok, err := LadeZugang(dir)
	if !ok || err != nil {
		t.Fatalf("gueltiger Zugang: ok=%v err=%v", ok, err)
	}
	if z.Gegenstelle.Host != "vpn.luox-energy.de" || z.TLSSchluessel != "tls_crypt" {
		t.Errorf("Zugang = %+v", z)
	}
	if z.Abgelaufen(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Error("nicht abgelaufen, aber als abgelaufen gemeldet")
	}
	if !z.Abgelaufen(time.Date(2027, 7, 1, 0, 0, 0, 0, time.UTC)) {
		t.Error("abgelaufen, aber nicht gemeldet")
	}

	// a missing key file is unusable material, not "no access"
	if err := os.Remove(filepath.Join(dir, ZugangOrdner, SchluesselDatei)); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := LadeZugang(dir); ok || err == nil {
		t.Errorf("fehlender Schluessel: ok=%v err=%v, want Fehler", ok, err)
	}
}

func TestLadeZugangVerweigertUnbrauchbares(t *testing.T) {
	faelle := map[string]string{
		"host":      `{"gegenstelle":{"host":"a b","port":1194,"protokoll":"udp"},"tls_schluessel":"keine"}`,
		"port":      `{"gegenstelle":{"host":"a","port":0,"protokoll":"udp"},"tls_schluessel":"keine"}`,
		"protokoll": `{"gegenstelle":{"host":"a","port":1,"protokoll":"icmp"},"tls_schluessel":"keine"}`,
		"tls":       `{"gegenstelle":{"host":"a","port":1,"protokoll":"udp"},"tls_schluessel":"vielleicht"}`,
	}
	for name, inhalt := range faelle {
		dir := t.TempDir()
		schreibeZugang(t, dir, inhalt, true)
		if _, ok, err := LadeZugang(dir); ok || err == nil {
			t.Errorf("%s: angenommen (ok=%v err=%v)", name, ok, err)
		}
	}
}

func TestLadeAnschluss(t *testing.T) {
	dir := t.TempDir()
	if _, ok, err := LadeAnschluss(dir); ok || err != nil {
		t.Fatalf("ohne Datei: ok=%v err=%v", ok, err)
	}
	if err := os.WriteFile(filepath.Join(dir, AnschlussDatei), []byte(`{"partner":"luox","referenz_wp":12000}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a, ok, err := LadeAnschluss(dir)
	if !ok || err != nil || a.Partner != "luox" || a.ReferenzWp != 12000 {
		t.Fatalf("a=%+v ok=%v err=%v", a, ok, err)
	}
	// without a positive reference the percent set-point has no meaning in kW
	if err := os.WriteFile(filepath.Join(dir, AnschlussDatei), []byte(`{"partner":"luox"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := LadeAnschluss(dir); ok || err == nil {
		t.Error("Anschluss ohne referenz_wp angenommen")
	}
}

func TestNftRegeln(t *testing.T) {
	regeln := string(NftRegeln("10.8.0.6", 502))
	for _, zeile := range []string{
		`iifname "vp_vermarkter" ip daddr 10.8.0.6 tcp dport 502 counter accept`,
		`iifname "vp_vermarkter" counter drop`,
		"hook forward",
		`oifname "vp_vermarkter" counter drop`,
		`oifname "vp_vermarkter" tcp sport 502 ct state established counter accept`,
	} {
		if !strings.Contains(regeln, zeile) {
			t.Errorf("Regeln ohne %q", zeile)
		}
	}
	// without an address NOTHING is accepted inbound
	ohne := string(NftRegeln("", 502))
	if strings.Contains(ohne, "accept comment \"vp-vermarkter: nur die Schnittstelle\"") {
		t.Error("ohne Tunnel-Adresse darf es keine Annahme-Regel geben")
	}
	// a non-address never reaches the ruleset
	kaputt := string(NftRegeln("10.8.0.6; flush ruleset", 502))
	if strings.Contains(kaputt, "flush") {
		t.Error("eine Nicht-Adresse gehoert nicht in die Regeln")
	}
}
