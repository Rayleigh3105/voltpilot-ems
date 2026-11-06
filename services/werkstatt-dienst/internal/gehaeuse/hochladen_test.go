package gehaeuse

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// hochladerFunc hält jeden Aufruf fest; fehler (falls gesetzt) lässt ihn scheitern.
type hochladerFunc struct {
	mu     sync.Mutex
	fehler error
	rufe   []string
}

func (h *hochladerFunc) GehaeuseHochladen(_ context.Context, edgeRef, name string, daten []byte, sha256 string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rufe = append(h.rufe, edgeRef+" "+name+" "+sha256)
	if h.fehler != nil {
		return h.fehler
	}
	return nil
}

func (h *hochladerFunc) anzahl() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rufe)
}

func warteHochgeladen(t *testing.T, w *Werkstatt, ref string) Auftrag {
	t.Helper()
	ende := time.Now().Add(5 * time.Second)
	for time.Now().Before(ende) {
		for _, a := range w.Auftraege() {
			if a.Referenz == ref && a.Zustand == Fertig && a.Hochgeladen {
				return a
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s wurde nicht hochgeladen: %+v", ref, w.Auftraege())
	return Auftrag{}
}

func TestFertigLaedtDieBoxDruckdateiHoch(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{}
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	if _, err := w.Bestelle(refA, "", false); err != nil {
		t.Fatal(err)
	}
	warteHochgeladen(t, w, refA)
	if h.anzahl() != 1 {
		t.Fatalf("Hochladen wurde %d statt 1 mal gerufen", h.anzahl())
	}
	if len(h.rufe) != 1 || h.rufe[0][:len(refA)] != refA {
		t.Fatalf("unerwarteter Aufruf: %+v", h.rufe)
	}
}

func TestHochladenFehlschlagBlockiertDenLaufNichtUndWirdNachgeholt(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{fehler: errors.New("Portal nicht erreicht")}
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	if _, err := w.Bestelle(refA, "", false); err != nil {
		t.Fatal(err)
	}
	fertig := warteAuf(t, w, refA, Fertig)
	time.Sleep(50 * time.Millisecond) // dem (gescheiterten) Upload-Versuch Zeit geben
	for _, a := range w.Auftraege() {
		if a.Referenz == refA && a.Hochgeladen {
			t.Fatal("ein gescheiterter Upload darf Hochgeladen nicht setzen")
		}
	}
	if fertig.Zustand != Fertig {
		t.Fatal("ein gescheiterter Upload darf den Bau-Zustand nicht ändern")
	}

	// Der nächste Anlauf (Neu + Laufe) holt den Upload nach, jetzt ohne Fehler.
	h.mu.Lock()
	h.fehler = nil
	h.mu.Unlock()
	w2, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w2)
	warteHochgeladen(t, w2, refA)
}
