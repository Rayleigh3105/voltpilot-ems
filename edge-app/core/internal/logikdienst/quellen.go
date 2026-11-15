package logikdienst

// Was eine Logik an einer Anlage lesen und schalten kann (Stufe 4, Ansicht
// "Aufbau" im Portal): die Auswahl für Eingänge und Geräte. Gerechnet aus dem
// Registry-Push der Anlage mit denselben Regeln, mit denen die Box liest
// (agent.logikQuelle: feste Quellen, die Temperatur eines Fühlers, die Signale
// eines eigenen Modbus-Geräts) und schaltet (SchaltRecht, agent.logikBefehl).
// Das Portal bildet diese Regeln nicht nach.

import (
	"encoding/json"
	"sort"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusgeraet"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

// Quelle ist ein Eingang, den eine Logik lesen kann.
type Quelle struct {
	Source   string `json:"source"`
	Name     string `json:"name"`
	EntityID string `json:"entity_id,omitempty"`
	Signal   string `json:"signal,omitempty"`
	// Einheit des Werts: °C, %, kW, °, ct/kWh (eine Zahl ohne Einheit) oder ja_nein.
	Einheit string `json:"einheit"`
}

// Schaltbar ist ein Gerät, das eine Logik schalten kann, mit den Ausgängen, die die
// Box an ihm ausführt (level, on_off, setpoint, mode).
type Schaltbar struct {
	EntityID  string   `json:"entity_id"`
	Name      string   `json:"name"`
	Typ       string   `json:"typ"`
	Ausgaenge []string `json:"ausgaenge"`
	// Ausgangszahl und kW je Ausgang einer Ausgangsmenge (Stufe 0 bis n).
	Ausgangszahl int      `json:"ausgangszahl,omitempty"`
	KwJeAusgang  *float64 `json:"kw_je_ausgang,omitempty"`
	// Sollwert: Einheit (°C oder kW), Band und Schritt, soweit das Gerät sie nennt.
	Sollwert      *Sollwert `json:"sollwert,omitempty"`
	Betriebsarten []string  `json:"betriebsarten,omitempty"`
}

// Sollwert beschreibt den Sollwert eines Geräts, das selbst regelt.
type Sollwert struct {
	Einheit string   `json:"einheit"`
	Von     *float64 `json:"von,omitempty"`
	Bis     *float64 `json:"bis,omitempty"`
	Schritt *float64 `json:"schritt,omitempty"`
}

// Bestand ist alles, was eine Logik an der Anlage lesen und schalten kann.
type Bestand struct {
	Quellen []Quelle    `json:"quellen"`
	Geraete []Schaltbar `json:"geraete"`
}

// FesteQuellen liest die Box an jeder Anlage (Wortliste, Tabelle quelle_fest).
var FesteQuellen = []Quelle{
	{Source: "site.grid", Name: "Netzbezug", Einheit: "kW"},
	{Source: "site.pv", Name: "PV-Leistung", Einheit: "kW"},
	{Source: "battery.power", Name: "Batterie lädt mit", Einheit: "kW"},
	{Source: "battery.soc", Name: "Ladestand der Batterie", Einheit: "%"},
	{Source: "sun.elevation", Name: "Sonnenstand", Einheit: "°"},
	{Source: "price.current", Name: "Börsenpreis", Einheit: "ct/kWh"},
}

// signalNamen sind die Wörter der Signale für Menschen.
var signalNamen = map[string]string{
	"temperature": "Temperatur", "room_temperature": "Raumtemperatur", "open": "offen", "door_open": "Tür offen",
	"defrost": "Abtauung", "fault": "Störung", "running": "läuft", "humidity": "Luftfeuchte",
	"outdoor_temperature": "Außentemperatur", "supply_temperature": "Vorlauf", "return_temperature": "Rücklauf",
}

func signalEinheit(signal string) string {
	switch {
	case modbusgeraet.BoolSignals[signal]:
		return "ja_nein"
	case signal == "humidity":
		return "%"
	}
	return "°C"
}

// Quellen nennt, was eine Logik an der Anlage dieses Registry-Pushs lesen und schalten kann.
func Quellen(registry json.RawMessage) Bestand {
	b := Bestand{Quellen: append([]Quelle(nil), FesteQuellen...), Geraete: []Schaltbar{}}
	var reg entities.Registry
	if len(registry) == 0 || json.Unmarshal(registry, &reg) != nil {
		return b
	}
	for _, e := range reg.Entities {
		name := e.Label
		if name == "" {
			name = e.ID
		}
		// Lesen: die Temperatur eines Fühlers (genau ein Fühler je Gerät), die Signale
		// eines eigenen Modbus-Geräts, das der Core führt.
		if e.Type == "fuehler" {
			b.Quellen = append(b.Quellen, Quelle{Source: e.ID + ".temperature", Name: name, EntityID: e.ID,
				Signal: "temperature", Einheit: "°C"})
		}
		if def, _, _, ok := modbusgeraet.AusEntity(e); ok {
			for _, c := range def.Channels {
				if c.Signal == "" {
					continue
				}
				b.Quellen = append(b.Quellen, Quelle{Source: e.ID + "." + c.Signal, Name: name + " · " + signalNamen[c.Signal],
					EntityID: e.ID, Signal: c.Signal, Einheit: signalEinheit(c.Signal)})
			}
		}
		if g, ok := schaltbar(e, name); ok {
			b.Geraete = append(b.Geraete, g)
		}
	}
	sort.SliceStable(b.Geraete, func(i, j int) bool { return b.Geraete[i].Name < b.Geraete[j].Name })
	return b
}

// schaltbar sagt, welche Ausgänge einer Logik die Box an einem Gerät ausführt - die
// Umkehrung von SchaltRecht: eine Stufe an einer Shelly-Ausgangsmenge (setpoint_kw),
// Ein/Aus (on_off), ein Sollwert in °C (setpoint_c) oder kW (setpoint_kw, kein
// Shelly), eine Betriebsart (mode; an einer SG-Ready-Wärmepumpe ohne eigene
// Betriebsart der Kontakt, E10 = A). Einen Anteil führt die Box nicht aus.
func schaltbar(e entities.Entity, name string) (Schaltbar, bool) {
	g := Schaltbar{EntityID: e.ID, Name: name, Typ: e.Type, Ausgaenge: []string{}}
	cfg, isShelly := shelly.ParseDriver(e.Driver)
	gruppe := isShelly && cfg.IsGroup()
	set := map[string]bool{}
	for _, c := range e.Capabilities.Actuate {
		switch c.Command {
		case entities.CmdSetpointKw:
			if gruppe {
				set["level"] = true
				g.Ausgangszahl, g.KwJeAusgang = cfg.OutputFacts()
			} else {
				set["setpoint"] = true
				g.Sollwert = &Sollwert{Einheit: "kW", Von: c.Min, Bis: c.Max, Schritt: c.Step}
			}
		case entities.CmdOnOff:
			set["on_off"] = true
		case entities.CmdSetpointC:
			set["setpoint"] = true
			g.Sollwert = &Sollwert{Einheit: "°C", Von: c.Min, Bis: c.Max, Schritt: c.Step}
		case entities.CmdMode:
			set["mode"] = true
			g.Betriebsarten = append([]string(nil), c.Modes...)
		}
	}
	if sgReadyKontakt(e) && set["on_off"] {
		set["mode"] = true
		g.Betriebsarten = []string{"normal", "boost"}
	}
	for _, art := range []string{"level", "on_off", "setpoint", "mode"} {
		if set[art] {
			g.Ausgaenge = append(g.Ausgaenge, art)
		}
	}
	return g, len(g.Ausgaenge) > 0
}
