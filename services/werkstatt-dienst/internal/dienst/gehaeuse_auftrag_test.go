package dienst_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/gehaeuse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
)

// gehaeuseAttrappe hält jede Bestellung fest; fehler (falls gesetzt) lässt sie scheitern.
type gehaeuseAttrappe struct {
	bestellt []string
	fehler   error
}

func (g *gehaeuseAttrappe) Bestelle(ref, lauf string, neu bool) (gehaeuse.Auftrag, error) {
	if g.fehler != nil {
		return gehaeuse.Auftrag{}, g.fehler
	}
	eintrag := ref
	if neu {
		eintrag += " neu"
	}
	g.bestellt = append(g.bestellt, eintrag)
	return gehaeuse.Auftrag{Referenz: ref, Zustand: gehaeuse.Wartet}, nil
}

func (g *gehaeuseAttrappe) Offene() []gehaeuse.Auftrag { return nil }

// „Erneut erstellen“ der Box-Druckdatei (P10, Box-Seite im Portal): Der
// Auftrag „gehaeuse“ kommt wie „nochmal“ mit der Antwort auf die Meldung der
// Ansicht; a.Lauf trägt hier die Edge-Referenz. Der Dienst reiht ihren Bau
// noch einmal ein (neu=true, auch ein schon fertiger baut noch einmal -
// Nachdruck nach einem behobenen Fehler). Ein unbekannter Auftrag und ein
// Fehlschlag der Schlange ändern nichts.
func TestGehaeuseAuftragReihtDenBauErneutEin(t *testing.T) {
	a := neu(t, time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC))
	fake := &gehaeuseAttrappe{}
	a.d.Mango = &mango.Konfig{Gehaeuse: fake}
	melder := &melderAttrappe{}
	a.d.Melder = melder
	ctx := context.Background()
	a.d.Runde(ctx)

	melder.auftraege = []portal.Auftrag{{ID: "g1", Art: "gehaeuse", Lauf: "edge-k7m2xq3"}}
	a.d.Runde(ctx)
	if len(fake.bestellt) != 1 || fake.bestellt[0] != "edge-k7m2xq3 neu" {
		t.Fatalf("eingereiht: %v", fake.bestellt)
	}

	// Ein Fehlschlag der Schlange ändert nichts außer dem Log.
	fake.fehler = errors.New("Ablage voll")
	melder.auftraege = []portal.Auftrag{{ID: "g2", Art: "gehaeuse", Lauf: "edge-k7m2xq3"}}
	a.d.Runde(ctx)
	if len(fake.bestellt) != 1 {
		t.Fatalf("ein gescheiterter Auftrag darf nicht als bestellt gelten: %v", fake.bestellt)
	}
}

// Kein Gehäuse-Bau eingerichtet (d.Mango.Gehaeuse nil): der Auftrag tut nichts.
func TestGehaeuseAuftragOhneGehaeuseBauTutNichts(t *testing.T) {
	a := neu(t, time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC))
	a.d.Mango = &mango.Konfig{}
	melder := &melderAttrappe{}
	a.d.Melder = melder
	ctx := context.Background()
	melder.auftraege = []portal.Auftrag{{ID: "g1", Art: "gehaeuse", Lauf: "edge-k7m2xq3"}}
	a.d.Runde(ctx) // darf nicht in Panik enden
}
