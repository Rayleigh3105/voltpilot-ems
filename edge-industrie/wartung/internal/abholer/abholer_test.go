package abholer

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/vertrag"
)

type bestand struct {
	mu      sync.Mutex
	listen  []vertrag.Liste
	frist   time.Duration
	hatFrst bool
}

func (b *bestand) Uebernimm(l vertrag.Liste) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.listen = append(b.listen, l)
	return true
}

func (b *bestand) NaechsteFrist() (time.Duration, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.frist, b.hatFrst
}

func (b *bestand) anzahl() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.listen)
}

type anfrage struct{ warte, stand string }

// server ist eine Schlüsselausgabe, die der Reihe nach vorgegebene Antworten gibt.
type server struct {
	mu        sync.Mutex
	antworten []func(http.ResponseWriter)
	fragen    []anfrage
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.fragen = append(s.fragen, anfrage{r.URL.Query().Get("warte"), r.URL.Query().Get("stand")})
	var f func(http.ResponseWriter)
	if len(s.antworten) > 0 {
		f, s.antworten = s.antworten[0], s.antworten[1:]
	}
	s.mu.Unlock()
	if f == nil {
		// Nichts Neues mehr: Die Anfrage bleibt offen, wie am echten Server.
		<-r.Context().Done()
		return
	}
	f(w)
}

func (s *server) gefragt() []anfrage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]anfrage(nil), s.fragen...)
}

func text(t string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) { _, _ = io.WriteString(w, t) }
}

func status(code int) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) { http.Error(w, "nein", code) }
}

func TestNurEineGueltigeAntwortAendertDenStand(t *testing.T) {
	vektor, err := os.ReadFile("../../../../docs/contracts/fernwartung-schluessel-v1.example.txt")
	if err != nil {
		t.Fatal(err)
	}
	leer := "vp-wartung-schluessel 1 99ba3c5f3272c926\nende 0\n"
	s := &server{antworten: []func(http.ResponseWriter){
		text(string(vektor)), // 1: gilt
		text(strings.TrimSuffix(string(vektor), "ende 1\n")), // 2: abgeschnitten
		text(leer + strings.Repeat(" ", vertrag.MaxBytes)),   // 3: zu groß
		status(http.StatusServiceUnavailable),                // 4
		status(http.StatusTooManyRequests),                   // 5
		status(http.StatusForbidden),                         // 6
		text(leer),                                           // 7: gilt
	}}
	ts := httptest.NewServer(s)
	defer ts.Close()
	b := &bestand{}
	var mu sync.Mutex
	var meldungen []string
	a := &Abholer{
		Dial: func(ctx context.Context, _ netip.AddrPort) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", ts.Listener.Addr().String())
		},
		Server:  netip.MustParseAddrPort("10.10.32.1:8022"),
		Bestand: b,
		Melde: func(m string) {
			mu.Lock()
			defer mu.Unlock()
			meldungen = append(meldungen, m)
		},
		Warte: 7 * time.Second, Pause: 10 * time.Millisecond,
	}
	ctx, ende := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() { a.Laufe(ctx); close(fertig) }()
	frist := time.Now().Add(10 * time.Second)
	for b.anzahl() < 2 {
		if time.Now().After(frist) {
			t.Fatalf("nur %d Antworten übernommen; gefragt: %v", b.anzahl(), s.gefragt())
		}
		time.Sleep(10 * time.Millisecond)
	}
	ende()
	<-fertig

	// Übernommen sind genau die beiden gültigen Antworten.
	if n := b.anzahl(); n != 2 || len(b.listen[0].Eintraege) != 1 || len(b.listen[1].Eintraege) != 0 {
		t.Fatalf("übernommen: %+v", b.listen)
	}
	// Die Box nennt einen Prüfwert erst, nachdem sie die Antwort übernommen
	// hat, und behält ihn über verworfene Antworten hinweg.
	f := s.gefragt()
	if len(f) < 7 || f[0].stand != "" || f[0].warte != "7" {
		t.Fatalf("erste Anfrage: %+v", f)
	}
	for i := 1; i <= 6; i++ {
		if f[i].stand != "6e7abb201a8aaa9a" {
			t.Fatalf("Anfrage %d nennt stand %q", i+1, f[i].stand)
		}
	}
	mu.Lock()
	alle := strings.Join(meldungen, "\n")
	mu.Unlock()
	for _, teil := range []string{"Wartungsserver antwortet", "verworfen (Form)", "verworfen (zu gross)", "503", "429", "403"} {
		if !strings.Contains(alle, teil) {
			t.Errorf("Meldung fehlt: %s\n%s", teil, alle)
		}
	}
	if _, ok, grund := a.Stand(); !ok || grund != "" {
		t.Fatalf("Stand nach der letzten gültigen Antwort: %v %q", ok, grund)
	}
}

// Vor einer Frist fragt die Box wieder: Das Fenster kann verlängert worden sein.
func TestWartezeitVorDerFrist(t *testing.T) {
	b := &bestand{}
	a := &Abholer{Bestand: b}
	if w := a.wartezeit(); w != 45*time.Second {
		t.Fatalf("ohne Frist: %v", w)
	}
	b.frist, b.hatFrst = 20*time.Second, true
	if w := a.wartezeit(); w != 15*time.Second {
		t.Fatalf("20 s vor der Frist: %v", w)
	}
	b.frist = 3 * time.Second
	if w := a.wartezeit(); w != 0 {
		t.Fatalf("kurz vor der Frist: %v", w)
	}
	b.frist = time.Hour
	a.Warte = 10 * time.Minute
	if w := a.wartezeit(); w != 300*time.Second {
		t.Fatalf("mehr als der Server zulässt: %v", w)
	}
}
