package logik

import (
	"strings"
	"testing"
)

// Verhalten, das die Vertragsvektoren nicht abdecken: keep nach Neustart, Meldungs-
// Wiederholung, Fenster über Mitternacht, die deutsche Schreibweise, die E2-Regel,
// verbotene Namen und der strenge Leser.

func liesTest(t *testing.T, quelle string) *Logik {
	t.Helper()
	L, err := Lesen([]byte(quelle))
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	return L
}

const kleineLogik = `{
 "logic": 1, "name": "T",
 "devices": {"g": {"entity": "e-1", "name": "G"}},
 "inputs": {"netz": {"source": "site.grid", "name": "Netz", "max_age": "60 s"}},
 "settings": {
  "schwelle": {"name": "Schwelle", "default": "1 kW", "range": ["0.5 kW", "5 kW"]},
  "plan": {"name": "Plan", "type": "schedule", "default": [{"days": "mon-fri", "from": "22:00", "to": "06:00"}]}
 },
 "states": {
  "merkt": {"type": "boolean", "on_when": "netz > schwelle", "off_when": "netz < 0 kW", "after_restart": "keep"},
  "zaehlt": {"type": "counter", "min": 0, "max": 5, "after_restart": "keep",
   "steps": [{"name": "hoch", "by": 1, "when": "netz > schwelle", "then": "start(wartet) if on"}]},
  "wartet": {"type": "timer", "duration": "10 min", "after_restart": "keep"}
 },
 "outputs": {"g": {"on_off": "merkt"}},
 "notifications": [{"when": "netz > 2 kW", "to": ["customer"], "text": "Hoch: {netz}", "repeat_after": "2 min"}],
 "status": [
  {"when": "in_schedule(plan)", "title": "Nachts", "type": "idle", "text": "Plan: {plan}"},
  {"else": true, "title": "Tags", "type": "waiting", "text": "Schwelle {schwelle}"}
 ]
}`

func einfacheEingabe(jetzt float64, netzKw float64) *Eingabe {
	v := netzKw
	return &Eingabe{
		Jetzt: jetzt, UhrMin: 720, Tag: 1, DT: 1,
		Werte:   map[string]EinWert{"netz": {Zahl: &v}},
		Geraete: map[string]GeraetStamm{"g": {}},
	}
}

func TestNeustartKeep(t *testing.T) {
	L := liesTest(t, kleineLogik)
	st := L.NeuerLauf(0)
	// Nach dem ersten Start: keep heißt aus, 0, Zeitgeber steht (es gibt nichts zu behalten).
	if st.Z["merkt"].an || st.Z["zaehlt"].wert != 0 || st.Z["wartet"].bis != nil {
		t.Fatalf("erster Start: %v %v %v", st.Z["merkt"].an, st.Z["zaehlt"].wert, st.Z["wartet"].bis)
	}
	for s := 0.0; s < 3; s++ {
		L.Takt(st, einfacheEingabe(s, 3))
	}
	if !st.Z["merkt"].an || st.Z["zaehlt"].wert != 3 || st.Z["wartet"].bis == nil {
		t.Fatalf("vor dem Neustart: an=%v wert=%d wartet=%v", st.Z["merkt"].an, st.Z["zaehlt"].wert, st.Z["wartet"].bis)
	}
	if st.Z["zaehlt"].zuletzt != "hoch" {
		t.Fatalf("zuletzt = %q", st.Z["zaehlt"].zuletzt)
	}
	seitVorher := st.Z["zaehlt"].seit
	L.Neustart(st, 100)
	// keep behält nur den Wert (beim Zeitgeber die Frist); since/last zählen ab dem Neustart.
	if !st.Z["merkt"].an || st.Z["zaehlt"].wert != 3 || st.Z["wartet"].bis == nil {
		t.Fatalf("nach dem Neustart: an=%v wert=%d wartet=%v", st.Z["merkt"].an, st.Z["zaehlt"].wert, st.Z["wartet"].bis)
	}
	if st.Z["zaehlt"].zuletzt != "start" || st.Z["zaehlt"].seit == seitVorher || st.Z["zaehlt"].seit != 100 {
		t.Fatalf("nach dem Neustart: zuletzt=%q seit=%v", st.Z["zaehlt"].zuletzt, st.Z["zaehlt"].seit)
	}
}

func TestMeldungWiederholtSichFruehestensNachWieder(t *testing.T) {
	L := liesTest(t, kleineLogik)
	st := L.NeuerLauf(0)
	meldungen := 0
	for s := 0.0; s < 400; s++ {
		netz := 3.0
		// die Bedingung fällt zweimal kurz ab: bei 30 s und bei 200 s
		if s == 30 || s == 200 {
			netz = 1.0
		}
		r := L.Takt(st, einfacheEingabe(s, netz))
		for _, e := range r.Ereignisse {
			if e.Was == "meldung" {
				meldungen++
				if s != 0 && s != 201 {
					t.Errorf("Meldung zur Sekunde %v", s)
				}
				if e.Text != "Hoch: 3,0\u00a0kW" {
					t.Errorf("Meldungstext %q", e.Text)
				}
			}
		}
	}
	// Bei 31 s ist die Wiederholfrist (2 min) noch nicht um, bei 201 s ist sie es.
	if meldungen != 2 {
		t.Fatalf("%d Meldungen, erwartet 2", meldungen)
	}
}

func TestZeitplanUeberMitternacht(t *testing.T) {
	L := liesTest(t, kleineLogik)
	st := L.NeuerLauf(0)
	lage := func(wochentag int, uhrMin float64) string {
		ein := einfacheEingabe(0, 0)
		ein.Wochentag = wochentag
		ein.UhrMin = uhrMin
		return L.Takt(st, ein).Lage.Titel
	}
	faelle := []struct {
		tag   int
		uhr   float64
		titel string
	}{
		{0, 23 * 60, "Nachts"},  // Montagabend im Fenster
		{1, 3 * 60, "Nachts"},   // Dienstagmorgen: das Fenster von Montag reicht hinein
		{5, 3 * 60, "Nachts"},   // Samstagmorgen: das Fenster von Freitag reicht hinein
		{5, 23 * 60, "Tags"},    // Samstagabend beginnt kein Fenster
		{0, 12 * 60, "Tags"},    // Montagmittag
		{0, 6 * 60, "Tags"},     // "to" zählt nicht mit
		{0, 22 * 60, "Nachts"},  // "from" zählt mit
		{6, 23*60 + 59, "Tags"}, // Sonntagabend beginnt kein Fenster
	}
	for _, f := range faelle {
		if titel := lage(f.tag, f.uhr); titel != f.titel {
			t.Errorf("Tag %d, %v min: „%s“, erwartet „%s“", f.tag, f.uhr, titel, f.titel)
		}
	}
}

func TestZeigeSchreibtWieDasLabor(t *testing.T) {
	faelle := []struct {
		wert Wert
		soll string
	}{
		{zahlW(57.5, GroesseTemp), "57,5 °C"},
		{zahlW(57, GroesseTemp), "57 °C"},
		{zahlW(13.5, GroesseKW), "14 kW"}, // toFixed-Hälfte: weg vom Nullpunkt
		{zahlW(-0.3, GroesseKW), "−0,3 kW"},
		{zahlW(0.25, GroesseKW), "0,25 kW"},
		{zahlW(2.5, GroesseKW), "2,5 kW"},
		{zahlW(0.001, GroesseKW), "0,0 kW"}, // unter 0,005 gilt null, kW unter 10 mit einer Stelle
		{zahlW(90, GroesseDauer), "2 min"},  // 1,5 min rundet weg vom Nullpunkt
		{zahlW(5400, GroesseDauer), "1,5 h"},
		{zahlW(7200, GroesseDauer), "2 h"},
		{zahlW(45, GroesseDauer), "45 s"},
		{zahlW(95, GroesseProzent), "95 %"},
		{zahlW(5, GroesseWinkel), "5°"},
		{zahlW(390, GroesseUhrzeit), "06:30"},
		{boolW(true), "an"},
		{boolW(false), "aus"},
		{unbekanntW(), "kein Wert"},
	}
	for _, f := range faelle {
		if ist := Zeige(f.wert); ist != f.soll {
			t.Errorf("Zeige(%v %s) = %q, erwartet %q", f.wert.V, f.wert.D, ist, f.soll)
		}
	}
	// Die toFixed-Hälften des Labors (V8): 2.5 -> 3, -2.5 -> -3, 0.25 -> 0.3, 0.615 -> 0.61.
	ties := []struct {
		v       float64
		stellen int
		soll    string
	}{
		{2.5, 0, "3"}, {-2.5, 0, "-3"}, {1.5, 0, "2"}, {0.25, 1, "0.3"}, {-0.25, 1, "-0.3"},
		{0.615, 2, "0.61"}, {1.005, 2, "1.00"}, {10.5, 0, "11"}, {0.5, 0, "1"},
	}
	for _, f := range ties {
		if ist := toFixed(f.v, f.stellen); ist != f.soll {
			t.Errorf("toFixed(%v, %d) = %q, erwartet %q", f.v, f.stellen, ist, f.soll)
		}
	}
}

func TestZielwertBrauchtBereich(t *testing.T) {
	quelle := strings.Replace(kleineLogik,
		`"schwelle": {"name": "Schwelle", "default": "1 kW", "range": ["0.5 kW", "5 kW"]}`,
		`"ziel": {"name": "Ziel", "default": "50 °C"}`, 1)
	quelle = strings.Replace(quelle, `"Schwelle {schwelle}"`, `"Ziel {ziel}"`, 1)
	quelle = strings.Replace(quelle, `netz > schwelle`, `netz > 1 kW`, -1)
	L := liesTest(t, quelle)
	bericht := L.Pruefe(nil)
	gefunden := false
	for _, b := range bericht.Befunde {
		if strings.Contains(b.Text, "Zielwert") && strings.Contains(b.Text, "Bereich") {
			gefunden = true
		}
	}
	if !gefunden || !bericht.Sperrt() {
		t.Fatalf("ein Zielwert ohne Bereich muss sperren (E2); Befunde: %v", bericht.Befunde)
	}
	if !L.Stellwerte["ziel"].Zielwert() {
		t.Error("ein Stellwert in °C ist ein Zielwert (E2)")
	}
	if L.Stellwerte["schwelle"] != nil {
		t.Error("Testaufbau: schwelle sollte ersetzt sein")
	}
}

func TestVerboteneNamenSperren(t *testing.T) {
	quelle := strings.Replace(kleineLogik, `"merkt":`, `"on":`, 1)
	quelle = strings.Replace(quelle, `"on_off": "merkt"`, `"on_off": "netz > 1 kW"`, 1)
	L := liesTest(t, quelle)
	bericht := L.Pruefe(nil)
	gefunden := false
	for _, b := range bericht.Befunde {
		if strings.Contains(b.Text, "„on“") && strings.Contains(b.Text, "nicht erlaubt") {
			gefunden = true
		}
	}
	if !gefunden {
		t.Fatalf("der Name „on“ muss sperren (Vertrag 17.2); Befunde: %v", bericht.Befunde)
	}
}

func TestOhneProbenNurHinweis(t *testing.T) {
	L := liesTest(t, kleineLogik)
	bericht := L.Pruefe(nil)
	if len(bericht.Befunde) > 0 {
		t.Fatalf("unerwartete Befunde: %v", bericht.Befunde)
	}
	if bericht.Sperrt() {
		t.Fatal("eine Logik ohne Proben darf scharf gehen (E5 = C)")
	}
	gefunden := false
	for _, h := range bericht.Hinweise {
		if h == "Keine Proben: Verhalten nicht belegt" {
			gefunden = true
		}
	}
	if !gefunden {
		t.Fatalf("Hinweis fehlt; Hinweise: %v", bericht.Hinweise)
	}
}

func TestLeserIstStreng(t *testing.T) {
	schlecht := []struct {
		aendern [2]string
		meldung string
	}{
		{[2]string{`"logic": 1`, `"logic": 2`}, "Sprachversion"},
		{[2]string{`"name": "T",`, `"name": "T", "extra": 1,`}, "unbekannter Schlüssel"},
		{[2]string{`"entity": "e-1", "name": "G"`, `"entity": "e-1", "name": "G", "x": 1`}, "unbekannter Schlüssel"},
		{[2]string{`"max_age": "60 s"`, `"max_age": "60 kW"`}, "Dauer"},
		{[2]string{`"after_restart": "keep"},
  "zaehlt"`, `"after_restart": "maybe"},
  "zaehlt"`}, "after_restart"},
	}
	for _, f := range schlecht {
		quelle := strings.Replace(kleineLogik, f.aendern[0], f.aendern[1], 1)
		if quelle == kleineLogik {
			t.Fatalf("Testaufbau: %q nicht gefunden", f.aendern[0])
		}
		_, err := Lesen([]byte(quelle))
		if err == nil || !strings.Contains(err.Error(), f.meldung) {
			t.Errorf("%s: erwartet Fehler mit „%s“, bekam %v", f.aendern[1], f.meldung, err)
		}
	}
}

func TestZustaendeLaufenInTextreihenfolge(t *testing.T) {
	// b liest a im selben Takt: steht b hinter a, sieht es den neuen Wert.
	quelle := `{
 "logic": 1, "name": "T",
 "devices": {"g": {"entity": "e-1", "name": "G"}},
 "inputs": {"netz": {"source": "site.grid", "name": "Netz"}},
 "states": {
  "a": {"type": "boolean", "on_when": "netz > 1 kW", "off_when": "netz <= 1 kW", "after_restart": "off"},
  "b": {"type": "boolean", "on_when": "a", "off_when": "not a", "after_restart": "off"}
 },
 "outputs": {"g": {"on_off": "b"}},
 "status": [{"else": true, "title": "A", "type": "idle", "text": ""}]
}`
	L := liesTest(t, quelle)
	st := L.NeuerLauf(0)
	r := L.Takt(st, einfacheEingabe(0, 3))
	if !st.Z["a"].an || !st.Z["b"].an || r.Ausgaenge["g"].Ein == nil || !*r.Ausgaenge["g"].Ein {
		t.Fatalf("b muss den neuen Wert von a sehen: a=%v b=%v", st.Z["a"].an, st.Z["b"].an)
	}
}

func TestDreiwertigesRechnen(t *testing.T) {
	L := liesTest(t, kleineLogik)
	st := L.NeuerLauf(0)
	ein := einfacheEingabe(0, 3)
	rechne := func(formel string) Wert {
		b, err := lies(formel)
		if err != nil {
			t.Fatalf("lies(%q): %v", formel, err)
		}
		x, err := L.rechne(st, ein, b, 0)
		if err != nil {
			t.Fatalf("rechne(%q): %v", formel, err)
		}
		return x
	}
	einOhne := einfacheEingabe(0, 0)
	einOhne.Werte = map[string]EinWert{}
	faelle := []struct {
		formel string
		soll   Wert
	}{
		{"false and unknown(netz)", boolW(false)},
		{"true or unknown(netz)", boolW(true)},
		{"300 W == 0.3 kW", boolW(true)},
		{"57 °C - 3 K < 55 °C", boolW(true)},
		{"60 °C - 57 °C == 3 K", boolW(true)},
		{"min(2 kW, netz)", zahlW(2, GroesseKW)},
		{"if(netz > 1 kW, 1, 0)", zahlW(1, GroesseZahl)},
		{"-netz", zahlW(-3, GroesseKW)},
		{"time_window(\"22:00\", \"06:00\")", boolW(false)}, // 12:00 liegt außerhalb
		{"time_window(\"06:00\", \"22:00\")", boolW(true)},
		{"time_window(\"06:00\", \"06:00\")", boolW(true)}, // gleich heißt rund um die Uhr
	}
	for _, f := range faelle {
		ist := rechne(f.formel)
		if ist != f.soll {
			t.Errorf("%s = %+v, erwartet %+v", f.formel, ist, f.soll)
		}
	}
	// Ein fehlender Wert macht ein Ergebnis unbekannt.
	st2 := L.NeuerLauf(0)
	b, _ := lies("netz > 1 kW")
	x, err := L.rechne(st2, einOhne, b, 0)
	if err != nil || x.Art != WertUnbekannt {
		t.Errorf("netz fehlt: %+v, %v", x, err)
	}
	// Alter über max_age heißt unbekannt.
	alt := einfacheEingabe(0, 3)
	w := alt.Werte["netz"]
	w.Alter = 61
	alt.Werte["netz"] = w
	x, err = L.rechne(st2, alt, b, 0)
	if err != nil || x.Art != WertUnbekannt {
		t.Errorf("netz zu alt: %+v, %v", x, err)
	}
	// Einheitenfehler sind Fehler, keine Werte.
	falsch, _ := lies("netz > 1 °C")
	if _, err := L.rechne(st2, einfacheEingabe(0, 3), falsch, 0); err == nil {
		t.Error("kW gegen °C muss ein Fehler sein")
	}
}

func TestHilfeJeNachStellung(t *testing.T) {
	quelle := strings.Replace(kleineLogik,
		`"plan": {"name": "Plan", "type": "schedule", "default": [{"days": "mon-fri", "from": "22:00", "to": "06:00"}]}`,
		`"plan": {"name": "Plan", "type": "schedule", "default": [{"days": "mon-fri", "from": "22:00", "to": "06:00"}]},
   "an_aus": {"name": "Schalter", "type": "boolean", "default": "off",
    "help": {"when_on": "An bis {schwelle}.", "when_off": "Aus."}}`, 1)
	L := liesTest(t, quelle)
	st := L.NeuerLauf(0)
	ein := einfacheEingabe(0, 0)
	satz, err := L.Hilfe(st, ein, "an_aus")
	if err != nil || satz != "Aus." {
		t.Fatalf("Hilfe aus: %q, %v", satz, err)
	}
	st.Stell["an_aus"] = boolW(true)
	satz, err = L.Hilfe(st, ein, "an_aus")
	if err != nil || satz != "An bis 1,0 kW." {
		t.Fatalf("Hilfe an: %q, %v", satz, err)
	}
}
