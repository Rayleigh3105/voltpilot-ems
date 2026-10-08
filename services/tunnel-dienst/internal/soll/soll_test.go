package soll

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
