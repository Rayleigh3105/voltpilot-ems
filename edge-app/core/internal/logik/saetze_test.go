package logik

import (
	"strings"
	"testing"
)

// Eine Bedingung ohne Namen liest der Kunde als Satz aus dem Wortschatz, nie als Formel; was sich
// nicht übersetzen lässt (eine Formel aus formulas, ein Zustand ohne Namen), heißt allgemeinSatz,
// und die Prüfung nennt die Stelle.
func TestBedingungOhneNamenWirdEinSatz(t *testing.T) {
	L, err := Lesen([]byte(`{"logic": 1, "name": "Probe", "devices": {"stab": {"entity": "e1", "name": "Heizstab"}},
 "inputs": {"t": {"source": "f.temperature", "name": "Speicher"}, "netz": {"source": "site.grid", "name": "Netzbezug"},
  "speicher": {"source": "battery.power", "name": "Batterie lädt mit"}, "ladestand": {"source": "battery.soc", "name": "Batterie"}},
 "settings": {"ziel": {"name": "Mit Sonnenstrom bis", "default": "57 °C", "range": ["45 °C", "65 °C"], "step": "1 K"},
  "winter": {"name": "Winterregelung", "type": "boolean", "default": "off"},
  "ab": {"name": "Netz erlaubt ab", "default": "06:00"}, "bis": {"name": "Netz erlaubt bis", "default": "22:00"}},
 "formulas": {"frei": "known(t) and t < ziel"},
 "states": {
  "warm": {"type": "boolean", "name": "Speicher ist warm", "on_when": "t >= ziel", "off_when": "unknown(t) or t < ziel - 3 K", "after_restart": "off"},
  "netz": {"type": "boolean", "on_when": "winter and time_window(ab, bis)", "off_when": "not winter or holds(netz > 0.3 kW, 10 min)", "after_restart": "off"},
  "stufe": {"type": "counter", "min": 0, "max": 3, "after_restart": 0, "steps": [
   {"name": "blind", "set": 0, "when": "holds(unknown(netz) or unknown(speicher) or unknown(ladestand), 1 min)"},
   {"name": "voll", "set": 0, "when": "stufe > 0 and not frei"},
   {"name": "warm_genug", "set": 0, "when": "not warm"}]}},
 "outputs": {"stab": {"level": "stufe"}},
 "status": [{"else": true, "title": "Läuft", "type": "idle", "text": "Gut."}]}`))
	if err != nil {
		t.Fatal(err)
	}
	satz := func(z, feld, schritt string) (string, bool) {
		var b []Bedingung
		zu := L.zustand[z]
		switch feld {
		case "on_when":
			b = zu.An
		case "off_when":
			b = zu.Aus
		default:
			for _, s := range zu.Schritte {
				if s.Name == schritt {
					b = s.Alle
				}
			}
		}
		return L.bedingungSatz(b[0].Baum)
	}
	nb := " "
	for _, f := range []struct{ z, feld, schritt, soll string }{
		{"warm", "on_when", "", "„Speicher“ ist mindestens „Mit Sonnenstrom bis“"},
		{"warm", "off_when", "", "„Speicher“ hat keinen Wert oder „Speicher“ liegt mehr als 3" + nb + "K unter „Mit Sonnenstrom bis“"},
		{"netz", "on_when", "", "„Winterregelung“ ist an und die Uhrzeit liegt zwischen „Netz erlaubt ab“ und „Netz erlaubt bis“"},
		{"netz", "off_when", "", "„Winterregelung“ ist aus oder „Netzbezug“ liegt über 0,3" + nb + "kW, seit mindestens 10" + nb + "min"},
		{"stufe", "when", "blind", "Kein Wert bei „Netzbezug“, „Batterie lädt mit“ oder „Batterie“, seit mindestens 1" + nb + "min"},
		{"stufe", "when", "warm_genug", "„Speicher ist warm“ trifft nicht zu"},
	} {
		if got, ok := satz(f.z, f.feld, f.schritt); !ok || got != f.soll {
			t.Errorf("%s %s %s: %q (übersetzt: %v), erwartet %q", f.z, f.feld, f.schritt, got, ok, f.soll)
		}
	}
	// Eine Formel aus formulas und ein Zähler ohne Namen haben kein Wort: der allgemeine Satz.
	if got, ok := satz("stufe", "when", "voll"); ok || got != allgemeinSatz {
		t.Errorf("voll: %q (übersetzt: %v), erwartet den allgemeinen Satz", got, ok)
	}
	hinweis := ""
	for _, h := range L.Pruefe(nil).Hinweise {
		if strings.HasPrefix(h, "Bedingungen ohne Namen") {
			hinweis = h
		}
	}
	if !strings.Contains(hinweis, "states.stufe.steps.voll.when („stufe > 0 and not frei“)") ||
		strings.Contains(hinweis, "blind") || strings.Contains(hinweis, "states.warm") {
		t.Errorf("der Hinweis nennt genau die Bedingung ohne Wort: %q", hinweis)
	}

	// Im Blatt „Warum?“ steht der Satz, nie die Formel; der allgemeine ist als solcher markiert.
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	temp := 50.0
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 720, Tag: 100, Werte: map[string]EinWert{"t": {Zahl: &temp}},
		Geraete: map[string]GeraetStamm{}}
	L.Takt(st, ein)
	for _, g := range L.Warum(st, ein) {
		for _, b := range g.Bedingungen {
			if strings.ContainsAny(b.Name, "()<>=") || strings.Contains(b.Name, "unknown") {
				t.Errorf("eine Formel im Blatt: %q", b.Name)
			}
			if b.Allgemein != (b.Name == allgemeinSatz) {
				t.Errorf("Allgemein passt nicht zum Satz: %+v", b)
			}
		}
	}
}
