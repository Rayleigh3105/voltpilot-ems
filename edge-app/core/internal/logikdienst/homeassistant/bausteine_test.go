package homeassistant

// Je Baustein von Home Assistant (Bericht 12.4) ein kleiner Fall: was daraus in der Logik
// wird, und dass der Kern das Ergebnis liest und die Prüfung nichts findet. Dazu je Grenze
// ein Fall, der mit Datei, Zeile und Grund in "nicht übersetzbar" landet.

import (
	"strings"
	"testing"
)

// pumpe schaltet switch.pumpe nach einer Bedingung ein und sonst aus (zwei Automationen):
// so hat jeder Fall ein Gerät mit einem Ausgang.
func pumpe(bedingung string) string {
	return `
- id: pumpe_an
  triggers:
    - trigger: time_pattern
      minutes: "/1"
  conditions:
    - ` + einruecken(bedingung, 6) + `
  actions:
    - action: switch.turn_on
      target:
        entity_id: switch.pumpe
- id: pumpe_aus
  triggers:
    - trigger: time_pattern
      minutes: "/1"
  conditions:
    - condition: not
      conditions:
        - ` + einruecken(bedingung, 10) + `
  actions:
    - action: switch.turn_off
      target:
        entity_id: switch.pumpe
`
}

func einruecken(s string, n int) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "\n", "\n"+strings.Repeat(" ", n))
}

type fall struct {
	konfiguration, automationen, skripte string
	zuordnung                            map[string]Zuordnung
}

func (f fall) dateien() []Datei {
	ds := []Datei{{Name: "configuration.yaml", Text: f.konfiguration}, {Name: "automations.yaml", Text: f.automationen}}
	if f.skripte != "" {
		ds = append(ds, Datei{Name: "scripts.yaml", Text: f.skripte})
	}
	return ds
}

// uebersetzt erwartet eine Logik, die der Kern liest und deren Prüfung nichts findet.
func uebersetzt(t *testing.T, f fall) *Ergebnis {
	t.Helper()
	e, err := Uebersetze(f.dateien(), f.zuordnung)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.NichtUebersetzt) > 0 || e.Text == "" {
		t.Fatalf("nicht übersetzbar: %+v", e.NichtUebersetzt)
	}
	L, _ := lies(t, e.Text)
	if b := L.Pruefe(nil); len(b.Befunde) > 0 {
		t.Fatalf("Befunde: %+v\n%s", b.Befunde, e.Text)
	}
	return e
}

func steht(t *testing.T, e *Ergebnis, teile ...string) {
	t.Helper()
	for _, s := range teile {
		if !strings.Contains(e.Text, s) {
			t.Errorf("fehlt im Text: %s\n%s", s, e.Text)
		}
	}
}

func hinweisMit(t *testing.T, e *Ergebnis, teil string) Hinweis {
	t.Helper()
	for _, h := range e.Hinweise {
		if strings.Contains(h.Text, teil) {
			return h
		}
	}
	t.Fatalf("kein Hinweis mit „%s“: %+v", teil, e.Hinweise)
	return Hinweis{}
}

// nichtUebersetzt erwartet keine Logik und eine Stelle mit diesem Grund an dieser Zeile.
func nichtUebersetzt(t *testing.T, f fall, datei string, zeile int, grund string) {
	t.Helper()
	e, err := Uebersetze(f.dateien(), f.zuordnung)
	if err != nil {
		t.Fatal(err)
	}
	if e.Text != "" {
		t.Errorf("eine Logik entstand, obwohl etwas nicht übersetzbar ist:\n%s", e.Text)
	}
	for _, s := range e.NichtUebersetzt {
		if s.Ort.Datei == datei && s.Ort.Zeile == zeile && strings.Contains(s.Grund, grund) {
			return
		}
	}
	t.Fatalf("erwartet %s:%d „%s“, bekommen %+v", datei, zeile, grund, e.NichtUebersetzt)
}

func TestInputBooleanOhneAutomationWirdStellwert(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: "input_boolean:\n  sommerbetrieb:\n    name: Sommerbetrieb\n",
		automationen:  pumpe("{condition: state, entity_id: input_boolean.sommerbetrieb, state: \"on\"}"),
	})
	steht(t, e, "sommerbetrieb: {name: Sommerbetrieb, type: boolean, default: off}", "pumpe: {on_off: sommerbetrieb}")
}

func TestInputNumberWirdStellwertMitEinheit(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: `input_number:
  grenze:
    name: Vorlauf mindestens
    initial: 45
    min: 30
    max: 60
    step: 0.5
    unit_of_measurement: "°C"
  reserve:
    name: Reserve
    min: 0
    max: 2000
    step: 50
    unit_of_measurement: W
`,
		automationen: pumpe(`"{{ states('sensor.vorlauf') | float(0) < states('input_number.grenze') | float(45) and states('sensor.netz') | float(0) < 0 - states('input_number.reserve') | float(0) }}"`),
	})
	steht(t, e,
		"grenze: {name: Vorlauf mindestens, default: 45 °C, range: [30 °C, 60 °C], step: 0.5 K}",
		// ohne initial merkt sich Home Assistant den Wert; die Vorgabe ist das Minimum
		"reserve: {name: Reserve, default: 0 W, range: [0 W, 2000 W], step: 50 W}",
		"pumpe: {on_off: vorlauf < grenze and netz < -reserve}")
	for _, l := range e.Luecken {
		switch l.Kennung {
		case "vorlauf":
			if l.Groesse != "temperatur" {
				t.Errorf("vorlauf: %+v", l)
			}
		case "netz":
			if l.Groesse != "leistung" {
				t.Errorf("netz: %+v", l)
			}
		}
	}
	hinweisMit(t, e, "Ohne Wert von „vorlauf“ rechnet Home Assistant hier mit 0")
}

func TestInputDatetimeUndZeitBedingung(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: `input_datetime:
  von:
    name: Von
    has_date: false
    has_time: true
    initial: "07:30:00"
  bis:
    name: Bis
    has_time: true
`,
		automationen: pumpe("{condition: time, after: input_datetime.von, before: input_datetime.bis}"),
	})
	steht(t, e, "von: {name: Von, default: '07:30'}", "bis: {name: Bis, default: '00:00'}", "pumpe: {on_off: 'time_window(von, bis)'}")
}

func TestInputSelectWirdAuswahl(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: "input_select:\n  betrieb:\n    name: Betrieb\n    options: [Normal, Sparen]\n    initial: Sparen\n",
		automationen:  pumpe("{condition: state, entity_id: input_select.betrieb, state: Sparen}"),
	})
	steht(t, e, "betrieb: {name: Betrieb, type: select, default: sparen, options: {normal_wahl: Normal, sparen: Sparen}}",
		"pumpe: {on_off: betrieb == sparen}")
}

func TestVorlagenSensorenWerdenFormelnEingaengeUndSchalter(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: `template:
  - sensor:
      - name: Anlage Puffer oben
        unique_id: anlage_puffer
        unit_of_measurement: "°C"
        state: "{{ states('sensor.modul_temperatur_2') }}"
        availability: "{{ states('sensor.modul_temperatur_2') | is_number }}"
      - name: Anlage Spreizung
        unit_of_measurement: K
        state: "{{ (states('sensor.anlage_puffer') | float(0) - states('sensor.ruecklauf') | float(0)) | round(1) }}"
  - binary_sensor:
      - name: Anlage Puffer warm
        state: >
          {% set an = this.state == 'on' %}
          {{ states('sensor.anlage_puffer') | float(0) > (50 if an else 53) }}
      - name: Anlage Spreizung gross
        state: "{{ states('sensor.anlage_spreizung') | float(0) > 5 }}"
`,
		automationen: pumpe("{condition: state, entity_id: [binary_sensor.anlage_puffer_warm, binary_sensor.anlage_spreizung_gross], state: \"on\"}"),
	})
	steht(t, e,
		// die Weitergabe wird der Eingang selbst, mit dem Namen des Sensors
		"anlage_puffer_oben: {source: quelle-anlage-puffer-oben.temperature, name: Anlage Puffer oben, max_age: 5 min}",
		// Temperatur minus Temperatur ist ein Abstand, die Zahl daneben deshalb K
		"anlage_spreizung: anlage_puffer_oben - ruecklauf", "anlage_spreizung_gross: anlage_spreizung > 5 K",
		// der Binärsensor mit eigenem Wert merkt sich etwas
		"on_when: known(anlage_puffer_oben) and anlage_puffer_oben > 53 °C",
		"off_when: not (known(anlage_puffer_oben) and anlage_puffer_oben > 50 °C)",
		"pumpe: {on_off: anlage_puffer_warm and anlage_spreizung_gross}")
	hinweisMit(t, e, "rundet hier")
}

func TestStatustextWirdLage(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: `template:
  - sensor:
      - name: Anlage Status
        state: >
          {% if is_state('switch.pumpe', 'on') %}Pumpe läuft
          {%- elif states('sensor.vorlauf') | float(-1) < 0 %}Fühler gestört
          {%- else %}Bereit{% endif %}
`,
		automationen: pumpe(`"{{ states('sensor.vorlauf') | float(0) < 40 }}"`),
	})
	steht(t, e, "- when: pumpe.on\n    title: Pumpe läuft\n    type: waiting",
		"- when: unknown(vorlauf) or vorlauf < 0 °C\n    title: Fühler gestört\n    type: fault",
		"- else: true\n    title: Bereit")
}

func TestZaehlerSchritteZeitgeberUndNeustart(t *testing.T) {
	e := uebersetzt(t, fall{
		zuordnung: map[string]Zuordnung{"netz": {Wert: "site.grid"}},
		konfiguration: `input_number:
  stufe:
    name: Stufe
    initial: 0
    min: 0
    max: 2
    step: 1
timer:
  pause:
    name: Pause
    duration: "00:10:00"
sensor:
  - platform: history_stats
    name: Stab L1 heute
    entity_id: switch.stab_l1
    state: "on"
    type: time
    start: "{{ today_at('00:00') }}"
    end: "{{ now() }}"
  - platform: history_stats
    name: Stab L2 heute
    entity_id: switch.stab_l2
    state: "on"
    type: time
    start: "{{ today_at('00:00') }}"
    end: "{{ now() }}"
`,
		automationen: `
- id: stufe_rauf
  alias: Stufe rauf
  triggers:
    - trigger: numeric_state
      entity_id: sensor.netz
      below: -500
      for: "00:01:00"
  conditions:
    - condition: numeric_state
      entity_id: sensor.netz
      below: -500
    - condition: state
      entity_id: timer.pause
      state: idle
  actions:
    - action: input_number.increment
      target: {entity_id: input_number.stufe}
- id: stufe_runter
  alias: Stufe runter
  triggers:
    - trigger: time_pattern
      minutes: "/1"
  conditions:
    - "{{ states('sensor.netz') | float(0) > 200 }}"
    - "{{ (now() - states.input_number.stufe.last_changed).total_seconds() > 120 }}"
  actions:
    - action: input_number.decrement
      target: {entity_id: input_number.stufe}
    - action: timer.start
      target: {entity_id: timer.pause}
- id: setzen
  triggers:
    - trigger: state
      entity_id: input_number.stufe
    - trigger: time_pattern
      minutes: "/5"
  actions:
    - action: script.setzen
- id: start
  triggers:
    - trigger: homeassistant
      event: start
  actions:
    - action: input_number.set_value
      target: {entity_id: input_number.stufe}
      data: {value: 0}
`,
		skripte: `setzen:
  sequence:
    - variables:
        stunden: "{{ states('sensor.stab_l1_heute') | float(0) + states('sensor.stab_l2_heute') | float(0) }}"
        stufe: "{{ states('input_number.stufe') | int(0) if stunden < 6 else 0 }}"
    - action: switch.turn_on
      target:
        entity_id: >
          {% set ns = namespace(an=[]) %}
          {% for i in range(1, 3) %}{% if i <= stufe %}{% set ns.an = ns.an + ['switch.stab_l' ~ i] %}{% endif %}{% endfor %}
          {{ ns.an }}
    - action: switch.turn_off
      target:
        entity_id: >
          {% set ns = namespace(aus=[]) %}
          {% for i in range(1, 3) %}{% if not i <= stufe %}{% set ns.aus = ns.aus + ['switch.stab_l' ~ i] %}{% endif %}{% endfor %}
          {{ ns.aus }}
`,
	})
	steht(t, e,
		"stufe:   # input_number.stufe", "after_restart: 0",
		// numeric_state mit for: wird holds(), die Bedingung daneben ist dieselbe
		"- name: stufe_runter   # automations.yaml:19\n        by: -1\n        not_before: 3 min\n        when:\n          - known(netz)\n          - netz > 200 W\n        then: start(pause)",
		"- name: stufe_rauf   # automations.yaml:2\n        by: +1\n        when:\n          - holds(netz < -500 W, 1 min)\n          - not running(pause)",
		"pause:   # timer.pause", "duration: 10 min",
		"stab: {level: 'if(stab.output_hours_today < 6 h, stufe, 0)'}")
	hinweisMit(t, e, "„mehr als 2 min seit dem letzten Wechsel“ ist so erst nach 3 min erfüllt")
	hinweisMit(t, e, "Home Assistant setzt die Schalter nur, wenn")
}

func TestSchalterVonZweiAutomationenWirdZustand(t *testing.T) {
	e := uebersetzt(t, fall{
		konfiguration: "",
		automationen: `
- id: pumpe_an
  triggers: [{trigger: numeric_state, entity_id: sensor.puffer, below: 40}]
  actions: [{action: switch.turn_on, target: {entity_id: switch.pumpe}}]
- id: pumpe_aus
  triggers: [{trigger: numeric_state, entity_id: sensor.puffer, above: 45}]
  actions: [{action: switch.turn_off, target: {entity_id: switch.pumpe}}]
`,
	})
	steht(t, e, "pumpe_an:   # automations.yaml:4", "on_when_any: puffer < 40 °C", "off_when_any: puffer > 45 °C", "after_restart: keep", "pumpe: {on_off: pumpe_an}")
	_ = e
}

func TestVorzeichenSchalterEntfaelltUndZuordnungDrehtDasVorzeichen(t *testing.T) {
	f := fall{
		konfiguration: `input_boolean:
  gedreht:
    name: Zähler gedreht
template:
  - sensor:
      - name: Anlage Einspeisung
        unit_of_measurement: W
        state: >
          {% set p = states('sensor.zaehler') | float(0) %}
          {% if is_state('input_boolean.gedreht', 'on') %}{{ p }}{% else %}{{ 0 - p }}{% endif %}
`,
		automationen: pumpe(`"{{ states('sensor.anlage_einspeisung') | float(0) > 1000 }}"`),
	}
	e := uebersetzt(t, f)
	steht(t, e, "anlage_einspeisung: '-zaehler'", "pumpe: {on_off: anlage_einspeisung > 1000 W}")
	if strings.Contains(e.Text, "gedreht:") {
		t.Errorf("der Vorzeichen-Schalter ist noch da:\n%s", e.Text)
	}
	h := hinweisMit(t, e, "drehte in Home Assistant das Vorzeichen von zaehler")
	if h.Stelle != "inputs.zaehler" {
		t.Errorf("Hinweis an %q", h.Stelle)
	}
	f.zuordnung = map[string]Zuordnung{"zaehler": {Wert: "-site.grid", Name: "Netzpunkt"}}
	e = uebersetzt(t, f)
	steht(t, e, "zaehler: {source: site.grid, name: Netzpunkt, max_age: 60 s}", "anlage_einspeisung: zaehler   #")
}

func TestErsatzwerteVonHomeAssistant(t *testing.T) {
	e := uebersetzt(t, fall{
		automationen: pumpe(`"{{ states('sensor.puffer') | float(-1) >= 0 and states('sensor.puffer') | float(-1) < states('sensor.vorlauf') | float(0) }}"`),
	})
	// gegen eine feste Zahl steht fest, wie der Vergleich ohne Wert ausgeht
	steht(t, e, "known(puffer) and puffer >= 0 °C and puffer < vorlauf")
	for _, h := range e.Hinweise {
		if strings.Contains(h.Text, "„puffer“") {
			t.Errorf("known(puffer) daneben macht den Hinweis überflüssig: %s", h.Text)
		}
	}
	hinweisMit(t, e, "Ohne Wert von „vorlauf“ rechnet Home Assistant hier mit 0")
}

func TestZuordnungPrueftDieGroesse(t *testing.T) {
	// Die Dateien sagen nichts über die Größe: die Zuordnung entscheidet, die Zahl daneben folgt.
	f := fall{automationen: pumpe(`"{{ states('sensor.puffer') | float(0) < 40 }}"`)}
	e := uebersetzt(t, f)
	if l := e.Luecken[1]; l.Groesse != "temperatur" || !l.Geschaetzt {
		t.Fatalf("%+v", l)
	}
	f.zuordnung = map[string]Zuordnung{"puffer": {Wert: "battery.soc"}}
	e = uebersetzt(t, f)
	steht(t, e, "puffer: {source: battery.soc", "pumpe: {on_off: unknown(puffer) or puffer < 40 %}")
	// Die Dateien nennen die Größe: eine Quelle einer anderen Größe passt nicht.
	f = fall{konfiguration: "input_number:\n  grenze:\n    min: 30\n    max: 60\n    unit_of_measurement: \"°C\"\n",
		automationen: pumpe("{condition: numeric_state, entity_id: sensor.puffer, below: input_number.grenze}")}
	f.zuordnung = map[string]Zuordnung{"puffer": {Wert: "battery.soc"}}
	e = uebersetzt(t, f)
	if l := e.Luecken[1]; l.Kennung != "puffer" || l.Fehler == "" || l.Wert != "battery.soc" {
		t.Fatalf("%+v", e.Luecken)
	}
	steht(t, e, "source: quelle-puffer.temperature")
	f.zuordnung = map[string]Zuordnung{"puffer": {Wert: "-fuehler-1.temperature"}, "pumpe": {Wert: "pumpe-keller", Name: "Pumpe Keller"}}
	e = uebersetzt(t, f)
	if !strings.Contains(e.Luecken[1].Fehler, "Vorzeichen") {
		t.Fatalf("%+v", e.Luecken)
	}
	steht(t, e, "pumpe: {entity: pumpe-keller, name: Pumpe Keller}")
}

func TestNichtUebersetzbar(t *testing.T) {
	t.Run("Warten in einer Aktion", func(t *testing.T) {
		nichtUebersetzt(t, fall{automationen: `
- id: kurz
  triggers: [{trigger: time_pattern, minutes: "/1"}]
  actions:
    - action: switch.turn_on
      target: {entity_id: switch.pumpe}
    - delay: "00:05:00"
`}, "automations.yaml", 7, "Abläufe mit Warten")
	})
	t.Run("Wochentag", func(t *testing.T) {
		nichtUebersetzt(t, fall{automationen: pumpe("{condition: time, weekday: [mon, tue]}")}, "automations.yaml", 7, "Wochentage")
	})
	t.Run("Sonne als Bedingung", func(t *testing.T) {
		nichtUebersetzt(t, fall{automationen: pumpe("{condition: sun, after: sunrise}")}, "automations.yaml", 7, "„sun“")
	})
	t.Run("unbekannte Funktion", func(t *testing.T) {
		nichtUebersetzt(t, fall{automationen: pumpe(`"{{ as_timestamp(now()) > 0 }}"`)}, "automations.yaml", 7, "as_timestamp")
	})
	t.Run("Makro", func(t *testing.T) {
		nichtUebersetzt(t, fall{automationen: pumpe(`"{% macro x() %}1{% endmacro %}{{ x() > 0 }}"`)}, "automations.yaml", 7, "macro")
	})
	t.Run("ein einzelner Ausgang", func(t *testing.T) {
		f := fall{automationen: `
- id: stufe
  triggers: [{trigger: time_pattern, minutes: "/1"}]
  actions:
    - action: switch.turn_on
      target: {entity_id: "{{ ['switch.stab_l1', 'switch.stab_l2'] if is_state('switch.stab_l1', 'on') else ['switch.stab_l1'] }}"}
`}
		e, _ := Uebersetze(f.dateien(), nil)
		if e.Text != "" || len(e.NichtUebersetzt) == 0 {
			t.Fatalf("%+v", e)
		}
	})
	t.Run("Zeitgeber anhalten", func(t *testing.T) {
		nichtUebersetzt(t, fall{konfiguration: "timer:\n  t:\n    duration: 60\n", automationen: pumpe("{condition: state, entity_id: timer.t, state: active}") + `
- id: anhalten
  triggers: [{trigger: time_pattern, minutes: "/1"}]
  actions: [{action: timer.cancel, target: {entity_id: timer.t}}]
`}, "automations.yaml", 27, "anhalten")
	})
}

func TestDashboardWirdNichtUebernommen(t *testing.T) {
	e, err := Uebersetze([]Datei{
		{Name: "automations.yaml", Text: pumpe(`"{{ states('sensor.puffer') | float(0) < 40 }}"`)},
		{Name: "dashboard.yaml", Text: "views:\n  - title: Heizung\n"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e.Text == "" || len(e.NichtUebernommen) != 1 || e.NichtUebernommen[0].Ort.Datei != "dashboard.yaml" {
		t.Fatalf("%+v", e)
	}
}
