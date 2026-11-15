package regel

// Die Übersetzung: je Bedingung genau das, was der kompilierte Flow auf der Docker-Box tut
// (edge-app/nodered/flowc/catalog.js), in Wörtern der Regelsprache.
//
//   - Schwelle mit Hysterese (THRESHOLD_BODY): ein Schalter, der an geht, sobald der Wert die
//     Schwelle kreuzt, und aus, sobald er um die Hysterese zurückliegt; dazwischen bleibt er.
//     Ein unbekannter Wert macht ihn aus - so verfährt der Flow mit dem Preis (Preis-Wächter,
//     mqtt-price-current.md „unbekannt zählt nicht“), und so verfährt der Kern mit jedem Wert:
//     ein veralteter Messwert ist nicht aktuell (Abweichung 2 in regel-kern-vectors.json).
//   - Zeitfenster (WINDOW_BODY): der Flow prüft es nur an der Viertelstunde (Slot-Raster), also
//     gilt es von der ersten Viertelstunde ab „von“ bis zur ersten ab „bis“.
//   - und/oder (combinatorBody): beide Seiten sind im Kern immer bekannt, weil jede Bedingung
//     ein Schalter oder ein Zeitfenster ist.
//   - Ein/Aus: der Flow wünscht in jedem Fall, an oder aus; „voll“ (Sollwert in kW über
//     vp.logic.if ohne Sonst-Wert) wünscht nur, solange die Bedingung gilt, sonst nichts
//     (`unknown`).
//
// Was der Kern an der Anlage nicht liest, wird nicht übersetzt, sondern mit Grund genannt.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Geraet ist, was die Übersetzung über ein Gerät der Anlage weiß (aus dem Registry-Push).
type Geraet struct {
	Name  string
	Typ   string
	Misst []string
}

// Anlage sind die Geräte der Anlage nach Kennung.
type Anlage map[string]Geraet

// Herkunft nennt die Regel im Kopf des Texts.
type Herkunft struct {
	Name    string
	Fassung int
}

// Grund ist eine Stelle, die sich nicht übersetzen lässt.
type Grund struct {
	Code string `json:"code"`
	Text string `json:"text"`
}

// Ergebnis ist die Übersetzung einer Regel.
type Ergebnis struct {
	// Text ist die Logik in der Schreibform; leer, wenn Gruende nicht leer ist.
	Text    string  `json:"text,omitempty"`
	Gruende []Grund `json:"gruende"`
}

// Uebersetze übersetzt eine gelesene Regel für eine Anlage.
func Uebersetze(r *Regel, a Anlage, h Herkunft) Ergebnis {
	u := &uebersetzung{r: r, a: a, h: h, eingaenge: map[string]bool{}}
	u.pruefe()
	if len(u.gruende) > 0 {
		return Ergebnis{Gruende: u.gruende}
	}
	return Ergebnis{Text: u.schreibe(), Gruende: []Grund{}}
}

// UebersetzeDokument liest und übersetzt ein Flow-Dokument.
func UebersetzeDokument(doc json.RawMessage, a Anlage, h Herkunft) (Ergebnis, error) {
	r, err := Lies(doc)
	if err != nil {
		return Ergebnis{}, err
	}
	return Uebersetze(r, a, h), nil
}

type eingang struct {
	kennung, source, name, maxAge, einheit string
}

type uebersetzung struct {
	r         *Regel
	a         Anlage
	h         Herkunft
	gruende   []Grund
	eingaenge map[string]bool
	liste     []eingang
}

func (u *uebersetzung) grund(code, format string, args ...any) {
	u.gruende = append(u.gruende, Grund{Code: code, Text: fmt.Sprintf(format, args...)})
}

func (u *uebersetzung) geraetName(id string) string {
	if g, ok := u.a[id]; ok && g.Name != "" {
		return g.Name
	}
	return "Gerät"
}

// einzig sagt, ob genau ein Gerät der Anlage den Kanal misst (und der Typ passt, wenn genannt).
func (u *uebersetzung) einzig(kanal, typ string) string {
	treffer := ""
	n := 0
	for id, g := range u.a {
		if typ != "" && g.Typ != typ {
			continue
		}
		for _, m := range g.Misst {
			if m == kanal {
				treffer = id
				n++
				break
			}
		}
	}
	if n != 1 {
		return ""
	}
	return treffer
}

// quelle ordnet eine Messwert-Bedingung einer festen Quelle des Kerns zu: der Netzanschluss
// ist site.grid, der Ladestand des Speichers battery.soc - beides aus derselben gesicherten
// Hausbilanz, die jeder Schutz der Box liest. Nur, wenn das Gerät der Anlage eindeutig dieses
// eine ist; ein zweiter Netz-Zähler oder Speicher machte den Wert der Bilanz zu einem anderen.
func (u *uebersetzung) quelle(b Bedingung) (eingang, bool) {
	switch b.Kanal {
	case "power_kw":
		if id := u.einzig("power_kw", "grid-meter"); id != "" && id == b.Entity {
			return eingang{kennung: "netz", source: "site.grid", name: "Netzbezug", maxAge: "60 s", einheit: "kW"}, true
		}
	case "soc_pct":
		if id := u.einzig("soc_pct", ""); id != "" && id == b.Entity {
			return eingang{kennung: "ladestand", source: "battery.soc", name: "Ladestand Speicher", maxAge: "5 min", einheit: "%"}, true
		}
	}
	return eingang{}, false
}

var preisEingang = eingang{kennung: "preis", source: "price.current", name: "Börsenpreis", einheit: ""}

func (u *uebersetzung) pruefe() {
	r := u.r
	switch r.Tat.Art {
	case "onoff", "setpoint":
	case "notify":
		u.grund("meldung", "Eine Benachrichtigung schaltet nichts; sie bleibt eine Regel (In Überwachung umwandeln).")
		return
	default:
		u.grund("tat", "Diese Tat kennt die Übersetzung nicht.")
		return
	}
	if r.Tat.Entity == "" {
		u.grund("geraet", "Die Regel nennt kein Gerät.")
	}
	if r.Tat.Art == "setpoint" && !(r.Tat.Wert > 0) {
		u.grund("sollwert", "„Voll einschalten“ braucht eine Leistung über 0 kW.")
	}
	for _, b := range r.Bedingungen {
		switch b.Art {
		case "price":
			u.nimm(preisEingang)
		case "entity":
			e, ok := u.quelle(b)
			if !ok {
				name := u.geraetName(b.Entity)
				u.grund("messwert", "„%s“ (%s) liest die Box für eine Logik nicht; nur der Netzanschluss und der Ladestand eines Speichers lassen sich übersetzen.", name, b.Kanal)
				continue
			}
			u.nimm(e)
		case "schedule":
			von, ok1 := minuten(b.Von)
			bis, ok2 := minuten(b.Bis)
			if !ok1 || !ok2 {
				u.grund("zeitfenster", "Ein Zeitfenster ist keine Uhrzeit „HH:MM“.")
				continue
			}
			if b.Tage != "alle" && viertel(von) >= viertel(bis) {
				// Der Flow prüft den Tag zum Zeitpunkt der Prüfung, der Zeitplan der Sprache rechnet
				// ein Fenster über Mitternacht dem Tag zu, an dem es beginnt.
				u.grund("zeitfenster", "Ein Zeitfenster über Mitternacht nur an bestimmten Tagen lässt sich nicht gleich übersetzen.")
			}
		}
	}
}

func (u *uebersetzung) nimm(e eingang) {
	if !u.eingaenge[e.kennung] {
		u.eingaenge[e.kennung] = true
		u.liste = append(u.liste, e)
	}
}

func minuten(t string) (int, bool) {
	if !hhmm.MatchString(t) {
		return 0, false
	}
	h, _ := strconv.Atoi(t[:2])
	m, _ := strconv.Atoi(t[3:])
	return h*60 + m, true
}

// viertel ist die erste Viertelstunde ab m (der Flow prüft ein Zeitfenster nur im Raster).
func viertel(m int) int {
	return ((m + 14) / 15 * 15) % (24 * 60)
}

func uhrText(m int) string {
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

// zahl schreibt eine Zahl so, dass der Kern genau denselben Wert liest.
func zahlText(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// mitEinheit schreibt einen Wert mit Einheit; ein negativer Wert als Vorzeichen vor der Zahl
// (der Kern liest „-2 kW“ als Vorzeichen auf 2 kW: dieselbe Zahl).
func mitEinheit(v float64, einheit string) string {
	if einheit == "" {
		return zahlText(v)
	}
	return zahlText(v) + " " + einheit
}

// deutsch schreibt eine Zahl für den Satz: eine Stelle, Dezimalkomma, echtes Minus (wie das
// Portal den Satz einer Regel schreibt, steuerung/zeit.ts).
func deutsch(v float64, stellen int) string {
	t := strconv.FormatFloat(math.Abs(v), 'f', stellen, 64)
	t = strings.Replace(t, ".", ",", 1)
	if v < 0 && strings.Trim(t, "0,") != "" {
		t = "−" + t
	}
	return t
}

// nebensatz nennt eine Bedingung als Nebensatz, wörtlich wie der Satz der Regel im Portal
// (steuerung/regeln.ts, bedingungSatz und regelSatzAusFlow).
func (u *uebersetzung) nebensatz(b Bedingung, e eingang) string {
	unter := b.Richtung == "below"
	switch e.source {
	case "price.current":
		return fmt.Sprintf("der Börsenpreis %s %s ct/kWh liegt", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 1))
	case "site.grid":
		if b.Schwelle <= 0 {
			return fmt.Sprintf("%s %s kW Sonnenstrom übrig sind", wahl(unter, "mehr als", "weniger als"), deutsch(-b.Schwelle, 1))
		}
		return fmt.Sprintf("der Netzbezug %s %s kW liegt", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 1))
	default:
		return fmt.Sprintf("der Speicher %s %s %% hat", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 0))
	}
}

// satzTeile nennt eine Bedingung für Menschen: wann sie gilt, wann sie endet, wie der fehlende Wert heißt.
func (u *uebersetzung) satzTeile(b Bedingung, e eingang) (an, aus, fehlt string) {
	unter := b.Richtung == "below"
	switch e.source {
	case "price.current":
		gegen := b.Schwelle + b.Hysterese
		if !unter {
			gegen = b.Schwelle - b.Hysterese
		}
		return fmt.Sprintf("Der Börsenpreis liegt %s %s ct/kWh", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 1)),
			fmt.Sprintf("Der Börsenpreis liegt %s %s ct/kWh", wahl(unter, "über", "unter"), deutsch(gegen, 1)),
			"Der Börsenpreis fehlt"
	case "site.grid":
		// Der Baukasten schreibt „Sonnen-Überschuss über w“ als „Netz unter −w“ (Einspeisung negativ).
		if unter && b.Schwelle <= 0 {
			return fmt.Sprintf("Mehr als %s kW Sonnenstrom sind übrig", deutsch(-b.Schwelle, 1)),
				fmt.Sprintf("Weniger als %s kW Sonnenstrom sind übrig", deutsch(-(b.Schwelle+b.Hysterese), 1)),
				"Der Netzbezug fehlt"
		}
		if !unter && b.Schwelle <= 0 {
			return fmt.Sprintf("Weniger als %s kW Sonnenstrom sind übrig", deutsch(-b.Schwelle, 1)),
				fmt.Sprintf("Mehr als %s kW Sonnenstrom sind übrig", deutsch(-(b.Schwelle-b.Hysterese), 1)),
				"Der Netzbezug fehlt"
		}
		gegen := b.Schwelle + b.Hysterese
		if !unter {
			gegen = b.Schwelle - b.Hysterese
		}
		return fmt.Sprintf("Der Netzbezug liegt %s %s kW", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 1)),
			fmt.Sprintf("Der Netzbezug liegt %s %s kW", wahl(unter, "über", "unter"), deutsch(gegen, 1)),
			"Der Netzbezug fehlt"
	default:
		gegen := b.Schwelle + b.Hysterese
		if !unter {
			gegen = b.Schwelle - b.Hysterese
		}
		return fmt.Sprintf("Der Speicher hat %s %s %%", wahl(unter, "unter", "über"), deutsch(b.Schwelle, 0)),
			fmt.Sprintf("Der Speicher hat %s %s %%", wahl(unter, "über", "unter"), deutsch(gegen, 0)),
			"Der Ladestand fehlt"
	}
}

func wahl(b bool, ja, nein string) string {
	if b {
		return ja
	}
	return nein
}

var formelBraucht = regexp.MustCompile(`["#]`)

func formel(f string) string {
	if formelBraucht.MatchString(f) {
		return "'" + f + "'"
	}
	return f
}

func (u *uebersetzung) schreibe() string {
	r := u.r
	s := &schreiber{}
	name := u.h.Name
	if strings.TrimSpace(name) == "" {
		name = "Regel"
	}
	s.kommentar(0, fmt.Sprintf("Übersetzt aus der Regel „%s“ (Fassung %d) des Regel-Baukastens.", name, u.h.Fassung))
	s.kommentar(0, "Bearbeitet wird die Regel, nicht dieser Text: jede neue Fassung der Regel übersetzt ihn neu.")
	s.kommentar(0, "Wie die Übersetzung entscheidet, belegt docs/contracts/v2/regel-kern-vectors.json.")
	s.zeile(0, "logic: 1")
	s.zeile(0, "name: "+skalar(name, false))
	s.zeile(0, "")

	geraet := u.geraetName(r.Tat.Entity)
	s.zeile(0, "devices:")
	s.zeile(2, fmt.Sprintf("geraet: {entity: %s, name: %s}", skalar(r.Tat.Entity, true), skalar(geraet, true)))
	s.zeile(0, "")

	if len(u.liste) > 0 {
		s.zeile(0, "inputs:")
		for _, e := range u.liste {
			alter := ""
			if e.maxAge != "" {
				alter = ", max_age: " + e.maxAge
			}
			s.zeile(2, fmt.Sprintf("%s: {source: %s, name: %s%s}", e.kennung, e.source, skalar(e.name, true), alter))
		}
		s.zeile(0, "")
	}

	// Zeitfenster an bestimmten Tagen: ein Zeitplan (der Fachbetrieb stellt ihn).
	var plaene []string
	for i, b := range r.Bedingungen {
		if b.Art == "schedule" && b.Tage != "alle" {
			plaene = append(plaene, fmt.Sprintf("zeitplan_%d", i+1))
		}
	}
	if len(plaene) > 0 {
		s.zeile(0, "settings:")
		for i, b := range r.Bedingungen {
			if b.Art != "schedule" || b.Tage == "alle" {
				continue
			}
			von, _ := minuten(b.Von)
			bis, _ := minuten(b.Bis)
			tage := "mon-fri"
			wort := "werktags"
			if b.Tage == "wochenende" {
				tage, wort = "sat-sun", "am Wochenende"
			}
			s.zeile(2, fmt.Sprintf("zeitplan_%d:", i+1))
			s.zeile(4, "name: "+skalar(fmt.Sprintf("Zeitfenster %s", wort), false))
			s.zeile(4, "type: schedule")
			s.zeile(4, fmt.Sprintf(`default: [{days: %s, from: "%s", to: "%s"}]`, tage, uhrText(viertel(von)), uhrText(viertel(bis))))
		}
		s.zeile(0, "")
	}

	// Benannte Zeitfenster als Formeln (der Kern rechnet sie in jedem Takt).
	var teile, saetze []string
	var formeln [][2]string
	var zustaende []func()
	for i, b := range r.Bedingungen {
		nr := i + 1
		switch b.Art {
		case "schedule":
			von, _ := minuten(b.Von)
			bis, _ := minuten(b.Bis)
			k := fmt.Sprintf("zeitfenster_%d", nr)
			if b.Tage == "alle" {
				formeln = append(formeln, [2]string{k, fmt.Sprintf(`time_window("%s", "%s")`, uhrText(viertel(von)), uhrText(viertel(bis)))})
			} else {
				formeln = append(formeln, [2]string{k, fmt.Sprintf("in_schedule(zeitplan_%d)", nr)})
			}
			teile = append(teile, k)
			saetze = append(saetze, fmt.Sprintf("es zwischen %s und %s Uhr ist", b.Von, b.Bis))
		default:
			e := preisEingang
			if b.Art == "entity" {
				e, _ = u.quelle(b)
			}
			k := fmt.Sprintf("bedingung_%d", nr)
			an, aus, fehlt := u.satzTeile(b, e)
			wert := func(v float64) string { return mitEinheit(v, e.einheit) }
			var anF, ausF string
			if b.Richtung == "below" {
				anF = fmt.Sprintf("%s < %s", e.kennung, wert(b.Schwelle))
				ausF = fmt.Sprintf("%s > %s + %s", e.kennung, wert(b.Schwelle), wert(b.Hysterese))
			} else {
				anF = fmt.Sprintf("%s > %s", e.kennung, wert(b.Schwelle))
				ausF = fmt.Sprintf("%s < %s - %s", e.kennung, wert(b.Schwelle), wert(b.Hysterese))
			}
			teile = append(teile, k)
			saetze = append(saetze, u.nebensatz(b, e))
			zustaende = append(zustaende, func() {
				s.zeile(2, k+":")
				s.zeile(4, "type: boolean")
				s.zeile(4, "on_when:")
				s.zeile(6, "- "+skalar(an, false)+": "+formel(anF))
				s.zeile(4, "off_when_any:")
				s.zeile(6, "- "+skalar(aus, false)+": "+formel(ausF))
				s.zeile(6, "- "+skalar(fehlt, false)+": "+formel("unknown("+e.kennung+")"))
				s.zeile(4, "on_text: "+skalar(an, false))
				s.zeile(4, "off_text: "+skalar(aus, false))
				s.zeile(4, "after_restart: off")
			})
		}
	}
	if len(formeln) > 0 {
		s.zeile(0, "formulas:")
		for _, f := range formeln {
			s.zeile(2, f[0]+": "+formel(f[1]))
		}
		s.zeile(0, "")
	}
	if len(zustaende) > 0 {
		s.zeile(0, "states:")
		for _, z := range zustaende {
			z()
		}
		s.zeile(0, "")
	}

	verk := " and "
	wortVerk := " und "
	if r.Verknuepfung == "or" {
		verk, wortVerk = " or ", " oder "
	}
	gilt := strings.Join(teile, verk)
	tatWort := "ein"
	s.zeile(0, "outputs:")
	if r.Tat.Art == "setpoint" {
		tatWort = "voll ein"
		s.kommentar(2, "Außerhalb der Bedingung wünscht die Regel nichts (unknown): das Gerät folgt dann wieder seiner Steuerung.")
		s.zeile(2, fmt.Sprintf("geraet: {setpoint: %s}", skalar(fmt.Sprintf("if(%s, %s kW, unknown)", gilt, zahlText(r.Tat.Wert)), true)))
	} else {
		s.zeile(2, fmt.Sprintf("geraet: {on_off: %s}", skalar(gilt, true)))
	}
	s.zeile(0, "")

	wenn := strings.Join(saetze, wortVerk)
	art := "idle"
	for _, b := range r.Bedingungen {
		if b.Art == "entity" && b.Kanal == "power_kw" {
			art = "solar"
		}
	}
	s.zeile(0, "status:")
	s.zeile(2, "- when: "+formel(gilt))
	s.zeile(4, "title: Regel greift")
	s.zeile(4, "type: "+art)
	s.zeile(4, "text: "+skalar(fmt.Sprintf("Die Regel schaltet „%s“ %s, weil %s.", geraet, tatWort, wenn), false))
	if len(u.liste) > 0 {
		var fehlt []string
		for _, e := range u.liste {
			fehlt = append(fehlt, "unknown("+e.kennung+")")
		}
		s.zeile(2, "- when: "+formel(strings.Join(fehlt, " or ")))
		s.zeile(4, "title: Ein Wert fehlt")
		s.zeile(4, "type: fault")
		s.zeile(4, "text: "+skalar(fmt.Sprintf("Ohne den Wert gilt die Bedingung nicht; die Regel schaltet „%s“ nicht ein.", geraet), false))
	}
	s.zeile(2, "- else: true")
	s.zeile(4, "title: Wartet")
	s.zeile(4, "type: waiting")
	s.zeile(4, "text: "+skalar(fmt.Sprintf("Wenn %s, schaltet die Regel „%s“ %s.", wenn, geraet, tatWort), false))
	return s.b.String()
}
