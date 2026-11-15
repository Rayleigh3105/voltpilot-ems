package homeassistant

// Lesen der Dateien einer Home-Assistant-Anlage: configuration.yaml (Helfer, Vorlagen,
// history_stats), automations.yaml und scripts.yaml. Jedes Stück behält Datei und Zeile,
// damit Hinweise und "nicht übersetzbar" an die Stelle zeigen, die der Mensch kennt.

import (
	"fmt"
	"path"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Datei ist eine hochgeladene Datei.
type Datei struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// Ort ist eine Stelle in einer Datei von Home Assistant (Zeile ab 1).
type Ort struct {
	Datei string `json:"datei"`
	Zeile int    `json:"zeile"`
}

func (o Ort) String() string { return fmt.Sprintf("%s:%d", o.Datei, o.Zeile) }

type helfer struct {
	art      string // input_boolean, input_number, input_datetime, input_select, timer, counter
	id       string // Objekt-Kennung ohne Bereich
	name     string
	ort      Ort
	initial  *yaml.Node
	min      *float64
	max      *float64
	schritt  *float64
	einheit  string
	zeit     bool
	datum    bool
	dauer    *float64 // Zeitgeber, Sekunden
	restore  bool
	optionen []string
}

func (h *helfer) entity() string { return h.art + "." + h.id }

type vorlageSensor struct {
	art          string // sensor oder binary_sensor
	name         string
	uniqueID     string
	einheit      string
	klasse       string
	state        *yaml.Node
	availability *yaml.Node
	icon         *yaml.Node
	attribute    bool
	ort          Ort
}

type laufzeit struct {
	name, entity, zustand, typ, start, ende string
	ort                                     Ort
}

type automation struct {
	id, alias string
	ort       Ort
	ausloeser []*yaml.Node
	bedingung []*yaml.Node
	aktionen  []*yaml.Node
	mode      string
}

type skript struct {
	id, alias string
	ort       Ort
	sequenz   []*yaml.Node
}

// haAnlage ist alles, was die Dateien enthalten.
type haAnlage struct {
	helfer      []*helfer
	vorlagen    []*vorlageSensor
	laufzeiten  []*laufzeit
	automations []*automation
	skripte     []*skript
	texte       map[string][]string // Zeilen je Datei
	// ignoriert: Abschnitte, die nicht Teil einer Logik sind (http, logger, …)
	ignoriert []Stelle
	fehler    []Stelle
}

// Teile der configuration.yaml, die mit einer Steuerlogik nichts zu tun haben.
var ohneBelang = map[string]bool{
	"default_config": true, "frontend": true, "http": true, "logger": true, "recorder": true, "history": true,
	"logbook": true, "homeassistant": true, "scene": true, "lovelace": true, "panel_custom": true, "panel_iframe": true,
	"tts": true, "cloud": true, "mobile_app": true, "config": true, "system_health": true, "zone": true, "person": true,
	"group": true, "shell_command": true, "rest_command": true, "notify": true, "mqtt": true, "modbus": true,
	"influxdb": true, "prometheus": true, "energy": true, "api": true, "conversation": true, "map": true, "sun": true,
	"automation": true, "script": true, "wake_on_lan": true, "python_script": true, "camera": true, "light": true,
	"switch": true, "cover": true, "climate": true, "media_player": true, "device_tracker": true,
}

func liesAnlage(dateien []Datei) (*haAnlage, error) {
	a := &haAnlage{texte: map[string][]string{}}
	for _, d := range dateien {
		name := path.Base(d.Name)
		a.texte[name] = strings.Split(d.Text, "\n")
		var wurzel yaml.Node
		if err := yaml.Unmarshal([]byte(d.Text), &wurzel); err != nil {
			return nil, fmt.Errorf("%s ist kein lesbares YAML: %v", name, err)
		}
		if wurzel.Kind != yaml.DocumentNode || len(wurzel.Content) == 0 {
			continue
		}
		doc := wurzel.Content[0]
		switch art := dateiArt(name, doc); art {
		case "configuration":
			a.liesKonfiguration(name, doc)
		case "automations":
			a.liesAutomationen(name, doc)
		case "scripts":
			a.liesSkripte(name, doc)
		default:
			a.ignoriert = append(a.ignoriert, Stelle{Ort: Ort{Datei: name, Zeile: 1}, Was: name,
				Grund: "Diese Datei ist keine configuration.yaml, automations.yaml oder scripts.yaml; eine Ansicht (Dashboard) entsteht in VoltPilot aus der Logik."})
		}
	}
	return a, nil
}

// dateiArt erkennt eine Datei am Namen, sonst am Inhalt.
func dateiArt(name string, doc *yaml.Node) string {
	n := strings.ToLower(name)
	switch {
	case strings.HasPrefix(n, "configuration"):
		return "configuration"
	case strings.HasPrefix(n, "automation"):
		return "automations"
	case strings.HasPrefix(n, "script"):
		return "scripts"
	}
	if doc.Kind == yaml.SequenceNode {
		for _, e := range doc.Content {
			if feld(e, "triggers") != nil || feld(e, "trigger") != nil {
				return "automations"
			}
		}
		return ""
	}
	if doc.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(doc.Content); i += 2 {
			switch doc.Content[i].Value {
			case "input_number", "input_boolean", "input_datetime", "template", "timer", "sensor", "binary_sensor", "counter", "input_select":
				return "configuration"
			}
			if v := doc.Content[i+1]; v.Kind == yaml.MappingNode && feld(v, "sequence") != nil {
				return "scripts"
			}
		}
	}
	return ""
}

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

// erstesFeld nimmt den ersten vorhandenen Schlüssel (neue und alte Schreibweise von Home Assistant).
func erstesFeld(n *yaml.Node, ks ...string) *yaml.Node {
	for _, k := range ks {
		if v := feld(n, k); v != nil {
			return v
		}
	}
	return nil
}

func text(n *yaml.Node) string {
	if n == nil || n.Kind != yaml.ScalarNode {
		return ""
	}
	return n.Value
}

func zahlVon(n *yaml.Node) *float64 {
	if n == nil || n.Kind != yaml.ScalarNode {
		return nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(n.Value), 64)
	if err != nil {
		return nil
	}
	return &v
}

func liste(n *yaml.Node) []*yaml.Node {
	switch {
	case n == nil:
		return nil
	case n.Kind == yaml.SequenceNode:
		return n.Content
	}
	return []*yaml.Node{n}
}

func (a *haAnlage) liesKonfiguration(datei string, doc *yaml.Node) {
	if doc.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(doc.Content); i += 2 {
		k, v := doc.Content[i], doc.Content[i+1]
		ort := Ort{Datei: datei, Zeile: k.Line}
		switch k.Value {
		case "input_boolean", "input_number", "input_datetime", "input_select", "timer", "counter":
			a.liesHelfer(k.Value, datei, v)
		case "template":
			for _, block := range liste(v) {
				if erstesFeld(block, "trigger", "triggers") != nil {
					a.fehler = append(a.fehler, Stelle{Ort: Ort{Datei: datei, Zeile: block.Line}, Was: "template mit trigger",
						Grund: "Vorlagen mit eigenem Auslöser übersetzt der Übersetzer nicht; schreiben Sie sie als Zustand."})
					continue
				}
				for _, art := range []string{"sensor", "binary_sensor"} {
					for _, s := range liste(feld(block, art)) {
						a.liesVorlage(art, datei, s)
					}
				}
				for j := 0; j+1 < len(block.Content); j += 2 {
					if w := block.Content[j].Value; w != "sensor" && w != "binary_sensor" {
						a.fehler = append(a.fehler, Stelle{Ort: Ort{Datei: datei, Zeile: block.Content[j].Line}, Was: "template: " + w,
							Grund: "Nur Vorlagen-Sensoren (sensor, binary_sensor) lassen sich übersetzen."})
					}
				}
			}
		case "sensor", "binary_sensor":
			for _, s := range liste(v) {
				platform := text(feld(s, "platform"))
				switch {
				case platform == "history_stats":
					a.laufzeiten = append(a.laufzeiten, &laufzeit{
						name: text(feld(s, "name")), entity: text(feld(s, "entity_id")), zustand: text(feld(s, "state")),
						typ: text(feld(s, "type")), start: text(feld(s, "start")), ende: text(feld(s, "end")),
						ort: Ort{Datei: datei, Zeile: s.Line}})
				case platform == "template" && k.Value == "sensor" || platform == "template" && k.Value == "binary_sensor":
					a.liesAlteVorlagen(k.Value, datei, s)
				default:
					a.ignoriert = append(a.ignoriert, Stelle{Ort: Ort{Datei: datei, Zeile: s.Line}, Was: k.Value + ": " + platform,
						Grund: "Ein Sensor einer Integration ist ein Messwert; er wird zur Lücke, sobald die Logik ihn liest."})
				}
			}
		case "automation":
			if v.Kind == yaml.SequenceNode {
				a.liesAutomationen(datei, v)
			}
		case "script":
			if v.Kind == yaml.MappingNode {
				a.liesSkripte(datei, v)
			}
		default:
			if !ohneBelang[k.Value] && !strings.HasPrefix(k.Value, "automation ") && !strings.HasPrefix(k.Value, "script ") {
				a.ignoriert = append(a.ignoriert, Stelle{Ort: ort, Was: k.Value, Grund: "gehört nicht zu einer Steuerlogik"})
			}
		}
	}
}

func (a *haAnlage) liesHelfer(art, datei string, v *yaml.Node) {
	if v.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(v.Content); i += 2 {
		id, h := v.Content[i].Value, v.Content[i+1]
		x := &helfer{art: art, id: id, ort: Ort{Datei: datei, Zeile: v.Content[i].Line}}
		x.name = text(feld(h, "name"))
		x.initial = feld(h, "initial")
		x.min, x.max, x.schritt = zahlVon(feld(h, "min")), zahlVon(feld(h, "max")), zahlVon(feld(h, "step"))
		x.einheit = text(feld(h, "unit_of_measurement"))
		x.zeit = text(feld(h, "has_time")) == "true"
		x.datum = text(feld(h, "has_date")) == "true"
		x.restore = text(feld(h, "restore")) == "true"
		if d := feld(h, "duration"); d != nil {
			if s, ok := dauerSekunden(d); ok {
				x.dauer = &s
			}
		}
		for _, o := range liste(feld(h, "options")) {
			x.optionen = append(x.optionen, text(o))
		}
		a.helfer = append(a.helfer, x)
	}
}

func (a *haAnlage) liesVorlage(art, datei string, s *yaml.Node) {
	a.vorlagen = append(a.vorlagen, &vorlageSensor{
		art: art, name: text(feld(s, "name")), uniqueID: text(feld(s, "unique_id")),
		einheit: text(feld(s, "unit_of_measurement")), klasse: text(feld(s, "device_class")),
		state: feld(s, "state"), availability: feld(s, "availability"), icon: feld(s, "icon"),
		attribute: feld(s, "attributes") != nil, ort: Ort{Datei: datei, Zeile: s.Line},
	})
}

// liesAlteVorlagen liest die alte Schreibweise (platform: template, sensors: {…}).
func (a *haAnlage) liesAlteVorlagen(art, datei string, s *yaml.Node) {
	sensoren := feld(s, "sensors")
	if sensoren == nil || sensoren.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(sensoren.Content); i += 2 {
		id, v := sensoren.Content[i], sensoren.Content[i+1]
		name := text(feld(v, "friendly_name"))
		if name == "" {
			name = id.Value
		}
		a.vorlagen = append(a.vorlagen, &vorlageSensor{
			art: art, name: name, uniqueID: id.Value, einheit: text(feld(v, "unit_of_measurement")),
			klasse: text(feld(v, "device_class")), state: feld(v, "value_template"),
			availability: feld(v, "availability_template"), icon: feld(v, "icon_template"),
			attribute: feld(v, "attribute_templates") != nil, ort: Ort{Datei: datei, Zeile: id.Line},
		})
	}
}

func (a *haAnlage) liesAutomationen(datei string, doc *yaml.Node) {
	for _, e := range liste(doc) {
		if e.Kind != yaml.MappingNode {
			continue
		}
		au := &automation{id: text(feld(e, "id")), alias: text(feld(e, "alias")), ort: Ort{Datei: datei, Zeile: e.Line},
			mode: text(feld(e, "mode"))}
		au.ausloeser = liste(erstesFeld(e, "triggers", "trigger"))
		au.bedingung = liste(erstesFeld(e, "conditions", "condition"))
		au.aktionen = liste(erstesFeld(e, "actions", "action"))
		a.automations = append(a.automations, au)
	}
}

func (a *haAnlage) liesSkripte(datei string, doc *yaml.Node) {
	if doc.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(doc.Content); i += 2 {
		k, v := doc.Content[i], doc.Content[i+1]
		a.skripte = append(a.skripte, &skript{id: k.Value, alias: text(feld(v, "alias")),
			ort: Ort{Datei: datei, Zeile: k.Line}, sequenz: liste(feld(v, "sequence"))})
	}
}

// dauerSekunden liest eine Dauer von Home Assistant: "00:02:00", Sekunden als Zahl
// oder {hours, minutes, seconds}.
func dauerSekunden(n *yaml.Node) (float64, bool) {
	if n == nil {
		return 0, false
	}
	switch n.Kind {
	case yaml.ScalarNode:
		s := strings.TrimSpace(n.Value)
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v, true
		}
		teile := strings.Split(s, ":")
		if len(teile) < 2 || len(teile) > 3 {
			return 0, false
		}
		var summe float64
		for _, t := range teile {
			v, err := strconv.ParseFloat(t, 64)
			if err != nil {
				return 0, false
			}
			summe = summe*60 + v
		}
		if len(teile) == 2 {
			summe *= 60
		}
		return summe, true
	case yaml.MappingNode:
		var summe float64
		for i := 0; i+1 < len(n.Content); i += 2 {
			v := zahlVon(n.Content[i+1])
			if v == nil {
				return 0, false
			}
			switch n.Content[i].Value {
			case "days":
				summe += *v * 86400
			case "hours":
				summe += *v * 3600
			case "minutes":
				summe += *v * 60
			case "seconds":
				summe += *v
			case "milliseconds":
				summe += *v / 1000
			default:
				return 0, false
			}
		}
		return summe, true
	}
	return 0, false
}

// vorlagenText liefert den Text einer Vorlage, wie er in der Datei steht, und die Zeile,
// in der er beginnt. Bei einem Block (> oder |) nimmt er die Zeilen der Datei, damit eine
// gefaltete Vorlage ihre Zeilen behält.
func (a *haAnlage) vorlagenText(datei string, n *yaml.Node) (string, int) {
	if n == nil {
		return "", 0
	}
	if n.Style&(yaml.LiteralStyle|yaml.FoldedStyle) == 0 {
		return n.Value, n.Line
	}
	zeilen := a.texte[datei]
	if n.Line < 1 || n.Line > len(zeilen) {
		return n.Value, n.Line
	}
	kopf := zeilen[n.Line-1]
	einzug := len(kopf) - len(strings.TrimLeft(kopf, " "))
	var teile []string
	for i := n.Line; i < len(zeilen); i++ {
		z := zeilen[i]
		if strings.TrimSpace(z) == "" {
			teile = append(teile, "")
			continue
		}
		if len(z)-len(strings.TrimLeft(z, " ")) <= einzug {
			break
		}
		teile = append(teile, z)
	}
	return strings.Join(teile, "\n"), n.Line + 1
}
