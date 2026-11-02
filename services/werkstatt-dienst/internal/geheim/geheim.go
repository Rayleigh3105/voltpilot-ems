// Package geheim hält Geheimnisse (Root-Passwort einer Box, private Schlüssel)
// so, dass sie weder in einer Log-Zeile noch in einem Beleg landen können.
//
// Zwei Riegel:
//
//  1. Der Typ Geheim gibt seinen Wert bei jeder Formatierung als "[geheim]"
//     aus (fmt, JSON, Text, slog). Nur Offenbaren liefert den Wert, und das
//     ruft nur der Code auf, der ihn über die Standardeingabe an eine Box gibt.
//  2. Jeder Wert, der als Geheim entsteht, steht bis Vergessen in der Liste
//     des Schwärzers. Log-Handler und Belegablage schicken jede Zeichenkette
//     durch Schwaerze: Taucht ein Geheimnis doch im Text auf (eine Box gibt
//     es in ihrer Ausgabe zurück, eine Fehlermeldung zitiert es), wird es
//     ersetzt, bevor es geschrieben wird.
package geheim

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
)

// Ersatz steht überall dort, wo ein Geheimnis stünde.
const Ersatz = "[geheim]"

// MindestLaenge: kürzere Werte schwärzt der Schwärzer nicht, sonst ersetzte
// er beliebige kurze Wörter in Belegen. Ein Geheimnis dieses Dienstes ist
// immer länger (Passwort 20 Zeichen, Schlüssel ein Vielfaches).
const MindestLaenge = 8

// Geheim ist ein Geheimnis. Der Nullwert ist leer.
type Geheim struct {
	wert *string
}

// Neu macht aus einem Wert ein Geheimnis und meldet ihn dem Schwärzer.
func Neu(wert string) Geheim {
	standard.merke(wert)
	return Geheim{wert: &wert}
}

// Offenbaren gibt den Wert zurück. Nur für die eine Stelle, die ihn an eine
// Box weitergibt (Standardeingabe) oder mit ihm einen Schlüssel liest.
func (g Geheim) Offenbaren() string {
	if g.wert == nil {
		return ""
	}
	return *g.wert
}

// Leer sagt, ob kein Wert gesetzt ist.
func (g Geheim) Leer() bool { return g.wert == nil || *g.wert == "" }

// Vergessen nimmt den Wert aus der Liste des Schwärzers. Danach schwärzt der
// Schwärzer ihn nicht mehr; der Aufrufer darf ihn dann nirgends mehr haben.
func (g Geheim) Vergessen() {
	if g.wert != nil {
		standard.vergiss(*g.wert)
	}
}

func (Geheim) String() string                { return Ersatz }
func (Geheim) GoString() string              { return Ersatz }
func (Geheim) MarshalJSON() ([]byte, error)  { return json.Marshal(Ersatz) }
func (Geheim) MarshalText() ([]byte, error)  { return []byte(Ersatz), nil }
func (Geheim) LogValue() slog.Value          { return slog.StringValue(Ersatz) }
func (Geheim) Format(f fmt.State, verb rune) { _, _ = f.Write([]byte(Ersatz)) }

// Schwaerze ersetzt jedes gemerkte Geheimnis in s durch Ersatz.
func Schwaerze(s string) string { return standard.schwaerze(s) }

// Schwaerzer hält die Liste der lebenden Geheimnisse.
type Schwaerzer struct {
	mu    sync.RWMutex
	werte map[string]int // Wert → Anzahl der Geheimnisse mit diesem Wert
	liste []string       // längste zuerst, damit ein Teilwort nicht zuerst ersetzt wird
}

var standard = &Schwaerzer{werte: map[string]int{}}

func (s *Schwaerzer) merke(wert string) {
	if len(wert) < MindestLaenge {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.werte[wert]++
	s.neueListe()
	// Auch die Zeilen eines mehrzeiligen Geheimnisses (PEM-Schlüssel): eine
	// Ausgabe, die nur eine Zeile davon zitiert, verrät sonst einen Teil.
	if strings.Contains(wert, "\n") {
		for _, z := range strings.Split(wert, "\n") {
			z = strings.TrimSpace(z)
			if len(z) >= 2*MindestLaenge && !strings.HasPrefix(z, "-----") {
				s.werte[z]++
			}
		}
		s.neueListe()
	}
}

func (s *Schwaerzer) vergiss(wert string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	weg := func(w string) {
		if s.werte[w] <= 1 {
			delete(s.werte, w)
		} else {
			s.werte[w]--
		}
	}
	weg(wert)
	if strings.Contains(wert, "\n") {
		for _, z := range strings.Split(wert, "\n") {
			z = strings.TrimSpace(z)
			if len(z) >= 2*MindestLaenge && !strings.HasPrefix(z, "-----") {
				weg(z)
			}
		}
	}
	s.neueListe()
}

func (s *Schwaerzer) neueListe() {
	s.liste = s.liste[:0]
	for w := range s.werte {
		s.liste = append(s.liste, w)
	}
	sort.Slice(s.liste, func(i, j int) bool { return len(s.liste[i]) > len(s.liste[j]) })
}

func (s *Schwaerzer) schwaerze(text string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, w := range s.liste {
		if strings.Contains(text, w) {
			text = strings.ReplaceAll(text, w, Ersatz)
		}
	}
	return text
}
