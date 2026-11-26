package suche

// The Deye logger stick of the field find 25.11.2026 (DYDA_WiBLE, MXCHIP
// Wi-Fi module): its start page and utils.js as served before any login
// (testdata/deye_logger), Modbus TCP off (502 closed) and on (502 open, the
// inverter answering at unit 1), next to the cases that must stay what they
// were: a stick that answers Solarman V5, an open 502 without the stick's
// page, an MXCHIP module without it.

import (
	"context"
	"net/netip"
	"os"
	"slices"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
)

func deyeLoggerDatei(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/deye_logger/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// deyeLoggerStick serves what the stick serves without a login; utils is
// the body of /js/utils.js.
func deyeLoggerStick(t *testing.T, p *geraetesim.Protokoll, utils []byte) geraetesim.Geraet {
	return geraetesim.Geraet{Protokoll: p, Pfade: map[string]geraetesim.Antwort{
		"/":            {Body: string(deyeLoggerDatei(t, "index.html"))},
		"/js/utils.js": {Body: utils},
	}}
}

// deyeRegister is the inverter behind the stick at unit 1: type 0x0005
// (hybrid, three-phase, low voltage), 0x0001, 0x0104 and a made-up serial.
func deyeRegister(m *geraetesim.Modbus) {
	m.Setze(1, 0x0000, 0x0005, 0x0001, 0x0104)
	m.Setze(1, 0x0003, geraetesim.Text("AB12345678", 5)...)
}

func TestDeyeLoggerAufEdgeLight(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	utils := deyeLoggerDatei(t, "utils.js")
	// .62: Modbus TCP switched on, the inverter answers at unit 1.
	n.http(t, "192.168.178.62:80", deyeLoggerStick(t, p, utils))
	an := n.modbus(t, "192.168.178.62:502")
	deyeRegister(an)
	// .63: as delivered - Modbus TCP off, 8899 and 502 refuse.
	n.http(t, "192.168.178.63:80", deyeLoggerStick(t, p, utils))
	// .64: Modbus TCP on, but nothing answers the Deye registers.
	n.http(t, "192.168.178.64:80", deyeLoggerStick(t, p, utils))
	still := n.modbus(t, "192.168.178.64:502")
	// .65: a stick that does answer Solarman V5: the solarman find, as before.
	n.http(t, "192.168.178.65:80", deyeLoggerStick(t, p, utils))
	n.solarman(t, "192.168.178.65:8899", 3115580613, 0x0006, "2409066698")
	// .66: Deye registers on 502 without the stick's page (utils.js without
	// its key): a small number at 0x0000 proves no Deye.
	n.http(t, "192.168.178.66:80", deyeLoggerStick(t, p, []byte("function request() {}")))
	fremd := n.modbus(t, "192.168.178.66:502")
	deyeRegister(fremd)
	// .67: an MXCHIP module with some other page: the vendor list alone is never a find.
	n.http(t, "192.168.178.67:80", geraetesim.Router(p, "Wetterstation"))
	for _, ip := range []string{"192.168.178.62", "192.168.178.63", "192.168.178.64", "192.168.178.65",
		"192.168.178.66", "192.168.178.67"} {
		n.antwortet[ip] = true
	}

	arp := []Nachbar{
		{IP: netip.MustParseAddr("192.168.178.62"), MAC: mac("88:a6:8d:00:00:62"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.63"), MAC: mac("88:a6:8d:00:00:63"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.64"), MAC: mac("c8:93:46:00:00:64"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.65"), MAC: mac("88:a6:8d:00:00:65"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.66"), MAC: mac("00:11:22:00:00:66"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.67"), MAC: mac("88:a6:8d:00:00:67"), Schnittstelle: "eth0"},
	}
	u := Umgebung{BoxArt: geraetesuche.BoxArtEdgeLight, Dial: n.dial, Takt: testTakt, Rundruf: &fakeRundruf{},
		Schnittstellen: func() ([]Schnittstelle, error) {
			return []Schnittstelle{{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}}}, nil
		},
		Routen: func() ([]Route, error) {
			return []Route{{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"),
				Gateway: netip.MustParseAddr("192.168.178.1")}, {Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("192.168.178.0/24")}}, nil
		},
		Nachbarn: func() ([]Nachbar, error) { return arp, nil },
		Anstoss:  func(context.Context, netip.Addr) error { return nil },
		Spur:     func(context.Context, string) (func(), bool) { return func() {}, true },
	}
	l, grund := Neu(u, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	aus := l.Suche(context.Background())
	if err := ergebnisAus(aus).Pruefe(geraetesuche.BoxArtEdgeLight); err != nil {
		t.Fatalf("the box would send a result the contract refuses: %v", err)
	}

	sicher := fundVon(t, aus.Funde, "deye_logger:AB12345678")
	if sicher.Erkennung != "sicher" || sicher.Anbindung != "uebernehmen" || sicher.Hindernis != "" ||
		sicher.Hersteller != "deye" || sicher.Familie != "hybrid_3p" || sicher.Spannung != "lv" ||
		sicher.Seriennummer != "AB12345678" || sicher.Verbindung.Communication != "deye_modbus_tcp" ||
		sicher.Verbindung.IP != "192.168.178.62" || sicher.Verbindung.Port != 502 || *sicher.Verbindung.UnitID != 1 ||
		!slices.Equal(sicher.Merkmale, []string{"deye_logger_seite", "deye_logger_pcs_local_web", "solarman_port_zu",
			"deye_typ_0x0005", "deye_seriennummer_0x0003", "funkmodul_mxchip"}) {
		t.Fatalf("Modbus TCP on: %+v", sicher)
	}
	aus502 := fundVon(t, aus.Funde, "deye_logger:192.168.178.63:502")
	if aus502.Erkennung != "wahrscheinlich" || aus502.Anbindung != "uebernehmen" || aus502.Hindernis != "lokale_api_aus" ||
		aus502.Hersteller != "deye" || aus502.Familie != "" || aus502.Seriennummer != "" ||
		aus502.Verbindung.Communication != "deye_modbus_tcp" || aus502.Verbindung.Port != 502 || *aus502.Verbindung.UnitID != 1 ||
		!slices.Equal(aus502.Merkmale, []string{"deye_logger_seite", "deye_logger_pcs_local_web", "solarman_port_zu",
			"modbus_port_zu", "funkmodul_mxchip"}) {
		t.Fatalf("Modbus TCP off: %+v", aus502)
	}
	stumm := fundVon(t, aus.Funde, "deye_logger:192.168.178.64:502")
	if stumm.Erkennung != "wahrscheinlich" || stumm.Anbindung != "uebernehmen" || stumm.Hindernis != "" ||
		stumm.Familie != "" || !enthaelt(stumm.Merkmale, "modbus_port_offen") {
		t.Fatalf("Modbus TCP on, no Deye type: %+v", stumm)
	}
	if v5 := fundVon(t, aus.Funde, "solarman:3115580613"); v5.Anbindung != "uebernehmen" || v5.Verbindung.IP != "192.168.178.65" {
		t.Fatalf("solarman: %+v", v5)
	}
	if mo := fundVon(t, aus.Funde, "modbus_offen:192.168.178.66:502"); mo.Erkennung != "unbekannt" {
		t.Fatalf("open modbus without the stick's page: %+v", mo)
	}
	for _, f := range aus.Funde {
		switch {
		case f.Erkenner == "deye_logger" && f.Verbindung.IP != "192.168.178.62" && f.Verbindung.IP != "192.168.178.63" &&
			f.Verbindung.IP != "192.168.178.64":
			t.Fatalf("a Deye logger at %s: %+v", f.Verbindung.IP, f)
		case f.Erkenner == "modbus_offen" && f.Verbindung.IP != "192.168.178.66":
			t.Fatalf("the stick became an open Modbus port: %+v", f)
		}
	}
	if aus.Weitere.Unbekannt == nil || *aus.Weitere.Unbekannt != 1 || len(aus.Weitere.UnbekannteGeraete) != 1 ||
		aus.Weitere.UnbekannteGeraete[0].IP != "192.168.178.67" {
		t.Fatalf("weitere: %+v", aus.Weitere)
	}
	// Only read: GET on fixed paths, never a CGI of the stick (key exchange,
	// account), Modbus only FC 3.
	nurGelesen(t, p, an, still, fremd)
	for _, e := range p.Eintraege() {
		if strings.Contains(e, "require.cgi") || strings.Contains(e, "change_user") || strings.Contains(e, "login") {
			t.Fatalf("asked the stick behind its login: %s", e)
		}
	}
}

// The Docker box recognises the same stick; it does not read the way, so it
// names it nicht_mit_dieser_box (Edge Light reads it).
func TestDeyeLoggerAufDerDockerBox(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	utils := deyeLoggerDatei(t, "utils.js")
	n.http(t, "10.77.0.62:80", deyeLoggerStick(t, p, utils))
	deyeRegister(n.modbus(t, "10.77.0.62:502"))
	n.http(t, "10.77.0.63:80", deyeLoggerStick(t, p, utils))
	n.antwortet["10.77.0.62"], n.antwortet["10.77.0.63"] = true, true
	l, grund := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	aus := l.Suche(context.Background())
	if err := ergebnisAus(aus).Pruefe(geraetesuche.BoxArtDocker); err != nil {
		t.Fatalf("the box would send a result the contract refuses: %v", err)
	}
	if f := fundVon(t, aus.Funde, "deye_logger:AB12345678"); f.Anbindung != "nicht_mit_dieser_box" || f.Erkennung != "sicher" ||
		enthaelt(f.Merkmale, "funkmodul_mxchip") {
		t.Fatalf("docker, Modbus TCP on: %+v", f)
	}
	if f := fundVon(t, aus.Funde, "deye_logger:10.77.0.63:502"); f.Anbindung != "nicht_mit_dieser_box" ||
		f.Hindernis != "lokale_api_aus" {
		t.Fatalf("docker, Modbus TCP off: %+v", f)
	}
}

// "8899 closed" is only what the search tried: a search narrowed to recognisers
// that do not try 8899 and 502 claims nothing about them.
func TestDeyeLoggerNurWennDieSucheDiePortsPruefte(t *testing.T) {
	utils := deyeLoggerDatei(t, "utils.js")
	for _, f := range []struct {
		erkenner []string
		fund     bool
	}{
		{[]string{"deye_logger", "shelly"}, false},
		{[]string{"deye_logger", "solarman"}, false},
		{[]string{"deye_logger", "solarman", "sunspec"}, true},
	} {
		n := neuesTestnetz()
		n.http(t, "10.77.0.63:80", deyeLoggerStick(t, &geraetesim.Protokoll{}, utils))
		n.antwortet["10.77.0.63"] = true
		l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, f.erkenner)
		aus := l.Suche(context.Background())
		if gefunden := len(aus.Funde) == 1 && aus.Funde[0].Erkenner == "deye_logger"; gefunden != f.fund {
			t.Fatalf("%v: %+v", f.erkenner, aus.Funde)
		}
	}
}

func TestDeyeLoggerSeite(t *testing.T) {
	if !deyeLoggerSeite(deyeLoggerDatei(t, "index.html")) {
		t.Fatal("the stick's start page of the field")
	}
	for _, seite := range []string{
		"<html><head><title>FRITZ!Box 7590</title></head><body>Anmeldung</body></html>",
		`<script src="js/lan_en.js"></script><script src="js/aes.js"></script><script src="js/utils.js"></script>`,
		`<script src="js/jquery.js"></script><script src="js/rsa.js"></script><script src="js/aes.js"></script>` +
			`<script src="js/utils.js"></script>`,
	} {
		if deyeLoggerSeite([]byte(seite)) {
			t.Fatalf("not the stick: %s", seite)
		}
	}
	if !deyeLoggerSeite([]byte(`<script type="text/javascript" src='/js/LAN_DE.js'></script><script src=/js/aes.js>` +
		`</script><script src="js/rsa.js"></script><script src="js/utils.js" defer></script>`)) {
		t.Fatal("absolute paths, other quotes and attributes")
	}
}

// MXCHIP builds Wi-Fi modules for many makers: a merkmal, never network gear.
func TestFunkmodulKenntMXCHIP(t *testing.T) {
	for _, m := range []string{"88:a6:8d:01:02:03", "04:78:63:01:02:03", "d0:ba:e4:01:02:03"} {
		if Funkmodul(mac(m)) != "mxchip" {
			t.Fatalf("%s: %q", m, Funkmodul(mac(m)))
		}
	}
	n := neuesTestnetz()
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt}, nil)
	l.wahl[0].gateway = netip.MustParseAddr("10.77.0.1")
	gw := &geraet{lauf: l, ip: netip.MustParseAddr("10.77.0.1"), offen: map[int]bool{}, hinweis: hinweise{funkmodul: "mxchip"}}
	if f, ok := l.netztechnik(context.Background(), gw); ok {
		t.Fatalf("an MXCHIP module became network gear: %+v", f)
	}
}
