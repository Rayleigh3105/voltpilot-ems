package logikdienst

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
)

const vertrag = "../../../../docs/contracts/v2"

type vektoren struct {
	Logiken []struct {
		Name     string `json:"name"`
		Datei    string `json:"datei"`
		Anlage   Anlage `json:"anlage"`
		Pruefung struct {
			Ausdruecke int        `json:"ausdruecke"`
			Befunde    int        `json:"befunde"`
			Zusammen   []Zusammen `json:"zusammen"`
		} `json:"pruefung"`
		Proben []struct {
			Name         string       `json:"name"`
			Besteht      bool         `json:"besteht"`
			Abweichungen []Abweichung `json:"abweichungen"`
		} `json:"proben"`
	} `json:"logiken"`
}

func liesVektoren(t *testing.T) vektoren {
	t.Helper()
	roh, err := os.ReadFile(filepath.Join(vertrag, "steuerlogik-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Logiken) != 6 {
		t.Fatalf("sechs Vektor-Logiken erwartet, %d gelesen", len(v.Logiken))
	}
	return v
}

// The service decides every contract vector exactly like the core - from the
// writing form AND from the canonical form - because it IS the core's reader.
func TestDienstBestehtDieVertragsvektoren(t *testing.T) {
	for _, vl := range liesVektoren(t).Logiken {
		for _, form := range []string{".logic.yaml", ".logic.json"} {
			t.Run(vl.Name+form, func(t *testing.T) {
				text, err := os.ReadFile(filepath.Join(vertrag, strings.TrimSuffix(vl.Datei, ".logic.json")+form))
				if err != nil {
					t.Fatal(err)
				}
				g, err := Pruefe(text, vl.Anlage, nil)
				if err != nil {
					t.Fatalf("Pruefe: %v", err)
				}
				b := g.Bericht
				if b.Ausdruecke != vl.Pruefung.Ausdruecke || len(b.Befunde) != vl.Pruefung.Befunde {
					t.Fatalf("Ausdrücke %d, Befunde %v", b.Ausdruecke, b.Befunde)
				}
				if len(b.Zusammen) != len(vl.Pruefung.Zusammen) {
					t.Fatalf("constraints: %+v", b.Zusammen)
				}
				for i, z := range b.Zusammen {
					if z != vl.Pruefung.Zusammen[i] {
						t.Errorf("constraint %d: %+v, erwartet %+v", i, z, vl.Pruefung.Zusammen[i])
					}
				}
				if len(b.Proben) != len(vl.Proben) {
					t.Fatalf("Proben: %d statt %d", len(b.Proben), len(vl.Proben))
				}
				for i, p := range b.Proben {
					soll := vl.Proben[i]
					if p.Name != soll.Name || p.Besteht != soll.Besteht || len(p.Abweichungen) != len(soll.Abweichungen) {
						t.Errorf("Probe %q: %+v, erwartet %+v", soll.Name, p, soll)
					}
				}
				if b.Sperrt != (vl.Name == "heizung-treu") {
					t.Fatalf("sperrt = %v", b.Sperrt)
				}
				// The canonical output is the vector's canonical document.
				soll, err := os.ReadFile(filepath.Join(vertrag, vl.Datei))
				if err != nil {
					t.Fatal(err)
				}
				a, _ := textform.LiesJSON(g.Kanonisch)
				c, _ := textform.LiesJSON(soll)
				if ok, wo := textform.Gleich(c, a); !ok {
					t.Fatalf("kanonische Form weicht ab: %s", wo)
				}
			})
		}
	}
}

func beispiel(t *testing.T, name string) string {
	t.Helper()
	roh, err := os.ReadFile(filepath.Join(vertrag, "steuerlogik", name+".logic.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return string(roh)
}

const tFlow = "0f0e0d0c-0b0a-4908-8706-050403020100"

// The artifact the service builds passes the box's own integrity check: the
// box re-marshals the bundle into its struct and recomputes the hash.
func TestArtefaktBestehtDiePruefungDerBox(t *testing.T) {
	breite, laenge := 48.1, 11.6
	raw, bericht, err := Artefakt(Auftrag{Text: beispiel(t, "waermepumpe"), FlowID: tFlow, FlowVersion: 2,
		CompiledAt: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC),
		Site:       &Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge}})
	if err != nil {
		t.Fatal(err)
	}
	if bericht.Name != "Wärmepumpe" || len(bericht.Geraete) != 1 || bericht.Geraete[0].EntityID != "waermepumpe-1" {
		t.Fatalf("Bericht: %+v", bericht)
	}
	var art flowdeploy.Artifact
	if err := json.Unmarshal(raw, &art); err != nil {
		t.Fatal(err)
	}
	if art.Bundle.Format != flowdeploy.FormatSteuerlogik || art.Runtime != "edge" || art.FlowVersion != 2 ||
		art.Bundle.Site == nil || *art.Bundle.Site.Latitude != 48.1 {
		t.Fatalf("Artefakt: %+v", art)
	}
	bundleRaw, _ := json.Marshal(art.Bundle)
	hash, err := flowdeploy.ContentHash(bundleRaw)
	if err != nil || hash != art.ContentHash {
		t.Fatalf("Hash der Box %s, Artefakt %s (%v)", hash, art.ContentHash, err)
	}
	// Deterministic: the same request builds the same artifact.
	again, _, _ := Artefakt(Auftrag{Text: beispiel(t, "waermepumpe"), FlowID: tFlow, FlowVersion: 2,
		CompiledAt: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC),
		Site:       &Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge}})
	if !bytes.Equal(raw, again) {
		t.Fatal("gleicher Auftrag, anderes Artefakt")
	}
}

func TestArtefaktAblehnungen(t *testing.T) {
	treu := beispiel(t, "heizung-treu")
	if _, b, err := Artefakt(Auftrag{Text: treu, FlowID: tFlow, FlowVersion: 1,
		Anlage: Anlage{"dle": {Outputs: 3}}}); !errors.Is(err, ErrSperrt) || b == nil || !b.Sperrt {
		t.Fatalf("eine nicht bestehende Probe sperrt (E5): %v %+v", err, b)
	}
	kaputt := strings.Replace(beispiel(t, "waermepumpe"), "default: on", "default: yes", 1)
	if _, _, err := Artefakt(Auftrag{Text: kaputt, FlowID: tFlow, FlowVersion: 1}); !errors.Is(err, ErrUnlesbar) ||
		!strings.Contains(err.Error(), "schreibe on oder off") {
		t.Fatalf("yes ist verboten: %v", err)
	}
	if _, _, err := Artefakt(Auftrag{Text: beispiel(t, "waermepumpe"), FlowID: "x", FlowVersion: 1}); !errors.Is(err, ErrAuftrag) {
		t.Fatalf("flow_id: %v", err)
	}
	if _, _, err := Artefakt(Auftrag{Text: beispiel(t, "waermepumpe"), FlowID: tFlow, FlowVersion: 1,
		Site: &Ort{Timezone: "Mars/Olympus"}}); !errors.Is(err, ErrAuftrag) {
		t.Fatalf("Zeitzone: %v", err)
	}
}

func TestHTTP(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	post := func(pfad string, body any) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		res, err := http.Post(srv.URL+pfad, "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var doc map[string]any
		_ = json.NewDecoder(res.Body).Decode(&doc)
		return res.StatusCode, doc
	}
	res, err := http.Get(srv.URL + "/health")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("health: %v %v", err, res)
	}
	res.Body.Close()

	code, doc := post("/artefakt", map[string]any{"text": beispiel(t, "waermepumpe"), "flow_id": tFlow, "flow_version": 1})
	if code != http.StatusOK || doc["artifact"] == nil || doc["bericht"].(map[string]any)["sperrt"] != false {
		t.Fatalf("artefakt: %d %v", code, doc)
	}
	code, doc = post("/artefakt", map[string]any{"text": beispiel(t, "heizung-treu"), "flow_id": tFlow, "flow_version": 1})
	if code != http.StatusUnprocessableEntity || doc["bericht"] == nil || doc["artifact"] != nil {
		t.Fatalf("gesperrt: %d %v", code, doc)
	}
	code, doc = post("/pruefe", map[string]any{"text": "logic: 2\nname: x\n"})
	if code != http.StatusUnprocessableEntity || !strings.Contains(doc["message"].(string), "Sprachversion 1") {
		t.Fatalf("unlesbar: %d %v", code, doc)
	}
	code, doc = post("/pruefe", map[string]any{"text": beispiel(t, "klima")})
	if code != http.StatusOK || !strings.HasPrefix(doc["kanonisch"].(string), `{"logic":1,`) {
		t.Fatalf("pruefe: %d %v", code, doc)
	}
	res, _ = http.Post(srv.URL+"/artefakt", "application/json", strings.NewReader("{"))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("kaputtes JSON: %d", res.StatusCode)
	}
	res.Body.Close()
}

// The artifact of the contract's heat pump example is pinned as a contract
// fixture (examples/flow-artifact.valid.steuerlogik.json): the API's tests
// hand it out as the service's answer, so Go and Java meet on the same bytes.
// VP_FIXTURES_SCHREIBEN=1 rewrites it after an intended change.
func TestBeispielArtefaktIstGepinnt(t *testing.T) {
	breite, laenge := 48.1, 11.6
	raw, _, err := Artefakt(Auftrag{Text: beispiel(t, "waermepumpe"), FlowID: "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b",
		FlowVersion: 1, CompiledAt: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC),
		Site: &Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge}})
	if err != nil {
		t.Fatal(err)
	}
	var schoen bytes.Buffer
	if err := json.Indent(&schoen, raw, "", "  "); err != nil {
		t.Fatal(err)
	}
	schoen.WriteByte('\n')
	pfad := filepath.Join(vertrag, "examples", "flow-artifact.valid.steuerlogik.json")
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, schoen.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	soll, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 legt sie an)", err)
	}
	if !bytes.Equal(soll, schoen.Bytes()) {
		t.Fatalf("%s weicht vom gebauten Artefakt ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung)", pfad)
	}
}

// The pilot logic needs the plant's devices: one of its probes depends on the
// kW per phase. Without facts it blocks; with the site's registry push - the
// document the box gets - the service reads the output sets with the box's
// own driver reader and the logic passes.
func TestProbenLesenDieGeraeteAusDerRegistry(t *testing.T) {
	text := []byte(beispiel(t, "heizung"))
	ohne, err := Pruefe(text, nil, nil)
	if err != nil || !ohne.Bericht.Sperrt {
		t.Fatalf("ohne Anlagendaten muss die Probe der Leistung sperren: %v %+v", err, ohne.Bericht.Proben)
	}
	stab := func(id string, kw float64) string {
		return fmt.Sprintf(`{"entity_id":%q,"entity_type":"heating-rod","capabilities":{"actuate":[{"command":"setpoint_kw"}]},`+
			`"guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",`+
			`"connection":{"ip":"192.168.1.20","port":80,"channels":[0,1,2],"output_kw":[%g,%g,%g],"stages":[1,2,3]}}}`,
			id, kw, kw, kw)
	}
	registry := json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` +
		stab("heizstab-dle", 3) + "," + stab("heizstab-puffer-2", 1.5) + "," + stab("heizstab-puffer-3", 1.5) + `]}`)
	mit, err := Pruefe(text, nil, registry)
	if err != nil {
		t.Fatal(err)
	}
	if mit.Bericht.Sperrt {
		t.Fatalf("mit der Registry der Anlage besteht jede Probe: %+v", mit.Bericht.Proben)
	}
	// An explicit plant fact wins over the registry.
	falsch, _ := Pruefe(text, Anlage{"dle": {Outputs: 3, KwPerOutput: ptr(9)}}, registry)
	if !falsch.Bericht.Sperrt {
		t.Fatal("eine ausdrückliche Angabe geht vor")
	}
}

func ptr(v float64) *float64 { return &v }

// Devices that regulate themselves (K2): the service sees band, step and the
// closed list of modes the same way - from the vectors' plant facts and from
// the registry push the box gets.
func TestDienstKenntGeraeteMitSollwertUndBetriebsart(t *testing.T) {
	roh, err := os.ReadFile(filepath.Join(vertrag, "steuerlogik-geraete-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Faelle []struct {
			Name    string   `json:"name"`
			Datei   string   `json:"datei"`
			Anlage  Anlage   `json:"anlage"`
			Befunde []string `json:"befunde"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	for _, f := range v.Faelle {
		text, err := os.ReadFile(filepath.Join(vertrag, f.Datei))
		if err != nil {
			t.Fatal(err)
		}
		g, err := Pruefe(text, f.Anlage, nil)
		if err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		if fmt.Sprint(g.Bericht.Befunde) != fmt.Sprint(f.Befunde) && !(len(f.Befunde) == 0 && len(g.Bericht.Befunde) == 0) {
			t.Errorf("%s: Befunde %q, erwartet %q", f.Name, g.Bericht.Befunde, f.Befunde)
		}
	}

	// From the registry: an air conditioner that cannot cool blocks the example.
	registry := []byte(`{"entities":[{"entity_id":"klimageraet-buero","entity_type":"modbus-device",
		"capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_c","min":16,"max":30,"step":0.5},
		{"command":"mode","modes":["heat","fan_only"]}]},"guards":{"failsafe":{"behavior":"rest"}}}]}`)
	text, _ := os.ReadFile(filepath.Join(vertrag, "steuerlogik/klima.logic.yaml"))
	g, err := Pruefe(text, nil, registry)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Bericht.Sperrt || len(g.Bericht.Befunde) != 1 ||
		g.Bericht.Befunde[0] != "outputs.klima.mode: das Gerät kennt die Betriebsart „cool“ nicht (es kennt heat, fan_only)" {
		t.Fatalf("Befunde aus der Registry: %+v", g.Bericht.Befunde)
	}
}

// tScharfStab is the hot water rod of the armed example as the registry
// names it - an entity with a UUID, as every real component has.
const tScharfStab = "7b0c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"

func scharfeRegistry() json.RawMessage {
	return json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[{"entity_id":"` + tScharfStab + `",` +
		`"entity_type":"heating-rod","capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_kw"}]},` +
		`"guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",` +
		`"connection":{"ip":"192.168.1.20","port":80,"channels":[0,1,2],"output_kw":[2,2,2],"stages":[1,2,3]}}}]}`)
}

func scharfesBeispiel(t *testing.T) string {
	return strings.ReplaceAll(beispiel(t, "wasser"), "heizstab-warmwasser", tScharfStab)
}

// An armed artifact carries armed, the set values with their revision, and
// requires the command the box will switch with (a level on an output set ->
// setpoint_kw). The service's whole answer is pinned as a contract fixture
// (examples/steuerlogik-dienst.valid.wasser-scharf.json) the API's tests hand
// out, so Go and Java meet on the same bytes.
func TestScharfesArtefaktIstGepinnt(t *testing.T) {
	breite, laenge := 48.1, 11.6
	art, bericht, gebaut, err := ArtefaktMitWerten(Auftrag{Text: scharfesBeispiel(t),
		FlowID: "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b", FlowVersion: 1,
		CompiledAt: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC), Registry: scharfeRegistry(), Armed: true,
		Site:     &Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge},
		Settings: &Einstellung{Revision: 1, Values: map[string]json.RawMessage{"mindest": json.RawMessage(`"42 °C"`)}}})
	if err != nil {
		t.Fatal(err)
	}
	var a flowdeploy.Artifact
	if err := json.Unmarshal(art, &a); err != nil {
		t.Fatal(err)
	}
	if !a.Bundle.Armed || a.Bundle.Settings == nil || a.Bundle.Settings.Revision != 1 ||
		string(a.Bundle.Settings.Values["mindest"]) != `"42 °C"` {
		t.Fatalf("bundle: armed %v settings %+v", a.Bundle.Armed, a.Bundle.Settings)
	}
	if len(a.RequiredEntities) != 1 || a.RequiredEntities[0].EntityID != tScharfStab ||
		strings.Join(a.RequiredEntities[0].Capabilities, ",") != "actuate:setpoint_kw" {
		t.Fatalf("required entities: %+v", a.RequiredEntities)
	}
	if len(bericht.Geraete) != 1 || strings.Join(bericht.Geraete[0].Ausgaenge, ",") != "level" ||
		len(bericht.Stellwerte) != 5 || !bericht.Stellwerte[0].Zielwert {
		t.Fatalf("bericht: %+v", bericht)
	}
	antwort, err := json.MarshalIndent(map[string]any{"artifact": json.RawMessage(art), "bericht": bericht,
		"settings": gebaut.Settings}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	antwort = append(antwort, '\n')
	pfad := filepath.Join(vertrag, "examples", "steuerlogik-dienst.valid.wasser-scharf.json")
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, antwort, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	soll, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 legt sie an)", err)
	}
	if !bytes.Equal(soll, antwort) {
		t.Fatalf("%s weicht von der Antwort des Dienstes ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung)", pfad)
	}
}

// Set values that do not fit refuse the artifact (a customer's slider must
// never reach the box out of range); for a new version they fall back to
// their default and are named instead (report §8.9).
func TestStellwerteImArtefakt(t *testing.T) {
	auftrag := func(werte map[string]string, behalten bool) Auftrag {
		v := map[string]json.RawMessage{}
		for k, w := range werte {
			v[k], _ = json.Marshal(w)
		}
		return Auftrag{Text: scharfesBeispiel(t), FlowID: "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b", FlowVersion: 2,
			Registry: scharfeRegistry(), Settings: &Einstellung{Revision: 4, Values: v}, SettingsKeepFitting: behalten}
	}
	for name, werte := range map[string]map[string]string{
		"über dem Bereich": {"ziel": "70 °C"},
		"nicht im Raster":  {"mindest": "40.5 °C"},
		"falsche Einheit":  {"mindest": "40 kW"},
		"unbekannt":        {"gibt_es_nicht": "1"},
		"Bedingung":        {"netz_ziel": "42 °C", "mindest": "40 °C"},
	} {
		_, _, _, err := ArtefaktMitWerten(auftrag(werte, false))
		if !errors.Is(err, ErrStellwerte) {
			t.Fatalf("%s: erwartet ErrStellwerte, war %v", name, err)
		}
	}
	_, _, gebaut, err := ArtefaktMitWerten(auftrag(map[string]string{"ziel": "70 °C", "mindest": "41 °C"}, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(gebaut.Verworfen) != 1 || gebaut.Verworfen[0].Kennung != "ziel" || gebaut.Settings.Revision != 4 ||
		string(gebaut.Settings.Values["mindest"]) != `"41 °C"` || gebaut.Settings.Values["ziel"] != nil {
		t.Fatalf("eine neue Fassung behält, was passt: %+v %+v", gebaut.Verworfen, gebaut.Settings)
	}

	// Over HTTP the refusal is 422 with grund stellwerte (the API's client reads it).
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	body, _ := json.Marshal(auftrag(map[string]string{"ziel": "70 °C"}, false))
	res, err := http.Post(srv.URL+"/artefakt", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var antwort map[string]any
	_ = json.NewDecoder(res.Body).Decode(&antwort)
	res.Body.Close()
	if res.StatusCode != 422 || antwort["grund"] != "stellwerte" {
		t.Fatalf("HTTP: %d %v", res.StatusCode, antwort)
	}
}

// Armed, a device that regulates itself (K2/K3) must execute what the logic
// sets: on/off, the setpoint in °C as setpoint_c, the mode as mode. The box
// takes the bundle only when its registry entry declares all three.
func TestScharfesArtefaktVerlangtSollwertUndBetriebsart(t *testing.T) {
	registry := json.RawMessage(`{"entities":[{"entity_id":"klimageraet-buero","entity_type":"modbus-device",
		"capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_c","min":16,"max":30,"step":0.5},
		{"command":"mode","modes":["cool","heat","fan_only"]}]},"guards":{"failsafe":{"behavior":"rest"}}}]}`)
	text, err := os.ReadFile(filepath.Join(vertrag, "steuerlogik/klima.logic.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	art, bericht, _, err := ArtefaktMitWerten(Auftrag{Text: string(text), FlowID: "3c9d2e1f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", FlowVersion: 1,
		Registry: registry, Armed: true})
	if err != nil || bericht.Sperrt {
		t.Fatalf("Dienst: %v %+v", err, bericht)
	}
	var a struct {
		RequiredEntities []struct {
			EntityID     string   `json:"entity_id"`
			Capabilities []string `json:"capabilities"`
		} `json:"required_entities"`
	}
	if err := json.Unmarshal(art, &a); err != nil {
		t.Fatal(err)
	}
	if len(a.RequiredEntities) != 1 || fmt.Sprint(a.RequiredEntities[0].Capabilities) !=
		"[actuate:mode actuate:on_off actuate:setpoint_c]" {
		t.Fatalf("verlangt: %+v", a.RequiredEntities)
	}
}
