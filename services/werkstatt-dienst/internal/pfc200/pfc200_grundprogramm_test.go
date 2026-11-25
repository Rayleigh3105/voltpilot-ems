package pfc200_test

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
)

// Die vier Fälle des Schritts grundprogramm, die der Dienst nie von selbst
// löst: alte Firmware, kein Grundprogramm in der Fassung, eine falsche
// Prüfsumme (hält schon im Schritt fassungen, nie am Gerät) und ein fremdes
// Programm auf der SPS.

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

func TestGrundprogrammFehltInDerFassung(t *testing.T) {
	t.Parallel()
	a := neu(t)
	a.f.EdgeIndustrie.GrundprogrammSha256 = ""
	s := a.halt(t, "grundprogramm", faelle.PFCKeinGrundprogramm)
	if !strings.Contains(s.Grund, a.f.EdgeIndustrie.Fassung) {
		t.Fatalf("Grund nennt nicht die Fassung: %s", s.Grund)
	}
	if !s.Loesung.ZurSeite {
		t.Fatal("nicht zur Seite")
	}
	for _, z := range a.p.Befehle() {
		if strings.Contains(z, "PlcLogic") {
			t.Fatalf("das Gerät wurde trotz fehlendem Grundprogramm angefasst: %q", z)
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
