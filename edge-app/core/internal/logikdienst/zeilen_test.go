package logikdienst

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// zeileMit ist die Zeile (ab 1), in der text zuerst vorkommt.
func zeileMit(t *testing.T, quelle, text string) int {
	t.Helper()
	for i, l := range strings.Split(quelle, "\n") {
		if strings.Contains(l, text) {
			return i + 1
		}
	}
	t.Fatalf("„%s“ steht nicht im Text", text)
	return 0
}

func wasser(t *testing.T) string {
	t.Helper()
	roh, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/wasser.logic.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return string(roh)
}

func ersetze(t *testing.T, s, alt, neu string) string {
	t.Helper()
	if strings.Count(s, alt) != 1 {
		t.Fatalf("„%s“ steht nicht genau einmal im Text", alt)
	}
	return strings.Replace(s, alt, neu, 1)
}

// Die unveränderte Logik hat keine Fehler, nur ihre Hinweise ohne Zeile.
func TestMeldungenOhneFehler(t *testing.T) {
	g, err := Pruefe([]byte(wasser(t)), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range g.Bericht.Meldungen {
		if m.Art != MeldungHinweis {
			t.Errorf("unerwartete Meldung %+v", m)
		}
	}
}

// Ein Befund der Prüfung steht an der Zeile seiner Bedingung, nicht an der des Abschnitts.
func TestBefundAnDerZeileDerBedingung(t *testing.T) {
	text := ersetze(t, wasser(t), "Das Netz hilft nicht aus: netz < 0.3 kW", "Das Netz hilft nicht aus: netz < 3 °C")
	g, err := Pruefe([]byte(text), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Bericht.Sperrt {
		t.Fatal("ein Vergleich von Leistung mit Temperatur muss sperren")
	}
	m := g.Bericht.Meldungen[0]
	if m.Art != MeldungFehler || m.Ort != "states.stufe.steps[4].when[2]" || m.Zeile != zeileMit(t, text, "netz < 3 °C") {
		t.Fatalf("Meldung %+v, erwartet Zeile %d", m, zeileMit(t, text, "netz < 3 °C"))
	}
}

// Ein Stellwert mit Vorgabe außerhalb seines Bereichs: die Zeile des Stellwerts.
func TestBefundAmStellwert(t *testing.T) {
	text := ersetze(t, wasser(t), "default: 57 °C", "default: 70 °C")
	g, err := Pruefe([]byte(text), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var gefunden bool
	for _, m := range g.Bericht.Meldungen {
		if m.Art == MeldungFehler && strings.Contains(m.Text, "Vorgabe") {
			gefunden = true
			if m.Zeile != zeileMit(t, text, "default: 70 °C") {
				t.Errorf("Meldung %+v an der falschen Zeile", m)
			}
		}
	}
	if !gefunden {
		t.Fatalf("kein Befund zur Vorgabe: %+v", g.Bericht.Meldungen)
	}
}

// Eine Probe, die nicht besteht, steht an ihrer Zeile und nennt die Abweichung.
func TestProbeAnIhrerZeile(t *testing.T) {
	text := ersetze(t, wasser(t), "expect: {netzheizen: off, heizstab.level: 0, status: Nachtsperre}",
		"expect: {netzheizen: on, heizstab.level: 0, status: Nachtsperre}")
	g, err := Pruefe([]byte(text), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var m *Meldung
	for i := range g.Bericht.Meldungen {
		if g.Bericht.Meldungen[i].Art == MeldungProbe {
			m = &g.Bericht.Meldungen[i]
		}
	}
	if m == nil || m.Zeile != zeileMit(t, text, "- name: Kalte Nacht") || !strings.Contains(m.Text, "Kalte Nacht") {
		t.Fatalf("Meldung %+v", m)
	}
}

// Was der Leser nicht annimmt, steht an der Zeile, die er selbst nennt oder deren Stelle er nennt.
func TestUnlesbarAnDerZeile(t *testing.T) {
	for _, f := range []struct {
		name, alt, neu, zeile string
	}{
		{"Uhrzeit ohne Anführungszeichen", `default: "06:00"`, `default: 06:00`, `default: 06:00`},
		{"unbekannter Schlüssel", "after_restart: 0\n", "after_restart: 0\n    colour: red\n", "colour: red"},
		{"YAML kaputt", "  frei:        known(t) and not warm", "  frei:        known(t) and not warm\n   kaputt: [", "kaputt: ["},
		{"Schritt ohne Änderung", "        by: +1\n", "", "- name: versuch"},
	} {
		t.Run(f.name, func(t *testing.T) {
			text := ersetze(t, wasser(t), f.alt, f.neu)
			_, err := Pruefe([]byte(text), nil, nil)
			var u *Unlesbar
			if !errors.As(err, &u) || !errors.Is(err, ErrUnlesbar) {
				t.Fatalf("erwartet unlesbar, ist %v", err)
			}
			want := zeileMit(t, text, f.zeile)
			// YAML nennt bei einem offenen Ausdruck die Zeile, an der es aufgibt: höchstens eine danach.
			if u.Meldung.Zeile != want && !(f.name == "YAML kaputt" && u.Meldung.Zeile == want+1) {
				t.Fatalf("Meldung %+v, erwartet Zeile %d", u.Meldung, want)
			}
			if u.Meldung.Art != MeldungFehler || u.Meldung.Text == "" {
				t.Fatalf("Meldung %+v", u.Meldung)
			}
		})
	}
}

// Die Stellen werden auch in der kanonischen JSON-Form gefunden.
func TestZeileInJSON(t *testing.T) {
	text := "{\n  \"logic\": 1,\n  \"name\": \"X\",\n  \"tests\": [\n    {\"name\": \"a\"},\n    {\"name\": \"b\"}\n  ]\n}\n"
	z := neueZeilen([]byte(text))
	if got := z.zeile("tests[2]"); got != 6 {
		t.Fatalf("tests[2] in Zeile %d", got)
	}
	if got := z.zeile("tests[2].given"); got != 6 {
		t.Fatalf("eine tiefere Stelle, die fehlt, nennt den tiefsten Teil: Zeile %d", got)
	}
}
