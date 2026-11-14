package suche

// S6: Wiederfinden after an address change in the WLAN way (relayd) - the
// customer router, not the box, hands out the devices' addresses behind it
// (vp-edge-light-wlan-konzept §6). planWiederfinden is tested directly
// against a staged ARP picture (no network at all); TestWiederfinden* run the
// whole search against a simulated M31 (the one device type the catalog
// never gives a serial - "Its identity is the MAC... never read here, it
// does not leave the box", ebyte.go) to prove the result the contract
// actually sends.

import (
	"context"
	"net/netip"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

func testGeraet(ip string, macAddr string) *geraet {
	g := &geraet{ip: netip.MustParseAddr(ip)}
	if macAddr != "" {
		g.mac = mac(macAddr)
	}
	return g
}

func TestWiederfindenPlanOhnePin(t *testing.T) {
	// No MAC pinned: unchanged pre-S6 trust, whatever the ARP table shows.
	bekannt := []Bekannt{{IP: "192.168.178.40"}}
	geraete := []*geraet{testGeraet("192.168.178.41", "00:11:22:aa:bb:10")}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || !plan[0].intakt {
		t.Fatalf("unpinned device must stay trusted: %+v", plan)
	}
}

func TestWiederfindenPlanDockerBleibtUnberuehrt(t *testing.T) {
	// The Docker box has no ARP table; a plan is never even built for it.
	bekannt := []Bekannt{{IP: "10.77.0.40", MAC: "00:11:22:aa:bb:10"}}
	if plan := planWiederfinden(geraetesuche.BoxArtDocker, bekannt, nil); plan != nil {
		t.Fatalf("docker box must get no plan: %+v", plan)
	}
}

func TestWiederfindenPlanIntakt(t *testing.T) {
	bekannt := []Bekannt{{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}}
	geraete := []*geraet{testGeraet("192.168.178.40", "00:11:22:aa:bb:10")}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || !plan[0].intakt {
		t.Fatalf("mac still at the configured address: %+v", plan)
	}
}

func TestWiederfindenPlanUmgezogen(t *testing.T) {
	bekannt := []Bekannt{{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}}
	// The old address is silent (not even in geraete); the same MAC answers
	// under a new one.
	geraete := []*geraet{testGeraet("192.168.178.41", "00:11:22:aa:bb:10")}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || plan[0].intakt || plan[0].kandidat.String() != "192.168.178.41" {
		t.Fatalf("moved device: %+v", plan)
	}
}

func TestWiederfindenPlanFremdAnAlterAdresse(t *testing.T) {
	bekannt := []Bekannt{{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}}
	// A different MAC answers at the configured address; the pinned one is
	// nowhere else in this run's ARP picture.
	geraete := []*geraet{testGeraet("192.168.178.40", "00:11:22:aa:bb:99")}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || plan[0].intakt || plan[0].kandidat.IsValid() {
		t.Fatalf("foreign device at the old address: %+v", plan)
	}
}

func TestWiederfindenPlanAntwortetNirgends(t *testing.T) {
	bekannt := []Bekannt{{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}}
	geraete := []*geraet{testGeraet("192.168.178.50", "00:11:22:aa:bb:99")}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || plan[0].intakt || plan[0].kandidat.IsValid() {
		t.Fatalf("device seen nowhere: %+v", plan)
	}
}

func TestWiederfindenPlanMehrdeutigBleibtOhneKandidat(t *testing.T) {
	bekannt := []Bekannt{{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}}
	// An ARP oddity: the same MAC answers under two addresses at once -
	// never a guess between them.
	geraete := []*geraet{
		testGeraet("192.168.178.41", "00:11:22:aa:bb:10"),
		testGeraet("192.168.178.42", "00:11:22:aa:bb:10"),
	}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 1 || plan[0].intakt || plan[0].kandidat.IsValid() {
		t.Fatalf("ambiguous mac must yield no candidate: %+v", plan)
	}
}

func TestWiederfindenPlanTausch(t *testing.T) {
	bekannt := []Bekannt{
		{IP: "192.168.178.40", MAC: "00:11:22:aa:bb:10"}, // A
		{IP: "192.168.178.41", MAC: "00:11:22:aa:bb:20"}, // B
	}
	// A and B swapped addresses.
	geraete := []*geraet{
		testGeraet("192.168.178.40", "00:11:22:aa:bb:20"),
		testGeraet("192.168.178.41", "00:11:22:aa:bb:10"),
	}
	plan := planWiederfinden(geraetesuche.BoxArtEdgeLight, bekannt, geraete)
	if len(plan) != 2 || plan[0].intakt || plan[1].intakt {
		t.Fatalf("swap must be detected for both: %+v", plan)
	}
	if plan[0].kandidat.String() != "192.168.178.41" || plan[1].kandidat.String() != "192.168.178.40" {
		t.Fatalf("each device's own address, not the other's old one: %+v", plan)
	}
}

// ---------------------------------------------------------------- whole search

// wiederfindenUmgebung is a minimal single-network Edge Light environment:
// just enough for Suche() to walk one /24 and read a staged ARP table.
func wiederfindenUmgebung(n *testnetz, arp []Nachbar, bekannt []Bekannt) Umgebung {
	return Umgebung{
		BoxArt: geraetesuche.BoxArtEdgeLight, Dial: n.dial, Takt: testTakt,
		Schnittstellen: func() ([]Schnittstelle, error) {
			return []Schnittstelle{
				{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}},
			}, nil
		},
		Routen: func() ([]Route, error) {
			return []Route{{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"),
				Gateway: netip.MustParseAddr("192.168.178.1")}}, nil
		},
		Nachbarn: func() ([]Nachbar, error) { return arp, nil },
		Anstoss:  func(_ context.Context, _ netip.Addr) error { return nil },
		Bekannt:  bekannt,
	}
}

func sucheOhneFehler(t *testing.T, u Umgebung) Ausgang {
	t.Helper()
	l, grund := Neu(u, nil)
	if grund != "" {
		t.Fatal(grund)
	}
	aus := l.Suche(context.Background())
	if err := ergebnisAus(aus).Pruefe(geraetesuche.BoxArtEdgeLight); err != nil {
		t.Fatalf("the box would send a result the contract refuses: %v", err)
	}
	return aus
}

func findMitSchluessel(funde []geraetesuche.Fund, schluessel string) (geraetesuche.Fund, bool) {
	for _, f := range funde {
		if f.Schluessel == schluessel {
			return f, true
		}
	}
	return geraetesuche.Fund{}, false
}

// Test case 1: the device moved - its old address went silent, the same MAC
// answers under a new one, and the device's own recogniser confirms it there.
func TestWiederfindenGeraetZiehtUm(t *testing.T) {
	n := neuesTestnetz()
	eb := n.modbus(t, "192.168.178.41:502")
	eb.SetzeText(1, 0x0C20, 12, "M31-AXAX4040G")

	arp := []Nachbar{{IP: netip.MustParseAddr("192.168.178.41"), MAC: mac("00:11:22:aa:bb:10"), Schnittstelle: "eth0"}}
	bekannt := []Bekannt{{Communication: "ebyte_modbus_tcp", IP: "192.168.178.40", Port: 502, MAC: "00:11:22:aa:bb:10"}}
	aus := sucheOhneFehler(t, wiederfindenUmgebung(n, arp, bekannt))

	if _, ok := findMitSchluessel(aus.Funde, "ebyte:192.168.178.40:502"); ok {
		t.Fatalf("the stale address must not be reported: %+v", aus.Funde)
	}
	neu, ok := findMitSchluessel(aus.Funde, "ebyte:192.168.178.41:502")
	if !ok || !neu.LiestBoxSchon {
		t.Fatalf("the device must be reported as already known under its new address: %+v", aus.Funde)
	}
}

// Test case 2: a foreign device - a different MAC - now answers at the
// configured address, and the pinned MAC is nowhere else. The real device is
// reported for what it is, never dressed up as the box's own known device.
func TestWiederfindenFremdesGeraetAnAlterAdresse(t *testing.T) {
	n := neuesTestnetz()
	eb := n.modbus(t, "192.168.178.40:502")
	eb.SetzeText(1, 0x0C20, 12, "M31-AXAX4040G")

	arp := []Nachbar{{IP: netip.MustParseAddr("192.168.178.40"), MAC: mac("00:11:22:aa:bb:99"), Schnittstelle: "eth0"}}
	bekannt := []Bekannt{{Communication: "ebyte_modbus_tcp", IP: "192.168.178.40", Port: 502, MAC: "00:11:22:aa:bb:10"}}
	aus := sucheOhneFehler(t, wiederfindenUmgebung(n, arp, bekannt))

	f, ok := findMitSchluessel(aus.Funde, "ebyte:192.168.178.40:502")
	if !ok {
		t.Fatalf("the device actually there must still be found: %+v", aus.Funde)
	}
	if f.LiestBoxSchon {
		t.Fatalf("a foreign device must never inherit the stale liest_box_schon claim: %+v", f)
	}
	for _, g := range aus.Funde {
		if g.LiestBoxSchon {
			t.Fatalf("no fund may claim liest_box_schon while the real device is lost: %+v", g)
		}
	}
}

// Test case 3: the device answers nowhere at all - neither at the configured
// address nor anywhere else under its pinned MAC. It is reported as missing
// by staying out of the result, never by repeating the stale claim.
func TestWiederfindenGeraetAntwortetNicht(t *testing.T) {
	n := neuesTestnetz()
	arp := []Nachbar{{IP: netip.MustParseAddr("192.168.178.90"), MAC: mac("00:11:22:aa:bb:99"), Schnittstelle: "eth0"}}
	bekannt := []Bekannt{{Communication: "ebyte_modbus_tcp", IP: "192.168.178.40", Port: 502, MAC: "00:11:22:aa:bb:10"}}
	aus := sucheOhneFehler(t, wiederfindenUmgebung(n, arp, bekannt))

	for _, f := range aus.Funde {
		if f.Erkenner == "ebyte" {
			t.Fatalf("an unreachable device must not appear at all: %+v", f)
		}
	}
}

// Test case 4: two configured devices swap addresses (a router giving out
// new leases on a reboot). Each is confirmed, by its OWN MAC, under the
// other's former address - never cross-wired.
func TestWiederfindenZweiGeraeteTauschenAdressen(t *testing.T) {
	n := neuesTestnetz()
	a := n.modbus(t, "192.168.178.40:502")
	a.SetzeText(1, 0x0C20, 12, "M31-AXAX4040G")
	b := n.modbus(t, "192.168.178.41:502")
	b.SetzeText(1, 0x0C20, 12, "M31-AXAX8080G")

	arp := []Nachbar{
		{IP: netip.MustParseAddr("192.168.178.40"), MAC: mac("00:11:22:aa:bb:20"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.41"), MAC: mac("00:11:22:aa:bb:10"), Schnittstelle: "eth0"},
	}
	bekannt := []Bekannt{
		{Communication: "ebyte_modbus_tcp", IP: "192.168.178.40", Port: 502, MAC: "00:11:22:aa:bb:10"}, // A, now at .41
		{Communication: "ebyte_modbus_tcp", IP: "192.168.178.41", Port: 502, MAC: "00:11:22:aa:bb:20"}, // B, now at .40
	}
	aus := sucheOhneFehler(t, wiederfindenUmgebung(n, arp, bekannt))

	anAlt, ok := findMitSchluessel(aus.Funde, "ebyte:192.168.178.40:502")
	if !ok || !anAlt.LiestBoxSchon {
		t.Fatalf("B at A's old address must be confirmed: %+v", aus.Funde)
	}
	anNeu, ok := findMitSchluessel(aus.Funde, "ebyte:192.168.178.41:502")
	if !ok || !anNeu.LiestBoxSchon {
		t.Fatalf("A at B's old address must be confirmed: %+v", aus.Funde)
	}
	anzahlEbyte := 0
	for _, f := range aus.Funde {
		if f.Erkenner == "ebyte" {
			anzahlEbyte++
		}
	}
	if anzahlEbyte != 2 {
		t.Fatalf("exactly the two physical devices, no stale duplicate: %d funde", anzahlEbyte)
	}
}
