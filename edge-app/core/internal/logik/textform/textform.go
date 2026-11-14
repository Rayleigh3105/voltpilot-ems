// Package textform liest die YAML-Schreibform einer Steuerlogik und wandelt sie in die
// kanonische Form (Vertrag: docs/contracts/v2/steuerlogik.md). Die Box liest nur die
// kanonische JSON-Form; dieses Paket braucht der Dienst, der Texte von Menschen annimmt.
// Es gehört bewusst nicht in den Kern, damit die Box ohne YAML-Leser auskommt.
//
// Die Falle der Schreibform: Leser nach YAML 1.1 machen aus on, off, yes und no ohne
// Anführungszeichen ein Ja oder Nein, Leser nach YAML 1.2 lassen sie als Wort stehen.
// Der Vertrag löst das auf: on = true und off = false, die gespeicherte Form schreibt
// on und off, yes und no sind verboten, und kein Schlüssel ist eines dieser Wörter.
// Damit jeder Leser dasselbe Dokument sieht, sind hier auch die anderen Schreibweisen
// von Ja und Nein (True, YES, …) sowie unzitierte Uhrzeiten und Dezimalkommas Fehler.
package textform

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Knoten ist ein Wert der kanonischen Form mit erhaltener Reihenfolge der Schlüssel.
type Knoten struct {
	Art        byte // 'o' Objekt, 'a' Liste, 's' Text, 'z' Zahl, 'b' Ja/Nein, '0' null
	Schluessel []string
	Kinder     []*Knoten
	Liste      []*Knoten
	Text       string
	Zahl       float64
	Bool       bool
}

var (
	bejaht    = map[string]bool{"true": true, "on": true}
	verneint  = map[string]bool{"false": true, "off": true}
	jaNeinArt = regexp.MustCompile(`^(?i:y|n|yes|no|true|false|on|off)$`)
	uhrzeit   = regexp.MustCompile(`^\d{1,2}:\d{2}(:\d{2})?$`)
	dezimalKo = regexp.MustCompile(`^-?\d+,\d+$`)
)

// Lies liest die YAML-Schreibform in die kanonische Form.
func Lies(quelle []byte) (*Knoten, error) {
	var wurzel yaml.Node
	if err := yaml.Unmarshal(quelle, &wurzel); err != nil {
		return nil, fmt.Errorf("YAML: %w", err)
	}
	if wurzel.Kind != yaml.DocumentNode || len(wurzel.Content) != 1 {
		return nil, fmt.Errorf("die Schreibform ist ein Dokument")
	}
	return wandle(wurzel.Content[0], "")
}

func wandle(n *yaml.Node, schluessel string) (*Knoten, error) {
	switch n.Kind {
	case yaml.AliasNode:
		return wandle(n.Alias, schluessel)
	case yaml.MappingNode:
		k := &Knoten{Art: 'o'}
		for i := 0; i+1 < len(n.Content); i += 2 {
			ks := n.Content[i]
			if ks.Kind != yaml.ScalarNode {
				return nil, fehlerBei(ks, "ein Schlüssel ist ein Wort")
			}
			name := ks.Value
			if jaNeinArt.MatchString(name) {
				return nil, fehlerBei(ks, "„%s“ ist als Schlüssel nicht erlaubt (Ja/Nein-Wort)", name)
			}
			for _, vorhanden := range k.Schluessel {
				if vorhanden == name {
					return nil, fehlerBei(ks, "Schlüssel „%s“ steht doppelt", name)
				}
			}
			kind, err := wandle(n.Content[i+1], name)
			if err != nil {
				return nil, err
			}
			k.Schluessel = append(k.Schluessel, name)
			k.Kinder = append(k.Kinder, kind)
		}
		return k, nil
	case yaml.SequenceNode:
		k := &Knoten{Art: 'a'}
		for _, e := range n.Content {
			kind, err := wandle(e, "")
			if err != nil {
				return nil, err
			}
			k.Liste = append(k.Liste, kind)
		}
		return k, nil
	case yaml.ScalarNode:
		return wandleScalar(n, schluessel)
	}
	return nil, fehlerBei(n, "unerwarteter Knoten")
}

func wandleScalar(n *yaml.Node, schluessel string) (*Knoten, error) {
	plain := n.Style == 0
	switch n.Tag {
	case "!!null":
		if plain && n.Value != "" && n.Value != "~" && n.Value != "null" {
			return nil, fehlerBei(n, "„%s“ ist kein Wert", n.Value)
		}
		return &Knoten{Art: '0'}, nil
	case "!!bool", "!!str":
		if n.Tag == "!!bool" || plain {
			// Ein Ja oder Nein ohne Anführungszeichen: nur die vier kleingeschriebenen
			// Formen sind erlaubt, damit jeder YAML-Leser dasselbe Dokument sieht.
			if bejaht[n.Value] || verneint[n.Value] {
				// "else: true" bleibt ein Ja (Schema: const true); sonst schreibt die
				// gespeicherte Form on und off.
				if schluessel == "else" {
					return &Knoten{Art: 'b', Bool: bejaht[n.Value]}, nil
				}
				if bejaht[n.Value] {
					return &Knoten{Art: 's', Text: "on"}, nil
				}
				return &Knoten{Art: 's', Text: "off"}, nil
			}
			if jaNeinArt.MatchString(n.Value) {
				return nil, fehlerBei(n, "„%s“: schreibe on oder off", n.Value)
			}
		}
		if n.Tag == "!!bool" {
			return nil, fehlerBei(n, "„%s“: schreibe on oder off", n.Value)
		}
		if plain {
			if uhrzeit.MatchString(n.Value) {
				return nil, fehlerBei(n, "„%s“: Uhrzeiten stehen in Anführungszeichen", n.Value)
			}
			if dezimalKo.MatchString(n.Value) {
				return nil, fehlerBei(n, "„%s“: Dezimalzahlen mit Punkt", n.Value)
			}
		}
		return &Knoten{Art: 's', Text: n.Value}, nil
	case "!!int", "!!float":
		v, err := strconv.ParseFloat(strings.TrimPrefix(n.Value, "+"), 64)
		if err != nil {
			return nil, fehlerBei(n, "„%s“ ist keine Zahl", n.Value)
		}
		return &Knoten{Art: 'z', Zahl: v}, nil
	}
	return nil, fehlerBei(n, "„%s“ (%s) ist kein Wert der Schreibform", n.Value, n.Tag)
}

func fehlerBei(n *yaml.Node, format string, a ...any) error {
	return fmt.Errorf("Zeile %d: %s", n.Line, fmt.Sprintf(format, a...))
}

// LiesJSON liest die kanonische JSON-Form in denselben Baum (für den Vergleich der Vektoren).
func LiesJSON(quelle []byte) (*Knoten, error) {
	var wurzel yaml.Node // YAML ist eine Obermenge von JSON; der Leser erhält die Reihenfolge
	if err := yaml.Unmarshal(quelle, &wurzel); err != nil {
		return nil, fmt.Errorf("JSON: %w", err)
	}
	if wurzel.Kind != yaml.DocumentNode || len(wurzel.Content) != 1 {
		return nil, fmt.Errorf("ein Dokument")
	}
	return wandleJSON(wurzel.Content[0])
}

func wandleJSON(n *yaml.Node) (*Knoten, error) {
	switch n.Kind {
	case yaml.MappingNode:
		k := &Knoten{Art: 'o'}
		for i := 0; i+1 < len(n.Content); i += 2 {
			kind, err := wandleJSON(n.Content[i+1])
			if err != nil {
				return nil, err
			}
			k.Schluessel = append(k.Schluessel, n.Content[i].Value)
			k.Kinder = append(k.Kinder, kind)
		}
		return k, nil
	case yaml.SequenceNode:
		k := &Knoten{Art: 'a'}
		for _, e := range n.Content {
			kind, err := wandleJSON(e)
			if err != nil {
				return nil, err
			}
			k.Liste = append(k.Liste, kind)
		}
		return k, nil
	case yaml.ScalarNode:
		switch n.Tag {
		case "!!null":
			return &Knoten{Art: '0'}, nil
		case "!!bool":
			return &Knoten{Art: 'b', Bool: n.Value == "true"}, nil
		case "!!int", "!!float":
			v, err := strconv.ParseFloat(n.Value, 64)
			if err != nil {
				return nil, fehlerBei(n, "„%s“ ist keine Zahl", n.Value)
			}
			return &Knoten{Art: 'z', Zahl: v}, nil
		default:
			return &Knoten{Art: 's', Text: n.Value}, nil
		}
	}
	return nil, fehlerBei(n, "unerwarteter Knoten")
}

// Gleich vergleicht zwei Bäume; die Reihenfolge der Schlüssel zählt mit.
// Bei einem Unterschied nennt der Text die Stelle.
func Gleich(a, b *Knoten) (bool, string) {
	return gleich(a, b, "$")
}

func gleich(a, b *Knoten, pfad string) (bool, string) {
	if a.Art != b.Art {
		return false, fmt.Sprintf("%s: andere Art (%c gegen %c)", pfad, a.Art, b.Art)
	}
	switch a.Art {
	case 'o':
		if len(a.Schluessel) != len(b.Schluessel) {
			return false, fmt.Sprintf("%s: %d gegen %d Schlüssel", pfad, len(a.Schluessel), len(b.Schluessel))
		}
		for i := range a.Schluessel {
			if a.Schluessel[i] != b.Schluessel[i] {
				return false, fmt.Sprintf("%s: Schlüssel %d heißt „%s“ gegen „%s“", pfad, i+1, a.Schluessel[i], b.Schluessel[i])
			}
			if ok, wo := gleich(a.Kinder[i], b.Kinder[i], pfad+"."+a.Schluessel[i]); !ok {
				return false, wo
			}
		}
	case 'a':
		if len(a.Liste) != len(b.Liste) {
			return false, fmt.Sprintf("%s: %d gegen %d Einträge", pfad, len(a.Liste), len(b.Liste))
		}
		for i := range a.Liste {
			if ok, wo := gleich(a.Liste[i], b.Liste[i], fmt.Sprintf("%s[%d]", pfad, i)); !ok {
				return false, wo
			}
		}
	case 's':
		if a.Text != b.Text {
			return false, fmt.Sprintf("%s: „%s“ gegen „%s“", pfad, a.Text, b.Text)
		}
	case 'z':
		if a.Zahl != b.Zahl {
			return false, fmt.Sprintf("%s: %v gegen %v", pfad, a.Zahl, b.Zahl)
		}
	case 'b':
		if a.Bool != b.Bool {
			return false, fmt.Sprintf("%s: %v gegen %v", pfad, a.Bool, b.Bool)
		}
	}
	return true, ""
}

// JSON schreibt die kanonische Form als JSON, Reihenfolge der Schlüssel erhalten.
// Das ist die Form, die der Kern liest und die ins Bundle der Auslieferung kommt
// (Stufe 2, zweiter Teil: der Dienst nimmt die Schreibform an und liefert JSON aus).
func (k *Knoten) JSON() ([]byte, error) {
	var b []byte
	b, err := schreibeJSON(b, k)
	return b, err
}

func schreibeJSON(b []byte, k *Knoten) ([]byte, error) {
	switch k.Art {
	case 'o':
		b = append(b, '{')
		for i, s := range k.Schluessel {
			if i > 0 {
				b = append(b, ',')
			}
			sb, err := json.Marshal(s)
			if err != nil {
				return nil, err
			}
			b = append(b, sb...)
			b = append(b, ':')
			if b, err = schreibeJSON(b, k.Kinder[i]); err != nil {
				return nil, err
			}
		}
		return append(b, '}'), nil
	case 'a':
		b = append(b, '[')
		for i, e := range k.Liste {
			if i > 0 {
				b = append(b, ',')
			}
			var err error
			if b, err = schreibeJSON(b, e); err != nil {
				return nil, err
			}
		}
		return append(b, ']'), nil
	case 's':
		sb, err := json.Marshal(k.Text)
		if err != nil {
			return nil, err
		}
		return append(b, sb...), nil
	case 'z':
		if math.IsNaN(k.Zahl) || math.IsInf(k.Zahl, 0) {
			return nil, fmt.Errorf("Zahl %v lässt sich nicht als JSON schreiben", k.Zahl)
		}
		return strconv.AppendFloat(b, k.Zahl, 'g', -1, 64), nil
	case 'b':
		if k.Bool {
			return append(b, []byte("true")...), nil
		}
		return append(b, []byte("false")...), nil
	case '0':
		return append(b, []byte("null")...), nil
	}
	return nil, fmt.Errorf("unbekannte Knotenart %c", k.Art)
}
