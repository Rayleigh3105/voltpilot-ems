package homeassistant

// Der Formelbaum der Übersetzung: was eine Vorlage, eine Bedingung oder ein Auslöser
// von Home Assistant in der Formelsprache der Steuerlogik bedeutet (Vertrag
// docs/contracts/v2/steuerlogik.md, "Werte und Rechnen"). Zahlen tragen eine Größe;
// Home Assistant kennt keine Einheiten, die Größe einer festen Zahl ergibt sich deshalb
// erst aus dem, womit sie verglichen oder verrechnet wird ("0 - netz" ist 0 kW,
// "ziel - 3" ist 3 K). Dafür trägt jede Zahl eine Größenvariable, die beim Rechnen mit
// anderen vereinigt wird; gedruckt wird erst, wenn alles gelesen ist.

import (
	"math"
	"strconv"
	"strings"
)

// Groessen der Formelsprache.
const (
	gOffen     = ""        // noch nicht bestimmt
	gZahl      = "zahl"    // ohne Einheit
	gTemp      = "temp"    // °C
	gAbstand   = "abstand" // K, Abstand zweier Temperaturen
	gLeistung  = "leistung"
	gProzent   = "prozent"
	gDauer     = "dauer"
	gWinkel    = "winkel"
	gUhrzeit   = "uhrzeit"
	gJaNein    = "ja_nein"
	gUnbekannt = "?" // widersprüchlich
)

// groesse ist eine Größenvariable (Vereinigungsmenge).
type groesse struct {
	eltern *groesse
	g      string
	// ha ist die Einheit, in der Home Assistant die Zahl meint: W, kW, °C, K, %, °, s, min, h.
	ha string
	// abstandVon: diese Größe ist der Abstand zu jener (Temperatur ± Zahl: die Zahl ist ein Abstand).
	abstandVon *groesse
}

func neueGroesse(g, ha string) *groesse { return &groesse{g: g, ha: ha} }

func (q *groesse) wurzel() *groesse {
	for q.eltern != nil {
		q = q.eltern
	}
	return q
}

// vereinige macht zwei Größen zu einer; widersprechen sie sich, wird sie unbekannt.
func vereinige(a, b *groesse) {
	if a == nil || b == nil {
		return
	}
	ra, rb := a.wurzel(), b.wurzel()
	if ra == rb {
		return
	}
	g, ha := ra.g, ra.ha
	switch {
	case g == gOffen:
		g, ha = rb.g, rb.ha
	case rb.g == gOffen || rb.g == g:
		if ha == "" {
			ha = rb.ha
		}
	default:
		// Leistung in W und kW sind dieselbe Größe; Dauern in verschiedenen Einheiten auch.
		g = gUnbekannt
	}
	if ra.abstandVon == nil {
		ra.abstandVon = rb.abstandVon
	}
	rb.eltern = ra
	ra.g, ra.ha = g, ha
}

// art ist die Größe, soweit bestimmt (gOffen, wenn noch nicht).
func (q *groesse) art() string {
	if q == nil {
		return gZahl
	}
	r := q.wurzel()
	if r.g == gOffen && r.abstandVon != nil {
		if g := r.abstandVon.art(); g == gTemp {
			return gAbstand
		} else if g != gOffen {
			return g
		}
	}
	return r.g
}

// aufgeloest nennt Größe und Einheit von Home Assistant.
func (q *groesse) aufgeloest() (string, string) {
	if q == nil {
		return gZahl, ""
	}
	r := q.wurzel()
	if r.g == gOffen && r.abstandVon != nil {
		g, ha := r.abstandVon.aufgeloest()
		if g == gTemp {
			return gAbstand, "K"
		}
		return g, ha
	}
	if r.g == gOffen {
		return gZahl, ""
	}
	return r.g, r.ha
}

// ir ist ein Knoten des Formelbaums.
type ir struct {
	art    byte // z Zahl, w Ja/Nein, u Uhrzeit, r Name, k clock, n Vorzeichen, b Rechnen, v Vergleich, a und, o oder, x nicht, c Aufruf, A Ausgang an, H Laufzeit eines Ausgangs
	v      float64
	b      bool
	text   string // Name, Rechenzeichen, Vergleich, Funktion, Uhrzeit "HH:MM"
	q      *groesse
	kinder []*ir
}

func zahl(v float64, q *groesse) *ir {
	if q == nil {
		q = neueGroesse(gOffen, "")
	}
	return &ir{art: 'z', v: v, q: q}
}

func wahr(b bool) *ir               { return &ir{art: 'w', b: b} }
func name(n string, q *groesse) *ir { return &ir{art: 'r', text: n, q: q} }
func aufruf(f string, q *groesse, a ...*ir) *ir {
	return &ir{art: 'c', text: f, q: q, kinder: a}
}

func (e *ir) istWahr(b bool) bool { return e != nil && e.art == 'w' && e.b == b }

func (e *ir) istZahl(v float64) bool { return e != nil && e.art == 'z' && e.v == v }

func (e *ir) groesse() *groesse {
	if e == nil {
		return nil
	}
	switch e.art {
	case 'w', 'v', 'a', 'o', 'x', 'A':
		return neueGroesse(gJaNein, "")
	case 'k', 'u':
		return neueGroesse(gUhrzeit, "")
	}
	return e.q
}

// --- Bauen mit Vereinfachung -------------------------------------------------

func und(xs ...*ir) *ir {
	var out []*ir
	gesehen := map[string]bool{}
	for _, x := range xs {
		if x == nil {
			continue
		}
		if x.istWahr(true) {
			continue
		}
		if x.istWahr(false) {
			return wahr(false)
		}
		teile := []*ir{x}
		if x.art == 'a' {
			teile = x.kinder
		}
		for _, t := range teile {
			s := t.String()
			if !gesehen[s] {
				gesehen[s] = true
				out = append(out, t)
			}
		}
	}
	out = absorbiere(out, 'o', gesehen)
	switch len(out) {
	case 0:
		return wahr(true)
	case 1:
		return out[0]
	}
	return &ir{art: 'a', kinder: out}
}

// absorbiere: (a oder b) und a ist a; (a und b) oder a ist a.
func absorbiere(teile []*ir, innen byte, gesehen map[string]bool) []*ir {
	var out []*ir
	for _, t := range teile {
		weg := false
		if t.art == innen {
			for _, k := range t.kinder {
				if gesehen[k.String()] {
					weg = true
					break
				}
			}
		}
		if !weg {
			out = append(out, t)
		}
	}
	return out
}

func oder(xs ...*ir) *ir {
	var out []*ir
	gesehen := map[string]bool{}
	for _, x := range xs {
		if x == nil {
			continue
		}
		if x.istWahr(false) {
			continue
		}
		if x.istWahr(true) {
			return wahr(true)
		}
		teile := []*ir{x}
		if x.art == 'o' {
			teile = x.kinder
		}
		for _, t := range teile {
			s := t.String()
			if !gesehen[s] {
				gesehen[s] = true
				out = append(out, t)
			}
		}
	}
	out = absorbiere(out, 'a', gesehen)
	switch len(out) {
	case 0:
		return wahr(false)
	case 1:
		return out[0]
	}
	return &ir{art: 'o', kinder: out}
}

func nicht(x *ir) *ir {
	switch {
	case x.art == 'w':
		return wahr(!x.b)
	case x.art == 'x':
		return x.kinder[0]
	case x.art == 'c' && x.text == "known":
		return aufruf("unknown", nil, x.kinder...)
	case x.art == 'c' && x.text == "unknown":
		return aufruf("known", nil, x.kinder...)
	}
	return &ir{art: 'x', kinder: []*ir{x}}
}

func vergleiche(op string, l, r *ir) *ir {
	if l.art == 'z' && r.art == 'z' {
		return wahr(vergleicheZahlen(op, l.v, r.v))
	}
	if l.art == 'u' && r.art == 'u' {
		return wahr(vergleicheZahlen(op, uhrMinuten(l.text), uhrMinuten(r.text)))
	}
	vereinige(l.groesse(), r.groesse())
	return &ir{art: 'v', text: op, kinder: []*ir{l, r}}
}

func vergleicheZahlen(op string, a, b float64) bool {
	switch op {
	case "<":
		return a < b
	case "<=":
		return a <= b
	case ">":
		return a > b
	case ">=":
		return a >= b
	case "==":
		return a == b
	}
	return a != b
}

// umgekehrt ist der Vergleich mit getauschten Seiten.
func umgekehrt(op string) string {
	return map[string]string{"<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!="}[op]
}

func neg(x *ir) *ir {
	switch x.art {
	case 'z':
		return zahl(-x.v, x.q)
	case 'n':
		return x.kinder[0]
	}
	return &ir{art: 'n', q: x.q, kinder: []*ir{x}}
}

// rechne baut + - * / mit Größen: Temperatur ± Zahl macht die Zahl zum Abstand,
// Temperatur - Temperatur ist ein Abstand; mal und geteilt nur mit einer Zahl ohne Einheit.
func rechne(op string, l, r *ir) *ir {
	if l.art == 'z' && r.art == 'z' && (op == "*" || op == "/") {
		// zwei feste Zahlen: die Größe trägt die erste
		v := l.v * r.v
		if op == "/" {
			v = l.v / r.v
		}
		return zahl(v, l.q)
	}
	switch op {
	case "+", "-":
		lq, rq := l.groesse(), r.groesse()
		var q *groesse
		switch {
		case l.art == 'z' && r.art != 'z':
			l.q.wurzel().abstandVon = rq
			q = rq
		case r.art == 'z' && l.art != 'z':
			r.q.wurzel().abstandVon = lq
			q = lq
		default:
			lg, rg := lq.art(), rq.art()
			switch {
			case op == "-" && (lg == gTemp && (rg == gTemp || rg == gOffen) || rg == gTemp && lg == gOffen):
				// Temperatur - Temperatur ist ein Abstand
				vereinige(lq, rq)
				q = neueGroesse(gAbstand, "K")
			case lg == gTemp && rg == gAbstand, lg == gAbstand && rg == gTemp:
				q = neueGroesse(gTemp, "°C")
			case lg == gTemp && rg == gOffen:
				rq.wurzel().abstandVon = lq
				q = lq
			case rg == gTemp && lg == gOffen:
				lq.wurzel().abstandVon = rq
				q = rq
			default:
				vereinige(lq, rq)
				q = lq
			}
		}
		switch {
		case op == "+" && l.istZahl(0):
			return r
		case r.istZahl(0):
			return l
		case op == "-" && l.istZahl(0):
			return neg(r)
		case r.art == 'n':
			andere := "+"
			if op == "+" {
				andere = "-"
			}
			return &ir{art: 'b', text: andere, q: q, kinder: []*ir{l, r.kinder[0]}}
		case op == "+" && l.art == 'n':
			return &ir{art: 'b', text: "-", q: q, kinder: []*ir{r, l.kinder[0]}}
		}
		return &ir{art: 'b', text: op, q: q, kinder: []*ir{l, r}}
	}
	// mal und geteilt
	q := l.groesse()
	if l.art == 'z' {
		q = r.groesse()
		l.q = neueGroesse(gZahl, "")
	} else if r.art == 'z' {
		r.q = neueGroesse(gZahl, "")
	} else {
		lg, _ := l.groesse().aufgeloest()
		rg, _ := r.groesse().aufgeloest()
		if lg != gZahl && rg != gZahl {
			q = neueGroesse(gUnbekannt, "")
		} else if lg == gZahl {
			q = r.groesse()
		}
	}
	if r.istZahl(1) {
		return l
	}
	if op == "*" && l.istZahl(1) {
		return r
	}
	return &ir{art: 'b', text: op, q: q, kinder: []*ir{l, r}}
}

func wenn(c, a, b *ir) *ir {
	switch {
	case c.istWahr(true):
		return a
	case c.istWahr(false):
		return b
	case a.String() == b.String():
		return a
	}
	if a.art == 'w' && b.art == 'w' {
		if a.b {
			return c
		}
		return nicht(c)
	}
	vereinige(a.groesse(), b.groesse())
	return &ir{art: 'c', text: "if", q: a.groesse(), kinder: []*ir{c, a, b}}
}

func minMax(f string, a, b *ir) *ir {
	if a.art == 'z' && b.art == 'z' {
		if f == "min" {
			return zahl(math.Min(a.v, b.v), a.q)
		}
		return zahl(math.Max(a.v, b.v), a.q)
	}
	if a.String() == b.String() {
		return a
	}
	vereinige(a.groesse(), b.groesse())
	return aufruf(f, a.groesse(), a, b)
}

// --- Drucken -----------------------------------------------------------------

func rang(e *ir) int {
	switch e.art {
	case 'o':
		return 1
	case 'a':
		return 2
	case 'x':
		return 3
	case 'v':
		return 4
	case 'b':
		if e.text == "+" || e.text == "-" {
			return 5
		}
		return 6
	case 'n':
		return 7
	}
	return 8
}

func (e *ir) String() string {
	var b strings.Builder
	e.schreibe(&b)
	return b.String()
}

func (e *ir) schreibe(b *strings.Builder) {
	kind := func(k *ir, mindest int) {
		if rang(k) < mindest {
			b.WriteString("(")
			k.schreibe(b)
			b.WriteString(")")
			return
		}
		k.schreibe(b)
	}
	switch e.art {
	case 'z':
		b.WriteString(zahlText(e.v, e.q))
	case 'w':
		if e.b {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case 'u':
		b.WriteString(`"` + e.text + `"`)
	case 'k':
		b.WriteString("clock")
	case 'r':
		b.WriteString(e.text)
	case 'A':
		b.WriteString("«Ausgang " + e.text + " " + strconv.Itoa(int(e.v)) + "»")
	case 'H':
		b.WriteString("«Laufzeit " + e.text + " " + strconv.Itoa(int(e.v)) + "»")
	case 'n':
		b.WriteString("-")
		kind(e.kinder[0], 8)
	case 'b':
		r := rang(e)
		kind(e.kinder[0], r)
		b.WriteString(" " + e.text + " ")
		kind(e.kinder[1], r+1)
	case 'v':
		kind(e.kinder[0], 5)
		b.WriteString(" " + e.text + " ")
		kind(e.kinder[1], 5)
	case 'a', 'o':
		wort := " and "
		if e.art == 'o' {
			wort = " or "
		}
		for i, k := range e.kinder {
			if i > 0 {
				b.WriteString(wort)
			}
			kind(k, rang(e)+1)
		}
	case 'x':
		b.WriteString("not ")
		kind(e.kinder[0], 5)
	case 'c':
		b.WriteString(e.text + "(")
		for i, k := range e.kinder {
			if i > 0 {
				b.WriteString(", ")
			}
			k.schreibe(b)
		}
		b.WriteString(")")
	}
}

// zahlText schreibt eine feste Zahl mit der Einheit ihrer Größe, wie Home Assistant sie meint
// (300 W bleibt 300 W; der Kern rechnet W in kW um).
func zahlText(v float64, q *groesse) string {
	g, ha := q.aufgeloest()
	s := zahlOhneEinheit(v)
	switch g {
	case gTemp:
		return s + " °C"
	case gAbstand:
		return s + " K"
	case gLeistung:
		if ha == "kW" {
			return s + " kW"
		}
		return s + " W"
	case gProzent:
		return s + " %"
	case gWinkel:
		return s + "°"
	case gDauer:
		return dauerText(v, ha)
	}
	return s
}

func zahlOhneEinheit(v float64) string {
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// dauerText schreibt eine Dauer in der Einheit, in der Home Assistant sie meint.
func dauerText(v float64, ha string) string {
	switch ha {
	case "min", "h":
		return zahlOhneEinheit(v) + " " + ha
	}
	return sekundenText(v)
}

// sekundenText schreibt Sekunden in der größten Einheit, die aufgeht.
func sekundenText(s float64) string {
	switch {
	case s != 0 && math.Mod(s, 3600) == 0:
		return zahlOhneEinheit(s/3600) + " h"
	case s != 0 && math.Mod(s, 60) == 0:
		return zahlOhneEinheit(s/60) + " min"
	}
	return zahlOhneEinheit(s) + " s"
}

func uhrMinuten(t string) float64 {
	teile := strings.Split(t, ":")
	if len(teile) < 2 {
		return -1
	}
	h, _ := strconv.Atoi(teile[0])
	m, _ := strconv.Atoi(teile[1])
	return float64(h*60 + m)
}

// besuche ruft f für jeden Knoten (vor seinen Kindern).
func (e *ir) besuche(f func(*ir)) {
	if e == nil {
		return
	}
	f(e)
	for _, k := range e.kinder {
		k.besuche(f)
	}
}
