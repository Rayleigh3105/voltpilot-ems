package soll

import (
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
)

var netze = Netze{Box: netip.MustParsePrefix("10.10.16.0/20"), Techniker: netip.MustParsePrefix("10.10.32.0/24")}

// Der Vertragsvektor, den auch die API (FernwartungRegelnTest) gegen ihre
// Serialisierung prüft. STRENG gelesen: ein neues Feld der API muss hier
// bekannt sein, bevor es ankommt.
func TestVertragsvektorWirdStrengGelesenUndIstGueltig(t *testing.T) {
	daten, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "fernwartung-soll-v1.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := LiesStreng(daten)
	if err != nil {
		t.Fatalf("Vertragsvektor streng lesen: %v", err)
	}
	g, befunde, err := Pruefe(s, netze)
	if err != nil || len(befunde) != 0 {
		t.Fatalf("Vektor nicht gültig: %v %v", err, befunde)
	}
	if len(g.Peers) != 3 || len(g.Fenster) != 1 {
		t.Fatalf("Peers %d, Fenster %d", len(g.Peers), len(g.Fenster))
	}
	f := g.Fenster[0]
	if f.Techniker.String() != "10.10.32.2" || f.Box.String() != "10.10.16.2" {
		t.Fatalf("Fenster aufgelöst zu %s -> %s", f.Techniker, f.Box)
	}
	if !f.Ende.Equal(time.Date(2026, 10, 7, 17, 30, 0, 0, time.UTC)) {
		t.Fatalf("Ende %s", f.Ende)
	}
	// Der SSH-Schlüssel steht nur am Techniker-Peer und kommt unverändert an.
	for _, p := range s.Peers {
		hat := strings.HasPrefix(p.SSHPublicKey, "ssh-rsa AAAAB3NzaC1yc2EA")
		if hat != (p.Art == ArtTechniker) {
			t.Fatalf("Peer %s (%s): sshPublicKey %q", p.Kennung, p.Art, p.SSHPublicKey)
		}
	}
}

// Der SSH-Schlüssel ist ein Zusatz: mit ihm, ohne ihn und mit einem
// unbrauchbaren Wert gilt für WireGuard und die Firewall derselbe Stand. Nur
// ein Schlüssel, der die eigene Prüfung besteht, geht weiter an die Ausgabe.
func TestSSHSchluesselAendertNichtsAnPeersUndFenstern(t *testing.T) {
	stand := func(ssh string) (Gueltig, []Befund) {
		s := basisSoll()
		s.Peers = []Peer{
			{Art: "box", ID: "b1", Kennung: "box", PublicKey: keyA, Adresse: "10.10.16.2"},
			{Art: "techniker", ID: "t1", Kennung: "tech", PublicKey: keyB, Adresse: "10.10.32.2", SSHPublicKey: ssh},
		}
		jetzt := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)
		s.Fenster = []Fenster{{ID: "f1", BoxID: "b1", TechnikerID: "t1", Beginn: jetzt, Ende: jetzt.Add(time.Hour)}}
		g, befunde, err := Pruefe(s, netze)
		if err != nil {
			t.Fatalf("ssh=%q: %v", ssh, err)
		}
		return g, befunde
	}
	ohneSSH := func(g Gueltig) Gueltig {
		kopie := Gueltig{Peers: map[string]PeerSoll{}, Fenster: g.Fenster}
		for k, p := range g.Peers {
			p.SSH = SSHSchluessel{}
			kopie.Peers[k] = p
		}
		return kopie
	}
	ohne, befunde := stand("")
	if len(befunde) != 0 || ohne.Peers[keyB].SSH.Zeile != "" {
		t.Fatalf("ohne Schlüssel: %v %+v", befunde, ohne.Peers[keyB])
	}

	gut := probe.SSHZeile(3072, 1)
	mit, befunde := stand(gut)
	if len(befunde) != 0 || mit.Peers[keyB].SSH.Zeile != gut || !strings.HasPrefix(mit.Peers[keyB].SSH.Fingerabdruck, "SHA256:") {
		t.Fatalf("mit Schlüssel: %v %+v", befunde, mit.Peers[keyB].SSH)
	}
	if !reflect.DeepEqual(ohneSSH(mit), ohne) {
		t.Fatal("ein SSH-Schlüssel ändert Peers oder Fenster")
	}

	// Unbrauchbar: der Peer und sein Fenster bleiben, der Schlüssel geht
	// nicht weiter, und das steht als Befund da - ohne den Wert zu wiederholen.
	for _, ssh := range []string{"ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB", "kein schluessel", gut + " kommentar"} {
		g, befunde := stand(ssh)
		if !reflect.DeepEqual(g, ohne) {
			t.Fatalf("ssh=%q ändert den geprüften Stand", ssh)
		}
		if len(befunde) != 1 || !strings.Contains(befunde[0].String(), "wird nicht ausgegeben") ||
			strings.Contains(befunde[0].String(), ssh) {
			t.Fatalf("ssh=%q: Befunde %v", ssh, befunde)
		}
	}

	// An einer Box hat ein SSH-Schlüssel nichts verloren.
	s := basisSoll()
	s.Peers = []Peer{{Art: "box", ID: "b1", Kennung: "box", PublicKey: keyA, Adresse: "10.10.16.2", SSHPublicKey: gut}}
	g, befunde, err := Pruefe(s, netze)
	if err != nil || len(g.Peers) != 1 || g.Peers[keyA].SSH.Zeile != "" || len(befunde) != 1 {
		t.Fatalf("%v %+v %v", err, g, befunde)
	}

	// Ohne Schlüssel fehlt das Feld, wie es die API liefert.
	roh, err := json.Marshal(Peer{Art: "box", ID: "b1"})
	if err != nil || strings.Contains(string(roh), "sshPublicKey") {
		t.Fatalf("%s %v", roh, err)
	}
}

// Der Schlüssel des Vertragsvektors: dieselbe Zeile, derselbe Fingerabdruck,
// den die API berechnet und `ssh-keygen -lf` zeigt (Beispiel im OpenAPI).
func TestSSHSchluesselDesVertragsvektors(t *testing.T) {
	daten, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "fernwartung-soll-v1.example.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Lies(daten)
	if err != nil {
		t.Fatal(err)
	}
	g, _, err := Pruefe(s, netze)
	if err != nil {
		t.Fatal(err)
	}
	var ssh SSHSchluessel
	for _, p := range g.Peers {
		if p.Art == ArtTechniker {
			ssh = p.SSH
		}
	}
	if ssh.Fingerabdruck != "SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc" || ssh.Bits != 3072 ||
		!strings.HasPrefix(ssh.Zeile, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC65yGM") {
		t.Fatalf("%+v", ssh)
	}
}

// Was an eine Box geht, landet unverändert in ihrer Schlüsseldatei. Deshalb
// gilt nur die Normalform: eine Zeile, "ssh-rsa", keine Optionen, kein
// Kommentar - und innen ein RSA-Schlüssel von 2048 bis 4096 Bit.
func TestPruefeSSHSchluessel(t *testing.T) {
	for _, bits := range []int{2048, 3072, 4096} {
		zeile := probe.SSHZeile(bits, 7)
		ssh, err := PruefeSSHSchluessel(zeile)
		if err != nil || ssh.Zeile != zeile || ssh.Bits != bits || len(ssh.Fingerabdruck) != len("SHA256:")+43 {
			t.Errorf("%d Bit: %+v %v", bits, ssh, err)
		}
	}
	gut := probe.SSHZeile(2048, 1)
	b64 := strings.TrimPrefix(gut, "ssh-rsa ")
	e := probe.MPInt(big.NewInt(65537))
	n2048 := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 2047), big.NewInt(1))
	innen := func(typ string, e, n []byte) string { return "ssh-rsa " + probe.SSHBlob(typ, e, n) }
	roh, _ := base64.StdEncoding.DecodeString(b64)
	// Ein Schlüssel, dessen Base64 "+" und "/" enthält (die letzten Bytes des Moduls sind fb ff ff).
	mitSonderzeichen := probe.SSHZeile(2048, (0xfbffff-1)/2)
	if _, err := PruefeSSHSchluessel(mitSonderzeichen); err != nil || !strings.HasSuffix(mitSonderzeichen, "+///") {
		t.Fatalf("Prüfschlüssel mit Sonderzeichen: %v", err)
	}
	// Die Normalform eines 3072-Bit-Schlüssels endet mit einem Füllzeichen.
	mitFuellzeichen := probe.SSHZeile(3072, 1)
	if !strings.HasSuffix(mitFuellzeichen, "=") {
		t.Fatal("Prüfschlüssel ohne Füllzeichen")
	}
	schlecht := map[string]string{
		"leer":                              "",
		"nur der Typ":                       "ssh-rsa",
		"Typ und Leerzeichen":               "ssh-rsa ",
		"Kommentar dahinter":                gut + " max@laptop",
		"Leerzeichen dahinter":              gut + " ",
		"Zeilenumbruch dahinter":            gut + "\n",
		"zweite Zeile":                      gut + "\n" + probe.SSHZeile(2048, 2),
		"Wagenrücklauf":                     gut + "\r",
		"Option davor":                      `command="/bin/sh" ` + gut,
		"restrict davor":                    "restrict " + gut,
		"Leerzeichen davor":                 " " + gut,
		"Tabulator statt Leerzeichen":       "ssh-rsa\t" + b64,
		"zwei Leerzeichen":                  "ssh-rsa  " + b64,
		"Ed25519":                           "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
		"ECDSA":                             "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=",
		"Typ außen RSA, innen Ed25519":      innen("ssh-ed25519", e, probe.MPInt(n2048)),
		"privater Schlüssel":                "-----BEGIN OPENSSH PRIVATE KEY-----",
		"1024 Bit":                          probe.SSHZeile(1024, 1),
		"2047 Bit":                          probe.SSHZeile(2047, 1),
		"4097 Bit":                          probe.SSHZeile(4097, 1),
		"8192 Bit":                          probe.SSHZeile(8192, 1),
		"gerader Modul":                     innen("ssh-rsa", e, probe.MPInt(new(big.Int).Lsh(big.NewInt(1), 2047))),
		"Exponent 1":                        innen("ssh-rsa", probe.MPInt(big.NewInt(1)), probe.MPInt(n2048)),
		"gerader Exponent":                  innen("ssh-rsa", probe.MPInt(big.NewInt(65536)), probe.MPInt(n2048)),
		"Exponent über 32 Bit":              innen("ssh-rsa", probe.MPInt(new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 33), big.NewInt(1))), probe.MPInt(n2048)),
		"Modul nicht kürzestmöglich":        innen("ssh-rsa", e, append([]byte{0}, probe.MPInt(n2048)...)),
		"Modul mit Vorzeichenbit":           innen("ssh-rsa", e, n2048.Bytes()),
		"leerer Exponent":                   innen("ssh-rsa", nil, probe.MPInt(n2048)),
		"Bytes hinter dem Schlüssel":        "ssh-rsa " + base64.StdEncoding.EncodeToString(append(append([]byte{}, roh...), 0)),
		"abgeschnitten":                     gut[:len(gut)-40],
		"Feldlänge über das Ende hinaus":    "ssh-rsa " + base64.StdEncoding.EncodeToString(roh[:len(roh)-3]),
		"Base64 ohne Füllzeichen":           strings.TrimSuffix(mitFuellzeichen, "="),
		"Zeichen außerhalb von Base64":      "ssh-rsa " + b64[:20] + "*" + b64[21:],
		"URL-Base64":                        strings.NewReplacer("+", "-", "/", "_").Replace(mitSonderzeichen),
		"länger als jeder zulässige":        "ssh-rsa " + strings.Repeat("A", 2000),
		"anderer Typ mit ssh-rsa im Inhalt": "ssh-dss " + b64,
	}
	for name, zeile := range schlecht {
		ssh, err := PruefeSSHSchluessel(zeile)
		if err == nil {
			t.Errorf("%s: angenommen (%+v)", name, ssh)
			continue
		}
		if len(zeile) > 12 && strings.Contains(err.Error(), zeile[8:]) {
			t.Errorf("%s: die Meldung wiederholt die Eingabe: %v", name, err)
		}
	}
}

func TestUnbekannteFelderSindImBetriebErlaubt(t *testing.T) {
	s, err := Lies([]byte(`{"version":1,"neuesFeld":true,"boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24","peers":[],"fenster":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Pruefe(s, netze); err != nil {
		t.Fatal(err)
	}
	if _, err := LiesStreng([]byte(`{"version":1,"neuesFeld":true}`)); err == nil {
		t.Fatal("streng muss unbekannte Felder ablehnen")
	}
}

func TestDasGanzeDokumentWirdVerworfen(t *testing.T) {
	for name, s := range map[string]Soll{
		"version":        {Version: 2, BoxNetz: "10.10.16.0/20", TechnikerNetz: "10.10.32.0/24"},
		"box-netz":       {Version: 1, BoxNetz: "10.10.0.0/16", TechnikerNetz: "10.10.32.0/24"},
		"techniker-netz": {Version: 1, BoxNetz: "10.10.16.0/20", TechnikerNetz: "10.10.33.0/24"},
	} {
		if _, _, err := Pruefe(s, netze); err == nil {
			t.Errorf("%s: erwartet verworfen", name)
		}
	}
}

const (
	keyA = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="
	keyB = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="
	keyC = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="
	keyD = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c="
)

func basisSoll() Soll {
	return Soll{Version: 1, BoxNetz: "10.10.16.0/20", TechnikerNetz: "10.10.32.0/24"}
}

func TestEinzelneFehlerWerdenUebersprungenDerRestGilt(t *testing.T) {
	s := basisSoll()
	s.Peers = []Peer{
		{Art: "box", ID: "b1", Kennung: "edge-gut", PublicKey: keyA, Adresse: "10.10.16.2"},
		{Art: "box", ID: "b2", Kennung: "falsches-netz", PublicKey: keyB, Adresse: "10.10.32.9"},
		{Art: "techniker", ID: "t1", Kennung: "server-adresse", PublicKey: keyC, Adresse: "10.10.32.1"},
		{Art: "techniker", ID: "t2", Kennung: "kaputter-schluessel", PublicKey: "abc=", Adresse: "10.10.32.3"},
		{Art: "router", ID: "x", Kennung: "unbekannt", PublicKey: keyD, Adresse: "10.10.16.9"},
		{Art: "box", ID: "b3", Kennung: "broadcast", PublicKey: keyD, Adresse: "10.10.31.255"},
		{Art: "techniker", ID: "t3", Kennung: "ipv6", PublicKey: keyD, Adresse: "fd00::1"},
	}
	g, befunde, err := Pruefe(s, netze)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Peers) != 1 || g.Peers[keyA].Kennung != "edge-gut" {
		t.Fatalf("gültig: %v", g.Peers)
	}
	if len(befunde) != 6 {
		t.Fatalf("Befunde: %v", befunde)
	}
}

func TestDoppelteSchluesselOderAdressenFallenBeideWeg(t *testing.T) {
	s := basisSoll()
	s.Peers = []Peer{
		{Art: "box", ID: "b1", Kennung: "a", PublicKey: keyA, Adresse: "10.10.16.2"},
		{Art: "box", ID: "b2", Kennung: "b", PublicKey: keyA, Adresse: "10.10.16.3"},
		{Art: "box", ID: "b3", Kennung: "c", PublicKey: keyB, Adresse: "10.10.16.4"},
		{Art: "box", ID: "b4", Kennung: "d", PublicKey: keyC, Adresse: "10.10.16.4"},
		{Art: "techniker", ID: "t1", Kennung: "e", PublicKey: keyD, Adresse: "10.10.32.2"},
	}
	g, befunde, err := Pruefe(s, netze)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Peers) != 1 || g.Peers[keyD].ID != "t1" {
		t.Fatalf("nur der eindeutige Peer bleibt: %v", g.Peers)
	}
	if len(befunde) != 4 {
		t.Fatalf("Befunde: %v", befunde)
	}
}

func TestFensterMuessenAufBoxUndTechnikerZeigen(t *testing.T) {
	s := basisSoll()
	s.Peers = []Peer{
		{Art: "box", ID: "b1", Kennung: "box", PublicKey: keyA, Adresse: "10.10.16.2"},
		{Art: "techniker", ID: "t1", Kennung: "tech", PublicKey: keyB, Adresse: "10.10.32.2"},
	}
	jetzt := time.Now()
	s.Fenster = []Fenster{
		{ID: "ok", BoxID: "b1", TechnikerID: "t1", Beginn: jetzt, Ende: jetzt.Add(time.Hour)},
		{ID: "vertauscht", BoxID: "t1", TechnikerID: "b1", Beginn: jetzt, Ende: jetzt.Add(time.Hour)},
		{ID: "unbekannt", BoxID: "b9", TechnikerID: "t1", Beginn: jetzt, Ende: jetzt.Add(time.Hour)},
		{ID: "rueckwaerts", BoxID: "b1", TechnikerID: "t1", Beginn: jetzt, Ende: jetzt.Add(-time.Hour)},
	}
	g, befunde, err := Pruefe(s, netze)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Fenster) != 1 || g.Fenster[0].ID != "ok" {
		t.Fatalf("Fenster: %v", g.Fenster)
	}
	if len(befunde) != 3 {
		t.Fatalf("Befunde: %v", befunde)
	}
	for _, b := range befunde {
		if !strings.HasPrefix(b.Was, "Fenster ") {
			t.Fatalf("Befund %v", b)
		}
	}
}

func TestSchluesselRegelWieInApiUndDatenbank(t *testing.T) {
	for key, gut := range map[string]bool{
		keyA: true,
		"LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=": true,
		"jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEB=": false, // 4 Nutzbits verletzt
		"jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM":  false,
		"": false,
	} {
		if SchluesselGueltig(key) != gut {
			t.Errorf("%q: erwartet %v", key, gut)
		}
	}
}
