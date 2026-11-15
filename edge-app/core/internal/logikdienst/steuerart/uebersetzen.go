// Package steuerart übersetzt die Verbraucherregel einer Steuerart in eine Logik der Regelsprache
// (Steuerlogik Stufe 6, Zusammenführen, dritter Teil: „ein Mechanismus statt vier“).
//
// Gelesen wird genau, was der Compiler der Cloud aus einer Steuerart baut
// (services/api/…/ConsumerPolicyCompiler.java): ein Flow-Dokument mit `origin.kind` =
// consumer-policy und genau einem Knoten vp.consumer.reactive. Die Übersetzung entscheidet wie
// der Knoten (Node-RED-Palette auf der Docker-Box, Go-Zwilling internal/verbraucherregel auf
// Edge Light):
//
//   - je Anforderung der Bedingungsbaum dreiwertig (all → and, any → or, not → not); ein Wert
//     ohne frische Messung ist unbekannt, unbekannt startet nichts;
//   - eine Schwelle mit Rückfallwert (reset_value) ist ein Schalter, der bei der Schwelle angeht,
//     beim Rückfallwert ausgeht und dazwischen bleibt; ein veralteter Wert vergisst ihn;
//   - alle geltenden Anforderungen ergeben EIN Ziel: Ein/Aus ist an, ein Sollwert in kW der
//     größte, eine Betriebsart die der ersten geltenden Anforderung; Pflicht gilt, wenn eine
//     geltende Anforderung Pflicht ist (must_run: über dem Fahrplan);
//   - endet die letzte Anforderung, hält die Ausschaltverzögerung das Ziel noch off_delay_s.
//
// Wie sie entscheidet, belegt gleichheit_test.go gegen verbraucherregel-vectors.json und den
// Go-Zwilling des Knotens. Was der Kern an der Anlage nicht liest, wird mit Grund genannt.
package steuerart

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// ErrKeineSteuerart: das Dokument ist nicht die generierte Verbraucherregel einer Steuerart.
var ErrKeineSteuerart = errors.New("keine Verbraucherregel einer Steuerart")

// Grund ist eine Stelle, die sich nicht übersetzen lässt.
type Grund struct {
	Code string `json:"code"`
	Text string `json:"text"`
}

// Herkunft nennt die Steuerart im Kopf des Texts.
type Herkunft struct {
	Name    string
	Fassung int
	Geraet  string // Name des Geräts
}

// Ergebnis ist die Übersetzung.
type Ergebnis struct {
	Text    string  `json:"text,omitempty"`
	Gruende []Grund `json:"gruende"`
	// Pflicht: die Logik trägt must_run (eine Anforderung ist Pflicht).
	Pflicht bool `json:"pflicht"`
}

// Regel sind die Parameter des Knotens vp.consumer.reactive.
type Regel struct {
	Entity      string
	Command     string
	OffDelayS   float64
	Anforderung []Anforderung
}

// Anforderung ist eine Anforderung des Knotens.
type Anforderung struct {
	ID      string
	MustRun bool
	Wert    any
	HatWert bool
	Bedingt any
}

// Lies liest ein generiertes Flow-Dokument (origin consumer-policy) oder die Parameter des
// Knotens selbst.
func Lies(doc json.RawMessage) (*Regel, error) {
	var d map[string]any
	if err := json.Unmarshal(doc, &d); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrKeineSteuerart, err)
	}
	params := d
	if nodes, ok := d["nodes"].([]any); ok {
		origin, _ := d["origin"].(map[string]any)
		if k, _ := origin["kind"].(string); k != "consumer-policy" {
			return nil, fmt.Errorf("%w: origin.kind ist nicht consumer-policy", ErrKeineSteuerart)
		}
		if len(nodes) != 1 {
			return nil, fmt.Errorf("%w: genau ein Knoten erwartet", ErrKeineSteuerart)
		}
		n, _ := nodes[0].(map[string]any)
		if t, _ := n["type"].(string); t != "vp.consumer.reactive" {
			return nil, fmt.Errorf("%w: Knoten %v", ErrKeineSteuerart, n["type"])
		}
		params, _ = n["parameters"].(map[string]any)
		if params == nil {
			return nil, fmt.Errorf("%w: Parameter fehlen", ErrKeineSteuerart)
		}
	}
	r := &Regel{}
	r.Entity, _ = params["entity_id"].(string)
	if r.Entity == "" {
		r.Entity, _ = params["entity"].(string)
	}
	r.Command, _ = params["command"].(string)
	if od, ok := params["off_delay_s"].(float64); ok && od > 0 && !math.IsInf(od, 0) {
		r.OffDelayS = od
	}
	reqs, ok := params["requirements"].([]any)
	if !ok {
		return nil, fmt.Errorf("%w: requirements fehlen", ErrKeineSteuerart)
	}
	for _, x := range reqs {
		m, _ := x.(map[string]any)
		if m == nil {
			return nil, fmt.Errorf("%w: eine Anforderung ist kein Objekt", ErrKeineSteuerart)
		}
		a := Anforderung{Bedingt: m["condition"]}
		a.ID, _ = m["id"].(string)
		a.MustRun, _ = m["must_run"].(bool)
		a.Wert, a.HatWert = m["value"]
		r.Anforderung = append(r.Anforderung, a)
	}
	return r, nil
}

// Betriebsarten der Sprache (Wortliste, Tabelle betriebsart).
var betriebsarten = map[string]bool{"normal": true, "boost": true, "cool": true, "heat": true, "fan_only": true,
	"dry": true, "auto": true, "start": true}

type eingang struct {
	kennung, source, name, einheit string
	maxAge                         float64
}

type uebersetzung struct {
	r         *Regel
	h         Herkunft
	gruende   []Grund
	eingaenge map[string]*eingang
	liste     []*eingang
	schalter  []schalter
}

type schalter struct {
	kennung   string
	an, aus   string
	anF, ausF string
	fehlt     string
	fehltF    string
}

func (u *uebersetzung) grund(code, format string, a ...any) {
	u.gruende = append(u.gruende, Grund{Code: code, Text: fmt.Sprintf(format, a...)})
}

// Uebersetze übersetzt eine gelesene Verbraucherregel.
func Uebersetze(r *Regel, h Herkunft) Ergebnis {
	u := &uebersetzung{r: r, h: h, eingaenge: map[string]*eingang{}}
	switch r.Command {
	case "on_off", "setpoint_kw", "mode":
	default:
		u.grund("befehl", "Den Befehl „%s“ stellt eine Logik nicht.", r.Command)
	}
	if r.Entity == "" {
		u.grund("geraet", "Die Verbraucherregel nennt kein Gerät.")
	}
	if len(r.Anforderung) == 0 {
		u.grund("anforderung", "Die Verbraucherregel hat keine Anforderung.")
	}
	formeln := make([]string, len(r.Anforderung))
	for i, a := range r.Anforderung {
		if r.Command == "mode" {
			w, ok := a.Wert.(string)
			if !ok || !betriebsarten[w] {
				u.grund("betriebsart", "Die Betriebsart „%v“ kennt die Regelsprache nicht.", a.Wert)
			}
		}
		formeln[i] = u.baum(a.Bedingt, 0)
	}
	if len(u.gruende) > 0 {
		return Ergebnis{Gruende: u.gruende}
	}
	return u.schreibe(formeln)
}

// UebersetzeDokument liest und übersetzt.
func UebersetzeDokument(doc json.RawMessage, h Herkunft) (Ergebnis, error) {
	r, err := Lies(doc)
	if err != nil {
		return Ergebnis{}, err
	}
	return Uebersetze(r, h), nil
}

// zahl ist numeric() des Knotens: Ja/Nein als 1/0, eine endliche Zahl, sonst keine.
func zahl(v any) (float64, bool) {
	switch x := v.(type) {
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	}
	return 0, false
}

var ops = map[string]string{"lt": "<", "lte": "<=", "gt": ">", "gte": ">=", "eq": "==", "ne": "!="}

// baum übersetzt einen Bedingungsbaum in eine dreiwertige Formel.
func (u *uebersetzung) baum(roh any, tiefe int) string {
	if tiefe > 16 {
		u.grund("bedingung", "Der Bedingungsbaum ist zu tief.")
		return "false"
	}
	c, ok := roh.(map[string]any)
	if !ok {
		u.grund("bedingung", "Eine Bedingung ist kein Objekt.")
		return "false"
	}
	verbinde := func(liste []any, wort, leer string) string {
		if len(liste) == 0 {
			return leer
		}
		var teile []string
		for _, x := range liste {
			teile = append(teile, u.baum(x, tiefe+1))
		}
		if len(teile) == 1 {
			return teile[0]
		}
		return "(" + strings.Join(teile, " "+wort+" ") + ")"
	}
	if l, ok := c["all"].([]any); ok {
		return verbinde(l, "and", "true")
	}
	if l, ok := c["any"].([]any); ok {
		return verbinde(l, "or", "false")
	}
	if n, ok := c["not"]; ok {
		return "not " + klammer(u.baum(n, tiefe+1))
	}
	if _, ok := c["windows"]; ok {
		u.grund("fenster", "Ein Preisfenster rechnet die Cloud aus ihren Preisen; das liest der Kern der Box nicht.")
		return "false"
	}
	signal, ok := c["signal"].(string)
	if !ok {
		u.grund("bedingung", "Eine Bedingung ohne Signal.")
		return "false"
	}
	return u.blatt(signal, c)
}

func klammer(f string) string {
	if strings.HasPrefix(f, "(") || !strings.ContainsAny(f, " ") {
		return f
	}
	return "(" + f + ")"
}

// blatt übersetzt eine Messwert-Bedingung.
func (u *uebersetzung) blatt(signal string, c map[string]any) string {
	quelle, _ := c["source"].(string)
	kanal, _ := c["channel"].(string)
	if quelle != "site" {
		u.grund("messwert", "„%s“ liest die Box für eine Logik nicht; übersetzen lassen sich der Sonnen-Überschuss, der Netzbezug und der Ladestand des Speichers.", signal)
		return "false"
	}
	var e eingang
	switch kanal {
	case "pv_surplus_kw":
		e = eingang{kennung: "ueberschuss", source: "site.surplus", name: "Sonnen-Überschuss", einheit: "kW"}
	case "grid_power_kw":
		e = eingang{kennung: "netz", source: "site.grid", name: "Netzbezug", einheit: "kW"}
	case "soc_pct":
		e = eingang{kennung: "ladestand", source: "battery.soc", name: "Ladestand Speicher", einheit: "%"}
	default:
		u.grund("messwert", "Den Wert „%s“ der Anlage liest der Kern nicht.", kanal)
		return "false"
	}
	maxAge, ok := c["max_age_s"].(float64)
	if !ok || !(maxAge >= 1) || math.IsInf(maxAge, 0) {
		u.grund("frische", "„%s“ ohne Frische (max_age_s ab 1 s) gilt nie; die Übersetzung schreibt das nicht.", signal)
		return "false"
	}
	e.maxAge = maxAge
	k := u.nimm(e)
	op, ok := ops[c["op"].(string)]
	if !ok {
		u.grund("vergleich", "Den Vergleich „%v“ kennt die Verbraucherregel nicht.", c["op"])
		return "false"
	}
	schwelle, ok := zahl(c["value"])
	if !ok {
		u.grund("schwelle", "Die Schwelle von „%s“ ist keine Zahl.", signal)
		return "false"
	}
	wert := func(v float64) string { return zahlText(v) + " " + e.einheit }
	rueck, hatRueck := c["reset_value"]
	rv, rueckZahl := zahl(rueck)
	opWort, _ := c["op"].(string)
	if !hatRueck || !rueckZahl || (opWort != "lt" && opWort != "lte" && opWort != "gt" && opWort != "gte") {
		return k.kennung + " " + op + " " + wert(schwelle)
	}
	oben := opWort == "gt" || opWort == "gte"
	if (oben && rv > schwelle) || (!oben && rv < schwelle) {
		u.grund("hysterese", "Der Rückfallwert von „%s“ liegt auf der falschen Seite der Schwelle.", signal)
		return "false"
	}
	nr := len(u.schalter) + 1
	s := schalter{kennung: fmt.Sprintf("schwelle_%d", nr)}
	s.anF = k.kennung + " " + op + " " + wert(schwelle)
	if oben {
		s.ausF = k.kennung + " < " + wert(rv)
		s.an = fmt.Sprintf("„%s“ liegt über %s", k.name, deutsch(schwelle, e.einheit))
		s.aus = fmt.Sprintf("„%s“ liegt unter %s", k.name, deutsch(rv, e.einheit))
	} else {
		s.ausF = k.kennung + " > " + wert(rv)
		s.an = fmt.Sprintf("„%s“ liegt unter %s", k.name, deutsch(schwelle, e.einheit))
		s.aus = fmt.Sprintf("„%s“ liegt über %s", k.name, deutsch(rv, e.einheit))
	}
	s.fehlt = fmt.Sprintf("„%s“ fehlt", k.name)
	s.fehltF = "unknown(" + k.kennung + ")"
	u.schalter = append(u.schalter, s)
	return "if(known(" + k.kennung + "), " + s.kennung + ", unknown)"
}

// nimm legt einen Eingang je Quelle und Frische an.
func (u *uebersetzung) nimm(e eingang) *eingang {
	schluessel := e.source + "|" + zahlText(e.maxAge)
	if x, ok := u.eingaenge[schluessel]; ok {
		return x
	}
	n := 0
	for _, x := range u.liste {
		if x.source == e.source {
			n++
		}
	}
	if n > 0 {
		e.kennung = fmt.Sprintf("%s_%d", e.kennung, n+1)
		e.name = fmt.Sprintf("%s (%s s)", e.name, zahlText(e.maxAge))
	}
	x := &e
	u.eingaenge[schluessel] = x
	u.liste = append(u.liste, x)
	return x
}

func zahlText(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func deutsch(v float64, einheit string) string {
	t := strings.Replace(strconv.FormatFloat(math.Abs(v), 'f', -1, 64), ".", ",", 1)
	if v < 0 {
		t = "−" + t
	}
	return t + " " + einheit
}

// ziel beschreibt, wie das Ziel der geltenden Anforderungen als Zahl im Zähler „ziel“ steht:
// 0 = keins; sonst 1 + 2·k + Pflicht, k der Wert (Index in werte; len(werte) = kein Wert).
type ziel struct {
	werte  []string // Text des Werts für den Ausgang (kW mit Einheit oder Betriebsart)
	wahlen []string // je Wert die Formel „dieser Wert gilt“ (erster zutreffender gewinnt)
}

func gilt(i int) string {
	return fmt.Sprintf("(known(anforderung_%d) and anforderung_%d)", i, i)
}

func (u *uebersetzung) ziel() ziel {
	r := u.r
	var z ziel
	switch r.Command {
	case "on_off":
		z.werte = []string{"on"}
		var alle []string
		for i := range r.Anforderung {
			alle = append(alle, gilt(i+1))
		}
		z.wahlen = []string{strings.Join(alle, " or ")}
	case "setpoint_kw":
		// Der größte Wert unter den geltenden (§7 der Verbrauchssteuerung); gleiche Werte zählen einmal.
		var vs []float64
		gesehen := map[float64]bool{}
		for _, a := range r.Anforderung {
			if v, ok := zahl(a.Wert); ok && a.HatWert && !gesehen[v] {
				gesehen[v] = true
				vs = append(vs, v)
			}
		}
		sort.Sort(sort.Reverse(sort.Float64Slice(vs)))
		for _, v := range vs {
			var mit []string
			for i, a := range r.Anforderung {
				if w, ok := zahl(a.Wert); ok && a.HatWert && w == v {
					mit = append(mit, gilt(i+1))
				}
			}
			z.werte = append(z.werte, zahlText(v)+" kW")
			z.wahlen = append(z.wahlen, strings.Join(mit, " or "))
		}
	case "mode":
		// Die Reihenfolge des Dokuments entscheidet: die erste geltende Anforderung.
		for i, a := range r.Anforderung {
			z.werte = append(z.werte, a.Wert.(string))
			z.wahlen = append(z.wahlen, gilt(i+1))
		}
	}
	return z
}

func (u *uebersetzung) schreibe(formeln []string) Ergebnis {
	r := u.r
	s := &schreiber{}
	name := u.h.Name
	if strings.TrimSpace(name) == "" {
		name = "Verbraucherregel"
	}
	geraet := u.h.Geraet
	if geraet == "" {
		geraet = "Gerät"
	}
	pflicht := false
	for _, a := range r.Anforderung {
		pflicht = pflicht || a.MustRun
	}
	s.kommentar(0, fmt.Sprintf("Übersetzt aus der Verbraucherregel der Steuerart „%s“ (Fassung %d).", name, u.h.Fassung))
	s.kommentar(0, "Bearbeitet wird die Steuerart, nicht dieser Text: jede neue Fassung übersetzt ihn neu.")
	s.kommentar(0, "Wie die Übersetzung entscheidet, belegt logikdienst/steuerart/gleichheit_test.go gegen docs/contracts/v2/verbraucherregel-vectors.json.")
	s.zeile(0, "logic: 1")
	s.zeile(0, "name: "+skalar(name, false))
	s.zeile(0, "")
	s.zeile(0, "devices:")
	s.zeile(2, fmt.Sprintf("geraet: {entity: %s, name: %s}", skalar(r.Entity, true), skalar(geraet, true)))
	s.zeile(0, "")
	if len(u.liste) > 0 {
		s.zeile(0, "inputs:")
		for _, e := range u.liste {
			s.zeile(2, fmt.Sprintf("%s: {source: %s, name: %s, max_age: %s s}", e.kennung, e.source, skalar(e.name, true), zahlText(e.maxAge)))
		}
		s.zeile(0, "")
	}

	z := u.ziel()
	s.zeile(0, "formulas:")
	for i, f := range formeln {
		id := r.Anforderung[i].ID
		s.kommentar(2, fmt.Sprintf("Anforderung „%s“%s: dreiwertig, ohne frischen Wert unbekannt.", id, wahl(r.Anforderung[i].MustRun, " (Pflicht)", "")))
		s.zeile(2, fmt.Sprintf("anforderung_%d: %s", i+1, formel(f)))
	}
	var alle, pflichten []string
	for i, a := range r.Anforderung {
		alle = append(alle, gilt(i+1))
		if a.MustRun {
			pflichten = append(pflichten, gilt(i+1))
		}
	}
	s.zeile(2, "gilt_jetzt: "+formel(strings.Join(alle, " or ")))
	if pflicht {
		s.zeile(2, "pflicht_jetzt: "+formel(strings.Join(pflichten, " or ")))
	}
	// Welcher Wert jetzt gilt (Index; len = keiner, etwa ein Sollwert ohne Zahl).
	wertIndex := strconv.Itoa(len(z.werte))
	for k := len(z.wahlen) - 1; k >= 0; k-- {
		wertIndex = fmt.Sprintf("if(%s, %d, %s)", z.wahlen[k], k, wertIndex)
	}
	pBit := "0"
	if pflicht {
		pBit = "if(pflicht_jetzt, 1, 0)"
	}
	s.zeile(2, "ziel_jetzt: "+formel(fmt.Sprintf("1 + 2 * %s + %s", wertIndex, pBit)))
	s.zeile(0, "")

	s.zeile(0, "states:")
	for _, x := range u.schalter {
		s.zeile(2, x.kennung+":")
		s.zeile(4, "type: boolean")
		s.zeile(4, "on_when:")
		s.zeile(6, "- "+skalar(x.an, false)+": "+formel(x.anF))
		s.zeile(4, "off_when_any:")
		s.zeile(6, "- "+skalar(x.aus, false)+": "+formel(x.ausF))
		s.zeile(6, "- "+skalar(x.fehlt, false)+": "+formel(x.fehltF))
		s.zeile(4, "on_text: "+skalar(x.an, false))
		s.zeile(4, "off_text: "+skalar(x.aus, false))
		s.zeile(4, "after_restart: off")
	}
	s.zeile(2, "gilt:")
	s.zeile(4, "type: boolean")
	s.zeile(4, "on_when:")
	s.zeile(6, "- Eine Anforderung gilt: gilt_jetzt")
	s.zeile(4, "off_when:")
	s.zeile(6, "- Keine Anforderung gilt: not gilt_jetzt")
	s.zeile(4, "on_text: Eine Anforderung gilt")
	s.zeile(4, "off_text: Keine Anforderung gilt mehr")
	s.zeile(4, "after_restart: off")
	maxZiel := 1 + 2*len(z.werte) + 1
	s.kommentar(2, "Das Ziel als Zahl: 0 keins, sonst 1 + 2 · Wert + Pflicht. Nach der letzten Anforderung hält es die Ausschaltverzögerung.")
	s.zeile(2, "ziel:")
	s.zeile(4, "type: counter")
	s.zeile(4, "min: 0")
	s.zeile(4, fmt.Sprintf("max: %d", maxZiel))
	s.zeile(4, "after_restart: 0")
	s.zeile(4, "steps:")
	s.zeile(6, "- name: verzoegerung_vorbei")
	s.zeile(8, "text: Die Ausschaltverzögerung ist vorbei")
	s.zeile(8, "set: 0")
	s.zeile(8, "when:")
	s.zeile(10, fmt.Sprintf("- Seit %s s gilt keine Anforderung: not gilt and since(gilt) >= %s s", zahlText(r.OffDelayS), zahlText(r.OffDelayS)))
	s.zeile(6, "- name: anforderung")
	s.zeile(8, "text: Die geltenden Anforderungen setzen das Ziel")
	s.zeile(8, "set: ziel_jetzt")
	s.zeile(8, "when:")
	s.zeile(10, "- Eine Anforderung gilt: gilt_jetzt")
	s.zeile(0, "")

	s.zeile(0, "outputs:")
	var aus string
	switch r.Command {
	case "on_off":
		aus = "on_off: " + skalar("if(ziel > 0, on, unknown)", true)
	case "setpoint_kw", "mode":
		f := "unknown"
		for k := len(z.werte) - 1; k >= 0; k-- {
			f = fmt.Sprintf("if(ziel == %d or ziel == %d, %s, %s)", 1+2*k, 2+2*k, z.werte[k], f)
		}
		art := "setpoint"
		if r.Command == "mode" {
			art = "mode"
		}
		aus = art + ": " + skalar(f, true)
	}
	if pflicht {
		var gerade []string
		for k := 0; k <= len(z.werte); k++ {
			gerade = append(gerade, fmt.Sprintf("ziel == %d", 2+2*k))
		}
		aus += ", must_run: " + skalar(strings.Join(gerade, " or "), true)
		s.kommentar(2, "Pflicht wie die Pflichtregel der Verbraucherregel: über dem Fahrplan (Rang 70), unter dem Handeingriff.")
	}
	s.zeile(2, "geraet: {"+aus+"}")
	s.zeile(0, "")

	s.zeile(0, "status:")
	s.zeile(2, "- when: ziel > 0 and not gilt")
	s.zeile(4, "title: Hält noch")
	s.zeile(4, "type: waiting")
	s.zeile(4, "text: "+skalar(fmt.Sprintf("Keine Anforderung gilt mehr; „%s“ bleibt noch %s s wie zuletzt.", geraet, zahlText(r.OffDelayS)), false))
	s.zeile(2, "- when: gilt")
	s.zeile(4, "title: Steuerart greift")
	s.zeile(4, "type: "+wahl(u.mitUeberschuss(), "solar", "idle"))
	s.zeile(4, "text: "+skalar(fmt.Sprintf("Eine Anforderung der Steuerart gilt; sie steuert „%s“.", geraet), false))
	if len(u.liste) > 0 {
		var fehlt []string
		for _, e := range u.liste {
			fehlt = append(fehlt, "unknown("+e.kennung+")")
		}
		s.zeile(2, "- when: "+formel(strings.Join(fehlt, " or ")))
		s.zeile(4, "title: Ein Wert fehlt")
		s.zeile(4, "type: fault")
		s.zeile(4, "text: "+skalar(fmt.Sprintf("Ohne frischen Wert gilt die Bedingung nicht; „%s“ bekommt keinen Wunsch.", geraet), false))
	}
	s.zeile(2, "- else: true")
	s.zeile(4, "title: Wartet")
	s.zeile(4, "type: waiting")
	s.zeile(4, "text: "+skalar(fmt.Sprintf("Sobald eine Anforderung gilt, steuert die Steuerart „%s“.", geraet), false))
	return Ergebnis{Text: s.b.String(), Gruende: []Grund{}, Pflicht: pflicht}
}

func (u *uebersetzung) mitUeberschuss() bool {
	for _, e := range u.liste {
		if e.source == "site.surplus" {
			return true
		}
	}
	return false
}

func wahl(b bool, ja, nein string) string {
	if b {
		return ja
	}
	return nein
}

func formel(f string) string {
	if strings.ContainsAny(f, "\"#") || strings.HasPrefix(f, "-") || strings.HasPrefix(f, "{") ||
		strings.HasPrefix(f, "[") || strings.Contains(f, ": ") {
		return "'" + f + "'"
	}
	return f
}
