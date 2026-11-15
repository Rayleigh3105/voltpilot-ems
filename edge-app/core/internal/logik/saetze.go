package logik

// Sätze aus dem Wortschatz für Bedingungen ohne Namen (Blatt „Warum?“): Der Kunde liest nie eine
// Formel. Eine Bedingung, die der Text benennt, trägt ihren Namen; eine ohne Namen übersetzt der
// Kern, wenn jeder Teil ein Wort hat (Eingänge, Stellwerte und benannte Zustände mit ihrem Namen,
// Zahlen mit Einheit, die üblichen Vergleiche und Funktionen). Was er nicht übersetzen kann - eine
// Formel aus formulas, ein Zustand ohne Namen, Rechnen jenseits von „Wert ± Zahl“ -, heißt
// allgemeinSatz, und die Prüfung nennt die Stelle.

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// allgemeinSatz steht für eine Bedingung, die sich nicht in einen Satz übersetzen lässt.
const allgemeinSatz = "Eine Bedingung Ihres Fachbetriebs"

// bedingungSatz bildet den Satz einer Bedingung ohne Namen; ok false heißt allgemeinSatz.
func (L *Logik) bedingungSatz(b *baum) (string, bool) {
	s, ok := L.satzBool(b)
	if !ok || s == "" {
		return allgemeinSatz, false
	}
	return grossAnfang(s), true
}

// grossAnfang schreibt das erste Zeichen groß (zeichengenau: „ und Umlaute sind mehr als ein Byte).
func grossAnfang(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToUpper(r)) + s[n:]
}

// nameImSatz ist der Name eines Werts in Anführungszeichen; ok false für eine Kennung ohne Namen.
func (L *Logik) nameImSatz(n string) (string, bool) {
	if e, ok := L.Werte[n]; ok && e.Name != "" {
		return "„" + e.Name + "“", true
	}
	if s, ok := L.Stellwerte[n]; ok && s.Name != "" {
		return "„" + s.Name + "“", true
	}
	if z, ok := L.zustand[n]; ok && z.HatName {
		return "„" + z.Name + "“", true
	}
	return "", false
}

// satzWert übersetzt einen Wert: ein benannter Wert oder eine Zahl mit Einheit.
func (L *Logik) satzWert(b *baum) (string, bool) {
	switch b.t {
	case kKlammer:
		return L.satzWert(b.x)
	case kZahl:
		return Zeige(zahlW(b.v, b.d)), true
	case kName:
		return L.nameImSatz(b.n)
	case kUn:
		if b.op == "-" && b.x.t == kZahl {
			return Zeige(zahlW(-b.x.v, b.x.d)), true
		}
	}
	return "", false
}

// satzBool übersetzt einen Wahrheitswert in einen Satzteil (ohne großen Anfang).
func (L *Logik) satzBool(b *baum) (string, bool) {
	switch b.t {
	case kKlammer:
		return L.satzBool(b.x)
	case kName:
		return L.satzSchalter(b.n, false)
	case kUn:
		if b.op != "not" {
			return "", false
		}
		x := b.x
		for x.t == kKlammer {
			x = x.x
		}
		switch {
		case x.t == kName:
			return L.satzSchalter(x.n, true)
		case x.t == kRuf && (x.f == "unknown" || x.f == "known") && len(x.args) == 1:
			return L.satzRuf(&baum{t: kRuf, f: map[string]string{"unknown": "known", "known": "unknown"}[x.f], args: x.args})
		case x.t == kRuf && x.f == "running" && len(x.args) == 1 && x.args[0].t == kName:
			if n, ok := L.nameImSatz(x.args[0].n); ok {
				return n + " läuft nicht", true
			}
		}
		return "", false
	case kRuf:
		return L.satzRuf(b)
	case kBin:
		switch b.op {
		case "and", "or":
			return L.satzVerknuepft(b)
		case "<", "<=", ">", ">=", "==", "!=":
			return L.satzVergleich(b)
		}
	}
	return "", false
}

// satzSchalter: ein Ja/Nein-Wert mit Namen - ein Schalter unter den Stellwerten ist an oder aus,
// ein Zustand oder ein Eingang trifft zu oder nicht.
func (L *Logik) satzSchalter(n string, nicht bool) (string, bool) {
	name, ok := L.nameImSatz(n)
	if !ok {
		return "", false
	}
	if s, ok := L.Stellwerte[n]; ok {
		if s.Art != "boolean" {
			return "", false
		}
		if nicht {
			return name + " ist aus", true
		}
		return name + " ist an", true
	}
	if e, ok := L.Werte[n]; ok && !e.GroesseBool {
		return "", false
	}
	if z, ok := L.zustand[n]; ok && z.Art != "boolean" {
		return "", false
	}
	if nicht {
		return name + " trifft nicht zu", true
	}
	return name + " trifft zu", true
}

func (L *Logik) satzRuf(b *baum) (string, bool) {
	switch b.f {
	case "unknown", "known":
		if len(b.args) != 1 || b.args[0].t != kName {
			return "", false
		}
		n, ok := L.nameImSatz(b.args[0].n)
		if !ok {
			return "", false
		}
		if b.f == "unknown" {
			return n + " hat keinen Wert", true
		}
		return n + " hat einen Wert", true
	case "holds":
		if len(b.args) != 2 {
			return "", false
		}
		was, ok := L.satzBool(b.args[0])
		dauer, okD := L.satzWert(b.args[1])
		if !ok || !okD {
			return "", false
		}
		return was + ", seit mindestens " + dauer, true
	case "time_window":
		if len(b.args) != 2 {
			return "", false
		}
		von, ok := L.satzWert(b.args[0])
		bis, okB := L.satzWert(b.args[1])
		if !ok || !okB {
			return "", false
		}
		return "die Uhrzeit liegt zwischen " + von + " und " + bis, true
	case "running":
		if len(b.args) == 1 && b.args[0].t == kName {
			if n, ok := L.nameImSatz(b.args[0].n); ok {
				return n + " läuft", true
			}
		}
	}
	return "", false
}

// satzVerknuepft: eine Kette gleicher Verknüpfung; lauter fehlende Werte werden ein Satz.
func (L *Logik) satzVerknuepft(b *baum) (string, bool) {
	var teile []*baum
	var sammle func(x *baum)
	sammle = func(x *baum) {
		for x.t == kKlammer {
			x = x.x
		}
		if x.t == kBin && x.op == b.op {
			sammle(x.l)
			sammle(x.r)
			return
		}
		teile = append(teile, x)
	}
	sammle(b)
	if b.op == "or" {
		var namen []string
		for _, t := range teile {
			if t.t != kRuf || t.f != "unknown" || len(t.args) != 1 || t.args[0].t != kName {
				namen = nil
				break
			}
			n, ok := L.nameImSatz(t.args[0].n)
			if !ok {
				return "", false
			}
			namen = append(namen, n)
		}
		if len(namen) > 1 {
			return "kein Wert bei " + strings.Join(namen[:len(namen)-1], ", ") + " oder " + namen[len(namen)-1], true
		}
	}
	wort := map[string]string{"and": " und ", "or": " oder "}[b.op]
	saetze := make([]string, 0, len(teile))
	for _, t := range teile {
		s, ok := L.satzBool(t)
		if !ok {
			return "", false
		}
		saetze = append(saetze, s)
	}
	return strings.Join(saetze, wort), true
}

// satzVergleich: Wert gegen Wert, Zahl oder „Wert ± Zahl“; since(x) gegen eine Dauer.
func (L *Logik) satzVergleich(b *baum) (string, bool) {
	l, r := b.l, b.r
	for l.t == kKlammer {
		l = l.x
	}
	for r.t == kKlammer {
		r = r.x
	}
	if l.t == kRuf && l.f == "since" && len(l.args) == 1 && l.args[0].t == kName && (b.op == ">=" || b.op == ">") {
		n, ok := L.nameImSatz(l.args[0].n)
		d, okD := L.satzWert(r)
		if !ok || !okD {
			return "", false
		}
		return n + " steht seit mindestens " + d, true
	}
	links, ok := L.satzWert(l)
	if !ok {
		return "", false
	}
	if r.t == kBin && (r.op == "+" || r.op == "-") {
		basis, okB := L.satzWert(r.l)
		abstand, okA := L.satzWert(r.r)
		if !okB || !okA || r.r.t != kZahl {
			return "", false
		}
		switch {
		case r.op == "-" && b.op == "<":
			return links + " liegt mehr als " + abstand + " unter " + basis, true
		case r.op == "-" && b.op == "<=":
			return links + " liegt mindestens " + abstand + " unter " + basis, true
		case r.op == "+" && b.op == ">":
			return links + " liegt mehr als " + abstand + " über " + basis, true
		case r.op == "+" && b.op == ">=":
			return links + " liegt mindestens " + abstand + " über " + basis, true
		}
		return "", false
	}
	rechts, ok := L.satzWert(r)
	if !ok {
		return "", false
	}
	switch b.op {
	case ">=":
		return links + " ist mindestens " + rechts, true
	case ">":
		return links + " liegt über " + rechts, true
	case "<":
		return links + " liegt unter " + rechts, true
	case "<=":
		return links + " ist höchstens " + rechts, true
	case "==":
		return links + " ist " + rechts, true
	}
	return links + " ist nicht " + rechts, true
}
