package suche

// A whole search on both box types against simulated devices (Solarman
// logger, Shelly Gen1/Gen2, go-e, Fronius, SunSpec, SMA, eByte, OpenDTU, KACO,
// a FRITZ!Box and a repeater): the networks of the box type, what each
// recogniser reports with which anbindung, what the box already reads, the
// counts in weitere, the result checked by the contract's own Pruefe - and
// that nothing but a GET and a Modbus FC 3 ever reached a device. Simulators
// are no hardware acceptance (package 5).

import (
	"context"
	"errors"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
)

var testTakt = Takt{JeSekunde: 100000, Zeitlimit: time.Second, Nachlauf: 10 * time.Millisecond}

// testnetz maps the addresses of a customer network onto simulators on the
// loopback. An address that "answers" refuses the connection (RST); every
// other one is silent.
type testnetz struct {
	mu        sync.Mutex
	ziele     map[string]string
	antwortet map[string]bool
	gewaehlt  []string
}

func neuesTestnetz() *testnetz {
	return &testnetz{ziele: map[string]string{}, antwortet: map[string]bool{}}
}

func (n *testnetz) dial(ctx context.Context, addr string) (net.Conn, error) {
	n.mu.Lock()
	n.gewaehlt = append(n.gewaehlt, addr)
	ziel, ok := n.ziele[addr]
	host, _, _ := net.SplitHostPort(addr)
	antwortet := n.antwortet[host]
	n.mu.Unlock()
	if ok {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", ziel)
	}
	if antwortet {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	}
	return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("i/o timeout")}
}

func (n *testnetz) http(t *testing.T, addr string, g geraetesim.Geraet) {
	t.Helper()
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	n.ziele[addr] = strings.TrimPrefix(srv.URL, "http://")
}

func (n *testnetz) modbus(t *testing.T, addr string) *geraetesim.Modbus {
	t.Helper()
	m, err := geraetesim.StartModbus("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	n.ziele[addr] = m.Addr()
	return m
}

func (n *testnetz) solarman(t *testing.T, addr string, logger uint32, typ uint16, seriennummer string) *v5sim.Sim {
	t.Helper()
	s, err := v5sim.Start("127.0.0.1:0", logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	werte := map[uint16]uint16{0x0000: typ, 0x0001: 0, 0x0002: 0}
	for i, r := range geraetesim.Text(seriennummer, 5) {
		werte[0x0003+uint16(i)] = r
	}
	s.Set(werte)
	n.ziele[addr] = s.Addr()
	return s
}

func (n *testnetz) wurdeGewaehlt(prefix string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range n.gewaehlt {
		if strings.HasPrefix(a, prefix) {
			return true
		}
	}
	return false
}

func fundVon(t *testing.T, funde []geraetesuche.Fund, schluessel string) geraetesuche.Fund {
	t.Helper()
	for _, f := range funde {
		if f.Schluessel == schluessel {
			return f
		}
	}
	var alle []string
	for _, f := range funde {
		alle = append(alle, f.Schluessel)
	}
	t.Fatalf("no find %s; finds: %v", schluessel, alle)
	return geraetesuche.Fund{}
}

func nurGelesen(t *testing.T, protokoll *geraetesim.Protokoll, modbus ...*geraetesim.Modbus) {
	t.Helper()
	for _, e := range protokoll.Eintraege() {
		if !strings.HasPrefix(e, "GET ") {
			t.Fatalf("not a GET: %s", e)
		}
	}
	for _, m := range modbus {
		for _, fc := range m.Funktionen() {
			if fc != 0x03 {
				t.Fatalf("Modbus function 0x%02x sent - the search only reads", fc)
			}
		}
	}
}

func ergebnisAus(aus Ausgang) geraetesuche.Ergebnis {
	return geraetesuche.Ergebnis{SchemaVersion: "1.0", TenantID: "11111111-1111-4111-8111-111111111111",
		SiteID: "22222222-2222-4222-8222-222222222222", DeviceID: "33333333-3333-4333-8333-333333333333",
		SuchID: "44444444-4444-4444-8444-444444444444", Ts: time.Now().UTC(), Zustand: "fertig", DauerMs: 1000,
		Erkenner: aus.Erkenner, Netze: aus.Netze, Funde: aus.Funde, Weitere: aus.Weitere}
}

func TestDockerBoxSuchtDurchNATNurMitTCP(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	logger := n.solarman(t, "10.77.0.34:8899", 3115580613, 0x0006, "2409066698")
	n.http(t, "10.77.0.50:80", geraetesim.ShellyGen2(p, "SPSW-003XE16EU", "1.4.4", 3, false, false))
	n.http(t, "10.77.0.52:80", geraetesim.ShellyGen2(p, "SNSW-001X16EU", "1.4.4", 1, false, true))
	n.http(t, "10.77.0.53:80", geraetesim.ShellyGen1(p, "SHEM-3", 1, 3))
	n.http(t, "10.77.0.61:80", geraetesim.Goe(p, "204117", "go-eCharger_V4", "56.1"))
	n.http(t, "10.77.0.40:80", geraetesim.Fronius(p, "31234567"))
	n.http(t, "10.77.0.1:80", geraetesim.Router(p, "FRITZ!Box 7590"))
	n.http(t, "10.77.0.80:80", geraetesim.OpenDTU(p))
	n.http(t, "10.77.0.81:8484", geraetesim.Kaco(p, "NX310K1234567"))
	sunspec := n.modbus(t, "10.77.0.70:502")
	sunspec.SunSpec(1, 40000, "Fronius", "Symo GEN24 10.0 Plus", "1.30.7-1", "34112233")
	offen := n.modbus(t, "10.77.0.71:502")
	sma := n.modbus(t, "10.77.0.45:502")
	sma.Setze(3, 30051, 0, 8001, 0, 9346, 0, 461, 0xB31F, 0x5A39)
	n.antwortet["10.77.0.99"] = true

	u := Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20:8484", Dial: n.dial, Takt: testTakt,
		Bekannt: []Bekannt{{Communication: "solarman_v5", IP: "10.77.0.35", Port: 8899, Serial: "1234567",
			Hersteller: "deye", Familie: "hybrid_1p"}}}
	l, grund := Neu(u, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	aus := l.Suche(context.Background())

	if err := ergebnisAus(aus).Pruefe(geraetesuche.BoxArtDocker); err != nil {
		t.Fatalf("the box would send a result the contract refuses: %v", err)
	}
	if len(aus.Netze) != 1 || aus.Netze[0].Netz != "10.77.0.0/24" || aus.Netze[0].BoxAdresse != "10.77.0.20" ||
		aus.Netze[0].Ausschnitt != nil || aus.Netze[0].Rolle != "kundennetz" {
		t.Fatalf("networks: %+v", aus.Netze)
	}
	if strings.Join(aus.Erkenner, ",") != strings.Join(ErkennerDerBox(geraetesuche.BoxArtDocker), ",") ||
		enthaelt(aus.Erkenner, "mdns") {
		t.Fatalf("erkenner: %v", aus.Erkenner)
	}

	deye := fundVon(t, aus.Funde, "solarman:3115580613")
	if deye.Erkennung != "sicher" || deye.Hersteller != "deye" || deye.Spannung != "hv" ||
		deye.Seriennummer != "2409066698" || deye.Anbindung != "uebernehmen" || *deye.Verbindung.Serial != 3115580613 ||
		deye.Verbindung.Communication != "solarman_v5" || deye.Verbindung.Port != 8899 || deye.LiestBoxSchon {
		t.Fatalf("deye: %+v", deye)
	}
	if logger.Requests() > AnfragenJeErkenner {
		t.Fatalf("the logger was asked %d times", logger.Requests())
	}
	if pro3 := fundVon(t, aus.Funde, "shelly:10.77.0.50:80"); pro3.Kanaele != 3 || pro3.Art != "schaltaktor" ||
		pro3.Hindernis != "" || pro3.Seriennummer != "" || pro3.Anbindung != "uebernehmen" {
		t.Fatalf("shelly pro 3: %+v", pro3)
	}
	if zu := fundVon(t, aus.Funde, "shelly:10.77.0.52:80"); zu.Hindernis != "geschuetzt" || zu.Anbindung != "uebernehmen" {
		t.Fatalf("protected shelly: %+v", zu)
	}
	if em := fundVon(t, aus.Funde, "shelly:10.77.0.53:80"); em.Art != "zaehler" || em.Anbindung != "kein_leseweg" ||
		em.Verbindung.Communication != "" {
		t.Fatalf("shelly 3EM: %+v", em)
	}
	if goe := fundVon(t, aus.Funde, "goe:204117"); goe.Firmware != "56.1" || goe.Anbindung != "uebernehmen" {
		t.Fatalf("go-e: %+v", goe)
	}
	if fr := fundVon(t, aus.Funde, "fronius_solar_api:31234567"); fr.Anbindung != "uebernehmen" ||
		fr.Verbindung.Communication != "fronius_solar_api" {
		t.Fatalf("fronius: %+v", fr)
	}
	if ss := fundVon(t, aus.Funde, "sunspec:34112233"); ss.Hersteller != "fronius" || ss.Modell != "Symo GEN24 10.0 Plus" ||
		ss.Anbindung != "uebernehmen" || ss.Verbindung.Communication != "sunspec_tcp" || *ss.Verbindung.UnitID != 1 {
		t.Fatalf("sunspec: %+v", ss)
	}
	if mo := fundVon(t, aus.Funde, "modbus_offen:10.77.0.71:502"); mo.Erkennung != "unbekannt" ||
		mo.Anbindung != "selbst_beschreiben" || mo.Verbindung.Communication != "modbus_tcp" {
		t.Fatalf("open modbus: %+v", mo)
	}
	if s := fundVon(t, aus.Funde, "sma:3005176377"); s.Anbindung != "kein_leseweg" || s.Verbindung.Communication != "" {
		t.Fatalf("sma: %+v", s)
	}
	if dtu := fundVon(t, aus.Funde, "opendtu_ahoy:10.77.0.80:80"); dtu.Anbindung != "kein_leseweg" || dtu.Hersteller != "opendtu" {
		t.Fatalf("opendtu: %+v", dtu)
	}
	if k := fundVon(t, aus.Funde, "kaco_aiswei:NX310K1234567"); k.Anbindung != "uebernehmen" || k.Verbindung.Port != 8484 {
		t.Fatalf("kaco: %+v", k)
	}
	if r := fundVon(t, aus.Funde, "netztechnik:10.77.0.1:80"); r.Art != "router" || r.Hersteller != "avm" ||
		r.Modell != "FRITZ!Box 7590" || r.Anbindung != "nur_anzeige" || r.Erkennung != "wahrscheinlich" {
		t.Fatalf("router: %+v", r)
	}
	bekannt := fundVon(t, aus.Funde, "solarman:1234567")
	if !bekannt.LiestBoxSchon || bekannt.Merkmale[0] != "laufender_leser" || bekannt.Familie != "hybrid_1p" {
		t.Fatalf("known logger: %+v", bekannt)
	}
	// The logger the box reads and the box itself are never connected.
	if n.wurdeGewaehlt("10.77.0.35:") || n.wurdeGewaehlt("10.77.0.20:") {
		t.Fatal("connected to the box itself or to the logger it already reads")
	}
	// Phones, computers and the unknown are a count; the Docker box cannot
	// tell them apart.
	if aus.Weitere.Unbekannt == nil || *aus.Weitere.Unbekannt != 1 || aus.Weitere.TelefonTablet != nil ||
		aus.Weitere.Rechner != nil {
		t.Fatalf("weitere: %+v", aus.Weitere)
	}
	if aus.Netze[0].Aktiv < 12 {
		t.Fatalf("aktiv: %d", aus.Netze[0].Aktiv)
	}
	nurGelesen(t, p, sunspec, offen, sma)
}

// fakeRundruf answers what the multicast ways would have heard.
type fakeRundruf struct {
	a        Antworten
	gefragt  []string
	gefragtM sync.Mutex
}

func (f *fakeRundruf) Hoeren(ctx context.Context, schnittstellen []string, wege []string) Antworten {
	f.gefragtM.Lock()
	f.gefragt = append(f.gefragt, schnittstellen...)
	f.gefragtM.Unlock()
	<-ctx.Done()
	return f.a
}

func mac(s string) net.HardwareAddr {
	m, err := net.ParseMAC(s)
	if err != nil {
		panic(err)
	}
	return m
}

func TestEdgeLightSiehtBeideNetzeUndDieWege(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	n.http(t, "192.168.178.1:80", geraetesim.Router(p, "FRITZ!Box 7590"))
	n.http(t, "192.168.178.2:49000", geraetesim.FritzBeschreibung(p, "/fboxdesc.xml", "FRITZ!Repeater 1200 AX"))
	n.solarman(t, "192.168.178.34:8899", 3115580613, 0x0006, "2409066698")
	fronius := n.modbus(t, "192.168.178.40:502")
	fronius.SunSpec(1, 40000, "Fronius", "Symo GEN24 10.0 Plus", "1.30.7-1", "31234567")
	n.http(t, "192.168.178.40:80", geraetesim.Fronius(p, "31234567"))
	n.http(t, "192.168.178.52:80", geraetesim.ShellyGen2(p, "SNSW-001X16EU", "1.4.4", 1, false, true))
	eb := n.modbus(t, "192.168.2.40:502")
	eb.SetzeText(1, 0x0C20, 12, "M31-AXAX4040G")

	routen := []Route{
		{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"), Gateway: netip.MustParseAddr("192.168.178.1")},
		{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("192.168.178.0/24")},
		{Schnittstelle: "br-lan", Ziel: netip.MustParsePrefix("192.168.2.0/24")},
		{Schnittstelle: "wg0", Ziel: netip.MustParsePrefix("10.8.0.0/24")},
	}
	arp := []Nachbar{
		{IP: netip.MustParseAddr("192.168.178.1"), MAC: mac("3c:a6:2f:01:02:03"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.34"), MAC: mac("ac:cf:23:11:22:33"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.40"), MAC: mac("00:03:ac:01:02:03"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.52"), MAC: mac("a8:48:fa:01:02:03"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.60"), MAC: mac("da:a1:19:01:02:03"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.61"), MAC: mac("00:1b:21:01:02:03"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.62"), MAC: mac("00:11:22:33:44:55"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.2.40"), MAC: mac("00:11:22:aa:bb:cc"), Schnittstelle: "br-lan"},
		{IP: netip.MustParseAddr("10.8.0.5"), MAC: mac("00:11:22:aa:bb:cd"), Schnittstelle: "wg0"},
		{IP: netip.MustParseAddr("192.168.178.21"), MAC: mac("00:11:22:aa:bb:ce"), Schnittstelle: "eth0"},
	}
	var anstoesse int
	var anstossMu sync.Mutex
	var spuren []string
	rundruf := &fakeRundruf{a: Antworten{
		MDNS: map[netip.Addr]map[string]bool{
			netip.MustParseAddr("192.168.178.61"): {"rechner": true},
			netip.MustParseAddr("192.168.178.52"): {"shelly": true},
		},
		SSDP:      map[netip.Addr]string{netip.MustParseAddr("192.168.178.2"): "http://192.168.178.2:49000/fboxdesc.xml"},
		Speedwire: map[netip.Addr]uint32{netip.MustParseAddr("192.168.2.30"): 3006054321},
		Wege:      []string{"mdns", "ssdp"},
	}}
	u := Umgebung{BoxArt: geraetesuche.BoxArtEdgeLight, Dial: n.dial, Takt: testTakt, Rundruf: rundruf,
		Schnittstellen: func() ([]Schnittstelle, error) {
			return []Schnittstelle{
				{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}},
				{Name: "br-lan", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.2.1/24")}},
				{Name: "wg0", Prefixe: []netip.Prefix{netip.MustParsePrefix("10.8.0.2/24")}},
			}, nil
		},
		Routen:   func() ([]Route, error) { return routen, nil },
		Nachbarn: func() ([]Nachbar, error) { return arp, nil },
		Anstoss: func(_ context.Context, ip netip.Addr) error {
			anstossMu.Lock()
			anstoesse++
			anstossMu.Unlock()
			if strings.HasPrefix(ip.String(), "10.") || ip.String() == "192.168.178.21" {
				t.Errorf("nudged %s", ip)
			}
			return nil
		},
		Spur: func(_ context.Context, addr string) (func(), bool) {
			spuren = append(spuren, addr)
			return func() {}, true
		},
		Bekannt: []Bekannt{{Communication: "solarman_v5", IP: "192.168.178.35", Serial: "3115580999",
			Hersteller: "deye", Familie: "hybrid_3p"}},
	}
	l, grund := Neu(u, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	aus := l.Suche(context.Background())
	if err := ergebnisAus(aus).Pruefe(geraetesuche.BoxArtEdgeLight); err != nil {
		t.Fatalf("the box would send a result the contract refuses: %v", err)
	}
	if strings.Join(aus.Erkenner, ",") != strings.Join(geraetesuche.Erkenner, ",") {
		t.Fatalf("erkenner: %v", aus.Erkenner)
	}
	if len(aus.Netze) != 2 || aus.Netze[0].Rolle != "kundennetz" || aus.Netze[0].Netz != "192.168.178.0/24" ||
		aus.Netze[1].Rolle != "box_netz" || aus.Netze[1].Netz != "192.168.2.0/24" ||
		aus.Netze[0].Ausschnitt == nil || *aus.Netze[0].Ausschnitt {
		t.Fatalf("networks: %+v", aus.Netze)
	}
	if aus.Netze[0].Aktiv != 8 || aus.Netze[1].Aktiv != 2 {
		t.Fatalf("aktiv: %d / %d", aus.Netze[0].Aktiv, aus.Netze[1].Aktiv)
	}
	if anstoesse != 506 {
		t.Fatalf("%d nudges, want one per host address of both /24 but the box's own", anstoesse)
	}
	if len(rundruf.gefragt) != 2 {
		t.Fatalf("multicast asked on %v", rundruf.gefragt)
	}

	deye := fundVon(t, aus.Funde, "solarman:3115580613")
	if deye.Anbindung != "uebernehmen" || !enthaelt(deye.Merkmale, "funkmodul_high_flying") {
		t.Fatalf("deye: %+v", deye)
	}
	if len(spuren) != 1 || spuren[0] != "192.168.178.34:8899" {
		t.Fatalf("logger lane: %v", spuren)
	}
	// Edge Light reads no SunSpec yet: recognised, not connectable with this box.
	if fr := fundVon(t, aus.Funde, "sunspec:31234567"); fr.Anbindung != "nicht_mit_dieser_box" {
		t.Fatalf("fronius: %+v", fr)
	}
	if s := fundVon(t, aus.Funde, "shelly:192.168.178.52:80"); s.Hindernis != "geschuetzt" ||
		!enthaelt(s.Merkmale, "mdns_shelly") || !enthaelt(s.Merkmale, "funkmodul_espressif") {
		t.Fatalf("shelly: %+v", s)
	}
	if r := fundVon(t, aus.Funde, "netztechnik:192.168.178.1:80"); r.Art != "router" {
		t.Fatalf("router: %+v", r)
	}
	if rep := fundVon(t, aus.Funde, "netztechnik:192.168.178.2:49000"); rep.Art != "zugangspunkt" ||
		rep.Modell != "FRITZ!Repeater 1200 AX" || rep.Hersteller != "avm" || rep.Merkmale[0] != "ssdp_fboxdesc" {
		t.Fatalf("repeater: %+v", rep)
	}
	if z := fundVon(t, aus.Funde, "sma:3006054321"); z.Art != "zaehler" || z.Anbindung != "kein_leseweg" ||
		z.Verbindung.Port != 9522 {
		t.Fatalf("sma meter: %+v", z)
	}
	if e := fundVon(t, aus.Funde, "ebyte:192.168.2.40:502"); e.Anbindung != "uebernehmen" || e.Kanaele != 4 ||
		e.Seriennummer != "" {
		t.Fatalf("ebyte: %+v", e)
	}
	if b := fundVon(t, aus.Funde, "solarman:3115580999"); !b.LiestBoxSchon || b.Familie != "hybrid_3p" {
		t.Fatalf("known: %+v", b)
	}
	// .60 randomised MAC = phone, .61 announces a workstation, .62 unknown.
	if *aus.Weitere.TelefonTablet != 1 || *aus.Weitere.Rechner != 1 || *aus.Weitere.Unbekannt != 1 {
		t.Fatalf("weitere: %d/%d/%d", *aus.Weitere.TelefonTablet, *aus.Weitere.Rechner, *aus.Weitere.Unbekannt)
	}
	if n.wurdeGewaehlt("10.8.0.") || n.wurdeGewaehlt("192.168.178.21:") || n.wurdeGewaehlt("192.168.178.35:") {
		t.Fatal("dialed into the tunnel, the box itself or a logger it reads")
	}
	nurGelesen(t, p, fronius, eb)
}

// The narrowing of the order: only the named recognisers run, and only their
// ports are checked.
func TestAuftragEngtDieErkennerEin(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	n.http(t, "10.77.0.50:80", geraetesim.ShellyGen2(p, "SPSW-003XE16EU", "1.4.4", 3, false, false))
	n.solarman(t, "10.77.0.34:8899", 3115580613, 0x0006, "2409066698")
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial, Takt: testTakt},
		[]string{"shelly"})
	aus := l.Suche(context.Background())
	if strings.Join(aus.Erkenner, ",") != "shelly" || len(aus.Funde) != 1 || aus.Funde[0].Erkenner != "shelly" {
		t.Fatalf("narrowed search: %v %+v", aus.Erkenner, aus.Funde)
	}
	if n.wurdeGewaehlt("10.77.0.34:8899") {
		t.Fatal("a port of a recogniser that does not run was checked")
	}
}

// A cancelled search keeps what it found and stops speaking to devices.
func TestAbbruchBehaeltDieFunde(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	n.http(t, "10.77.0.2:80", geraetesim.Goe(p, "204117", "go-eCharger_V4", "56.1"))
	ctx, cancel := context.WithCancel(context.Background())
	l, _ := Neu(Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: n.dial,
		Takt: Takt{JeSekunde: 400, Zeitlimit: time.Second}}, nil)
	fertig := make(chan Ausgang)
	go func() { fertig <- l.Suche(ctx) }()
	time.Sleep(300 * time.Millisecond)
	cancel()
	select {
	case aus := <-fertig:
		if aus.Funde == nil || aus.Erkenner == nil {
			t.Fatalf("cancelled search lost its shape: %+v", aus)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled search did not stop")
	}
}
