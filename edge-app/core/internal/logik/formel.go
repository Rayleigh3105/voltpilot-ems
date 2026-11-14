package logik

import (
	"strconv"
	"strings"
)

// Die Formelsprache: Werte mit Einheiten, drei Wahrheitswerte, benannte Funktionen.
// Rangfolge von schwach nach stark: or, and, not, Vergleich, + -, * /, Vorzeichen.
// Wörter nach dem Entscheid E9 = B (englisch); die Wortliste steht im Vertrag.

type knotenArt byte

const (
	kZahl knotenArt = iota
	kBool
	kName
	kUn
	kBin
	kRuf
	kKlammer
)

// baum ist ein gelesener Ausdruck. src trägt den Textausschnitt für Meldungen und
// als Schlüssel des holds()-Gedächtnisses (wie im Referenzlabor).
type baum struct {
	t    knotenArt
	op   string
	v    float64
	d    Groesse
	b    bool
	n    string
	f    string
	x    *baum
	l, r *baum
	args []*baum
	src  string
}

type token struct {
	k string // "zahl", "text", "name", "op"
	v string
	z float64
	d Groesse
	a int // Anfang im Quelltext
}

func istNameZeichen(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func istNameAnfang(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func zerlege(text string) ([]token, error) {
	var t []token
	s := text
	i := 0
	for i < len(s) {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		if c >= '0' && c <= '9' {
			j := i
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			if j+1 < len(s) && s[j] == '.' && s[j+1] >= '0' && s[j+1] <= '9' {
				j++
				for j < len(s) && s[j] >= '0' && s[j] <= '9' {
					j++
				}
			}
			zahl, err := strconv.ParseFloat(s[i:j], 64)
			if err != nil {
				return nil, fehler("Keine Zahl: „%s“", s[i:j])
			}
			k := j
			for k < len(s) && s[k] == ' ' {
				k++
			}
			gefunden := false
			for _, e := range einheiten {
				if strings.HasPrefix(s[k:], e.sym) {
					ende := k + len(e.sym)
					letzter := e.sym[len(e.sym)-1]
					wortEinheit := istBuchstabe(letzter)
					if wortEinheit && ende < len(s) && istNameZeichen(s[ende]) {
						continue
					}
					t = append(t, token{k: "zahl", z: zahl * e.faktor, d: e.d, a: i})
					j = ende
					gefunden = true
					break
				}
			}
			if !gefunden {
				t = append(t, token{k: "zahl", z: zahl, d: GroesseZahl, a: i})
			}
			i = j
			continue
		}
		if c == '"' {
			e := strings.IndexByte(s[i+1:], '"')
			if e < 0 {
				return nil, fehler("Anführungszeichen ohne Ende")
			}
			t = append(t, token{k: "text", v: s[i+1 : i+1+e], a: i})
			i = i + e + 2
			continue
		}
		if istNameAnfang(c) {
			j := i
			for j < len(s) && istNameZeichen(s[j]) {
				j++
			}
			if j < len(s) && s[j] == '.' && j+1 < len(s) && istNameAnfang(s[j+1]) {
				j++
				for j < len(s) && istNameZeichen(s[j]) {
					j++
				}
			}
			t = append(t, token{k: "name", v: s[i:j], a: i})
			i = j
			continue
		}
		if i+1 < len(s) {
			zwei := s[i : i+2]
			if zwei == "<=" || zwei == ">=" || zwei == "==" || zwei == "!=" {
				t = append(t, token{k: "op", v: zwei, a: i})
				i += 2
				continue
			}
		}
		if strings.IndexByte("<>+-*/(),", c) >= 0 {
			t = append(t, token{k: "op", v: string(c), a: i})
			i++
			continue
		}
		r := []rune(s[i:])
		return nil, fehler("Unbekanntes Zeichen „%s“ in „%s“", string(r[0]), s)
	}
	return t, nil
}

type leser struct {
	src string
	t   []token
	p   int
}

// lies liest einen Ausdruck der Formelsprache.
func lies(text string) (*baum, error) {
	src := strings.TrimSpace(strings.Join(strings.Fields(text), " "))
	t, err := zerlege(src)
	if err != nil {
		return nil, err
	}
	l := &leser{src: src, t: t}
	b, err := l.oder()
	if err != nil {
		return nil, err
	}
	if l.p < len(l.t) {
		return nil, fehler("Rest nach dem Ausdruck in „%s“", src)
	}
	b.src = src
	return b, nil
}

func (l *leser) blick() *token {
	if l.p < len(l.t) {
		return &l.t[l.p]
	}
	return nil
}

func (l *leser) ist(k, v string) bool {
	t := l.blick()
	return t != nil && t.k == k && (v == "" || t.v == v)
}

func (l *leser) nimm(k, v string) (*token, error) {
	if !l.ist(k, v) {
		was := v
		if was == "" {
			was = k
		}
		return nil, fehler("Erwartet %s in „%s“", was, l.src)
	}
	l.p++
	return &l.t[l.p-1], nil
}

func (l *leser) anfang() int {
	if t := l.blick(); t != nil {
		return t.a
	}
	return len(l.src)
}

func (l *leser) ende() int {
	if l.p > 0 && l.p < len(l.t) {
		return l.t[l.p].a
	}
	return len(l.src)
}

func (l *leser) mitText(n *baum, a int) *baum {
	n.src = strings.TrimSpace(l.src[a:l.ende()])
	return n
}

func (l *leser) oder() (*baum, error) {
	a := l.anfang()
	links, err := l.und()
	if err != nil {
		return nil, err
	}
	for l.ist("name", "or") {
		l.p++
		rechts, err := l.und()
		if err != nil {
			return nil, err
		}
		links = l.mitText(&baum{t: kBin, op: "or", l: links, r: rechts}, a)
	}
	return links, nil
}

func (l *leser) und() (*baum, error) {
	a := l.anfang()
	links, err := l.nicht()
	if err != nil {
		return nil, err
	}
	for l.ist("name", "and") {
		l.p++
		rechts, err := l.nicht()
		if err != nil {
			return nil, err
		}
		links = l.mitText(&baum{t: kBin, op: "and", l: links, r: rechts}, a)
	}
	return links, nil
}

func (l *leser) nicht() (*baum, error) {
	a := l.anfang()
	if l.ist("name", "not") {
		l.p++
		x, err := l.nicht()
		if err != nil {
			return nil, err
		}
		return l.mitText(&baum{t: kUn, op: "not", x: x}, a), nil
	}
	return l.vergleich()
}

func (l *leser) vergleich() (*baum, error) {
	a := l.anfang()
	links, err := l.summe()
	if err != nil {
		return nil, err
	}
	if t := l.blick(); t != nil && t.k == "op" {
		switch t.v {
		case "<", "<=", ">", ">=", "==", "!=":
			l.p++
			rechts, err := l.summe()
			if err != nil {
				return nil, err
			}
			return l.mitText(&baum{t: kBin, op: t.v, l: links, r: rechts}, a), nil
		}
	}
	return links, nil
}

func (l *leser) summe() (*baum, error) {
	a := l.anfang()
	links, err := l.produkt()
	if err != nil {
		return nil, err
	}
	for l.ist("op", "+") || l.ist("op", "-") {
		op := l.blick().v
		l.p++
		rechts, err := l.produkt()
		if err != nil {
			return nil, err
		}
		links = l.mitText(&baum{t: kBin, op: op, l: links, r: rechts}, a)
	}
	return links, nil
}

func (l *leser) produkt() (*baum, error) {
	a := l.anfang()
	links, err := l.unaer()
	if err != nil {
		return nil, err
	}
	for l.ist("op", "*") || l.ist("op", "/") {
		op := l.blick().v
		l.p++
		rechts, err := l.unaer()
		if err != nil {
			return nil, err
		}
		links = l.mitText(&baum{t: kBin, op: op, l: links, r: rechts}, a)
	}
	return links, nil
}

func (l *leser) unaer() (*baum, error) {
	a := l.anfang()
	if l.ist("op", "-") {
		l.p++
		x, err := l.unaer()
		if err != nil {
			return nil, err
		}
		return l.mitText(&baum{t: kUn, op: "-", x: x}, a), nil
	}
	if l.ist("op", "+") {
		l.p++
		return l.unaer()
	}
	return l.primaer()
}

func (l *leser) primaer() (*baum, error) {
	tok := l.blick()
	if tok == nil {
		return nil, fehler("Ausdruck endet zu früh: „%s“", l.src)
	}
	a := tok.a
	switch tok.k {
	case "zahl":
		l.p++
		return l.mitText(&baum{t: kZahl, v: tok.z, d: tok.d}, a), nil
	case "text":
		l.p++
		m := uhrzeitRe.FindStringSubmatch(tok.v)
		if m == nil {
			return nil, fehler("Nur Uhrzeiten stehen in Anführungszeichen: „%s“", tok.v)
		}
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		return l.mitText(&baum{t: kZahl, v: float64(h*60 + min), d: GroesseUhrzeit}, a), nil
	case "name":
		l.p++
		switch tok.v {
		case "on", "true":
			return l.mitText(&baum{t: kBool, b: true}, a), nil
		case "off", "false":
			return l.mitText(&baum{t: kBool, b: false}, a), nil
		}
		if l.ist("op", "(") {
			l.p++
			var args []*baum
			if !l.ist("op", ")") {
				arg, err := l.oder()
				if err != nil {
					return nil, err
				}
				args = append(args, arg)
				for l.ist("op", ",") {
					l.p++
					arg, err := l.oder()
					if err != nil {
						return nil, err
					}
					args = append(args, arg)
				}
			}
			if _, err := l.nimm("op", ")"); err != nil {
				return nil, err
			}
			return l.mitText(&baum{t: kRuf, f: tok.v, args: args}, a), nil
		}
		return l.mitText(&baum{t: kName, n: tok.v}, a), nil
	case "op":
		if tok.v == "(" {
			l.p++
			x, err := l.oder()
			if err != nil {
				return nil, err
			}
			if _, err := l.nimm("op", ")"); err != nil {
				return nil, err
			}
			return l.mitText(&baum{t: kKlammer, x: x}, a), nil
		}
	}
	return nil, fehler("Unerwartet „%s“ in „%s“", tok.v, l.src)
}
