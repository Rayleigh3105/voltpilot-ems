package logik

import (
	"fmt"
	"strings"
)

// Die Prüfung vor dem Scharfschalten, Punkte 1 bis 3 des Vertrags:
//   1. Aufbau und Einheiten: jeder Ausdruck lesbar, jeder Name bekannt, Einheiten passen,
//      keine Formel hängt von sich selbst ab; Geräte und Ausgänge passen zueinander.
//   2. Stellwerte: Vorgabe im Bereich, Bedingungen unter constraints erfüllt; ein Zielwert
//      (Stellwert in °C) braucht einen Bereich (E2 = B).
//   3. Proben: jeder Fall wird durchgespielt. Proben sind freiwillig (E5 = C); eine
//      vorhandene Probe, die nicht besteht, sperrt weiter.
// Die Punkte 4 bis 6 (Ausfall, Flattern, Schutzzeiten) sind Hinweise der Oberfläche und
// kein Teil dieses Pakets. Ob ein Gerät existiert, freigegeben und unbeansprucht ist,
// prüft die Auslieferung (Regel V-5 des Graphvertrags), nicht der Kern.

// Befund ist ein sperrender Fund der Prüfung.
type Befund struct {
	Text string
	// Ort ist die Stelle im Dokument, in der Schreibweise der Meldungen des Lesers:
	// Schlüssel mit Punkten, Listenplätze ab 1 in eckigen Klammern
	// („states.warm.on_when[1]“, „tests[2]“). Damit stellt eine Oberfläche den Befund an
	// seine Zeile (Dienst neben der API, Stufe 4); leer, wo der Befund keine Stelle hat.
	Ort string
}

// ZusammenStand ist eine Bedingung zwischen Stellwerten mit ihrem Stand.
type ZusammenStand struct {
	Name       string
	Gilt       bool
	Verletzbar bool // im erlaubten Bereich verletzbar: die Oberfläche begrenzt den Regler
}

// Pruefbericht ist das Ergebnis der Prüfung einer Logik.
type Pruefbericht struct {
	Ausdruecke int
	Befunde    []Befund
	Zusammen   []ZusammenStand
	Proben     []*ProbenErgebnis
	Hinweise   []string
}

// Sperrt sagt, ob die Prüfung das Scharfschalten sperrt: Befunde aus Aufbau und
// Stellwerten oder eine vorhandene Probe, die nicht besteht (E5 = C).
func (b *Pruefbericht) Sperrt() bool {
	if len(b.Befunde) > 0 {
		return true
	}
	for _, p := range b.Proben {
		if !p.Bestanden {
			return true
		}
	}
	return false
}

type ausdruckOrt struct {
	ort  string
	pfad string // die Stelle des Ausdrucks samt Listenplatz (Befund.Ort)
	baum *baum
	soll Groesse // "" heißt: nur lesbar und einheitenrein
}

func (L *Logik) alleAusdruecke() []ausdruckOrt {
	var out []ausdruckOrt
	liste := func(wo string, liste []Bedingung, soll Groesse) {
		for i, b := range liste {
			out = append(out, ausdruckOrt{ort: wo, pfad: fmt.Sprintf("%s[%d]", wo, i+1), baum: b.Baum, soll: soll})
		}
	}
	for _, n := range L.MerkerListe {
		out = append(out, ausdruckOrt{ort: "formulas." + n, pfad: "formulas." + n, baum: L.Merker[n]})
	}
	for _, e := range L.Zustaende {
		for _, teil := range []struct {
			feld  string
			liste []Bedingung
		}{{"on_when", e.An}, {"on_when_any", e.AnEines}, {"off_when", e.Aus}, {"off_when_any", e.AusEines}} {
			liste("states."+e.Kennung+"."+teil.feld, teil.liste, GroesseBool)
		}
		if e.Art == "timer" {
			wo := "states." + e.Kennung + ".duration"
			out = append(out, ausdruckOrt{ort: wo, pfad: wo, baum: e.Dauer, soll: GroesseDauer})
		}
		for i, s := range e.Schritte {
			ort := "states." + e.Kennung + "." + s.Name
			pfad := fmt.Sprintf("states.%s.steps[%d]", e.Kennung, i+1)
			for j, b := range s.Alle {
				out = append(out, ausdruckOrt{ort: ort + ".when", pfad: fmt.Sprintf("%s.when[%d]", pfad, j+1), baum: b.Baum, soll: GroesseBool})
			}
			for j, b := range s.Eines {
				out = append(out, ausdruckOrt{ort: ort + ".when_any", pfad: fmt.Sprintf("%s.when_any[%d]", pfad, j+1), baum: b.Baum, soll: GroesseBool})
			}
			if s.Setze != nil {
				out = append(out, ausdruckOrt{ort: ort + ".set", pfad: pfad + ".set", baum: s.Setze, soll: GroesseZahl})
			}
			if s.FruehestensBaum != nil {
				out = append(out, ausdruckOrt{ort: ort + ".not_before", pfad: pfad + ".not_before", baum: s.FruehestensBaum, soll: GroesseDauer})
			}
			if s.DannWenn != nil {
				out = append(out, ausdruckOrt{ort: ort + ".then", pfad: pfad + ".then", baum: s.DannWenn, soll: GroesseBool})
			}
		}
	}
	soll := map[string]Groesse{"level": GroesseZahl, "on_off": GroesseBool, "setpoint": "", "mode": GroesseWort, "percent": GroesseProzent}
	for _, g := range L.AusgangListe {
		for art, b := range L.Ausgaenge[g] {
			wo := "outputs." + g + "." + art
			out = append(out, ausdruckOrt{ort: wo, pfad: wo, baum: b, soll: soll[art]})
		}
	}
	for i, m := range L.Meldungen {
		wo := fmt.Sprintf("notifications[%d].when", i+1)
		out = append(out, ausdruckOrt{ort: wo, pfad: wo, baum: m.Wenn, soll: GroesseBool})
	}
	if L.Anzeige != nil {
		var anzeigeSoll Groesse
		if e, ok := L.Werte[L.Anzeige.Wert]; ok {
			if e.GroesseBool {
				anzeigeSoll = GroesseBool
			} else {
				anzeigeSoll = e.Groesse
			}
		}
		for i, m := range L.Anzeige.Marken {
			out = append(out, ausdruckOrt{ort: "display.marks." + m.Name, pfad: fmt.Sprintf("display.marks[%d].at", i+1), baum: m.Bei, soll: anzeigeSoll})
		}
	}
	for i, z := range L.Lage {
		if !z.Sonst {
			wo := fmt.Sprintf("status[%d].when", i+1)
			out = append(out, ausdruckOrt{ort: wo, pfad: wo, baum: z.Wenn, soll: GroesseBool})
		}
	}
	for i, z := range L.Zusammen {
		out = append(out, ausdruckOrt{ort: "constraints", pfad: fmt.Sprintf("constraints[%d]", i+1), baum: z.Baum, soll: GroesseBool})
	}
	return out
}

// Namen, die kein Verfasser vergeben darf (Vertrag 17.2: die YAML-Falle).
var verboteneNamen = map[string]bool{"on": true, "off": true, "yes": true, "no": true, "true": true, "false": true}

// Pruefe prüft Aufbau, Einheiten und Stellwerte und lässt die Proben laufen.
func (L *Logik) Pruefe(anlage map[string]ProbenGeraet) *Pruefbericht {
	b := &Pruefbericht{}
	fehl := func(ort, format string, a ...any) {
		b.Befunde = append(b.Befunde, Befund{Text: fmt.Sprintf(format, a...), Ort: ort})
	}

	// Punkt 1: Aufbau und Einheiten.
	alle := L.alleAusdruecke()
	b.Ausdruecke = len(alle)
	for _, a := range alle {
		d, err := L.groesse(a.baum, nil)
		if err != nil {
			fehl(a.pfad, "%s: %s", a.ort, err.Error())
			continue
		}
		if a.soll != "" && d != a.soll {
			fehl(a.pfad, "%s: erwartet %s, ist %s („%s“)", a.ort, nenne(a.soll), nenne(d), a.baum.src)
		}
		if strings.HasSuffix(a.ort, ".setpoint") {
			switch d {
			case GroesseBool, GroesseWort, GroessePlan, GroesseZahl:
				fehl(a.pfad, "%s: ein Sollwert braucht eine Einheit („%s“)", a.ort, a.baum.src)
			}
		}
	}
	// Eine Betriebsart, die im Text fest steht, muss das Gerät kennen, wenn die Anlage seine
	// Liste nennt (Klima, Heizung, Kälte: die geschlossene Liste je Gerät).
	for _, g := range L.AusgangListe {
		b, ok := L.Ausgaenge[g]["mode"]
		if !ok || len(anlage[g].Betriebsarten) == 0 {
			continue
		}
		for _, w := range festeBetriebsarten(b) {
			if !kenntBetriebsart(GeraetStamm{Betriebsarten: anlage[g].Betriebsarten}, w) {
				fehl("outputs."+g+".mode", "outputs.%s.mode: das Gerät kennt die Betriebsart „%s“ nicht (es kennt %s)", g, w,
					strings.Join(anlage[g].Betriebsarten, ", "))
			}
		}
	}
	if L.Anzeige != nil {
		if _, ok := L.Werte[L.Anzeige.Wert]; !ok {
			fehl("display.input", "display.input: „%s“ steht nicht unter inputs", L.Anzeige.Wert)
		}
	}
	for _, g := range L.GeraetListe {
		if _, ok := L.Ausgaenge[g]; !ok {
			fehl("devices."+g, "Gerät „%s“ wird beansprucht, bekommt aber keinen Ausgang", g)
		}
	}
	for _, g := range L.AusgangListe {
		if _, ok := L.Geraete[g]; !ok {
			fehl("outputs."+g, "Ausgang für „%s“, das Gerät steht nicht unter devices", g)
		}
	}
	if len(L.Lage) == 0 || !L.Lage[len(L.Lage)-1].Sonst {
		fehl(fmt.Sprintf("status[%d]", len(L.Lage)), "Die letzte Zeile der Lage muss „else“ sein, damit immer ein Satz gilt")
	}
	pruefeText := func(wo, ort, text string) {
		rest := text
		for {
			i := strings.IndexByte(rest, '{')
			if i < 0 {
				return
			}
			j := strings.IndexByte(rest[i:], '}')
			if j < 0 {
				return
			}
			formel := rest[i+1 : i+j]
			rest = rest[i+j+1:]
			baum, err := lies(formel)
			if err != nil {
				fehl(ort, "%s: %s", wo, err.Error())
				continue
			}
			if _, err := L.groesse(baum, nil); err != nil {
				fehl(ort, "%s: %s", wo, err.Error())
			}
		}
	}
	for i, z := range L.Lage {
		pruefeText("Satz „"+z.Titel+"“", fmt.Sprintf("status[%d].text", i+1), z.Satz)
	}
	for i, m := range L.Meldungen {
		pruefeText(fmt.Sprintf("Meldung %d", i+1), fmt.Sprintf("notifications[%d].text", i+1), m.Satz)
	}
	for _, n := range L.StellListe {
		s := L.Stellwerte[n]
		switch h := s.Hilfe.(type) {
		case string:
			pruefeText("Hilfe zu „"+s.Name+"“", "settings."+n+".help", h)
		case [2]string:
			pruefeText("Hilfe zu „"+s.Name+"“", "settings."+n+".help.when_on", h[0])
			pruefeText("Hilfe zu „"+s.Name+"“", "settings."+n+".help.when_off", h[1])
		}
	}
	// Die Sätze für den Kunden im Blatt „Warum?“: Platzhalter wie in der Lage; fehlt einer für eine
	// Gruppe, die das Blatt zeigt, sagt es ein Hinweis (dort steht dann ein Satz aus dem Wortschatz).
	var ohneSatz, ohneWort []string
	// Eine Bedingung ohne Namen, die sich nicht übersetzen lässt, liest der Kunde als allgemeinSatz.
	bedingungenOhneWort := func(wo string, liste []Bedingung) {
		for _, c := range liste {
			if c.Name != "" {
				continue
			}
			if _, ok := L.bedingungSatz(c.Baum); !ok {
				ohneWort = append(ohneWort, wo+" („"+c.Baum.src+"“)")
			}
		}
	}
	for _, z := range L.Zustaende {
		switch z.Art {
		case "boolean":
			pruefeText("on_text von „"+z.Name+"“", "states."+z.Kennung+".on_text", z.AnText)
			pruefeText("off_text von „"+z.Name+"“", "states."+z.Kennung+".off_text", z.AusText)
			if z.AnText == "" && (z.An != nil || z.AnEines != nil) {
				ohneSatz = append(ohneSatz, "states."+z.Kennung+".on_text")
			}
			if z.AusText == "" && (z.Aus != nil || z.AusEines != nil) {
				ohneSatz = append(ohneSatz, "states."+z.Kennung+".off_text")
			}
			bedingungenOhneWort("states."+z.Kennung+".on_when", z.An)
			bedingungenOhneWort("states."+z.Kennung+".on_when_any", z.AnEines)
			bedingungenOhneWort("states."+z.Kennung+".off_when", z.Aus)
			bedingungenOhneWort("states."+z.Kennung+".off_when_any", z.AusEines)
		case "counter":
			for i, s := range z.Schritte {
				pruefeText("text von „"+z.Name+"“, Schritt "+s.Name, fmt.Sprintf("states.%s.steps[%d].text", z.Kennung, i+1), s.Text)
				if s.Text == "" && (s.Alle != nil || s.Eines != nil) {
					ohneSatz = append(ohneSatz, "states."+z.Kennung+".steps."+s.Name+".text")
				}
				bedingungenOhneWort("states."+z.Kennung+".steps."+s.Name+".when", s.Alle)
				bedingungenOhneWort("states."+z.Kennung+".steps."+s.Name+".when_any", s.Eines)
			}
		}
	}
	if len(ohneSatz) > 0 {
		b.Hinweise = append(b.Hinweise, "Ohne Satz für den Kunden im Blatt „Warum?“ (dort steht dann ein Satz "+
			"aus dem Wortschatz): "+strings.Join(ohneSatz, ", "))
	}
	if len(ohneWort) > 0 {
		b.Hinweise = append(b.Hinweise, "Bedingungen ohne Namen, die sich nicht in einen Satz übersetzen lassen "+
			"(im Blatt „Warum?“ steht dann „"+allgemeinSatz+"“; bitte benennen): "+strings.Join(ohneWort, ", "))
	}
	// Wörter dürfen keinen anderen Namen verdecken; Schrittnamen sind auch Wörter.
	istName := func(w string) bool {
		if _, ok := L.Werte[w]; ok {
			return true
		}
		if _, ok := L.Stellwerte[w]; ok {
			return true
		}
		if _, ok := L.Merker[w]; ok {
			return true
		}
		_, ok := L.zustand[w]
		return ok
	}
	// Wo ein Name steht: die Stelle seiner Erklärung.
	stelle := func(w string) string {
		for _, abschnitt := range []struct {
			name string
			da   bool
		}{{"inputs", L.Werte[w] != nil}, {"settings", L.Stellwerte[w] != nil}, {"formulas", L.Merker[w] != nil},
			{"states", L.zustand[w] != nil}} {
			if abschnitt.da {
				return abschnitt.name + "." + w
			}
		}
		return ""
	}
	for w := range L.eigene {
		if istName(w) {
			fehl(stelle(w), "„%s“ ist zugleich ein Wort und ein Name", w)
		}
	}
	for _, e := range L.Zustaende {
		for i, s := range e.Schritte {
			if istName(s.Name) {
				fehl(fmt.Sprintf("states.%s.steps[%d].name", e.Kennung, i+1), "Schritt „%s“ von „%s“ heißt wie ein anderer Name", s.Name, e.Kennung)
			}
		}
	}
	// Die YAML-Falle (Vertrag 17.2): kein Name des Verfassers ist ein Ja oder Nein.
	pruefeVerboten := func(wo, n string) {
		if verboteneNamen[n] {
			fehl(wo+"."+n, "%s: „%s“ ist als Name nicht erlaubt (Ja/Nein-Wort)", wo, n)
		}
	}
	for _, n := range L.GeraetListe {
		pruefeVerboten("devices", n)
	}
	for _, n := range L.WertListe {
		pruefeVerboten("inputs", n)
	}
	for _, n := range L.StellListe {
		pruefeVerboten("settings", n)
	}
	for _, n := range L.MerkerListe {
		pruefeVerboten("formulas", n)
	}
	for _, z := range L.Zustaende {
		pruefeVerboten("states", z.Kennung)
		for i, s := range z.Schritte {
			if verboteneNamen[s.Name] {
				fehl(fmt.Sprintf("states.%s.steps[%d].name", z.Kennung, i+1), "%s: „%s“ ist als Name nicht erlaubt (Ja/Nein-Wort)",
					"states."+z.Kennung+".steps", s.Name)
			}
		}
	}
	for w := range L.eigene {
		pruefeVerboten("options", w)
	}

	// Punkt 2: Stellwerte.
	for _, n := range L.StellListe {
		s := L.Stellwerte[n]
		if s.Art != "zahl" {
			continue
		}
		if s.Bereich != nil {
			a, z := s.Bereich[0], s.Bereich[1]
			if a.Art != WertZahl || z.Art != WertZahl || a.D != s.Vorgabe.D || z.D != s.Vorgabe.D {
				fehl("settings."+n+".range", "Stellwert „%s“: Bereich und Vorgabe haben verschiedene Einheiten", s.Name)
			} else if s.Vorgabe.V < a.V-eps || s.Vorgabe.V > z.V+eps {
				fehl("settings."+n+".default", "Stellwert „%s“: Vorgabe %s liegt außerhalb %s bis %s", s.Name, Zeige(s.Vorgabe), Zeige(a), Zeige(z))
			}
		}
		// E2 = B: ein Zielwert (°C) braucht einen Bereich, weil der Kunde ihn immer stellt.
		if s.Zielwert() && s.Bereich == nil {
			fehl("settings."+n, "Stellwert „%s“: ein Zielwert (°C) braucht einen Bereich (range), weil der Kunde ihn immer stellt", s.Name)
		}
	}
	for i, z := range L.Zusammen {
		stand := ZusammenStand{Name: z.Name}
		ort := fmt.Sprintf("constraints[%d]", i+1)
		ok, err := L.zusammenGilt(nil)
		if err != nil {
			fehl(ort, "constraints „%s“: %s", z.Name, err.Error())
			continue
		}
		stand.Gilt = ok[i]
		verletzbar, err := L.zusammenImBereich(i)
		if err != nil {
			fehl(ort, "constraints „%s“: %s", z.Name, err.Error())
			continue
		}
		stand.Verletzbar = verletzbar
		if !stand.Gilt {
			fehl(ort, "constraints „%s“: mit den Vorgaben verletzt", z.Name)
		}
		b.Zusammen = append(b.Zusammen, stand)
	}

	// Punkt 3: Proben. Freiwillig (E5 = C); vorhandene, die nicht bestehen, sperren.
	if len(L.Proben) == 0 {
		b.Hinweise = append(b.Hinweise, "Keine Proben: Verhalten nicht belegt")
	}
	if len(b.Befunde) == 0 {
		for i, p := range L.Proben {
			r, err := L.FuehreProbe(p, anlage)
			if err != nil {
				fehl(fmt.Sprintf("tests[%d]", i+1), "Probe „%s“: %s", p.Name, err.Error())
				continue
			}
			b.Proben = append(b.Proben, r)
		}
	}
	return b
}

// zusammenGilt wertet die Bedingungen zwischen Stellwerten mit Vorgaben und Überschreibungen.
func (L *Logik) zusammenGilt(stell map[string]Wert) ([]bool, error) {
	st := L.NeuerLauf(0)
	for k, v := range stell {
		st.Stell[k] = v
	}
	ein := &Eingabe{Jetzt: 0, UhrMin: 720, Tag: 1, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{}}
	var aus []bool
	for _, z := range L.Zusammen {
		x, err := L.rechne(st, ein, z.Baum, 0)
		if err != nil {
			return nil, err
		}
		aus = append(aus, x.Art == WertBool && x.B)
	}
	return aus, nil
}

// zusammenImBereich probiert die Ecken der Bereiche durch: Lässt sich die Bedingung
// mit erlaubten Stellwerten verletzen? Dann begrenzt die Oberfläche den Regler.
func (L *Logik) zusammenImBereich(nr int) (bool, error) {
	z := L.Zusammen[nr]
	var namen []string
	var geh func(b *baum)
	geh = func(b *baum) {
		if b == nil {
			return
		}
		switch b.t {
		case kName:
			if s, ok := L.Stellwerte[b.n]; ok && s.Bereich != nil {
				for _, n := range namen {
					if n == b.n {
						return
					}
				}
				namen = append(namen, b.n)
			}
		case kBin:
			geh(b.l)
			geh(b.r)
		case kUn, kKlammer:
			geh(b.x)
		case kRuf:
			for _, a := range b.args {
				geh(a)
			}
		}
	}
	geh(z.Baum)
	ecken := 1 << len(namen)
	for m := 0; m < ecken; m++ {
		stell := map[string]Wert{}
		for i, n := range namen {
			s := L.Stellwerte[n]
			stell[n] = s.Bereich[(m>>i)&1]
		}
		ok, err := L.zusammenGilt(stell)
		if err != nil {
			return false, err
		}
		if !ok[nr] {
			return true, nil
		}
	}
	return false, nil
}

// festeBetriebsarten sammelt die Betriebsarten, die in einem Ausdruck als Wort stehen.
func festeBetriebsarten(b *baum) []string {
	if b == nil {
		return nil
	}
	var out []string
	if b.t == kName {
		for _, w := range Betriebsarten {
			if b.n == w {
				out = append(out, w)
			}
		}
	}
	for _, x := range append([]*baum{b.x, b.l, b.r}, b.args...) {
		out = append(out, festeBetriebsarten(x)...)
	}
	return out
}
