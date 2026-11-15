package logikdienst

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Die Bausteine von VoltPilot (Stufe 5, E4 = A) und ihre Vektoren:
// docs/contracts/v2/steuerlogik/bausteine/*.block.yaml und steuerlogik-baustein-vectors.json.
const bausteinOrdner = "../../../../docs/contracts/v2/steuerlogik/bausteine"
const bausteinVektoren = "../../../../docs/contracts/v2/steuerlogik-baustein-vectors.json"

// testAnlage ist eine Anlage mit allem, was die Bausteine schalten und lesen: zwei Heizstäbe
// an Ausgangsmengen, ein Relais, zwei Fühler, eine SG-Ready-Wärmepumpe, ein Kühlstellenregler
// und ein Klimagerät als eigene Modbus-Geräte.
func testAnlage(t *testing.T) json.RawMessage {
	t.Helper()
	klima, err := os.ReadFile("../../../../docs/contracts/v2/examples/edge-entity.valid.config-modbus-geraet.json")
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` +
		heizstab("stab-ww", "Heizstab Warmwasser", "192.168.1.20") + `,` +
		heizstab("stab-puffer", "Heizstab Puffer", "192.168.1.21") + `,` +
		`{"entity_id":"relais-pumpe","entity_type":"switchable-load","label":"Poolpumpe","capabilities":{"actuate":[{"command":"on_off"}]},"guards":{}},` +
		`{"entity_id":"fuehler-ww","entity_type":"fuehler","label":"Warmwasser oben","capabilities":{},"guards":{}},` +
		`{"entity_id":"fuehler-puffer","entity_type":"fuehler","label":"Puffer oben","capabilities":{},"guards":{}},` +
		`{"entity_id":"wp-1","entity_type":"heat-pump-sgready","label":"Wärmepumpe","capabilities":{"actuate":[{"command":"on_off"}]},"guards":{}},` +
		kuehlstelle + `,` + string(klima) + `]}`)
}

func heizstab(id, name, ip string) string {
	return `{"entity_id":"` + id + `","entity_type":"heating-rod","label":"` + name + `","capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_kw"}]},` +
		`"guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",` +
		`"connection":{"ip":"` + ip + `","port":80,"channels":[0,1,2],"output_kw":[2,2,2],"stages":[1,2,3]}}}`
}

// kuehlstelle ist ein Kühlstellenregler als eigenes Modbus-Gerät: Raumtemperatur, Tür, Abtauung
// lesen, den Sollwert in °C schreiben (Band 0 bis 8 °C).
const kuehlstelle = `{"schema_version":"1.0","entity_id":"kuehl-1","entity_type":"modbus-device","label":"Kühlraum",
 "capabilities":{"measure":[{"channel":"raum","unit":"°C","label":"Raum"}],
  "actuate":[{"command":"setpoint_c","min":0,"max":8,"step":0.5,"rest":4}]},
 "guards":{"limits":{"min_change_interval_s":60},"failsafe":{"behavior":"rest"}},
 "driver":{"communication":"modbus_baukasten","connection":{"schema_version":"1.0",
  "transport":{"host":"192.168.10.60","port":502,"unit_id":1},
  "channels":[
   {"slug":"raum","label":"Raum","unit":"°C","signal":"room_temperature","register":{"kind":"input","address":0,"data_type":"s16"},"scale":0.1,"offset":0},
   {"slug":"tuer","label":"Tür","unit":"","signal":"door_open","register":{"kind":"discrete","address":1}},
   {"slug":"abtau","label":"Abtauung","unit":"","signal":"defrost","register":{"kind":"discrete","address":2}}],
  "controls":{"min_change_interval_s":60,"values":[
   {"slug":"soll","label":"Sollwert","kind":"setpoint_c","register":{"kind":"holding","address":10,"data_type":"s16"},
    "scale":0.1,"offset":0,"min":0,"max":8,"step":0.5,"rest":4}],
   "freigabe":{"released_at":"2026-11-14T10:00:00Z","released_by":"installer","evidence":"Test bestanden"}}}},
 "revision":"2026-11-14T10:00:00Z"}`

func bausteinDateien(t *testing.T) map[string][]byte {
	t.Helper()
	pfade, err := filepath.Glob(filepath.Join(bausteinOrdner, "*.block.yaml"))
	if err != nil || len(pfade) == 0 {
		t.Fatalf("keine Bausteine unter %s: %v", bausteinOrdner, err)
	}
	out := map[string][]byte{}
	for _, p := range pfade {
		roh, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[strings.TrimSuffix(filepath.Base(p), ".block.yaml")] = roh
	}
	return out
}

func sortierteSchluessel[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Jeder Baustein lässt sich an der Testanlage einsetzen, ohne eine Füllung: die Vorschläge
// passen, die Prüfung sperrt nicht, jede Probe besteht, und kein Platzhalter bleibt im Text.
func TestBausteineEinsetzenMitVorschlag(t *testing.T) {
	reg := testAnlage(t)
	dateien := bausteinDateien(t)
	if n := len(dateien); n < 5 || n > 7 {
		t.Errorf("%d Bausteine; der Start sind fünf bis sieben", n)
	}
	for _, id := range sortierteSchluessel(dateien) {
		e, err := Einsetzen(dateien[id], Fuellung{}, reg)
		if err != nil {
			t.Errorf("%s: %v", id, err)
			continue
		}
		if !e.Vollstaendig {
			t.Errorf("%s: nicht vollständig: %+v", id, e.Luecken)
		}
		pruefeEingesetzt(t, id, e)
		if strings.Contains(e.Text, "geraet-") || strings.Contains(e.Text, "quelle-") {
			t.Errorf("%s: ein Platzhalter blieb im Text:\n%s", id, e.Text)
		}
	}
}

func pruefeEingesetzt(t *testing.T, wo string, e *Eingesetzt) {
	t.Helper()
	if e.Bericht == nil {
		t.Errorf("%s: ohne Bericht", wo)
		return
	}
	if e.Bericht.Sperrt {
		t.Errorf("%s: die Prüfung sperrt: %+v", wo, e.Bericht.Meldungen)
	}
	if len(e.Verhalten) < 4 {
		t.Errorf("%s: %d Proben; ein Baustein zeigt mindestens vier Fälle", wo, len(e.Verhalten))
	}
	for _, p := range e.Verhalten {
		if !p.Besteht {
			t.Errorf("%s: Probe „%s“ besteht nicht: %+v", wo, p.Name, p.Abweichungen)
		}
		if p.Lage == nil || p.Lage.Satz == "" {
			t.Errorf("%s: Probe „%s“ ohne Lage", wo, p.Name)
		}
	}
	for i := 1; i < len(e.Verhalten); i++ {
		if e.Verhalten[i].Uhr < e.Verhalten[i-1].Uhr {
			t.Errorf("%s: das Verhalten ist nicht nach der Uhrzeit geordnet", wo)
		}
	}
}

// Die Proben eines Bausteins gelten für jeden Wert, den der Satz anbietet: jeder Stellwert der
// Lücken einzeln auf seinem kleinsten und größten Wert (die anderen auf der Vorgabe). Eine
// Bedingung zwischen Stellwerten darf dabei sperren - die Oberfläche lässt dann nur passende
// Werte zu -, eine Probe nie.
func TestBausteinProbenGeltenImGanzenBereich(t *testing.T) {
	reg := testAnlage(t)
	dateien := bausteinDateien(t)
	for _, id := range sortierteSchluessel(dateien) {
		b, err := LiesBaustein(dateien[id])
		if err != nil {
			t.Errorf("%s: %v", id, err)
			continue
		}
		for _, l := range b.Luecken {
			if l.Art != LueckeStellwert || l.Stellwert.Art != "zahl" || l.Stellwert.Von == nil {
				continue
			}
			for _, v := range []float64{*l.Stellwert.Von, *l.Stellwert.Bis} {
				wert := fmt.Sprintf("%s %s", strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", v), "0"), "."), l.Stellwert.Einheit)
				roh, _ := json.Marshal(wert)
				e, err := Einsetzen(dateien[id], Fuellung{Werte: map[string]json.RawMessage{l.Kennung: roh}}, reg)
				if err != nil {
					t.Errorf("%s %s=%s: %v", id, l.Kennung, wert, err)
					continue
				}
				for _, p := range e.Verhalten {
					if !p.Besteht {
						t.Errorf("%s %s=%s: Probe „%s“ besteht nicht: %+v", id, l.Kennung, wert, p.Name, p.Abweichungen)
					}
				}
				for _, m := range e.Bericht.Meldungen {
					if m.Art == MeldungFehler && !strings.HasPrefix(m.Text, "constraints") {
						t.Errorf("%s %s=%s: %s", id, l.Kennung, wert, m.Text)
					}
				}
			}
		}
	}
}

// Ein Baustein, wie er in einer Anlage steht, geht über "Als Baustein speichern" zurück in einen
// Baustein: die Kennungen der Anlage verlassen sie nicht, Satz und Lücken bleiben gleich, und
// erneut eingesetzt entsteht dieselbe Logik.
func TestAusLogikUndZurueck(t *testing.T) {
	reg := testAnlage(t)
	dateien := bausteinDateien(t)
	for _, id := range sortierteSchluessel(dateien) {
		e, err := Einsetzen(dateien[id], Fuellung{}, reg)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		vorher, _ := LiesBaustein(dateien[id])
		var satz strings.Builder
		for _, s := range vorher.Satz {
			if s.Luecke != "" {
				satz.WriteString("{" + s.Luecke + "}")
			} else {
				satz.WriteString(s.Text)
			}
		}
		doc, b, err := AusLogik([]byte(e.Text), vorher.Name, vorher.Beschreibung, satz.String())
		if err != nil {
			t.Errorf("%s: AusLogik: %v", id, err)
			continue
		}
		for _, l := range e.Luecken {
			if l.Art == LueckeGeraet || l.Art == LueckeEingang {
				if s, _ := l.Wert.(string); strings.Contains(string(doc), s) {
					t.Errorf("%s: die Kennung %s der Anlage steht im Baustein", id, s)
				}
			}
		}
		if len(b.Luecken) != len(vorher.Luecken) {
			t.Errorf("%s: %d Lücken statt %d", id, len(b.Luecken), len(vorher.Luecken))
		}
		wieder, err := Einsetzen(doc, Fuellung{}, reg)
		if err != nil {
			t.Errorf("%s: wieder einsetzen: %v", id, err)
			continue
		}
		if wieder.Kanonisch != e.Kanonisch {
			t.Errorf("%s: wieder eingesetzt entsteht eine andere Logik", id)
		}
	}
}

// Was eine Füllung ändert und was nicht: genau die Werte unter devices, inputs und settings,
// Kommentare und die übrigen Zeilen bleiben.
func TestEinsetzenAendertNurDieLuecken(t *testing.T) {
	dok := []byte(`block: 1
name: Probe
sentence: "Wenn {t} unter {mindest} fällt, heize mit {stab} zwischen {ab} und {bis}."
logic: |
  # Kommentar bleibt
  logic: 1
  name: Probe
  devices:
    stab: {entity: geraet-stab, name: "Stab ä"}   # hinter dem Wert
  inputs:
    t: {source: quelle-t.temperature, name: Speicher, max_age: 5 min}
  settings:
    mindest: {name: Nie kälter als, default: 40 °C, range: [30 °C, 50 °C], step: 1 K, editable_by: customer}
    ab:      {name: Ab, default: "06:00", editable_by: customer}
    bis:     {name: Bis, default: '22:00', editable_by: customer}
  states:
    an:
      type: boolean
      on_when:
        - holds(t < mindest, 2 min)
        - time_window(ab, bis)
      off_when_any:
        - unknown(t)
        - t >= mindest + 5 K
        - not time_window(ab, bis)
      after_restart: off
  outputs:
    stab: {on_off: an}
  status:
    - else: true
      title: Läuft
      type: idle
      text: Speicher {t}
`)
	reg := json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` + heizstab("s9", `Heizstab \"Keller\"`, "192.168.1.9") + `,` +
		`{"entity_id":"f9","entity_type":"fuehler","label":"Fühler","capabilities":{},"guards":{}}]}`)
	f := Fuellung{Name: "Mein Warmwasser", Werte: map[string]json.RawMessage{
		"mindest": json.RawMessage(`"45 °C"`), "ab": json.RawMessage(`"05:30"`), "bis": json.RawMessage(`"21:00"`)}}
	e, err := Einsetzen(dok, f, reg)
	if err != nil {
		t.Fatal(err)
	}
	soll := `# Kommentar bleibt
logic: 1
name: "Mein Warmwasser"
devices:
  stab: {entity: "s9", name: "Heizstab \"Keller\""}   # hinter dem Wert
inputs:
  t: {source: "f9.temperature", name: Speicher, max_age: 5 min}
settings:
  mindest: {name: Nie kälter als, default: "45 °C", range: [30 °C, 50 °C], step: 1 K, editable_by: customer}
  ab:      {name: Ab, default: "05:30", editable_by: customer}
  bis:     {name: Bis, default: "21:00", editable_by: customer}
`
	if !strings.HasPrefix(e.Text, soll) {
		t.Errorf("eingesetzt:\n%s\nerwartet am Anfang:\n%s", e.Text, soll)
	}
	if !e.Vollstaendig || e.Bericht.Sperrt {
		t.Errorf("vollständig %v, sperrt %v: %+v", e.Vollstaendig, e.Bericht.Sperrt, e.Bericht.Meldungen)
	}
	var teile []string
	for _, s := range e.Satz {
		if s.Luecke != "" {
			teile = append(teile, "["+s.Luecke+"]")
		} else {
			teile = append(teile, s.Text)
		}
	}
	if got := strings.Join(teile, ""); got != "Wenn [t] unter [mindest] fällt, heize mit [stab] zwischen [ab] und [bis]." {
		t.Errorf("Satz: %s", got)
	}
	texte := map[string]string{}
	for _, l := range e.Luecken {
		texte[l.Kennung] = l.WertText
	}
	if texte["mindest"] != "45 °C" || texte["ab"] != "05:30" || texte["stab"] != `Heizstab "Keller"` || texte["t"] != "Fühler" {
		t.Errorf("Werte für Menschen: %v", texte)
	}
}

// Was nicht passt, steht an der Lücke; gespeichert wird nur Vollständiges.
func TestEinsetzenMitUnpassendemWert(t *testing.T) {
	reg := testAnlage(t)
	dok := bausteinDateien(t)["netzheizen-zeitfenster"]
	f := Fuellung{Werte: map[string]json.RawMessage{
		"mindest":  json.RawMessage(`"90 °C"`),
		"heizstab": json.RawMessage(`"fuehler-ww"`),
	}}
	e, err := Einsetzen(dok, f, reg)
	if err != nil {
		t.Fatal(err)
	}
	if e.Vollstaendig {
		t.Error("ein Wert außerhalb des Bereichs und ein Fühler als Heizstab sind nicht vollständig")
	}
	fehler := map[string]string{}
	for _, l := range e.Luecken {
		fehler[l.Kennung] = l.Fehler
	}
	if !strings.Contains(fehler["mindest"], "außerhalb") || fehler["heizstab"] != "Passt nicht zu diesem Baustein" {
		t.Errorf("Fehler an den Lücken: %v", fehler)
	}
}

// Zwei Lücken für Geräte bekommen verschiedene Geräte; dasselbe Gerät zweimal ist ein Fehler.
func TestZweiGeraeteLueckenVerschieden(t *testing.T) {
	reg := testAnlage(t)
	dok := bausteinDateien(t)["warmwasser-vorrang"]
	e, err := Einsetzen(dok, Fuellung{}, reg)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, l := range e.Luecken {
		if l.Art == LueckeGeraet {
			ids[l.Wert.(string)] = true
		}
	}
	if len(ids) != 2 {
		t.Errorf("Vorschläge: %v", ids)
	}
	gleich := Fuellung{Werte: map[string]json.RawMessage{"ww": json.RawMessage(`"stab-ww"`), "puffer": json.RawMessage(`"stab-ww"`)}}
	e, err = Einsetzen(dok, gleich, reg)
	if err != nil {
		t.Fatal(err)
	}
	if e.Vollstaendig {
		t.Error("dasselbe Gerät in zwei Lücken ist nicht vollständig")
	}
}

// Ohne passendes Gerät passt der Baustein nicht zur Anlage (die Liste zeigt ihn dann nicht an).
func TestLiesBausteinePasst(t *testing.T) {
	dateien := bausteinDateien(t)
	var texte []BausteinText
	for _, id := range sortierteSchluessel(dateien) {
		texte = append(texte, BausteinText{ID: id, Text: string(dateien[id])})
	}
	texte = append(texte, BausteinText{ID: "kaputt", Text: "block: 2\n"})
	nurStab := json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` + heizstab("s1", "Heizstab", "192.168.1.2") +
		`,{"entity_id":"f1","entity_type":"fuehler","label":"Speicher","capabilities":{},"guards":{}}]}`)
	passt := map[string]bool{}
	for _, k := range LiesBausteine(texte, nurStab) {
		if k.ID == "kaputt" {
			if k.Lesbar || k.Message == "" {
				t.Errorf("ein kaputter Baustein: %+v", k)
			}
			continue
		}
		if !k.Lesbar {
			t.Errorf("%s: %s", k.ID, k.Message)
		}
		passt[k.ID] = k.Passt
	}
	soll := map[string]bool{"geraet-ueberschuss": true, "heizstab-ueberschuss": true, "netzheizen-zeitfenster": true,
		"warmwasser-vorrang": false, "waermepumpe-sgready": false, "kuehlraum-vorrat": false, "klima-vorkuehlen": false}
	for id, p := range soll {
		if passt[id] != p {
			t.Errorf("%s passt %v, erwartet %v", id, passt[id], p)
		}
	}
}

// Die Vektoren des Vertrags: je Baustein eine Füllung und was daraus entsteht (Satz für
// Menschen, Lage jeder Probe). Neu schreiben mit VP_FIXTURES_SCHREIBEN=1.
func TestBausteinVektoren(t *testing.T) {
	reg := testAnlage(t)
	dateien := bausteinDateien(t)
	type fall struct {
		Baustein  string                     `json:"baustein"`
		Fuellung  map[string]json.RawMessage `json:"fuellung"`
		Satz      string                     `json:"satz"`
		Verhalten []string                   `json:"verhalten"`
	}
	var vektoren struct {
		Hinweis  string          `json:"_hinweis"`
		Registry json.RawMessage `json:"registry"`
		Faelle   []fall          `json:"faelle"`
	}
	roh, err := os.ReadFile(bausteinVektoren)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(roh, &vektoren); err != nil {
		t.Fatal(err)
	}
	if len(vektoren.Faelle) < len(dateien) {
		t.Errorf("%d Fälle für %d Bausteine", len(vektoren.Faelle), len(dateien))
	}
	schreiben := os.Getenv("VP_FIXTURES_SCHREIBEN") == "1"
	if schreiben {
		vektoren.Registry = reg
	}
	for i, f := range vektoren.Faelle {
		dok, ok := dateien[f.Baustein]
		if !ok {
			t.Errorf("Fall %d: kein Baustein %s", i, f.Baustein)
			continue
		}
		e, err := Einsetzen(dok, Fuellung{Werte: f.Fuellung}, vektoren.Registry)
		if err != nil {
			t.Errorf("%s: %v", f.Baustein, err)
			continue
		}
		pruefeEingesetzt(t, f.Baustein, e)
		satz := satzText(e)
		var verhalten []string
		for _, p := range e.Verhalten {
			verhalten = append(verhalten, p.Uhr+" "+p.Name+" | "+p.Lage.Titel+" | "+p.Lage.Satz)
		}
		if schreiben {
			vektoren.Faelle[i].Satz, vektoren.Faelle[i].Verhalten = satz, verhalten
			continue
		}
		if satz != f.Satz {
			t.Errorf("%s: Satz\n%s\nerwartet\n%s", f.Baustein, satz, f.Satz)
		}
		if strings.Join(verhalten, "\n") != strings.Join(f.Verhalten, "\n") {
			t.Errorf("%s: Verhalten\n%s\nerwartet\n%s", f.Baustein, strings.Join(verhalten, "\n"), strings.Join(f.Verhalten, "\n"))
		}
	}
	if schreiben {
		out, _ := json.MarshalIndent(vektoren, "", "  ")
		if err := os.WriteFile(bausteinVektoren, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// satzText ist der Satz mit den Werten der Füllung, die Lücken in eckigen Klammern.
func satzText(e *Eingesetzt) string {
	werte := map[string]string{}
	for _, l := range e.Luecken {
		werte[l.Kennung] = l.WertText
	}
	var s strings.Builder
	for _, t := range e.Satz {
		if t.Luecke != "" {
			s.WriteString("[" + werte[t.Luecke] + "]")
		} else {
			s.WriteString(t.Text)
		}
	}
	return s.String()
}

// Werte unter given und ein erwarteter Sollwert dürfen Formeln über Stellwerte sein (Stufe 5):
// eine Probe bleibt wahr, wenn jemand den Stellwert ändert. Andere Namen als Stellwerte und
// eine falsche Einheit sind Fehler an der Probe.
func TestProbeMitFormelnUeberStellwerten(t *testing.T) {
	text := func(given string) []byte {
		return []byte(`logic: 1
name: Formeln
devices:
  stab: {entity: s1, name: Stab}
inputs:
  t:    {source: f1.temperature, name: Speicher, max_age: 5 min}
  netz: {source: site.grid, name: Netz, max_age: 60 s}
settings:
  mindest: {name: Mindest, default: 40 °C, range: [30 °C, 50 °C], step: 1 K, editable_by: customer}
  ab:      {name: Ab, default: "06:00", editable_by: customer}
states:
  kalt:
    type: boolean
    on_when:
      - t < mindest
      - time_window(ab, "22:00")
    off_when_any:
      - t >= mindest
    after_restart: off
outputs:
  stab: {on_off: kalt}
status:
  - when: kalt
    title: Kalt
    type: grid
    text: Kalt
  - else: true
    title: Warm
    type: idle
    text: Warm
tests:
  - name: Fall
    given: {` + given + `}
    after: 1 min
    expect: {kalt: on, status: Kalt}
`)
	}
	g, err := Pruefe(text(`t: mindest - 2 K, clock: ab, mindest: 45 °C`), nil, nil)
	if err != nil || g.Bericht.Sperrt {
		t.Fatalf("Formeln über Stellwerte: %v %+v", err, g)
	}
	for given, soll := range map[string]string{
		`t: netz + 1 K`:                    "kennt nur Stellwerte, nicht „netz“",
		`t: mindest - 2 K, netz: mindest`:  "netz ist Leistung, nicht Temperatur",
		`t: mindest - 2 K, clock: mindest`: "clock ist eine Uhrzeit",
		`t: kalt`:                          "kennt nur Stellwerte, nicht „kalt“",
	} {
		g, err := Pruefe(text(given), nil, nil)
		if err != nil {
			t.Fatalf("%s: %v", given, err)
		}
		if !g.Bericht.Sperrt || !strings.Contains(strings.Join(g.Bericht.Befunde, " "), soll) {
			t.Errorf("%s: erwartet „%s“, Befunde %v", given, soll, g.Bericht.Befunde)
		}
	}
}

// Das Schema der Baustein-Form und der Leser kennen dieselben Schlüssel.
func TestBausteinSchemaUndLeser(t *testing.T) {
	roh, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik-baustein.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required   []string                   `json:"required"`
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(roh, &schema); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(sortierteSchluessel(schema.Properties), ","); got != "block,description,logic,name,sentence" {
		t.Errorf("Schlüssel des Schemas: %s", got)
	}
	sort.Strings(schema.Required)
	if got := strings.Join(schema.Required, ","); got != "block,logic,name,sentence" {
		t.Errorf("Pflicht im Schema: %s", got)
	}
	for _, fall := range []struct{ text, soll string }{
		{"block: 1\nname: a\nsentence: b\n", "„logic“ fehlt"},
		{"block: 1\nname: a\nsentence: b\nlogic: x\nwas: y\n", "unbekannter Schlüssel „was“"},
		{"block: 2\nname: a\nsentence: b\nlogic: x\n", "nur Version 1"},
	} {
		if _, err := LiesBaustein([]byte(fall.text)); err == nil || !strings.Contains(err.Error(), fall.soll) {
			t.Errorf("%q: %v, erwartet „%s“", fall.text, err, fall.soll)
		}
	}
}

// Die Antwort des Dienstes auf "einsetzen" ist für API und Portal gepinnt (die API-Tests und die
// Bühne des Portals lesen sie): der Baustein "Aus dem Netz nachheizen" an der Testanlage.
func TestEingesetztIstGepinnt(t *testing.T) {
	const pfad = "../../../../docs/contracts/v2/examples/steuerlogik-baustein.valid.eingesetzt.json"
	e, err := Einsetzen(bausteinDateien(t)["netzheizen-zeitfenster"], Fuellung{Name: "Puffer nachheizen",
		Werte: map[string]json.RawMessage{"heizstab": json.RawMessage(`"stab-puffer"`), "t": json.RawMessage(`"fuehler-puffer"`),
			"mindest": json.RawMessage(`"45 °C"`), "netz_ab": json.RawMessage(`"05:30"`)}}, testAnlage(t))
	if err != nil {
		t.Fatal(err)
	}
	neu, _ := json.MarshalIndent(e, "", "  ")
	neu = append(neu, '\n')
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, neu, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	alt, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatal(err)
	}
	if string(alt) != string(neu) {
		t.Errorf("%s weicht von der Antwort des Dienstes ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung)", pfad)
	}
}
