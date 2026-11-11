package dienst_test

import (
	"context"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
)

// „Nochmal versuchen“ aus dem Portal (Entscheid E1 A der Lauf-Seite): Der
// Auftrag kommt mit der Antwort auf die Meldung der Ansicht. Für einen Fall
// ohne Handgriff an der Box gibt der Dienst die Sperre frei, wie beim
// Abziehen des Kabels, und beginnt nach der Startprüfung neu; an der Box wird
// dabei nichts ausgeführt. Ein Auftrag für einen anderen Lauf, ein zweiter
// für denselben und einer für einen Fall mit Handgriff tun nichts.
func TestNochmalVersuchenGibtDieSperreFrei(t *testing.T) {
	m := attrappe.NeueMango(t, true)
	m.HalbEingerichtet("10.213.0.1", "unbekannt")
	w := werkbankMit(t, m, &standPortal{stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3"}}})
	halberLauf(t, w.ablage, m.MAC, "SHA256:einanderer", bisLan...)
	melder := &melderAttrappe{}
	w.d.Melder = melder
	ctx := context.Background()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	s := w.bisEnde(t)
	if s.Fall != faelle.NichtNachweisbar || !s.NochmalMoeglich || !s.NochmalSeit.IsZero() {
		t.Fatalf("%+v", s)
	}
	w.d.Runde(ctx)
	if a := w.d.Ansicht(); a.AnschlussFall != faelle.Gesperrt {
		t.Fatalf("nicht gesperrt: %s", a.Anschluss)
	}

	// Ein Auftrag für einen anderen Lauf und eine unbekannte Art: nichts.
	melder.auftraege = []portal.Auftrag{{ID: "a1", Art: "nochmal", Lauf: "2026-11-04-162800-ab12"}, {ID: "a2", Art: "loeschen", Lauf: s.Kennung}}
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	if a := w.d.Ansicht(); a.AnschlussFall != faelle.Gesperrt || a.Lauf.Kennung != s.Kennung || !a.Lauf.NochmalSeit.IsZero() {
		t.Fatalf("%+v %+v", a.AnschlussFall, a.Lauf)
	}

	melder.auftraege = []portal.Auftrag{{ID: "a3", Art: "nochmal", Lauf: s.Kennung}}
	w.d.Runde(ctx) // meldet, holt den Auftrag ab und gibt die Sperre frei
	if a := w.d.Ansicht(); a.Lauf.NochmalSeit.IsZero() {
		t.Fatalf("Auftrag nicht angenommen: %+v", a.Lauf)
	}
	w.d.Runde(ctx) // Startprüfung: die Box steht ein zweites Mal gleich da
	w.d.Runde(ctx)
	n := w.d.Ansicht().Lauf
	if n == nil || n.Kennung == s.Kennung {
		t.Fatalf("kein neuer Lauf nach dem Auftrag: %s", w.d.Ansicht().Anschluss)
	}
	n2 := w.bisEnde(t)
	if n2.Fall != faelle.NichtNachweisbar {
		t.Fatalf("neuer Lauf: %+v", n2)
	}
	if len(m.Befehle()) != 0 {
		t.Fatalf("an der Box ausgeführt: %v", m.Befehle())
	}

	// Ein zweiter Auftrag für den alten Lauf: nichts mehr (er ist nicht der letzte).
	w.d.Runde(ctx)
	melder.auftraege = []portal.Auftrag{{ID: "a4", Art: "nochmal", Lauf: s.Kennung}}
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	if a := w.d.Ansicht(); a.AnschlussFall != faelle.Gesperrt || a.Lauf.Kennung != n2.Kennung {
		t.Fatalf("%+v %+v", a.AnschlussFall, a.Lauf)
	}
}

// Ein Fall mit Handgriff an der Box (hier der Reset bei gl_passwort) bietet
// kein „Nochmal“ an, und ein Auftrag dafür ändert nichts.
func TestNochmalNieBeiHandgriffAnDerBox(t *testing.T) {
	m := attrappe.NeueMango(t, false)
	m.RootPasswortAbWerk = true
	w := werkbankMit(t, m, nil)
	melder := &melderAttrappe{}
	w.d.Melder = melder
	ctx := context.Background()
	w.d.Runde(ctx)
	w.d.Runde(ctx)
	s := w.bisEnde(t)
	if s.Fall != faelle.GLPasswort || s.NochmalMoeglich || s.Zustand != lauf.Angehalten {
		t.Fatalf("%+v", s)
	}
	if s.Vorher == nil || !strings.Contains(s.Vorher.System, "unbekannt") {
		t.Fatalf("vorher: %+v", s.Vorher)
	}
	melder.auftraege = []portal.Auftrag{{ID: "a1", Art: "nochmal", Lauf: s.Kennung}}
	for i := 0; i < 3; i++ {
		w.d.Runde(ctx)
	}
	if a := w.d.Ansicht(); a.AnschlussFall != faelle.Gesperrt || a.Lauf.Kennung != s.Kennung || !a.Lauf.NochmalSeit.IsZero() {
		t.Fatalf("%+v %+v", a.AnschlussFall, a.Lauf)
	}
}

// Jeder Fall mit „Nochmal“ ist einer ohne Reset, Startlader oder „zur Seite“
// als Hauptweg - außer nicht_nachweisbar, das „zur Seite“ zeigt und „Nochmal“
// nur leise anbietet (das Portal antwortete vielleicht nur nicht).
func TestNochmalNurOhneHandgriffAnDerBox(t *testing.T) {
	for _, c := range faelle.Codes() {
		if !faelle.Nochmal(c) {
			continue
		}
		switch c {
		case faelle.GLPasswort, faelle.HalbEigene, faelle.SSHZu, faelle.AbbildAbgelehnt, faelle.OpenWrtFassung:
			t.Fatalf("%s braucht einen Handgriff an der Box", c)
		}
		if l := faelle.Zu(c); l.ZurSeite && c != faelle.NichtNachweisbar {
			t.Fatalf("%s geht zur Seite", c)
		}
	}
}
