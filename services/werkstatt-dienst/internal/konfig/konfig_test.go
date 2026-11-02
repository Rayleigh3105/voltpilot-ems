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

func TestFuerDienst(t *testing.T) {
	k, err := Lies(umgebung(map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50"}), false)
	if err != nil {
		t.Fatal(err)
	}
	if err := k.PruefeFuerDienst(); err == nil || !strings.Contains(err.Error(), "VP_WERKSTATT_PASSWORT_EMPFAENGER") || !strings.Contains(err.Error(), "VP_WARTUNG_PUBKEY") {
		t.Fatalf("%v", err)
	}
	k, err = Lies(umgebung(map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50",
		"VP_WERKSTATT_PASSWORT_EMPFAENGER": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
		"VP_WARTUNG_PUBKEY":                "c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU="}), false)
	if err != nil || k.PruefeFuerDienst() != nil {
		t.Fatalf("%v", err)
	}
	if k.LanBruecke.String() != "10.213.0.2" || k.BoxNetz.String() != "10.10.16.0/20" || len(k.DNS) != 2 || k.Bauart != "mipsle" || k.Steuerung == "" {
		t.Fatalf("%+v", k)
	}
}

func TestAPIQuelle(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{DateiStatus, DateiWeiterleitung, DateiPflege} {
		pem, _ := attrappe.SchluesselPEM(t)
		_ = os.WriteFile(filepath.Join(dir, n), pem, 0o600)
	}
	pub := filepath.Join(dir, "notfall.pub")
	_ = os.WriteFile(pub, ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()), 0o644)
	env := map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50", "VP_WERKSTATT_GEHEIM": dir, "VP_WERKSTATT_NOTFALL_PUB": pub,
		"VP_WERKSTATT_API_URL": "https://portal.example"}
	if _, err := Lies(umgebung(env), true); err == nil || !strings.Contains(err.Error(), "VP_WERKSTATT_TOKEN_URL") || !strings.Contains(err.Error(), DateiClientSecret) {
		t.Fatalf("%v", err)
	}
	env["VP_WERKSTATT_TOKEN_URL"] = "https://portal.example/auth/realms/voltpilot/protocol/openid-connect/token"
	_ = os.WriteFile(filepath.Join(dir, DateiClientSecret), []byte("dienst-secret-123\n"), 0o600)
	k, err := Lies(umgebung(env), true)
	if err != nil {
		t.Fatal(err)
	}
	if k.ClientID != "voltpilot-werkstatt-dienst" || k.ClientSecret.Offenbaren() != "dienst-secret-123" || geheim.Schwaerze("dienst-secret-123") != geheim.Ersatz {
		t.Fatalf("%+v", k)
	}
}

func TestTechnikerZugang(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{DateiStatus, DateiWeiterleitung, DateiPflege} {
		pem, _ := attrappe.SchluesselPEM(t)
		_ = os.WriteFile(filepath.Join(dir, n), pem, 0o600)
	}
	pub := filepath.Join(dir, "notfall.pub")
	_ = os.WriteFile(pub, ssh.MarshalAuthorizedKey(attrappe.Schluessel(t).PublicKey()), 0o644)
	env := map[string]string{"VP_WERKBANK_ADRESSE": "192.0.2.50", "VP_WERKSTATT_GEHEIM": dir, "VP_WERKSTATT_NOTFALL_PUB": pub,
		"VP_WERKSTATT_TECHNIKER_ADRESSE": "10.10.32.50"}
	// Ohne API: abgelehnt (die Probe braucht das Fenster der Einlösung).
	if _, err := Lies(umgebung(env), true); err == nil || !strings.Contains(err.Error(), "VP_WERKSTATT_API_URL") {
		t.Fatalf("%v", err)
	}
	env["VP_WERKSTATT_API_URL"] = "https://portal.example"
	env["VP_WERKSTATT_TOKEN_URL"] = "https://portal.example/token"
	_ = os.WriteFile(filepath.Join(dir, DateiClientSecret), []byte("s3cret-dienst\n"), 0o600)
	// Nur die Adresse: die Schlüssel fehlen.
	if _, err := Lies(umgebung(env), true); err == nil || !strings.Contains(err.Error(), DateiTechnikerWG) || !strings.Contains(err.Error(), DateiTechnikerSSH) {
		t.Fatalf("%v", err)
	}
	if _, _, err := wartungSchluessel(dir); err != nil {
		t.Fatal(err)
	}
	k, err := Lies(umgebung(env), true)
	if err != nil {
		t.Fatal(err)
	}
	if k.TechnikerAdresse.String() != "10.10.32.50" || k.TechnikerSSH == nil || k.TechnikerWG.Leer() {
		t.Fatalf("%+v", k)
	}
	// Ohne alles: keine Probe über den Tunnel, kein Fehler.
	leer := t.TempDir()
	for _, n := range []string{DateiStatus, DateiWeiterleitung, DateiPflege} {
		pem, _ := attrappe.SchluesselPEM(t)
		_ = os.WriteFile(filepath.Join(leer, n), pem, 0o600)
	}
	_ = os.WriteFile(filepath.Join(leer, DateiClientSecret), []byte("s3cret-dienst\n"), 0o600)
	env["VP_WERKSTATT_GEHEIM"] = leer
	delete(env, "VP_WERKSTATT_TECHNIKER_ADRESSE")
	if k, err := Lies(umgebung(env), true); err != nil || k.TechnikerSSH != nil {
		t.Fatalf("%v %+v", err, k.TechnikerSSH)
	}
}
