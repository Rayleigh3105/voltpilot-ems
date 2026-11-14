package logik

import "testing"

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
