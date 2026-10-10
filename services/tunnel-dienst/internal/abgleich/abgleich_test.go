package abgleich

import (
	"net/netip"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

var (
	jetzt  = time.Date(2026, 10, 7, 14, 0, 0, 0, time.UTC)
	box1   = netip.MustParseAddr("10.10.16.2")
	box2   = netip.MustParseAddr("10.10.16.3")
	tech   = netip.MustParseAddr("10.10.32.2")
	keyB1  = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="
	keyB2  = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="
	keyT   = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="
	keyAlt = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c="
)

func opt() Optionen {
	return Optionen{Jetzt: jetzt, MitFenster: true, MaxEntfernen: 10, MaxFenster: 24 * time.Hour,
		Toleranz: 10 * time.Second, Vorlauf: time.Minute}
}

func gueltig(fenster ...soll.FensterSoll) soll.Gueltig {
	return soll.Gueltig{
		Peers: map[string]soll.PeerSoll{
			keyB1: {Art: "box", ID: "b1", Kennung: "edge-a", PublicKey: keyB1, Adresse: box1},
			keyB2: {Art: "box", ID: "b2", Kennung: "edge-b", PublicKey: keyB2, Adresse: box2},
			keyT:  {Art: "techniker", ID: "t1", Kennung: "Max", PublicKey: keyT, Adresse: tech},
		},
		Fenster: fenster,
	}
}

func pfx(a netip.Addr) []netip.Prefix { return []netip.Prefix{netip.PrefixFrom(a, 32)} }

func TestLeererServerBekommtAllePeersUndNochKeinFenster(t *testing.T) {
	p := Rechne(gueltig(), Ist{Peers: map[string][]netip.Prefix{}, Fenster: map[Paar]time.Duration{}}, opt())
	if len(p.PeersSetzen) != 3 || len(p.FensterHinzufuegen) != 0 || len(p.PeersEntfernen) != 0 {
		t.Fatalf("%+v", p)
	}
	for _, s := range p.PeersSetzen {
		if !s.Neu {
			t.Fatalf("neu erwartet: %+v", s)
		}
	}
}

func TestIdempotentWennAllesStimmt(t *testing.T) {
	f := soll.FensterSoll{ID: "f1", Techniker: tech, Box: box1, Beginn: jetzt.Add(-time.Minute), Ende: jetzt.Add(time.Hour)}
	ist := Ist{
		Peers:   map[string][]netip.Prefix{keyB1: pfx(box1), keyB2: pfx(box2), keyT: pfx(tech)},
		Fenster: map[Paar]time.Duration{{tech, box1}: time.Hour - 3*time.Second},
	}
	if p := Rechne(gueltig(f), ist, opt()); !p.Leer() || len(p.Alarme) != 0 {
		t.Fatalf("nichts zu tun erwartet: %+v", p)
	}
}

func TestOffenesFensterWirdMitRestlaufzeitGesetzt(t *testing.T) {
	f := soll.FensterSoll{ID: "f1", Techniker: tech, Box: box1, Beginn: jetzt.Add(-time.Minute), Ende: jetzt.Add(90 * time.Minute)}
	ist := Ist{Peers: map[string][]netip.Prefix{keyB1: pfx(box1), keyB2: pfx(box2), keyT: pfx(tech)}}
	p := Rechne(gueltig(f), ist, opt())
	if len(p.FensterHinzufuegen) != 1 {
		t.Fatalf("%+v", p)
	}
	e := p.FensterHinzufuegen[0]
	if e.Paar != (Paar{tech, box1}) || e.Timeout != 90*time.Minute || e.FensterID != "f1" {
		t.Fatalf("%+v", e)
	}
}

func TestGeschlossenesFensterWirdEntferntUndNichtsAnderes(t *testing.T) {
	ist := Ist{
		Peers:   map[string][]netip.Prefix{keyB1: pfx(box1), keyB2: pfx(box2), keyT: pfx(tech)},
		Fenster: map[Paar]time.Duration{{tech, box1}: 50 * time.Minute},
	}
	p := Rechne(gueltig(), ist, opt())
	if len(p.FensterEntfernen) != 1 || p.FensterEntfernen[0] != (Paar{tech, box1}) || len(p.FensterHinzufuegen) != 0 {
		t.Fatalf("%+v", p)
	}
}

func TestAbweichendeRestlaufzeitWirdErsetzt(t *testing.T) {
	f := soll.FensterSoll{ID: "f1", Techniker: tech, Box: box1, Beginn: jetzt.Add(-time.Minute), Ende: jetzt.Add(time.Hour)}
	ist := Ist{
		Peers:   map[string][]netip.Prefix{keyB1: pfx(box1), keyB2: pfx(box2), keyT: pfx(tech)},
		Fenster: map[Paar]time.Duration{{tech, box1}: 4 * time.Hour},
	}
	p := Rechne(gueltig(f), ist, opt())
	if len(p.FensterEntfernen) != 1 || len(p.FensterHinzufuegen) != 1 || p.FensterHinzufuegen[0].Timeout != time.Hour {
		t.Fatalf("%+v", p)
	}
}

func TestZukuenftigesUndAbgelaufenesFensterOeffnetNichts(t *testing.T) {
	spaeter := soll.FensterSoll{ID: "s", Techniker: tech, Box: box1, Beginn: jetzt.Add(10 * time.Minute), Ende: jetzt.Add(time.Hour)}
	vorbei := soll.FensterSoll{ID: "v", Techniker: tech, Box: box2, Beginn: jetzt.Add(-2 * time.Hour), Ende: jetzt.Add(-time.Second)}
	knapp := soll.FensterSoll{ID: "k", Techniker: tech, Box: box2, Beginn: jetzt.Add(30 * time.Second), Ende: jetzt.Add(time.Hour)}
	p := Rechne(gueltig(spaeter, vorbei, knapp), Ist{}, opt())
	if len(p.FensterHinzufuegen) != 1 || p.FensterHinzufuegen[0].FensterID != "k" {
		t.Fatalf("nur das innerhalb der Uhrabweichung begonnene: %+v", p.FensterHinzufuegen)
	}
}

func TestDerDienstDeckeltDieDauerSelbst(t *testing.T) {
	lang := soll.FensterSoll{ID: "l", Techniker: tech, Box: box1, Beginn: jetzt, Ende: jetzt.Add(30 * 24 * time.Hour)}
	p := Rechne(gueltig(lang), Ist{}, opt())
	if len(p.FensterHinzufuegen) != 1 || p.FensterHinzufuegen[0].Timeout != 24*time.Hour || len(p.Alarme) != 1 {
		t.Fatalf("%+v", p)
	}
}

func TestOhneFrischenStandWirdKeinFensterAngefasst(t *testing.T) {
	f := soll.FensterSoll{ID: "f1", Techniker: tech, Box: box1, Beginn: jetzt, Ende: jetzt.Add(time.Hour)}
	o := opt()
	o.MitFenster = false
	ist := Ist{Fenster: map[Paar]time.Duration{{tech, box2}: time.Minute}}
	p := Rechne(gueltig(f), ist, o)
	if len(p.FensterHinzufuegen) != 0 || len(p.FensterEntfernen) != 0 {
		t.Fatalf("%+v", p)
	}
}

func TestSchluesseltauschUndFremdePeers(t *testing.T) {
	// Die Box b1 hat einen neuen Schlüssel bekommen; ein Peer, den niemand
	// mehr will, und einer mit falscher Adresse.
	ist := Ist{Peers: map[string][]netip.Prefix{
		keyAlt: pfx(box1),
		keyB2:  pfx(netip.MustParseAddr("10.10.16.99")),
		keyT:   pfx(tech),
	}}
	p := Rechne(gueltig(), ist, opt())
	if len(p.PeersEntfernen) != 1 || p.PeersEntfernen[0] != keyAlt {
		t.Fatalf("entfernen: %v", p.PeersEntfernen)
	}
	if len(p.PeersSetzen) != 2 {
		t.Fatalf("setzen: %+v", p.PeersSetzen)
	}
}

func TestZuVieleEntfernungenSindAlarmStattAusfuehrung(t *testing.T) {
	ist := Ist{Peers: map[string][]netip.Prefix{keyB1: pfx(box1), keyB2: pfx(box2), keyT: pfx(tech)}}
	o := opt()
	o.MaxEntfernen = 2
	leer := soll.Gueltig{Peers: map[string]soll.PeerSoll{}}
	p := Rechne(leer, ist, o)
	if len(p.PeersEntfernen) != 0 || len(p.Alarme) != 1 {
		t.Fatalf("%+v", p)
	}
	o.MaxEntfernen = 3
	if p := Rechne(leer, ist, o); len(p.PeersEntfernen) != 3 {
		t.Fatalf("%+v", p)
	}
}

func TestWiederanlaufFuegtNurHinzu(t *testing.T) {
	o := Optionen{NurHinzufuegen: true}
	ist := Ist{Peers: map[string][]netip.Prefix{keyAlt: pfx(netip.MustParseAddr("10.10.16.50"))}}
	p := Rechne(gueltig(soll.FensterSoll{ID: "f", Techniker: tech, Box: box1, Beginn: jetzt, Ende: jetzt.Add(time.Hour)}), ist, o)
	if len(p.PeersEntfernen) != 0 || len(p.PeersSetzen) != 3 || len(p.FensterHinzufuegen) != 0 {
		t.Fatalf("%+v", p)
	}
}

func TestZweiFensterFuerDasselbePaarNehmenDasLaengere(t *testing.T) {
	a := soll.FensterSoll{ID: "a", Techniker: tech, Box: box1, Beginn: jetzt, Ende: jetzt.Add(time.Hour)}
	b := soll.FensterSoll{ID: "b", Techniker: tech, Box: box1, Beginn: jetzt, Ende: jetzt.Add(2 * time.Hour)}
	p := Rechne(gueltig(a, b), Ist{}, opt())
	if len(p.FensterHinzufuegen) != 1 || p.FensterHinzufuegen[0].Timeout != 2*time.Hour || p.FensterHinzufuegen[0].FensterID != "b" {
		t.Fatalf("%+v", p.FensterHinzufuegen)
	}
}
