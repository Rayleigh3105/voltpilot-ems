// Package homeassistant übersetzt die Dateien einer Home-Assistant-Anlage in eine Logik
// der Textform (Steuerlogik Stufe 6, erster Teil; Bericht Abschnitte 12.4, 13.4, 14,
// Entscheid E8 = A: eigene Form, Bausteine wie in Home Assistant, ein Helfer übersetzt
// vorhandene Dateien, die Prüfung urteilt).
//
// Abgebildet wird nach der Gegenüberstellung in Bericht 12.4:
//
//   - input_boolean, input_number, input_datetime, input_select, die keine Automation
//     ändert, werden Stellwerte; die eine Automation ändert, werden Zustände (Schalter,
//     Zähler); timer wird ein Zeitgeber;
//   - Vorlagen-Sensoren werden Formeln, ein Binärsensor mit eigenem Wert (this.state) ein
//     Schalter, ein Sensor, der nur einen Messwert weitergibt, der Eingang selbst, und der
//     Sensor mit Texten die Lage;
//   - history_stats über alle Ausgänge eines Geräts wird dessen output_hours_today;
//   - Automationen werden Bedingungen von Zuständen und Schritte von Zählern; ein Skript,
//     das Schalter setzt, wird zu den Ausgängen der Geräte;
//   - Entitäten von Geräten und Messwerten werden Lücken, die der Mensch der Anlage
//     zuordnet (wie bei den Bausteinen aus Stufe 5).
//
// Wo Home Assistant etwas anders tut als die Sprache (Auswertung nur bei Auslösern, zur
// vollen Minute, Ersatzwerte für fehlende Messwerte, Rundung), steht ein Hinweis an der
// Stelle; still anders gerechnet wird nicht. Was sich nicht abbilden lässt, steht mit
// Datei, Zeile und Grund in der Liste "nicht übersetzbar", und es entsteht keine Logik.
package homeassistant

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// Stelle ist ein Stück der Dateien mit einem Grund.
type Stelle struct {
	Ort   Ort    `json:"ort"`
	Was   string `json:"was"`
	Grund string `json:"grund"`
}

// Hinweis sagt, wo die Logik sich anders verhält als Home Assistant.
type Hinweis struct {
	Ort Ort `json:"ort"`
	// Stelle in der Logik (wie die Meldungen der Prüfung: states.heizstufe.steps[1]).
	Stelle string `json:"stelle,omitempty"`
	Text   string `json:"text"`
}

// Lücke ist eine Entität von Home Assistant, die der Mensch einem Gerät oder Eingang der
// Anlage zuordnet.
type Luecke struct {
	Kennung string `json:"kennung"`
	// Art: geraet oder eingang.
	Art      string   `json:"art"`
	Name     string   `json:"name"`
	Entities []string `json:"entities"`
	// Eingang: temperatur, leistung, prozent, winkel, ja_nein.
	Groesse string `json:"groesse,omitempty"`
	// Geschaetzt: die Größe stammt nur aus dem Namen; die Zuordnung entscheidet.
	Geschaetzt bool `json:"groesse_geschaetzt,omitempty"`
	// Gerät: Zahl der Ausgänge und was die Logik ihm stellt (level oder on_off).
	Ausgaenge int    `json:"ausgaenge,omitempty"`
	Ausgang   string `json:"ausgang,omitempty"`
	Orte      []Ort  `json:"orte"`
	// Wert: die Zuordnung, mit der übersetzt wurde (leer: nicht zugeordnet).
	Wert string `json:"wert"`
	// Fehler: warum die Zuordnung nicht passt (dann ist die Lücke offen).
	Fehler string `json:"fehler,omitempty"`
}

// Zuordnung füllt eine Lücke: das Gerät (entity_id der Anlage) oder die Quelle eines
// Eingangs (site.grid, -battery.power für gedrehtes Vorzeichen, <fühler>.temperature),
// dazu der Name, den die Anlage dafür kennt.
type Zuordnung struct {
	Wert string `json:"wert"`
	Name string `json:"name,omitempty"`
}

// Ergebnis ist eine Übersetzung.
type Ergebnis struct {
	// Text ist die Logik in der Schreibform; leer, wenn etwas nicht übersetzbar ist.
	Text             string    `json:"text"`
	Luecken          []Luecke  `json:"luecken"`
	NichtUebersetzt  []Stelle  `json:"nicht_uebersetzt"`
	NichtUebernommen []Stelle  `json:"nicht_uebernommen"`
	Hinweise         []Hinweis `json:"hinweise"`
	// Kennungen: welche Entität von Home Assistant in der Logik wie heißt.
	Kennungen map[string]string `json:"kennungen"`
}

type symbol struct {
	art     byte // S Stellwert, W Uhrzeit-Stellwert, P Auswahl, B Schalter, C Zähler, T Zeitgeber, F Formel, E Eingang, L Lage, H Laufzeit eines Ausgangs, A Ausgang, U Sonne
	kennung string
	name    string
	entity  string
	q       *groesse
	ort     Ort
	helfer  *helfer
	vorlage *vorlageSensor
	geraet  *geraet
	index   int
	// Eingang
	quelle   string
	gedreht  bool
	maxAlter string
	// Name stammt aus der Kennung, nicht aus einem Namen in den Dateien
	nameGeraten bool
	// zugeordneteGroesse: die Größe der Quelle, die der Mensch zugeordnet hat
	zugeordneteGroesse string
	gelesen            bool
	zustand            *zustand
	formel             *formel
}

type formel struct {
	kennung   string
	e         *ir
	ort       Ort
	kommentar string
	sym       *symbol
}

type geraet struct {
	kennung     string
	name        string
	stamm       string
	entities    map[int]string
	ort         Ort
	an, aus     map[int][]*ir
	stelle      *ir // was die Logik ihm stellt
	art         string
	wert        string
	zustand     *zustand
	geschrieben bool
	// quellen: die Automationen, die das Gerät schalten
	quellen []Ort
}

type zustand struct {
	kennung, name, art string
	ort                Ort
	an, ausAlle        []*ir
	anEines, ausEines  []*ir
	nachNeustart       string
	dauer              *ir
	min, max           int
	schritte           []*schritt
	kommentare         []string
	sym                *symbol
	// quellen: die Automationen, die den Zustand ändern
	quellen []Ort
}

type schritt struct {
	name        string
	um          int
	setze       *ir
	fruehestens string
	wenn        []*ir
	wennEines   []*ir
	startet     string
	startWenn   *ir
	ort         Ort
	kommentare  []string
	sinkt       bool
}

type lageZeile struct {
	wenn  *ir
	sonst bool
	titel string
	art   string
}

type uebersetzer struct {
	ha          *haAnlage
	zuordnung   map[string]Zuordnung
	symbole     map[string]*symbol
	vergeben    map[string]bool
	geraete     map[string]*geraet
	geraetListe []*geraet
	eingaenge   []*symbol
	stellwerte  []*symbol
	formeln     []*formel
	zustaende   []*zustand
	lage        []lageZeile
	lageOrt     Ort
	lageName    string
	ergebnis    Ergebnis
	gesehen     map[string]bool
	geschrieben map[string]bool
	praefix     string
	naechste    int
	sonneSym    *symbol
	// hinweisKnoten: je Hinweis der Teil einer Formel, an dem er hängt (oder nil)
	hinweisKnoten []*ir
	// offene Hinweise auf Ersatzwerte (siehe auswerter.offen)
	offen []offenerHinweis
	// Wurzeln aller Formeln, für das Falten der Ausgänge am Ende
	wurzeln   []**ir
	wurzelOrt []Ort
}

// Uebersetze übersetzt die Dateien. Ohne Zuordnung bleiben die Lücken offen (Platzhalter).
func Uebersetze(dateien []Datei, zuordnung map[string]Zuordnung) (*Ergebnis, error) {
	ha, err := liesAnlage(dateien)
	if err != nil {
		return nil, err
	}
	u := &uebersetzer{ha: ha, zuordnung: zuordnung, symbole: map[string]*symbol{}, vergeben: map[string]bool{},
		geraete: map[string]*geraet{}, gesehen: map[string]bool{}, geschrieben: map[string]bool{}}
	u.ergebnis.NichtUebersetzt = append(u.ergebnis.NichtUebersetzt, ha.fehler...)
	u.ergebnis.NichtUebernommen = append(u.ergebnis.NichtUebernommen, ha.ignoriert...)
	u.uebersetze()
	if u.ergebnis.Luecken == nil {
		u.ergebnis.Luecken = []Luecke{}
	}
	for _, l := range []*[]Stelle{&u.ergebnis.NichtUebersetzt, &u.ergebnis.NichtUebernommen} {
		if *l == nil {
			*l = []Stelle{}
		}
		sort.SliceStable(*l, func(i, j int) bool {
			a, b := (*l)[i].Ort, (*l)[j].Ort
			if a.Datei != b.Datei {
				return dateiRang(a.Datei) < dateiRang(b.Datei)
			}
			return a.Zeile < b.Zeile
		})
	}
	if u.ergebnis.Hinweise == nil {
		u.ergebnis.Hinweise = []Hinweis{}
	}
	u.ergebnis.Kennungen = map[string]string{}
	for id, s := range u.symbole {
		switch s.art {
		case 'S', 'W', 'P', 'B', 'C', 'T', 'F', 'E', 'U':
			if s.kennung != "" && u.vergeben[s.kennung] {
				u.ergebnis.Kennungen[id] = s.kennung
			}
		}
	}
	for _, g := range u.geraetListe {
		if g.stelle != nil {
			for _, id := range g.entities {
				u.ergebnis.Kennungen[id] = g.kennung
			}
		}
	}
	return &u.ergebnis, nil
}

func dateiRang(d string) string {
	switch {
	case strings.HasPrefix(d, "configuration"):
		return "1" + d
	case strings.HasPrefix(d, "automation"):
		return "2" + d
	case strings.HasPrefix(d, "script"):
		return "3" + d
	}
	return "4" + d
}

func (u *uebersetzer) nichtUebersetzbar(o Ort, was, grund string) {
	key := o.String() + was + grund
	if u.gesehen[key] {
		return
	}
	u.gesehen[key] = true
	u.ergebnis.NichtUebersetzt = append(u.ergebnis.NichtUebersetzt, Stelle{Ort: o, Was: was, Grund: grund})
}

func (u *uebersetzer) hinweis(o Ort, stelle, text string) {
	u.hinweisAn(o, stelle, text, nil)
}

// hinweisAn: ein Hinweis, der an einem Teil einer Formel hängt (so findet er seinen Eintrag).
func (u *uebersetzer) hinweisAn(o Ort, stelle, text string, knoten *ir) {
	key := o.String() + text
	if u.gesehen[key] {
		return
	}
	u.gesehen[key] = true
	u.ergebnis.Hinweise = append(u.ergebnis.Hinweise, Hinweis{Ort: o, Stelle: stelle, Text: text})
	u.hinweisKnoten = append(u.hinweisKnoten, knoten)
}

// gibOffen gibt die offenen Hinweise auf Ersatzwerte aus; behalte kann einzelne streichen.
func (u *uebersetzer) gibOffen(streiche func(offenerHinweis) bool) {
	for _, o := range u.offen {
		if u.sonneSym != nil && o.fehlbar == u.sonneSym.kennung {
			continue // den Sonnenstand rechnet die Box immer
		}
		if streiche != nil && streiche(o) {
			continue
		}
		u.hinweisAn(o.ort, "", fmt.Sprintf("Ohne Wert von „%s“ rechnet Home Assistant hier mit %s; in der Logik ist der Wert dann unbekannt, und was davon abhängt, geschieht nicht.",
			o.fehlbar, zahlOhneEinheit(o.vorgabe)), o.cmp)
	}
	u.offen = nil
}

func (u *uebersetzer) intHinweis(a *auswerter, entity string) {
	s := u.symbole[entity]
	if s == nil || s.art == 'C' {
		return
	}
	if s.helfer != nil && s.helfer.schritt != nil && *s.helfer.schritt == float64(int(*s.helfer.schritt)) {
		return
	}
	u.hinweis(a.ortJetzt(), "", "Home Assistant schneidet hier die Nachkommastellen ab (|int); die Logik rechnet mit dem ganzen Wert.")
}

// --- Kennungen ---------------------------------------------------------------

var reservierteWoerter = map[string]bool{
	"on": true, "off": true, "yes": true, "no": true, "true": true, "false": true, "and": true, "or": true, "not": true,
	"if": true, "min": true, "max": true, "known": true, "unknown": true, "clock": true, "time_window": true,
	"in_schedule": true, "holds": true, "since": true, "running": true, "last": true, "start": true, "keep": true,
	"mon": true, "tue": true, "wed": true, "thu": true, "fri": true, "sat": true, "sun": true, "normal": true,
	"boost": true, "cool": true, "heat": true, "fan_only": true, "dry": true, "auto": true, "site": true,
	"battery": true, "price": true, "weekday": true, "restart": true, "status": true, "notifications": true,
}

var hexTeil = regexp.MustCompile(`^[0-9a-f]{8,}$`)

// kennungAus macht aus einem Namen eine Kennung der Logik: klein, a-z0-9_, höchstens 32 Zeichen.
func kennungAus(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch r {
		case 'ä':
			b.WriteString("ae")
		case 'ö':
			b.WriteString("oe")
		case 'ü':
			b.WriteString("ue")
		case 'ß':
			b.WriteString("ss")
		default:
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			} else {
				b.WriteRune('_')
			}
		}
	}
	var teile []string
	for _, t := range strings.Split(b.String(), "_") {
		if t != "" && !hexTeil.MatchString(t) {
			teile = append(teile, t)
		}
	}
	k := strings.Join(teile, "_")
	if k == "" {
		k = "wert"
	}
	if k[0] >= '0' && k[0] <= '9' {
		k = "x_" + k
	}
	for len(k) > 32 {
		i := strings.Index(k, "_")
		if i < 0 || i >= len(k)-1 {
			k = k[:32]
			break
		}
		k = k[i+1:]
	}
	return strings.Trim(k, "_")
}

func (u *uebersetzer) neueKennung(wunsch string) string {
	return u.kennung(wunsch, true)
}

// kennungOhnePraefix behält das erste Wort (pumpe_an bleibt pumpe_an).
func (u *uebersetzer) kennungOhnePraefix(wunsch string) string {
	return u.kennung(wunsch, false)
}

func (u *uebersetzer) kennung(wunsch string, praefixWeg bool) string {
	k := kennungAus(wunsch)
	if praefixWeg && u.praefix != "" && strings.HasPrefix(k, u.praefix+"_") && len(k) > len(u.praefix)+1 {
		k = k[len(u.praefix)+1:]
		if k[0] >= '0' && k[0] <= '9' {
			k = u.praefix + "_" + k
		}
	}
	if reservierteWoerter[k] {
		k += "_wert"
	}
	basis := k
	for i := 2; u.vergeben[k]; i++ {
		suffix := "_" + strconv.Itoa(i)
		if len(basis)+len(suffix) > 32 {
			basis = basis[:32-len(suffix)]
		}
		k = basis + suffix
	}
	u.vergeben[k] = true
	return k
}

// haSlug ist die Kennung, die Home Assistant aus einem Namen macht (slugify: ä wird a).
func haSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch r {
		case 'ä':
			b.WriteRune('a')
		case 'ö':
			b.WriteRune('o')
		case 'ü':
			b.WriteRune('u')
		case 'ß':
			b.WriteString("ss")
		default:
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			} else {
				b.WriteRune('_')
			}
		}
	}
	var teile []string
	for _, t := range strings.Split(b.String(), "_") {
		if t != "" {
			teile = append(teile, t)
		}
	}
	return strings.Join(teile, "_")
}

// nameAus macht aus einer Kennung einen lesbaren Namen ("puffer_2_l1" → "Puffer 2 L1").
func nameAus(k string) string {
	var teile []string
	for _, t := range strings.Split(k, "_") {
		if t == "" || hexTeil.MatchString(t) {
			continue
		}
		r := []rune(t)
		r[0] = unicode.ToUpper(r[0])
		teile = append(teile, string(r))
	}
	return kuerze(strings.Join(teile, " "), 40)
}

func kuerze(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	cut := string(r[:n-1])
	if i := strings.LastIndex(cut, " "); i > n/2 {
		cut = cut[:i]
	}
	return cut + "…"
}

// --- Aufbau ------------------------------------------------------------------

func (u *uebersetzer) uebersetze() {
	u.findeGeschriebene()
	u.findePraefix()
	u.legeHelferAn()
	u.legeVorlagenAn()
	u.legeLaufzeitenAn()
	u.deuteVorlagen()
	u.deuteAutomationen()
	u.bildeAusgaenge()
	u.falteAlles()
	u.pruefeGelesen()
	u.bildeLuecken()
	if len(u.ergebnis.NichtUebersetzt) > 0 {
		return
	}
	u.ergebnis.Text = u.schreibe()
}

// findeGeschriebene sucht in allen Aktionen die Entitäten, die eine Automation oder ein
// Skript ändert (Helfer, die sich ändern, sind Zustände, keine Stellwerte).
func (u *uebersetzer) findeGeschriebene() {
	var gehe func(ns []*yaml.Node)
	gehe = func(ns []*yaml.Node) {
		for _, n := range ns {
			if n.Kind != yaml.MappingNode {
				continue
			}
			dienst := text(erstesFeld(n, "action", "service"))
			if dienst != "" {
				for _, id := range zieleWoertlich(n) {
					u.geschrieben[id] = true
				}
			}
			for _, k := range []string{"then", "else", "sequence", "default"} {
				gehe(liste(feld(n, k)))
			}
			for _, c := range liste(feld(n, "choose")) {
				gehe(liste(feld(c, "sequence")))
			}
		}
	}
	for _, a := range u.ha.automations {
		gehe(a.aktionen)
	}
	for _, s := range u.ha.skripte {
		gehe(s.sequenz)
	}
}

// zieleWoertlich nennt die wörtlich genannten Ziele einer Aktion.
func zieleWoertlich(n *yaml.Node) []string {
	var ids []string
	for _, quelle := range []*yaml.Node{feld(feld(n, "target"), "entity_id"), feld(n, "entity_id"), feld(feld(n, "data"), "entity_id")} {
		for _, e := range liste(quelle) {
			if t := text(e); t != "" && !IstVorlage(t) {
				for _, teil := range strings.Split(t, ",") {
					ids = append(ids, strings.TrimSpace(teil))
				}
			}
		}
	}
	return ids
}

// findePraefix: tragen alle Vorlagen und Automationen dasselbe erste Wort ("heizung_…"),
// fällt es in den Kennungen weg und wird der Name der Logik.
func (u *uebersetzer) findePraefix() {
	var slugs []string
	for _, v := range u.ha.vorlagen {
		slugs = append(slugs, haSlug(v.name))
	}
	for _, a := range u.ha.automations {
		if a.id != "" {
			slugs = append(slugs, haSlug(a.id))
		}
	}
	if len(slugs) < 2 {
		return
	}
	erstes := strings.SplitN(slugs[0], "_", 2)[0]
	for _, s := range slugs {
		if !strings.HasPrefix(s, erstes+"_") {
			return
		}
	}
	u.praefix = erstes
}

func (u *uebersetzer) legeHelferAn() {
	for _, h := range u.ha.helfer {
		s := &symbol{entity: h.entity(), ort: h.ort, helfer: h, name: h.name}
		if s.name == "" {
			s.name, s.nameGeraten = nameAus(h.id), true
		}
		s.name = kuerze(s.name, 40)
		geschrieben := u.geschrieben[h.entity()]
		switch h.art {
		case "input_boolean":
			s.q = neueGroesse(gJaNein, "")
			if geschrieben {
				s.art = 'B'
			} else {
				s.art = 'S'
			}
		case "input_number":
			s.q = groesseAusEinheit(h.einheit)
			if geschrieben {
				s.art = 'C'
				s.q = neueGroesse(gZahl, "")
			} else {
				s.art = 'S'
			}
		case "counter":
			s.art, s.q = 'C', neueGroesse(gZahl, "")
		case "input_datetime":
			if h.datum || !h.zeit {
				u.nichtUebersetzbar(h.ort, h.entity(), "Ein Datum lässt sich nicht einstellen; die Logik kennt Uhrzeiten (input_datetime mit has_date: false).")
				continue
			}
			if geschrieben {
				u.nichtUebersetzbar(h.ort, h.entity(), "Eine Uhrzeit, die eine Automation setzt, lässt sich nicht übersetzen.")
				continue
			}
			s.art, s.q = 'W', neueGroesse(gUhrzeit, "")
		case "input_select":
			if geschrieben {
				u.nichtUebersetzbar(h.ort, h.entity(), "Eine Auswahl, die eine Automation setzt, lässt sich nicht übersetzen.")
				continue
			}
			s.art, s.q = 'P', neueGroesse(gZahl, "")
		case "timer":
			s.art, s.q = 'T', neueGroesse(gJaNein, "")
		}
		s.kennung = u.neueKennung(h.id)
		u.symbole[h.entity()] = s
		switch s.art {
		case 'S', 'W', 'P':
			u.stellwerte = append(u.stellwerte, s)
		case 'B', 'C', 'T':
			z := &zustand{kennung: s.kennung, name: s.name, ort: h.ort, sym: s}
			switch s.art {
			case 'B':
				z.art = "boolean"
			case 'C':
				z.art = "counter"
			case 'T':
				z.art = "timer"
			}
			s.zustand = z
			u.zustaende = append(u.zustaende, z)
		}
	}
}

func groesseAusEinheit(e string) *groesse {
	switch strings.TrimSpace(e) {
	case "°C", "°c", "C":
		return neueGroesse(gTemp, "°C")
	case "K":
		return neueGroesse(gAbstand, "K")
	case "W":
		return neueGroesse(gLeistung, "W")
	case "kW":
		return neueGroesse(gLeistung, "kW")
	case "%":
		return neueGroesse(gProzent, "%")
	case "°":
		return neueGroesse(gWinkel, "°")
	case "s":
		return neueGroesse(gDauer, "s")
	case "min":
		return neueGroesse(gDauer, "min")
	case "h":
		return neueGroesse(gDauer, "h")
	case "":
		return neueGroesse(gZahl, "")
	}
	return neueGroesse(gUnbekannt, e)
}

// aliasVon erkennt einen Vorlagen-Sensor, der nur den Wert einer anderen Entität weitergibt.
func (u *uebersetzer) aliasVon(v *vorlageSensor) string {
	t, _ := u.ha.vorlagenText(v.ort.Datei, v.state)
	tpl, err := LiesVorlage(t)
	if err != nil {
		return ""
	}
	var ausgabe *jAusgabe
	for _, k := range tpl.rumpf {
		switch x := k.(type) {
		case jText:
			if strings.TrimSpace(x.text) != "" {
				return ""
			}
		case jAusgabe:
			if ausgabe != nil {
				return ""
			}
			ausgabe = &x
		default:
			return ""
		}
	}
	if ausgabe == nil {
		return ""
	}
	e := ausgabe.e
	if f, ok := e.(jFilter); ok && (f.name == "float" || f.name == "int") && len(f.args) == 0 {
		e = f.e
	}
	a, ok := e.(jAufruf)
	if !ok || len(a.args) != 1 {
		return ""
	}
	if n, ok := a.f.(jName); !ok || n.n != "states" {
		return ""
	}
	id, ok := a.args[0].(jTextWert)
	if !ok {
		return ""
	}
	return id.s
}

func (u *uebersetzer) legeVorlagenAn() {
	// zuerst die Weitergaben: sie werden der Eingang selbst, mit ihrem Namen
	for _, v := range u.ha.vorlagen {
		ziel := u.aliasVon(v)
		if ziel == "" || !istRohEntity(ziel) {
			continue
		}
		s := u.symbole[ziel]
		if s == nil {
			s = u.neuerEingang(ziel, v.name, v.ort)
		} else if s.nameGeraten {
			s.name, s.nameGeraten = kuerze(v.name, 40), false
		}
		vereinige(s.q, groesseAusEinheit(v.einheit))
		u.symbole["sensor."+haSlug(v.name)] = s
		if v.uniqueID != "" {
			u.symbole[v.art+"."+v.uniqueID] = s
		}
		v.art = "alias"
		if v.availability != nil {
			at, _ := u.ha.vorlagenText(v.ort.Datei, v.availability)
			if !strings.Contains(at, ziel) {
				u.hinweis(v.ort, "", "Die Verfügbarkeit dieses Sensors hängt in Home Assistant an mehr als seinem Messwert; in der Logik gilt er, solange der Messwert frisch ist.")
			}
		}
	}
	for _, v := range u.ha.vorlagen {
		if v.art == "alias" {
			continue
		}
		s := &symbol{entity: v.art + "." + haSlug(v.name), name: kuerze(v.name, 40), ort: v.ort, vorlage: v}
		st, _ := u.ha.vorlagenText(v.ort.Datei, v.state)
		switch {
		case v.art == "binary_sensor" && strings.Contains(st, "this.state"):
			s.art = 'B'
			s.q = neueGroesse(gJaNein, "")
		case v.art == "binary_sensor":
			s.art = 'F'
			s.q = neueGroesse(gJaNein, "")
		default:
			s.art = 'F'
			s.q = groesseAusEinheit(v.einheit)
			if v.einheit == "" {
				s.q = neueGroesse(gOffen, "")
			}
		}
		s.kennung = u.neueKennung(haSlug(v.name))
		u.symbole[s.entity] = s
		if v.uniqueID != "" {
			u.symbole[v.art+"."+v.uniqueID] = s
		}
		if s.art == 'B' {
			z := &zustand{kennung: s.kennung, name: s.name, art: "boolean", ort: v.ort, sym: s, nachNeustart: "off"}
			s.zustand = z
			u.zustaende = append(u.zustaende, z)
		}
	}
}

// istRohEntity: eine Entität einer Integration (Messwert, Schalter), kein Helfer und keine Vorlage.
func istRohEntity(id string) bool {
	return strings.HasPrefix(id, "sensor.") || strings.HasPrefix(id, "binary_sensor.")
}

func (u *uebersetzer) neuerEingang(entity, name string, ort Ort) *symbol {
	objekt := entity[strings.Index(entity, ".")+1:]
	s := &symbol{art: 'E', entity: entity, ort: ort, q: neueGroesse(gOffen, "")}
	if strings.HasPrefix(entity, "binary_sensor.") {
		s.q = neueGroesse(gJaNein, "")
	}
	if name != "" {
		s.name = kuerze(name, 40)
		s.kennung = u.neueKennung(haSlug(name))
	} else {
		s.name, s.nameGeraten = nameAus(objekt), true
		s.kennung = u.neueKennung(objekt)
	}
	if z, ok := u.zuordnung[s.kennung]; ok && z.Wert != "" {
		s.quelle = z.Wert
		if strings.HasPrefix(s.quelle, "-") {
			s.quelle, s.gedreht = strings.TrimPrefix(s.quelle, "-"), true
		}
		if s.nameGeraten && z.Name != "" {
			s.name = kuerze(z.Name, 40)
		}
		// Die Quelle bringt ihre Größe mit; so bekommen auch feste Zahlen daneben ihre Einheit.
		if g := quellenGroesse(s.quelle); g != "" && g != gZahl {
			s.zugeordneteGroesse = g
		}
	}
	u.symbole[entity] = s
	u.eingaenge = append(u.eingaenge, s)
	return s
}

func (u *uebersetzer) sonne() *symbol {
	if u.sonneSym == nil {
		u.sonneSym = &symbol{art: 'U', entity: "sun.sun", name: "Sonnenstand", kennung: u.neueKennung("sonnenstand"),
			q: neueGroesse(gWinkel, "°"), quelle: "sun.elevation"}
		u.eingaenge = append(u.eingaenge, u.sonneSym)
		u.symbole["sun.sun"] = u.sonneSym
	}
	u.sonneSym.gelesen = true
	return u.sonneSym
}

var ausgangsMuster = regexp.MustCompile(`^(.*?)_?(?:l|p|phase|stufe|relay|relais|ch|kanal|ausgang|output)?_?(\d+)$`)

// geraetVon ordnet einen Schalter einem Gerät zu: switch.puffer_2_l1 ist Ausgang 1 von "puffer_2".
func (u *uebersetzer) geraetVon(entity string) (*geraet, int) {
	objekt := entity[strings.Index(entity, ".")+1:]
	stamm, index := objekt, 1
	if m := ausgangsMuster.FindStringSubmatch(objekt); m != nil && m[1] != "" {
		stamm = m[1]
		index, _ = strconv.Atoi(m[2])
	}
	g := u.geraete[stamm]
	if g == nil {
		g = &geraet{stamm: stamm, kennung: u.neueKennung(stamm), entities: map[int]string{}, an: map[int][]*ir{}, aus: map[int][]*ir{}}
		u.geraete[stamm] = g
		u.geraetListe = append(u.geraetListe, g)
	}
	if alt, ok := g.entities[index]; ok && alt != entity {
		// zwei Schalter mit derselben Nummer: dann ist jeder ein eigenes Gerät
		return u.geraetVon(entity + "_" + strconv.Itoa(len(u.geraete)))
	}
	g.entities[index] = entity
	return g, index
}

func (g *geraet) ausgaenge() int {
	n := 0
	for i := range g.entities {
		if i > n {
			n = i
		}
	}
	return n
}

func (u *uebersetzer) legeLaufzeitenAn() {
	for _, l := range u.ha.laufzeiten {
		id := "sensor." + haSlug(l.name)
		ok := strings.HasPrefix(l.entity, "switch.") && (l.zustand == "on" || l.zustand == "") && (l.typ == "time" || l.typ == "") &&
			strings.Contains(strings.ReplaceAll(l.start, " ", ""), "today_at") && strings.Contains(strings.ReplaceAll(l.ende, " ", ""), "now()")
		if !ok {
			u.symbole[id] = &symbol{art: 'X', entity: id, ort: l.ort, name: l.name}
			continue
		}
		g, i := u.geraetVon(l.entity)
		u.symbole[id] = &symbol{art: 'H', entity: id, ort: l.ort, geraet: g, index: i, name: l.name}
	}
}

// symbolFuer nennt das Symbol einer Entität; Messwerte und Schalter entstehen beim ersten Lesen.
func (u *uebersetzer) symbolFuer(a *auswerter, entity string) *symbol {
	if s, ok := u.symbole[entity]; ok {
		if s.art == 'X' {
			a.stopp("„%s“ zählt nicht die Einschaltzeit eines Schalters seit Mitternacht (history_stats mit type: time, start today_at(), end now()) und lässt sich nicht übersetzen", entity)
		}
		return s
	}
	switch {
	case entity == "sun.sun":
		return u.sonne()
	case istRohEntity(entity):
		return u.neuerEingang(entity, "", a.ortJetzt())
	case strings.HasPrefix(entity, "switch.") || strings.HasPrefix(entity, "light.") || strings.HasPrefix(entity, "input_boolean."):
		if strings.HasPrefix(entity, "input_boolean.") {
			a.stopp("„%s“ steht in keiner Datei", entity)
		}
		g, i := u.geraetVon(entity)
		s := &symbol{art: 'A', entity: entity, geraet: g, index: i}
		u.symbole[entity] = s
		return s
	}
	a.stopp("„%s“ steht in keiner Datei und ist kein Messwert, den die Logik lesen kann", entity)
	return nil
}

// ref ist der Name, unter dem die Logik den Wert eines Symbols liest.
func (u *uebersetzer) ref(s *symbol) *ir {
	s.gelesen = true
	switch s.art {
	case 'A':
		return &ir{art: 'A', text: s.geraet.stamm, v: float64(s.index)}
	case 'H':
		return &ir{art: 'H', text: s.geraet.stamm, v: float64(s.index), q: neueGroesse(gDauer, "h")}
	case 'W':
		return &ir{art: 'r', text: s.kennung, q: neueGroesse(gUhrzeit, "")}
	}
	n := name(s.kennung, s.q)
	if s.gedreht {
		return neg(n)
	}
	return n
}

// zahlVon: states(x)|float - der Wert und, wenn er fehlen kann, der Eingang.
func (u *uebersetzer) zahlVon(a *auswerter, entity string) (*ir, *ir) {
	s := u.symbolFuer(a, entity)
	switch s.art {
	case 'S', 'C', 'F', 'H':
		if s.art == 'S' && s.q != nil {
			if g, _ := s.q.aufgeloest(); g == gJaNein {
				a.stopp("„%s“ ist ein Schalter, keine Zahl", entity)
			}
		}
		return u.ref(s), nil
	case 'U':
		return u.ref(s), nil // den Sonnenstand rechnet die Box immer
	case 'E':
		if g, _ := s.q.aufgeloest(); g == gJaNein {
			a.stopp("„%s“ ist ein Ja/Nein-Wert, keine Zahl", entity)
		}
		return u.ref(s), name(s.kennung, s.q)
	case 'T':
		a.stopp("die Restzeit eines Zeitgebers lässt sich nicht lesen")
	}
	a.stopp("„%s“ ist keine Zahl", entity)
	return nil, nil
}

// uhrzeitVon: der Zustand eines input_datetime als Uhrzeit.
func (u *uebersetzer) uhrzeitVon(a *auswerter, entity string) *ir {
	s := u.symbolFuer(a, entity)
	if s.art != 'W' {
		a.stopp("„%s“ ist keine Uhrzeit", entity)
	}
	return u.ref(s)
}

// zustandIst: is_state(x, wort).
func (u *uebersetzer) zustandIst(a *auswerter, entity, wort string) *ir {
	s := u.symbolFuer(a, entity)
	fehlt := wort == "unavailable" || wort == "unknown"
	if fehlt && s.art != 'E' && s.art != 'A' {
		// Helfer und Vorlagen haben in der Logik immer einen Wert
		return wahr(false)
	}
	switch s.art {
	case 'S', 'B', 'F', 'E':
		if s.art != 'E' {
			if g, _ := s.q.aufgeloest(); g != gJaNein && !fehlt {
				if v, err := strconv.ParseFloat(wort, 64); err == nil {
					return vergleiche("==", u.ref(s), zahl(v, nil))
				}
				a.stopp("„%s“ ist kein Schalter", entity)
			}
		}
		switch {
		case fehlt && s.art == 'E':
			return aufruf("unknown", nil, u.ref(s))
		case fehlt:
			return wahr(false)
		case wort == "on":
			vereinige(s.q, neueGroesse(gJaNein, ""))
			return u.ref(s)
		case wort == "off":
			vereinige(s.q, neueGroesse(gJaNein, ""))
			return nicht(u.ref(s))
		}
	case 'T':
		u.ref(s)
		switch wort {
		case "idle":
			return nicht(aufruf("running", nil, name(s.kennung, s.q)))
		case "active":
			return aufruf("running", nil, name(s.kennung, s.q))
		}
	case 'A':
		switch wort {
		case "on":
			return u.ref(s)
		case "off":
			return nicht(u.ref(s))
		case "unavailable", "unknown":
			return wahr(false)
		}
	case 'P':
		for _, o := range s.helfer.optionen {
			if o == wort {
				return vergleiche("==", u.ref(s), name(optionsWort(o), neueGroesse(gZahl, "")))
			}
		}
		a.stopp("„%s“ ist keine Option von %s", wort, entity)
	case 'C':
		if v, err := strconv.ParseFloat(wort, 64); err == nil {
			return vergleiche("==", u.ref(s), zahl(v, nil))
		}
	case 'W':
		return vergleiche("==", u.ref(s), &ir{art: 'u', text: uhrText(wort)})
	case 'U':
		a.stopp("der Zustand der Sonne (über oder unter dem Horizont) lässt sich nicht übersetzen; nutzen Sie state_attr('sun.sun', 'elevation')")
	case 'L':
		a.stopp("„%s“ ist der Statustext; ihn liest die Logik nicht", entity)
	}
	a.stopp("is_state(%s, '%s') lässt sich nicht übersetzen", entity, wort)
	return nil
}

func optionsWort(o string) string {
	k := kennungAus(o)
	if reservierteWoerter[k] {
		k += "_wahl"
	}
	return k
}

// seit: (now() - states.x.last_changed).total_seconds()
func (u *uebersetzer) seit(a *auswerter, s *symbol) *ir {
	switch s.art {
	case 'B', 'C', 'T':
		u.ref(s)
		return aufruf("since", neueGroesse(gDauer, "s"), name(s.kennung, s.q))
	}
	a.stopp("„%s“: wann sich ein Wert zuletzt änderte, kennt die Logik nur von ihren Zuständen", s.entity)
	return nil
}

// alsFormel macht eine mehrfach gelesene Variable einer Vorlage zu einer Formel der Logik.
func (u *uebersetzer) alsFormel(n string, w wert, o Ort) wert {
	if (w.art != 'z' && w.art != 'b') || w.e.art == 'r' || w.e.art == 'z' || w.e.art == 'w' || w.e.art == 'A' || w.e.art == 'H' ||
		w.e.art == 'u' || w.e.art == 'k' || (w.e.art == 'n' && w.e.kinder[0].art == 'r') || (w.e.art == 'x' && w.e.kinder[0].art == 'r') {
		return w
	}
	for _, f := range u.formeln {
		if f.sym.vorlage == nil && f.e.String() == w.e.String() {
			return wert{art: w.art, e: name(f.kennung, w.e.groesse())}
		}
	}
	k := u.neueKennung(n)
	s := &symbol{art: 'F', kennung: k, name: k, q: w.e.groesse(), ort: o}
	f := &formel{kennung: k, e: w.e, ort: o, sym: s}
	s.formel = f
	u.formeln = append(u.formeln, f)
	u.wurzeln = append(u.wurzeln, &f.e)
	u.wurzelOrt = append(u.wurzelOrt, o)
	return wert{art: w.art, e: name(k, w.e.groesse())}
}

// werte wertet eine Vorlage aus einer Datei aus.
func (u *uebersetzer) werte(datei string, n *yaml.Node, this string) ([]ausgabe, *Stelle) {
	return u.werteMit(datei, n, this, nil)
}

// werteMit wertet eine Vorlage mit Variablen aus (variables eines Skripts).
func (u *uebersetzer) werteMit(datei string, n *yaml.Node, this string, env umgebung) ([]ausgabe, *Stelle) {
	t, zeile := u.ha.vorlagenText(datei, n)
	o := Ort{Datei: datei, Zeile: zeile}
	tpl, err := LiesVorlage(t)
	if err != nil {
		if jf, ok := err.(*jFehler); ok {
			o.Zeile += jf.zeile
		}
		return nil, &Stelle{Ort: o, Was: "Vorlage", Grund: "nicht lesbar: " + err.Error()}
	}
	a := &auswerter{u: u, ort: o, this: this, naechste: &u.naechste}
	if env != nil {
		env = env.kopie()
	}
	aus, f := a.deute(tpl, env)
	if f != nil {
		return nil, &Stelle{Ort: Ort{Datei: datei, Zeile: zeile + f.zeile}, Was: "Vorlage", Grund: f.grund}
	}
	return aus, nil
}

// wertVon fasst die Ausgaben einer Vorlage zu einem Wert zusammen.
func (u *uebersetzer) wertVon(aus []ausgabe, ja bool) (*ir, string) {
	if len(aus) == 0 {
		return nil, "die Vorlage gibt nichts aus"
	}
	pfade := map[string]bool{}
	for _, x := range aus {
		if pfade[x.pfad] {
			return nil, "die Vorlage setzt einen Wert aus mehreren Teilen zusammen"
		}
		pfade[x.pfad] = true
	}
	umwandeln := func(w wert) (*ir, string) {
		switch w.art {
		case 'z':
			if ja {
				return nil, "der Binärsensor gibt eine Zahl aus"
			}
			return w.e, ""
		case 'b':
			if !ja {
				return nil, "der Sensor gibt Ja/Nein aus"
			}
			return w.e, ""
		case 't':
			if ja {
				switch strings.ToLower(w.text) {
				case "true", "on", "yes", "1":
					return wahr(true), ""
				case "false", "off", "no", "0":
					return wahr(false), ""
				}
			}
			if v, err := strconv.ParseFloat(w.text, 64); err == nil && !ja {
				return zahl(v, nil), ""
			}
			return nil, "Text"
		case 's':
			return nil, "die Vorlage gibt den Zustand einer Entität als Text aus"
		}
		return nil, "die Vorlage gibt keinen Wert aus, mit dem sich rechnen lässt"
	}
	e, grund := umwandeln(aus[len(aus)-1].w)
	if grund != "" {
		return nil, grund
	}
	for i := len(aus) - 2; i >= 0; i-- {
		v, grund := umwandeln(aus[i].w)
		if grund != "" {
			return nil, grund
		}
		e = wenn(aus[i].bed, v, e)
	}
	return e, ""
}

func (u *uebersetzer) deuteVorlagen() {
	for _, v := range u.ha.vorlagen {
		if v.art == "alias" {
			continue
		}
		s := u.symbole[v.art+"."+haSlug(v.name)]
		if v.attribute {
			u.ergebnis.NichtUebernommen = append(u.ergebnis.NichtUebernommen, Stelle{Ort: v.ort, Was: v.name + ": attributes",
				Grund: "Attribute eines Sensors übernimmt die Logik nicht; liest eine Vorlage sie, ist das ein eigener Fund."})
		}
		if s.art == 'B' {
			u.deuteHysterese(v, s)
			continue
		}
		aus, f := u.werte(v.ort.Datei, v.state, "")
		if f != nil {
			u.offen = nil
			f.Was = v.name
			u.nichtUebersetzbar(f.Ort, f.Was, f.Grund)
			continue
		}
		e, grund := u.wertVon(aus, v.art == "binary_sensor")
		if grund == "Text" && v.art == "sensor" {
			u.deuteLage(v, s, aus)
			continue
		}
		u.gibOffen(nil)
		if grund != "" {
			u.nichtUebersetzbar(v.ort, v.name, grund)
			continue
		}
		if v.availability != nil {
			u.hinweis(v.ort, "formulas."+s.kennung, "Die Verfügbarkeit (availability) dieses Sensors übernimmt die Logik nicht: die Formel ist unbekannt, wenn ein Wert fehlt, den sie braucht.")
		}
		vereinige(s.q, e.groesse())
		f2 := &formel{kennung: s.kennung, e: e, ort: v.ort, kommentar: v.name, sym: s}
		s.formel = f2
		u.formeln = append(u.formeln, f2)
		u.wurzeln = append(u.wurzeln, &f2.e)
		u.wurzelOrt = append(u.wurzelOrt, v.ort)
	}
}

// deuteHysterese: ein Binärsensor, der seinen eigenen Wert liest, merkt sich etwas. Er geht
// an, wenn die Vorlage mit "aus" wahr ergibt, und aus, wenn sie mit "an" falsch ergibt.
func (u *uebersetzer) deuteHysterese(v *vorlageSensor, s *symbol) {
	z := s.zustand
	ergebnis := map[string]*ir{}
	for _, this := range []string{"off", "on"} {
		aus, f := u.werte(v.ort.Datei, v.state, this)
		if f != nil {
			u.nichtUebersetzbar(f.Ort, v.name, f.Grund)
			return
		}
		e, grund := u.wertVon(aus, true)
		if grund != "" {
			u.nichtUebersetzbar(v.ort, v.name, grund)
			return
		}
		ergebnis[this] = e
	}
	u.gibOffen(nil)
	z.an = []*ir{ergebnis["off"]}
	z.ausAlle = []*ir{nicht(ergebnis["on"])}
	u.wurzeln = append(u.wurzeln, &z.an[0], &z.ausAlle[0])
	u.wurzelOrt = append(u.wurzelOrt, v.ort, v.ort)
	z.kommentare = append(z.kommentare, "Binärsensor mit eigenem Wert (this.state): wird ein Schalter, der sich merkt, ob er an ist.")
}

// deuteLage: der Sensor mit Texten wird die Lage (die erste zutreffende Zeile gilt).
func (u *uebersetzer) deuteLage(v *vorlageSensor, s *symbol, aus []ausgabe) {
	if u.lage != nil {
		s.art = 'L'
		u.ergebnis.NichtUebernommen = append(u.ergebnis.NichtUebernommen, Stelle{Ort: v.ort, Was: v.name,
			Grund: "Eine Logik hat eine Lage; sie stammt aus „" + u.lageName + "“. Dieser zweite Statustext wird nicht übernommen."})
		return
	}
	s.art = 'L'
	u.lageOrt, u.lageName = v.ort, v.name
	var zeilen []lageZeile
	for i, x := range aus {
		if x.w.art != 't' {
			u.nichtUebersetzbar(v.ort, v.name, "der Statustext setzt Werte ein; die Lage schreibt Werte mit {Formel} in ihren Satz")
			return
		}
		z := lageZeile{titel: kuerze(x.w.text, 40), wenn: x.bed, art: lageArt(x.w.text)}
		if i == len(aus)-1 && x.bed.istWahr(true) {
			z.sonst, z.wenn = true, nil
		}
		zeilen = append(zeilen, z)
	}
	if !zeilen[len(zeilen)-1].sonst {
		zeilen = append(zeilen, lageZeile{sonst: true, titel: kuerze(v.name, 40), art: "idle"})
		u.hinweis(v.ort, "status", "Der Statustext hat keinen Zweig für alle übrigen Fälle; die Logik zeigt dann den Namen des Sensors.")
	}
	u.lage = zeilen
	// Ein Ersatzwert zählt nicht, wenn eine Zeile davor den fehlenden Wert schon abfängt (unknown(x)).
	u.gibOffen(func(o offenerHinweis) bool {
		for i, z := range zeilen {
			if z.wenn != nil && enthaelt(z.wenn, o.cmp) {
				for _, vor := range zeilen[:i] {
					if vor.wenn != nil && deckt(vor.wenn, "unknown", o.fehlbar) {
						return true
					}
				}
			}
		}
		return false
	})
	for i := range u.lage {
		if u.lage[i].wenn != nil {
			u.wurzeln = append(u.wurzeln, &u.lage[i].wenn)
			u.wurzelOrt = append(u.wurzelOrt, v.ort)
		}
	}
	u.hinweis(v.ort, "status", "Die Art jeder Zeile der Lage (Sonne, Netz, wartet, ruht, Störung) kennt Home Assistant nicht; sie ist aus dem Titel geschätzt. Den Satz für den Kunden (text) schreiben Sie im Aufbau dazu.")
}

func lageArt(titel string) string {
	t := strings.ToLower(titel)
	enthaelt := func(ws ...string) bool {
		for _, w := range ws {
			if strings.Contains(t, w) {
				return true
			}
		}
		return false
	}
	switch {
	case enthaelt("stör", "stoer", "fehler", "fault", "error", "defekt"):
		return "fault"
	case enthaelt("wartet", "warte"):
		return "waiting"
	case enthaelt("keine", "pause", "ruht", " aus", "nacht"):
		return "idle"
	case enthaelt("netz", "notheiz", "notbetrieb", "grid"):
		return "grid"
	case enthaelt("sonnenstrom", "solar", "pv", "heizt mit sonne"):
		return "solar"
	}
	return "waiting"
}
