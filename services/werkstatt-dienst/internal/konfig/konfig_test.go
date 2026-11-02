package konfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

func umgebung(m map[string]string) Umgebung { return func(k string) string { return m[k] } }

func TestVorgabenUndAbleitung(t *testing.T) {
	k, err := Lies(umgebung(map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50"}), false)
	if err != nil {
		t.Fatal(err)
	}
	if k.Takt != 10*time.Second || k.Anzeige != "127.0.0.1:8101" || k.HTTP != ":8100" || k.LanNetz.String() != "10.213.0.1/24" {
		t.Fatalf("%+v", k)
	}
	w := k.Werkbank
	if w.Netz != "wlan0" || w.Werkstatt != "eth0" || w.EinrichtenBenutzer != "vpwerkstatt" || !strings.HasSuffix(w.HostDatei, "/werkbank-hostschluessel.pub") {
		t.Fatalf("%+v", w)
	}
	var adr, ziele, quellen []string
	for _, a := range w.WerkstattAdressen {
		adr = append(adr, a.String())
	}
	for _, z := range w.Ziele {
		ziele = append(ziele, z.String())
	}
	for _, q := range w.SSHQuellen {
		quellen = append(quellen, q.String())
	}
	if strings.Join(adr, " ") != "192.168.8.2/24 192.168.1.2/24 10.213.0.2/24" ||
		strings.Join(ziele, " ") != "192.168.8.1:22 192.168.8.1:80 192.168.1.1:22 192.168.1.1:80 10.213.0.1:22 10.213.0.1:8484" ||
		strings.Join(quellen, " ") != "192.168.178.241/32 192.168.178.242/32 192.168.178.243/32" {
		t.Fatalf("%v | %v | %v", adr, ziele, quellen)
	}
	// Box auf .2: die Brücke nimmt .3
	k, _ = Lies(umgebung(map[string]string{"VP_WERKBANK_ADRESSE": "x", "VP_WERKSTATT_LAN_NETZ": "10.77.5.2/24"}), false)
	if k.Werkbank.WerkstattAdressen[2].String() != "10.77.5.3/24" {
		t.Fatalf("%v", k.Werkbank.WerkstattAdressen)
	}
}

func TestUngueltig(t *testing.T) {
	faelle := map[string]map[string]string{
		"ohne Brücke":    {},
		"Anzeige offen":  {"VP_WERKSTATT_ANZEIGE": "0.0.0.0:8101"},
		"LAN Werksnetz":  {"VP_WERKSTATT_LAN_NETZ": "192.168.8.1/24"},
		"LAN OpenWrt":    {"VP_WERKSTATT_LAN_NETZ": "192.168.1.5/24"},
		"LAN öffentlich": {"VP_WERKSTATT_LAN_NETZ": "203.0.113.1/24"},
		"LAN /16":        {"VP_WERKSTATT_LAN_NETZ": "10.213.0.1/16"},
		"Takt":           {"VP_WERKSTATT_TAKT": "100ms"},
		"Quelle /8":      {"VP_WERKBANK_SSH_QUELLEN": "10.0.0.0/8"},
		"Host-Schlüssel": {"VP_WERKBANK_HOSTSCHLUESSEL": "MD5:aa"},
	}
	for name, m := range faelle {
		if name != "ohne Brücke" {
			m["VP_WERKBANK_ADRESSE"] = "192.0.2.50"
		}
		if _, err := Lies(umgebung(m), false); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

func TestSchluesselAusDateien(t *testing.T) {
	dir := t.TempDir()
	var pems [][]byte
	for _, n := range []string{DateiStatus, DateiWeiterleitung, DateiPflege} {
		pem, _ := attrappe.SchluesselPEM(t)
		pems = append(pems, pem)
		_ = os.WriteFile(filepath.Join(dir, n), pem, 0o600)
	}
	pub := filepath.Join(dir, "notfall.pub")
	n := attrappe.Schluessel(t)
	_ = os.WriteFile(pub, append(ssh.MarshalAuthorizedKey(n.PublicKey())[:len(ssh.MarshalAuthorizedKey(n.PublicKey()))-1], []byte(" voltpilot-notfall\n")...), 0o644)
	env := map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50", "VP_WERKSTATT_GEHEIM": dir, "VP_WERKSTATT_NOTFALL_PUB": pub}
	k, err := Lies(umgebung(env), true)
	if err != nil {
		t.Fatal(err)
	}
	if k.Werkbank.Status == nil || k.Werkbank.Einrichten != nil || !strings.HasSuffix(k.Werkbank.Notfall, "voltpilot-notfall") {
		t.Fatalf("%+v", k.Werkbank)
	}
	// Der private Schlüssel ist im Schwärzer.
	if strings.Contains(geheim.Schwaerze(string(pems[0])), "PRIVATE KEY-----\nb3Bl") {
		t.Fatal("privater Schlüssel nicht im Schwärzer")
	}
	_ = os.WriteFile(filepath.Join(dir, DateiPflege), []byte("kein schlüssel"), 0o600)
	if _, err := Lies(umgebung(env), true); err == nil || strings.Contains(err.Error(), "kein schlüssel") {
		t.Fatalf("%v", err)
	}
	delete(env, "VP_WERKSTATT_NOTFALL_PUB")
	if _, err := Lies(umgebung(env), true); err == nil {
		t.Fatal("ohne Notfall-Schlüssel angenommen")
	}
}
