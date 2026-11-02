// Package metriken hält die Metriken des Dienstes und schreibt sie im
// Textformat von Prometheus (GET /metrics). Ohne Fremdbibliothek: der Dienst
// hat eine Handvoll Werte.
//
// Unbekannt ist keine Null: Ein Messwert, der nie gesetzt wurde oder mit
// Loesche zurückgenommen ist, fehlt in der Ausgabe. Labels tragen nie eine
// Box-Referenz, MAC oder Adresse, nur feste Wörter (Schritt, Ergebnis).
package metriken

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type art string

const (
	gauge   art = "gauge"
	counter art = "counter"
)

type familie struct {
	name, hilfe string
	art         art
	labels      []string
	werte       map[string]float64 // Schlüssel: Labelwerte mit \x00 verbunden
}

// Register sammelt Metriken.
type Register struct {
	mu       sync.Mutex
	familien map[string]*familie
}

// Neu legt ein leeres Register an.
func Neu() *Register { return &Register{familien: map[string]*familie{}} }

func (r *Register) familie(name, hilfe string, a art, labels []string) *familie {
	r.mu.Lock()
	defer r.mu.Unlock()
	if f, ok := r.familien[name]; ok {
		return f
	}
	f := &familie{name: name, hilfe: hilfe, art: a, labels: labels, werte: map[string]float64{}}
	r.familien[name] = f
	return f
}

// Messwert ist ein Wert, der steigen und fallen kann.
type Messwert struct {
	r *Register
	f *familie
}

// Zaehler zählt nur aufwärts.
type Zaehler struct {
	r *Register
	f *familie
}

// Messwert legt einen Messwert an (oder gibt den vorhandenen zurück).
func (r *Register) Messwert(name, hilfe string, labels ...string) Messwert {
	return Messwert{r: r, f: r.familie(name, hilfe, gauge, labels)}
}

// Zaehler legt einen Zähler an (oder gibt den vorhandenen zurück).
func (r *Register) Zaehler(name, hilfe string, labels ...string) Zaehler {
	return Zaehler{r: r, f: r.familie(name, hilfe, counter, labels)}
}

func schluessel(f *familie, werte []string) string {
	if len(werte) != len(f.labels) {
		panic(fmt.Sprintf("metrik %s: %d Labels erwartet, %d bekommen", f.name, len(f.labels), len(werte)))
	}
	return strings.Join(werte, "\x00")
}

// Setze setzt den Wert.
func (m Messwert) Setze(v float64, labels ...string) {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	m.f.werte[schluessel(m.f, labels)] = v
}

// Loesche nimmt den Wert zurück: er fehlt dann in der Ausgabe.
func (m Messwert) Loesche(labels ...string) {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	delete(m.f.werte, schluessel(m.f, labels))
}

// Wahr setzt 1 oder 0.
func (m Messwert) Wahr(b bool, labels ...string) {
	if b {
		m.Setze(1, labels...)
	} else {
		m.Setze(0, labels...)
	}
}

// Plus zählt einen hoch.
func (z Zaehler) Plus(labels ...string) {
	z.r.mu.Lock()
	defer z.r.mu.Unlock()
	z.f.werte[schluessel(z.f, labels)]++
}

// Null legt einen Zähler mit 0 an, damit er vor dem ersten Ereignis sichtbar ist.
func (z Zaehler) Null(labels ...string) {
	z.r.mu.Lock()
	defer z.r.mu.Unlock()
	k := schluessel(z.f, labels)
	if _, ok := z.f.werte[k]; !ok {
		z.f.werte[k] = 0
	}
}

// Schreibe gibt alle Metriken im Textformat aus, sortiert.
func (r *Register) Schreibe(w io.Writer) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	namen := make([]string, 0, len(r.familien))
	for n := range r.familien {
		namen = append(namen, n)
	}
	sort.Strings(namen)
	var b strings.Builder
	for _, n := range namen {
		f := r.familien[n]
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", f.name, f.hilfe, f.name, f.art)
		keys := make([]string, 0, len(f.werte))
		for k := range f.werte {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteString(f.name)
			if len(f.labels) > 0 {
				werte := strings.Split(k, "\x00")
				b.WriteByte('{')
				for i, l := range f.labels {
					if i > 0 {
						b.WriteByte(',')
					}
					fmt.Fprintf(&b, "%s=%s", l, strconv.Quote(werte[i]))
				}
				b.WriteByte('}')
			}
			b.WriteByte(' ')
			b.WriteString(zahl(f.werte[k]))
			b.WriteByte('\n')
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func zahl(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}
