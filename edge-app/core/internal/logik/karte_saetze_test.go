package logik

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Die Karte zeigt den Satz der Lage und den Hilfesatz eines Schalters nebeneinander; beide setzen die
// Werte von jetzt ein, also können sie sich nicht widersprechen. Belegt am Heizungs-Beispiel im
// Winter (kalt, im Zeitfenster): Lage und Hilfesatz der Winterregelung aus EINEM Lauf, festgehalten
// als Vertragsbeispiel, aus dem die Bühne des Portals die Karte „Heizung“ baut
// (frontend/portal/e2e/steuerlogik-karte.tsx, ?stand=winter).
func TestKarteWinterSaetzeAusEinemLauf(t *testing.T) {
	L := ladeBeispiel(t, "heizung")
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	L.SetzeStellwerte(st, map[string]Wert{"winter": {Art: WertBool, B: true}})
	z := func(v float64) EinWert { return EinWert{Zahl: &v} }
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 6*60 + 30, Tag: 100, Werte: map[string]EinWert{
		"t1": z(38.5), "t2": z(30), "t3": z(30), "netz": z(0.4), "speicher": z(0), "ladestand": z(20), "sonne": z(-10)},
		Geraete: map[string]GeraetStamm{}}
	var erg TaktErgebnis
	for i := 0; i < 180; i++ {
		ein.Jetzt = jetzt + float64(i)
		ein.UhrMin = 6*60 + 30 + float64(i)/60
		erg = L.Takt(st, ein)
	}
	var winter StellwertJetzt
	for _, s := range L.StellwerteJetzt(st, ein) {
		if s.Kennung == "winter" {
			winter = s
		}
	}
	dle := erg.Ausgaenge["dle"]
	if erg.Lage.Titel != "Heizt aus dem Netz" || winter.Hilfe == "" || !dle.HatStufe || dle.Stufe != 3 {
		t.Fatalf("Lage %+v, Winterregelung %+v, Durchlauferhitzer %+v", erg.Lage, winter, dle)
	}
	saetze := map[string]any{
		"logik": L.Name,
		"lage":  map[string]any{"nr": erg.Lage.Nr, "titel": erg.Lage.Titel, "art": erg.Lage.Art, "satz": erg.Lage.Satz},
		"winter": map[string]any{"kennung": "winter", "name": L.Stellwerte["winter"].Name, "wert": winter.Wert,
			"text": winter.Text, "hilfe": winter.Hilfe},
		"geraet": map[string]any{"kennung": "dle", "name": L.Geraete["dle"].Name, "stufe": dle.Stufe},
	}
	roh, err := json.MarshalIndent(saetze, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	roh = append(roh, '\n')
	pfad := filepath.Join(dokumentePfad, "examples", "steuerlogik-karte-saetze.heizung-winter.json")
	if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
		if err := os.WriteFile(pfad, roh, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	soll, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 legt sie an)", err)
	}
	if string(soll) != string(roh) {
		t.Fatalf("%s weicht vom Lauf ab (VP_FIXTURES_SCHREIBEN=1 nach gewollter Änderung):\n%s", pfad, roh)
	}
}
