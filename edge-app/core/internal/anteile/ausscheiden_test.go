package anteile

import (
	"math/big"
	"testing"
)

// AP-15 §5.5 (Ausscheiden): die ausscheidende Box bekommt als letztes Dokument den
// Übergang mit ihrem eigenen Anteil 0 in beiden Richtungen. Es nennt sie - also
// kein box_fehlt_im_dokument -, sie nimmt es an (und quittiert es wie jedes); ein
// gehaltener Anteil 0 ist ein gültiger Anteil, kein "kein Anteil" (V5). Zahlen aus
// R1/R3: E-4 60/77 -> 0/0, E-1 bleibt 40/0.
func TestAusscheidenEigenerAnteilNullWirdAngenommen(t *testing.T) {
	id := Identitaet{Mandant: "t-1", Anlage: "an-1", Box: "e-4"}
	d := Dokument{Mandant: "t-1", Anlage: "an-1", Epoche: 1, Revision: 3,
		Verteilbar: map[string]*big.Rat{"einspeisung": big.NewRat(100, 1), "bezug": big.NewRat(77, 1)},
		Anteile: map[string]map[string]*big.Rat{
			"einspeisung": {"e-1": big.NewRat(40, 1), "e-4": new(big.Rat)},
			"bezug":       {"e-1": new(big.Rat), "e-4": new(big.Rat)},
		}}
	if p := DokumentPruefen(id, &Stand{Epoche: 1, Revision: 2}, d); !p.Angenommen() {
		t.Fatalf("eigener Anteil 0 muss angenommen werden: %+v", p)
	}
	// Der Übergang verengt nur die ausscheidende Box (G5): E-4 fällt, E-1 bleibt.
	u := Uebergangsstand(map[string]*big.Rat{"e-1": big.NewRat(40, 1), "e-4": big.NewRat(60, 1)},
		map[string]*big.Rat{"e-1": big.NewRat(100, 1)})
	if u.Uebergang["e-4"].Sign() != 0 || u.Uebergang["e-1"].Cmp(big.NewRat(40, 1)) != 0 {
		t.Fatalf("Übergang: %v", u.Uebergang)
	}
	if len(u.VerengteBoxen) != 1 || u.VerengteBoxen[0] != "e-4" {
		t.Fatalf("verengt: %v", u.VerengteBoxen)
	}
	// Ein Dokument OHNE die Box (der Zielstand der verbleibenden) ginge nie an sie - sie verwürfe es.
	delete(d.Anteile["einspeisung"], "e-4")
	delete(d.Anteile["bezug"], "e-4")
	if p := DokumentPruefen(id, &Stand{Epoche: 1, Revision: 3}, d); p.Grund != GrundBoxFehlt {
		t.Fatalf("ohne die eigene Box: %+v", p)
	}
}
