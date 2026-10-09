package ausgabe

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Grenzen des Schalters. Er ist der einzige Teil des Dienstes, den eine Box
// aus dem Tunnel erreicht.
// kopfFrist: so lange hat eine Box für ihre Anfragezeile und die Kopfzeilen.
var kopfFrist = 5 * time.Second

const (
	// maxKopf: mehr Bytes Kopfzeilen liest der Schalter nicht.
	maxKopf = 4096
	// maxJeAbsender: so viele Verbindungen hält ein Absender höchstens zugleich.
	// Eine Box braucht eine; die zweite ist die neue Anfrage, die die alte ablöst.
	maxJeAbsender = 4
	// maxVerbindungen: Obergrenze über alle Absender.
	maxVerbindungen = 8192
)

// Schalter nimmt die Anfragen der Boxen an und reicht sie an die Stelle weiter.
type Schalter struct {
	BoxNetz netip.Prefix
	Log     *slog.Logger

	anschluss *anschluss

	mu          sync.Mutex
	abgewiesen  int
	letzteZeile time.Time
}

// NeuerSchalter verbindet den Schalter mit dem Kanal zur Stelle.
func NeuerSchalter(kanal io.ReadWriter, boxNetz netip.Prefix, log *slog.Logger) *Schalter {
	return &Schalter{BoxNetz: boxNetz, Log: log, anschluss: neuerAnschluss(kanal)}
}

// absender liest die Adresse der Gegenseite. WireGuard lässt im Tunnel nur
// die Adresse durch, die zum Schlüssel des Peers gehört: der Absender IST die
// Box.
func absender(r *http.Request) (netip.Addr, bool) {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	return ap.Addr().Unmap(), true
}

func ablehnen(w http.ResponseWriter, code int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, text+"\n")
}

// ServeHTTP beantwortet GET /v1/schluessel?warte=<s>&stand=<prüfwert>.
// Geantwortet wird nur einer Box-Adresse; alles andere bekommt 403 und
// erfährt nichts.
func (s *Schalter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	box, ok := absender(r)
	if !ok || !soll.IstHost(s.BoxNetz, box) {
		s.vermerkeAbweisung(r.RemoteAddr)
		ablehnen(w, http.StatusForbidden, "keine Box-Adresse")
		return
	}
	if r.URL.Path != Pfad {
		ablehnen(w, http.StatusNotFound, "unbekannter Pfad")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		ablehnen(w, http.StatusMethodNotAllowed, "nur GET")
		return
	}
	q := r.URL.Query()
	warte := time.Duration(0)
	if t := q.Get("warte"); t != "" {
		sek, err := strconv.Atoi(t)
		if err != nil || sek < 0 || len(t) > 6 {
			ablehnen(w, http.StatusBadRequest, "warte: Sekunden erwartet")
			return
		}
		warte = min(time.Duration(sek)*time.Second, MaxWarte)
	}
	kennt := q.Get("stand")
	if kennt != "" && !PruefwertGueltig(kennt) {
		ablehnen(w, http.StatusBadRequest, "stand: Prüfwert der letzten Antwort erwartet")
		return
	}
	antwort, err := s.anschluss.frage(r.Context(), box, warte, kennt)
	if err != nil {
		if r.Context().Err() != nil {
			// Die Box hat die Verbindung beendet - oder ihre Schreibseite
			// geschlossen, was von hier aus dasselbe ist. Die Frage ist
			// zurückgezogen; die Verbindung endet ohne Antwort. Ohne diesen
			// Abbruch schriebe net/http von sich aus ein leeres "200 OK".
			panic(http.ErrAbortHandler)
		}
		ablehnen(w, http.StatusServiceUnavailable, "Schlüsselausgabe nicht bereit")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(antwort.Text)))
	w.WriteHeader(antwort.Code)
	_, _ = w.Write(antwort.Text)
}

// vermerkeAbweisung schreibt höchstens alle zehn Sekunden eine Zeile: wer von
// außerhalb des Box-Netzes fragt, soll das Journal nicht füllen können.
func (s *Schalter) vermerkeAbweisung(absender string) {
	s.mu.Lock()
	s.abgewiesen++
	n := s.abgewiesen
	melden := time.Since(s.letzteZeile) > 10*time.Second
	if melden {
		s.letzteZeile = time.Now()
		s.abgewiesen = 0
	}
	s.mu.Unlock()
	if melden {
		s.Log.Warn("Schlüsselausgabe: Anfrage abgewiesen, keine Box-Adresse", "absender", absender, "anzahl", n)
	}
}

// server ist der HTTP-Server mit seinen Zeitlimits: eine Frist für die
// Kopfzeilen, eine für die Antwort (längste Wartezeit plus Reserve). Einen
// Rumpf hat die Anfrage nicht, und gelesen wird keiner.
func (s *Schalter) server() *http.Server {
	server := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: kopfFrist,
		WriteTimeout:      MaxWarte + 30*time.Second,
		MaxHeaderBytes:    maxKopf,
		ErrorLog:          slog.NewLogLogger(s.Log.Handler(), slog.LevelDebug),
	}
	// Eine Anfrage je Verbindung: so ist "eine offene Anfrage je Box" auch
	// eine offene Verbindung je Box.
	server.SetKeepAlivesEnabled(false)
	return server
}

// Bedienen nimmt Verbindungen an, bis der Kanal zur Stelle endet oder ctx
// abläuft. Endet der Kanal, ist der Dienst weg: der Schalter hört auf.
func (s *Schalter) Bedienen(ctx context.Context, l net.Listener) error {
	server := s.server()

	ende := make(chan error, 2)
	go func() { ende <- s.anschluss.lies() }()
	go func() { ende <- server.Serve(&begrenzt{Listener: l, proAbsender: map[netip.Addr]int{}}) }()
	var err error
	select {
	case err = <-ende:
	case <-ctx.Done():
	}
	_ = server.Close()
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// begrenzt nimmt je Absender und insgesamt nur eine feste Zahl Verbindungen
// an. Was darüber liegt, wird sofort geschlossen, bevor ein Byte gelesen ist.
type begrenzt struct {
	net.Listener
	mu          sync.Mutex
	proAbsender map[netip.Addr]int
	gesamt      int
}

func (b *begrenzt) Accept() (net.Conn, error) {
	for {
		c, err := b.Listener.Accept()
		if err != nil {
			return nil, err
		}
		var von netip.Addr
		if ap, err := netip.ParseAddrPort(c.RemoteAddr().String()); err == nil {
			von = ap.Addr().Unmap()
		}
		b.mu.Lock()
		voll := b.gesamt >= maxVerbindungen || b.proAbsender[von] >= maxJeAbsender
		if !voll {
			b.gesamt++
			b.proAbsender[von]++
		}
		b.mu.Unlock()
		if voll {
			_ = c.Close()
			continue
		}
		return &gezaehlt{Conn: c, frei: func() {
			b.mu.Lock()
			b.gesamt--
			if b.proAbsender[von]--; b.proAbsender[von] <= 0 {
				delete(b.proAbsender, von)
			}
			b.mu.Unlock()
		}}, nil
	}
}

type gezaehlt struct {
	net.Conn
	einmal sync.Once
	frei   func()
}

func (g *gezaehlt) Close() error {
	g.einmal.Do(g.frei)
	return g.Conn.Close()
}
