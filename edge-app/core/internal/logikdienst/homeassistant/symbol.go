package homeassistant

// Deuten einer Vorlage: aus dem Baum von jinja.go wird ein Formelbaum (ausdruck.go). Jede
// Entität wird über die Symboltafel des Übersetzers zu einem Namen der Logik (Stellwert,
// Zustand, Formel, Eingang) oder zu einem Ausgang eines Geräts. Gerechnet wird nicht mit
// Werten, sondern mit Formeln: {% if %} wird zu if(), eine Schleife über range() wird
// ausgerollt, ein namespace wird zu Variablen, die nach jeder Verzweigung zusammengeführt
// werden.

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// nichtUebersetzbar bricht das Deuten einer Vorlage ab (über panic, gefangen in werte).
type nichtUebersetzbar struct {
	zeile int // in der Vorlage, ab 0
	grund string
}

type wert struct {
	art byte // z Zahl/Uhrzeit, b Ja/Nein, t Text, l Liste, s Zustand einer Entität, e Zustandsobjekt, d Bereich von states, c letzter Wechsel, j jetzt, D Dauer seit dem Wechsel, h this, N namespace, 0 nichts
	e   *ir
	// text: Text, Kennung der Entität, Bereich
	text string
	el   []element
	// vorgabe: Home Assistant rechnet ohne Wert mit dieser Zahl (|float(-1)); fehlbar ist
	// der Eingang, der fehlen kann.
	vorgabe *float64
	fehlbar *ir
	// anzahl: die Bedingungen der Elemente einer gezählten Liste (L|count)
	anzahl []*ir
	// felder eines namespace
	felder map[string]wert
}

type element struct {
	id  int
	bed *ir
	w   wert
}

type umgebung map[string]wert

func (u umgebung) kopie() umgebung {
	k := make(umgebung, len(u))
	for n, w := range u {
		k[n] = w
	}
	return k
}

type ausgabe struct {
	bed  *ir // Bedingung des Pfads (bei vollständigen Verzweigungen nur die genommenen)
	pfad string
	w    wert
}

type auswerter struct {
	u     *uebersetzer
	ort   Ort // Datei und erste Zeile der Vorlage
	zeile int // aktuelle Zeile in der Vorlage
	// this: der eigene Wert eines Vorlagen-Binärsensors ("on"/"off"), sonst leer
	this string
	// formeln: zugewiesene Variablen, die mehrfach vorkommen, werden Formeln
	mehrfach map[string]bool
	tiefe    int
	ausgaben []ausgabe
	naechste *int
	// offen: Hinweise auf Ersatzwerte von Home Assistant, die ein known()/unknown() daneben
	// noch überflüssig machen kann
	offen []offenerHinweis
}

type offenerHinweis struct {
	fehlbar string
	vorgabe float64
	cmp     *ir
	ort     Ort
}

// deckt: e ist wort(f) oder eine Verknüpfung (und für known, oder für unknown), die es enthält.
func deckt(e *ir, wort, f string) bool {
	ist := func(x *ir) bool {
		return x.art == 'c' && x.text == wort && len(x.kinder) == 1 && x.kinder[0].art == 'r' && x.kinder[0].text == f
	}
	if ist(e) {
		return true
	}
	verbund := byte('a')
	if wort == "unknown" {
		verbund = 'o'
	}
	if e.art == verbund {
		for _, k := range e.kinder {
			if ist(k) {
				return true
			}
		}
	}
	return false
}

func enthaelt(e, knoten *ir) bool {
	gefunden := false
	e.besuche(func(x *ir) {
		if x == knoten {
			gefunden = true
		}
	})
	return gefunden
}

// streiche: ein Vergleich, neben dem known(x) (bei und) oder unknown(x) (bei oder) steht,
// rechnet nie mit dem Ersatzwert.
func (a *auswerter) streiche(op string, l, r *ir) {
	wort := "known"
	if op == "or" {
		wort = "unknown"
	}
	var bleiben []offenerHinweis
	for _, o := range a.offen {
		if (deckt(l, wort, o.fehlbar) && enthaelt(r, o.cmp)) || (deckt(r, wort, o.fehlbar) && enthaelt(l, o.cmp)) {
			continue
		}
		bleiben = append(bleiben, o)
	}
	a.offen = bleiben
}

func (a *auswerter) stopp(f string, args ...any) {
	panic(nichtUebersetzbar{zeile: a.zeile, grund: fmt.Sprintf(f, args...)})
}

// deute wertet eine Vorlage aus und liefert ihre Ausgaben je Pfad.
func (a *auswerter) deute(v *Vorlage, env umgebung) (aus []ausgabe, fehler *nichtUebersetzbar) {
	defer func() {
		if r := recover(); r != nil {
			if f, ok := r.(nichtUebersetzbar); ok {
				fehler = &f
				return
			}
			panic(r)
		}
	}()
	a.mehrfach = zaehleNamen(v.rumpf)
	if env == nil {
		env = umgebung{}
	}
	a.lauf(v.rumpf, env, nil, "")
	a.u.offen = append(a.u.offen, a.offen...)
	return a.ausgaben, nil
}

// zaehleNamen nennt die Variablen, die eine Vorlage mehr als einmal liest.
func zaehleNamen(rumpf []jKnoten) map[string]bool {
	n := map[string]int{}
	var ausdruck func(e jAusdruck)
	ausdruck = func(e jAusdruck) {
		switch x := e.(type) {
		case jName:
			n[x.n]++
		case jBin:
			ausdruck(x.l)
			ausdruck(x.r)
		case jVergleich:
			for _, t := range x.teile {
				ausdruck(t)
			}
		case jNicht:
			ausdruck(x.e)
		case jNeg:
			ausdruck(x.e)
		case jWennA:
			ausdruck(x.dann)
			ausdruck(x.bed)
			ausdruck(x.sonst)
		case jAttr:
			ausdruck(x.e)
		case jIndex:
			ausdruck(x.e)
			ausdruck(x.i)
		case jAufruf:
			ausdruck(x.f)
			for _, y := range x.args {
				ausdruck(y)
			}
			for _, y := range x.kwargs {
				ausdruck(y)
			}
		case jFilter:
			ausdruck(x.e)
			for _, y := range x.args {
				ausdruck(y)
			}
		case jTest:
			ausdruck(x.e)
		case jListe:
			for _, y := range x.el {
				ausdruck(y)
			}
		}
	}
	var knoten func(ks []jKnoten)
	knoten = func(ks []jKnoten) {
		for _, k := range ks {
			switch x := k.(type) {
			case jAusgabe:
				ausdruck(x.e)
			case jSetze:
				ausdruck(x.e)
			case jWenn:
				for _, z := range x.zweige {
					ausdruck(z.bed)
					knoten(z.rumpf)
				}
				knoten(x.sonst)
			case jFuer:
				ausdruck(x.ueber)
				knoten(x.rumpf)
			}
		}
	}
	knoten(rumpf)
	out := map[string]bool{}
	for k, c := range n {
		if c > 1 {
			out[k] = true
		}
	}
	return out
}

func pfadText(bed []*ir) string {
	var s []string
	for _, b := range bed {
		s = append(s, b.String())
	}
	return strings.Join(s, " ∧ ")
}

// lauf geht die Anweisungen durch; liefert, ob jeder Pfad etwas ausgegeben hat.
func (a *auswerter) lauf(ks []jKnoten, env umgebung, bed []*ir, pfad string) bool {
	alle := false
	for _, k := range ks {
		switch x := k.(type) {
		case jText:
			t := strings.TrimSpace(x.text)
			if t == "" {
				continue
			}
			a.gib(wert{art: 't', text: t}, bed, pfad)
			alle = true
		case jAusgabe:
			a.zeile = x.zeile
			a.gib(a.aus(x.e, env), bed, pfad)
			alle = true
		case jSetze:
			a.zeile = x.zeile
			w := a.aus(x.e, env)
			if x.attr != "" {
				if _, ok := env[x.name]; !ok || env[x.name].art != 'N' {
					a.stopp("„%s“ ist kein namespace", x.name)
				}
				env[x.name+"."+x.attr] = w
				continue
			}
			if w.art == 'N' {
				env[x.name] = wert{art: 'N'}
				for k, v := range w.felder {
					env[x.name+"."+k] = v
				}
				continue
			}
			if a.tiefe == 0 && a.mehrfach[x.name] {
				w = a.u.alsFormel(x.name, w, a.ortJetzt())
			}
			env[x.name] = w
		case jWenn:
			a.zeile = x.zeile
			alle = a.wenn(x, env, bed, pfad) || alle
		case jFuer:
			a.zeile = x.zeile
			ueber := a.aus(x.ueber, env)
			if ueber.art != 'l' {
				a.stopp("Schleife nur über range() oder eine Liste")
			}
			a.tiefe++
			for _, el := range ueber.el {
				innen := env.kopie()
				innen[x.name] = el.w
				ibed := bed
				if !el.bed.istWahr(true) {
					ibed = append(append([]*ir{}, bed...), el.bed)
				}
				a.lauf(x.rumpf, innen, ibed, pfad+"|for")
				// Nur namespace-Werte überleben eine Schleife (wie in jinja2).
				for n, w := range innen {
					if strings.Contains(n, ".") {
						if el.bed.istWahr(true) {
							env[n] = w
						} else {
							env[n] = a.misch(el.bed, w, env[n])
						}
					}
				}
			}
			a.tiefe--
		}
	}
	return alle
}

func (a *auswerter) wenn(x jWenn, env umgebung, bed []*ir, pfad string) bool {
	type zweig struct {
		c   *ir
		env umgebung
	}
	var zweige []zweig
	var negationen []*ir
	vorherAlle := true
	gesamt := true
	sonstErreichbar := true
	for i, z := range x.zweige {
		c := a.wahrheit(a.aus(z.bed, env))
		if c.istWahr(false) {
			continue
		}
		innen := env.kopie()
		zbed := append([]*ir{}, bed...)
		if !vorherAlle {
			zbed = append(zbed, negationen...)
		}
		if !c.istWahr(true) {
			zbed = append(zbed, c)
		}
		a.tiefe++
		ok := a.lauf(z.rumpf, innen, zbed, fmt.Sprintf("%s|%d.%d", pfad, x.zeile, i))
		a.tiefe--
		vorherAlle = vorherAlle && ok
		gesamt = gesamt && ok
		zweige = append(zweige, zweig{c: c, env: innen})
		negationen = append(negationen, nicht(c))
		if c.istWahr(true) {
			sonstErreichbar = false
			break
		}
	}
	sonst := env.kopie()
	if sonstErreichbar {
		zbed := append([]*ir{}, bed...)
		if !vorherAlle {
			zbed = append(zbed, negationen...)
		}
		a.tiefe++
		ok := a.lauf(x.sonst, sonst, zbed, fmt.Sprintf("%s|%d.sonst", pfad, x.zeile))
		a.tiefe--
		gesamt = gesamt && ok
	}
	// Variablen zusammenführen: von hinten, wie die Kette der Zweige
	namen := map[string]bool{}
	for _, z := range zweige {
		for n := range z.env {
			namen[n] = true
		}
	}
	for n := range sonst {
		namen[n] = true
	}
	for n := range namen {
		var w wert
		var hat bool
		if sonstErreichbar {
			w, hat = sonst[n]
		}
		for i := len(zweige) - 1; i >= 0; i-- {
			wz, ok := zweige[i].env[n]
			switch {
			case !ok:
				continue
			case !hat:
				w, hat = wz, true
			default:
				w = a.misch(zweige[i].c, wz, w)
			}
		}
		if hat {
			env[n] = w
		}
	}
	return gesamt && (sonstErreichbar || len(zweige) > 0)
}

func (a *auswerter) gib(w wert, bed []*ir, pfad string) {
	a.ausgaben = append(a.ausgaben, ausgabe{bed: und(bed...), pfad: pfad, w: w})
}

func (a *auswerter) ortJetzt() Ort {
	return Ort{Datei: a.ort.Datei, Zeile: a.ort.Zeile + a.zeile}
}

// misch führt zwei Werte nach einer Bedingung zusammen: wenn c, dann x, sonst y.
func (a *auswerter) misch(c *ir, x, y wert) wert {
	switch {
	case x.art == 'l' && y.art == 'l':
		// eine Liste wächst in einem Zweig: die neuen Elemente gelten nur in ihm
		if len(x.el) >= len(y.el) {
			gleich := true
			for i := range y.el {
				if x.el[i].id != y.el[i].id {
					gleich = false
					break
				}
			}
			if gleich {
				out := append([]element{}, y.el...)
				for _, e := range x.el[len(y.el):] {
					out = append(out, element{id: e.id, bed: und(c, e.bed), w: e.w})
				}
				return wert{art: 'l', el: out}
			}
		}
		a.stopp("eine Liste ändert sich in einer Verzweigung auf eine Weise, die sich nicht übersetzen lässt")
	case x.art == 'z' && y.art == 'z':
		// x = y + d: die Summe wächst nur im Zweig (Zähler in einer Schleife)
		if x.e.art == 'b' && x.e.text == "+" && x.e.kinder[0].String() == y.e.String() {
			d := x.e.kinder[1]
			return wert{art: 'z', e: rechne("+", y.e, wenn(c, d, zahl(0, d.groesse())))}
		}
		return wert{art: 'z', e: wenn(c, x.e, y.e)}
	case x.art == 'b' && y.art == 'b':
		return wert{art: 'b', e: wenn(c, x.e, y.e)}
	case x.art == 't' && y.art == 't' && x.text == y.text:
		return x
	case x.art == 'N' && y.art == 'N':
		return x
	case x.art == 'z' && y.art == 'b', x.art == 'b' && y.art == 'z':
		a.stopp("ein Wert ist in einem Zweig eine Zahl und im anderen Ja/Nein")
	}
	if x.art == y.art && x.art != 't' && x.art != 'l' {
		return x
	}
	a.stopp("Werte verschiedener Art in Verzweigungen lassen sich nicht übersetzen")
	return wert{}
}

// wahrheit macht aus einem Wert eine Bedingung.
func (a *auswerter) wahrheit(w wert) *ir {
	switch w.art {
	case 'b':
		return w.e
	case 't':
		switch strings.ToLower(w.text) {
		case "true", "on", "yes", "1":
			return wahr(true)
		case "false", "off", "no", "0", "":
			return wahr(false)
		}
		return wahr(w.text != "")
	case '0':
		return wahr(false)
	case 'l':
		if len(w.el) == 0 {
			return wahr(false)
		}
		var b []*ir
		for _, e := range w.el {
			b = append(b, e.bed)
		}
		return oder(b...)
	}
	a.stopp("dieser Wert ist keine Bedingung")
	return nil
}

func (a *auswerter) zahlWert(w wert) *ir {
	switch w.art {
	case 'z':
		return w.e
	case 't':
		if v, err := strconv.ParseFloat(strings.TrimSpace(w.text), 64); err == nil {
			return zahl(v, nil)
		}
	case 'b':
		a.stopp("mit Ja/Nein wird nicht gerechnet")
	case 's':
		a.stopp("der Zustand von %s ist Text; Zahlen brauchen |float oder |int", w.text)
	}
	a.stopp("hier wird eine Zahl erwartet")
	return nil
}

// aus wertet einen Ausdruck aus.
func (a *auswerter) aus(e jAusdruck, env umgebung) wert {
	switch x := e.(type) {
	case jZahl:
		return wert{art: 'z', e: zahl(x.v, nil)}
	case jTextWert:
		return wert{art: 't', text: x.s}
	case jWahr:
		return wert{art: 'b', e: wahr(x.b)}
	case jNichts:
		return wert{art: '0'}
	case jListe:
		var el []element
		for _, y := range x.el {
			el = append(el, a.element(wahr(true), a.aus(y, env)))
		}
		return wert{art: 'l', el: el}
	case jName:
		if w, ok := env[x.n]; ok {
			return w
		}
		switch x.n {
		case "states":
			return wert{art: 'd'}
		case "this":
			return wert{art: 'h'}
		}
		a.stopp("unbekannter Name „%s“", x.n)
	case jAttr:
		if n, ok := x.e.(jName); ok {
			if w, ok := env[n.n]; ok && w.art == 'N' {
				v, ok := env[n.n+"."+x.name]
				if !ok {
					a.stopp("%s.%s ist nicht gesetzt", n.n, x.name)
				}
				return v
			}
		}
		basis := a.aus(x.e, env)
		switch basis.art {
		case 'd':
			if basis.text == "" {
				return wert{art: 'd', text: x.name}
			}
			return wert{art: 'e', text: basis.text + "." + x.name}
		case 'e':
			switch x.name {
			case "state":
				return wert{art: 's', text: basis.text}
			case "last_changed", "last_updated", "last_reported":
				return wert{art: 'c', text: basis.text}
			}
			a.stopp("%s.%s lässt sich nicht übersetzen", basis.text, x.name)
		case 'h':
			if x.name == "state" {
				if a.this == "" {
					a.stopp("this.state nur in einem Binärsensor mit eigenem Wert")
				}
				return wert{art: 't', text: a.this}
			}
			a.stopp("this.%s lässt sich nicht übersetzen", x.name)
		}
		a.stopp("Attribut „%s“ lässt sich nicht übersetzen", x.name)
	case jIndex:
		a.stopp("Zugriff mit [] lässt sich nicht übersetzen")
	case jAufruf:
		return a.aufruf(x, env)
	case jFilter:
		return a.filter(x, env)
	case jTest:
		w := a.aus(x.e, env)
		var b *ir
		switch x.name {
		case "number":
			b = a.istZahl(w)
		case "defined":
			b = wahr(w.art != '0')
		case "none":
			b = wahr(w.art == '0')
		default:
			a.stopp("Test „is %s“ lässt sich nicht übersetzen", x.name)
		}
		if x.nicht {
			b = nicht(b)
		}
		return wert{art: 'b', e: b}
	case jNicht:
		return wert{art: 'b', e: nicht(a.wahrheit(a.aus(x.e, env)))}
	case jNeg:
		w := a.aus(x.e, env)
		return wert{art: 'z', e: neg(a.zahlWert(w))}
	case jWennA:
		c := a.wahrheit(a.aus(x.bed, env))
		switch {
		case c.istWahr(true):
			return a.aus(x.dann, env)
		case c.istWahr(false):
			return a.aus(x.sonst, env)
		}
		return a.misch(c, a.aus(x.dann, env), a.aus(x.sonst, env))
	case jBin:
		return a.bin(x, env)
	case jVergleich:
		var teile []*ir
		links := a.aus(x.teile[0], env)
		for i, op := range x.ops {
			rechts := a.aus(x.teile[i+1], env)
			teile = append(teile, a.vergleich(op, links, rechts))
			links = rechts
		}
		return wert{art: 'b', e: und(teile...)}
	}
	a.stopp("Ausdruck lässt sich nicht übersetzen")
	return wert{}
}

func (a *auswerter) element(bed *ir, w wert) element {
	*a.naechste++
	return element{id: *a.naechste, bed: bed, w: w}
}

func (a *auswerter) bin(x jBin, env umgebung) wert {
	switch x.op {
	case "and", "or":
		l := a.wahrheit(a.aus(x.l, env))
		r := a.wahrheit(a.aus(x.r, env))
		a.streiche(x.op, l, r)
		if x.op == "and" {
			return wert{art: 'b', e: und(l, r)}
		}
		return wert{art: 'b', e: oder(l, r)}
	case "~":
		l, r := a.aus(x.l, env), a.aus(x.r, env)
		return wert{art: 't', text: a.alsText(l) + a.alsText(r)}
	}
	l, r := a.aus(x.l, env), a.aus(x.r, env)
	if x.op == "+" && l.art == 'l' && r.art == 'l' {
		out := append(append([]element{}, l.el...), r.el...)
		return wert{art: 'l', el: out}
	}
	if x.op == "+" && l.art == 't' && r.art == 't' {
		return wert{art: 't', text: l.text + r.text}
	}
	if x.op == "-" && l.art == 'j' && r.art == 'c' {
		return wert{art: 'D', text: r.text}
	}
	switch x.op {
	case "+", "-", "*", "/":
		le, re := a.zahlWert(l), a.zahlWert(r)
		if x.op == "*" || x.op == "/" {
			if e, ok := dauerUmrechnung(x.op, le, re); ok {
				return wert{art: 'z', e: e}
			}
		}
		return wert{art: 'z', e: rechne(x.op, le, re)}
	}
	a.stopp("Rechenzeichen „%s“ lässt sich nicht übersetzen", x.op)
	return wert{}
}

// dauerUmrechnung: Home Assistant rechnet Minuten mal 60 in Sekunden um; in der Logik ist
// eine Dauer eine Dauer, die Zahl ändert nur ihre Einheit.
func dauerUmrechnung(op string, l, r *ir) (*ir, bool) {
	if r.art != 'z' {
		return nil, false
	}
	g, ha := l.groesse().aufgeloest()
	if g != gDauer {
		return nil, false
	}
	nach := ""
	switch {
	case op == "*" && r.v == 60 && ha == "min", op == "/" && r.v == 60 && ha == "h":
		if ha == "min" {
			nach = "s"
		} else {
			nach = "min"
		}
	case op == "*" && r.v == 60 && ha == "h":
		nach = "min"
	case op == "*" && r.v == 3600 && ha == "h":
		nach = "s"
	case op == "/" && r.v == 60 && ha == "s":
		nach = "min"
	case op == "/" && r.v == 3600 && ha == "s":
		nach = "h"
	default:
		return nil, false
	}
	k := *l
	k.q = neueGroesse(gDauer, nach)
	if l.art == 'r' {
		// derselbe Name, in einer anderen Einheit gemeint
		return &k, true
	}
	return &k, true
}

func (a *auswerter) alsText(w wert) string {
	switch w.art {
	case 't':
		return w.text
	case 'z':
		if w.e.art == 'z' {
			return zahlOhneEinheit(w.e.v)
		}
	}
	a.stopp("Text lässt sich nur aus festen Teilen zusammensetzen")
	return ""
}

func (a *auswerter) vergleich(op string, l, r wert) *ir {
	switch op {
	case "in", "not in":
		var b *ir
		switch {
		case r.art == 'l' && l.art == 's':
			var teile []*ir
			for _, e := range r.el {
				if e.w.art != 't' {
					a.stopp("„in“ nur mit einer Liste aus Texten")
				}
				teile = append(teile, und(e.bed, a.u.zustandIst(a, l.text, e.w.text)))
			}
			b = oder(teile...)
		case r.art == 'l' && l.art == 't':
			var teile []*ir
			for _, e := range r.el {
				if e.w.art == 't' && e.w.text == l.text {
					teile = append(teile, e.bed)
				}
			}
			b = oder(teile...)
		default:
			a.stopp("„in“ lässt sich hier nicht übersetzen")
		}
		if op == "not in" {
			b = nicht(b)
		}
		return b
	}
	// Zustand gegen Text: is_state in anderer Schreibweise
	if l.art == 's' && r.art == 't' || l.art == 't' && r.art == 's' {
		if l.art == 't' {
			l, r = r, l
		}
		if op != "==" && op != "!=" {
			a.stopp("Text lässt sich nur mit == und != vergleichen")
		}
		b := a.u.zustandIst(a, l.text, r.text)
		if op == "!=" {
			b = nicht(b)
		}
		return b
	}
	if l.art == 't' && r.art == 't' {
		return wahr(vergleicheText(op, l.text, r.text))
	}
	if l.art == 's' && r.art == 's' {
		// zwei Uhrzeiten (input_datetime) oder zwei Zustände
		le, re := a.u.uhrzeitVon(a, l.text), a.u.uhrzeitVon(a, r.text)
		return vergleiche(op, le, re)
	}
	if (l.art == 'b' || r.art == 'b') && (op == "==" || op == "!=") {
		lb, rb := a.wahrheit(l), a.wahrheit(r)
		var b *ir
		switch {
		case rb.istWahr(true):
			b = lb
		case rb.istWahr(false):
			b = nicht(lb)
		case lb.istWahr(true):
			b = rb
		case lb.istWahr(false):
			b = nicht(rb)
		default:
			a.stopp("Ja/Nein gegen Ja/Nein lässt sich nicht übersetzen")
		}
		if op == "!=" {
			b = nicht(b)
		}
		return b
	}
	if l.art == 'j' || r.art == 'j' {
		if l.art == 'j' {
			l = wert{art: 'z', e: &ir{art: 'k'}}
		}
		if r.art == 'j' {
			r = wert{art: 'z', e: &ir{art: 'k'}}
		}
	}
	if len(l.anzahl) > 0 && r.art == 'z' && r.e.art == 'z' {
		if (op == ">" && r.e.v == 0) || (op == ">=" && r.e.v == 1) || (op == "!=" && r.e.v == 0) {
			return oder(l.anzahl...)
		}
		if (op == "==" || op == "<=") && r.e.v == 0 || op == "<" && r.e.v == 1 {
			return nicht(oder(l.anzahl...))
		}
	}
	le, re := a.zahlWert(l), a.zahlWert(r)
	// Home Assistant rechnet ohne Wert mit der Vorgabe von |float(…). Gegen eine feste Zahl
	// steht damit fest, wie der Vergleich ohne Wert ausgeht: genau so wird er geschrieben.
	switch {
	case l.vorgabe != nil && l.fehlbar != nil && re.art == 'z':
		return a.mitVorgabe(op, le, re, *l.vorgabe, l.fehlbar)
	case r.vorgabe != nil && r.fehlbar != nil && le.art == 'z':
		return a.mitVorgabe(umgekehrt(op), re, le, *r.vorgabe, r.fehlbar)
	}
	v := vergleiche(op, le, re)
	for _, s := range []wert{l, r} {
		if s.vorgabe != nil && s.fehlbar != nil {
			a.offen = append(a.offen, offenerHinweis{fehlbar: s.fehlbar.text, vorgabe: *s.vorgabe, cmp: v, ort: a.ortJetzt()})
		}
	}
	return v
}

func (a *auswerter) mitVorgabe(op string, l, r *ir, vorgabe float64, fehlbar *ir) *ir {
	v := vergleiche(op, l, r)
	if vergleicheZahlen(op, vorgabe, r.v) {
		return oder(aufruf("unknown", nil, fehlbar), v)
	}
	return und(aufruf("known", nil, fehlbar), v)
}

func vergleicheText(op, a, b string) bool {
	switch op {
	case "==":
		return a == b
	case "!=":
		return a != b
	case "<":
		return a < b
	case "<=":
		return a <= b
	case ">":
		return a > b
	}
	return a >= b
}

func (a *auswerter) istZahl(w wert) *ir {
	switch w.art {
	case 's':
		s := a.u.symbolFuer(a, w.text)
		if s.art == 'E' {
			return aufruf("known", nil, a.u.ref(s))
		}
		return wahr(s.art == 'S' || s.art == 'C' || s.art == 'F')
	case 'z':
		return wahr(true)
	}
	return wahr(false)
}

func (a *auswerter) textArg(x jAusdruck, env umgebung) string {
	w := a.aus(x, env)
	if w.art != 't' {
		a.stopp("hier wird ein fester Text erwartet (die Kennung einer Entität)")
	}
	return w.text
}

func (a *auswerter) aufruf(x jAufruf, env umgebung) wert {
	if at, ok := x.f.(jAttr); ok {
		basis := a.aus(at.e, env)
		if at.name == "total_seconds" && basis.art == 'D' {
			s := a.u.symbolFuer(a, basis.text)
			return wert{art: 'z', e: a.u.seit(a, s)}
		}
		a.stopp("Aufruf .%s() lässt sich nicht übersetzen", at.name)
	}
	n, ok := x.f.(jName)
	if !ok {
		a.stopp("dieser Aufruf lässt sich nicht übersetzen")
	}
	arg := func(i int) jAusdruck {
		if i >= len(x.args) {
			a.stopp("%s() braucht mehr Angaben", n.n)
		}
		return x.args[i]
	}
	switch n.n {
	case "states":
		return wert{art: 's', text: a.textArg(arg(0), env)}
	case "is_state":
		id := a.textArg(arg(0), env)
		w := a.aus(arg(1), env)
		switch w.art {
		case 't':
			return wert{art: 'b', e: a.u.zustandIst(a, id, w.text)}
		case 'l':
			var teile []*ir
			for _, e := range w.el {
				teile = append(teile, und(e.bed, a.u.zustandIst(a, id, a.alsText(e.w))))
			}
			return wert{art: 'b', e: oder(teile...)}
		}
		a.stopp("is_state() braucht einen Text")
	case "state_attr":
		id := a.textArg(arg(0), env)
		attr := a.textArg(arg(1), env)
		if id == "sun.sun" && attr == "elevation" {
			return wert{art: 'z', e: a.u.ref(a.u.sonne())}
		}
		a.stopp("state_attr(%s, %s) lässt sich nicht übersetzen", id, attr)
	case "has_value":
		return wert{art: 'b', e: a.istZahl(wert{art: 's', text: a.textArg(arg(0), env)})}
	case "now", "utcnow":
		return wert{art: 'j'}
	case "today_at":
		if len(x.args) == 0 {
			return wert{art: 'z', e: &ir{art: 'u', text: "00:00"}}
		}
		w := a.aus(arg(0), env)
		switch w.art {
		case 't':
			return wert{art: 'z', e: &ir{art: 'u', text: uhrText(w.text)}}
		case 's':
			return wert{art: 'z', e: a.u.uhrzeitVon(a, w.text)}
		}
		a.stopp("today_at() braucht eine Uhrzeit")
	case "range":
		var grenzen []float64
		for _, y := range x.args {
			e := a.zahlWert(a.aus(y, env))
			if e.art != 'z' {
				a.stopp("range() nur mit festen Zahlen")
			}
			grenzen = append(grenzen, e.v)
		}
		von, bis, schritt := 0.0, 0.0, 1.0
		switch len(grenzen) {
		case 1:
			bis = grenzen[0]
		case 2:
			von, bis = grenzen[0], grenzen[1]
		case 3:
			von, bis, schritt = grenzen[0], grenzen[1], grenzen[2]
		default:
			a.stopp("range() braucht eine bis drei Zahlen")
		}
		if schritt <= 0 || (bis-von)/schritt > 64 {
			a.stopp("range() zu groß")
		}
		var el []element
		for i := von; i < bis; i += schritt {
			el = append(el, a.element(wahr(true), wert{art: 'z', e: zahl(i, neueGroesse(gZahl, ""))}))
		}
		return wert{art: 'l', el: el}
	case "namespace":
		// namespace(w=0): die Felder werden Variablen ns.w (siehe lauf, jSetze)
		out := wert{art: 'N', felder: map[string]wert{}}
		for k, v := range x.kwargs {
			w := a.aus(v, env)
			if w.art == 't' {
				a.stopp("ein Text in einem namespace lässt sich nicht übersetzen")
			}
			out.felder[k] = w
		}
		return out
	case "float", "int":
		return a.zahlFilter(n.n, a.aus(arg(0), env), x.args[1:], env)
	case "min", "max":
		var werte []wert
		for _, y := range x.args {
			werte = append(werte, a.aus(y, env))
		}
		if len(werte) == 1 && werte[0].art == 'l' {
			return a.minMaxListe(n.n, werte[0])
		}
		return a.minMaxListe(n.n, wert{art: 'l', el: elementeVon(werte)})
	case "bool":
		return wert{art: 'b', e: a.wahrheit(a.aus(arg(0), env))}
	}
	a.stopp("Funktion %s() lässt sich nicht übersetzen", n.n)
	return wert{}
}

func elementeVon(ws []wert) []element {
	var out []element
	for _, w := range ws {
		out = append(out, element{bed: wahr(true), w: w})
	}
	return out
}

func uhrText(s string) string {
	teile := strings.Split(strings.TrimSpace(s), ":")
	if len(teile) < 2 {
		return s
	}
	h, _ := strconv.Atoi(teile[0])
	m, _ := strconv.Atoi(teile[1])
	return fmt.Sprintf("%02d:%02d", h, m)
}

func (a *auswerter) minMaxListe(f string, l wert) wert {
	if l.art != 'l' || len(l.el) == 0 {
		a.stopp("%s braucht eine Liste aus Zahlen", f)
	}
	var e *ir
	for _, x := range l.el {
		if !x.bed.istWahr(true) {
			a.stopp("%s über eine Liste mit Bedingungen lässt sich nicht übersetzen", f)
		}
		v := a.zahlWert(x.w)
		if e == nil {
			e = v
			continue
		}
		e = minMax(f, e, v)
	}
	return wert{art: 'z', e: e}
}

func (a *auswerter) zahlFilter(f string, w wert, args []jAusdruck, env umgebung) wert {
	var vorgabe *float64
	if len(args) > 0 {
		d := a.zahlWert(a.aus(args[0], env))
		if d.art != 'z' {
			a.stopp("|%s(…) nur mit einer festen Zahl", f)
		}
		vorgabe = &d.v
	}
	switch w.art {
	case 's':
		v, fehlbar := a.u.zahlVon(a, w.text)
		out := wert{art: 'z', e: v}
		if fehlbar != nil {
			out.fehlbar = fehlbar
			out.vorgabe = vorgabe
			if vorgabe != nil {
				vereinige(v.groesse(), neueGroesse(gOffen, ""))
			}
		}
		return out
	case 'z':
		if f == "int" && w.e.art == 'z' {
			return wert{art: 'z', e: zahl(math.Trunc(w.e.v), w.e.q)}
		}
		return w
	case 't':
		if v, err := strconv.ParseFloat(strings.TrimSpace(w.text), 64); err == nil {
			if f == "int" {
				v = math.Trunc(v)
			}
			return wert{art: 'z', e: zahl(v, nil)}
		}
		if vorgabe != nil {
			return wert{art: 'z', e: zahl(*vorgabe, nil)}
		}
	case 'b':
		a.stopp("|%s auf Ja/Nein lässt sich nicht übersetzen", f)
	}
	a.stopp("|%s lässt sich hier nicht übersetzen", f)
	return wert{}
}

func (a *auswerter) filter(x jFilter, env umgebung) wert {
	w := a.aus(x.e, env)
	switch x.name {
	case "float", "int":
		out := a.zahlFilter(x.name, w, x.args, env)
		if x.name == "int" && w.art == 's' {
			a.u.intHinweis(a, w.text)
		}
		return out
	case "round":
		if w.art != 'z' {
			a.stopp("|round nur auf Zahlen")
		}
		a.u.hinweis(a.ortJetzt(), "", "Home Assistant rundet hier (|round); die Logik rechnet ungerundet. Ein Unterschied entsteht nur innerhalb einer halben Einheit um eine Schwelle.")
		return wert{art: 'z', e: w.e}
	case "min", "max":
		return a.minMaxListe(x.name, w)
	case "count", "length":
		if w.art != 'l' {
			a.stopp("|%s nur auf Listen", x.name)
		}
		var beds []*ir
		summe := zahl(0, neueGroesse(gZahl, ""))
		for _, e := range w.el {
			beds = append(beds, e.bed)
			summe = rechne("+", summe, wenn(e.bed, zahl(1, neueGroesse(gZahl, "")), zahl(0, neueGroesse(gZahl, ""))))
		}
		return wert{art: 'z', e: summe, anzahl: beds}
	case "list":
		if w.art != 'l' {
			a.stopp("|list nur auf Listen")
		}
		return w
	case "reject", "select":
		if w.art != 'l' || len(x.args) != 2 {
			a.stopp("|%s nur als %s('in', liste)", x.name, x.name)
		}
		test := a.aus(x.args[0], env)
		gegen := a.aus(x.args[1], env)
		if test.art != 't' || test.text != "in" || gegen.art != 'l' {
			a.stopp("|%s nur als %s('in', liste)", x.name, x.name)
		}
		var out []element
		for _, e := range w.el {
			if e.w.art != 't' {
				a.stopp("|%s nur auf Listen aus Texten", x.name)
			}
			var drin []*ir
			for _, g := range gegen.el {
				if g.w.art == 't' && g.w.text == e.w.text {
					drin = append(drin, g.bed)
				}
			}
			ist := oder(drin...)
			if x.name == "reject" {
				ist = nicht(ist)
			}
			out = append(out, element{id: e.id, bed: und(e.bed, ist), w: e.w})
		}
		return wert{art: 'l', el: out}
	case "default":
		if w.art == '0' && len(x.args) > 0 {
			return a.aus(x.args[0], env)
		}
		return w
	case "is_number":
		return wert{art: 'b', e: a.istZahl(w)}
	case "string":
		return w
	case "sum":
		if w.art != 'l' {
			a.stopp("|sum nur auf Listen")
		}
		var e *ir
		for _, x := range w.el {
			v := wenn(x.bed, a.zahlWert(x.w), zahl(0, a.zahlWert(x.w).groesse()))
			if e == nil {
				e = v
			} else {
				e = rechne("+", e, v)
			}
		}
		if e == nil {
			e = zahl(0, nil)
		}
		return wert{art: 'z', e: e}
	}
	a.stopp("Filter |%s lässt sich nicht übersetzen", x.name)
	return wert{}
}
