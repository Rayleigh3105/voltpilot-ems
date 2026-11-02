// Package protokoll schreibt das Schritt-Protokoll eines Laufs: je Lauf eine
// Datei mit einer JSON-Zeile je Ereignis, nur angehängt, nie umgeschrieben.
//
// Ein Beleg ist die echte Ausgabe, die einen Schritt beweist (Prüfsumme auf
// der Box, Zeile aus /etc/openwrt_release, Fingerabdruck), als geordnete
// Liste von Angaben. Jede Zeichenkette geht vor dem Schreiben durch den
// Schwärzer (internal/geheim): Ein Geheimnis steht in keinem Beleg.
package protokoll

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// MaxWert begrenzt eine Angabe: ein Beleg ist ein Auszug, kein Mitschnitt.
const MaxWert = 4096

// Angabe ist ein Teil eines Belegs.
type Angabe struct {
	Name string `json:"name"`
	Wert string `json:"wert"`
}

// Beleg ist die geordnete Liste der Angaben eines Schritts.
type Beleg []Angabe

// Mit hängt eine Angabe an.
func (b Beleg) Mit(name, wert string) Beleg { return append(b, Angabe{Name: name, Wert: wert}) }

// Leer sagt, ob der Beleg keine Angabe mit Inhalt hat.
func (b Beleg) Leer() bool {
	for _, a := range b {
		if strings.TrimSpace(a.Wert) != "" {
			return false
		}
	}
	return true
}

// Wert gibt die erste Angabe mit diesem Namen zurück.
func (b Beleg) Wert(name string) (string, bool) {
	for _, a := range b {
		if a.Name == name {
			return a.Wert, true
		}
	}
	return "", false
}

// Art eines Eintrags.
const (
	LaufBegonnen       = "lauf_begonnen"
	SchrittBegonnen    = "schritt_begonnen"
	SchrittBelegt      = "schritt_belegt"
	SchrittGescheitert = "schritt_gescheitert"
	Wartet             = "wartet"
	Eingabe            = "eingabe"
	LaufBeendet        = "lauf_beendet"
)

// Eintrag ist eine Zeile des Protokolls.
type Eintrag struct {
	Zeit     time.Time         `json:"zeit"`
	Lauf     string            `json:"lauf"`
	Art      string            `json:"art"`
	Schritt  string            `json:"schritt,omitempty"`
	Beleg    Beleg             `json:"beleg,omitempty"`
	Grund    string            `json:"grund,omitempty"`
	Zustand  string            `json:"zustand,omitempty"`
	Angaben  map[string]string `json:"angaben,omitempty"`
	DauerSek float64           `json:"dauer_s,omitempty"`
}

// geschwaerzt gibt eine Kopie zurück, in der jede Zeichenkette geschwärzt
// und jede Angabe auf MaxWert gekürzt ist.
func (e Eintrag) geschwaerzt() Eintrag {
	s := func(t string) string { return kuerze(geheim.Schwaerze(t)) }
	e.Schritt = s(e.Schritt)
	e.Grund = s(e.Grund)
	e.Zustand = s(e.Zustand)
	if e.Beleg != nil {
		b := make(Beleg, len(e.Beleg))
		for i, a := range e.Beleg {
			b[i] = Angabe{Name: s(a.Name), Wert: s(a.Wert)}
		}
		e.Beleg = b
	}
	if e.Angaben != nil {
		m := make(map[string]string, len(e.Angaben))
		for k, v := range e.Angaben {
			m[s(k)] = s(v)
		}
		e.Angaben = m
	}
	return e
}

func kuerze(t string) string {
	if len(t) <= MaxWert {
		return t
	}
	// an einer Zeichengrenze kürzen
	n := MaxWert
	for n > 0 && (t[n]&0xC0) == 0x80 {
		n--
	}
	return t[:n] + " … (gekürzt)"
}

var kennungMuster = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,63}$`)

// GueltigeKennung prüft eine Laufkennung; sie wird Teil eines Dateinamens.
func GueltigeKennung(k string) bool { return kennungMuster.MatchString(k) }

// Ablage ist das Verzeichnis der Protokolle.
type Ablage struct {
	dir string
	mu  sync.Mutex
}

// NeueAblage legt das Verzeichnis an (nur für den Dienst lesbar).
func NeueAblage(dir string) (*Ablage, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("Protokollverzeichnis %s: %w", dir, err)
	}
	return &Ablage{dir: dir}, nil
}

func (a *Ablage) pfad(lauf string) (string, error) {
	if !GueltigeKennung(lauf) {
		return "", fmt.Errorf("ungültige Laufkennung %q", lauf)
	}
	return filepath.Join(a.dir, lauf+".jsonl"), nil
}

// Schreibe hängt einen Eintrag an das Protokoll seines Laufs an und
// schreibt ihn sofort auf die Platte.
func (a *Ablage) Schreibe(e Eintrag) error {
	p, err := a.pfad(e.Lauf)
	if err != nil {
		return err
	}
	if e.Zeit.IsZero() {
		e.Zeit = time.Now().UTC()
	}
	zeile, err := json.Marshal(e.geschwaerzt())
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(zeile, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Lies gibt alle Einträge eines Laufs zurück.
func (a *Ablage) Lies(lauf string) ([]Eintrag, error) {
	p, err := a.pfad(lauf)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Eintrag
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		if len(strings.TrimSpace(sc.Text())) == 0 {
			continue
		}
		var e Eintrag
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			return out, fmt.Errorf("Protokoll %s: Zeile %d: %w", lauf, len(out)+1, err)
		}
		out = append(out, e)
	}
	return out, sc.Err()
}

// Begonnen zählt die Läufe, die unter einer Freigabe begonnen haben (für ihre
// Obergrenze). Es zählt der erste Eintrag jeder Datei.
func (a *Ablage) Begonnen(freigabe string) (int, error) {
	laeufe, err := a.Laeufe()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, l := range laeufe {
		p, _ := a.pfad(l)
		f, err := os.Open(p)
		if err != nil {
			return n, err
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		if sc.Scan() {
			var e Eintrag
			if json.Unmarshal(sc.Bytes(), &e) == nil && e.Art == LaufBegonnen && e.Angaben["freigabe"] == freigabe {
				n++
			}
		}
		_ = f.Close()
	}
	return n, nil
}

// Laeufe gibt die Kennungen aller Läufe zurück, neueste zuerst (die
// Kennung beginnt mit dem Zeitpunkt).
func (a *Ablage) Laeufe() ([]string, error) {
	eintraege, err := os.ReadDir(a.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, d := range eintraege {
		n := d.Name()
		if d.IsDir() || !strings.HasSuffix(n, ".jsonl") {
			continue
		}
		k := strings.TrimSuffix(n, ".jsonl")
		if GueltigeKennung(k) {
			out = append(out, k)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out, nil
}
