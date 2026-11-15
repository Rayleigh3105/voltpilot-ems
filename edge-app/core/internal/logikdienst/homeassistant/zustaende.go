package homeassistant

// Zustände, Ausgänge und Lücken: was aus den Wirkungen der Automationen wird, und das
// Falten der Ausgänge eines Geräts (Home Assistant liest jeden Schalter einzeln, die Box
// kennt das Gerät mit seinen Ausgängen).

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

func (u *uebersetzer) wurzel(e **ir, o Ort) {
	u.wurzeln = append(u.wurzeln, e)
	u.wurzelOrt = append(u.wurzelOrt, o)
}

func (u *uebersetzer) wurzelListe(l []*ir, o Ort) {
	for i := range l {
		u.wurzel(&l[i], o)
	}
}

// schalterAus bildet einen Schalter aus den Automationen, die ihn ein- und ausschalten.
func (u *uebersetzer) schalterAus(z *zustand, an, aus []bedListe) {
	stelle := "states." + z.kennung
	switch len(an) {
	case 0:
		u.nichtUebersetzbar(z.ort, z.name, "keine Automation schaltet diesen Helfer ein; ein Zustand der Logik braucht eine Bedingung zum Einschalten")
		return
	case 1:
		z.an = an[0].items
		if len(z.an) == 0 {
			z.an = []*ir{wahr(true)}
		}
	default:
		for _, l := range an {
			z.anEines = append(z.anEines, und(l.items...))
		}
	}
	switch {
	case len(aus) == 1 && len(aus[0].items) == 1 && aus[0].items[0].art == 'o':
		z.ausEines = aus[0].items[0].kinder
	case len(aus) == 1:
		z.ausAlle = aus[0].items
	case len(aus) > 1:
		for _, l := range aus {
			z.ausEines = append(z.ausEines, und(l.items...))
		}
	}
	for _, l := range [][]*ir{z.an, z.anEines, z.ausAlle, z.ausEines} {
		u.wurzelListe(l, z.ort)
	}
	if z.nachNeustart == "" {
		z.nachNeustart = "keep"
		if h := z.sym.helfer; h != nil && h.initial != nil {
			if text(h.initial) == "true" || text(h.initial) == "on" {
				z.nachNeustart = "on"
			} else {
				z.nachNeustart = "off"
			}
		}
	}
	if len(an) > 1 || len(aus) > 1 {
		u.hinweis(z.ort, stelle, fmt.Sprintf("„%s“ ändern mehrere Automationen; in der Logik gilt: an, wenn eine Gruppe von Bedingungen ganz zutrifft, aus gewinnt.", z.name))
	}
}

// seitBedingung erkennt "seit dem letzten Wechsel mehr als N" am eigenen Zähler.
func seitBedingung(x *ir, kennung string) (float64, bool) {
	if x.art != 'v' {
		return 0, false
	}
	l, r, op := x.kinder[0], x.kinder[1], x.text
	if r.art == 'c' && r.text == "since" {
		l, r, op = r, l, umgekehrt(op)
	}
	if l.art != 'c' || l.text != "since" || len(l.kinder) != 1 || l.kinder[0].text != kennung || r.art != 'z' {
		return 0, false
	}
	if op != ">" && op != ">=" {
		return 0, false
	}
	_, ha := r.q.aufgeloest()
	s := r.v
	switch ha {
	case "min":
		s *= 60
	case "h":
		s *= 3600
	}
	return s, true
}

// zaehlerSchritt füllt einen Schritt aus den Bedingungen seiner Automation.
func (u *uebersetzer) zaehlerSchritt(z *zustand, s *schritt, items []*ir, raster float64, au *automation) {
	name := kennungAus(s.name)
	if u.praefix != "" && strings.HasPrefix(name, u.praefix+"_") {
		name = name[len(u.praefix)+1:]
	}
	if name == "" || reservierteWoerter[name] {
		name = "schritt"
	}
	basis := name
	for i := 2; ; i++ {
		frei := true
		for _, x := range z.schritte {
			if x.name == name {
				frei = false
			}
		}
		if frei {
			break
		}
		name = basis + "_" + strconv.Itoa(i)
	}
	s.name = name
	nb := -1.0
	var rest []*ir
	for _, x := range items {
		if sek, ok := seitBedingung(x, z.kennung); ok {
			w := sek
			if raster > 0 {
				w = (math.Floor(sek/raster) + 1) * raster
				u.hinweis(au.ort, "states."+z.kennung+"."+s.name, fmt.Sprintf(
					"Home Assistant prüft „%s“ nur %s (time_pattern); „mehr als %s seit dem letzten Wechsel“ ist so erst nach %s erfüllt. Die Logik prüft jede Sekunde, deshalb steht hier not_before: %s.",
					au.titel(), abstandText(raster), sekundenText(sek), sekundenText(w), sekundenText(w)))
			}
			nb = math.Max(nb, w)
			continue
		}
		rest = append(rest, x)
	}
	if nb >= 0 {
		s.fruehestens = sekundenText(nb)
	}
	oders := 0
	for _, x := range rest {
		if x.art == 'o' {
			oders++
		}
	}
	for _, x := range rest {
		if oders == 1 && x.art == 'o' {
			s.wennEines = x.kinder
			continue
		}
		s.wenn = append(s.wenn, x)
	}
	u.wurzelListe(s.wenn, au.ort)
	u.wurzelListe(s.wennEines, au.ort)
	if s.setze != nil {
		u.wurzel(&s.setze, au.ort)
	}
}

// abstandText: wie oft ein time_pattern prüft ("jede Minute", "alle 5 min").
func abstandText(s float64) string {
	switch s {
	case 1:
		return "jede Sekunde"
	case 60:
		return "jede Minute"
	case 3600:
		return "jede Stunde"
	}
	return "alle " + sekundenText(s)
}

// zaehlerFertig ordnet die Schritte und setzt Grenzen und Neustart.
func (u *uebersetzer) zaehlerFertig(z *zustand, aus []*automation) {
	h := z.sym.helfer
	if len(z.schritte) == 0 {
		u.nichtUebersetzbar(z.ort, z.name, "diesen Zähler ändert nur der Start von Home Assistant; ohne Schritte ist er ein Stellwert, kein Zustand")
		return
	}
	if h == nil || h.min == nil || h.max == nil || *h.min != math.Trunc(*h.min) || *h.max != math.Trunc(*h.max) {
		u.nichtUebersetzbar(z.ort, z.name, "ein Zähler braucht ganze Grenzen (min und max)")
		return
	}
	z.min, z.max = int(*h.min), int(*h.max)
	rang := func(s *schritt) int {
		switch {
		case s.setze != nil:
			return 1
		case s.um < 0:
			return 0
		}
		return 2
	}
	sort.SliceStable(z.schritte, func(i, j int) bool { return rang(z.schritte[i]) < rang(z.schritte[j]) })
	if len(aus) > 1 {
		var namen []string
		for _, a := range aus {
			namen = append(namen, "„"+a.titel()+"“")
		}
		u.hinweis(z.ort, "states."+z.kennung, fmt.Sprintf(
			"In Home Assistant ändern %s diesen Wert unabhängig voneinander; welche zuerst prüft, hängt vom Start von Home Assistant ab. Hier gilt je Takt der erste zutreffende Schritt, die zurücknehmenden zuerst.",
			strings.Join(namen, " und ")))
	}
	if z.nachNeustart == "" {
		z.nachNeustart = "keep"
		if v := zahlVon(h.initial); v != nil {
			z.nachNeustart = strconv.Itoa(int(*v))
		}
	}
}

// zeitgeberDauer übernimmt die Dauer, mit der eine Automation den Zeitgeber startet.
func (u *uebersetzer) zeitgeberDauer(z *zustand, w wirkung) {
	if w.dauer == nil {
		return
	}
	if z.dauer != nil && z.dauer.String() != w.dauer.String() {
		u.nichtUebersetzbar(w.ort, z.name, "der Zeitgeber wird mit verschiedenen Dauern gestartet; in der Logik hat er eine Dauer")
		return
	}
	z.dauer = w.dauer
	u.wurzel(&z.dauer, w.ort)
	if w.dauer.art != 'z' && z.sym.helfer.dauer != nil {
		u.hinweis(z.ort, "states."+z.kennung, fmt.Sprintf(
			"Startet Home Assistant den Zeitgeber mit der Dauer 0, läuft er seine eingestellte Dauer (%s); in der Logik startet eine Dauer von 0 nicht.",
			sekundenText(*z.sym.helfer.dauer)))
	}
}

// nachNeustart: eine Automation, die nur beim Start läuft, legt fest, womit die Zustände beginnen.
func (u *uebersetzer) nachNeustart(au *automation, ws []wirkung) {
	for _, w := range ws {
		z := w.symbol.zustand
		if !w.bed.istWahr(true) {
			u.nichtUebersetzbar(w.ort, au.titel(), "beim Start mit einer Bedingung zu setzen lässt sich nicht übersetzen")
			continue
		}
		switch w.art {
		case "bool_an":
			z.nachNeustart = "on"
		case "bool_aus":
			z.nachNeustart = "off"
		case "setze":
			if w.setze.art != 'z' {
				u.nichtUebersetzbar(w.ort, au.titel(), "beim Start einen gerechneten Wert zu setzen lässt sich nicht übersetzen")
				continue
			}
			z.nachNeustart = zahlOhneEinheit(w.setze.v)
		case "timer_stop":
			z.nachNeustart = "off"
		case "schalter_an", "schalter_aus":
			u.hinweis(w.ort, "", "Beim Start setzt Home Assistant hier einen Schalter; die Box setzt die Ausgänge nach einem Neustart aus der Logik.")
		default:
			u.nichtUebersetzbar(w.ort, au.titel(), "beim Start lässt sich nur setzen, nicht zählen oder starten")
			continue
		}
		if z != nil {
			z.kommentare = append(z.kommentare, fmt.Sprintf("Nach einem Neustart: wie „%s“ (%s).", au.titel(), au.ort))
		}
	}
}

// stufeAus erkennt "Ausgang k ist an, wenn k <= E".
func stufeAus(c *ir, k int) (*ir, bool) {
	if c.art != 'v' {
		return nil, false
	}
	l, r := c.kinder[0], c.kinder[1]
	kf := float64(k)
	switch c.text {
	case "<=":
		if l.istZahl(kf) {
			return r, true
		}
	case ">=":
		if r.istZahl(kf) {
			return l, true
		}
	case "<":
		if l.istZahl(kf - 1) {
			return r, true
		}
	case ">":
		if r.istZahl(kf - 1) {
			return l, true
		}
	}
	return nil, false
}

// bildeAusgaenge: was jedes Gerät tun soll.
func (u *uebersetzer) bildeAusgaenge() {
	for _, g := range u.geraetListe {
		if !g.geschrieben {
			continue
		}
		n := g.ausgaenge()
		for i := 1; i <= n; i++ {
			if _, ok := g.entities[i]; !ok {
				u.nichtUebersetzbar(g.ort, g.stamm, fmt.Sprintf("dem Gerät „%s“ fehlt der Ausgang %d; die Schalter eines Geräts sind fortlaufend nummeriert", g.stamm, i))
				return
			}
		}
		ein := make([]*ir, n+1)
		zustandslos := true
		for i := 1; i <= n; i++ {
			ein[i] = oder(g.an[i]...)
			ausI := oder(g.aus[i]...)
			if len(g.an[i]) == 0 || len(g.aus[i]) == 0 || ausI.String() != nicht(ein[i]).String() {
				zustandslos = false
			}
		}
		switch {
		case zustandslos && n == 1:
			g.art, g.stelle = "on_off", ein[1]
		case zustandslos:
			var stufe *ir
			gleich := true
			for i := 1; i <= n && gleich; i++ {
				e, ok := stufeAus(ein[i], i)
				if !ok || (stufe != nil && e.String() != stufe.String()) {
					gleich = false
					break
				}
				stufe = e
			}
			if gleich {
				g.art, g.stelle = "level", stufe
				break
			}
			gleich = true
			for i := 2; i <= n; i++ {
				if ein[i].String() != ein[1].String() {
					gleich = false
				}
			}
			if !gleich {
				u.nichtUebersetzbar(g.ort, g.stamm, fmt.Sprintf("die Ausgänge von „%s“ folgen keiner Stufe (Ausgang k an, wenn die Stufe mindestens k ist) und schalten nicht gemeinsam", g.stamm))
				continue
			}
			g.art, g.stelle = "level", wenn(ein[1], zahl(float64(n), neueGroesse(gZahl, "")), zahl(0, neueGroesse(gZahl, "")))
		case n == 1:
			z := &zustand{kennung: u.kennungOhnePraefix(g.stamm + "_an"), name: kuerze(nameAus(g.stamm)+" an", 40), art: "boolean",
				ort: g.ort, nachNeustart: "keep"}
			z.sym = &symbol{art: 'B', kennung: z.kennung, zustand: z}
			z.anEines = g.an[1]
			z.ausEines = g.aus[1]
			if len(z.anEines) == 0 {
				u.nichtUebersetzbar(g.ort, g.stamm, "keine Automation schaltet „"+g.entities[1]+"“ ein")
				continue
			}
			u.wurzelListe(z.anEines, g.ort)
			u.wurzelListe(z.ausEines, g.ort)
			z.kommentare = append(z.kommentare, "Automationen schalten „"+g.entities[1]+"“ ein und aus; in der Logik merkt sich dieser Schalter, ob das Gerät an sein soll.")
			u.zustaende = append(u.zustaende, z)
			g.zustand = z
			g.art, g.stelle = "on_off", name(z.kennung, neueGroesse(gJaNein, ""))
		default:
			u.nichtUebersetzbar(g.ort, g.stamm, fmt.Sprintf("die Ausgänge von „%s“ schalten Automationen einzeln ein und aus; das lässt sich nur bei einem Gerät mit einem Ausgang übersetzen", g.stamm))
			continue
		}
		u.wurzel(&g.stelle, g.ort)
	}
}

// ersetze baut einen Baum neu, von unten nach oben.
func ersetze(e *ir, f func(*ir) *ir) *ir {
	if e == nil {
		return nil
	}
	if len(e.kinder) > 0 {
		neu := make([]*ir, len(e.kinder))
		anders := false
		for i, c := range e.kinder {
			neu[i] = ersetze(c, f)
			anders = anders || neu[i] != c
		}
		if anders {
			k := *e
			k.kinder = neu
			e = &k
		}
	}
	return f(e)
}

// falteAlles: Vorzeichen-Schalter fallen weg, einzelne Ausgänge werden zum Gerät.
func (u *uebersetzer) falteAlles() {
	u.vorzeichenSchalter()
	for i, r := range u.wurzeln {
		*r = ersetze(*r, zeitfenster)
		*r = ersetze(*r, u.falte)
		var rest *ir
		(*r).besuche(func(e *ir) {
			if (e.art == 'A' || e.art == 'H') && rest == nil {
				rest = e
			}
		})
		if rest != nil {
			g := u.geraete[rest.text]
			was := "den Schalter"
			if rest.art == 'H' {
				was = "die Laufzeit"
			}
			u.nichtUebersetzbar(u.wurzelOrt[i], g.entities[int(rest.v)], fmt.Sprintf(
				"liest %s eines einzelnen Ausgangs; die Box kennt Stand und Laufzeit je Gerät (alle Ausgänge zusammen)", was))
		}
	}
}

// uhrLinks schreibt einen Vergleich mit clock so, dass clock links steht (für den Vergleich von Formen).
func uhrLinks(e *ir) string {
	return ersetze(e, func(x *ir) *ir {
		if x.art == 'v' && x.kinder[1].art == 'k' && x.kinder[0].art != 'k' {
			return &ir{art: 'v', text: umgekehrt(x.text), kinder: []*ir{x.kinder[1], x.kinder[0]}}
		}
		return x
	}).String()
}

// zeitfenster erkennt die Vorlage eines Zeitfensters (gleich heißt rund um die Uhr, über
// Mitternacht erlaubt, "von" zählt mit, "bis" nicht) und schreibt time_window(von, bis).
func zeitfenster(e *ir) *ir {
	if e.art != 'c' || e.text != "if" || !e.kinder[1].istWahr(true) {
		return e
	}
	c1, innen := e.kinder[0], e.kinder[2]
	if c1.art != 'v' || c1.text != "==" || innen.art != 'c' || innen.text != "if" {
		return e
	}
	von, bis := c1.kinder[0], c1.kinder[1]
	if g, _ := von.groesse().aufgeloest(); g != gUhrzeit {
		return e
	}
	a, b := von.String(), bis.String()
	if uhrLinks(innen.kinder[0]) == a+" < "+b && uhrLinks(innen.kinder[1]) == "clock >= "+a+" and clock < "+b &&
		uhrLinks(innen.kinder[2]) == "clock >= "+a+" or clock < "+b {
		return aufruf("time_window", neueGroesse(gJaNein, ""), von, bis)
	}
	return e
}

func (u *uebersetzer) geraetName(g *geraet, eig string, q *groesse) *ir {
	return name(g.kennung+"."+eig, q)
}

// falte macht aus Lesungen aller Ausgänge eines Geräts eine Eigenschaft des Geräts.
func (u *uebersetzer) falte(e *ir) *ir {
	switch e.art {
	case 'A', 'H':
		g := u.geraete[e.text]
		if g.ausgaenge() == 1 {
			if e.art == 'A' {
				return u.geraetName(g, "on", neueGroesse(gJaNein, ""))
			}
			return u.geraetName(g, "output_hours_today", e.q)
		}
		return e
	case 'o':
		gruppen := map[string]map[int]bool{}
		for _, k := range e.kinder {
			if k.art == 'A' {
				if gruppen[k.text] == nil {
					gruppen[k.text] = map[int]bool{}
				}
				gruppen[k.text][int(k.v)] = true
			}
		}
		var neu []*ir
		erledigt := map[string]bool{}
		for _, k := range e.kinder {
			if k.art == 'A' && u.vollstaendig(k.text, gruppen[k.text]) {
				if !erledigt[k.text] {
					erledigt[k.text] = true
					neu = append(neu, u.geraetName(u.geraete[k.text], "on", neueGroesse(gJaNein, "")))
				}
				continue
			}
			neu = append(neu, k)
		}
		return oder(neu...)
	case 'b':
		if e.text != "+" && e.text != "-" {
			return e
		}
		type term struct {
			minus bool
			e     *ir
		}
		var terme []term
		var flach func(x *ir, minus bool)
		flach = func(x *ir, minus bool) {
			if x.art == 'b' && (x.text == "+" || x.text == "-") {
				flach(x.kinder[0], minus)
				flach(x.kinder[1], minus != (x.text == "-"))
				return
			}
			terme = append(terme, term{minus, x})
		}
		flach(e, false)
		schluessel := func(t term) (string, *geraet, int, *ir) {
			x := t.e
			switch {
			case x.art == 'H':
				return fmt.Sprintf("H|%s|%v", x.text, t.minus), u.geraete[x.text], int(x.v), nil
			case x.art == 'c' && x.text == "if" && x.kinder[0].art == 'A' && x.kinder[2].istZahl(0):
				c := x.kinder[1]
				return fmt.Sprintf("A|%s|%s|%v", x.kinder[0].text, c.String(), t.minus), u.geraete[x.kinder[0].text], int(x.kinder[0].v), c
			}
			return "", nil, 0, nil
		}
		gruppen := map[string]map[int]bool{}
		for _, t := range terme {
			if k, _, i, _ := schluessel(t); k != "" {
				if gruppen[k] == nil {
					gruppen[k] = map[int]bool{}
				}
				gruppen[k][i] = true
			}
		}
		var neu []term
		erledigt := map[string]bool{}
		for _, t := range terme {
			k, g, _, c := schluessel(t)
			if k == "" || !u.vollstaendig(g.stamm, gruppen[k]) {
				neu = append(neu, t)
				continue
			}
			if erledigt[k] {
				continue
			}
			erledigt[k] = true
			if c == nil {
				neu = append(neu, term{t.minus, u.geraetName(g, "output_hours_today", t.e.q)})
				continue
			}
			stufe := u.geraetName(g, "level", neueGroesse(gZahl, ""))
			if c.istZahl(1) {
				neu = append(neu, term{t.minus, stufe})
			} else {
				neu = append(neu, term{t.minus, rechne("*", stufe, c)})
			}
		}
		if len(neu) == len(terme) {
			return e
		}
		out := neu[0].e
		if neu[0].minus {
			out = neg(out)
		}
		for _, t := range neu[1:] {
			if t.minus {
				out = rechne("-", out, t.e)
			} else {
				out = rechne("+", out, t.e)
			}
		}
		return out
	}
	return e
}

func (u *uebersetzer) vollstaendig(stamm string, indizes map[int]bool) bool {
	g := u.geraete[stamm]
	n := g.ausgaenge()
	if len(indizes) != n {
		return false
	}
	for i := 1; i <= n; i++ {
		if !indizes[i] {
			return false
		}
	}
	return true
}

// vorzeichenSchalter: ein Schalter, der nur das Vorzeichen eines Messwerts dreht
// (if(invertiert, x, -x)), entfällt; das Vorzeichen legt die Zuordnung des Eingangs fest.
func (u *uebersetzer) vorzeichenSchalter() {
	var bleiben []*symbol
	for _, s := range u.stellwerte {
		if s.art != 'S' || s.helfer == nil || s.helfer.art != "input_boolean" {
			bleiben = append(bleiben, s)
			continue
		}
		dreht, sonst := 0, 0
		var gedreht []string
		for _, r := range u.wurzeln {
			(*r).besuche(func(e *ir) {
				if e.art == 'r' && e.text == s.kennung {
					sonst++
				}
				if e.art == 'c' && e.text == "if" && e.kinder[0].art == 'r' && e.kinder[0].text == s.kennung &&
					(e.kinder[1].String() == neg(e.kinder[2]).String() || neg(e.kinder[1]).String() == e.kinder[2].String()) {
					dreht++
					e.kinder[2].besuche(func(x *ir) {
						if x.art == 'r' {
							gedreht = append(gedreht, x.text)
						}
					})
				}
			})
		}
		if dreht == 0 || dreht != sonst {
			bleiben = append(bleiben, s)
			continue
		}
		an := s.helfer.initial != nil && (text(s.helfer.initial) == "true" || text(s.helfer.initial) == "on")
		for _, r := range u.wurzeln {
			*r = ersetze(*r, func(e *ir) *ir {
				if e.art == 'c' && e.text == "if" && e.kinder[0].art == 'r' && e.kinder[0].text == s.kennung {
					if an {
						return e.kinder[1]
					}
					return e.kinder[2]
				}
				return e
			})
		}
		u.vergeben[s.kennung] = false
		stelle := ""
		for _, e := range u.eingaenge {
			for _, g := range gedreht {
				if e.kennung == g && stelle == "" {
					stelle = "inputs." + e.kennung
				}
			}
		}
		u.hinweis(s.ort, stelle, fmt.Sprintf("Der Schalter „%s“ drehte in Home Assistant das Vorzeichen von %s. In der Logik legt die Zuordnung des Eingangs das Vorzeichen fest (Netz: + ist Bezug, Batterie: + ist Laden); der Schalter entfällt, gerechnet wird wie mit ihm %s.",
			s.name, strings.Join(eindeutig(gedreht), ", "), map[bool]string{true: "an", false: "aus"}[an]))
	}
	u.stellwerte = bleiben
}

func eindeutig(xs []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// pruefeGelesen: was die Logik liest, muss sie auch haben.
func (u *uebersetzer) pruefeGelesen() {
	for _, s := range u.symbole {
		if s.art == 'L' && s.gelesen {
			u.nichtUebersetzbar(s.ort, s.name, "der Statustext wird an anderer Stelle gelesen; die Lage ist in der Logik nur für den Kunden")
		}
	}
	for _, g := range u.geraetListe {
		if g.geschrieben {
			continue
		}
		gelesen := false
		for _, s := range u.symbole {
			if (s.art == 'A' || s.art == 'H') && s.geraet == g && s.gelesen {
				gelesen = true
			}
		}
		if gelesen {
			var ids []string
			for _, id := range g.entities {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			u.nichtUebersetzbar(g.ort, strings.Join(ids, ", "), "die Logik liest diesen Schalter, schaltet ihn aber nicht; Stand und Laufzeit liest sie nur von Geräten, die sie schaltet")
		}
	}
}

// groesseAusName schätzt die Größe eines Messwerts aus seiner Kennung und seinem Namen,
// wenn keine Stelle der Dateien sie nennt.
func groesseAusName(s string) string {
	s = strings.ToLower(s)
	hat := func(ws ...string) bool {
		for _, w := range ws {
			if strings.Contains(s, w) {
				return true
			}
		}
		return false
	}
	switch {
	case hat("temp", "fuehler", "fühler", "fuhler", "vorlauf", "ruecklauf", "rücklauf", "puffer"):
		return gTemp
	case hat("power", "leistung", "watt"):
		return gLeistung
	case hat("soc", "ladestand", "state_of_charge", "battery_level", "feuchte", "humidity"):
		return gProzent
	}
	return ""
}

// quellenGroesse: welche Größe eine Quelle der Box liefert.
func quellenGroesse(q string) string {
	switch q {
	case "site.grid", "site.pv", "battery.power":
		return gLeistung
	case "battery.soc":
		return gProzent
	case "sun.elevation":
		return gWinkel
	case "price.current":
		return gZahl
	}
	_, signal, _ := strings.Cut(q, ".")
	switch signal {
	case "temperature", "room_temperature", "outdoor_temperature", "supply_temperature", "return_temperature":
		return gTemp
	case "humidity":
		return gProzent
	case "open", "door_open", "defrost", "fault", "running":
		return gJaNein
	}
	return ""
}

var groesseWort = map[string]string{gTemp: "temperatur", gLeistung: "leistung", gProzent: "prozent", gWinkel: "winkel", gJaNein: "ja_nein", gZahl: "zahl"}

// bildeLuecken nennt die Geräte und Messwerte, die der Mensch der Anlage zuordnet.
func (u *uebersetzer) bildeLuecken() {
	for _, g := range u.geraetListe {
		if !g.geschrieben || g.stelle == nil {
			continue
		}
		var ids []string
		for i := 1; i <= g.ausgaenge(); i++ {
			ids = append(ids, g.entities[i])
		}
		l := Luecke{Kennung: g.kennung, Art: "geraet", Name: nameAus(g.stamm), Entities: ids, Ausgaenge: g.ausgaenge(),
			Ausgang: g.art, Orte: []Ort{g.ort}}
		g.name = l.Name
		if z, ok := u.zuordnung[g.kennung]; ok && z.Wert != "" {
			l.Wert, g.wert = z.Wert, z.Wert
			if z.Name != "" {
				g.name = kuerze(z.Name, 40)
			}
		}
		u.ergebnis.Luecken = append(u.ergebnis.Luecken, l)
	}
	for _, s := range u.eingaenge {
		if !s.gelesen || s.art == 'U' {
			if s.art == 'U' {
				s.maxAlter = ""
			}
			continue
		}
		g, ha := s.q.aufgeloest()
		if g == gUnbekannt {
			u.nichtUebersetzbar(s.ort, s.entity, "dieser Messwert wird mit Werten verschiedener Größe verrechnet oder verglichen (etwa °C und W)")
			continue
		}
		// Was die Dateien nicht sagen, sagt die Zuordnung; ohne sie ist die Größe offen.
		offen := g == gZahl || g == gOffen
		l := Luecke{Kennung: s.kennung, Art: "eingang", Name: s.name, Entities: []string{s.entity}, Groesse: groesseWort[g], Orte: []Ort{s.ort}}
		if offen {
			l.Groesse = ""
			switch geschaetzt := groesseAusName(s.entity + " " + s.name); {
			case s.zugeordneteGroesse != "":
				g = s.zugeordneteGroesse
			case geschaetzt != "":
				g, l.Groesse, l.Geschaetzt = geschaetzt, groesseWort[geschaetzt], true
			default:
				g = gTemp // nur für den Platzhalter, bis die Lücke zugeordnet ist
			}
			vereinige(s.q, neueGroesse(g, ""))
		}
		if g == gLeistung && ha == "" {
			u.hinweis(s.ort, "inputs."+s.kennung, "Welche Einheit „"+s.entity+"“ in Home Assistant hat, steht in keiner Datei; die Zahlen daneben sind als W gelesen, wie Home Assistant Leistungen meist meldet. Meldet der Sensor kW, ändern Sie sie im Text.")
		}
		if s.quelle != "" {
			l.Wert = s.quelle
			if s.gedreht {
				l.Wert = "-" + s.quelle
			}
			switch {
			case quellenGroesse(s.quelle) != g:
				l.Fehler = "Diese Quelle liefert keine " + map[string]string{gTemp: "Temperatur", gLeistung: "Leistung", gProzent: "Prozent", gWinkel: "Winkel", gJaNein: "Ja/Nein-Werte"}[g] + "."
				s.quelle, s.gedreht = "", false
			case s.gedreht && g != gLeistung:
				l.Fehler = "Das Vorzeichen lässt sich nur bei einer Leistung drehen."
				s.gedreht = false
			}
		}
		switch g {
		case gLeistung:
			s.maxAlter = "60 s"
		default:
			s.maxAlter = "5 min"
		}
		u.ergebnis.Luecken = append(u.ergebnis.Luecken, l)
	}
}

// platzhalter: die Quelle eines Eingangs, solange die Lücke offen ist.
func (s *symbol) platzhalter() string {
	g, _ := s.q.aufgeloest()
	k := strings.ReplaceAll(s.kennung, "_", "-")
	switch g {
	case gLeistung:
		return "site.grid"
	case gProzent:
		return "battery.soc"
	case gWinkel:
		return "sun.elevation"
	case gJaNein:
		return "quelle-" + k + ".open"
	}
	return "quelle-" + k + ".temperature"
}
