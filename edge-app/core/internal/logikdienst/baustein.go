package logikdienst

// Bausteine (Stufe 5, Bericht 6.7, E4 = A): ein Baustein ist eine Logik mit
// Lücken und einem Satz für die Oberfläche ("Wenn der Speicher unter {mindest}
// fällt, heize mit {heizstab} aus dem Netz …"). Die Lücken sind die Geräte und
// die Fühler der Logik und die Stellwerte, die der Satz nennt. Beim Einsetzen
// füllt der Dienst die Lücken mit Geräten und Werten einer Anlage und ändert im
// Text genau diese Stellen - Kommentare und alle übrigen Zeilen bleiben, wie der
// Verfasser sie schrieb. Heraus kommt eine gewöhnliche Logik, geprüft mit
// denselben Lesern wie jede andere, und ihre Proben als "So verhält sie sich".
//
// Ein Rechner (Bericht 6.6): Portal und API lesen weder den Baustein noch die
// Logik darin; sie fragen hier.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
	"gopkg.in/yaml.v3"
)

// BausteinSprache ist die Version der Baustein-Form (`block: 1`).
const BausteinSprache = 1

const (
	maxBausteinName  = 80
	maxBausteinSatz  = 300
	maxBausteinBesch = 300
)

// Die Arten einer Lücke.
const (
	LueckeGeraet    = "geraet"
	LueckeEingang   = "eingang"
	LueckeStellwert = "stellwert"
)

// ErrBaustein marks a building block the reader refuses (the German reason follows).
var ErrBaustein = errors.New("Baustein nicht lesbar")

func bausteinFehler(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrBaustein, fmt.Sprintf(format, a...))
}

// SatzTeil ist ein Stück des Satzes: fester Text oder eine Lücke.
type SatzTeil struct {
	Text   string `json:"text,omitempty"`
	Luecke string `json:"luecke,omitempty"`
}

// Kandidat ist ein Gerät oder Fühler der Anlage, der in eine Lücke passt.
type Kandidat struct {
	EntityID string `json:"entity_id"`
	Name     string `json:"name"`
}

// Luecke ist eine Stelle, die beim Einsetzen gefüllt wird.
type Luecke struct {
	Kennung string `json:"kennung"`
	// Art: geraet, eingang (ein Fühler oder Signal eines Geräts) oder stellwert.
	Art  string `json:"art"`
	Name string `json:"name"`
	// ImSatz: der Satz nennt die Lücke; die übrigen stehen unter dem Satz.
	ImSatz bool `json:"im_satz"`
	// Gerät: die Ausgänge, die die Logik ihm stellt, die Einheit eines Sollwerts, die
	// Betriebsarten, die sie fest wählt, und die Signale, die sie an ihm liest.
	Ausgaenge     []string `json:"ausgaenge,omitempty"`
	Sollwert      string   `json:"sollwert,omitempty"`
	Betriebsarten []string `json:"betriebsarten,omitempty"`
	Signale       []string `json:"signale,omitempty"`
	// Eingang: das Signal, das er liest (temperature, door_open, …).
	Signal string `json:"signal,omitempty"`
	// Stellwert: Art, Einheit, Bereich, Schritt wie im Prüfbericht.
	Stellwert *logik.StellwertInfo `json:"stellwert,omitempty"`
	// Wert ist die Füllung: die Kennung des Geräts oder Fühlers, beim Stellwert der Wert
	// in der Form des Dokuments ("60 °C", "06:00", "on"); WertText derselbe für Menschen.
	Wert     any    `json:"wert"`
	WertText string `json:"wert_text,omitempty"`
	// Kandidaten: was die Anlage für ein Gerät oder einen Eingang anbietet.
	Kandidaten []Kandidat `json:"kandidaten,omitempty"`
	// Fehler: warum die Füllung nicht passt (dann gilt der Wert des Bausteins).
	Fehler string `json:"fehler,omitempty"`
}

// Baustein ist ein gelesener Baustein.
type Baustein struct {
	Name         string     `json:"name"`
	Beschreibung string     `json:"beschreibung,omitempty"`
	Satz         []SatzTeil `json:"satz"`
	Luecken      []Luecke   `json:"luecken"`

	logikText []byte
	json      bool
	L         *logik.Logik
	// gebunden: Eingänge, die ein Signal eines Geräts der Logik lesen (Eingang → Gerät).
	gebunden map[string]string
}

var platzhalter = regexp.MustCompile(`\{([a-z][a-z0-9_]{0,31})\}`)

// LiesBaustein liest einen Baustein in der YAML-Schreibform oder als JSON.
func LiesBaustein(text []byte) (*Baustein, error) {
	if len(text) > MaxTextBytes {
		return nil, bausteinFehler("größer als %d KB", MaxTextBytes/1024)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(text, &doc); err != nil {
		return nil, bausteinFehler("YAML: %s", err.Error())
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, bausteinFehler("ein Baustein ist ein Objekt")
	}
	m := doc.Content[0]
	felder := map[string]*yaml.Node{}
	for i := 0; i+1 < len(m.Content); i += 2 {
		k := m.Content[i].Value
		switch k {
		case "block", "name", "description", "sentence", "logic":
		default:
			return nil, bausteinFehler("unbekannter Schlüssel „%s“", k)
		}
		if _, doppelt := felder[k]; doppelt {
			return nil, bausteinFehler("doppelter Schlüssel „%s“", k)
		}
		felder[k] = m.Content[i+1]
	}
	for _, k := range []string{"block", "name", "sentence", "logic"} {
		if felder[k] == nil {
			return nil, bausteinFehler("„%s“ fehlt", k)
		}
	}
	if v := felder["block"]; v.Kind != yaml.ScalarNode || v.Value != strconv.Itoa(BausteinSprache) {
		return nil, bausteinFehler("block: nur Version %d", BausteinSprache)
	}
	text1 := func(k string, max int) (string, error) {
		v := felder[k]
		if v == nil {
			return "", nil
		}
		if v.Kind != yaml.ScalarNode || v.Tag != "!!str" {
			return "", bausteinFehler("„%s“ ist ein Text", k)
		}
		s := strings.TrimSpace(v.Value)
		if s == "" || utf8.RuneCountInString(s) > max {
			return "", bausteinFehler("„%s“: 1 bis %d Zeichen", k, max)
		}
		return s, nil
	}
	b := &Baustein{gebunden: map[string]string{}}
	var err error
	if b.Name, err = text1("name", maxBausteinName); err != nil {
		return nil, err
	}
	if b.Beschreibung, err = text1("description", maxBausteinBesch); err != nil {
		return nil, err
	}
	satz, err := text1("sentence", maxBausteinSatz)
	if err != nil {
		return nil, err
	}
	lv := felder["logic"]
	if lv.Kind != yaml.ScalarNode || lv.Tag != "!!str" {
		return nil, bausteinFehler("„logic“ ist der Text einer Logik")
	}
	b.logikText = []byte(lv.Value)
	b.json = istJSON(b.logikText)
	b.L, err = liesLogik(b.logikText)
	if err != nil {
		return nil, bausteinFehler("logic: %s", err.Error())
	}
	if err := b.luecken(satz); err != nil {
		return nil, err
	}
	return b, nil
}

// liesLogik liest den Text einer Logik (Schreibform oder JSON) mit den Lesern der Box.
func liesLogik(text []byte) (*logik.Logik, error) {
	var baum *textform.Knoten
	var err error
	if istJSON(text) {
		baum, err = textform.LiesJSON(text)
	} else {
		baum, err = textform.Lies(text)
	}
	if err != nil {
		return nil, err
	}
	kanonisch, err := baum.JSON()
	if err != nil {
		return nil, err
	}
	return logik.Lesen(kanonisch)
}

// istFesteQuelle: die Quellen, die die Box an jeder Anlage liest, sind keine Lücke.
func istFesteQuelle(source string) bool {
	for _, q := range FesteQuellen {
		if q.Source == source {
			return true
		}
	}
	return false
}

// teileQuelle trennt "<gerät>.<signal>" am letzten Punkt.
func teileQuelle(source string) (string, string) {
	i := strings.LastIndex(source, ".")
	if i <= 0 {
		return source, ""
	}
	return source[:i], source[i+1:]
}

// luecken bestimmt Satz und Lücken: jedes Gerät, jeder Eingang, der ein Gerät der
// Anlage liest (außer einem Signal eines Geräts der Logik: das folgt dem Gerät), und
// jeder Stellwert, den der Satz nennt.
func (b *Baustein) luecken(satz string) error {
	L := b.L
	geraetVon := map[string]string{}
	for _, k := range L.GeraetListe {
		geraetVon[L.Geraete[k].Entity] = k
	}
	alle := map[string]*Luecke{}
	var reihe []string
	for _, k := range L.GeraetListe {
		g := L.Geraete[k]
		l := &Luecke{Kennung: k, Art: LueckeGeraet, Name: g.Name, Wert: g.Entity}
		for _, art := range []string{"level", "on_off", "setpoint", "mode", "percent"} {
			if _, ok := L.Ausgaenge[k][art]; ok {
				l.Ausgaenge = append(l.Ausgaenge, art)
			}
		}
		switch L.SollwertGroesse(k) {
		case logik.GroesseTemp:
			l.Sollwert = "°C"
		case logik.GroesseKW:
			l.Sollwert = "kW"
		}
		l.Betriebsarten = L.FesteBetriebsarten(k)
		alle[k] = l
		reihe = append(reihe, k)
	}
	for _, k := range L.WertListe {
		src := L.Werte[k].Source
		if istFesteQuelle(src) {
			continue
		}
		ent, signal := teileQuelle(src)
		if signal == "" {
			return bausteinFehler("inputs.%s: eine Quelle ist „<Gerät>.<Signal>“", k)
		}
		if g, ok := geraetVon[ent]; ok {
			b.gebunden[k] = g
			if l := alle[g]; !slices.Contains(l.Signale, signal) {
				l.Signale = append(l.Signale, signal)
			}
			continue
		}
		alle[k] = &Luecke{Kennung: k, Art: LueckeEingang, Name: L.Werte[k].Name, Signal: signal, Wert: ent}
		reihe = append(reihe, k)
	}
	infos := map[string]logik.StellwertInfo{}
	for _, i := range L.StellwertInfos() {
		infos[i.Kennung] = i
	}
	var imSatz []string
	rest := satz
	for {
		m := platzhalter.FindStringSubmatchIndex(rest)
		if m == nil {
			if rest != "" {
				b.Satz = append(b.Satz, SatzTeil{Text: rest})
			}
			break
		}
		if m[0] > 0 {
			b.Satz = append(b.Satz, SatzTeil{Text: rest[:m[0]]})
		}
		k := rest[m[2]:m[3]]
		l := alle[k]
		if l == nil {
			info, ok := infos[k]
			switch {
			case !ok:
				return bausteinFehler("sentence: „{%s}“ ist kein Gerät, kein Fühler und kein Stellwert der Logik", k)
			case info.Art == "schedule":
				return bausteinFehler("sentence: „{%s}“ ist ein Zeitplan; einen Zeitplan stellt der Kunde an der Karte, nicht im Satz", k)
			}
			i := info
			l = &Luecke{Kennung: k, Art: LueckeStellwert, Name: info.Name, Stellwert: &i, Wert: info.Vorgabe}
			alle[k] = l
		}
		if !l.ImSatz {
			l.ImSatz = true
			imSatz = append(imSatz, k)
		}
		b.Satz = append(b.Satz, SatzTeil{Luecke: k})
		rest = rest[m[1]:]
	}
	gesehen := map[string]bool{}
	for _, k := range append(imSatz, reihe...) {
		if gesehen[k] {
			continue
		}
		gesehen[k] = true
		b.Luecken = append(b.Luecken, *alle[k])
	}
	return nil
}

// Fuellung sind die Werte für die Lücken: die Kennung eines Geräts oder Fühlers der
// Anlage, für einen Stellwert der Wert in der Form des Dokuments; dazu der Name der Logik.
type Fuellung struct {
	Name  string                     `json:"name,omitempty"`
	Werte map[string]json.RawMessage `json:"werte,omitempty"`
}

// Eingesetzt ist ein gefüllter Baustein: die Logik als Text, ihre Prüfung und ihre Proben
// in der Reihenfolge eines Tages ("So verhält sie sich").
type Eingesetzt struct {
	Name         string     `json:"name"`
	Beschreibung string     `json:"beschreibung,omitempty"`
	Satz         []SatzTeil `json:"satz"`
	Luecken      []Luecke   `json:"luecken"`
	// Vollstaendig: jedes Gerät und jeder Fühler hat ein passendes Gegenüber der Anlage,
	// kein Gerät steht zweimal, kein Wert ist abgelehnt. Nur dann wird gespeichert.
	Vollstaendig bool `json:"vollstaendig"`
	// Text ist die Logik mit den Füllungen, Kanonisch ihre kanonische Form.
	Text      string   `json:"text"`
	Kanonisch string   `json:"kanonisch,omitempty"`
	Bericht   *Bericht `json:"bericht"`
	// Verhalten sind die Proben nach ihrer Uhrzeit.
	Verhalten []Probe `json:"verhalten"`
}

// Einsetzen füllt einen Baustein für eine Anlage. Fehlt einem Gerät oder Fühler die
// Füllung, schlägt der Dienst das erste passende der Anlage vor (verschiedene Geräte für
// verschiedene Lücken, wo es geht); ein Stellwert ohne Füllung behält die Vorgabe.
func Einsetzen(dok []byte, f Fuellung, registry json.RawMessage) (*Eingesetzt, error) {
	b, err := LiesBaustein(dok)
	if err != nil {
		return nil, err
	}
	bestand := Quellen(registry)
	b.kandidaten(bestand)
	vollstaendig := true
	vergeben := map[string]bool{}
	for i := range b.Luecken {
		l := &b.Luecken[i]
		roh, gefuellt := f.Werte[l.Kennung]
		switch l.Art {
		case LueckeGeraet, LueckeEingang:
			var id string
			if gefuellt && json.Unmarshal(roh, &id) != nil {
				l.Fehler = "Erwartet die Kennung eines Geräts"
			}
			if !gefuellt || id == "" {
				id = vorschlag(l, vergeben)
			}
			k := findeKandidat(l.Kandidaten, id)
			switch {
			case k == nil && id != "":
				l.Fehler = "Passt nicht zu diesem Baustein"
				vollstaendig = false
			case k == nil:
				vollstaendig = false
			case l.Art == LueckeGeraet && vergeben[id]:
				l.Wert, l.WertText = k.EntityID, k.Name
				l.Fehler = "Dieses Gerät steht schon in einer anderen Lücke"
				vollstaendig = false
			default:
				l.Wert, l.WertText = k.EntityID, k.Name
				if l.Art == LueckeGeraet {
					vergeben[id] = true
				}
			}
		case LueckeStellwert:
			if gefuellt {
				var v any
				if err := json.Unmarshal(roh, &v); err != nil {
					l.Fehler = "Kein Wert"
					vollstaendig = false
					break
				}
				w, err := b.L.LiesStellwert(l.Kennung, v)
				if err != nil {
					l.Fehler = err.Error()
					vollstaendig = false
					break
				}
				l.Wert = b.L.StellwertRoh(l.Kennung, w)
			}
			l.WertText = wertText(b.L, l)
		}
		if l.Fehler != "" {
			vollstaendig = false
		}
	}
	text, err := b.fuelle(f.Name)
	if err != nil {
		return nil, err
	}
	out := &Eingesetzt{Name: b.Name, Beschreibung: b.Beschreibung, Satz: b.Satz, Luecken: b.Luecken, Text: string(text),
		Verhalten: []Probe{}}
	g, err := Pruefe(text, nil, registry)
	if err != nil {
		// Der Baustein war lesbar, die Füllung ändert nur Werte: das darf nicht geschehen.
		return nil, bausteinFehler("nach dem Einsetzen nicht lesbar: %s", err.Error())
	}
	out.Kanonisch, out.Bericht = string(g.Kanonisch), g.Bericht
	out.Verhalten = append(out.Verhalten, g.Bericht.Proben...)
	sort.SliceStable(out.Verhalten, func(i, j int) bool { return out.Verhalten[i].Uhr < out.Verhalten[j].Uhr })
	out.Vollstaendig = vollstaendig
	return out, nil
}

// kandidaten nennt je Gerät und Eingang, was die Anlage dafür anbietet: ein Gerät, an dem
// die Box jeden Ausgang ausführt, den die Logik ihm stellt (ein Sollwert in derselben
// Einheit), einen Eingang mit demselben Signal.
func (b *Baustein) kandidaten(bestand Bestand) {
	signale := map[string][]string{}
	for _, q := range bestand.Quellen {
		if q.EntityID != "" {
			signale[q.EntityID] = append(signale[q.EntityID], q.Signal)
		}
	}
	for i := range b.Luecken {
		l := &b.Luecken[i]
		switch l.Art {
		case LueckeGeraet:
			l.Kandidaten = []Kandidat{}
			// Wer genau kann, was die Logik braucht, steht vorn: für "ein Gerät mit Ein/Aus" die Pumpe
			// vor dem Heizstab, der dazu Stufen hat; danach, wessen Name zur Lücke passt ("Heizstab
			// Warmwasser" in die Lücke "Heizstab Warmwasser"). Der Vorschlag ist der erste.
			var passend []Schaltbar
			for _, g := range bestand.Geraete {
				if passtGeraet(l, g, signale[g.EntityID]) {
					passend = append(passend, g)
				}
			}
			sort.SliceStable(passend, func(i, j int) bool {
				if a, b := len(passend[i].Ausgaenge), len(passend[j].Ausgaenge); a != b {
					return a < b
				}
				return namensNaehe(l.Name, passend[i].Name) > namensNaehe(l.Name, passend[j].Name)
			})
			for _, g := range passend {
				l.Kandidaten = append(l.Kandidaten, Kandidat{EntityID: g.EntityID, Name: g.Name})
			}
		case LueckeEingang:
			l.Kandidaten = []Kandidat{}
			for _, q := range bestand.Quellen {
				if q.EntityID != "" && q.Signal == l.Signal {
					l.Kandidaten = append(l.Kandidaten, Kandidat{EntityID: q.EntityID, Name: q.Name})
				}
			}
			sort.SliceStable(l.Kandidaten, func(i, j int) bool {
				return namensNaehe(l.Name, l.Kandidaten[i].Name) > namensNaehe(l.Name, l.Kandidaten[j].Name)
			})
		}
	}
}

// passtGeraet: die Box führt an dem Gerät jeden Ausgang aus, den die Logik ihm stellt, ein
// Sollwert hat dieselbe Einheit, es kennt jede fest gewählte Betriebsart und liefert jedes
// Signal, das die Logik an ihm liest.
func passtGeraet(l *Luecke, g Schaltbar, signale []string) bool {
	for _, art := range l.Ausgaenge {
		if !slices.Contains(g.Ausgaenge, art) {
			return false
		}
	}
	if l.Sollwert != "" && (g.Sollwert == nil || g.Sollwert.Einheit != l.Sollwert) {
		return false
	}
	for _, w := range l.Betriebsarten {
		if !slices.Contains(g.Betriebsarten, w) {
			return false
		}
	}
	for _, s := range l.Signale {
		if !slices.Contains(signale, s) {
			return false
		}
	}
	return true
}

// namensNaehe zählt die Wörter (ab drei Buchstaben), die zwei Namen teilen, ohne Groß- und Kleinschreibung.
func namensNaehe(a, b string) int {
	woerter := func(s string) map[string]bool {
		out := map[string]bool{}
		for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if utf8.RuneCountInString(w) >= 3 {
				out[w] = true
			}
		}
		return out
	}
	n, wb := 0, woerter(b)
	for w := range woerter(a) {
		if wb[w] {
			n++
		}
	}
	return n
}

func vorschlag(l *Luecke, vergeben map[string]bool) string {
	for _, k := range l.Kandidaten {
		if l.Art != LueckeGeraet || !vergeben[k.EntityID] {
			return k.EntityID
		}
	}
	return ""
}

func findeKandidat(ks []Kandidat, id string) *Kandidat {
	for i := range ks {
		if ks[i].EntityID == id {
			return &ks[i]
		}
	}
	return nil
}

// wertText schreibt den Wert eines Stellwerts für Menschen ("60 °C", "06:00", "an", den
// Namen einer Auswahl).
func wertText(L *logik.Logik, l *Luecke) string {
	w, err := L.LiesStellwert(l.Kennung, l.Wert)
	if err != nil {
		return fmt.Sprint(l.Wert)
	}
	switch w.Art {
	case logik.WertBool:
		if w.B {
			return "an"
		}
		return "aus"
	case logik.WertWort:
		if l.Stellwert != nil {
			for _, o := range l.Stellwert.Optionen {
				if o.Wert == w.W && o.Name != "" {
					return o.Name
				}
			}
		}
		return w.W
	}
	return logik.Zeige(w)
}

// ersetzung ist eine Stelle im Text und ihr neuer Wert (schon in der Schreibweise des Textes).
type ersetzung struct {
	von, bis int
	neu      string
}

// fuelle schreibt die Füllungen in den Text der Logik: genau die Werte unter devices
// (entity, name), inputs (source), settings (default) und, wenn gegeben, name.
func (b *Baustein) fuelle(name string) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(b.logikText, &doc); err != nil || doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return nil, bausteinFehler("logic: kein Objekt")
	}
	wurzel := doc.Content[0]
	zeilen := zeilenAnfaenge(b.logikText)
	var ers []ersetzung
	setze := func(n *yaml.Node, wert any) error {
		if n == nil {
			return nil
		}
		e, err := spanne(b.logikText, zeilen, n)
		if err != nil {
			return err
		}
		e.neu = b.schreibweise(wert)
		ers = append(ers, e)
		return nil
	}
	if name != "" {
		if err := setze(feld(wurzel, "name"), name); err != nil {
			return nil, err
		}
	}
	neuesGeraet := map[string]string{}
	for _, l := range b.Luecken {
		switch l.Art {
		case LueckeGeraet:
			id, _ := l.Wert.(string)
			neuesGeraet[l.Kennung] = id
			eintrag := feld(feld(wurzel, "devices"), l.Kennung)
			if err := setze(feld(eintrag, "entity"), id); err != nil {
				return nil, err
			}
			if l.WertText != "" {
				if err := setze(feld(eintrag, "name"), l.WertText); err != nil {
					return nil, err
				}
			}
		case LueckeEingang:
			id, _ := l.Wert.(string)
			if err := setze(feld(feld(feld(wurzel, "inputs"), l.Kennung), "source"), id+"."+l.Signal); err != nil {
				return nil, err
			}
		case LueckeStellwert:
			if err := setze(feld(feld(feld(wurzel, "settings"), l.Kennung), "default"), l.Wert); err != nil {
				return nil, err
			}
		}
	}
	for k, g := range b.gebunden {
		_, signal := teileQuelle(b.L.Werte[k].Source)
		if err := setze(feld(feld(feld(wurzel, "inputs"), k), "source"), neuesGeraet[g]+"."+signal); err != nil {
			return nil, err
		}
	}
	sort.Slice(ers, func(i, j int) bool { return ers[i].von > ers[j].von })
	out := append([]byte(nil), b.logikText...)
	for i, e := range ers {
		if i > 0 && e.bis > ers[i-1].von {
			return nil, bausteinFehler("logic: zwei Lücken an derselben Stelle")
		}
		out = append(out[:e.von], append([]byte(e.neu), out[e.bis:]...)...)
	}
	return out, nil
}

// schreibweise schreibt einen Wert so, wie YAML und JSON ihn gleich lesen: Text in
// Anführungszeichen, Zahlen und on/off wie sie sind (in JSON on/off als Text).
func (b *Baustein) schreibweise(wert any) string {
	switch v := wert.(type) {
	case bool:
		w := "off"
		if v {
			w = "on"
		}
		if b.json {
			return `"` + w + `"`
		}
		return w
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case string:
		if !b.json && (v == "on" || v == "off") {
			return v
		}
		return jsonText(v)
	}
	roh, _ := json.Marshal(wert)
	return string(roh)
}

func jsonText(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(buf.String(), "\n")
}

// feld ist der Wert unter einem Schlüssel eines Objekts; nil ohne ihn.
func feld(n *yaml.Node, k string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == k {
			return n.Content[i+1]
		}
	}
	return nil
}

func zeilenAnfaenge(text []byte) []int {
	out := []int{0}
	for i, c := range text {
		if c == '\n' {
			out = append(out, i+1)
		}
	}
	return out
}

// spanne findet einen Wert im Text: Zeile und Spalte (in Zeichen) nennt yaml.v3, das Ende
// ergibt sich aus der Schreibweise. Nur einzeilige Werte lassen sich ersetzen.
func spanne(text []byte, zeilen []int, n *yaml.Node) (ersetzung, error) {
	if n.Kind != yaml.ScalarNode || n.Line < 1 || n.Line > len(zeilen) {
		return ersetzung{}, bausteinFehler("logic: Zeile %d: an dieser Stelle steht kein einzelner Wert", n.Line)
	}
	von := zeilen[n.Line-1]
	for c := 1; c < n.Column; c++ {
		_, w := utf8.DecodeRune(text[von:])
		von += w
	}
	ende := len(text)
	if n.Line < len(zeilen) {
		ende = zeilen[n.Line] - 1
	}
	zeile := text[von:ende]
	bis := -1
	switch n.Style {
	case 0:
		if bytes.HasPrefix(zeile, []byte(n.Value)) {
			bis = von + len(n.Value)
		}
	case yaml.DoubleQuotedStyle:
		for i := 1; i < len(zeile); i++ {
			if zeile[i] == '\\' {
				i++
				continue
			}
			if zeile[i] == '"' {
				bis = von + i + 1
				break
			}
		}
	case yaml.SingleQuotedStyle:
		for i := 1; i < len(zeile); i++ {
			if zeile[i] == '\'' {
				if i+1 < len(zeile) && zeile[i+1] == '\'' {
					i++
					continue
				}
				bis = von + i + 1
				break
			}
		}
	}
	if bis < 0 {
		return ersetzung{}, bausteinFehler("logic: Zeile %d: eine Lücke steht in einer Zeile", n.Line)
	}
	return ersetzung{von: von, bis: bis}, nil
}

// AusLogik macht aus einer Logik einen Baustein (Stufe 5, E4 = A: der Fachbetrieb speichert
// eine Logik für seine Kunden, VoltPilot für alle). Geräte und Fühler der Anlage werden
// Lücken: ihre Kennungen verlassen die Anlage nicht, im Baustein stehen Platzhalter
// ("geraet-<name>", "quelle-<name>"). Der Satz nennt die Lücken mit {name}.
func AusLogik(text []byte, name, beschreibung, satz string) ([]byte, *Baustein, error) {
	L, err := liesLogik(text)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %s", ErrUnlesbar, err.Error())
	}
	vorlage := &Baustein{logikText: text, json: istJSON(text), L: L, gebunden: map[string]string{}}
	if err := vorlage.luecken(""); err != nil {
		return nil, nil, err
	}
	for i := range vorlage.Luecken {
		l := &vorlage.Luecken[i]
		switch l.Art {
		case LueckeGeraet:
			l.Wert, l.WertText = "geraet-"+l.Kennung, ""
		case LueckeEingang:
			l.Wert = "quelle-" + l.Kennung
		}
	}
	neutral, err := vorlage.fuelle(name)
	if err != nil {
		return nil, nil, err
	}
	var doc strings.Builder
	doc.WriteString("block: 1\n")
	doc.WriteString("name: " + jsonText(strings.TrimSpace(name)) + "\n")
	if strings.TrimSpace(beschreibung) != "" {
		doc.WriteString("description: " + jsonText(strings.TrimSpace(beschreibung)) + "\n")
	}
	doc.WriteString("sentence: " + jsonText(strings.TrimSpace(satz)) + "\n")
	doc.WriteString("logic: |2\n")
	for _, z := range strings.Split(strings.TrimRight(string(neutral), "\n"), "\n") {
		if strings.TrimSpace(z) == "" {
			doc.WriteString("\n")
			continue
		}
		doc.WriteString("  " + z + "\n")
	}
	out := []byte(doc.String())
	b, err := LiesBaustein(out)
	if err != nil {
		return nil, nil, err
	}
	return out, b, nil
}

// LiesBausteine liest mehrere Bausteine für eine Anlage: Satz, Lücken und was die Anlage
// dafür anbietet; Passt sagt, ob jedes Gerät und jeder Fühler ein Gegenüber hat.
func LiesBausteine(texte []BausteinText, registry json.RawMessage) []BausteinKopf {
	bestand := Quellen(registry)
	out := make([]BausteinKopf, 0, len(texte))
	for _, t := range texte {
		k := BausteinKopf{ID: t.ID, Satz: []SatzTeil{}, Luecken: []Luecke{}}
		b, err := LiesBaustein([]byte(t.Text))
		if err != nil {
			k.Message = err.Error()
			out = append(out, k)
			continue
		}
		b.kandidaten(bestand)
		k.Lesbar, k.Name, k.Beschreibung, k.Satz, k.Luecken = true, b.Name, b.Beschreibung, b.Satz, b.Luecken
		k.Passt = true
		vergeben := map[string]bool{}
		for i := range k.Luecken {
			l := &k.Luecken[i]
			if l.Art == LueckeStellwert {
				l.WertText = wertText(b.L, l)
				continue
			}
			id := vorschlag(l, vergeben)
			if kd := findeKandidat(l.Kandidaten, id); kd != nil {
				l.Wert, l.WertText = kd.EntityID, kd.Name
				if l.Art == LueckeGeraet {
					vergeben[id] = true
				}
			} else {
				k.Passt = false
			}
		}
		out = append(out, k)
	}
	return out
}

// BausteinText ist ein Baustein, wie die API ihn schickt.
type BausteinText struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// BausteinKopf ist ein Baustein in der Liste: Satz, Lücken mit Vorschlag, passt er zur Anlage.
type BausteinKopf struct {
	ID           string     `json:"id"`
	Lesbar       bool       `json:"lesbar"`
	Message      string     `json:"message,omitempty"`
	Name         string     `json:"name,omitempty"`
	Beschreibung string     `json:"beschreibung,omitempty"`
	Satz         []SatzTeil `json:"satz"`
	Luecken      []Luecke   `json:"luecken"`
	Passt        bool       `json:"passt"`
}
