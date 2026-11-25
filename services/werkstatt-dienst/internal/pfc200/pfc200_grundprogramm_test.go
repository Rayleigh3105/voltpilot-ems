package pfc200_test

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/pfc200"
)

// Trägt die Freigabe kein Grundprogramm, übergeht sich der Schritt (kein
// Handgriff, nichts am Gerät geändert, der Lauf macht normal weiter) - auch
// wenn die Firmware zu alt dafür wäre: Sonst bliebe jeder Lauf stehen,
// solange noch keine Fassung ein Grundprogramm trägt.
func TestGrundprogrammUebersprungenOhneGrundprogrammInDerFassung(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.f.EdgeIndustrie.GrundprogrammSha256 = ""
	l, z := a.fahre(t, pfc200.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s im Schritt %s: %s", z, l.Stand().Schritt, l.Stand().Grund)
	}
	g := wert(t, a.belege(t, l)["grundprogramm"], "grundprogramm")
	if !strings.Contains(g, "übersprungen") || !strings.Contains(g, "kein Grundprogramm") {
		t.Fatalf("Beleg nennt nicht übersprungen: %q", g)
	}
	for _, x := range a.p.Befehle() {
		if strings.Contains(x, "PlcLogic") {
			t.Fatalf("das Gerät wurde trotz fehlendem Grundprogramm angefasst: %q", x)
		}
	}
}

func TestGrundprogrammUebersprungenAuchBeiZuAlterFirmware(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.f.EdgeIndustrie.GrundprogrammSha256 = ""
	a.p.SetzeFirmware("03.10.08(22)")
	l, z := a.fahre(t, pfc200.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s im Schritt %s: %s", z, l.Stand().Schritt, l.Stand().Grund)
	}
	g := wert(t, a.belege(t, l)["grundprogramm"], "grundprogramm")
	if !strings.Contains(g, "übersprungen") {
		t.Fatalf("Beleg nennt nicht übersprungen: %q", g)
	}
	for _, x := range a.p.Befehle() {
		if strings.Contains(x, "PlcLogic") {
			t.Fatalf("das Gerät wurde trotz fehlendem Grundprogramm angefasst: %q", x)
		}
	}
}

// Die drei verbliebenen Fälle des Schritts grundprogramm, die der Dienst nie
// von selbst löst (nur wenn die Freigabe ein Grundprogramm trägt): alte
// Firmware, eine falsche Prüfsumme (hält schon im Schritt fassungen, nie am
// Gerät) und ein fremdes Programm auf der SPS.

func TestGrundprogrammFirmwareZuAlt(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.p.SetzeFirmware("03.10.08(22)")
	s := a.halt(t, "grundprogramm", faelle.PFCFirmwareAlt)
	if !strings.Contains(s.Grund, "03.10.08(22)") || !strings.Contains(s.Grund, "04.xx") {
		t.Fatalf("Grund nennt nicht Firmware und Soll: %s", s.Grund)
	}
	if !s.Loesung.ZurSeite {
		t.Fatal("nicht zur Seite")
	}
	for _, z := range a.p.Befehle() {
		if strings.Contains(z, "PlcLogic") {
			t.Fatalf("das Gerät wurde trotz alter Firmware angefasst: %q", z)
		}
	}
}

// Eine Freigabe, deren Prüfsumme nicht die des signierten Manifests ist, hält
// schon im Schritt fassungen (manifestHolen bindet die Prüfsumme der
// Freigabe an das Manifest) - nie im Schritt grundprogramm, nie am Gerät.
func TestGrundprogrammPruefsummeStimmtNichtMitDemManifestUeberein(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.f.EdgeIndustrie.GrundprogrammSha256 = strings.Repeat("9", 64)
	a.halt(t, "fassungen", faelle.FassungNichtBereit)
	a.unveraendert(t)
}

// Auf der SPS liegt schon eine Boot-Applikation, die keine Marke dieser
// Werkstatt trägt: Der Dienst überschreibt sie nie von selbst.
func TestGrundprogrammFremdesProgrammAufDerSps(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.p.SchreibeDatei(codesysOrdner+"/Application.app", "fremdes Projekt, nicht von dieser Werkstatt")
	s := a.halt(t, "grundprogramm", faelle.PFCGrundprogrammFremd)
	if !strings.Contains(s.Grund, "1 Datei") {
		t.Fatalf("Grund nennt nicht die vorhandene Datei: %s", s.Grund)
	}
	if !s.Loesung.ZurSeite {
		t.Fatal("nicht zur Seite")
	}
	for _, z := range a.p.Befehle() {
		if strings.Contains(z, "tar -xzf") {
			t.Fatalf("das fremde Programm wurde überschrieben: %q", z)
		}
	}
	if got := a.p.Datei(codesysOrdner + "/Application.app"); got != "fremdes Projekt, nicht von dieser Werkstatt" {
		t.Fatalf("die fremde Datei wurde verändert: %q", got)
	}
}
