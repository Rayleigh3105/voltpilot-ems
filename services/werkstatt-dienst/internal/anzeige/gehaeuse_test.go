package anzeige_test

import (
	"context"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/anzeige"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/gehaeuse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
)

// Ein Bau, wie ihn das Gehäuse-Programm ablegt; edge-abcdefj scheitert.
type bau struct{}

func (bau) Baue(_ context.Context, ref, ziel string, _ func(string)) error {
	dir := filepath.Join(ziel, "kennung", ref)
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "gehaeuse-"+ref+".3mf"), []byte("PK3mf"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "gehaeuse-"+ref+"-geslict.3mf"), []byte("nur Prüfung"), 0o644)
	if ref == "edge-abcdefj" {
		_ = os.WriteFile(filepath.Join(dir, "pruefung.md"), []byte("- **Fehler:** <b>Ruhezone</b>\n"), 0o644)
		return io.ErrUnexpectedEOF
	}
	_ = os.WriteFile(filepath.Join(dir, "pruefung.md"), []byte("- Keine verletzte Regel; der QR-Code ist aus dem G-Code lesbar.\n"), 0o644)
	return nil
}

func TestGehaeuseInDerAnzeige(t *testing.T) {
	d, ablage, _ := aufbau(t)
	g, err := gehaeuse.Neu(t.TempDir(), bau{}, nil, time.Minute, time.Hour, logs.Neu(io.Discard, "text", nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.Laufe(ctx)

	s := anzeige.Steuerung(d, g)
	for _, form := range []string{"referenz=edge-k7m2xq3", "referenz=edge-abcdefj"} {
		r := httptest.NewRequest("POST", "/gehaeuse", strings.NewReader(form))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "wartet") {
			t.Fatalf("%s: %d %s", form, w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("POST", "/gehaeuse", strings.NewReader("referenz=edge-k7m2xqz"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("falsches Prüfzeichen: %d", w.Code)
	}
	ende := time.Now().Add(5 * time.Second)
	for g.Wartend() > 0 && time.Now().Before(ende) {
		time.Sleep(10 * time.Millisecond)
	}

	h := anzeige.Werkstatt(d, ablage, g, logs.Neu(io.Discard, "text", nil))
	c, b, _ := hole(t, h, "localhost:8101", "/")
	if c != 200 || !strings.Contains(b, `href="gehaeuse/edge-k7m2xq3/gehaeuse-edge-k7m2xq3.3mf"`) || strings.Contains(b, "geslict") {
		t.Fatalf("%d\n%s", c, b)
	}
	if strings.Contains(b, "<b>Ruhezone") || !strings.Contains(b, "&lt;b&gt;Ruhezone") {
		t.Fatal("Grund nicht escaped")
	}
	c, b, hdr := hole(t, h, "localhost:8101", "/gehaeuse/edge-k7m2xq3/gehaeuse-edge-k7m2xq3.3mf")
	if c != 200 || b != "PK3mf" || hdr.Get("Content-Type") != "model/3mf" || !strings.Contains(hdr.Get("Content-Disposition"), "attachment") {
		t.Fatalf("%d %q %v", c, b, hdr)
	}
	for _, pfad := range []string{
		"/gehaeuse/edge-k7m2xq3/gehaeuse-edge-k7m2xq3-geslict.3mf",
		"/gehaeuse/edge-abcdefj/gehaeuse-edge-abcdefj.3mf",
		"/gehaeuse/edge-k7m2xq3/auftrag.json",
		"/gehaeuse/..%2Fedge-k7m2xq3/pruefung.md",
	} {
		if c, _, _ := hole(t, h, "localhost:8101", pfad); c != 404 {
			t.Errorf("%s: %d", pfad, c)
		}
	}
	if c, _, _ := hole(t, h, "boese.example", "/gehaeuse/edge-k7m2xq3/gehaeuse-edge-k7m2xq3.3mf"); c != 403 {
		t.Errorf("fremder Host: %d", c)
	}
	if c, b, _ := hole(t, h, "localhost", "/gehaeuse.json"); c != 200 || !strings.Contains(b, `"zustand": "fehler"`) {
		t.Errorf("%d %s", c, b)
	}
}
