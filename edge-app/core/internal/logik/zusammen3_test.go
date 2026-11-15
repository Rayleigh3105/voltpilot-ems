package logik

import (
	"strings"
	"testing"
)

// Die Wörter des dritten Teils von Stufe 6 (Steuerarten und Heizstab-Regler als Logik des
// Kerns): die Quelle site.surplus, das Signal power eines Geräts, der Verlauf eines Zählers
// (changes, oldest_change) und die Pflicht eines Ausgangs (must_run).

const verlaufLogik = `{
 "logic": 1, "name": "Verlauf",
 "devices": {"g": {"entity": "e-1", "name": "G"}},
 "inputs": {
  "ueber": {"source": "site.surplus", "name": "Überschuss", "max_age": "60 s"},
  "zieht": {"source": "g.power", "name": "Zieht", "max_age": "30 s"}
 },
 "states": {
  "stufe": {"type": "counter", "min": 0, "max": 3, "after_restart": "keep", "steps": [
   {"name": "setze", "set": "if(ueber > 4 kW, 3, if(ueber > 2 kW, 1, 0))", "when": ["known(ueber)"]}
  ]}
 },
 "outputs": {"g": {"level": "stufe"}},
 "status": [
  {"when": "changes(stufe, 1 h) >= 4", "title": "Viel", "type": "idle", "text": "Seit {oldest_change(stufe, 1 h)}"},
  {"else": true, "title": "T", "type": "idle", "text": "S"}
 ]
}`

func eingabeMit(jetzt float64, werte map[string]float64) *Eingabe {
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 600, Tag: 1, DT: 1, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{}}
	for n, v := range werte {
		x := v
		ein.Werte[n] = EinWert{Zahl: &x}
	}
	return ein
}

func TestNeueQuellenTragenKw(t *testing.T) {
	L := liesTest(t, verlaufLogik)
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("Prüfung sperrt: %+v", b.Befunde)
	}
	for _, n := range []string{"ueber", "zieht"} {
		if L.Werte[n].Groesse != GroesseKW {
			t.Errorf("%s: Größe %s, erwartet kW", n, L.Werte[n].Groesse)
		}
	}
}

func TestVerlaufZaehltBetraegeUndVergisst(t *testing.T) {
	L := liesTest(t, verlaufLogik)
	st := L.NeuerLauf(0)
	L.Takt(st, eingabeMit(0, map[string]float64{"ueber": 5}))   // 0 -> 3: drei
	L.Takt(st, eingabeMit(100, map[string]float64{"ueber": 3})) // 3 -> 1: zwei
	erg := L.Takt(st, eingabeMit(200, map[string]float64{"ueber": 3}))
	if erg.Lage.Titel != "Viel" {
		t.Fatalf("fünf Schritte in der Stunde: Lage %q", erg.Lage.Titel)
	}
	if !strings.Contains(erg.Lage.Satz, "3") {
		t.Errorf("ältester Wechsel vor 200 s: Satz %q", erg.Lage.Satz)
	}
	// Nach einer Stunde ist der erste Wechsel (drei) vergessen: zwei bleiben, unter vier.
	erg = L.Takt(st, eingabeMit(3600, map[string]float64{"ueber": 3}))
	if erg.Lage.Titel == "Viel" {
		t.Fatalf("nach einer Stunde zählt der erste Wechsel nicht mehr: %+v", erg.Lage)
	}
	// Der Verlauf ist Geschichte: er bleibt über Sicherung und Neustart.
	roh, err := L.SichereLauf(st)
	if err != nil {
		t.Fatal(err)
	}
	st2, err := L.LadeLauf(roh, 3601)
	if err != nil {
		t.Fatal(err)
	}
	L.Neustart(st2, 3601)
	L.Takt(st2, eingabeMit(3602, map[string]float64{"ueber": 5})) // 1 -> 3: zwei
	if erg := L.Takt(st2, eingabeMit(3603, map[string]float64{"ueber": 5})); erg.Lage.Titel != "Viel" {
		t.Fatalf("nach dem Neustart: zwei plus zwei sind vier, Lage %q", erg.Lage.Titel)
	}
}

func TestVerlaufOhneWechselIstUnbekannt(t *testing.T) {
	q := strings.Replace(verlaufLogik, `"when": "changes(stufe, 1 h) >= 4"`, `"when": "unknown(oldest_change(stufe, 1 h))"`, 1)
	L := liesTest(t, q)
	st := L.NeuerLauf(0)
	if erg := L.Takt(st, eingabeMit(0, map[string]float64{})); erg.Lage.Titel != "Viel" {
		t.Fatalf("ohne Wechsel ist der älteste unbekannt: %+v", erg.Lage)
	}
}

func TestVerlaufNurAnEinemZaehler(t *testing.T) {
	for _, f := range []string{`changes(ueber, 1 h) >= 4`, `changes(stufe, 4) >= 4`, `oldest_change(stufe) > 1 s`} {
		q := strings.Replace(verlaufLogik, `changes(stufe, 1 h) >= 4`, f, 1)
		L, err := Lesen([]byte(q))
		if err != nil {
			continue
		}
		if b := L.Pruefe(nil); !b.Sperrt() {
			t.Errorf("%s: die Prüfung muss sperren", f)
		}
	}
}

const pflichtLogik = `{
 "logic": 1, "name": "Pflicht",
 "devices": {"g": {"entity": "e-1", "name": "G"}},
 "inputs": {"soc": {"source": "battery.soc", "name": "Ladestand", "max_age": "60 s"}},
 "outputs": {"g": {"on_off": "if(soc < 20 %, on, unknown)", "must_run": "soc < 20 %"}},
 "status": [{"else": true, "title": "T", "type": "idle", "text": "S"}]
}`

func TestPflichtNurInDerUebersetzungEinerSteuerart(t *testing.T) {
	L := liesTest(t, pflichtLogik)
	b := L.Pruefe(nil)
	if !b.Sperrt() || !strings.Contains(b.Befunde[0].Text, "Steuerart") {
		t.Fatalf("ohne Erlaubnis muss die Prüfung must_run sperren: %+v", b.Befunde)
	}
	L.PflichtErlaubt = true
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("mit Erlaubnis sperrt nichts: %+v", b.Befunde)
	}
	st := L.NeuerLauf(0)
	a := L.Takt(st, eingabeMit(0, map[string]float64{"soc": 10})).Ausgaenge["g"]
	if !a.HatPflicht || !a.Pflicht || a.Ein == nil || !*a.Ein {
		t.Fatalf("Ladestand 10 %%: ein mit Pflicht erwartet, %+v", a)
	}
	a = L.Takt(st, eingabeMit(1, map[string]float64{"soc": 50})).Ausgaenge["g"]
	if a.Pflicht || a.Ein != nil {
		t.Fatalf("Ladestand 50 %%: kein Wunsch, keine Pflicht, %+v", a)
	}
	a = L.Takt(st, eingabeMit(2, map[string]float64{})).Ausgaenge["g"]
	if a.Pflicht {
		t.Fatalf("ohne Wert: keine Pflicht, %+v", a)
	}
}

func TestPflichtAlleinIstKeinAusgang(t *testing.T) {
	q := strings.Replace(pflichtLogik, `"on_off": "if(soc < 20 %, on, unknown)", `, "", 1)
	if _, err := Lesen([]byte(q)); err == nil || !strings.Contains(err.Error(), "must_run") {
		t.Fatalf("must_run allein muss der Leser ablehnen: %v", err)
	}
}
