package logikdienst

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Die Anlage der Gleichheitsvektoren (regel-kern-vectors.json) als Registry-Push: Netzanschluss,
// Speicher, ein Heizstab an einer Shelly-Ausgangsmenge, eine Pumpe am Relais.
func regelRegistry() json.RawMessage {
	return json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[
	 {"entity_id":"11111111-1111-4111-8111-111111111111","entity_type":"grid-meter","label":"Netzanschluss",
	  "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}]},"guards":{}},
	 {"entity_id":"22222222-2222-4222-8222-222222222222","entity_type":"battery-hybrid","label":"Speicher",
	  "capabilities":{"measure":[{"channel":"soc_pct","unit":"%"},{"channel":"power_kw","unit":"kW"}]},"guards":{}},
	 {"entity_id":"33333333-3333-4333-8333-333333333333","entity_type":"heating-rod","label":"Heizstab",
	  "capabilities":{"measure":[{"channel":"power_kw","unit":"kW"}],"actuate":[{"command":"on_off"},{"command":"setpoint_kw"}]},
	  "guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",
	  "connection":{"ip":"192.168.1.20","port":80,"channels":[0,1,2],"output_kw":[1,1,1],"stages":[1,2,3]}}},
	 {"entity_id":"44444444-4444-4444-8444-444444444444","entity_type":"pump","label":"Pumpe",
	  "capabilities":{"actuate":[{"command":"on_off"}]},"guards":{"failsafe":{"behavior":"off"}}}
	]}`)
}

type regelVektoren struct {
	Faelle []struct {
		Name     string          `json:"name"`
		Dokument json.RawMessage `json:"dokument"`
	} `json:"faelle"`
}

func liesRegelVektoren(t *testing.T) regelVektoren {
	t.Helper()
	roh, err := os.ReadFile("../../../../docs/contracts/v2/regel-kern-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v regelVektoren
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Jede Regel der Vektoren wird mit der Anlage übersetzt, besteht die Prüfung und lässt sich scharf
// ausliefern; das scharfe Artefakt verlangt genau den Befehl, mit dem der Flow das Gerät schaltet.
func TestAusRegelUebersetztJedeRegelDerVektoren(t *testing.T) {
	for _, f := range liesRegelVektoren(t).Faelle {
		t.Run(f.Name, func(t *testing.T) {
			e, err := AusRegel(RegelAuftrag{Dokument: f.Dokument, Name: f.Name, Fassung: 2, Registry: regelRegistry()})
			if err != nil {
				t.Fatal(err)
			}
			if !e.Uebersetzt || e.Text == "" || len(e.Gruende) != 0 {
				t.Fatalf("nicht übersetzt: %+v", e.Gruende)
			}
			if e.Bericht == nil || e.Bericht.Sperrt {
				t.Fatalf("Bericht: %+v", e.Bericht)
			}
			if !strings.Contains(e.Text, "(Fassung 2)") {
				t.Errorf("der Kopf nennt die Fassung der Regel nicht:\n%s", e.Text)
			}
			art, _, _, err := ArtefaktMitWerten(Auftrag{Text: e.Text, Registry: regelRegistry(),
				FlowID: "9f0c5a52-0000-4000-8000-000000000001", FlowVersion: 1,
				CompiledAt: time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC), Armed: true})
			if err != nil {
				t.Fatal(err)
			}
			var doc struct {
				Required []struct {
					EntityID     string   `json:"entity_id"`
					Capabilities []string `json:"capabilities"`
				} `json:"required_entities"`
			}
			if err := json.Unmarshal(art, &doc); err != nil {
				t.Fatal(err)
			}
			var dok struct {
				Nodes []struct {
					Type       string         `json:"type"`
					Parameters map[string]any `json:"parameters"`
				} `json:"nodes"`
			}
			_ = json.Unmarshal(f.Dokument, &dok)
			befehl := ""
			for _, n := range dok.Nodes {
				if n.Type == "vp.entity.control" {
					befehl = "actuate:" + n.Parameters["command"].(string)
				}
			}
			if len(doc.Required) != 1 || len(doc.Required[0].Capabilities) != 1 ||
				doc.Required[0].Capabilities[0] != befehl {
				t.Errorf("verlangt %+v, der Flow schaltet mit %s", doc.Required, befehl)
			}
		})
	}
}

// Was die Box für eine Logik nicht liest, wird nicht übersetzt, sondern mit Grund genannt.
func TestAusRegelNenntWasSichNichtUebersetzt(t *testing.T) {
	unter := `{"schema_version":"1.0","name":"Unterzähler","runtime":"edge","nodes":[
	 {"id":"lesen1","type":"vp.entity.read","type_version":"1.0.0","parameters":{"entity_id":"44444444-4444-4444-8444-444444444444","channel":"power_kw"}},
	 {"id":"schwelle1","type":"vp.logic.threshold","type_version":"1.1.0","parameters":{"threshold":1,"direction":"above"}},
	 {"id":"steuern1","type":"vp.entity.control","type_version":"1.0.0","parameters":{"entity_id":"33333333-3333-4333-8333-333333333333","command":"on_off","ttl_s":930}}],
	 "edges":[{"id":"e1","from":{"node":"lesen1","port":"value"},"to":{"node":"schwelle1","port":"input"}},
	  {"id":"e2","from":{"node":"schwelle1","port":"result"},"to":{"node":"steuern1","port":"value"}}],
	 "triggers":[{"id":"t1","kind":"slot-boundary"}]}`
	e, err := AusRegel(RegelAuftrag{Dokument: json.RawMessage(unter), Name: "Unterzähler", Registry: regelRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	if e.Uebersetzt || len(e.Gruende) != 1 || e.Gruende[0].Code != "messwert" || !strings.Contains(e.Gruende[0].Text, "Pumpe") {
		t.Fatalf("erwartet ein Grund „messwert“: %+v", e)
	}
	// Ohne Netz-Zähler in der Anlage ist auch der Sonnen-Überschuss keine feste Quelle.
	f := liesRegelVektoren(t).Faelle[0]
	e, err = AusRegel(RegelAuftrag{Dokument: f.Dokument, Name: f.Name})
	if err != nil {
		t.Fatal(err)
	}
	if e.Uebersetzt || len(e.Gruende) != 1 || e.Gruende[0].Code != "messwert" {
		t.Fatalf("ohne Anlage: %+v", e)
	}
}

// Ein Flow aus dem freien Editor ist keine Regel des Baukastens: 422 mit grund „regel“.
func TestAusRegelLehntFreienFlowAb(t *testing.T) {
	frei := `{"schema_version":"1.0","name":"Frei","runtime":"edge","nodes":[
	 {"id":"lesen1","type":"vp.entity.read","type_version":"1.0.0","parameters":{"entity_id":"x","channel":"power_kw"}},
	 {"id":"code1","type":"vp.logic.function","type_version":"1.0.0","parameters":{"code":"return wert;"}}],
	 "edges":[],"triggers":[]}`
	if _, err := AusRegel(RegelAuftrag{Dokument: json.RawMessage(frei)}); !errors.Is(err, ErrRegel) {
		t.Fatalf("erwartet ErrRegel, %v", err)
	}
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	body, _ := json.Marshal(map[string]any{"dokument": json.RawMessage(frei), "name": "Frei"})
	res, err := http.Post(srv.URL+"/aus-regel", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var antwort map[string]any
	_ = json.NewDecoder(res.Body).Decode(&antwort)
	if res.StatusCode != http.StatusUnprocessableEntity || antwort["grund"] != "regel" {
		t.Fatalf("Status %d, %v", res.StatusCode, antwort)
	}
}

// Die Antwort des Dienstes für die erste Regel der Vektoren, gepinnt für API und Portal.
func TestAusRegelGepinnteAntwort(t *testing.T) {
	f := liesRegelVektoren(t).Faelle[0]
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	body, _ := json.Marshal(RegelAuftrag{Dokument: f.Dokument, Name: f.Name, Fassung: 1, Registry: regelRegistry()})
	res, err := http.Post(srv.URL+"/aus-regel", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var antwort any
	if err := json.NewDecoder(res.Body).Decode(&antwort); err != nil {
		t.Fatal(err)
	}
	roh, _ := json.MarshalIndent(antwort, "", "  ")
	roh = append(roh, '\n')
	pfad := "../../../../docs/contracts/v2/examples/steuerlogik-aus-regel.valid.sonne.json"
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, roh, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	alt, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 schreibt sie)", err)
	}
	if string(alt) != string(roh) {
		t.Fatalf("%s ist nicht die Antwort des Dienstes; VP_FIXTURES_SCHREIBEN=1 schreibt sie neu", pfad)
	}
}
