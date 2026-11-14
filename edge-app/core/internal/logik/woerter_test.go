package logik

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

// Die Wortliste des Vertrags (E9 = B) ist ein geschlossenes Vokabular: Dieser Test hält
// sie und den Kern deckungsgleich. Ein neues oder geändertes Wort gehört zuerst in die
// Wortliste und in docs/contracts/v2/steuerlogik.md, dann hierher und in den Kern.

const woerterPfad = "../../../../docs/contracts/v2/steuerlogik-woerter.json"
const schemaPfad = "../../../../docs/contracts/v2/steuerlogik.schema.json"

func liesWoerter(t *testing.T) map[string]map[string]string {
	t.Helper()
	roh, err := os.ReadFile(woerterPfad)
	if err != nil {
		t.Fatalf("Wortliste lesen: %v", err)
	}
	var voll map[string]json.RawMessage
	if err := json.Unmarshal(roh, &voll); err != nil {
		t.Fatalf("Wortliste lesen: %v", err)
	}
	delete(voll, "_hinweis")
	aus := map[string]map[string]string{}
	for tabelle, inhalt := range voll {
		var m map[string]string
		if err := json.Unmarshal(inhalt, &m); err != nil {
			t.Fatalf("Wortliste, Tabelle %s: %v", tabelle, err)
		}
		aus[tabelle] = m
	}
	return aus
}

func englisch(t *testing.T, w map[string]map[string]string, tabelle string) []string {
	t.Helper()
	m, ok := w[tabelle]
	if !ok {
		t.Fatalf("Wortliste: Tabelle „%s“ fehlt", tabelle)
	}
	var aus []string
	gesehen := map[string]bool{}
	for _, v := range m {
		if !gesehen[v] {
			gesehen[v] = true
			aus = append(aus, v)
		}
	}
	sort.Strings(aus)
	return aus
}

func sortiert(a []string) []string {
	b := append([]string(nil), a...)
	sort.Strings(b)
	return b
}

func gleicheMengen(t *testing.T, tabelle string, ist, soll []string) {
	t.Helper()
	ist, soll = sortiert(ist), sortiert(soll)
	if !gleicheListe(ist, soll) {
		t.Errorf("Tabelle „%s“: Wortliste %v, Kern %v", tabelle, ist, soll)
	}
}

func TestWortlisteUndKernSindDeckungsgleich(t *testing.T) {
	w := liesWoerter(t)

	gleicheMengen(t, "abschnitte", englisch(t, w, "abschnitte"), []string{
		"logic", "name", "description", "devices", "inputs", "settings", "constraints",
		"formulas", "states", "outputs", "display", "notifications", "status", "tests"})
	gleicheMengen(t, "geraet", englisch(t, w, "geraet"), []string{"entity", "name"})
	gleicheMengen(t, "wert", englisch(t, w, "wert"), []string{"source", "name", "max_age"})
	gleicheMengen(t, "stellwert", englisch(t, w, "stellwert"), []string{
		"name", "type", "default", "range", "step", "editable_by", "help", "options"})
	gleicheMengen(t, "hilfe", englisch(t, w, "hilfe"), []string{"when_on", "when_off"})
	gleicheMengen(t, "zeitfenster", englisch(t, w, "zeitfenster"), []string{"days", "from", "to"})
	gleicheMengen(t, "zustand", englisch(t, w, "zustand"), []string{
		"name", "type", "on_when", "on_when_any", "off_when", "off_when_any", "after_restart",
		"duration", "min", "max", "steps"})
	gleicheMengen(t, "schritt", englisch(t, w, "schritt"), []string{
		"name", "by", "set", "not_before", "when", "when_any", "then"})
	gleicheMengen(t, "ausgang", englisch(t, w, "ausgang"), []string{"level", "on_off", "setpoint", "mode", "percent"})
	gleicheMengen(t, "anzeige", englisch(t, w, "anzeige"), []string{"input", "scale", "marks"})
	gleicheMengen(t, "marke", englisch(t, w, "marke"), []string{"name", "at"})
	gleicheMengen(t, "meldung", englisch(t, w, "meldung"), []string{"when", "to", "text", "repeat_after"})
	gleicheMengen(t, "lage", englisch(t, w, "lage"), []string{"when", "else", "title", "type", "text"})
	gleicheMengen(t, "probe", englisch(t, w, "probe"), []string{"name", "given", "after", "expect"})
	gleicheMengen(t, "gegeben", englisch(t, w, "gegeben"), []string{"clock", "weekday", "restart"})
	gleicheMengen(t, "erwarte", englisch(t, w, "erwarte"), []string{"status", "notifications"})
	gleicheMengen(t, "art_stellwert", englisch(t, w, "art_stellwert"), []string{"boolean", "select", "schedule"})
	gleicheMengen(t, "art_zustand", englisch(t, w, "art_zustand"), []string{"boolean", "counter", "timer"})
	gleicheMengen(t, "darf", englisch(t, w, "darf"), []string{"customer", "customer_admin", "installer"})
	gleicheMengen(t, "art_lage", englisch(t, w, "art_lage"), []string{"solar", "grid", "waiting", "idle", "fault"})
	gleicheMengen(t, "tage", englisch(t, w, "tage"), tage)
	gleicheMengen(t, "wertwort", englisch(t, w, "wertwort"), []string{"on", "off", "true", "false", "unknown", "keep"})
	gleicheMengen(t, "formelwort", englisch(t, w, "formelwort"), []string{"and", "or", "not", "on", "off", "true", "false", "clock"})
	gleicheMengen(t, "funktion", englisch(t, w, "funktion"), []string{
		"if", "known", "unknown", "time_window", "in_schedule", "holds", "since", "running", "last", "min", "max"})
	gleicheMengen(t, "handlung", englisch(t, w, "handlung"), []string{"start", "if"})
	gleicheMengen(t, "geraet_eigenschaft", englisch(t, w, "geraet_eigenschaft"), []string{
		"on", "level", "power", "kw_per_output", "output_hours_today", "requested", "setpoint", "mode"})
	gleicheMengen(t, "betriebsart", englisch(t, w, "betriebsart"), Betriebsarten)
	gleicheMengen(t, "quelle_fest", englisch(t, w, "quelle_fest"), []string{
		"site.grid", "site.pv", "battery.power", "battery.soc", "sun.elevation", "price.current"})
	gleicheMengen(t, "signal", englisch(t, w, "signal"), []string{
		"temperature", "room_temperature", "open", "door_open", "defrost", "fault", "running",
		"humidity", "outdoor_temperature", "supply_temperature", "return_temperature"})

	// Die reservierten Wörter sind die Formelwörter plus unknown und else (Vertrag 17.2).
	gleicheMengen(t, "formelwort + unknown/else", append(englisch(t, w, "formelwort"), "unknown", "else"), Reserviert)
}

// Jede feste Quelle und jedes Signal der Wortliste muss der Kern einer Größe zuordnen.
func TestQuellenHabenEineGroesse(t *testing.T) {
	w := liesWoerter(t)
	erwartet := map[string]struct {
		d    Groesse
		bool bool
	}{
		"site.grid": {GroesseKW, false}, "site.pv": {GroesseKW, false},
		"battery.power": {GroesseKW, false}, "battery.soc": {GroesseProzent, false},
		"sun.elevation": {GroesseWinkel, false}, "price.current": {GroesseZahl, false},
		"x.temperature": {GroesseTemp, false}, "x.room_temperature": {GroesseTemp, false},
		"x.open": {GroesseZahl, true}, "x.door_open": {GroesseZahl, true},
		"x.defrost": {GroesseZahl, true}, "x.fault": {GroesseZahl, true}, "x.running": {GroesseZahl, true},
		"x.humidity": {GroesseProzent, false}, "x.outdoor_temperature": {GroesseTemp, false},
		"x.supply_temperature": {GroesseTemp, false}, "x.return_temperature": {GroesseTemp, false},
	}
	gesehen := map[string]bool{}
	for _, q := range englisch(t, w, "quelle_fest") {
		gesehen[q] = true
	}
	for _, s := range englisch(t, w, "signal") {
		gesehen["x."+s] = true
	}
	for quelle, soll := range erwartet {
		if !gesehen[quelle] {
			t.Errorf("Quelle %s steht nicht in der Wortliste", quelle)
		}
		d, istBool := groesseDerQuelle(quelle)
		if d != soll.d || istBool != soll.bool {
			t.Errorf("Quelle %s: Größe %s/bool=%v, erwartet %s/bool=%v", quelle, d, istBool, soll.d, soll.bool)
		}
	}
}

// Das Schema und der Leser müssen dieselben geschlossenen Listen tragen.
func TestSchemaUndLeserSindDeckungsgleich(t *testing.T) {
	roh, err := os.ReadFile(schemaPfad)
	if err != nil {
		t.Fatalf("Schema lesen: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(roh, &schema); err != nil {
		t.Fatalf("Schema lesen: %v", err)
	}
	pfad := func(weg ...string) any {
		var k any = schema
		for _, s := range weg {
			m, ok := k.(map[string]any)
			if !ok {
				t.Fatalf("Schema: %v ist kein Objekt (bei %s)", weg, s)
			}
			k = m[s]
		}
		return k
	}
	texte := func(v any) []string {
		liste, ok := v.([]any)
		if !ok {
			t.Fatalf("Schema: erwartet eine Liste, ist %T", v)
		}
		var aus []string
		for _, e := range liste {
			aus = append(aus, e.(string))
		}
		return aus
	}

	if muster := pfad("$defs", "identifier", "pattern"); muster != kennungRe.String() {
		t.Errorf("identifier-Muster: Schema %v, Kern %s", muster, kennungRe.String())
	}
	gleicheMengen(t, "schema editable_by", texte(pfad("$defs", "setting", "properties", "editable_by", "enum")),
		[]string{"customer", "customer_admin", "installer"})
	gleicheMengen(t, "schema status.type", texte(pfad("properties", "status", "items", "properties", "type", "enum")),
		[]string{"solar", "grid", "waiting", "idle", "fault"})
	gleicheMengen(t, "schema setting.type", texte(pfad("$defs", "setting", "properties", "type", "enum")),
		[]string{"boolean", "select", "schedule"})
	gleicheMengen(t, "schema boolean.after_restart", texte(pfad("$defs", "boolean", "properties", "after_restart", "enum")),
		[]string{"on", "off", "keep"})
	gleicheMengen(t, "schema timer.after_restart", texte(pfad("$defs", "timer", "properties", "after_restart", "enum")),
		[]string{"off", "keep"})
	gleicheMengen(t, "schema notifications.to", texte(pfad("properties", "notifications", "items", "properties", "to", "items", "enum")),
		[]string{"customer", "installer"})

	grenzen := []struct {
		weg  []string
		soll float64
	}{
		{[]string{"properties", "devices", "maxProperties"}, maxGeraete},
		{[]string{"properties", "inputs", "maxProperties"}, maxWerte},
		{[]string{"properties", "settings", "maxProperties"}, maxStellwerte},
		{[]string{"properties", "formulas", "maxProperties"}, maxMerker},
		{[]string{"properties", "states", "maxProperties"}, maxZustaende},
		{[]string{"properties", "status", "maxItems"}, maxLage},
		{[]string{"properties", "notifications", "maxItems"}, maxMeldungen},
		{[]string{"properties", "constraints", "maxItems"}, maxZusammen},
		{[]string{"properties", "tests", "maxItems"}, maxProben},
		{[]string{"$defs", "counter", "properties", "steps", "maxItems"}, maxSchritte},
	}
	for _, g := range grenzen {
		if v, ok := pfad(g.weg...).(float64); !ok || v != g.soll {
			t.Errorf("Schema-Grenze %v: %v, Kern %v", g.weg, pfad(g.weg...), g.soll)
		}
	}

	ketten, ok := pfad("$defs", "conditions", "oneOf").([]any)
	if !ok || len(ketten) != 2 {
		t.Fatalf("Schema: $defs.conditions.oneOf")
	}
	if v := ketten[1].(map[string]any)["maxItems"]; v != float64(maxBedingungen) {
		t.Errorf("Schema-Grenze conditions.maxItems: %v, Kern %d", v, maxBedingungen)
	}

	var top []string
	for k := range pfad("properties").(map[string]any) {
		top = append(top, k)
	}
	gleicheMengen(t, "schema Abschnitte", top, []string{
		"logic", "name", "description", "devices", "inputs", "settings", "constraints",
		"formulas", "states", "outputs", "display", "notifications", "status", "tests"})
}
