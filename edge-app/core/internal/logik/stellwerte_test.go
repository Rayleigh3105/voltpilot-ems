package logik

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func ladeBeispiel(t *testing.T, name string) *Logik {
	t.Helper()
	roh, err := os.ReadFile(dokumentePfad + "/steuerlogik/" + name + ".logic.json")
	if err != nil {
		t.Fatalf("Dokument lesen: %v", err)
	}
	L, err := Lesen(roh)
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	return L
}

// Die Beschreibung der Stellwerte nennt Zahlen in der Einheit, in der der Text die Vorgabe
// schreibt (eine Haltezeit in min bleibt min), und markiert Zielwerte (°C) nach E2 = B.
func TestStellwertInfos(t *testing.T) {
	L := ladeBeispiel(t, "waermepumpe")
	infos := map[string]StellwertInfo{}
	var reihenfolge []string
	for _, i := range L.StellwertInfos() {
		infos[i.Kennung] = i
		reihenfolge = append(reihenfolge, i.Kennung)
	}
	if strings.Join(reihenfolge, ",") != "sonne_nutzen,ab_kw,puffer_max,haltezeit,pause" {
		t.Fatalf("Reihenfolge des Textes verloren: %v", reihenfolge)
	}
	if s := infos["sonne_nutzen"]; s.Art != "boolean" || s.Vorgabe != "on" || s.Darf != "customer" || s.Zielwert {
		t.Fatalf("Schalter falsch beschrieben: %+v", s)
	}
	h := infos["haltezeit"]
	if h.Einheit != "min" || *h.Von != 30 || *h.Bis != 120 || *h.Schritt != 5 || h.Vorgabe != "30 min" || h.Darf != "installer" {
		t.Fatalf("Haltezeit nicht in min beschrieben: %+v", h)
	}
	p := infos["puffer_max"]
	if !p.Zielwert || p.Einheit != "°C" || *p.Schritt != 1 || *p.Von != 40 || *p.Bis != 65 {
		t.Fatalf("Zielwert in °C mit Schritt in K falsch: %+v", p)
	}
	if a := infos["ab_kw"]; a.Einheit != "kW" || *a.Schritt != 0.5 || a.Vorgabe != "2 kW" {
		t.Fatalf("Leistung falsch beschrieben: %+v", a)
	}
}

// Ein gestellter Wert passt nur in Art, Einheit, Bereich und Schritt; die Form des Dokuments
// liest sich zurück, wie sie geschrieben wurde.
func TestLiesStellwert(t *testing.T) {
	L := ladeBeispiel(t, "waermepumpe")
	gut := map[string]any{"puffer_max": "58 °C", "haltezeit": "45 min", "ab_kw": "2500 W", "sonne_nutzen": "off"}
	for k, roh := range gut {
		w, err := L.LiesStellwert(k, roh)
		if err != nil {
			t.Fatalf("%s=%v abgelehnt: %v", k, roh, err)
		}
		zurueck, err := L.LiesStellwert(k, L.StellwertRoh(k, w))
		if err != nil || zurueck != w {
			t.Fatalf("%s: Rundreise über %v ergab %+v (%v)", k, L.StellwertRoh(k, w), zurueck, err)
		}
	}
	if r := L.StellwertRoh("ab_kw", zahlW(2.5, GroesseKW)); r != "2.5 kW" {
		t.Fatalf("Rohform 2.5 kW erwartet, war %v", r)
	}
	schlecht := map[string]any{
		"puffer_max":    "66 °C",  // über dem Bereich
		"haltezeit":     "33 min", // nicht im 5-min-Raster
		"ab_kw":         "2 K",    // falsche Einheit
		"sonne_nutzen":  "ja",     // kein on/off
		"gibt_es_nicht": "1",
	}
	for k, roh := range schlecht {
		if _, err := L.LiesStellwert(k, roh); err == nil {
			t.Fatalf("%s=%v hätte abgelehnt werden müssen", k, roh)
		}
	}
	if _, err := L.LiesStellwert("haltezeit", "33 min"); err == nil || !strings.Contains(err.Error(), "Empfehlung mindestens") {
		t.Fatalf("der Grund nennt den Namen des Stellwerts nicht: %v", err)
	}
}

// Zeitplan und Auswahl: dieselbe Form wie im Dokument, die Auswahl nur mit ihren Wörtern.
func TestStellwertZeitplanUndAuswahl(t *testing.T) {
	L := ladeBeispiel(t, "klima")
	var plan any
	if err := json.Unmarshal([]byte(`[{"days":"mon-thu","from":"06:30","to":"17:00"}]`), &plan); err != nil {
		t.Fatal(err)
	}
	w, err := L.LiesStellwert("arbeitszeit", plan)
	if err != nil {
		t.Fatalf("Zeitplan abgelehnt: %v", err)
	}
	roh, _ := json.Marshal(L.StellwertRoh("arbeitszeit", w))
	if string(roh) != `[{"days":"mon-thu","from":"06:30","to":"17:00"}]` {
		t.Fatalf("Zeitplan nicht in der Form des Dokuments: %s", roh)
	}
	if err := json.Unmarshal([]byte(`[{"days":"mon","from":7,"to":"17:00"}]`), &plan); err != nil {
		t.Fatal(err)
	}
	if _, err := L.LiesStellwert("arbeitszeit", plan); err == nil {
		t.Fatalf("eine Uhrzeit als Zahl muss abgelehnt werden, nicht abstürzen")
	}
	if _, err := L.LiesStellwert("betrieb", "nur_sonne"); err != nil {
		t.Fatalf("Wort der Auswahl abgelehnt: %v", err)
	}
	if _, err := L.LiesStellwert("betrieb", "heizen"); err == nil {
		t.Fatalf("ein Wort außerhalb der Auswahl muss abgelehnt werden")
	}
}

// Bedingungen unter constraints gelten mit allen gestellten Werten zusammen.
func TestPruefeStellwerteZusammen(t *testing.T) {
	L := ladeBeispiel(t, "heizung")
	if len(L.Zusammen) == 0 {
		t.Skip("das Beispiel hat keine constraints")
	}
	if _, err := L.PruefeStellwerte(map[string]any{}); err != nil {
		t.Fatalf("die Vorgaben müssen gelten: %v", err)
	}
	// Die Ecken der Bereiche durchprobieren, bis eine Belegung die Bedingung verletzt.
	verletzt := false
	for i := range L.Zusammen {
		ok, err := L.zusammenImBereich(i)
		if err != nil {
			t.Fatal(err)
		}
		verletzt = verletzt || ok
	}
	if !verletzt {
		t.Skip("keine Bedingung ist im Bereich verletzbar")
	}
	for _, n := range L.StellListe {
		s := L.Stellwerte[n]
		if s.Bereich == nil {
			continue
		}
		for _, ecke := range s.Bereich {
			roh := map[string]any{n: L.StellwertRoh(n, ecke)}
			if _, err := L.PruefeStellwerte(roh); err != nil {
				if !strings.Contains(err.Error(), "passen nicht zusammen") {
					t.Fatalf("falscher Grund: %v", err)
				}
				return
			}
		}
	}
	t.Fatalf("keine Ecke hat eine Bedingung unter constraints verletzt")
}

// Gesetzte Stellwerte ändern das Verhalten sofort; Zustände und Zeitgeber bleiben.
func TestSetzeStellwerteBehaeltZustand(t *testing.T) {
	L := ladeBeispiel(t, "waermepumpe")
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	netz, puffer := -4.0, 42.0
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 720, Tag: 100, Werte: map[string]EinWert{
		"netz": {Zahl: &netz}, "puffer": {Zahl: &puffer}}, Geraete: map[string]GeraetStamm{}}
	for i := 0; i < 1300; i++ {
		ein.Jetzt = jetzt + float64(i)
		L.Takt(st, ein)
	}
	if !zustandAn(t, L, st, "empfehlung") {
		t.Fatalf("die Empfehlung sollte an sein")
	}
	seit := st.Z["empfehlung"].seit
	werte, err := L.PruefeStellwerte(map[string]any{"puffer_max": "60 °C"})
	if err != nil {
		t.Fatal(err)
	}
	L.SetzeStellwerte(st, werte)
	ein.Jetzt++
	L.Takt(st, ein)
	if !zustandAn(t, L, st, "empfehlung") || st.Z["empfehlung"].seit != seit {
		t.Fatalf("ein gestellter Wert darf den Zustand nicht zurücksetzen")
	}
	if got := st.Stell["puffer_max"]; got.V != 60 || st.Stell["ab_kw"].V != 2 {
		t.Fatalf("Stellwerte nicht übernommen: %+v %+v", got, st.Stell["ab_kw"])
	}
	// Abschalten über den Schalter wirkt im nächsten Takt.
	werte, _ = L.PruefeStellwerte(map[string]any{"sonne_nutzen": "off"})
	L.SetzeStellwerte(st, werte)
	ein.Jetzt++
	L.Takt(st, ein)
	if zustandAn(t, L, st, "empfehlung") {
		t.Fatalf("Sonnenstrom speichern aus muss die Empfehlung beenden")
	}
	if st.Stell["puffer_max"].V != 55 {
		t.Fatalf("ein nicht genannter Stellwert fällt auf seine Vorgabe zurück")
	}
	// Die Hilfe folgt der Stellung des Schalters, mit den Werten von jetzt.
	for _, j := range L.StellwerteJetzt(st, ein) {
		if j.Kennung == "sonne_nutzen" && (j.Wert != "off" || !strings.HasPrefix(j.Hilfe, "Aus:")) {
			t.Fatalf("Hilfe zum Schalter falsch: %+v", j)
		}
		if j.Kennung == "puffer_max" && j.Text != "55 °C" {
			t.Fatalf("Anzeige des Zielwerts falsch: %q", j.Text)
		}
	}
}

// Eine neue Fassung behält Zustände mit gleichem Namen und gleicher Art (Bericht 8.9).
func TestUebernimmLaufBehaeltGleicheZustaende(t *testing.T) {
	alt := ladeBeispiel(t, "waermepumpe")
	jetzt := 1000000.0
	st := alt.NeuerLauf(jetzt)
	st.Z["empfehlung"].an = true
	st.Z["empfehlung"].seit = jetzt - 600
	roh, err := os.ReadFile(dokumentePfad + "/steuerlogik/waermepumpe.logic.json")
	if err != nil {
		t.Fatal(err)
	}
	neuText := strings.Replace(string(roh), `"Wärmepumpe"`, `"Wärmepumpe 2"`, 1)
	neu, err := Lesen([]byte(neuText))
	if err != nil {
		t.Fatal(err)
	}
	ns := neu.UebernimmLauf(alt, st, jetzt+1)
	if !ns.Z["empfehlung"].an || ns.Z["empfehlung"].seit != jetzt-600 {
		t.Fatalf("gleicher Zustand muss bleiben: %+v", ns.Z["empfehlung"])
	}
	ns.Z["empfehlung"].an = false
	if !st.Z["empfehlung"].an {
		t.Fatalf("der neue Lauf teilt sich nichts mit dem alten")
	}
}
