package gehaeuse

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// hochladerFunc hält jeden Aufruf fest; fehler (falls gesetzt) lässt ihn scheitern.
// offen ist die Antwort auf den Abgleich (GehaeuseOffen); offenFehler lässt ihn scheitern.
type hochladerFunc struct {
	mu          sync.Mutex
	fehler      error
	rufe        []string
	offen       []string
	offenFehler error
	offenRufe   int
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

func (h *hochladerFunc) GehaeuseOffen(_ context.Context) ([]string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.offenRufe++
	if h.offenFehler != nil {
		return nil, h.offenFehler
	}
	return h.offen, nil
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
	}), h, time.Minute, time.Hour, stumm)
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
	}), h, time.Minute, time.Hour, stumm)
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
	}), h, time.Minute, time.Hour, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w2)
	warteHochgeladen(t, w2, refA)
}

// Ein Fehlschlag beim Hochladen muss nicht erst einen Neustart des Dienstes
// abwarten: Laufe holt ihn auch im eigenen Takt nach, solange die Schlange
// leer ist (laufende Behebung des Problems - Portal kurz nicht erreichbar).
func TestHochladenWirdImTaktNachgeholtOhneNeustart(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{fehler: errors.New("Portal nicht erreicht")}
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, 20*time.Millisecond, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	if _, err := w.Bestelle(refA, "", false); err != nil {
		t.Fatal(err)
	}
	warteAuf(t, w, refA, Fertig)
	h.mu.Lock()
	h.fehler = nil
	h.mu.Unlock()
	warteHochgeladen(t, w, refA)
}

// Eine abgenommene Box ohne Druckdatei im Portal und ohne Auftrag in der
// Ablage (zu alt für vp-mango-3mf-pro-box, wie edge-cyhchfr) reiht der Dienst
// im Takt von selbst ein - ohne Neustart, ohne Handgriff.
func TestAbgleichReihtUnbekannteBoxAutomatischEin(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{offen: []string{refA}}
	var baue int32
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		atomic.AddInt32(&baue, 1)
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, 20*time.Millisecond, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	warteHochgeladen(t, w, refA)
	if n := atomic.LoadInt32(&baue); n != 1 {
		t.Fatalf("%d Bauten für die automatisch eingereihte Box", n)
	}
}

// Kein Doppelauftrag: Eine Box, die der Abgleich schon kennt - sei es, weil
// sie noch wartet/baut, sei es, weil ihr letzter Bau scheiterte -, reiht
// Laufe nicht noch einmal ein. Ein Fehler wartet bewusst auf „Erneut
// erstellen“ statt auf einen endlosen automatischen Nachbau.
func TestAbgleichReihtBekannteBoxNichtDoppeltEin(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{offen: []string{refA}}
	var baue int32
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		atomic.AddInt32(&baue, 1)
		schreibeBau(t, ziel, ref, "ein Fehler")
		return nil
	}), h, time.Minute, 20*time.Millisecond, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	warteAuf(t, w, refA, Fehler)
	time.Sleep(80 * time.Millisecond) // mehrere Takte Zeit geben
	if n := atomic.LoadInt32(&baue); n != 1 {
		t.Fatalf("%d Bauten, ein Fehler darf nicht automatisch wieder eingereiht werden", n)
	}
}

// Ein Fehlschlag beim Abgleich selbst (Portal kurz nicht erreichbar) ist nur
// eine Warnung: der nächste Takt versucht es wieder, nichts hält an.
func TestAbgleichFehlschlagWirdImTaktWiederholt(t *testing.T) {
	ablage := t.TempDir()
	h := &hochladerFunc{offenFehler: errors.New("Portal nicht erreicht"), offen: []string{refA}}
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), h, time.Minute, 20*time.Millisecond, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	time.Sleep(60 * time.Millisecond)
	if len(w.Auftraege()) != 0 {
		t.Fatalf("ein gescheiterter Abgleich darf nichts einreihen: %+v", w.Auftraege())
	}
	h.mu.Lock()
	h.offenFehler = nil
	h.mu.Unlock()
	warteHochgeladen(t, w, refA)
}
