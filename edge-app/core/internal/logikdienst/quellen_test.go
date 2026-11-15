package logikdienst

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Was eine Logik an einer Anlage lesen und schalten kann, aus dem Registry-Push: ein
// Heizstab an einer Ausgangsmenge (Stufe), ein Fühler (Temperatur), ein eigenes
// Modbus-Gerät mit Schreibwerten (Ein/Aus, Sollwert, Betriebsart und seine Signale),
// eine SG-Ready-Wärmepumpe (der Kontakt als Betriebsart) und ein Zähler, der nichts schaltet.
func TestQuellenAusDerRegistry(t *testing.T) {
	mb, err := os.ReadFile("../../../../docs/contracts/v2/examples/edge-entity.valid.config-modbus-geraet.json")
	if err != nil {
		t.Fatal(err)
	}
	registry := json.RawMessage(`{"schema_version":"1.0","revision":"r1","entities":[` +
		`{"entity_id":"a1","entity_type":"heating-rod","label":"Heizstab","capabilities":{"actuate":[{"command":"on_off"},{"command":"setpoint_kw"}]},` +
		`"guards":{"failsafe":{"behavior":"off"}},"driver":{"brand":"shelly","communication":"shelly_http",` +
		`"connection":{"ip":"192.168.1.20","port":80,"channels":[0,1,2],"output_kw":[2,2,2],"stages":[1,2,3]}}},` +
		`{"entity_id":"f1","entity_type":"fuehler","label":"Speicher oben","capabilities":{},"guards":{}},` +
		`{"entity_id":"w1","entity_type":"heat-pump-sgready","label":"Wärmepumpe","capabilities":{"actuate":[{"command":"on_off"}]},"guards":{}},` +
		`{"entity_id":"z1","entity_type":"grid-meter","label":"Zähler","capabilities":{},"guards":{}},` +
		string(mb) + `]}`)
	b := Quellen(registry)

	quellen := map[string]Quelle{}
	for _, q := range b.Quellen {
		quellen[q.Source] = q
	}
	for _, fest := range FesteQuellen {
		if quellen[fest.Source] != fest {
			t.Errorf("feste Quelle %s fehlt: %+v", fest.Source, quellen[fest.Source])
		}
	}
	if q := quellen["f1.temperature"]; q.Name != "Speicher oben" || q.Einheit != "°C" {
		t.Errorf("Fühler: %+v", q)
	}
	mbID := "5b8d2e40-1c7a-4f3e-9d21-6a0b4c8e2f17"
	if q := quellen[mbID+".room_temperature"]; q.Einheit != "°C" || q.Name != "Klimagerät Büro · Raumtemperatur" {
		t.Errorf("Modbus-Signal: %+v", q)
	}
	if q := quellen[mbID+".fault"]; q.Einheit != "ja_nein" {
		t.Errorf("Modbus-Störung: %+v", q)
	}
	if len(b.Quellen) != len(FesteQuellen)+1+3 {
		t.Errorf("%d Quellen: %+v", len(b.Quellen), b.Quellen)
	}

	geraete := map[string]Schaltbar{}
	for _, g := range b.Geraete {
		geraete[g.EntityID] = g
	}
	if g := geraete["a1"]; !reflect.DeepEqual(g.Ausgaenge, []string{"level", "on_off"}) || g.Ausgangszahl != 3 ||
		g.KwJeAusgang == nil || *g.KwJeAusgang != 2 {
		t.Errorf("Heizstab: %+v", g)
	}
	if g := geraete[mbID]; !reflect.DeepEqual(g.Ausgaenge, []string{"on_off", "setpoint", "mode"}) ||
		g.Sollwert == nil || g.Sollwert.Einheit != "°C" || *g.Sollwert.Von != 16 || *g.Sollwert.Schritt != 0.5 ||
		!reflect.DeepEqual(g.Betriebsarten, []string{"cool", "heat", "fan_only"}) {
		t.Errorf("Modbus-Gerät: %+v", g)
	}
	if g := geraete["w1"]; !reflect.DeepEqual(g.Ausgaenge, []string{"on_off", "mode"}) ||
		!reflect.DeepEqual(g.Betriebsarten, []string{"normal", "boost"}) {
		t.Errorf("SG-Ready: %+v", g)
	}
	if _, da := geraete["z1"]; da {
		t.Error("ein Zähler schaltet nichts")
	}
	if _, da := geraete["f1"]; da {
		t.Error("ein Fühler schaltet nichts")
	}
}

// Ohne Registry bleiben die festen Quellen.
func TestQuellenOhneRegistry(t *testing.T) {
	b := Quellen(nil)
	if len(b.Quellen) != len(FesteQuellen) || len(b.Geraete) != 0 {
		t.Fatalf("%+v", b)
	}
}
