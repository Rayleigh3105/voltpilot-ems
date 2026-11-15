package homeassistant

// Ein Leser für die Teilmenge von Jinja, die Home Assistant in Vorlagen benutzt:
// Text, {{ Ausdruck }}, {% set %}, {% if %}/{% elif %}/{% else %}, {% for %} und
// Kommentare; Ausdrücke mit Filtern (|float(0)), Tests (is number), Vergleichsketten
// (a <= b < c), bedingten Ausdrücken (a if b else c), Listen und Aufrufen. Die
// Rangfolge folgt jinja2 (parser.py): or, and, not, Vergleich, + -, ~, * / // %, **,
// Vorzeichen, dann Aufruf, Attribut, Index und Filter.
//
// Der Leser rechnet nichts; er baut einen Baum, den symbol.go deutet. Was er nicht
// kennt (Makros, Blöcke, Aufrufe mit Rumpf), ist ein Fehler mit der Zeile in der
// Vorlage.

import (
	"fmt"
	"strconv"
	"strings"
)

// jFehler ist ein Fehler beim Lesen einer Vorlage, mit der Zeile innerhalb der Vorlage (ab 0).
type jFehler struct {
	zeile int
	text  string
}

func (e *jFehler) Error() string { return e.text }

// Anweisungen
type (
	jKnoten  interface{}
	jText    struct{ text string }
	jAusgabe struct {
		e     jAusdruck
		zeile int
	}
	jSetze struct {
		name, attr string // attr bei {% set ns.attr = … %}
		e          jAusdruck
		zeile      int
	}
	jWenn struct {
		zweige []jZweig
		sonst  []jKnoten
		zeile  int
	}
	jZweig struct {
		bed   jAusdruck
		rumpf []jKnoten
	}
	jFuer struct {
		name  string
		ueber jAusdruck
		rumpf []jKnoten
		zeile int
	}
)

// Ausdrücke
type (
	jAusdruck interface{}
	jName     struct{ n string }
	jZahl     struct {
		v    float64
		ganz bool
	}
	jTextWert struct{ s string }
	jWahr     struct{ b bool }
	jNichts   struct{}
	jListe    struct{ el []jAusdruck }
	jBin      struct {
		op   string // + - * / // % ** ~ and or
		l, r jAusdruck
	}
	jVergleich struct {
		ops   []string // == != < <= > >= in "not in"
		teile []jAusdruck
	}
	jNicht struct{ e jAusdruck }
	jNeg   struct{ e jAusdruck }
	jWennA struct{ dann, bed, sonst jAusdruck }
	jAttr  struct {
		e    jAusdruck
		name string
	}
	jIndex  struct{ e, i jAusdruck }
	jAufruf struct {
		f      jAusdruck
		args   []jAusdruck
		kwargs map[string]jAusdruck
	}
	jFilter struct {
		e    jAusdruck
		name string
		args []jAusdruck
	}
	jTest struct {
		e     jAusdruck
		name  string
		nicht bool
		args  []jAusdruck
	}
)

// Vorlage ist eine gelesene Vorlage.
type Vorlage struct {
	Quelle string
	rumpf  []jKnoten
}

// LiesVorlage liest den Text einer Vorlage.
func LiesVorlage(text string) (*Vorlage, error) {
	teile, err := zerlegeVorlage(text)
	if err != nil {
		return nil, err
	}
	p := &jParser{teile: teile}
	rumpf, ende, err := p.anweisungen()
	if err != nil {
		return nil, err
	}
	if ende != "" {
		return nil, &jFehler{zeile: p.zeile(), text: "unerwartetes {% " + ende + " %}"}
	}
	return &Vorlage{Quelle: text, rumpf: rumpf}, nil
}

// IstVorlage sagt, ob ein Text Jinja enthält.
func IstVorlage(text string) bool {
	return strings.Contains(text, "{{") || strings.Contains(text, "{%")
}

type vTeil struct {
	art   byte // 't' Text, 'a' Ausgabe, 's' Anweisung
	text  string
	zeile int
}

func zerlegeVorlage(text string) ([]vTeil, error) {
	var out []vTeil
	zeile := 0
	i := 0
	for i < len(text) {
		j := strings.IndexAny(text[i:], "{")
		if j < 0 {
			out = append(out, vTeil{art: 't', text: text[i:], zeile: zeile})
			break
		}
		j += i
		if j+1 >= len(text) || (text[j+1] != '{' && text[j+1] != '%' && text[j+1] != '#') {
			// ein einzelnes { gehört zum Text
			k := j + 1
			out = append(out, vTeil{art: 't', text: text[i:k], zeile: zeile})
			zeile += strings.Count(text[i:k], "\n")
			i = k
			continue
		}
		if j > i {
			out = append(out, vTeil{art: 't', text: text[i:j], zeile: zeile})
			zeile += strings.Count(text[i:j], "\n")
		}
		art := text[j+1]
		schluss := map[byte]string{'{': "}}", '%': "%}", '#': "#}"}[art]
		k := strings.Index(text[j+2:], schluss)
		if k < 0 {
			return nil, &jFehler{zeile: zeile, text: "„" + string(text[j:j+2]) + "“ ohne Ende"}
		}
		innen := text[j+2 : j+2+k]
		innen = strings.TrimPrefix(innen, "-")
		innen = strings.TrimSuffix(innen, "-")
		switch art {
		case '{':
			out = append(out, vTeil{art: 'a', text: innen, zeile: zeile})
		case '%':
			out = append(out, vTeil{art: 's', text: innen, zeile: zeile})
		}
		zeile += strings.Count(text[j:j+2+k+2], "\n")
		i = j + 2 + k + 2
	}
	return out, nil
}

type jParser struct {
	teile []vTeil
	pos   int
}

func (p *jParser) zeile() int {
	if p.pos < len(p.teile) {
		return p.teile[p.pos].zeile
	}
	if len(p.teile) > 0 {
		return p.teile[len(p.teile)-1].zeile
	}
	return 0
}

// anweisungen liest bis zu einem Ende ({% endif %}, {% elif … %}, {% else %}, {% endfor %})
// und nennt dessen Anweisung.
func (p *jParser) anweisungen() ([]jKnoten, string, error) {
	var out []jKnoten
	for p.pos < len(p.teile) {
		t := p.teile[p.pos]
		switch t.art {
		case 't':
			p.pos++
			out = append(out, jText{text: t.text})
		case 'a':
			p.pos++
			e, err := liesAusdruck(t.text, t.zeile)
			if err != nil {
				return nil, "", err
			}
			out = append(out, jAusgabe{e: e, zeile: t.zeile})
		case 's':
			wort, rest := erstesWort(t.text)
			switch wort {
			case "endif", "endfor", "else", "elif":
				return out, wort, nil
			case "set":
				p.pos++
				gleich := strings.Index(rest, "=")
				if gleich < 0 {
					return nil, "", &jFehler{zeile: t.zeile, text: "{% set %} ohne „=“ (Blockzuweisung) wird nicht unterstützt"}
				}
				ziel := strings.TrimSpace(rest[:gleich])
				e, err := liesAusdruck(rest[gleich+1:], t.zeile)
				if err != nil {
					return nil, "", err
				}
				s := jSetze{e: e, zeile: t.zeile}
				if punkt := strings.Index(ziel, "."); punkt > 0 {
					s.name, s.attr = ziel[:punkt], ziel[punkt+1:]
				} else {
					s.name = ziel
				}
				if !istBezeichner(s.name) || (s.attr != "" && !istBezeichner(s.attr)) {
					return nil, "", &jFehler{zeile: t.zeile, text: "{% set " + ziel + " %}: mehrere Ziele werden nicht unterstützt"}
				}
				out = append(out, s)
			case "if":
				p.pos++
				w := jWenn{zeile: t.zeile}
				bed, err := liesAusdruck(rest, t.zeile)
				if err != nil {
					return nil, "", err
				}
				for {
					rumpf, ende, err := p.anweisungen()
					if err != nil {
						return nil, "", err
					}
					w.zweige = append(w.zweige, jZweig{bed: bed, rumpf: rumpf})
					if p.pos >= len(p.teile) {
						return nil, "", &jFehler{zeile: t.zeile, text: "{% if %} ohne {% endif %}"}
					}
					e := p.teile[p.pos]
					p.pos++
					if ende == "endif" {
						break
					}
					if ende == "elif" {
						_, r := erstesWort(e.text)
						bed, err = liesAusdruck(r, e.zeile)
						if err != nil {
							return nil, "", err
						}
						continue
					}
					if ende == "else" {
						sonst, ende2, err := p.anweisungen()
						if err != nil {
							return nil, "", err
						}
						if ende2 != "endif" {
							return nil, "", &jFehler{zeile: e.zeile, text: "{% else %} ohne {% endif %}"}
						}
						p.pos++
						w.sonst = sonst
						break
					}
					return nil, "", &jFehler{zeile: e.zeile, text: "{% " + ende + " %} in {% if %}"}
				}
				out = append(out, w)
			case "for":
				p.pos++
				in := strings.Index(rest, " in ")
				if in < 0 {
					return nil, "", &jFehler{zeile: t.zeile, text: "{% for %} ohne „in“"}
				}
				name := strings.TrimSpace(rest[:in])
				if !istBezeichner(name) {
					return nil, "", &jFehler{zeile: t.zeile, text: "{% for " + name + " %}: nur eine Schleifenvariable wird unterstützt"}
				}
				ueber, err := liesAusdruck(rest[in+4:], t.zeile)
				if err != nil {
					return nil, "", err
				}
				rumpf, ende, err := p.anweisungen()
				if err != nil {
					return nil, "", err
				}
				if ende != "endfor" {
					return nil, "", &jFehler{zeile: t.zeile, text: "{% for %} ohne {% endfor %}"}
				}
				p.pos++
				out = append(out, jFuer{name: name, ueber: ueber, rumpf: rumpf, zeile: t.zeile})
			default:
				return nil, "", &jFehler{zeile: t.zeile, text: "{% " + wort + " %} wird nicht unterstützt"}
			}
		}
	}
	return out, "", nil
}

func erstesWort(s string) (string, string) {
	s = strings.TrimSpace(s)
	i := strings.IndexAny(s, " \t\n")
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}

func istBezeichner(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// --- Ausdrücke -------------------------------------------------------------

type jToken struct {
	art   byte // 'n' Name, 'z' Zahl, 's' Text, 'o' Zeichen, 0 Ende
	text  string
	zeile int
}

func zerlegeAusdruck(s string, zeile int) ([]jToken, error) {
	var out []jToken
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '\n':
			zeile++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '\'' || c == '"':
			j := i + 1
			var b strings.Builder
			for j < len(s) && s[j] != c {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				b.WriteByte(s[j])
				j++
			}
			if j >= len(s) {
				return nil, &jFehler{zeile: zeile, text: "Text ohne schließendes Anführungszeichen"}
			}
			out = append(out, jToken{art: 's', text: b.String(), zeile: zeile})
			i = j + 1
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && ((s[j] >= '0' && s[j] <= '9') || s[j] == '.' || s[j] == '_') {
				j++
			}
			out = append(out, jToken{art: 'z', text: s[i:j], zeile: zeile})
			i = j
		case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			j := i
			for j < len(s) && (s[j] == '_' || (s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9')) {
				j++
			}
			out = append(out, jToken{art: 'n', text: s[i:j], zeile: zeile})
			i = j
		default:
			zwei := ""
			if i+1 < len(s) {
				zwei = s[i : i+2]
			}
			switch zwei {
			case "==", "!=", "<=", ">=", "//", "**":
				out = append(out, jToken{art: 'o', text: zwei, zeile: zeile})
				i += 2
				continue
			}
			if strings.IndexByte("+-*/%~<>()[]{},.|:=", c) < 0 {
				return nil, &jFehler{zeile: zeile, text: fmt.Sprintf("unbekanntes Zeichen „%c“", c)}
			}
			out = append(out, jToken{art: 'o', text: string(c), zeile: zeile})
			i++
		}
	}
	out = append(out, jToken{zeile: zeile})
	return out, nil
}

type aParser struct {
	t   []jToken
	pos int
}

func liesAusdruck(s string, zeile int) (jAusdruck, error) {
	toks, err := zerlegeAusdruck(s, zeile)
	if err != nil {
		return nil, err
	}
	p := &aParser{t: toks}
	e, err := p.wennAusdruck()
	if err != nil {
		return nil, err
	}
	if p.jetzt().art != 0 {
		return nil, p.fehler("unerwartet „" + p.jetzt().text + "“")
	}
	return e, nil
}

func (p *aParser) jetzt() jToken { return p.t[p.pos] }

func (p *aParser) ist(text string) bool {
	t := p.jetzt()
	return (t.art == 'o' || t.art == 'n') && t.text == text
}

func (p *aParser) nimm(text string) bool {
	if p.ist(text) {
		p.pos++
		return true
	}
	return false
}

func (p *aParser) erwarte(text string) error {
	if !p.nimm(text) {
		return p.fehler("„" + text + "“ erwartet")
	}
	return nil
}

func (p *aParser) fehler(text string) error {
	return &jFehler{zeile: p.jetzt().zeile, text: text}
}

func (p *aParser) wennAusdruck() (jAusdruck, error) {
	dann, err := p.oder()
	if err != nil {
		return nil, err
	}
	for p.ist("if") {
		p.pos++
		bed, err := p.oder()
		if err != nil {
			return nil, err
		}
		var sonst jAusdruck = jNichts{}
		if p.nimm("else") {
			sonst, err = p.wennAusdruck()
			if err != nil {
				return nil, err
			}
		}
		dann = jWennA{dann: dann, bed: bed, sonst: sonst}
	}
	return dann, nil
}

func (p *aParser) oder() (jAusdruck, error) {
	l, err := p.und()
	if err != nil {
		return nil, err
	}
	for p.nimm("or") {
		r, err := p.und()
		if err != nil {
			return nil, err
		}
		l = jBin{op: "or", l: l, r: r}
	}
	return l, nil
}

func (p *aParser) und() (jAusdruck, error) {
	l, err := p.nicht()
	if err != nil {
		return nil, err
	}
	for p.nimm("and") {
		r, err := p.nicht()
		if err != nil {
			return nil, err
		}
		l = jBin{op: "and", l: l, r: r}
	}
	return l, nil
}

func (p *aParser) nicht() (jAusdruck, error) {
	if p.nimm("not") {
		e, err := p.nicht()
		if err != nil {
			return nil, err
		}
		return jNicht{e: e}, nil
	}
	return p.vergleich()
}

func (p *aParser) vergleich() (jAusdruck, error) {
	l, err := p.summe()
	if err != nil {
		return nil, err
	}
	v := jVergleich{teile: []jAusdruck{l}}
	for {
		op := ""
		switch {
		case p.ist("==") || p.ist("!=") || p.ist("<") || p.ist("<=") || p.ist(">") || p.ist(">="):
			op = p.jetzt().text
			p.pos++
		case p.ist("in"):
			op = "in"
			p.pos++
		case p.ist("not") && p.pos+1 < len(p.t) && p.t[p.pos+1].text == "in":
			op = "not in"
			p.pos += 2
		}
		if op == "" {
			break
		}
		r, err := p.summe()
		if err != nil {
			return nil, err
		}
		v.ops = append(v.ops, op)
		v.teile = append(v.teile, r)
	}
	if len(v.ops) == 0 {
		return l, nil
	}
	return v, nil
}

func (p *aParser) summe() (jAusdruck, error) {
	l, err := p.verkettung()
	if err != nil {
		return nil, err
	}
	for p.ist("+") || p.ist("-") {
		op := p.jetzt().text
		p.pos++
		r, err := p.verkettung()
		if err != nil {
			return nil, err
		}
		l = jBin{op: op, l: l, r: r}
	}
	return l, nil
}

func (p *aParser) verkettung() (jAusdruck, error) {
	l, err := p.produkt()
	if err != nil {
		return nil, err
	}
	for p.nimm("~") {
		r, err := p.produkt()
		if err != nil {
			return nil, err
		}
		l = jBin{op: "~", l: l, r: r}
	}
	return l, nil
}

func (p *aParser) produkt() (jAusdruck, error) {
	l, err := p.potenz()
	if err != nil {
		return nil, err
	}
	for p.ist("*") || p.ist("/") || p.ist("//") || p.ist("%") {
		op := p.jetzt().text
		p.pos++
		r, err := p.potenz()
		if err != nil {
			return nil, err
		}
		l = jBin{op: op, l: l, r: r}
	}
	return l, nil
}

func (p *aParser) potenz() (jAusdruck, error) {
	l, err := p.vorzeichen(true)
	if err != nil {
		return nil, err
	}
	for p.nimm("**") {
		r, err := p.vorzeichen(true)
		if err != nil {
			return nil, err
		}
		l = jBin{op: "**", l: l, r: r}
	}
	return l, nil
}

func (p *aParser) vorzeichen(mitFilter bool) (jAusdruck, error) {
	var e jAusdruck
	var err error
	switch {
	case p.nimm("-"):
		e, err = p.vorzeichen(false)
		if err != nil {
			return nil, err
		}
		e = jNeg{e: e}
	case p.nimm("+"):
		e, err = p.vorzeichen(false)
		if err != nil {
			return nil, err
		}
	default:
		e, err = p.grund()
		if err != nil {
			return nil, err
		}
		e, err = p.nachsatz(e)
		if err != nil {
			return nil, err
		}
	}
	if mitFilter {
		return p.filter(e)
	}
	return e, nil
}

func (p *aParser) grund() (jAusdruck, error) {
	t := p.jetzt()
	switch t.art {
	case 'z':
		p.pos++
		v, err := strconv.ParseFloat(strings.ReplaceAll(t.text, "_", ""), 64)
		if err != nil {
			return nil, &jFehler{zeile: t.zeile, text: "Zahl „" + t.text + "“ nicht lesbar"}
		}
		return jZahl{v: v, ganz: !strings.Contains(t.text, ".")}, nil
	case 's':
		p.pos++
		s := t.text
		// benachbarte Texte werden verbunden ('a' 'b')
		for p.jetzt().art == 's' {
			s += p.jetzt().text
			p.pos++
		}
		return jTextWert{s: s}, nil
	case 'n':
		p.pos++
		switch t.text {
		case "true", "True":
			return jWahr{b: true}, nil
		case "false", "False":
			return jWahr{b: false}, nil
		case "none", "None":
			return jNichts{}, nil
		}
		return jName{n: t.text}, nil
	case 'o':
		switch t.text {
		case "(":
			p.pos++
			if p.nimm(")") {
				return jListe{}, nil
			}
			e, err := p.wennAusdruck()
			if err != nil {
				return nil, err
			}
			if p.ist(",") {
				// Tupel: wie eine Liste
				el := []jAusdruck{e}
				for p.nimm(",") {
					if p.ist(")") {
						break
					}
					x, err := p.wennAusdruck()
					if err != nil {
						return nil, err
					}
					el = append(el, x)
				}
				e = jListe{el: el}
			}
			return e, p.erwarte(")")
		case "[":
			p.pos++
			var el []jAusdruck
			for !p.ist("]") {
				x, err := p.wennAusdruck()
				if err != nil {
					return nil, err
				}
				el = append(el, x)
				if !p.nimm(",") {
					break
				}
			}
			return jListe{el: el}, p.erwarte("]")
		case "{":
			return nil, p.fehler("Wörterbücher ({…}) werden nicht unterstützt")
		}
	}
	if t.art == 0 {
		return nil, p.fehler("Ausdruck endet zu früh")
	}
	return nil, p.fehler("unerwartet „" + t.text + "“")
}

func (p *aParser) nachsatz(e jAusdruck) (jAusdruck, error) {
	for {
		switch {
		case p.ist("."):
			p.pos++
			t := p.jetzt()
			if t.art != 'n' && t.art != 'z' {
				return nil, p.fehler("Name nach „.“ erwartet")
			}
			p.pos++
			e = jAttr{e: e, name: t.text}
		case p.ist("["):
			p.pos++
			i, err := p.wennAusdruck()
			if err != nil {
				return nil, err
			}
			if err := p.erwarte("]"); err != nil {
				return nil, err
			}
			e = jIndex{e: e, i: i}
		case p.ist("("):
			p.pos++
			a := jAufruf{f: e}
			args, kwargs, err := p.argumente()
			if err != nil {
				return nil, err
			}
			a.args, a.kwargs = args, kwargs
			e = a
		default:
			return e, nil
		}
	}
}

// argumente liest bis zur schließenden Klammer (die öffnende ist schon gelesen).
func (p *aParser) argumente() ([]jAusdruck, map[string]jAusdruck, error) {
	var args []jAusdruck
	var kw map[string]jAusdruck
	for !p.ist(")") {
		if p.jetzt().art == 'n' && p.pos+1 < len(p.t) && p.t[p.pos+1].text == "=" {
			name := p.jetzt().text
			p.pos += 2
			x, err := p.wennAusdruck()
			if err != nil {
				return nil, nil, err
			}
			if kw == nil {
				kw = map[string]jAusdruck{}
			}
			kw[name] = x
		} else {
			x, err := p.wennAusdruck()
			if err != nil {
				return nil, nil, err
			}
			args = append(args, x)
		}
		if !p.nimm(",") {
			break
		}
	}
	return args, kw, p.erwarte(")")
}

func (p *aParser) filter(e jAusdruck) (jAusdruck, error) {
	for {
		switch {
		case p.ist("|"):
			p.pos++
			t := p.jetzt()
			if t.art != 'n' {
				return nil, p.fehler("Filtername erwartet")
			}
			p.pos++
			f := jFilter{e: e, name: t.text}
			if p.nimm("(") {
				args, _, err := p.argumente()
				if err != nil {
					return nil, err
				}
				f.args = args
			}
			e = f
		case p.ist("is"):
			p.pos++
			te := jTest{e: e}
			if p.nimm("not") {
				te.nicht = true
			}
			t := p.jetzt()
			if t.art != 'n' {
				return nil, p.fehler("Name eines Tests erwartet")
			}
			p.pos++
			te.name = t.text
			if p.nimm("(") {
				args, _, err := p.argumente()
				if err != nil {
					return nil, err
				}
				te.args = args
			}
			e = te
		default:
			return e, nil
		}
	}
}
