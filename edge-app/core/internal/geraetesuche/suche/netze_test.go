package suche

// Step 1 on both box types (contract §3 "Je Box-Art", §4): the Docker box
// searches only the /24 around VP_LAN_HOST, with a named refusal without it;
// Edge Light walks its private interfaces without tunnels and containers,
// the customer network on the default route, and a network whose route
// leaves through the tunnel is not reachable (finding 2 of 30.10.). The
// Linux readers parse the kernel's own tables; the pace holds JeSekunde.

import (
	"net/netip"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

func TestDockerNetzAusVPLanHost(t *testing.T) {
	for _, f := range []struct {
		host, netz, grund string
	}{
		{"192.168.178.42:8484", "192.168.178.0/24", ""},
		{"10.0.5.7", "10.0.5.0/24", ""},
		{"", "", GrundLanHostFehlt},
		{"  ", "", GrundLanHostFehlt},
		{"8.8.8.8", "", GrundKeinPrivatesNetz},
		{"box.fritz.box:8484", "", GrundKeinPrivatesNetz},
		{"100.64.0.1", "", GrundKeinPrivatesNetz},
	} {
		w, grund := netzDocker(f.host)
		if grund != f.grund {
			t.Fatalf("%q: grund %q, want %q", f.host, grund, f.grund)
		}
		if f.netz != "" && (len(w) != 1 || w[0].netz.Netz != f.netz || w[0].netz.Rolle != "kundennetz" ||
			w[0].netz.Ausschnitt != nil || !w[0].netz.Erreichbar) {
			t.Fatalf("%q: %+v", f.host, w)
		}
	}
}

func TestEdgeLightNetzeUndDieRouteInDenTunnel(t *testing.T) {
	ifs := []Schnittstelle{
		{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/16")}},
		{Name: "br-lan", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.8.1/24")}},
		{Name: "wlan0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.9.1/24")}},
		{Name: "wg0", Prefixe: []netip.Prefix{netip.MustParsePrefix("10.8.0.2/24")}},
		{Name: "docker0", Prefixe: []netip.Prefix{netip.MustParsePrefix("172.17.0.1/16")}},
		{Name: "br-0123456789ab", Prefixe: []netip.Prefix{netip.MustParsePrefix("172.18.0.1/16")}},
	}
	routen := []Route{
		{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"), Gateway: netip.MustParseAddr("192.168.178.1")},
		{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("192.168.0.0/16")},
		{Schnittstelle: "br-lan", Ziel: netip.MustParsePrefix("192.168.8.0/24")},
		// Befund 2 vom 30.10.: the router's own LAN route pointed into the tunnel.
		{Schnittstelle: "wg0", Ziel: netip.MustParsePrefix("192.168.8.0/25")},
	}
	u := Umgebung{BoxArt: geraetesuche.BoxArtEdgeLight,
		Schnittstellen: func() ([]Schnittstelle, error) { return ifs, nil },
		Routen:         func() ([]Route, error) { return routen, nil }}
	w, grund := waehleNetze(u)
	if grund != "" || len(w) != 2 {
		t.Fatalf("%q %+v", grund, w)
	}
	kunde, box := w[0], w[1]
	// A /16 is searched as the /24 around the box, and the result says so.
	if kunde.netz.Rolle != "kundennetz" || kunde.netz.Netz != "192.168.178.0/24" || kunde.netz.Ausschnitt == nil ||
		!*kunde.netz.Ausschnitt || !kunde.netz.Erreichbar || kunde.gateway != netip.MustParseAddr("192.168.178.1") {
		t.Fatalf("customer network: %+v", kunde)
	}
	if box.netz.Rolle != "box_netz" || box.netz.Netz != "192.168.8.0/24" || box.netz.Erreichbar {
		t.Fatalf("box network: %+v (its route leaves through the tunnel)", box)
	}

	// No private network at all: a named refusal.
	leer := Umgebung{BoxArt: geraetesuche.BoxArtEdgeLight, Schnittstellen: func() ([]Schnittstelle, error) {
		return []Schnittstelle{{Name: "wg0", Prefixe: []netip.Prefix{netip.MustParsePrefix("10.8.0.2/24")}}}, nil
	}}
	if _, grund := waehleNetze(leer); grund != GrundKeinPrivatesNetz {
		t.Fatalf("grund %q", grund)
	}
}

func TestKernelTabellenLesen(t *testing.T) {
	routen, err := LiesRouten(strings.NewReader(
		"Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
			"eth0\t00000000\t01B2A8C0\t0003\t0\t0\t10\t00000000\t0\t0\t0\n" +
			"br-lan\t0002A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"))
	if err != nil || len(routen) != 2 {
		t.Fatalf("%v %+v", err, routen)
	}
	if routen[0].Ziel.Bits() != 0 || routen[0].Gateway != netip.MustParseAddr("192.168.178.1") || routen[0].Metrik != 10 ||
		routen[1].Ziel != netip.MustParsePrefix("192.168.2.0/24") || routen[1].Gateway.IsValid() {
		t.Fatalf("routes: %+v", routen)
	}
	nachbarn, err := LiesNachbarn(strings.NewReader(
		"IP address       HW type     Flags       HW address            Mask     Device\n" +
			"192.168.2.40     0x1         0x2         00:11:22:aa:bb:cc     *        br-lan\n" +
			"192.168.2.41     0x1         0x0         00:00:00:00:00:00     *        br-lan\n" +
			"192.168.2.42     0x1         0x6         ac:cf:23:11:22:33     *        br-lan\n"))
	if err != nil || len(nachbarn) != 2 || nachbarn[0].IP != netip.MustParseAddr("192.168.2.40") ||
		nachbarn[1].Schnittstelle != "br-lan" {
		t.Fatalf("%v %+v", err, nachbarn)
	}
	if Funkmodul(nachbarn[1].MAC) != "high-flying" || Funkmodul(mac("da:a1:19:01:02:03")) != "" {
		t.Fatal("vendor list")
	}
}

func TestTaktHaeltZwanzigJeSekunde(t *testing.T) {
	tg := neuerTaktgeber(JeSekunde)
	start := time.Now()
	for i := 0; i < JeSekunde+1; i++ {
		if err := tg.warte(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(start); d < 950*time.Millisecond {
		t.Fatalf("%d connections in %s", JeSekunde+1, d)
	}
}

func TestRestSekunden(t *testing.T) {
	if _, ok := restSekunden(5*time.Second, 0, 100, geraetesuche.MaxDauer); ok {
		t.Fatal("unknown is no number")
	}
	if r, ok := restSekunden(10*time.Second, 25, 100, geraetesuche.MaxDauer); !ok || r != 30 {
		t.Fatalf("rest %d", r)
	}
	if r, _ := restSekunden(170*time.Second, 1, 100, geraetesuche.MaxDauer); r != 10 {
		t.Fatalf("beyond the time limit: %d", r)
	}
}

// rest_s is 0 only when all is done (VoltPilotGATE 30.10.2026: it showed 0
// from progress 7 on while ~3.5 s still followed).
func TestRestSekundenNieNullSolangeEtwasOffenIst(t *testing.T) {
	if r, _ := restSekunden(15*time.Second, 316, 323, geraetesuche.MaxDauer); r != 1 {
		t.Fatalf("open units, rest %d", r)
	}
	if r, _ := restSekunden(17*time.Second, 323, 323, geraetesuche.MaxDauer); r != 0 {
		t.Fatalf("done, rest %d", r)
	}
	if r, _ := restSekunden(geraetesuche.MaxDauer, 1, 100, geraetesuche.MaxDauer); r != 0 {
		t.Fatalf("time limit reached, rest %d", r)
	}
}

// The steps of the GATE run with its numbers: 253 nudges, 2 s listening at 20
// per second, 25 port checks of 5 devices, 5 to recognise. gesamt holds the
// listening and the recognising before they run, so the units never all look
// done while a step still follows.
func TestGesamtRechnetNachlaufUndErkennenVorab(t *testing.T) {
	l := &Lauf{}
	nachlauf := int(Takt{}.nachlauf() * time.Duration(Takt{}.jeSekunde()) / time.Second)
	if nachlauf != 40 {
		t.Fatalf("nachlauf %d units", nachlauf)
	}
	l.schritte("nachbarn_finden", 253+nachlauf, 0)
	l.erledige(253)
	if z := l.Stand(); z.Erledigt != 253 || z.Gesamt != 293 {
		t.Fatalf("after the nudges: %d/%d", z.Erledigt, z.Gesamt)
	}
	if r, _ := restSekunden(12600*time.Millisecond, 253, 293, geraetesuche.MaxDauer); r != 2 {
		t.Fatalf("listening still follows, rest %d", r)
	}
	l.erledige(nachlauf)
	l.schritte("geraete_ansprechen", 25, 5)
	l.erledige(25)
	if z := l.Stand(); z.Erledigt != 318 || z.Gesamt != 323 {
		t.Fatalf("after the port checks: %d/%d", z.Erledigt, z.Gesamt)
	}
	l.schritte("geraete_erkennen", 3, 0)
	l.erledige(2)
	if z := l.Stand(); z.Erledigt != 320 || z.Gesamt != 321 {
		t.Fatalf("recognising: %d/%d", z.Erledigt, z.Gesamt)
	}
	l.erledige(1)
	if z := l.Stand(); z.Erledigt != z.Gesamt {
		t.Fatalf("done: %d/%d", z.Erledigt, z.Gesamt)
	}
}
