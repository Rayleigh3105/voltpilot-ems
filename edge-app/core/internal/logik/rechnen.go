package logik

import (
	"math"
	"strings"
)

// Rechnen ist dreiwertig: wahr, falsch, unbekannt. Ein fehlender Wert macht ein Ergebnis
// unbekannt, außer die andere Seite entscheidet schon (false and unknown ist false,
// true or unknown ist true). Vergleiche tragen ein Epsilon von 1e-9.

const eps = 1e-9

func passt(a, b Groesse) bool { return a == b }

func wahrheit(x Wert, src string) (bool, error) {
	if x.Art != WertBool {
		return false, fehler("Hier steht kein Ja/Nein: „%s“", src)
	}
	return x.B, nil
}

func addiere(op string, l, r Wert, src string) (Wert, error) {
	if l.Art == WertUnbekannt || r.Art == WertUnbekannt {
		return unbekanntW(), nil
	}
	if l.Art != WertZahl || r.Art != WertZahl {
		return Wert{}, fehler("Einheiten passen nicht in „%s“", src)
	}
	vz := 1.0
	if op == "-" {
		vz = -1.0
	}
	switch {
	case l.D == r.D && l.D != GroesseTemp:
		return zahlW(l.V+vz*r.V, l.D), nil
	case l.D == GroesseTemp && r.D == GroesseDTemp:
		return zahlW(l.V+vz*r.V, GroesseTemp), nil
	case l.D == GroesseTemp && r.D == GroesseTemp && op == "-":
		return zahlW(l.V-r.V, GroesseDTemp), nil
	}
	return Wert{}, fehler("Einheiten passen nicht: %s %s %s in „%s“", groesseWort[l.D], op, groesseWort[r.D], src)
}

func (L *Logik) rechne(st *Lauf, ein *Eingabe, b *baum, tiefe int) (Wert, error) {
	if tiefe > 64 {
		return Wert{}, fehler("Formeln verweisen im Kreis")
	}
	w := func(x *baum) (Wert, error) { return L.rechne(st, ein, x, tiefe+1) }
	switch b.t {
	case kZahl:
		return zahlW(b.v, b.d), nil
	case kBool:
		return boolW(b.b), nil
	case kKlammer:
		return w(b.x)
	case kName:
		return L.hole(st, ein, b.n, tiefe)
	case kUn:
		x, err := w(b.x)
		if err != nil {
			return Wert{}, err
		}
		if x.Art == WertUnbekannt {
			return unbekanntW(), nil
		}
		if b.op == "not" {
			v, err := wahrheit(x, b.src)
			if err != nil {
				return Wert{}, err
			}
			return boolW(!v), nil
		}
		if x.Art != WertZahl {
			return Wert{}, fehler("Vorzeichen braucht eine Zahl: „%s“", b.src)
		}
		return zahlW(-x.V, x.D), nil
	case kBin:
		if b.op == "and" || b.op == "or" {
			// beide Seiten rechnen, damit holds() weiterzählt
			l, err := w(b.l)
			if err != nil {
				return Wert{}, err
			}
			r, err := w(b.r)
			if err != nil {
				return Wert{}, err
			}
			var lb, rb int8 = -1, -1 // -1 unbekannt, 0 falsch, 1 wahr
			if l.Art != WertUnbekannt {
				v, err := wahrheit(l, b.src)
				if err != nil {
					return Wert{}, err
				}
				if v {
					lb = 1
				} else {
					lb = 0
				}
			}
			if r.Art != WertUnbekannt {
				v, err := wahrheit(r, b.src)
				if err != nil {
					return Wert{}, err
				}
				if v {
					rb = 1
				} else {
					rb = 0
				}
			}
			if b.op == "and" {
				if lb == 0 || rb == 0 {
					return boolW(false), nil
				}
				if lb == -1 || rb == -1 {
					return unbekanntW(), nil
				}
				return boolW(true), nil
			}
			if lb == 1 || rb == 1 {
				return boolW(true), nil
			}
			if lb == -1 || rb == -1 {
				return unbekanntW(), nil
			}
			return boolW(false), nil
		}
		l, err := w(b.l)
		if err != nil {
			return Wert{}, err
		}
		r, err := w(b.r)
		if err != nil {
			return Wert{}, err
		}
		switch b.op {
		case "+", "-":
			return addiere(b.op, l, r, b.src)
		case "*", "/":
			if l.Art == WertUnbekannt || r.Art == WertUnbekannt {
				return unbekanntW(), nil
			}
			if l.Art != WertZahl || r.Art != WertZahl {
				return Wert{}, fehler("Einheiten passen nicht in „%s“", b.src)
			}
			if b.op == "*" && (l.D == GroesseZahl || r.D == GroesseZahl) {
				d := l.D
				if l.D == GroesseZahl {
					d = r.D
				}
				return zahlW(l.V*r.V, d), nil
			}
			if b.op == "/" && r.D == GroesseZahl {
				return zahlW(l.V/r.V, l.D), nil
			}
			return Wert{}, fehler("Einheiten passen nicht in „%s“", b.src)
		}
		if l.Art == WertUnbekannt || r.Art == WertUnbekannt {
			return unbekanntW(), nil
		}
		if l.Art == WertWort || r.Art == WertWort {
			if l.Art != WertWort || r.Art != WertWort || (b.op != "==" && b.op != "!=") {
				return Wert{}, fehler("Wörter lassen sich nur mit == und != vergleichen: „%s“", b.src)
			}
			return boolW((l.W == r.W) == (b.op == "==")), nil
		}
		if l.Art == WertBool || r.Art == WertBool {
			gleich := l.Art == WertBool && r.Art == WertBool && l.B == r.B
			switch b.op {
			case "==":
				return boolW(gleich), nil
			case "!=":
				return boolW(!gleich), nil
			}
			return Wert{}, fehler("Vergleich mit Wahrheitswert in „%s“", b.src)
		}
		if l.Art != WertZahl || r.Art != WertZahl || !passt(l.D, r.D) {
			return Wert{}, fehler("Einheiten passen nicht: %s %s %s in „%s“", groesseWort[l.D], b.op, groesseWort[r.D], b.src)
		}
		d := l.V - r.V
		switch b.op {
		case "<":
			return boolW(d < -eps), nil
		case "<=":
			return boolW(d <= eps), nil
		case ">":
			return boolW(d > eps), nil
		case ">=":
			return boolW(d >= -eps), nil
		case "==":
			return boolW(math.Abs(d) <= eps), nil
		default:
			return boolW(math.Abs(d) > eps), nil
		}
	case kRuf:
		return L.rufe(st, ein, b, tiefe)
	}
	return Wert{}, fehler("Unbekannter Knoten")
}

func (L *Logik) rufe(st *Lauf, ein *Eingabe, b *baum, tiefe int) (Wert, error) {
	w := func(x *baum) (Wert, error) { return L.rechne(st, ein, x, tiefe+1) }
	a := b.args
	brauche := func(n int) error {
		if len(a) != n {
			return fehler("%s() braucht %d Angaben: „%s“", b.f, n, b.src)
		}
		return nil
	}
	switch b.f {
	case "min", "max":
		if len(a) == 0 {
			return Wert{}, fehler("%s() braucht mindestens einen Wert: „%s“", b.f, b.src)
		}
		var xs []Wert
		for _, arg := range a {
			x, err := w(arg)
			if err != nil {
				return Wert{}, err
			}
			xs = append(xs, x)
		}
		for _, x := range xs {
			if x.Art == WertUnbekannt {
				return unbekanntW(), nil
			}
		}
		for _, x := range xs {
			if x.Art != WertZahl || !passt(x.D, xs[0].D) {
				return Wert{}, fehler("Einheiten passen nicht in „%s“", b.src)
			}
		}
		best := xs[0].V
		for _, x := range xs[1:] {
			if (b.f == "min" && x.V < best) || (b.f == "max" && x.V > best) {
				best = x.V
			}
		}
		return zahlW(best, xs[0].D), nil
	case "if":
		if err := brauche(3); err != nil {
			return Wert{}, err
		}
		c, err := w(a[0])
		if err != nil {
			return Wert{}, err
		}
		x, err := w(a[1])
		if err != nil {
			return Wert{}, err
		}
		y, err := w(a[2])
		if err != nil {
			return Wert{}, err
		}
		if c.Art == WertUnbekannt {
			return unbekanntW(), nil
		}
		v, err := wahrheit(c, b.src)
		if err != nil {
			return Wert{}, err
		}
		if v {
			return x, nil
		}
		return y, nil
	case "known", "unknown":
		if err := brauche(1); err != nil {
			return Wert{}, err
		}
		x, err := w(a[0])
		if err != nil {
			return Wert{}, err
		}
		return boolW((x.Art == WertUnbekannt) == (b.f == "unknown")), nil
	case "time_window":
		if err := brauche(2); err != nil {
			return Wert{}, err
		}
		von, err := w(a[0])
		if err != nil {
			return Wert{}, err
		}
		bis, err := w(a[1])
		if err != nil {
			return Wert{}, err
		}
		// fehlt eine Zeit, gilt "rund um die Uhr" (wie die Vorlage)
		if von.Art == WertUnbekannt || bis.Art == WertUnbekannt {
			return boolW(true), nil
		}
		if von.V == bis.V {
			return boolW(true), nil
		}
		n := ein.UhrMin
		if von.V < bis.V {
			return boolW(n >= von.V && n < bis.V), nil
		}
		return boolW(n >= von.V || n < bis.V), nil
	case "holds":
		if err := brauche(2); err != nil {
			return Wert{}, err
		}
		c, err := w(a[0])
		if err != nil {
			return Wert{}, err
		}
		dauer, err := w(a[1])
		if err != nil {
			return Wert{}, err
		}
		key := "h:" + b.src
		if c.Art == WertBool && c.B {
			if st.haelt[key] == nil {
				t := ein.Jetzt
				st.haelt[key] = &t
			}
			if dauer.Art == WertUnbekannt {
				return unbekanntW(), nil
			}
			return boolW(ein.Jetzt-*st.haelt[key] >= dauer.V), nil
		}
		st.haelt[key] = nil
		if c.Art == WertUnbekannt {
			return unbekanntW(), nil
		}
		return boolW(false), nil
	case "running":
		if err := brauche(1); err != nil {
			return Wert{}, err
		}
		z := st.zustandLauf(a[0])
		if z == nil || z.art != "timer" {
			return Wert{}, fehler("running() braucht einen Zeitgeber: „%s“", b.src)
		}
		return boolW(z.bis != nil && ein.Jetzt < *z.bis), nil
	case "since":
		if err := brauche(1); err != nil {
			return Wert{}, err
		}
		z := st.zustandLauf(a[0])
		if z == nil || z.art == "timer" {
			return Wert{}, fehler("since() braucht einen Schalter oder Zähler: „%s“", b.src)
		}
		return zahlW(ein.Jetzt-z.seit, GroesseDauer), nil
	case "last":
		if err := brauche(1); err != nil {
			return Wert{}, err
		}
		z := st.zustandLauf(a[0])
		if z == nil || z.art != "counter" {
			return Wert{}, fehler("last() braucht einen Zähler: „%s“", b.src)
		}
		return wortW(z.zuletzt), nil
	case "in_schedule":
		if err := brauche(1); err != nil {
			return Wert{}, err
		}
		if a[0].t != kName {
			return Wert{}, fehler("in_schedule() braucht einen Zeitplan: „%s“", b.src)
		}
		p := st.Stell[a[0].n]
		if p.Art != WertPlan || p.Plan == nil {
			return Wert{}, fehler("in_schedule() braucht einen Zeitplan: „%s“", b.src)
		}
		tag := ein.Wochentag
		n := ein.UhrMin
		for _, f := range p.Plan.Fenster {
			if f.Von < f.Bis {
				if tagIn(f.Tage, tag) && n >= f.Von && n < f.Bis {
					return boolW(true), nil
				}
			} else if (tagIn(f.Tage, tag) && n >= f.Von) || (tagIn(f.Tage, (tag+6)%7) && n < f.Bis) {
				return boolW(true), nil
			}
		}
		return boolW(false), nil
	}
	return Wert{}, fehler("Unbekannte Funktion %s()", b.f)
}

func tagIn(tage []int, t int) bool {
	for _, x := range tage {
		if x == t {
			return true
		}
	}
	return false
}

func (st *Lauf) zustandLauf(arg *baum) *zustandLauf {
	if arg == nil || arg.t != kName {
		return nil
	}
	return st.Z[arg.n]
}

func (L *Logik) hole(st *Lauf, ein *Eingabe, n string, tiefe int) (Wert, error) {
	if n == "clock" {
		return zahlW(ein.UhrMin, GroesseUhrzeit), nil
	}
	if _, ok := L.Stellwerte[n]; ok {
		return st.Stell[n], nil
	}
	if e, ok := L.Werte[n]; ok {
		w, ok := ein.Werte[n]
		if !ok {
			return unbekanntW(), nil
		}
		if e.HatMaxAge && w.Alter > e.MaxAge {
			return unbekanntW(), nil
		}
		if w.Bool != nil {
			return boolW(*w.Bool), nil
		}
		if w.Zahl == nil {
			return unbekanntW(), nil
		}
		d := w.D
		if d == "" {
			d = e.Groesse
		}
		return zahlW(*w.Zahl, d), nil
	}
	if z, ok := st.Z[n]; ok {
		switch z.art {
		case "boolean":
			return boolW(z.an), nil
		case "counter":
			return zahlW(float64(z.wert), GroesseZahl), nil
		default:
			return boolW(z.bis != nil && ein.Jetzt < *z.bis), nil
		}
	}
	if m, ok := L.Merker[n]; ok {
		return L.rechne(st, ein, m, tiefe+1)
	}
	if L.woerter[n] {
		return wortW(n), nil
	}
	if punkt := indexPunkt(n); punkt > 0 {
		g, eig := n[:punkt], n[punkt+1:]
		if _, ok := L.Geraete[g]; ok {
			stamm := ein.Geraete[g]
			lauf := st.G[g]
			switch eig {
			case "on":
				if stamm.Stufe == nil {
					return unbekanntW(), nil
				}
				return boolW(*stamm.Stufe > 0), nil
			case "level":
				if stamm.Stufe == nil {
					return unbekanntW(), nil
				}
				return zahlW(*stamm.Stufe, GroesseZahl), nil
			case "power":
				if stamm.Stufe == nil || stamm.KwJeAusgang == nil {
					return unbekanntW(), nil
				}
				return zahlW(*stamm.Stufe**stamm.KwJeAusgang, GroesseKW), nil
			case "kw_per_output":
				if stamm.KwJeAusgang == nil {
					return unbekanntW(), nil
				}
				return zahlW(*stamm.KwJeAusgang, GroesseKW), nil
			case "output_hours_today":
				if lauf == nil {
					return zahlW(0, GroesseDauer), nil
				}
				return zahlW(lauf.ausgangsSekunden, GroesseDauer), nil
			case "requested":
				if lauf == nil {
					return zahlW(0, GroesseZahl), nil
				}
				return zahlW(lauf.wunsch, GroesseZahl), nil
			default:
				return Wert{}, fehler("Gerät kennt „%s“ nicht", eig)
			}
		}
	}
	return Wert{}, fehler("Unbekannter Name „%s“", n)
}

func indexPunkt(n string) int {
	for i := 0; i < len(n); i++ {
		if n[i] == '.' {
			return i
		}
	}
	return -1
}

// ------------------------------------------------------------------ Statische Größen

// groesse bestimmt die Größe eines Ausdrucks ohne Werte; Einheitenfehler sind Fehler.
func (L *Logik) groesse(b *baum, pfad []string) (Groesse, error) {
	g := func(x *baum) (Groesse, error) { return L.groesse(x, pfad) }
	switch b.t {
	case kZahl:
		return b.d, nil
	case kBool:
		return GroesseBool, nil
	case kKlammer:
		return g(b.x)
	case kUn:
		x, err := g(b.x)
		if err != nil {
			return "", err
		}
		if b.op == "not" && x != GroesseBool {
			return "", fehler("„not“ braucht Ja/Nein: „%s“", b.src)
		}
		return x, nil
	case kName:
		n := b.n
		if n == "clock" {
			return GroesseUhrzeit, nil
		}
		if s, ok := L.Stellwerte[n]; ok {
			switch s.Art {
			case "boolean":
				return GroesseBool, nil
			case "select":
				return GroesseWort, nil
			case "schedule":
				return GroessePlan, nil
			default:
				return s.Vorgabe.D, nil
			}
		}
		if e, ok := L.Werte[n]; ok {
			if e.GroesseBool {
				return GroesseBool, nil
			}
			return e.Groesse, nil
		}
		if z, ok := L.zustand[n]; ok {
			if z.Art == "counter" {
				return GroesseZahl, nil
			}
			return GroesseBool, nil
		}
		if m, ok := L.Merker[n]; ok {
			for _, p := range pfad {
				if p == n {
					return "", fehler("Formeln verweisen im Kreis: %s", strings.Join(append(pfad, n), " → "))
				}
			}
			return L.groesse(m, append(pfad, n))
		}
		if punkt := indexPunkt(n); punkt > 0 {
			ger, eig := n[:punkt], n[punkt+1:]
			if _, ok := L.Geraete[ger]; ok {
				switch eig {
				case "on":
					return GroesseBool, nil
				case "level", "requested":
					return GroesseZahl, nil
				case "power", "kw_per_output":
					return GroesseKW, nil
				case "output_hours_today":
					return GroesseDauer, nil
				}
				return "", fehler("Gerät kennt „%s“ nicht (in „%s“)", eig, n)
			}
		}
		if L.woerter[n] {
			return GroesseWort, nil
		}
		return "", fehler("Unbekannter Name „%s“", n)
	case kRuf:
		var arten []Groesse
		for _, arg := range b.args {
			x, err := g(arg)
			if err != nil {
				return "", err
			}
			arten = append(arten, x)
		}
		switch b.f {
		case "min", "max":
			if len(arten) == 0 {
				return "", fehler("%s() braucht mindestens einen Wert: „%s“", b.f, b.src)
			}
			for _, x := range arten {
				if x != arten[0] {
					return "", fehler("Einheiten passen nicht in „%s“", b.src)
				}
			}
			return arten[0], nil
		case "if":
			if len(arten) != 3 {
				return "", fehler("if() braucht Bedingung, dann, sonst: „%s“", b.src)
			}
			if arten[0] != GroesseBool {
				return "", fehler("if() beginnt mit Ja/Nein: „%s“", b.src)
			}
			if arten[1] != arten[2] {
				return "", fehler("if() liefert zwei verschiedene Größen: „%s“", b.src)
			}
			return arten[1], nil
		case "known", "unknown":
			if len(arten) != 1 {
				return "", fehler("%s() braucht einen Wert: „%s“", b.f, b.src)
			}
			return GroesseBool, nil
		case "time_window":
			if len(arten) != 2 || arten[0] != GroesseUhrzeit || arten[1] != GroesseUhrzeit {
				return "", fehler("time_window() braucht zwei Uhrzeiten")
			}
			return GroesseBool, nil
		case "holds":
			if len(arten) != 2 || arten[0] != GroesseBool || arten[1] != GroesseDauer {
				return "", fehler("holds() braucht Bedingung und Dauer: „%s“", b.src)
			}
			return GroesseBool, nil
		case "running":
			if len(b.args) != 1 || b.args[0].t != kName {
				return "", fehler("running() braucht einen Zeitgeber: „%s“", b.src)
			}
			if z, ok := L.zustand[b.args[0].n]; !ok || z.Art != "timer" {
				return "", fehler("running() braucht einen Zeitgeber: „%s“", b.src)
			}
			return GroesseBool, nil
		case "since":
			if len(b.args) != 1 || b.args[0].t != kName {
				return "", fehler("since() braucht einen Schalter oder Zähler: „%s“", b.src)
			}
			if z, ok := L.zustand[b.args[0].n]; !ok || z.Art == "timer" {
				return "", fehler("since() braucht einen Schalter oder Zähler: „%s“", b.src)
			}
			return GroesseDauer, nil
		case "last":
			if len(b.args) != 1 || b.args[0].t != kName {
				return "", fehler("last() braucht einen Zähler: „%s“", b.src)
			}
			if z, ok := L.zustand[b.args[0].n]; !ok || z.Art != "counter" {
				return "", fehler("last() braucht einen Zähler: „%s“", b.src)
			}
			return GroesseWort, nil
		case "in_schedule":
			if len(arten) != 1 || arten[0] != GroessePlan {
				return "", fehler("in_schedule() braucht einen Zeitplan: „%s“", b.src)
			}
			return GroesseBool, nil
		}
		return "", fehler("Unbekannte Funktion %s()", b.f)
	case kBin:
		l, err := g(b.l)
		if err != nil {
			return "", err
		}
		r, err := g(b.r)
		if err != nil {
			return "", err
		}
		switch b.op {
		case "and", "or":
			if l != GroesseBool || r != GroesseBool {
				return "", fehler("„%s“ verbindet Ja/Nein: „%s“", b.op, b.src)
			}
			return GroesseBool, nil
		case "+", "-":
			if l == r && l != GroesseTemp && l != GroesseBool && l != GroesseWort && l != GroessePlan {
				return l, nil
			}
			if l == GroesseTemp && r == GroesseDTemp {
				return GroesseTemp, nil
			}
			if l == GroesseTemp && r == GroesseTemp && b.op == "-" {
				return GroesseDTemp, nil
			}
			return "", fehler("Einheiten passen nicht: %s %s %s in „%s“", nenne(l), b.op, nenne(r), b.src)
		case "*":
			if l == GroesseZahl {
				return r, nil
			}
			if r == GroesseZahl {
				return l, nil
			}
			return "", fehler("Einheiten passen nicht in „%s“", b.src)
		case "/":
			if r == GroesseZahl {
				return l, nil
			}
			return "", fehler("Einheiten passen nicht in „%s“", b.src)
		}
		if l == GroesseBool || r == GroesseBool {
			if l != r || (b.op != "==" && b.op != "!=") {
				return "", fehler("Vergleich mit Ja/Nein in „%s“", b.src)
			}
			return GroesseBool, nil
		}
		if l == GroesseWort || r == GroesseWort {
			if l != r || (b.op != "==" && b.op != "!=") {
				return "", fehler("Wörter lassen sich nur mit == und != vergleichen: „%s“", b.src)
			}
			return GroesseBool, nil
		}
		if l != r {
			return "", fehler("Einheiten passen nicht: %s %s %s in „%s“", nenne(l), b.op, nenne(r), b.src)
		}
		return GroesseBool, nil
	}
	return "", fehler("Unbekannter Knoten")
}

func nenne(x Groesse) string {
	switch x {
	case GroesseBool:
		return "Ja/Nein"
	case GroesseWort:
		return "ein Wort"
	case GroessePlan:
		return "ein Zeitplan"
	}
	return groesseWort[x]
}
