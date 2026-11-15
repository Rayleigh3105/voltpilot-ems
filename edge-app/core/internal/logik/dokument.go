package logik

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Die kanonische Form einer Logik ist JSON. Die Reihenfolge der Einträge unter "states"
// ist die Reihenfolge der Auswertung und bleibt deshalb beim Lesen erhalten; dasselbe gilt
// für "given" einer Probe. Der Leser ist streng: unbekannte Schlüssel sind ein Fehler,
// wie es das Schema (additionalProperties: false) sagt.

// jZahl ist eine gelesene JSON-Zahl mit ihrem Rohtext (für Erwartungstexte der Proben).
type jZahl struct {
	roh string
	v   float64
}

// jObjekt ist ein JSON-Objekt mit erhaltener Reihenfolge.
type jObjekt struct {
	keys []string
	vals []any
}

func (o *jObjekt) hat(k string) bool {
	for _, key := range o.keys {
		if key == k {
			return true
		}
	}
	return false
}

func (o *jObjekt) wert(k string) any {
	for i, key := range o.keys {
		if key == k {
			return o.vals[i]
		}
	}
	return nil
}

// liesJSON liest ein JSON-Dokument in einen geordneten Baum.
func liesJSON(daten []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(daten))
	dec.UseNumber()
	w, err := liesJSONWert(dec)
	if err != nil {
		return nil, fehler("JSON: %v", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fehler("JSON: Rest nach dem Dokument")
	}
	return w, nil
}

func liesJSONWert(dec *json.Decoder) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return liesJSONAb(dec, t)
}

func liesJSONAb(dec *json.Decoder, t json.Token) (any, error) {
	switch v := t.(type) {
	case json.Delim:
		switch v {
		case '{':
			o := &jObjekt{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k := kt.(string)
				if o.hat(k) {
					return nil, fmt.Errorf("Schlüssel „%s“ steht doppelt", k)
				}
				w, err := liesJSONWert(dec)
				if err != nil {
					return nil, err
				}
				o.keys = append(o.keys, k)
				o.vals = append(o.vals, w)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			var a []any
			for dec.More() {
				w, err := liesJSONWert(dec)
				if err != nil {
					return nil, err
				}
				a = append(a, w)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return a, nil
		}
		return nil, fmt.Errorf("unerwartetes Zeichen %v", v)
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return nil, err
		}
		return jZahl{roh: v.String(), v: f}, nil
	case string:
		return v, nil
	case bool:
		return v, nil
	case nil:
		return nil, nil
	}
	return nil, fmt.Errorf("unerwarteter Wert %v", t)
}

// anyText gibt einen festen Wert so wieder, wie die Probe ihn erwartet (JS String(x)).
func anyText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case jZahl:
		return x.roh
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	return fmt.Sprintf("%v", v)
}

// ------------------------------------------------------------------ Das gelesene Dokument

// Die Betriebsarten, die Geräteklassen kennen (geschlossene Liste, Vertrag 17.2).
var Betriebsarten = []string{"normal", "boost", "cool", "heat", "fan_only", "dry", "auto", "start"}

// Wörter der Sprache, die kein Name eines Verfassers sein dürfen (Auswahl-Werte).
var Reserviert = []string{"on", "off", "true", "false", "and", "or", "not", "clock", "unknown", "else"}

var kennungRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
var dannRe = regexp.MustCompile(`^start\(([^)]+)\)(?:\s+if\s+(.+))?$`)

// Geraet ist ein Anspruch der Logik auf ein Gerät der Anlage.
type Geraet struct {
	Kennung string
	Entity  string
	Name    string
}

// Eingang ist ein gelesener Wert; ohne frischen Wert gilt er als unbekannt.
type Eingang struct {
	Kennung     string
	Source      string
	Name        string
	MaxAge      float64 // Sekunden; < 0 heißt ohne Grenze
	HatMaxAge   bool
	Groesse     Groesse // aus der Quelle abgeleitet
	GroesseBool bool    // die Quelle liefert Ja/Nein
}

// Stellwert ist ein Wert, den Menschen stellen, ohne den Text zu ändern.
type Stellwert struct {
	Kennung     string
	Name        string
	Art         string // "zahl", "boolean", "select", "schedule"
	Vorgabe     Wert
	VorgabePlan *Zeitplan
	Bereich     *[2]Wert
	Schritt     *Wert
	Darf        string // "customer", "customer_admin", "installer"
	HatDarf     bool
	Hilfe       any // nil, string oder [2]string{whenOn, whenOff}
	Optionen    *jObjekt
	// vorgabeText ist die Vorgabe, wie der Text sie schreibt ("30 min"): ihre Einheit ist die
	// Einheit, in der Oberfläche und Bündel den Wert zeigen und schreiben (StellwertInfos).
	vorgabeText string
}

// Zielwert nach E2 = B: jeder Stellwert in °C. Ihn darf der Kunde immer ändern, in seinem Bereich.
func (s *Stellwert) Zielwert() bool {
	return s.Art == "zahl" && s.Vorgabe.Art == WertZahl && s.Vorgabe.D == GroesseTemp
}

// Bedingung ist ein Ausdruck, bei Listen mit dem Namen für Kunde und Verlauf.
type Bedingung struct {
	Name string
	Baum *baum
}

type neustartArt byte

const (
	neustartAus neustartArt = iota
	neustartAn
	neustartBleibt
	neustartZahl
)

// Zustand ist, was sich die Logik merkt: Schalter, Zeitgeber oder Zähler.
type Zustand struct {
	Kennung string
	Name    string
	HatName bool   // Name kommt aus dem Text (sonst ist er die Kennung)
	Art     string // "boolean", "timer", "counter"

	// Schalter
	An, AnEines, Aus, AusEines []Bedingung
	// AnText und AusText sind die Sätze für den Kunden im Blatt „Warum?“ (on_text, off_text).
	AnText, AusText string

	// Zeitgeber
	Dauer *baum

	// Zähler
	Von, Bis     int
	Schritte     []*Schritt
	NeustartWert int

	Neustart neustartArt
}

// Schritt ist ein Schritt eines Zählers; je Takt gilt der erste zutreffende.
type Schritt struct {
	Name            string
	Text            string // Satz für den Kunden im Blatt „Warum?“; Name ist eine Kennung
	Um              int
	HatUm           bool
	Setze           *baum
	Fruehestens     float64
	FruehestensBaum *baum
	Alle, Eines     []Bedingung
	DannStarte      string
	DannWenn        *baum
}

// Meldung geht einmal hinaus, wenn die Bedingung eintritt, und frühestens nach "wieder" erneut.
type Meldung struct {
	Wenn   *baum
	An     []string
	Satz   string
	Wieder float64
}

// LageZeile ist eine Zeile dessen, was der Kunde liest; die erste zutreffende gilt.
type LageZeile struct {
	Sonst bool
	Wenn  *baum
	Titel string
	Art   string
	Satz  string
}

// Anzeige ist, was die Karte zusätzlich zeichnet.
type Anzeige struct {
	Wert   string
	Skala  *[2]Wert
	Marken []AnzeigeMarke
}

type AnzeigeMarke struct {
	Name string
	Bei  *baum
}

// Probe ist ein durchgespielter Fall mit erwartetem Ergebnis.
type Probe struct {
	Name    string
	Gegeben *jObjekt
	Nach    any
	Erwarte *jObjekt
}

// Logik ist ein gelesenes, vorbereitetes Dokument.
type Logik struct {
	Name         string
	Beschreibung string
	Geraete      map[string]*Geraet
	GeraetListe  []string
	Werte        map[string]*Eingang
	WertListe    []string
	Stellwerte   map[string]*Stellwert
	StellListe   []string
	Merker       map[string]*baum
	MerkerListe  []string
	Zustaende    []*Zustand
	zustand      map[string]*Zustand
	Ausgaenge    map[string]map[string]*baum
	AusgangListe []string
	Anzeige      *Anzeige
	Meldungen    []*Meldung
	Lage         []*LageZeile
	Zusammen     []Bedingung
	Proben       []*Probe
	woerter      map[string]bool
	eigene       map[string]bool
}

// Grenzen des Dokuments, wie das Schema sie zieht.
const (
	maxGeraete       = 16
	maxWerte         = 32
	maxStellwerte    = 64
	maxMerker        = 64
	maxZustaende     = 32
	maxLage          = 32
	maxMeldungen     = 16
	maxZusammen      = 16
	maxProben        = 64
	maxBedingungen   = 12
	maxSchritte      = 12
	maxDokumentBytes = 128 * 1024
)

func pruefeKennung(wo, k string) error {
	if !kennungRe.MatchString(k) {
		return fehler("%s: „%s“ ist keine Kennung (klein, a-z, 0-9, _, höchstens 32 Zeichen)", wo, k)
	}
	return nil
}

func objekt(wo string, v any, pflicht bool) (*jObjekt, error) {
	if v == nil {
		if pflicht {
			return nil, fehler("%s fehlt", wo)
		}
		return nil, nil
	}
	o, ok := v.(*jObjekt)
	if !ok {
		return nil, fehler("%s: erwartet ein Objekt", wo)
	}
	return o, nil
}

func textWert(wo string, v any, pflicht bool) (string, error) {
	if v == nil {
		if pflicht {
			return "", fehler("%s fehlt", wo)
		}
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", fehler("%s: erwartet einen Text", wo)
	}
	return s, nil
}

func nurSchluessel(wo string, o *jObjekt, erlaubt ...string) error {
	for _, k := range o.keys {
		gefunden := false
		for _, e := range erlaubt {
			if k == e {
				gefunden = true
				break
			}
		}
		if !gefunden {
			return fehler("%s: unbekannter Schlüssel „%s“", wo, k)
		}
	}
	return nil
}

// ausdruck liest ein Ausdrucksfeld: Text, Zahl oder Ja/Nein (on/off in der gespeicherten Form).
func ausdruck(wo string, v any) (*baum, error) {
	var text string
	switch x := v.(type) {
	case string:
		text = x
	case jZahl:
		text = x.roh
	case bool:
		if x {
			text = "on"
		} else {
			text = "off"
		}
	default:
		return nil, fehler("%s: erwartet eine Formel", wo)
	}
	b, err := lies(text)
	if err != nil {
		return nil, fehler("%s: %s", wo, err.Error())
	}
	return b, nil
}

// bedingungen liest eine Formel oder eine Liste aus Formeln und benannten Bedingungen.
func bedingungen(wo string, v any) ([]Bedingung, error) {
	if v == nil {
		return nil, nil
	}
	if liste, ok := v.([]any); ok {
		if len(liste) == 0 || len(liste) > maxBedingungen {
			return nil, fehler("%s: eine Liste hat 1 bis %d Bedingungen", wo, maxBedingungen)
		}
		var aus []Bedingung
		for _, e := range liste {
			if o, ok := e.(*jObjekt); ok {
				if len(o.keys) != 1 {
					return nil, fehler("%s: eine benannte Bedingung hat genau einen Namen", wo)
				}
				b, err := ausdruck(wo, o.vals[0])
				if err != nil {
					return nil, err
				}
				aus = append(aus, Bedingung{Name: o.keys[0], Baum: b})
				continue
			}
			b, err := ausdruck(wo, e)
			if err != nil {
				return nil, err
			}
			aus = append(aus, Bedingung{Baum: b})
		}
		return aus, nil
	}
	if v == true {
		return []Bedingung{{Baum: &baum{t: kBool, b: true, src: "true"}}}, nil
	}
	b, err := ausdruck(wo, v)
	if err != nil {
		return nil, err
	}
	return []Bedingung{{Baum: b}}, nil
}

func dauerWert(wo string, v any) (float64, error) {
	w, err := LiesWert(v)
	if err != nil {
		return 0, fehler("%s: %s", wo, err.Error())
	}
	if w.Art != WertZahl || (w.D != GroesseDauer && w.D != GroesseZahl) {
		return 0, fehler("%s: erwartet eine Dauer", wo)
	}
	return w.V, nil
}

// Lesen liest die kanonische JSON-Form einer Logik und bereitet sie zur Auswertung vor.
func Lesen(daten []byte) (*Logik, error) {
	if len(daten) > maxDokumentBytes {
		return nil, fehler("Das Dokument ist größer als %d KB", maxDokumentBytes/1024)
	}
	wurzel, err := liesJSON(daten)
	if err != nil {
		return nil, err
	}
	doc, ok := wurzel.(*jObjekt)
	if !ok {
		return nil, fehler("Eine Logik ist ein JSON-Objekt")
	}
	if err := nurSchluessel("logic", doc, "logic", "name", "description", "devices", "inputs", "settings",
		"constraints", "formulas", "states", "outputs", "display", "notifications", "status", "tests"); err != nil {
		return nil, err
	}
	if z, ok := doc.wert("logic").(jZahl); !ok || z.v != 1 {
		return nil, fehler("logic: dieser Kern liest die Sprachversion 1")
	}

	L := &Logik{
		Geraete: map[string]*Geraet{}, Werte: map[string]*Eingang{}, Stellwerte: map[string]*Stellwert{},
		Merker: map[string]*baum{}, zustand: map[string]*Zustand{}, Ausgaenge: map[string]map[string]*baum{},
		woerter: map[string]bool{}, eigene: map[string]bool{},
	}
	for _, w := range Betriebsarten {
		L.woerter[w] = true
	}
	if L.Name, err = textWert("name", doc.wert("name"), true); err != nil {
		return nil, err
	}
	if L.Name == "" || len([]rune(L.Name)) > 60 {
		return nil, fehler("name: 1 bis 60 Zeichen")
	}
	if L.Beschreibung, err = textWert("description", doc.wert("description"), false); err != nil {
		return nil, err
	}

	// Geräte
	ger, err := objekt("devices", doc.wert("devices"), true)
	if err != nil {
		return nil, err
	}
	if len(ger.keys) < 1 || len(ger.keys) > maxGeraete {
		return nil, fehler("devices: 1 bis %d Geräte", maxGeraete)
	}
	for i, k := range ger.keys {
		if err := pruefeKennung("devices", k); err != nil {
			return nil, err
		}
		o, err := objekt("devices."+k, ger.vals[i], true)
		if err != nil {
			return nil, err
		}
		if err := nurSchluessel("devices."+k, o, "entity", "name"); err != nil {
			return nil, err
		}
		g := &Geraet{Kennung: k}
		if g.Entity, err = textWert("devices."+k+".entity", o.wert("entity"), true); err != nil {
			return nil, err
		}
		if g.Name, err = textWert("devices."+k+".name", o.wert("name"), true); err != nil {
			return nil, err
		}
		L.Geraete[k] = g
		L.GeraetListe = append(L.GeraetListe, k)
	}

	// Werte
	if werte, err := objekt("inputs", doc.wert("inputs"), false); err != nil {
		return nil, err
	} else if werte != nil {
		if len(werte.keys) > maxWerte {
			return nil, fehler("inputs: höchstens %d Werte", maxWerte)
		}
		for i, k := range werte.keys {
			if err := pruefeKennung("inputs", k); err != nil {
				return nil, err
			}
			o, err := objekt("inputs."+k, werte.vals[i], true)
			if err != nil {
				return nil, err
			}
			if err := nurSchluessel("inputs."+k, o, "source", "name", "max_age"); err != nil {
				return nil, err
			}
			e := &Eingang{Kennung: k, MaxAge: -1}
			if e.Source, err = textWert("inputs."+k+".source", o.wert("source"), true); err != nil {
				return nil, err
			}
			if e.Name, err = textWert("inputs."+k+".name", o.wert("name"), true); err != nil {
				return nil, err
			}
			if o.hat("max_age") {
				if e.MaxAge, err = dauerWert("inputs."+k+".max_age", o.wert("max_age")); err != nil {
					return nil, err
				}
				e.HatMaxAge = true
			}
			e.Groesse, e.GroesseBool = groesseDerQuelle(e.Source)
			L.Werte[k] = e
			L.WertListe = append(L.WertListe, k)
		}
	}

	// Stellwerte
	if stell, err := objekt("settings", doc.wert("settings"), false); err != nil {
		return nil, err
	} else if stell != nil {
		if len(stell.keys) > maxStellwerte {
			return nil, fehler("settings: höchstens %d Stellwerte", maxStellwerte)
		}
		for i, k := range stell.keys {
			if err := pruefeKennung("settings", k); err != nil {
				return nil, err
			}
			o, err := objekt("settings."+k, stell.vals[i], true)
			if err != nil {
				return nil, err
			}
			s, err := liesStellwert(L, k, o)
			if err != nil {
				return nil, err
			}
			L.Stellwerte[k] = s
			L.StellListe = append(L.StellListe, k)
		}
	}

	// Bedingungen zwischen Stellwerten
	if v := doc.wert("constraints"); v != nil {
		liste, ok := v.([]any)
		if !ok || len(liste) > maxZusammen {
			return nil, fehler("constraints: eine Liste mit höchstens %d Bedingungen", maxZusammen)
		}
		for _, e := range liste {
			o, ok := e.(*jObjekt)
			if !ok || len(o.keys) != 1 {
				return nil, fehler("constraints: eine Bedingung mit ihrem Namen: {Name: Formel}")
			}
			b, err := ausdruck("constraints", o.vals[0])
			if err != nil {
				return nil, err
			}
			L.Zusammen = append(L.Zusammen, Bedingung{Name: o.keys[0], Baum: b})
		}
	}

	// Merker (Formeln)
	if merker, err := objekt("formulas", doc.wert("formulas"), false); err != nil {
		return nil, err
	} else if merker != nil {
		if len(merker.keys) > maxMerker {
			return nil, fehler("formulas: höchstens %d Formeln", maxMerker)
		}
		for i, k := range merker.keys {
			if err := pruefeKennung("formulas", k); err != nil {
				return nil, err
			}
			b, err := ausdruck("formulas."+k, merker.vals[i])
			if err != nil {
				return nil, err
			}
			L.Merker[k] = b
			L.MerkerListe = append(L.MerkerListe, k)
		}
	}

	// Zustände, in der Reihenfolge des Textes
	if zust, err := objekt("states", doc.wert("states"), false); err != nil {
		return nil, err
	} else if zust != nil {
		if len(zust.keys) > maxZustaende {
			return nil, fehler("states: höchstens %d Zustände", maxZustaende)
		}
		for i, k := range zust.keys {
			if err := pruefeKennung("states", k); err != nil {
				return nil, err
			}
			o, err := objekt("states."+k, zust.vals[i], true)
			if err != nil {
				return nil, err
			}
			z, err := liesZustand(L, k, o)
			if err != nil {
				return nil, err
			}
			L.Zustaende = append(L.Zustaende, z)
			L.zustand[k] = z
		}
	}

	// Ausgänge
	ausg, err := objekt("outputs", doc.wert("outputs"), true)
	if err != nil {
		return nil, err
	}
	if len(ausg.keys) < 1 {
		return nil, fehler("outputs: mindestens ein Gerät")
	}
	for i, k := range ausg.keys {
		o, err := objekt("outputs."+k, ausg.vals[i], true)
		if err != nil {
			return nil, err
		}
		if err := nurSchluessel("outputs."+k, o, "level", "on_off", "setpoint", "mode", "percent"); err != nil {
			return nil, err
		}
		if len(o.keys) == 0 {
			return nil, fehler("outputs.%s: mindestens eine Angabe", k)
		}
		arten := map[string]*baum{}
		for j, art := range o.keys {
			b, err := ausdruck("outputs."+k+"."+art, o.vals[j])
			if err != nil {
				return nil, err
			}
			arten[art] = b
		}
		L.Ausgaenge[k] = arten
		L.AusgangListe = append(L.AusgangListe, k)
	}

	// Anzeige
	if anz, err := objekt("display", doc.wert("display"), false); err != nil {
		return nil, err
	} else if anz != nil {
		if err := nurSchluessel("display", anz, "input", "scale", "marks"); err != nil {
			return nil, err
		}
		a := &Anzeige{}
		if a.Wert, err = textWert("display.input", anz.wert("input"), true); err != nil {
			return nil, err
		}
		if v := anz.wert("scale"); v != nil {
			liste, ok := v.([]any)
			if !ok || len(liste) != 2 {
				return nil, fehler("display.scale: zwei Werte")
			}
			var skala [2]Wert
			for i := range liste {
				if skala[i], err = LiesWert(liste[i]); err != nil {
					return nil, fehler("display.scale: %s", err.Error())
				}
			}
			a.Skala = &skala
		}
		if v := anz.wert("marks"); v != nil {
			liste, ok := v.([]any)
			if !ok || len(liste) > 4 {
				return nil, fehler("display.marks: höchstens vier Marken")
			}
			for _, e := range liste {
				o, ok := e.(*jObjekt)
				if !ok {
					return nil, fehler("display.marks: erwartet {name, at}")
				}
				if err := nurSchluessel("display.marks", o, "name", "at"); err != nil {
					return nil, err
				}
				name, err := textWert("display.marks.name", o.wert("name"), true)
				if err != nil {
					return nil, err
				}
				b, err := ausdruck("display.marks."+name, o.wert("at"))
				if err != nil {
					return nil, err
				}
				a.Marken = append(a.Marken, AnzeigeMarke{Name: name, Bei: b})
			}
		}
		L.Anzeige = a
	}

	// Meldungen
	if v := doc.wert("notifications"); v != nil {
		liste, ok := v.([]any)
		if !ok || len(liste) > maxMeldungen {
			return nil, fehler("notifications: eine Liste mit höchstens %d Meldungen", maxMeldungen)
		}
		for i, e := range liste {
			wo := fmt.Sprintf("notifications[%d]", i+1)
			o, ok := e.(*jObjekt)
			if !ok {
				return nil, fehler("%s: erwartet ein Objekt", wo)
			}
			if err := nurSchluessel(wo, o, "when", "to", "text", "repeat_after"); err != nil {
				return nil, err
			}
			m := &Meldung{Wieder: 3600}
			if m.Wenn, err = ausdruck(wo+".when", o.wert("when")); err != nil {
				return nil, err
			}
			an, ok := o.wert("to").([]any)
			if !ok || len(an) == 0 {
				return nil, fehler("%s.to: eine Liste aus customer und installer", wo)
			}
			for _, a := range an {
				s, _ := a.(string)
				if s != "customer" && s != "installer" {
					return nil, fehler("%s.to: eine Liste aus customer und installer", wo)
				}
				m.An = append(m.An, s)
			}
			if m.Satz, err = textWert(wo+".text", o.wert("text"), true); err != nil {
				return nil, err
			}
			if o.hat("repeat_after") {
				if m.Wieder, err = dauerWert(wo+".repeat_after", o.wert("repeat_after")); err != nil {
					return nil, err
				}
			}
			L.Meldungen = append(L.Meldungen, m)
		}
	}

	// Lage
	lage, ok := doc.wert("status").([]any)
	if !ok || len(lage) == 0 || len(lage) > maxLage {
		return nil, fehler("status: eine Liste mit 1 bis %d Zeilen", maxLage)
	}
	for i, e := range lage {
		wo := fmt.Sprintf("status[%d]", i+1)
		o, ok := e.(*jObjekt)
		if !ok {
			return nil, fehler("%s: erwartet ein Objekt", wo)
		}
		if err := nurSchluessel(wo, o, "when", "else", "title", "type", "text"); err != nil {
			return nil, err
		}
		z := &LageZeile{}
		if o.hat("else") {
			if o.wert("else") != true || o.hat("when") {
				return nil, fehler("%s: entweder when oder else: true", wo)
			}
			z.Sonst = true
		} else {
			if z.Wenn, err = ausdruck(wo+".when", o.wert("when")); err != nil {
				return nil, err
			}
		}
		if z.Titel, err = textWert(wo+".title", o.wert("title"), true); err != nil {
			return nil, err
		}
		if z.Art, err = textWert(wo+".type", o.wert("type"), true); err != nil {
			return nil, err
		}
		switch z.Art {
		case "solar", "grid", "waiting", "idle", "fault":
		default:
			return nil, fehler("%s.type: solar, grid, waiting, idle oder fault", wo)
		}
		satz, ok := o.wert("text").(string)
		if !ok {
			return nil, fehler("%s.text fehlt", wo)
		}
		z.Satz = satz
		L.Lage = append(L.Lage, z)
	}

	// Proben
	if v := doc.wert("tests"); v != nil {
		liste, ok := v.([]any)
		if !ok || len(liste) > maxProben {
			return nil, fehler("tests: eine Liste mit höchstens %d Proben", maxProben)
		}
		for i, e := range liste {
			wo := fmt.Sprintf("tests[%d]", i+1)
			o, ok := e.(*jObjekt)
			if !ok {
				return nil, fehler("%s: erwartet ein Objekt", wo)
			}
			if err := nurSchluessel(wo, o, "name", "given", "after", "expect"); err != nil {
				return nil, err
			}
			p := &Probe{Nach: o.wert("after")}
			if p.Name, err = textWert(wo+".name", o.wert("name"), true); err != nil {
				return nil, err
			}
			if p.Gegeben, err = objekt(wo+".given", o.wert("given"), true); err != nil {
				return nil, err
			}
			if p.Erwarte, err = objekt(wo+".expect", o.wert("expect"), true); err != nil {
				return nil, err
			}
			if len(p.Erwarte.keys) == 0 {
				return nil, fehler("%s.expect: mindestens eine Erwartung", wo)
			}
			L.Proben = append(L.Proben, p)
		}
	}

	return L, nil
}

func liesStellwert(L *Logik, k string, o *jObjekt) (*Stellwert, error) {
	wo := "settings." + k
	if err := nurSchluessel(wo, o, "name", "type", "default", "range", "step", "options", "editable_by", "help"); err != nil {
		return nil, err
	}
	s := &Stellwert{Kennung: k, Darf: "installer"}
	var err error
	if s.Name, err = textWert(wo+".name", o.wert("name"), true); err != nil {
		return nil, err
	}
	art, err := textWert(wo+".type", o.wert("type"), false)
	if err != nil {
		return nil, err
	}
	switch art {
	case "":
		s.Art = "zahl"
	case "boolean", "select", "schedule":
		s.Art = art
	default:
		return nil, fehler("%s.type: boolean, select oder schedule; ohne Angabe Zahl mit Einheit oder Uhrzeit", wo)
	}
	if !o.hat("default") {
		return nil, fehler("%s.default fehlt", wo)
	}
	switch s.Art {
	case "select":
		opt, err := objekt(wo+".options", o.wert("options"), true)
		if err != nil {
			return nil, err
		}
		if len(opt.keys) < 2 || len(opt.keys) > 8 {
			return nil, fehler("%s.options: 2 bis 8 Werte", wo)
		}
		vorgabe, ok := o.wert("default").(string)
		if !ok || !opt.hat(vorgabe) {
			return nil, fehler("Auswahl „%s“: die Vorgabe steht nicht unter options", k)
		}
		for i, w := range opt.keys {
			if err := pruefeKennung(wo+".options", w); err != nil {
				return nil, err
			}
			for _, r := range Reserviert {
				if w == r {
					return nil, fehler("Auswahl „%s“: „%s“ ist ein Wort der Sprache", k, w)
				}
			}
			if _, ok := opt.vals[i].(string); !ok {
				return nil, fehler("%s.options.%s: erwartet den Namen für den Kunden", wo, w)
			}
			L.woerter[w] = true
			L.eigene[w] = true
		}
		s.Optionen = opt
		s.Vorgabe = wortW(vorgabe)
	case "schedule":
		if s.VorgabePlan, err = liesPlan(o.wert("default")); err != nil {
			return nil, fehler("%s.default: %s", wo, err.Error())
		}
		s.Vorgabe = Wert{Art: WertPlan, Plan: s.VorgabePlan}
	default:
		if s.Vorgabe, err = LiesWert(o.wert("default")); err != nil {
			return nil, fehler("%s.default: %s", wo, err.Error())
		}
		s.vorgabeText, _ = o.wert("default").(string)
		if s.Art == "boolean" && s.Vorgabe.Art != WertBool {
			return nil, fehler("%s.default: on oder off", wo)
		}
	}
	if s.Art != "zahl" && (o.hat("range") || o.hat("step")) {
		return nil, fehler("%s: range und step gibt es nur bei Zahlen", wo)
	}
	if v := o.wert("range"); v != nil {
		liste, ok := v.([]any)
		if !ok || len(liste) != 2 {
			return nil, fehler("%s.range: zwei Werte", wo)
		}
		var bereich [2]Wert
		for i := range liste {
			if bereich[i], err = LiesWert(liste[i]); err != nil {
				return nil, fehler("%s.range: %s", wo, err.Error())
			}
		}
		s.Bereich = &bereich
	}
	if o.hat("step") {
		w, err := LiesWert(o.wert("step"))
		if err != nil {
			return nil, fehler("%s.step: %s", wo, err.Error())
		}
		s.Schritt = &w
	}
	if o.hat("editable_by") {
		darf, _ := o.wert("editable_by").(string)
		switch darf {
		case "customer", "customer_admin", "installer":
			s.Darf = darf
			s.HatDarf = true
		default:
			return nil, fehler("%s.editable_by: customer, customer_admin oder installer", wo)
		}
	}
	if o.hat("help") {
		switch h := o.wert("help").(type) {
		case string:
			s.Hilfe = h
		case *jObjekt:
			if err := nurSchluessel(wo+".help", h, "when_on", "when_off"); err != nil {
				return nil, err
			}
			an, err := textWert(wo+".help.when_on", h.wert("when_on"), true)
			if err != nil {
				return nil, err
			}
			aus, err := textWert(wo+".help.when_off", h.wert("when_off"), true)
			if err != nil {
				return nil, err
			}
			s.Hilfe = [2]string{an, aus}
		default:
			return nil, fehler("%s.help: ein Satz oder {when_on, when_off}", wo)
		}
	}
	return s, nil
}

func liesZustand(L *Logik, k string, o *jObjekt) (*Zustand, error) {
	wo := "states." + k
	art, err := textWert(wo+".type", o.wert("type"), true)
	if err != nil {
		return nil, err
	}
	z := &Zustand{Kennung: k, Name: k, Art: art}
	if n, err := textWert(wo+".name", o.wert("name"), false); err != nil {
		return nil, err
	} else if n != "" {
		z.Name, z.HatName = n, true
	}
	neu := o.wert("after_restart")
	switch art {
	case "boolean":
		if err := nurSchluessel(wo, o, "type", "name", "on_when", "on_when_any", "off_when", "off_when_any", "after_restart",
			"on_text", "off_text"); err != nil {
			return nil, err
		}
		if z.AnText, err = textWert(wo+".on_text", o.wert("on_text"), false); err != nil {
			return nil, err
		}
		if z.AusText, err = textWert(wo+".off_text", o.wert("off_text"), false); err != nil {
			return nil, err
		}
		if z.An, err = bedingungen(wo+".on_when", o.wert("on_when")); err != nil {
			return nil, err
		}
		if z.AnEines, err = bedingungen(wo+".on_when_any", o.wert("on_when_any")); err != nil {
			return nil, err
		}
		if z.Aus, err = bedingungen(wo+".off_when", o.wert("off_when")); err != nil {
			return nil, err
		}
		if z.AusEines, err = bedingungen(wo+".off_when_any", o.wert("off_when_any")); err != nil {
			return nil, err
		}
		if z.An == nil && z.AnEines == nil {
			return nil, fehler("%s: ein Schalter braucht on_when oder on_when_any", wo)
		}
		switch neu {
		case "on":
			z.Neustart = neustartAn
		case "off":
			z.Neustart = neustartAus
		case "keep":
			z.Neustart = neustartBleibt
		default:
			return nil, fehler("%s.after_restart: on, off oder keep", wo)
		}
	case "timer":
		if err := nurSchluessel(wo, o, "type", "name", "duration", "after_restart"); err != nil {
			return nil, err
		}
		if z.Dauer, err = ausdruck(wo+".duration", o.wert("duration")); err != nil {
			return nil, err
		}
		switch neu {
		case "off":
			z.Neustart = neustartAus
		case "keep":
			z.Neustart = neustartBleibt
		default:
			return nil, fehler("%s.after_restart: off oder keep", wo)
		}
	case "counter":
		if err := nurSchluessel(wo, o, "type", "name", "min", "max", "after_restart", "steps"); err != nil {
			return nil, err
		}
		von, okV := o.wert("min").(jZahl)
		bis, okB := o.wert("max").(jZahl)
		if !okV || !okB || von.v != float64(int(von.v)) || bis.v != float64(int(bis.v)) {
			return nil, fehler("%s: min und max sind ganze Zahlen", wo)
		}
		z.Von, z.Bis = int(von.v), int(bis.v)
		switch n := neu.(type) {
		case jZahl:
			if n.v != float64(int(n.v)) {
				return nil, fehler("%s.after_restart: eine ganze Zahl oder keep", wo)
			}
			z.Neustart = neustartZahl
			z.NeustartWert = int(n.v)
		case string:
			if n != "keep" {
				return nil, fehler("%s.after_restart: eine ganze Zahl oder keep", wo)
			}
			z.Neustart = neustartBleibt
		default:
			return nil, fehler("%s.after_restart: eine ganze Zahl oder keep", wo)
		}
		schritte, ok := o.wert("steps").([]any)
		if !ok || len(schritte) == 0 || len(schritte) > maxSchritte {
			return nil, fehler("%s.steps: 1 bis %d Schritte", wo, maxSchritte)
		}
		for _, e := range schritte {
			so, ok := e.(*jObjekt)
			if !ok {
				return nil, fehler("%s.steps: erwartet Objekte", wo)
			}
			if err := nurSchluessel(wo+".steps", so, "name", "by", "set", "not_before", "when", "when_any", "then", "text"); err != nil {
				return nil, err
			}
			s := &Schritt{}
			if s.Name, err = textWert(wo+".steps.name", so.wert("name"), true); err != nil {
				return nil, err
			}
			if s.Text, err = textWert(wo+".steps."+s.Name+".text", so.wert("text"), false); err != nil {
				return nil, err
			}
			if err := pruefeKennung(wo+".steps", s.Name); err != nil {
				return nil, err
			}
			swo := wo + "." + s.Name
			if so.hat("by") == so.hat("set") {
				return nil, fehler("%s: entweder by oder set", swo)
			}
			if so.hat("by") {
				um, ok := so.wert("by").(jZahl)
				if !ok || um.v != float64(int(um.v)) {
					return nil, fehler("%s.by: eine ganze Zahl", swo)
				}
				s.Um = int(um.v)
				s.HatUm = true
			} else {
				if s.Setze, err = ausdruck(swo+".set", so.wert("set")); err != nil {
					return nil, err
				}
			}
			if so.hat("not_before") {
				// wie das Referenzlabor: eine feste Dauer oder eine Formel
				fb, err := ausdruck(swo+".not_before", so.wert("not_before"))
				if err != nil {
					return nil, err
				}
				if fb.t == kZahl {
					s.Fruehestens = fb.v
				} else {
					s.FruehestensBaum = fb
				}
			}
			if s.Alle, err = bedingungen(swo+".when", so.wert("when")); err != nil {
				return nil, err
			}
			if s.Eines, err = bedingungen(swo+".when_any", so.wert("when_any")); err != nil {
				return nil, err
			}
			if so.hat("then") {
				dann, _ := so.wert("then").(string)
				m := dannRe.FindStringSubmatch(strings.TrimSpace(strings.Join(strings.Fields(dann), " ")))
				if m == nil {
					return nil, fehler("„then“ kennt nur start(timer) [if …]: %s", dann)
				}
				s.DannStarte = strings.TrimSpace(m[1])
				if m[2] != "" {
					if s.DannWenn, err = ausdruck(swo+".then", m[2]); err != nil {
						return nil, err
					}
				}
			}
			L.woerter[s.Name] = true
			z.Schritte = append(z.Schritte, s)
		}
	default:
		return nil, fehler("Zustand „%s“: unbekannte Art %s", k, art)
	}
	return z, nil
}

// groesseDerQuelle leitet die Größe eines Eingangs aus seiner Quelle ab (wie das Referenzlabor;
// im Bau kommen die Namen aus dem Messkatalog der Box).
func groesseDerQuelle(von string) (Groesse, bool) {
	for _, s := range []string{".door_open", ".open", ".defrost", ".fault", ".running"} {
		if strings.HasSuffix(von, s) {
			return GroesseZahl, true
		}
	}
	if strings.HasSuffix(von, "temperature") {
		return GroesseTemp, false
	}
	if strings.HasSuffix(von, ".humidity") {
		return GroesseProzent, false
	}
	switch von {
	case "site.grid", "battery.power", "site.pv":
		return GroesseKW, false
	case "battery.soc":
		return GroesseProzent, false
	case "sun.elevation":
		return GroesseWinkel, false
	case "price.current":
		// Der Börsenpreis in ct/kWh (mqtt-price-current.md); die Sprache hat
		// keine Geld-Einheit, er ist eine Zahl.
		return GroesseZahl, false
	}
	return GroesseZahl, false
}
