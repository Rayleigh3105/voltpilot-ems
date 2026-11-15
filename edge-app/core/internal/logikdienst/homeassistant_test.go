package logikdienst

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/homeassistant"
)

// Die Anlage der Test-Anlage des Übersetzers: drei Heizstäbe an Ausgangsmengen mit drei
// Ausgängen und drei Fühler.
func haRegistry() json.RawMessage {
	stab := func(id, name string, kw float64) string {
		return `{"entity_id":"` + id + `","entity_type":"heating-rod","label":"` + name + `","capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_kw"}]},` +
			`"guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",` +
			`"connection":{"ip":"192.168.1.20","port":80,"channels":[0,1,2],"output_kw":[` + strings.Repeat(jsonZahl(kw)+",", 2) + jsonZahl(kw) + `],"stages":[1,2,3]}}}`
	}
	fuehler := func(id, name string) string {
		return `{"entity_id":"` + id + `","entity_type":"fuehler","label":"` + name + `","capabilities":{},"guards":{}}`
	}
	return json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` + strings.Join([]string{
		stab("stab-1", "Durchlauferhitzer Speicher 1", 3), stab("stab-2", "Heizstab Speicher 2", 1.5), stab("stab-3", "Heizstab Speicher 3", 1.5),
		fuehler("f-1", "Fühler Speicher 1 oben"), fuehler("f-2", "Speicher 2 oben"), fuehler("f-3", "Speicher 3 oben"),
	}, ",") + `]}`)
}

func jsonZahl(v float64) string { b, _ := json.Marshal(v); return string(b) }

func haDateien(t *testing.T) []homeassistant.Datei {
	t.Helper()
	var ds []homeassistant.Datei
	for _, n := range []string{"configuration.yaml", "automations.yaml", "scripts.yaml"} {
		b, err := os.ReadFile(filepath.Join("homeassistant/testdata/solarheizung", n))
		if err != nil {
			t.Fatal(err)
		}
		ds = append(ds, homeassistant.Datei{Name: "/home/ha/config/" + n, Text: string(b)})
	}
	return ds
}

func luecke(t *testing.T, e *HAErgebnis, kennung string) HALuecke {
	t.Helper()
	for _, l := range e.Luecken {
		if l.Kennung == kennung {
			return l
		}
	}
	t.Fatalf("keine Lücke %s: %+v", kennung, e.Luecken)
	return HALuecke{}
}

// Ohne Zuordnung schlägt der Dienst Geräte und Fühler vor, die Leistungen nicht: deren
// Vorzeichen wählt der Mensch. Mit ihnen ist die Logik vollständig und besteht die Prüfung.
func TestHomeAssistantVorschlagUndZuordnung(t *testing.T) {
	e, err := UebersetzeHA(HAAuftrag{Dateien: haDateien(t), Registry: haRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	if len(e.NichtUebersetzt) > 0 || e.Text == "" || e.Vollstaendig {
		t.Fatalf("erwartet eine Logik mit offenen Leistungen: %+v", e)
	}
	if strings.Join(e.Dateien, ",") != "configuration.yaml,automations.yaml,scripts.yaml" {
		t.Errorf("Dateinamen ohne Pfad: %v", e.Dateien)
	}
	for kennung, soll := range map[string]string{"durchlauferhitzer": "stab-1", "speicher_2": "stab-2", "speicher_3": "stab-3",
		"fuehler_speicher_1_oben": "f-1.temperature", "speicher_2_oben": "f-2.temperature", "speicher_3_oben": "f-3.temperature",
		"wr_ladestand": "battery.soc"} {
		l := luecke(t, e, kennung)
		if l.Wert != soll || !l.Vorgeschlagen || l.WertText == "" {
			t.Errorf("%s: %+v, erwartet %s", kennung, l, soll)
		}
	}
	netz := luecke(t, e, "wr_netzleistung")
	if netz.Wert != "" || netz.Groesse != "leistung" || len(netz.Kandidaten) != 5 || netz.Kandidaten[1].Wert != "-site.grid" {
		t.Errorf("Netz: %+v", netz)
	}
	stab := luecke(t, e, "durchlauferhitzer")
	if len(stab.Kandidaten) != 3 || stab.Kandidaten[0].Wert != "stab-1" || stab.Ausgaenge != 3 || stab.Ausgang != "level" {
		t.Errorf("Gerät: %+v", stab)
	}
	if e.Bericht == nil || len(e.Bericht.Befunde) > 0 {
		t.Fatalf("Bericht: %+v", e.Bericht)
	}
	// Die Hinweise stehen an ihrer Zeile im übersetzten Text.
	zeilen := strings.Split(e.Text, "\n")
	gefunden := false
	for _, h := range e.Hinweise {
		if h.Stelle == "states.heizstufe.stufe_rauf" {
			gefunden = true
			if h.Zeile == 0 || !strings.Contains(zeilen[h.Zeile-1], "name: stufe_rauf") {
				t.Errorf("Hinweis an Zeile %d: %q", h.Zeile, zeilen[max(h.Zeile-1, 0)])
			}
		}
	}
	if !gefunden {
		t.Errorf("kein Hinweis am Schritt stufe_rauf: %+v", e.Hinweise)
	}

	e, err = UebersetzeHA(HAAuftrag{Dateien: haDateien(t), Registry: haRegistry(), Zuordnung: map[string]homeassistant.Zuordnung{
		"wr_netzleistung": {Wert: "site.grid"}, "wr_akkuleistung": {Wert: "-battery.power"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !e.Vollstaendig || e.Bericht.Sperrt {
		t.Fatalf("erwartet vollständig: %+v", e.Luecken)
	}
	for _, s := range []string{"durchlauferhitzer: {entity: stab-1, name: Durchlauferhitzer Speicher 1}",
		"wr_akkuleistung: {source: battery.power, name: Batterie lädt mit, max_age: 60 s}",
		"akkuleistung: '-wr_akkuleistung'"} {
		if !strings.Contains(e.Text, s) {
			t.Errorf("fehlt: %s\n%s", s, e.Text)
		}
	}
	// Das Ergebnis ist ein gewöhnlicher Text: der Dienst baut sein Artefakt.
	if _, _, err := Artefakt(Auftrag{Text: e.Text, Registry: haRegistry(), FlowID: "5b8d2e40-1c7a-4f3e-9d21-6a0b4c8e2f18", FlowVersion: 1}); err != nil {
		t.Fatalf("Artefakt: %v", err)
	}
}

// Was nicht übersetzbar ist, kommt mit Datei und Zeile; eine Logik entsteht dann nicht.
func TestHomeAssistantNichtUebersetzbar(t *testing.T) {
	e, err := UebersetzeHA(HAAuftrag{Dateien: []homeassistant.Datei{{Name: "automations.yaml", Text: `
- id: kurz
  triggers: [{trigger: time_pattern, minutes: "/1"}]
  actions:
    - action: switch.turn_on
      target: {entity_id: switch.pumpe}
    - delay: 5
`}}})
	if err != nil {
		t.Fatal(err)
	}
	if e.Text != "" || e.Vollstaendig || len(e.NichtUebersetzt) != 1 || e.NichtUebersetzt[0].Ort.Zeile != 7 || e.Bericht != nil {
		t.Fatalf("%+v", e)
	}
	if _, err := UebersetzeHA(HAAuftrag{Dateien: []homeassistant.Datei{{Name: "a.yaml", Text: "a: [b"}}}); err == nil ||
		!strings.Contains(err.Error(), "a.yaml ist kein lesbares YAML") {
		t.Fatalf("erwartet unlesbar: %v", err)
	}
	if _, err := UebersetzeHA(HAAuftrag{}); err == nil {
		t.Fatal("ohne Dateien")
	}
}
