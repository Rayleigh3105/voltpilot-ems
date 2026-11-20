package konfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func schreibe(t *testing.T, inhalt string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "konfig")
	if err := os.WriteFile(p, []byte(inhalt), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestVorgabenUndAbleitungen(t *testing.T) {
	k, err := Lies(schreibe(t, "# Wartungstunnel\nadresse = 10.10.16.7\nserver_pubkey = abc=\n"))
	if err != nil {
		t.Fatal(err)
	}
	if k.Endpunkt != "wartung.voltpilot.de:51820" || len(k.Netze) != 1 || k.Netze[0].String() != "10.10.32.0/24" {
		t.Fatalf("Vorgaben: %+v", k)
	}
	// Die Schlüsselausgabe: Server-Adresse im Techniker-Netz, Port 8022.
	if k.SchluesselServer.String() != "10.10.32.1:8022" || !k.Web || k.WebZiel != "127.0.0.1:8484" {
		t.Fatalf("Ableitungen: %+v", k)
	}
	if k.Dauerhaft != "/root/.ssh/authorized_keys" || k.WGSchluessel != "/home/voltpilot/wartung/wg.key" {
		t.Fatalf("Orte: %+v", k)
	}
}

func TestAllesGesetzt(t *testing.T) {
	k, err := Lies(schreibe(t, `adresse=10.10.16.9
endpunkt = 203.0.113.5:1001
server_pubkey = xyz=
netz = 10.20.0.0/16, 10.30.1.0/24
schluessel_server = 10.20.0.1:9000
web = zu
hostkeys = /a, /b
dauerhaft = /x/authorized_keys
ereignisse = /x/ereignisse
stand = /run/s
wg_schluessel = /x/wg.key
`))
	if err != nil {
		t.Fatal(err)
	}
	if k.Adresse.String() != "10.10.16.9" || k.Endpunkt != "203.0.113.5:1001" || len(k.Netze) != 2 ||
		k.SchluesselServer.String() != "10.20.0.1:9000" || k.Web || len(k.Hostkeys) != 2 || k.Stand != "/run/s" {
		t.Fatalf("%+v", k)
	}
}

func TestFehlerNennenDieZeile(t *testing.T) {
	for inhalt, teil := range map[string]string{
		"server_pubkey = abc=\n":                                           "adresse fehlt",
		"adresse = 10.10.16.7\n":                                           "server_pubkey fehlt",
		"adresse = fe80::1\nserver_pubkey = a\n":                           "keine IPv4-Adresse",
		"adresse = 10.10.16.7\nserver_pubkey = a\nadrese = 1\n":            "unbekannte Angabe",
		"adresse = 10.10.16.7\nserver_pubkey = a\nohne gleichzeichen\n":    "Zeile 3",
		"adresse = 10.10.16.7\nserver_pubkey = a\nweb = vielleicht\n":      "\"netz\" oder \"zu\"",
		"adresse = 10.10.16.7\nserver_pubkey = a\nendpunkt = ohne-port\n":  "nicht name:port",
		"adresse = 10.10.16.7\nserver_pubkey = a\nnetz = 10.0.0.0\n":       "kein IPv4-Netz",
		"adresse = 10.10.16.7\nserver_pubkey = a\nschluessel_server = x\n": "keine Adresse mit Port",
	} {
		if _, err := Lies(schreibe(t, inhalt)); err == nil || !strings.Contains(err.Error(), teil) {
			t.Errorf("%q: %v (erwartet: %s)", inhalt, err, teil)
		}
	}
	if _, err := Lies(filepath.Join(t.TempDir(), "fehlt")); !os.IsNotExist(err) {
		t.Fatalf("fehlende Datei: %v", err)
	}
}
