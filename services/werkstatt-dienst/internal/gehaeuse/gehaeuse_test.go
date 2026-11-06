package gehaeuse

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Gültige Referenzen aus docs/contracts/edge-ref-vectors.json.
const (
	refA = "edge-k7m2xq3"
	refB = "edge-abcdefj"
	refC = "edge-mnpqrsb"
)

var stumm = slog.New(slog.NewTextHandler(io.Discard, nil))

// schreibeBau legt ab, was das Gehäuse-Programm für ref schreibt.
func schreibeBau(t *testing.T, ziel, ref string, fehler ...string) {
	t.Helper()
	dir := filepath.Join(ziel, "kennung", ref)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bericht := "# Gehäuse für " + ref + "\n\n"
	if len(fehler) == 0 {
		bericht += "- Keine verletzte Regel; der QR-Code ist aus dem G-Code lesbar.\n"
	}
	for _, f := range fehler {
		bericht += "- **Fehler:** " + f + "\n"
	}
	for name, inhalt := range map[string]string{
		"gehaeuse-" + ref + ".3mf":           "3mf-gehaeuse",
		"unterteil-" + ref + ".3mf":          "3mf-unterteil",
		"gehaeuse-" + ref + "-geslict.3mf":   "nur zur Prüfung",
		"unterseite-" + ref + ".png":         "png",
		"unterteil-" + ref + "-qr-sicht.png": "png",
		"pruefung.md":                        bericht,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(inhalt), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(ziel, Ausgabe), []byte("== Gehäuse für "+ref+"\n"), 0o644)
}

type bauerFunc func(ctx context.Context, ref, ziel string, job func(string)) error

func (f bauerFunc) Baue(ctx context.Context, ref, ziel string, job func(string)) error {
	return f(ctx, ref, ziel, job)
}

func warteAuf(t *testing.T, w *Werkstatt, ref string, z Zustand) Auftrag {
	t.Helper()
	ende := time.Now().Add(5 * time.Second)
	for time.Now().Before(ende) {
		for _, a := range w.Auftraege() {
			if a.Referenz == ref && a.Zustand == z {
				return a
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s wurde nicht %s: %+v", ref, z, w.Auftraege())
	return Auftrag{}
}

func starte(t *testing.T, w *Werkstatt) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Laufe(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel
}

func TestFertigLegtDruckdateienAbUndNichtDasGeslicte(t *testing.T) {
	ablage := t.TempDir()
	w, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, job func(string)) error {
		job("gehaeuse-" + ref + "-120000")
		schreibeBau(t, ziel, ref)
		return nil
	}), nil, time.Minute, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	if _, err := w.Bestelle(refA, "lauf-1", false); err != nil {
		t.Fatal(err)
	}
	a := warteAuf(t, w, refA, Fertig)
	var namen []string
	for _, d := range a.Dateien {
		namen = append(namen, d.Name)
		if len(d.Sha256) != 64 || d.Bytes == 0 {
			t.Errorf("Datei ohne Prüfsumme: %+v", d)
		}
	}
	want := "gehaeuse-edge-k7m2xq3.3mf pruefung.md unterseite-edge-k7m2xq3.png unterteil-edge-k7m2xq3-qr-sicht.png unterteil-edge-k7m2xq3.3mf"
	if strings.Join(namen, " ") != want {
		t.Errorf("abgelegt: %v\nwant %s", namen, want)
	}
	if a.Job != "gehaeuse-edge-k7m2xq3-120000" || a.Lauf != "lauf-1" || !strings.Contains(a.Beleg, "Keine verletzte Regel") {
		t.Errorf("Auftrag: %+v", a)
	}
	if p, ok := w.Datei(refA, "gehaeuse-"+refA+".3mf"); !ok || mussLesen(t, p) != "3mf-gehaeuse" {
		t.Errorf("Druckdatei nicht abrufbar: %s %v", p, ok)
	}
	for _, name := range []string{"gehaeuse-" + refA + "-geslict.3mf", "../" + refA + "/auftrag.json", "auftrag.json", Ausgabe} {
		if _, ok := w.Datei(refA, name); ok {
			t.Errorf("%s darf nicht abrufbar sein", name)
		}
	}
	if _, err := os.Stat(filepath.Join(ablage, refA, "bau")); !os.IsNotExist(err) {
		t.Errorf("Bauordner blieb liegen: %v", err)
	}
}

func mussLesen(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestFehlerImBerichtGibtKeineDruckdatei(t *testing.T) {
	w, _ := Neu(t.TempDir(), bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref, "Ruhezone 2,1 Module (mindestens 3)")
		return errors.New("bauen.sh endete mit 1")
	}), nil, time.Minute, stumm)
	starte(t, w)
	_, _ = w.Bestelle(refA, "", false)
	a := warteAuf(t, w, refA, Fehler)
	if !strings.Contains(a.Grund, "bauen.sh endete mit 1") || !strings.Contains(a.Grund, "Ruhezone 2,1 Module") {
		t.Errorf("Grund: %q", a.Grund)
	}
	var namen []string
	for _, d := range a.Dateien {
		namen = append(namen, d.Name)
	}
	if strings.Join(namen, " ") != "pruefung.md "+Ausgabe {
		t.Errorf("bei Fehler nur Bericht und Ausgabe, nicht %v", namen)
	}
	if _, ok := w.Datei(refA, "gehaeuse-"+refA+".3mf"); ok {
		t.Error("eine gescheiterte Druckdatei darf nicht zum Drucker")
	}
	if _, ok := w.Datei(refA, Ausgabe); !ok {
		t.Error("die Ausgabe hilft bei der Suche nach dem Grund")
	}
}

func TestRueckgabeNullOhneSatzImBerichtIstNichtFertig(t *testing.T) {
	w, _ := Neu(t.TempDir(), bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		dir := filepath.Join(ziel, "kennung", ref)
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, "gehaeuse-"+ref+".3mf"), []byte("x"), 0o644)
		return nil
	}), nil, time.Minute, stumm)
	starte(t, w)
	_, _ = w.Bestelle(refA, "", false)
	if a := warteAuf(t, w, refA, Fehler); !strings.Contains(a.Grund, "kein Prüfbericht") {
		t.Errorf("Grund: %q", a.Grund)
	}
}

func TestEinerZurZeitInDerReihenfolgeDerBestellung(t *testing.T) {
	var aktiv, hoechst int32
	var mu sync.Mutex
	var folge []string
	w, _ := Neu(t.TempDir(), bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		n := atomic.AddInt32(&aktiv, 1)
		for {
			h := atomic.LoadInt32(&hoechst)
			if n <= h || atomic.CompareAndSwapInt32(&hoechst, h, n) {
				break
			}
		}
		mu.Lock()
		folge = append(folge, ref)
		mu.Unlock()
		time.Sleep(30 * time.Millisecond)
		schreibeBau(t, ziel, ref)
		atomic.AddInt32(&aktiv, -1)
		return nil
	}), nil, time.Minute, stumm)
	for _, r := range []string{refA, refB, refC} {
		_, _ = w.Bestelle(r, "", false)
	}
	starte(t, w)
	warteAuf(t, w, refC, Fertig)
	if hoechst != 1 {
		t.Errorf("%d Bauten zugleich, erlaubt ist einer", hoechst)
	}
	if strings.Join(folge, " ") != refA+" "+refB+" "+refC {
		t.Errorf("Reihenfolge %v", folge)
	}
}

func TestBestellenIstJeReferenzEinmalUndNeuBautNochEinmal(t *testing.T) {
	var baue int32
	w, _ := Neu(t.TempDir(), bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		atomic.AddInt32(&baue, 1)
		schreibeBau(t, ziel, ref)
		return nil
	}), nil, time.Minute, stumm)
	if _, err := w.Bestelle("edge-k7m2xqz", "", false); err == nil {
		t.Error("Referenz mit falschem Prüfzeichen angenommen")
	}
	_, _ = w.Bestelle(refA, "lauf-1", false)
	_, _ = w.Bestelle(refA, "lauf-2", false)
	starte(t, w)
	warteAuf(t, w, refA, Fertig)
	_, _ = w.Bestelle(refA, "lauf-3", false)
	time.Sleep(50 * time.Millisecond)
	if n := atomic.LoadInt32(&baue); n != 1 {
		t.Fatalf("%d Bauten für eine Referenz", n)
	}
	a, _ := w.Bestelle(refA, "", true)
	if a.Zustand != Wartet {
		t.Errorf("neu: %+v", a)
	}
	warteAuf(t, w, refA, Fertig)
	if n := atomic.LoadInt32(&baue); n != 2 {
		t.Errorf("neu baute nicht noch einmal: %d", n)
	}
}

func TestNachDemNeustartKommtDerAbgebrocheneBauWiederInDieSchlange(t *testing.T) {
	ablage := t.TempDir()
	begonnen := make(chan struct{})
	w, _ := Neu(ablage, bauerFunc(func(ctx context.Context, _, _ string, job func(string)) error {
		job("gehaeuse-alt")
		close(begonnen)
		<-ctx.Done()
		return ctx.Err()
	}), nil, time.Minute, stumm)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Laufe(ctx); close(done) }()
	_, _ = w.Bestelle(refA, "lauf-1", false)
	<-begonnen
	cancel()
	<-done
	if a := w.Auftraege()[0]; a.Zustand != Baut {
		t.Fatalf("beim Ende des Dienstes: %+v", a)
	}

	w2, err := Neu(ablage, bauerFunc(func(_ context.Context, ref, ziel string, _ func(string)) error {
		schreibeBau(t, ziel, ref)
		return nil
	}), nil, time.Minute, stumm)
	if err != nil {
		t.Fatal(err)
	}
	if a := w2.Auftraege()[0]; a.Zustand != Wartet || a.Job != "" || a.Lauf != "lauf-1" {
		t.Fatalf("nach dem Neustart: %+v", a)
	}
	starte(t, w2)
	warteAuf(t, w2, refA, Fertig)
}

func TestFristBeendetEinenHaengendenBau(t *testing.T) {
	w, _ := Neu(t.TempDir(), bauerFunc(func(ctx context.Context, _, _ string, _ func(string)) error {
		<-ctx.Done()
		return ctx.Err()
	}), nil, 50*time.Millisecond, stumm)
	starte(t, w)
	_, _ = w.Bestelle(refA, "", false)
	if a := warteAuf(t, w, refA, Fehler); !strings.Contains(a.Grund, "nicht in 50ms fertig") {
		t.Errorf("Grund: %q", a.Grund)
	}
	if n := w.Wartend(); n != 0 {
		t.Errorf("wartend: %d", n)
	}
}
