package textform

import (
	"os"
	"strings"
	"testing"
)

// Die Schreibform jeder Vektor-Logik muss genau die abgelegte kanonische Form ergeben.
// Das ist der Vertragstest der zweiten Lesung: Kern (JSON) und Schreibform-Leser (YAML)
// sehen dasselbe Dokument, einschließlich der on/off-Regel.

const vertragPfad = "../../../../../docs/contracts/v2/steuerlogik"

var logiken = []string{"heizung-treu", "heizung", "wasser", "kuehlraum", "waermepumpe", "klima", "waermepumpe-modbus"}

func TestSchreibformErgibtKanonischeForm(t *testing.T) {
	for _, name := range logiken {
		t.Run(name, func(t *testing.T) {
			yamlRoh, err := os.ReadFile(vertragPfad + "/" + name + ".logic.yaml")
			if err != nil {
				t.Fatalf("Schreibform lesen: %v", err)
			}
			jsonRoh, err := os.ReadFile(vertragPfad + "/" + name + ".logic.json")
			if err != nil {
				t.Fatalf("kanonische Form lesen: %v", err)
			}
			a, err := Lies(yamlRoh)
			if err != nil {
				t.Fatalf("Schreibform wandeln: %v", err)
			}
			b, err := LiesJSON(jsonRoh)
			if err != nil {
				t.Fatalf("kanonische Form wandeln: %v", err)
			}
			if ok, wo := Gleich(a, b); !ok {
				t.Fatalf("Schreibform und kanonische Form weichen ab: %s", wo)
			}
		})
	}
}

// Die on/off-Falle (Vertrag 17.2): feste Werte on/true und off/false werden on und off;
// andere Schreibweisen von Ja und Nein sind Fehler, ebenso unzitierte Uhrzeiten.
func TestOnOffRegel(t *testing.T) {
	gut := "logic: 1\nname: T\ndevices:\n  g: {entity: e, name: G}\nsettings:\n  w:\n    name: W\n    type: boolean\n    default: off\n  x: {name: X, type: boolean, default: true}\noutputs:\n  g: {on_off: w}\nstatus:\n  - {else: true, title: A, type: idle, text: \"\"}\n"
	k, err := Lies([]byte(gut))
	if err != nil {
		t.Fatalf("Lies: %v", err)
	}
	// default: off -> "off", default: true -> "on", else: true bleibt ein Ja.
	pfad := func(k *Knoten, weg ...any) *Knoten {
		for _, schritt := range weg {
			switch s := schritt.(type) {
			case string:
				k = k.Kinder[index(t, k.Schluessel, s)]
			case int:
				k = k.Liste[s]
			}
		}
		return k
	}
	if w := pfad(k, "settings", "w", "default"); w.Art != 's' || w.Text != "off" {
		t.Errorf("default off: %+v", w)
	}
	if w := pfad(k, "settings", "x", "default"); w.Art != 's' || w.Text != "on" {
		t.Errorf("default true: %+v", w)
	}
	if w := pfad(k, "status", 0, "else"); w.Art != 'b' || !w.Bool {
		t.Errorf("else true: %+v", w)
	}

	schlecht := []struct{ zeile, meldung string }{
		{"default: Off", "schreibe on oder off"},
		{"default: OFF", "schreibe on oder off"},
		{"default: yes", "schreibe on oder off"},
		{"default: no", "schreibe on oder off"},
		{"default: TRUE", "schreibe on oder off"},
		{"default: 06:00", "Anführungszeichen"},
		{"default: 0,3", "Dezimalzahlen mit Punkt"},
	}
	for _, f := range schlecht {
		quelle := strings.Replace(gut, "default: off", f.zeile, 1)
		if _, err := Lies([]byte(quelle)); err == nil || !strings.Contains(err.Error(), f.meldung) {
			t.Errorf("%s: erwartet Fehler mit „%s“, bekam %v", f.zeile, f.meldung, err)
		}
	}
	// Kein Schlüssel ist ein Ja oder Nein.
	if _, err := Lies([]byte(strings.Replace(gut, "  w:", "  on:", 1))); err == nil || !strings.Contains(err.Error(), "nicht erlaubt") {
		t.Errorf("Schlüssel on: erwartet Fehler, bekam %v", err)
	}
	// In Anführungszeichen bleibt ein Wort ein Wort.
	zitiert := strings.Replace(gut, "title: A", "title: \"on\"", 1)
	k2, err := Lies([]byte(zitiert))
	if err != nil {
		t.Fatalf("zitiertes on: %v", err)
	}
	if w := pfad(k2, "status", 0, "title"); w.Art != 's' || w.Text != "on" {
		t.Errorf("zitiertes on: %+v", w)
	}
}

func index(t *testing.T, liste []string, s string) int {
	t.Helper()
	for i, x := range liste {
		if x == s {
			return i
		}
	}
	t.Fatalf("Schlüssel „%s“ fehlt in %v", s, liste)
	return -1
}

// Die JSON-Ausgabe eines gelesenen Baums liest sich verlustfrei zurück -
// für jede Vektor-Logik (die zweite Hälfte des Dienst-Wegs: YAML -> JSON).
func TestJSONRundreise(t *testing.T) {
	for _, name := range logiken {
		t.Run(name, func(t *testing.T) {
			roh, err := os.ReadFile(vertragPfad + "/" + name + ".logic.yaml")
			if err != nil {
				t.Fatalf("Schreibform lesen: %v", err)
			}
			k, err := Lies(roh)
			if err != nil {
				t.Fatalf("Lies: %v", err)
			}
			js, err := k.JSON()
			if err != nil {
				t.Fatalf("JSON: %v", err)
			}
			wieder, err := LiesJSON(js)
			if err != nil {
				t.Fatalf("LiesJSON der eigenen Ausgabe: %v", err)
			}
			if ok, wo := Gleich(k, wieder); !ok {
				t.Fatalf("Rundreise verliert: %s", wo)
			}
		})
	}
}
