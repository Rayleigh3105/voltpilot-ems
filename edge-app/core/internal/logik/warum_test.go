package logik

import (
	"strings"
	"testing"
)

// Die Liste „Warum?“ nennt je Zustand die Bedingungen, die als Nächstes entscheiden, mit Haken
// und Werten - und verändert den Lauf beim Lesen nicht (holds-Zähler bleiben, wo sie waren).
func TestWarumNenntBedingungenOhneDenLaufZuAendern(t *testing.T) {
	L := ladeBeispiel(t, "waermepumpe")
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	netz, puffer := -4.0, 42.0
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 720, Tag: 100, Werte: map[string]EinWert{
		"netz": {Zahl: &netz}, "puffer": {Zahl: &puffer}}, Geraete: map[string]GeraetStamm{}}
	for i := 0; i < 120; i++ {
		ein.Jetzt = jetzt + float64(i)
		L.Takt(st, ein)
	}
	vorher, _ := L.SichereLauf(st)
	haeltVorher := len(st.haelt)
	w := L.Warum(st, ein)
	nachher, _ := L.SichereLauf(st)
	if string(vorher) != string(nachher) || len(st.haelt) != haeltVorher {
		t.Fatalf("Warum hat den Lauf verändert")
	}
	if len(w) != 1 || w[0].Zustand != "empfehlung" || w[0].Was != "an" || w[0].Modus != "alle" {
		t.Fatalf("erwartet eine Gruppe „schaltet ein, wenn alle“: %+v", w)
	}
	ok := map[string]*bool{}
	for _, b := range w[0].Bedingungen {
		ok[b.Name] = b.Ok
	}
	if v := ok["Seit 10 Minuten ist genug Sonnenstrom übrig"]; v == nil || *v {
		t.Fatalf("nach 2 Minuten hält der Sonnenstrom noch keine 10 Minuten: %v", v)
	}
	if v := ok["Der Speicher kann noch Wärme aufnehmen"]; v == nil || !*v {
		t.Fatalf("42 °C liegt unter 55 °C - 3 K: %v", v)
	}
	for _, b := range w[0].Bedingungen {
		if b.Name == "Der Speicher kann noch Wärme aufnehmen" {
			if len(b.Werte) != 2 || b.Werte[0].Text != "42 °C" || b.Werte[1].Name != "Speicher höchstens" {
				t.Fatalf("Werte hinter der Bedingung falsch: %+v", b.Werte)
			}
		}
	}

	// Ohne Fühlerwert ist die Bedingung unbekannt, nie falsch oder wahr.
	ein.Werte["puffer"] = EinWert{}
	for _, b := range L.Warum(st, ein)[0].Bedingungen {
		if b.Name == "Der Speicher kann noch Wärme aufnehmen" {
			if b.Ok != nil || b.Werte[0].Text != "kein Wert" {
				t.Fatalf("ohne Fühler muss die Bedingung unbekannt sein: %+v", b)
			}
		}
	}

	// Ist der Zustand an, nennt die Liste, was ihn beendet.
	ein.Werte["puffer"] = EinWert{Zahl: &puffer}
	st.Z["empfehlung"].an = true
	w = L.Warum(st, ein)
	if len(w) != 1 || w[0].Was != "aus" || w[0].Modus != "eines" {
		t.Fatalf("ein eingeschalteter Zustand nennt seine Aus-Bedingungen: %+v", w)
	}
}

// Ein Zähler nennt seine Schritte mit der Wartezeit bis „not_before“.
func TestWarumZaehlerSchritte(t *testing.T) {
	L := ladeBeispiel(t, "heizung")
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	ein := &Eingabe{Jetzt: jetzt + 10, UhrMin: 720, Tag: 100, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{}}
	w := L.Warum(st, ein)
	schritte := 0
	for _, g := range w {
		if g.Was == "schritt" {
			schritte++
			if g.Schritt == "" || len(g.Bedingungen) == 0 {
				t.Fatalf("Schritt ohne Namen oder Bedingungen: %+v", g)
			}
		}
	}
	if schritte == 0 {
		t.Fatalf("die Heizung hat Zählerschritte, die Liste nennt keine: %+v", w)
	}
	if len(w) > maxWarumGruppen {
		t.Fatalf("mehr als %d Gruppen", maxWarumGruppen)
	}
}

// Jede Gruppe trägt einen Satz für den Kunden: den der Logik mit den Werten von jetzt, sonst einen
// aus dem Wortschatz - nie die Kennung eines Zustands oder Schritts. Fehlt ein Satz für eine Gruppe,
// die das Blatt zeigt, sagt es die Prüfung.
func TestWarumSatzNieDieKennung(t *testing.T) {
	ohne := []byte(`{"logic": 1, "name": "Probe", "devices": {"stab": {"entity": "e1", "name": "Stab"}},
 "inputs": {"t": {"source": "f.temperature", "name": "Speicher"}},
 "states": {
  "heizen": {"type": "boolean", "on_when": [{"Zu kalt": "t < 40 °C"}], "off_when_any": [{"Warm genug": "t >= 50 °C"}], "after_restart": "off"},
  "netzheizen": {"type": "boolean", "name": "Netzheizen", "on_when": "t < 30 °C", "after_restart": "off"},
  "stufe": {"type": "counter", "min": 0, "max": 3, "after_restart": 0, "steps": [
   {"name": "hoch", "by": 1, "when": "heizen"}, {"name": "null", "set": 0, "when_any": [{"Warm": "not heizen"}]}]}},
 "outputs": {"stab": {"level": "stufe"}},
 "status": [{"else": true, "title": "Läuft", "type": "idle", "text": "Gut."}]}`)
	L, err := Lesen(ohne)
	if err != nil {
		t.Fatal(err)
	}
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	temp := 35.0
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 720, Tag: 100, Werte: map[string]EinWert{"t": {Zahl: &temp}},
		Geraete: map[string]GeraetStamm{}}
	L.Takt(st, ein)
	saetze := map[string]string{}
	for _, g := range L.Warum(st, ein) {
		if g.Eigen {
			t.Fatalf("ohne Satz im Text ist keine Gruppe „eigen“: %+v", g)
		}
		saetze[g.Zustand+"/"+g.Was+"/"+g.Schritt] = g.Satz
	}
	soll := map[string]string{
		"heizen/aus/":        "Schaltet aus", // bei 35 °C schon an: das Blatt nennt, was ihn beendet
		"netzheizen/an/":     "„Netzheizen“ beginnt",
		"stufe/schritt/hoch": "Um 1 höher",
		"stufe/schritt/null": "Auf 0",
	}
	for k, v := range soll {
		if saetze[k] != v {
			t.Errorf("%s: Satz %q, erwartet %q (alle: %v)", k, saetze[k], v, saetze)
		}
	}
	hinweis := ""
	for _, h := range L.Pruefe(nil).Hinweise {
		if strings.HasPrefix(h, "Ohne Satz für den Kunden") {
			hinweis = h
		}
	}
	for _, ort := range []string{"states.heizen.on_text", "states.heizen.off_text", "states.netzheizen.on_text",
		"states.stufe.steps.hoch.text", "states.stufe.steps.null.text"} {
		if !strings.Contains(hinweis, ort) {
			t.Errorf("der Hinweis nennt %s nicht: %q", ort, hinweis)
		}
	}
	if strings.Contains(hinweis, "netzheizen.off_text") {
		t.Errorf("ohne Aus-Bedingungen zeigt das Blatt keine Gruppe, also kein Hinweis: %q", hinweis)
	}

	// Das Beispiel bringt seine Sätze mit; Platzhalter tragen die Werte von jetzt (wie die Lage).
	W := ladeBeispiel(t, "wasser")
	st = W.NeuerLauf(jetzt)
	kalt, netz, speicher, ladestand := 38.0, 0.4, 0.0, 20.0
	ein = &Eingabe{Jetzt: jetzt, UhrMin: 6*60 + 30, Tag: 100, Werte: map[string]EinWert{"t": {Zahl: &kalt},
		"netz": {Zahl: &netz}, "speicher": {Zahl: &speicher}, "ladestand": {Zahl: &ladestand}},
		Geraete: map[string]GeraetStamm{}}
	W.Takt(st, ein)
	gefunden := false
	for _, g := range W.Warum(st, ein) {
		if !g.Eigen || g.Satz == "" || g.Satz == g.Zustand || g.Satz == g.Schritt {
			t.Fatalf("das Beispiel bringt für jede Gruppe einen Satz: %+v", g)
		}
		for _, b := range g.Bedingungen {
			if b.Allgemein || strings.ContainsAny(b.Name, "()<>=") {
				t.Fatalf("das Beispiel benennt jede Bedingung: %+v", b)
			}
		}
		if g.Zustand == "netzheizen" && g.Was == "an" {
			gefunden = true
			if g.Satz != "Heizt aus dem Netz bis 50\u00a0°C" {
				t.Fatalf("Platzhalter mit dem Stellwert von jetzt: %q", g.Satz)
			}
		}
	}
	if !gefunden {
		t.Fatal("die Gruppe „Heizt aus dem Netz“ fehlt")
	}
	for _, h := range W.Pruefe(nil).Hinweise {
		if strings.HasPrefix(h, "Ohne Satz für den Kunden") {
			t.Fatalf("das Beispiel hat alle Sätze: %q", h)
		}
	}
}
