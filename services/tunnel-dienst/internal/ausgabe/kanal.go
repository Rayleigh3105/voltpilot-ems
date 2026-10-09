package ausgabe

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Der Kanal zwischen Schalter (ohne Rechte, aus dem Tunnel erreichbar) und
// Stelle (im Dienst). Eine Zeile je Nachricht, Felder durch ein Leerzeichen:
//
//	Schalter -> Stelle
//	  bereit                              der Schalter lauscht
//	  f <nr> <box-adresse> <warte-s> <prüfwert|->    Frage einer Box
//	  x <nr>                              die Box hat die Verbindung beendet
//
//	Stelle -> Schalter
//	  a <nr> <code> <länge>\n<länge Bytes>            Antwort
//
// Die Stelle traut dem Schalter nicht: Sie nimmt nur diese Zeilen an, prüft
// jedes Feld selbst und beendet den Kanal beim ersten Verstoß. Mehr als eine
// Box-Adresse, eine Wartezeit und einen Prüfwert kann der Schalter ihr nicht
// sagen; was eine Box bekommt, steht allein in der Antwort der Stelle.

const (
	// maxZeile: länger ist keine Zeile des Schalters.
	maxZeile = 128
	// maxOffen: so viele Fragen bearbeitet die Stelle höchstens zugleich.
	maxOffen = 8192
	// maxAntwort: größer ist keine Antwort (acht Schlüssel zu 4096 Bit sind rund 6 kB).
	maxAntwort = 64 * 1024
)

var pruefwertForm = regexp.MustCompile(`^[0-9a-f]{1,32}$`)

// PruefwertGueltig prüft den Prüfwert, den eine Box nennt.
func PruefwertGueltig(s string) bool { return pruefwertForm.MatchString(s) }

type frage struct {
	nr    uint64
	box   netip.Addr
	warte time.Duration
	kennt string
}

func (f frage) zeile() string {
	kennt := f.kennt
	if kennt == "" {
		kennt = "-"
	}
	return fmt.Sprintf("f %d %s %d %s\n", f.nr, f.box, int(f.warte/time.Second), kennt)
}

// liesFrage zerlegt eine f-Zeile streng.
func liesFrage(felder []string, boxNetz netip.Prefix) (frage, error) {
	if len(felder) != 5 {
		return frage{}, errors.New("f: fünf Felder erwartet")
	}
	nr, err := strconv.ParseUint(felder[1], 10, 64)
	if err != nil {
		return frage{}, errors.New("f: Nummer")
	}
	box, err := netip.ParseAddr(felder[2])
	if err != nil || !box.Is4() || !boxNetz.Contains(box) || box.String() != felder[2] {
		return frage{}, errors.New("f: keine Adresse aus dem Box-Netz")
	}
	sek, err := strconv.Atoi(felder[3])
	if err != nil || sek < 0 || sek > int(MaxWarte/time.Second) || strconv.Itoa(sek) != felder[3] {
		return frage{}, errors.New("f: Wartezeit")
	}
	kennt := felder[4]
	if kennt == "-" {
		kennt = ""
	} else if !PruefwertGueltig(kennt) {
		return frage{}, errors.New("f: Prüfwert")
	}
	return frage{nr: nr, box: box, warte: time.Duration(sek) * time.Second, kennt: kennt}, nil
}

// Bediene ist die Seite der Stelle: Sie liest die Zeilen des Schalters und
// beantwortet jede Frage. Kehrt zurück, wenn der Kanal endet (nil) oder der
// Schalter sich nicht an die Form hält (Fehler) - dann gehört er beendet.
func (s *Stelle) Bediene(ctx context.Context, kanal io.ReadWriter) error {
	ctx, abbruch := context.WithCancel(ctx)
	defer abbruch()
	var (
		schreibMu sync.Mutex
		mu        sync.Mutex
		offen     = map[uint64]context.CancelFunc{}
	)
	defer s.SetzeLaeuft(false)

	leser := bufio.NewReaderSize(kanal, maxZeile)
	for {
		roh, err := leser.ReadSlice('\n')
		if err != nil {
			if errors.Is(err, bufio.ErrBufferFull) {
				return errors.New("Kanal: Zeile zu lang")
			}
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("Kanal: %w", err)
		}
		felder := strings.Split(strings.TrimSuffix(string(roh), "\n"), " ")
		switch felder[0] {
		case "bereit":
			if len(felder) != 1 {
				return errors.New("Kanal: bereit ohne Felder erwartet")
			}
			s.SetzeLaeuft(true)
		case "x":
			if len(felder) != 2 {
				return errors.New("Kanal: x <nr> erwartet")
			}
			nr, err := strconv.ParseUint(felder[1], 10, 64)
			if err != nil {
				return errors.New("Kanal: x: Nummer")
			}
			mu.Lock()
			if ab := offen[nr]; ab != nil {
				ab()
			}
			mu.Unlock()
		case "f":
			f, err := liesFrage(felder, s.BoxNetz)
			if err != nil {
				return fmt.Errorf("Kanal: %w", err)
			}
			fctx, fab := context.WithCancel(ctx)
			mu.Lock()
			if _, doppelt := offen[f.nr]; doppelt || len(offen) >= maxOffen {
				mu.Unlock()
				fab()
				return errors.New("Kanal: Nummer doppelt oder zu viele offene Fragen")
			}
			offen[f.nr] = fab
			mu.Unlock()
			go func() {
				a := s.Frage(fctx, f.box, f.warte, f.kennt)
				mu.Lock()
				delete(offen, f.nr)
				mu.Unlock()
				fab()
				if a.Code == 0 {
					return
				}
				schreibMu.Lock()
				defer schreibMu.Unlock()
				_, _ = fmt.Fprintf(kanal, "a %d %d %d\n%s", f.nr, a.Code, len(a.Text), a.Text)
			}()
		default:
			return errors.New("Kanal: unbekannte Zeile")
		}
	}
}

// anschluss ist die Seite des Schalters.
type anschluss struct {
	kanal     io.ReadWriter
	schreibMu sync.Mutex

	mu          sync.Mutex
	naechste    uint64
	wartet      map[uint64]chan Antwort
	geschlossen bool
}

func neuerAnschluss(kanal io.ReadWriter) *anschluss {
	return &anschluss{kanal: kanal, wartet: map[uint64]chan Antwort{}}
}

func (a *anschluss) sende(zeile string) error {
	a.schreibMu.Lock()
	defer a.schreibMu.Unlock()
	_, err := io.WriteString(a.kanal, zeile)
	return err
}

// lies verteilt die Antworten der Stelle; kehrt zurück, wenn der Kanal endet.
// Danach bekommt jede offene und jede weitere Frage einen Fehler.
func (a *anschluss) lies() error {
	defer func() {
		a.mu.Lock()
		a.geschlossen = true
		for nr, k := range a.wartet {
			close(k)
			delete(a.wartet, nr)
		}
		a.mu.Unlock()
	}()
	leser := bufio.NewReader(a.kanal)
	for {
		zeile, err := leser.ReadString('\n')
		if err != nil {
			return err
		}
		var (
			nr     uint64
			code   int
			laenge int
		)
		if _, err := fmt.Sscanf(zeile, "a %d %d %d\n", &nr, &code, &laenge); err != nil || laenge < 0 || laenge > maxAntwort {
			return errors.New("Kanal: unerwartete Zeile der Stelle")
		}
		text := make([]byte, laenge)
		if _, err := io.ReadFull(leser, text); err != nil {
			return err
		}
		a.mu.Lock()
		k := a.wartet[nr]
		delete(a.wartet, nr)
		a.mu.Unlock()
		if k != nil {
			k <- Antwort{Code: code, Text: text}
		}
	}
}

var errKanalZu = errors.New("Kanal zur Stelle geschlossen")

// frage stellt eine Frage und wartet auf die Antwort. Endet ctx vorher (die
// Box hat die Verbindung beendet), bekommt die Stelle das gesagt.
func (a *anschluss) frage(ctx context.Context, box netip.Addr, warte time.Duration, kennt string) (Antwort, error) {
	k := make(chan Antwort, 1)
	a.mu.Lock()
	if a.geschlossen {
		a.mu.Unlock()
		return Antwort{}, errKanalZu
	}
	a.naechste++
	nr := a.naechste
	a.wartet[nr] = k
	a.mu.Unlock()
	if err := a.sende(frage{nr: nr, box: box, warte: warte, kennt: kennt}.zeile()); err != nil {
		return Antwort{}, err
	}
	// Die Stelle antwortet spätestens nach der Wartezeit; bleibt sie stumm,
	// wartet die Box nicht ewig.
	frist := time.NewTimer(warte + 20*time.Second)
	defer frist.Stop()
	select {
	case antwort, ok := <-k:
		if !ok {
			return Antwort{}, errKanalZu
		}
		return antwort, nil
	case <-ctx.Done():
	case <-frist.C:
	}
	a.mu.Lock()
	delete(a.wartet, nr)
	a.mu.Unlock()
	_ = a.sende(fmt.Sprintf("x %d\n", nr))
	if ctx.Err() != nil {
		return Antwort{}, ctx.Err()
	}
	return Antwort{}, errors.New("keine Antwort der Stelle")
}
