package homeassistant

// Die Logik als Text in der Schreibform: Abschnitte in der Reihenfolge des Vertrags, je
// Eintrag die Herkunft als Kommentar (Datei:Zeile), Hinweise als Kommentar über der Stelle,
// an der sich die Logik anders verhält als Home Assistant.

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type schreiber struct {
	b strings.Builder
}

func (s *schreiber) zeile(einzug int, text string) {
	s.b.WriteString(strings.Repeat(" ", einzug) + text + "\n")
}

// kommentar schreibt einen Satz als Kommentarzeilen, umbrochen nach etwa 110 Zeichen.
func (s *schreiber) kommentar(einzug int, text string) {
	woerter := strings.Fields(text)
	zeile := "#"
	for _, w := range woerter {
		if len([]rune(zeile))+1+len([]rune(w)) > 110 && zeile != "#" {
			s.zeile(einzug, zeile)
			zeile = "#"
		}
		zeile += " " + w
	}
	if zeile != "#" {
		s.zeile(einzug, zeile)
	}
}

var (
	jaNeinWort  = regexp.MustCompile(`^(?i:y|n|yes|no|true|false|on|off|null|~)$`)
	zahlMuster  = regexp.MustCompile(`^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$`)
	zeitMuster  = regexp.MustCompile(`^\d{1,2}:\d{2}`)
	sicherPlain = regexp.MustCompile(`^[^-?:,\[\]{}#&*!|>'"%@` + "`" + `\s]`)
)

// skalar schreibt einen Text so, dass jeder YAML-Leser ihn als denselben Text liest.
func skalar(t string, fluss bool) string {
	braucht := t == "" || !sicherPlain.MatchString(t) || strings.Contains(t, ": ") || strings.Contains(t, " #") ||
		strings.HasSuffix(t, ":") || strings.HasSuffix(t, " ") || jaNeinWort.MatchString(t) || zahlMuster.MatchString(t) ||
		zeitMuster.MatchString(t) || strings.ContainsAny(t, "\n\t\"") || regexp.MustCompile(`^\d+,\d+$`).MatchString(t)
	if fluss && strings.ContainsAny(t, ",[]{}") {
		braucht = true
	}
	if !braucht {
		return t
	}
	if !strings.ContainsAny(t, "'\n\t") {
		return "'" + t + "'"
	}
	return strconv.Quote(t)
}

func anzahl(n int, eins, viele string) string {
	if n == 1 {
		return "1 " + eins
	}
	return strconv.Itoa(n) + " " + viele
}

func (u *uebersetzer) dateienText() string {
	var namen []string
	for n := range u.ha.texte {
		namen = append(namen, n)
	}
	sort.Slice(namen, func(i, j int) bool { return dateiRang(namen[i]) < dateiRang(namen[j]) })
	return strings.Join(namen, ", ")
}

func (u *uebersetzer) logikName() string {
	if u.praefix != "" {
		r := []rune(u.praefix)
		return strings.ToUpper(string(r[0])) + string(r[1:])
	}
	return "Aus Home Assistant"
}

// eintrag ist ein Eintrag der Logik mit den Stellen in den Dateien, aus denen er stammt.
type eintrag struct {
	stelle string
	orte   []Ort
	irs    []*ir
}

func (u *uebersetzer) eintraege() []eintrag {
	var out []eintrag
	for _, e := range u.eingaenge {
		if e.gelesen {
			// ein Eingang bekommt nur Hinweise, die ihn nennen (seine Zeile ist die, an der er zuerst gelesen wird)
			out = append(out, eintrag{stelle: "inputs." + e.kennung})
		}
	}
	for _, st := range u.stellwerte {
		out = append(out, eintrag{stelle: "settings." + st.kennung, orte: []Ort{st.ort}})
	}
	for _, f := range u.formeln {
		out = append(out, eintrag{stelle: "formulas." + f.kennung, orte: []Ort{f.ort}, irs: []*ir{f.e}})
	}
	for _, z := range u.zustaende {
		e := eintrag{stelle: "states." + z.kennung, orte: append([]Ort{z.ort}, z.quellen...)}
		for _, l := range [][]*ir{z.an, z.anEines, z.ausAlle, z.ausEines} {
			e.irs = append(e.irs, l...)
		}
		if z.dauer != nil {
			e.irs = append(e.irs, z.dauer)
		}
		out = append(out, e)
		for _, st := range z.schritte {
			se := eintrag{stelle: "states." + z.kennung + "." + st.name, orte: []Ort{st.ort}}
			se.irs = append(append(se.irs, st.wenn...), st.wennEines...)
			if st.startWenn != nil {
				se.irs = append(se.irs, st.startWenn)
			}
			out = append(out, se)
		}
	}
	for _, g := range u.geraetListe {
		if g.stelle != nil {
			out = append(out, eintrag{stelle: "outputs." + g.kennung, orte: append([]Ort{g.ort}, g.quellen...), irs: []*ir{g.stelle}})
		}
	}
	if u.lage != nil {
		e := eintrag{stelle: "status", orte: []Ort{u.lageOrt}}
		for _, z := range u.lage {
			if z.wenn != nil {
				e.irs = append(e.irs, z.wenn)
			}
		}
		out = append(out, e)
	}
	return out
}

// ordneHinweise gibt jedem Hinweis seinen Eintrag: den genannten, den, dessen Formel den
// Teil enthält, an dem er hängt, sonst den, der in derselben Datei zuletzt davor beginnt.
func (u *uebersetzer) ordneHinweise() {
	es := u.eintraege()
	for i := range u.ergebnis.Hinweise {
		h := &u.ergebnis.Hinweise[i]
		besitzer := ""
		if h.Stelle != "" {
			for _, e := range es {
				if e.stelle == h.Stelle || strings.HasPrefix(e.stelle, h.Stelle+".") {
					besitzer = e.stelle
					break
				}
			}
		}
		if k := u.hinweisKnoten[i]; besitzer == "" && k != nil {
			for _, e := range es {
				for _, x := range e.irs {
					if enthaelt(x, k) {
						besitzer = e.stelle
					}
				}
				if besitzer != "" {
					break
				}
			}
		}
		if besitzer == "" {
			beste := 0
			for _, e := range es {
				for _, o := range e.orte {
					if o.Datei == h.Ort.Datei && o.Zeile <= h.Ort.Zeile && o.Zeile > beste {
						beste, besitzer = o.Zeile, e.stelle
					}
				}
			}
		}
		h.Stelle = besitzer
	}
}

// hinweiseAn schreibt die Hinweise eines Eintrags als Kommentar über ihn.
func (u *uebersetzer) hinweiseAn(s *schreiber, einzug int, stelle string) {
	gesehen := map[string]bool{}
	for _, h := range u.ergebnis.Hinweise {
		if h.Stelle == stelle && !gesehen[h.Text] {
			gesehen[h.Text] = true
			s.kommentar(einzug, "Hinweis: "+h.Text)
		}
	}
}

func (u *uebersetzer) schreibe() string {
	u.ordneHinweise()
	s := &schreiber{}
	s.kommentar(0, "Aus Home Assistant übersetzt: "+u.dateienText()+". Jeder Eintrag nennt seine Herkunft (Datei:Zeile); "+
		"ein Hinweis steht dort, wo die Logik sich anders verhält als Home Assistant.")
	s.zeile(0, "logic: 1")
	s.zeile(0, "name: "+skalar(u.logikName(), false))
	s.zeile(0, "description: "+skalar("Aus Home Assistant übersetzt: "+strings.Join([]string{
		anzahl(len(u.ha.automations), "Automation", "Automationen"), anzahl(len(u.ha.skripte), "Skript", "Skripte"),
		anzahl(len(u.ha.helfer), "Helfer", "Helfer"), anzahl(len(u.ha.vorlagen), "Vorlagen-Sensor", "Vorlagen-Sensoren")}, ", ")+".", false))

	s.zeile(0, "")
	s.zeile(0, "devices:")
	for _, g := range u.geraetListe {
		if !g.geschrieben || g.stelle == nil {
			continue
		}
		entity := g.wert
		if entity == "" {
			entity = "geraet-" + strings.ReplaceAll(g.kennung, "_", "-")
		}
		var ids []string
		for i := 1; i <= g.ausgaenge(); i++ {
			ids = append(ids, g.entities[i])
		}
		s.zeile(2, fmt.Sprintf("%s: {entity: %s, name: %s}   # %s", g.kennung, skalar(entity, true), skalar(g.name, true), strings.Join(ids, ", ")))
	}

	s.zeile(0, "")
	s.zeile(0, "inputs:")
	for _, e := range u.eingaenge {
		if !e.gelesen {
			continue
		}
		q := e.quelle
		if q == "" {
			q = e.platzhalter()
		}
		teile := []string{"source: " + skalar(q, true), "name: " + skalar(e.name, true)}
		if e.maxAlter != "" {
			teile = append(teile, "max_age: "+e.maxAlter)
		}
		herkunft := e.entity
		if e.gedreht {
			herkunft += "; Home Assistant zählt mit umgekehrtem Vorzeichen, gelesen wird deshalb -" + e.kennung
		}
		if e.quelle == "" {
			herkunft += " (Lücke: noch nicht zugeordnet)"
		}
		u.hinweiseAn(s, 2, "inputs."+e.kennung)
		s.zeile(2, fmt.Sprintf("%s: {%s}   # %s", e.kennung, strings.Join(teile, ", "), herkunft))
	}

	if len(u.stellwerte) > 0 {
		s.zeile(0, "")
		s.zeile(0, "settings:")
		for _, st := range u.stellwerte {
			u.hinweiseAn(s, 2, "settings."+st.kennung)
			s.zeile(2, fmt.Sprintf("%s: {%s}   # %s", st.kennung, u.stellwertText(st), st.ort))
		}
	}

	var formeln []*formel
	for _, f := range u.formeln {
		formeln = append(formeln, f)
	}
	if len(formeln) > 0 {
		s.zeile(0, "")
		s.zeile(0, "formulas:")
		for _, f := range formeln {
			u.hinweiseAn(s, 2, "formulas."+f.kennung)
			herkunft := f.ort.String()
			if f.kommentar != "" {
				herkunft += " „" + f.kommentar + "“"
			}
			s.zeile(2, fmt.Sprintf("%s: %s   # %s", f.kennung, skalar(f.e.String(), false), herkunft))
		}
	}

	s.zeile(0, "")
	s.zeile(0, "states:")
	for _, z := range u.geordneteZustaende() {
		u.schreibeZustand(s, z)
	}

	s.zeile(0, "")
	s.zeile(0, "outputs:")
	for _, g := range u.geraetListe {
		if !g.geschrieben || g.stelle == nil {
			continue
		}
		u.hinweiseAn(s, 2, "outputs."+g.kennung)
		s.zeile(2, fmt.Sprintf("%s: {%s: %s}", g.kennung, g.art, skalar(g.stelle.String(), true)))
	}

	s.zeile(0, "")
	s.zeile(0, "status:")
	if u.lage == nil {
		s.kommentar(2, "Die Dateien haben keinen Statustext (Vorlagen-Sensor mit Texten); diese Zeile steht für alle Fälle.")
		s.zeile(2, "- else: true")
		s.zeile(4, "title: "+skalar(u.logikName(), false))
		s.zeile(4, "type: idle")
		s.zeile(4, `text: ""`)
	} else {
		u.hinweiseAn(s, 2, "status")
		s.kommentar(2, "aus "+u.lageOrt.String()+" „"+u.lageName+"“")
		for _, z := range u.lage {
			if z.sonst {
				s.zeile(2, "- else: true")
			} else {
				s.zeile(2, "- when: "+skalar(z.wenn.String(), false))
			}
			s.zeile(4, "title: "+skalar(z.titel, false))
			s.zeile(4, "type: "+z.art)
			s.zeile(4, `text: ""`)
		}
	}
	return s.b.String()
}

func (u *uebersetzer) geordneteZustaende() []*zustand {
	rang := func(z *zustand) int {
		switch {
		case z.sym != nil && z.sym.vorlage != nil:
			return 0
		case z.art == "boolean" && z.sym != nil && z.sym.helfer != nil:
			return 1
		case z.art == "timer":
			return 2
		case z.art == "counter":
			return 3
		}
		return 4
	}
	out := append([]*zustand{}, u.zustaende...)
	sort.SliceStable(out, func(i, j int) bool { return rang(out[i]) < rang(out[j]) })
	return out
}

func bedingungen(s *schreiber, einzug int, schluessel string, l []*ir) {
	if len(l) == 0 {
		return
	}
	if len(l) == 1 {
		s.zeile(einzug, schluessel+": "+skalar(l[0].String(), false))
		return
	}
	s.zeile(einzug, schluessel+":")
	for _, e := range l {
		s.zeile(einzug+2, "- "+skalar(e.String(), false))
	}
}

func (u *uebersetzer) schreibeZustand(s *schreiber, z *zustand) {
	herkunft := z.ort.String()
	if z.sym != nil && z.sym.entity != "" {
		herkunft = z.sym.entity + ", " + herkunft
	}
	u.hinweiseAn(s, 2, "states."+z.kennung)
	for _, k := range z.kommentare {
		s.kommentar(2, k)
	}
	s.zeile(2, z.kennung+":   # "+herkunft)
	s.zeile(4, "name: "+skalar(z.name, false))
	s.zeile(4, "type: "+z.art)
	switch z.art {
	case "boolean":
		bedingungen(s, 4, "on_when", z.an)
		bedingungen(s, 4, "on_when_any", z.anEines)
		bedingungen(s, 4, "off_when", z.ausAlle)
		bedingungen(s, 4, "off_when_any", z.ausEines)
	case "timer":
		s.zeile(4, "duration: "+skalar(z.dauer.String(), false))
	case "counter":
		s.zeile(4, "min: "+strconv.Itoa(z.min))
		s.zeile(4, "max: "+strconv.Itoa(z.max))
	}
	s.zeile(4, "after_restart: "+z.nachNeustart)
	if z.art == "counter" {
		s.zeile(4, "steps:")
		for _, st := range z.schritte {
			u.hinweiseAn(s, 6, "states."+z.kennung+"."+st.name)
			for _, k := range st.kommentare {
				s.kommentar(6, k)
			}
			s.zeile(6, "- name: "+st.name+"   # "+st.ort.String())
			if st.setze != nil {
				s.zeile(8, "set: "+skalar(st.setze.String(), false))
			} else {
				s.zeile(8, fmt.Sprintf("by: %+d", st.um))
			}
			if st.fruehestens != "" {
				s.zeile(8, "not_before: "+st.fruehestens)
			}
			bedingungen(s, 8, "when", st.wenn)
			bedingungen(s, 8, "when_any", st.wennEines)
			if st.startet != "" {
				dann := "start(" + st.startet + ")"
				if st.startWenn != nil {
					dann += " if " + st.startWenn.String()
				}
				s.zeile(8, "then: "+skalar(dann, false))
			}
		}
	}
}

// stellwertText schreibt einen Stellwert als Fluss-Abbildung.
func (u *uebersetzer) stellwertText(st *symbol) string {
	h := st.helfer
	teile := []string{"name: " + skalar(st.name, true)}
	switch st.art {
	case 'W':
		v := "00:00"
		if h.initial != nil {
			v = uhrText(text(h.initial))
		}
		teile = append(teile, "default: "+skalar(v, true))
	case 'P':
		teile = append(teile, "type: select")
		var opts []string
		for _, o := range h.optionen {
			opts = append(opts, optionsWort(o)+": "+skalar(kuerze(o, 30), true))
		}
		v := ""
		if len(h.optionen) > 0 {
			v = optionsWort(h.optionen[0])
		}
		if h.initial != nil {
			v = optionsWort(text(h.initial))
		}
		teile = append(teile, "default: "+v, "options: {"+strings.Join(opts, ", ")+"}")
	default:
		g, ha := st.q.aufgeloest()
		if g == gJaNein {
			v := "off"
			if h.initial != nil && (text(h.initial) == "true" || text(h.initial) == "on") {
				v = "on"
			}
			teile = append(teile, "type: boolean", "default: "+v)
			break
		}
		einheit := func(v float64, schritt bool) string {
			if g == gTemp && schritt {
				return zahlOhneEinheit(v) + " K"
			}
			return zahlText(v, neueGroesse(g, ha))
		}
		vorgabe := 0.0
		switch {
		case h.initial != nil && zahlVon(h.initial) != nil:
			vorgabe = *zahlVon(h.initial)
		case h.min != nil:
			vorgabe = *h.min
		}
		teile = append(teile, "default: "+einheit(vorgabe, false))
		if h.min != nil && h.max != nil {
			teile = append(teile, "range: ["+einheit(*h.min, false)+", "+einheit(*h.max, false)+"]")
		}
		if h.schritt != nil {
			teile = append(teile, "step: "+einheit(*h.schritt, true))
		}
	}
	return strings.Join(teile, ", ")
}
