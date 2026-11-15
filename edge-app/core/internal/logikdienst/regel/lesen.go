// Package regel übersetzt eine Regel des Regel-Baukastens in eine Logik der Regelsprache
// (Steuerlogik Stufe 6, Zusammenführen: „ein Mechanismus statt vier“).
//
// Eine Regel ist ein Flow-Dokument aus genau der Teilmenge, die der geführte Baukasten des
// Portals baut (frontend/portal/src/flows/guidedBuilder.ts, buildGuidedFlow): je Bedingung ein
// Messwert, der Börsenpreis oder ein Zeitfenster, verknüpft mit und oder oder, und genau eine
// Tat (Ein/Aus oder „voll“ als Sollwert in kW). Lesen ist der Zwilling von parseGuidedFlow:
// was das Portal nicht als geführte Regel liest, liest auch dieser Leser nicht.
//
// Wie die Übersetzung entscheidet, belegen die Vektoren docs/contracts/v2/regel-kern-vectors.json:
// derselbe Flow, mit flowc kompiliert und so ausgeführt, wie Node-RED ihn ausführt, gegen die
// übersetzte Logik im Kern, Sekunde für Sekunde (gleichheit_test.go).
package regel

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
)

// ErrNichtGefuehrt: das Dokument ist keine Regel des geführten Baukastens.
var ErrNichtGefuehrt = errors.New("keine Regel des Regel-Baukastens")

// Bedingung ist eine Bedingung einer Regel (GuidedCondition).
type Bedingung struct {
	// Art: "entity" (ein Messwert eines Geräts), "price" (Börsenpreis), "schedule" (Zeitfenster).
	Art string
	// Entity und Kanal bei "entity".
	Entity, Kanal string
	// Richtung "above" oder "below", Schwelle und Hysterese bei "entity" und "price".
	Richtung  string
	Schwelle  float64
	Hysterese float64
	// Von, Bis ("HH:MM") und Tage ("alle", "werktage", "wochenende") bei "schedule".
	Von, Bis, Tage string
}

// Tat ist, was die Regel tut (GuidedAction): "onoff", "setpoint" oder "notify".
type Tat struct {
	Art     string
	Entity  string
	Wert    float64 // Sollwert in kW bei "setpoint"
	TTL     int
	Meldung string // bei "notify"
}

// Regel ist eine gelesene Regel des Baukastens.
type Regel struct {
	Bedingungen []Bedingung
	// Verknuepfung "and" oder "or" (bei einer Bedingung ohne Bedeutung).
	Verknuepfung string
	Tat          Tat
}

type portRef struct {
	Node string `json:"node"`
	Port string `json:"port"`
}

type knoten struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Parameters map[string]any `json:"parameters"`
}

type kante struct {
	From portRef `json:"from"`
	To   portRef `json:"to"`
}

type dokument struct {
	Nodes []knoten `json:"nodes"`
	Edges []kante  `json:"edges"`
}

var hhmm = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// guidedTTL ist die Gültigkeit, die der Baukasten jedem Wunsch gibt (GUIDED_WISH_TTL_S).
const guidedTTL = 930

type leser struct {
	byID  map[string]*knoten
	edges []kante
	used  map[string]bool
}

func (l *leser) feeder(node, port string) *portRef {
	var f *portRef
	n := 0
	for i := range l.edges {
		e := l.edges[i]
		if e.To.Node == node && e.To.Port == port {
			n++
			f = &l.edges[i].From
		}
	}
	if n != 1 {
		return nil
	}
	return f
}

func zahl(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

func text(v any) string {
	s, _ := v.(string)
	return s
}

func (l *leser) blatt(ref *portRef) (*Bedingung, error) {
	n := l.byID[ref.Node]
	if n == nil {
		return nil, fmt.Errorf("%w: ein Eingang führt ins Leere", ErrNichtGefuehrt)
	}
	switch {
	case n.Type == "vp.schedule.window" && ref.Port == "active":
		l.used[n.ID] = true
		tage := "alle"
		if v, ok := n.Parameters["days"]; ok {
			tage = text(v)
		}
		if tage != "alle" && tage != "werktage" && tage != "wochenende" {
			return nil, fmt.Errorf("%w: Tage des Zeitfensters", ErrNichtGefuehrt)
		}
		return &Bedingung{Art: "schedule", Von: text(n.Parameters["from"]), Bis: text(n.Parameters["to"]), Tage: tage}, nil
	case n.Type == "vp.logic.threshold" && ref.Port == "result":
		l.used[n.ID] = true
		richtung := "above"
		if text(n.Parameters["direction"]) == "below" {
			richtung = "below"
		}
		schwelle, ok := zahl(n.Parameters["threshold"])
		if !ok {
			return nil, fmt.Errorf("%w: Schwelle ist keine Zahl", ErrNichtGefuehrt)
		}
		hyst := 0.0
		if v, da := n.Parameters["hysteresis"]; da {
			if hyst, ok = zahl(v); !ok || hyst < 0 {
				return nil, fmt.Errorf("%w: Hysterese ist keine Zahl", ErrNichtGefuehrt)
			}
		}
		f := l.feeder(n.ID, "input")
		if f == nil {
			return nil, fmt.Errorf("%w: Schwelle ohne Eingang", ErrNichtGefuehrt)
		}
		src := l.byID[f.Node]
		if src == nil {
			return nil, fmt.Errorf("%w: ein Eingang führt ins Leere", ErrNichtGefuehrt)
		}
		b := &Bedingung{Richtung: richtung, Schwelle: schwelle, Hysterese: hyst}
		switch {
		case src.Type == "vp.entity.read" && f.Port == "value":
			l.used[src.ID] = true
			b.Art, b.Entity, b.Kanal = "entity", text(src.Parameters["entity_id"]), text(src.Parameters["channel"])
		case src.Type == "vp.price.current" && f.Port == "value":
			l.used[src.ID] = true
			b.Art = "price"
		default:
			return nil, fmt.Errorf("%w: eine Schwelle liest weder Messwert noch Preis", ErrNichtGefuehrt)
		}
		return b, nil
	}
	return nil, fmt.Errorf("%w: Baustein %s", ErrNichtGefuehrt, n.Type)
}

// bool zerlegt einen Ja/Nein-Ausgang in Bedingungen und eine einheitliche Verknüpfung
// (links gefaltet wie buildGuidedFlow: ((a ∘ b) ∘ c) ∘ d, rechts immer ein Blatt).
func (l *leser) bool(ref *portRef) ([]Bedingung, string, error) {
	n := l.byID[ref.Node]
	if n == nil {
		return nil, "", fmt.Errorf("%w: ein Eingang führt ins Leere", ErrNichtGefuehrt)
	}
	if (n.Type == "vp.logic.and" || n.Type == "vp.logic.or") && ref.Port == "result" {
		l.used[n.ID] = true
		verk := "and"
		if n.Type == "vp.logic.or" {
			verk = "or"
		}
		a, b := l.feeder(n.ID, "a"), l.feeder(n.ID, "b")
		if a == nil || b == nil {
			return nil, "", fmt.Errorf("%w: Verknüpfung ohne beide Eingänge", ErrNichtGefuehrt)
		}
		links, lv, err := l.bool(a)
		if err != nil {
			return nil, "", err
		}
		rechts, err := l.blatt(b)
		if err != nil {
			return nil, "", err
		}
		if lv != "" && lv != verk {
			return nil, "", fmt.Errorf("%w: und und oder gemischt", ErrNichtGefuehrt)
		}
		return append(links, *rechts), verk, nil
	}
	b, err := l.blatt(ref)
	if err != nil {
		return nil, "", err
	}
	return []Bedingung{*b}, "", nil
}

// Lies liest ein Flow-Dokument als Regel des Baukastens; ErrNichtGefuehrt, wo das Portal es
// in der Profi-Ansicht öffnen würde (parseGuidedFlow liefert dort null).
func Lies(roh []byte) (*Regel, error) {
	var d dokument
	if err := json.Unmarshal(roh, &d); err != nil {
		return nil, fmt.Errorf("%w: kein Flow-Dokument", ErrNichtGefuehrt)
	}
	l := &leser{byID: map[string]*knoten{}, edges: d.Edges, used: map[string]bool{}}
	for i := range d.Nodes {
		if d.Nodes[i].Parameters == nil {
			d.Nodes[i].Parameters = map[string]any{}
		}
		l.byID[d.Nodes[i].ID] = &d.Nodes[i]
	}
	var steuern, melden []*knoten
	for i := range d.Nodes {
		switch d.Nodes[i].Type {
		case "vp.entity.control":
			steuern = append(steuern, &d.Nodes[i])
		case "vp.notify.push":
			melden = append(melden, &d.Nodes[i])
		}
	}
	if len(steuern)+len(melden) != 1 {
		return nil, fmt.Errorf("%w: genau eine Tat", ErrNichtGefuehrt)
	}
	var tat Tat
	var boolRef *portRef
	if len(steuern) == 1 {
		s := steuern[0]
		l.used[s.ID] = true
		ttl := guidedTTL
		if v, ok := zahl(s.Parameters["ttl_s"]); ok {
			ttl = int(v)
		}
		tat = Tat{Entity: text(s.Parameters["entity_id"]), TTL: ttl}
		switch text(s.Parameters["command"]) {
		case "on_off":
			tat.Art = "onoff"
			boolRef = l.feeder(s.ID, "value")
		case "setpoint_kw":
			ifRef := l.feeder(s.ID, "setpoint")
			if ifRef == nil {
				return nil, fmt.Errorf("%w: Sollwert ohne Eingang", ErrNichtGefuehrt)
			}
			ifNode := l.byID[ifRef.Node]
			if ifNode == nil || ifNode.Type != "vp.logic.if" || ifRef.Port != "value" {
				return nil, fmt.Errorf("%w: Sollwert nicht aus Wenn/Dann", ErrNichtGefuehrt)
			}
			l.used[ifNode.ID] = true
			wert, ok := zahl(ifNode.Parameters["then_value"])
			if !ok {
				return nil, fmt.Errorf("%w: Sollwert ist keine Zahl", ErrNichtGefuehrt)
			}
			if _, sonst := ifNode.Parameters["else_value"]; sonst {
				// buildGuidedFlow schreibt nie einen Sonst-Wert; parseGuidedFlow übersieht ihn,
				// der Kern dürfte ihn nicht übersehen.
				return nil, fmt.Errorf("%w: Wenn/Dann mit Sonst-Wert", ErrNichtGefuehrt)
			}
			tat.Art, tat.Wert = "setpoint", wert
			boolRef = l.feeder(ifNode.ID, "condition")
		default:
			return nil, fmt.Errorf("%w: Befehl %s", ErrNichtGefuehrt, text(s.Parameters["command"]))
		}
	} else {
		m := melden[0]
		l.used[m.ID] = true
		gateRef := l.feeder(m.ID, "trigger")
		if gateRef == nil {
			return nil, fmt.Errorf("%w: Meldung ohne Auslöser", ErrNichtGefuehrt)
		}
		gate := l.byID[gateRef.Node]
		if gate == nil || gate.Type != "vp.logic.gate" || gateRef.Port != "dann" {
			return nil, fmt.Errorf("%w: Meldung nicht aus Wenn/Dann", ErrNichtGefuehrt)
		}
		l.used[gate.ID] = true
		tat = Tat{Art: "notify", Meldung: text(m.Parameters["message"])}
		boolRef = l.feeder(gate.ID, "wenn")
	}
	if boolRef == nil {
		return nil, fmt.Errorf("%w: die Tat hat keine Bedingung", ErrNichtGefuehrt)
	}
	bed, verk, err := l.bool(boolRef)
	if err != nil {
		return nil, err
	}
	if len(l.used) != len(d.Nodes) {
		return nil, fmt.Errorf("%w: weitere Bausteine im Flow", ErrNichtGefuehrt)
	}
	if verk == "" {
		verk = "and"
	}
	return &Regel{Bedingungen: bed, Verknuepfung: verk, Tat: tat}, nil
}
