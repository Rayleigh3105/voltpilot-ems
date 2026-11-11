package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/meldung"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Die Rückmeldung ans Portal darf die eigentliche Arbeit nie stören: Was auch
// immer die API auf ihrer Route tut - Soll-Stand, WireGuard, Firewall und
// Schlüsselausgabe laufen genau so wie ohne Rückmeldung.

// schritte hält fest, was der Dienst an WireGuard und Firewall tut.
type schritte struct {
	mu   sync.Mutex
	alle []string
}

func (s *schritte) merke(format string, a ...any) {
	s.mu.Lock()
	s.alle = append(s.alle, fmt.Sprintf(format, a...))
	s.mu.Unlock()
}

func (s *schritte) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.alle, "\n")
}

type wgProbe struct {
	s     *schritte
	mu    sync.Mutex
	peers map[string][]netip.Prefix
}

func (w *wgProbe) Peers(context.Context) (map[string][]netip.Prefix, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	kopie := map[string][]netip.Prefix{}
	for k, v := range w.peers {
		kopie[k] = v
	}
	return kopie, nil
}

func (w *wgProbe) Setze(_ context.Context, key string, a netip.Addr) error {
	w.mu.Lock()
	w.peers[key] = []netip.Prefix{netip.PrefixFrom(a, 32)}
	w.mu.Unlock()
	w.s.merke("wg setze %s %s", key, a)
	return nil
}

func (w *wgProbe) Entferne(_ context.Context, key string) error {
	w.mu.Lock()
	delete(w.peers, key)
	w.mu.Unlock()
	w.s.merke("wg entferne %s", key)
	return nil
}

type fwProbe struct {
	s     *schritte
	mu    sync.Mutex
	basis bool
	bis   map[abgleich.Paar]time.Time
}

func (f *fwProbe) SichereBasis(context.Context) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.basis {
		return false, nil
	}
	f.basis, f.bis = true, map[abgleich.Paar]time.Time{}
	f.s.merke("fw basis geladen")
	return true, nil
}

func (f *fwProbe) Fenster(context.Context) (map[abgleich.Paar]time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := map[abgleich.Paar]time.Duration{}
	for p, bis := range f.bis {
		if rest := time.Until(bis); rest > 0 {
			m[p] = rest
		}
	}
	return m, nil
}

func (f *fwProbe) EntferneFenster(_ context.Context, p abgleich.Paar) error {
	f.mu.Lock()
	delete(f.bis, p)
	f.mu.Unlock()
	f.s.merke("fw entferne %s", p)
	return nil
}

func (f *fwProbe) FuegeFensterHinzu(_ context.Context, e []abgleich.FensterSetzen) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range e {
		f.bis[x.Paar] = time.Now().Add(x.Timeout)
		f.s.merke("fw fuege %s hinzu (%s)", x.Paar, x.FensterID)
	}
	return nil
}

const (
	umlaufBox1 = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="
	umlaufBox2 = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0="
	umlaufTech = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y="
)

func umlaufSoll(t *testing.T, mitFenster bool) []byte {
	t.Helper()
	beginn := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	s := soll.Soll{Version: 1, ErzeugtAm: beginn, BoxNetz: "10.10.16.0/20", TechnikerNetz: "10.10.32.0/24",
		Peers: []soll.Peer{
			{Art: "box", ID: "b1", Kennung: "edge-zay5sdd", PublicKey: umlaufBox1, Adresse: "10.10.16.2"},
			{Art: "box", ID: "b2", Kennung: "edge-k7m2xq3", PublicKey: umlaufBox2, Adresse: "10.10.16.3"},
			{Art: "techniker", ID: "t1", Kennung: "Probe-Techniker", PublicKey: umlaufTech, Adresse: "10.10.32.2",
				SSHPublicKey: probe.SSHZeile(3072, 1)},
		}}
	if mitFenster {
		s.Fenster = []soll.Fenster{{ID: "f1", BoxID: "b1", TechnikerID: "t1", Beginn: beginn, Ende: beginn.Add(time.Hour)}}
	}
	daten, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return daten
}

// ablauf ist, was nach drei Durchgängen feststeht.
type ablauf struct {
	schritte  string
	antworten []string
	holungen  int32
	tokens    int32
	meldungen []string
	dauer     time.Duration
}

// durchlauf fährt drei Durchgänge gegen eine API, deren Route der Rückmeldung
// sich verhält wie art: "" = kein Melder, "alt" = die Route gibt es nicht.
func durchlauf(t *testing.T, art string) ablauf {
	t.Helper()
	var holungen, tokens atomic.Int32
	var mu sync.Mutex
	var meldungen []string
	mitFenster := atomic.Bool{}
	mitFenster.Store(true)
	haengt := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		tokens.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":300}`))
	})
	mux.HandleFunc("GET "+quelle.SollPfad, func(w http.ResponseWriter, r *http.Request) {
		holungen.Add(1)
		_, _ = w.Write(umlaufSoll(t, mitFenster.Load()))
	})
	if art != "" && art != "alt" {
		mux.HandleFunc("PUT "+quelle.MeldePfad, func(w http.ResponseWriter, r *http.Request) {
			daten, _ := io.ReadAll(r.Body)
			mu.Lock()
			meldungen = append(meldungen, string(daten))
			mu.Unlock()
			switch art {
			case "an":
				w.WriteHeader(http.StatusNoContent)
			case "fehler":
				w.WriteHeader(http.StatusInternalServerError)
			case "abgelehnt":
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"message":"Die Meldung nennt eine Box, die es nicht gibt."}`))
			case "haengt":
				select {
				case <-haengt:
				case <-r.Context().Done():
				}
			}
		})
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	defer close(haengt)

	api, err := quelle.Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	s := &schritte{}
	wg := &wgProbe{s: s, peers: map[string][]netip.Prefix{}}
	fw := &fwProbe{s: s}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	boxNetz := netip.MustParsePrefix("10.10.16.0/20")
	d := &dienst.Dienst{Quelle: api, WG: wg, FW: fw,
		Netze:      soll.Netze{Box: boxNetz, Techniker: netip.MustParsePrefix("10.10.32.0/24")},
		MaxFenster: 24 * time.Hour, MaxEntfernen: 10, Zustand: t.TempDir(), Log: log, Jetzt: time.Now}
	stelle := &ausgabe.Stelle{Menge: fw, BoxNetz: boxNetz, Log: log, Jetzt: time.Now, Zustand: t.TempDir(), Frische: -1}
	d.Ausgabe = stelle
	var melder *meldung.Melder
	if art != "" {
		melder = &meldung.Melder{Senden: api.Melder(300 * time.Millisecond).Melde,
			Handshakes: func(context.Context) (map[string]time.Time, error) {
				return map[string]time.Time{umlaufBox1: time.Now()}, nil
			},
			Auskunft: stelle.Auskunft, Log: log, Jetzt: time.Now, GestartetUm: time.Now(),
			Frist: 300 * time.Millisecond, Intervall: time.Second}
	}

	box := netip.MustParseAddr("10.10.16.2")
	var a ablauf
	frage := func() {
		antwort := stelle.Frage(context.Background(), box, 0, "")
		a.antworten = append(a.antworten, fmt.Sprintf("%d %s", antwort.Code, zeilenOhneRest(string(antwort.Text))))
	}
	beginn := time.Now()
	for i := 0; i < 3; i++ {
		if i == 2 {
			mitFenster.Store(false) // das Fenster wird im Portal geschlossen
		}
		t0 := time.Now()
		e := umlauf(context.Background(), d, stelle, melder, 5*time.Second)
		if d := time.Since(t0); d > 250*time.Millisecond {
			t.Errorf("%q: Durchgang %d brauchte %s", art, i+1, d)
		}
		if !e.Frisch || e.Fehler != nil {
			t.Fatalf("%q: Durchgang %d: %+v", art, i+1, e)
		}
		frage()
	}
	a.dauer = time.Since(beginn)
	// Der letzte Aufruf der Rückmeldung darf noch laufen; dann erst lesen.
	for ende := time.Now().Add(5 * time.Second); melder != nil && melder.Laeuft(); {
		if time.Now().After(ende) {
			t.Fatalf("%q: die Rückmeldung endet nicht", art)
		}
		time.Sleep(5 * time.Millisecond)
	}
	a.schritte = s.text()
	a.holungen, a.tokens = holungen.Load(), tokens.Load()
	mu.Lock()
	a.meldungen = append(a.meldungen, meldungen...)
	mu.Unlock()
	return a
}

// zeilenOhneRest nimmt einer Antwort die Restlaufzeit, die mit der Uhr läuft.
func zeilenOhneRest(text string) string {
	var aus []string
	for _, z := range strings.Split(strings.TrimSpace(text), "\n") {
		f := strings.Fields(z)
		if len(f) == 5 && f[0] == "schluessel" {
			f[1] = "<rest>"
		}
		aus = append(aus, strings.Join(f, " "))
	}
	return strings.Join(aus, " | ")
}

func TestRueckmeldungStoertDenAbgleichNie(t *testing.T) {
	ohne := durchlauf(t, "")
	if !strings.Contains(ohne.schritte, "fw fuege 10.10.32.2 . 10.10.16.2 hinzu (f1)") ||
		!strings.Contains(ohne.schritte, "fw entferne 10.10.32.2 . 10.10.16.2") || len(ohne.antworten) != 3 ||
		!strings.HasPrefix(ohne.antworten[0], "200 ") || !strings.Contains(ohne.antworten[0], "schluessel <rest> t1 ssh-rsa ") ||
		!strings.HasSuffix(ohne.antworten[2], "ende 0") {
		t.Fatalf("Ablauf ohne Rückmeldung:\n%s\n%q", ohne.schritte, ohne.antworten)
	}
	for art, was := range map[string]string{
		"an":        "die API nimmt die Meldung an",
		"alt":       "neuer Dienst an einer alten API: die Route gibt es nicht (404)",
		"fehler":    "die API antwortet mit 500",
		"abgelehnt": "die API weist die Meldung ab (422)",
		"haengt":    "die API antwortet auf die Meldung nie",
	} {
		t.Run(art, func(t *testing.T) {
			mit := durchlauf(t, art)
			if mit.schritte != ohne.schritte {
				t.Errorf("%s: WireGuard und Firewall weichen ab\nohne:\n%s\nmit:\n%s", was, ohne.schritte, mit.schritte)
			}
			if fmt.Sprint(mit.antworten) != fmt.Sprint(ohne.antworten) {
				t.Errorf("%s: die Schlüsselausgabe antwortet anders\nohne: %q\nmit:  %q", was, ohne.antworten, mit.antworten)
			}
			if mit.holungen != 3 || mit.tokens != 1 {
				t.Errorf("%s: %d Abrufe des Soll-Stands und %d Token, erwartet 3 und 1", was, mit.holungen, mit.tokens)
			}
			if mit.dauer > 2*time.Second {
				t.Errorf("%s: drei Durchgänge brauchten %s", was, mit.dauer)
			}
			switch art {
			case "alt":
				if len(mit.meldungen) != 0 {
					t.Errorf("an der alten API kam etwas an: %q", mit.meldungen)
				}
			case "an":
				if len(mit.meldungen) == 0 {
					t.Fatal("die API hat keine Meldung bekommen")
				}
				var b meldung.Bericht
				if err := json.Unmarshal([]byte(mit.meldungen[0]), &b); err != nil {
					t.Fatal(err)
				}
				if b.Version != 1 || len(b.Boxen) != 2 || b.Boxen[0].ID != "b1" || b.Boxen[0].VerbundenSeit == nil ||
					b.Boxen[1].VerbundenSeit != nil || len(b.Fenster) != 1 || b.Fenster[0].ID != "f1" {
					t.Errorf("erste Meldung: %s", mit.meldungen[0])
				}
			default:
				if len(mit.meldungen) == 0 {
					t.Errorf("%s: der Dienst hat es gar nicht versucht", was)
				}
			}
		})
	}
}

// Die letzte Meldung nach dem Schließen nennt das Fenster nicht mehr, und der
// Dienst meldet auch dann, wenn die Schlüsselausgabe abgeschaltet ist.
func TestUmlaufMeldetDenStandNachDemLauf(t *testing.T) {
	mit := durchlauf(t, "an")
	if len(mit.meldungen) < 2 {
		t.Fatalf("%d Meldungen", len(mit.meldungen))
	}
	var letzte meldung.Bericht
	if err := json.Unmarshal([]byte(mit.meldungen[len(mit.meldungen)-1]), &letzte); err != nil {
		t.Fatal(err)
	}
	if len(letzte.Fenster) != 0 || len(letzte.Boxen) != 2 {
		t.Fatalf("nach dem Schließen: %s", mit.meldungen[len(mit.meldungen)-1])
	}
}
