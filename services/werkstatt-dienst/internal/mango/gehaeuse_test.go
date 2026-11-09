package mango_test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/gehaeuse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
)

type schlange struct {
	mu       sync.Mutex
	bestellt []string
	fehler   error
}

func (s *schlange) Bestelle(ref, kennung string, neu bool) (gehaeuse.Auftrag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fehler != nil {
		return gehaeuse.Auftrag{}, s.fehler
	}
	s.bestellt = append(s.bestellt, ref+" "+kennung)
	if neu {
		s.bestellt = append(s.bestellt, "neu?")
	}
	return gehaeuse.Auftrag{Referenz: ref, Lauf: kennung, Zustand: gehaeuse.Wartet}, nil
}

func (s *schlange) Offene() []gehaeuse.Auftrag { return nil }

// Schritt 19: Nach der Übergabe ist die Druckdatei des Gehäuses bestellt, für
// genau diese Referenz und diesen Lauf; der Lauf wartet nicht auf den Bau.
func TestNachDerUebergabeIstDasGehaeuseBestellt(t *testing.T) {
	a := neu(t, true)
	s := &schlange{}
	a.k.Gehaeuse = s
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v", z, l.Stand())
	}
	if len(s.bestellt) != 1 || s.bestellt[0] != "edge-k7m2xq3 "+l.Kennung() {
		t.Fatalf("bestellt: %v", s.bestellt)
	}
	if b := wert(t, a.belege(t, l)["uebergabe"], "gehaeuse"); !strings.Contains(b, "Druckdatei bestellt (wartet)") {
		t.Errorf("Beleg: %q", b)
	}
}

// Die Abnahme steht schon: Eine Schlange, die nicht annimmt, hält den Lauf nicht an.
func TestOhneBestellungBleibtDerLaufFertig(t *testing.T) {
	a := neu(t, true)
	a.k.Gehaeuse = &schlange{fehler: errors.New("Ablage voll")}
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v", z, l.Stand())
	}
	if b := wert(t, a.belege(t, l)["uebergabe"], "gehaeuse"); b != "nicht bestellt: Ablage voll" {
		t.Errorf("Beleg: %q", b)
	}
}
