package logikdienst

// Meldungen an der Zeile (Stufe 4, Ansicht "Text" im Portal): jeder Befund der
// Prüfung, jede Probe, die nicht besteht, und jeder Hinweis wird an die Zeile des
// Textes gestellt, an der er entsteht. Die Stelle nennt der Kern (Befund.Ort) oder
// der Leser in seiner Meldung ("states.warm.on_when: …", "Zeile 7: …",
// "yaml: line 5: …"); hier wird sie gegen den Text aufgelöst, den der Mensch
// geschrieben hat - in der YAML-Schreibform wie in der kanonischen JSON-Form.

import (
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Meldung ist eine Meldung der Prüfung an ihrer Zeile.
type Meldung struct {
	// Art: fehler (sperrt; ein Befund oder ein unlesbarer Text), probe (eine Probe
	// besteht nicht; sperrt ebenfalls), hinweis (sperrt nicht).
	Art  string `json:"art"`
	Text string `json:"text"`
	// Ort ist die Stelle im Dokument (Schreibweise des Lesers), leer ohne Stelle.
	Ort string `json:"ort,omitempty"`
	// Zeile ist die Zeile im Text ab 1; 0 heißt: keine Stelle gefunden.
	Zeile int `json:"zeile,omitempty"`
}

const (
	MeldungFehler  = "fehler"
	MeldungProbe   = "probe"
	MeldungHinweis = "hinweis"
)

var (
	// "Zeile 7: …" (textform) und "yaml: line 5: …" (yaml.v3).
	zeileTextform = regexp.MustCompile(`^Zeile (\d+): `)
	zeileYAML     = regexp.MustCompile(`\bline (\d+)\b`)
	// Der Pfad vor der Meldung des Lesers: "states.warm.on_when: …", "tests[2].given: …".
	ortVorne = regexp.MustCompile(`^([a-z_][a-z0-9_]*(?:\[\d+\])*(?:\.[a-z0-9_]+(?:\[\d+\])*)*)(?::|\s)`)
	teilOrt  = regexp.MustCompile(`^([a-z0-9_]+)?((?:\[\d+\])*)$`)
	platz    = regexp.MustCompile(`\[(\d+)\]`)
	// Ein unbekannter Schlüssel steht in seiner eigenen Zeile, nicht in der seines Objekts.
	unbekannterSchluessel = regexp.MustCompile(`unbekannter Schlüssel „([a-z0-9_]+)“`)
)

// zeilen löst Stellen gegen den Text auf.
type zeilen struct {
	wurzel *yaml.Node
}

// neueZeilen liest den Text als Baum mit Zeilen; ein Text, den YAML nicht liest, hat
// keine Stellen (die Meldung des Lesers nennt dann selbst die Zeile).
func neueZeilen(text []byte) *zeilen {
	var doc yaml.Node
	if yaml.Unmarshal(text, &doc) != nil || doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return &zeilen{}
	}
	return &zeilen{wurzel: doc.Content[0]}
}

// schritt ist ein Teil einer Stelle: ein Schlüssel oder ein Listenplatz ab 1.
type schritt struct {
	name  string
	platz int
}

func zerlege(ort string) []schritt {
	var out []schritt
	for _, teil := range strings.Split(ort, ".") {
		m := teilOrt.FindStringSubmatch(teil)
		if m == nil {
			return out
		}
		if m[1] != "" {
			out = append(out, schritt{name: m[1]})
		}
		for _, p := range platz.FindAllStringSubmatch(m[2], -1) {
			n, _ := strconv.Atoi(p[1])
			out = append(out, schritt{platz: n})
		}
	}
	return out
}

// zeile ist die Zeile der Stelle; reicht die Stelle tiefer als der Text, die Zeile
// des tiefsten Teils, den es gibt. 0 = nichts gefunden.
func (z *zeilen) zeile(ort string) int {
	if z.wurzel == nil || ort == "" {
		return 0
	}
	n := z.wurzel
	beste := 0
	for _, s := range zerlege(ort) {
		next, linie := kind(n, s)
		if next == nil {
			break
		}
		n, beste = next, linie
	}
	return beste
}

// kind sucht einen Teil unter einem Knoten und nennt seine Zeile: einen Schlüssel in
// einem Objekt, einen Listenplatz, oder - wie der Leser Schritte nennt
// ("states.heizstufe.versuch") - den Eintrag einer Liste mit diesem Namen.
func kind(n *yaml.Node, s schritt) (*yaml.Node, int) {
	switch n.Kind {
	case yaml.MappingNode:
		if s.platz > 0 {
			return nil, 0
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == s.name {
				return n.Content[i+1], n.Content[i].Line
			}
		}
		// Ein Schritt mit diesem Namen in einer Liste darunter (steps).
		for i := 0; i+1 < len(n.Content); i += 2 {
			if e := benannt(n.Content[i+1], s.name); e != nil {
				return e, e.Line
			}
		}
	case yaml.SequenceNode:
		if s.platz > 0 {
			if s.platz <= len(n.Content) {
				return n.Content[s.platz-1], n.Content[s.platz-1].Line
			}
			return nil, 0
		}
		if e := benannt(n, s.name); e != nil {
			return e, e.Line
		}
	}
	return nil, 0
}

// benannt ist der Eintrag einer Liste mit name: <name> oder (eine benannte Bedingung)
// dem einen Schlüssel <name>.
func benannt(liste *yaml.Node, name string) *yaml.Node {
	if liste.Kind != yaml.SequenceNode {
		return nil
	}
	for _, e := range liste.Content {
		if e.Kind != yaml.MappingNode {
			continue
		}
		for i := 0; i+1 < len(e.Content); i += 2 {
			if e.Content[i].Value == "name" && e.Content[i+1].Value == name {
				return e
			}
		}
		if len(e.Content) == 2 && e.Content[0].Value == name {
			return e
		}
	}
	return nil
}

// ausFehler stellt die Meldung eines Lesers an ihre Zeile: die Zeile, die er selbst
// nennt, sonst die Stelle vor seiner Meldung.
func (z *zeilen) ausFehler(text string) Meldung {
	m := Meldung{Art: MeldungFehler, Text: text}
	if t := zeileTextform.FindStringSubmatch(text); t != nil {
		m.Zeile, _ = strconv.Atoi(t[1])
		m.Text = strings.TrimPrefix(text, t[0])
		return m
	}
	if t := zeileYAML.FindStringSubmatch(text); t != nil {
		m.Zeile, _ = strconv.Atoi(t[1])
		return m
	}
	if t := ortVorne.FindStringSubmatch(text); t != nil {
		m.Ort = t[1]
		if k := unbekannterSchluessel.FindStringSubmatch(text); k != nil {
			m.Ort += "." + k[1]
		}
		m.Zeile = z.zeile(m.Ort)
	}
	return m
}
