package logik

import (
	"strings"
	"testing"
)

// Das Wort „unknown“ als Wert (Stufe 6, Zusammenführen): ein Zweig von if() ohne Wert. Ein
// Ausgang, der so rechnet, ist kein Wunsch - wie eine Regel „voll einschalten“, die außerhalb
// ihrer Bedingung nichts will. An jeder anderen Stelle ist das Wort ein Fehler der Prüfung.

const vollLogik = `{
 "logic": 1, "name": "Voll",
 "devices": {"g": {"entity": "e-1", "name": "G"}},
 "inputs": {"netz": {"source": "site.grid", "name": "Netz", "max_age": "60 s"}},
 "outputs": {"g": {"setpoint": "if(netz < -2 kW, 3 kW, unknown)"}},
 "status": [{"else": true, "title": "T", "type": "idle", "text": "S"}]
}`

func TestUnknownAlsZweigIstKeinWunsch(t *testing.T) {
	L := liesTest(t, vollLogik)
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("Prüfung sperrt: %+v", b)
	}
	st := L.NeuerLauf(0)
	erg := L.Takt(st, einfacheEingabe(0, -3))
	a := erg.Ausgaenge["g"]
	if !a.HatSollwert || a.Sollwert == nil || a.Sollwert.V != 3 || a.Sollwert.D != GroesseKW {
		t.Fatalf("Bedingung wahr: Sollwert 3 kW erwartet, %+v", a)
	}
	erg = L.Takt(st, einfacheEingabe(1, 0.5))
	if a := erg.Ausgaenge["g"]; !a.HatSollwert || a.Sollwert != nil {
		t.Fatalf("Bedingung falsch: kein Wunsch erwartet, %+v", a)
	}
	// Ohne Netzwert ist die Bedingung unbekannt: ebenfalls kein Wunsch.
	ein := einfacheEingabe(2, 0)
	ein.Werte = map[string]EinWert{}
	if a := L.Takt(st, ein).Ausgaenge["g"]; a.Sollwert != nil {
		t.Fatalf("Netz unbekannt: kein Wunsch erwartet, %+v", a)
	}
}

func TestUnknownNurAlsZweig(t *testing.T) {
	for _, f := range []string{
		`"on_off": "unknown"`,
		`"setpoint": "if(netz < 0 kW, unknown, unknown)"`,
		`"setpoint": "netz + unknown"`,
		`"on_off": "netz > unknown"`,
	} {
		quelle := strings.Replace(vollLogik, `"setpoint": "if(netz < -2 kW, 3 kW, unknown)"`, f, 1)
		L, err := Lesen([]byte(quelle))
		if err != nil {
			continue // der Leser lehnt schon ab
		}
		if b := L.Pruefe(nil); !b.Sperrt() {
			t.Errorf("%s: die Prüfung muss sperren", f)
		}
	}
}
