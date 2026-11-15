package logik

// Stellwerte zur Laufzeit (Stufe 3, „Scharf“): Menschen stellen sie, ohne den Text zu ändern
// (Bericht 6.6 Punkt 4, 8.9). Ein gestellter Wert reist getrennt vom Text, im Bündel der
// Auslieferung neben der Logik; er startet die Logik nicht neu, ihr Zustand bleibt.
// Wer welchen Wert stellen darf, entscheidet die API nach `editable_by` und den Rollen des
// Portals (E2 = B: ein Zielwert in °C immer); der Kern prüft nur, ob der Wert passt:
// Art, Einheit, Bereich, Schritt, Auswahl und die Bedingungen unter `constraints`.
// Gleich streng auf beiden Seiten: der Dienst neben der API prüft vor dem Speichern,
// die Box beim Annehmen - ein Bündel mit einem unpassenden Wert nimmt sie nicht an.

import (
	"math"
	"strings"
)

// StellwertInfo beschreibt einen Stellwert für API und Oberfläche: Zahlen in der Einheit,
// in der der Text die Vorgabe schreibt (eine Haltezeit in min bleibt in min).
type StellwertInfo struct {
	Kennung string `json:"kennung"`
	Name    string `json:"name"`
	// Art: "zahl", "uhrzeit", "boolean", "select" oder "schedule".
	Art     string   `json:"art"`
	Einheit string   `json:"einheit,omitempty"`
	Vorgabe any      `json:"vorgabe"`
	Von     *float64 `json:"von,omitempty"`
	Bis     *float64 `json:"bis,omitempty"`
	Schritt *float64 `json:"schritt,omitempty"`
	// Optionen einer Auswahl: Wort und Name für den Kunden, in der Reihenfolge des Textes.
	Optionen []StellwertOption `json:"optionen,omitempty"`
	// Darf ist editable_by ("customer", "customer_admin", "installer"; ohne Angabe installer).
	Darf string `json:"darf"`
	// Zielwert nach E2 = B: ein Stellwert in °C; ihn stellt der Kunde immer, in seinem Bereich.
	Zielwert bool `json:"zielwert"`
}

// StellwertOption ist ein Wort einer Auswahl mit seinem Namen für den Kunden.
type StellwertOption struct {
	Wert string `json:"wert"`
	Name string `json:"name"`
}

// StellwertInfos beschreibt alle Stellwerte in der Reihenfolge des Textes.
func (L *Logik) StellwertInfos() []StellwertInfo {
	out := make([]StellwertInfo, 0, len(L.StellListe))
	for _, n := range L.StellListe {
		s := L.Stellwerte[n]
		i := StellwertInfo{Kennung: n, Name: s.Name, Art: s.Art, Darf: s.Darf, Zielwert: s.Zielwert(),
			Vorgabe: L.StellwertRoh(n, s.Vorgabe)}
		switch s.Art {
		case "select":
			if s.Optionen != nil {
				for j, w := range s.Optionen.keys {
					name, _ := s.Optionen.vals[j].(string)
					i.Optionen = append(i.Optionen, StellwertOption{Wert: w, Name: name})
				}
			}
		case "zahl":
			if s.Vorgabe.D == GroesseUhrzeit {
				i.Art = "uhrzeit"
			}
			e := anzeigeEinheit(s)
			i.Einheit = e.sym
			if s.Bereich != nil {
				von, bis := s.Bereich[0].V/e.faktor, s.Bereich[1].V/e.faktor
				i.Von, i.Bis = &von, &bis
			}
			if s.Schritt != nil {
				f := e.faktor
				if s.Schritt.D != s.Vorgabe.D {
					f = 1 // ein Abstand in K zu einer Temperatur in °C
				}
				v := s.Schritt.V / f
				i.Schritt = &v
			}
		}
		out = append(out, i)
	}
	return out
}

// anzeigeEinheit ist die Einheit, in der der Text die Vorgabe eines Zahl-Stellwerts schreibt;
// ohne Schreibweise die Grundeinheit der Größe. Uhrzeiten und Zahlen ohne Einheit haben keine.
func anzeigeEinheit(s *Stellwert) einheit {
	if s.Vorgabe.D == GroesseUhrzeit || s.Vorgabe.D == GroesseZahl {
		return einheit{d: s.Vorgabe.D, faktor: 1}
	}
	if s.vorgabeText != "" {
		t := strings.TrimSpace(s.vorgabeText)
		for _, e := range einheiten {
			if e.d == s.Vorgabe.D && strings.HasSuffix(t, e.sym) {
				return e
			}
		}
	}
	for _, e := range einheiten {
		if e.d == s.Vorgabe.D && e.faktor == 1 {
			return e
		}
	}
	return einheit{d: s.Vorgabe.D, faktor: 1}
}

// StellwertRoh schreibt einen Wert in der Form des Dokuments: "72 °C" in der Einheit der
// Vorgabe, "on"/"off", "06:00", das Wort einer Auswahl oder den Zeitplan als Objekt.
// LiesStellwert liest genau diese Form wieder.
func (L *Logik) StellwertRoh(kennung string, w Wert) any {
	s := L.Stellwerte[kennung]
	switch w.Art {
	case WertBool:
		if w.B {
			return "on"
		}
		return "off"
	case WertWort:
		return w.W
	case WertPlan:
		return planRoh(w.Plan)
	case WertZahl:
		if w.D == GroesseUhrzeit {
			m := int(math.Round(w.V))
			return zweistellig(m/60) + ":" + zweistellig(m%60)
		}
		if w.D == GroesseZahl {
			return w.V
		}
		e := einheit{d: w.D, faktor: 1}
		if s != nil {
			e = anzeigeEinheit(s)
		}
		if e.sym == "" {
			for _, x := range einheiten {
				if x.d == w.D && x.faktor == 1 {
					e = x
				}
			}
		}
		return zahlText(w.V/e.faktor) + " " + e.sym
	}
	return nil
}

// zahlText schreibt eine Zahl mit Punkt und ohne überflüssige Stellen (die Schreibform
// des Dokuments, nicht die Anzeige für Kunden).
func zahlText(v float64) string {
	r := math.Round(v*1e6) / 1e6
	s := toFixed(r, 6)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" {
		s = "0"
	}
	return s
}

func planRoh(p *Zeitplan) []any {
	out := []any{}
	if p == nil {
		return out
	}
	for _, f := range p.Fenster {
		tageText := f.TageText
		if tageText == "" {
			var t []string
			for _, d := range f.Tage {
				t = append(t, tage[d])
			}
			tageText = strings.Join(t, ",")
		}
		out = append(out, map[string]any{"days": tageText, "from": uhrText(f.Von), "to": uhrText(f.Bis)})
	}
	return out
}

func uhrText(min float64) string {
	m := int(math.Round(min))
	return zweistellig(m/60) + ":" + zweistellig(m%60)
}

// LiesStellwert liest einen gestellten Wert in der Form des Dokuments und prüft ihn gegen
// Art, Einheit, Bereich, Schritt und Auswahl des Stellwerts. Ein Fehler nennt den Namen
// des Stellwerts und den Grund in Sätzen für Menschen.
func (L *Logik) LiesStellwert(kennung string, roh any) (Wert, error) {
	s := L.Stellwerte[kennung]
	if s == nil {
		return Wert{}, fehler("Einen Stellwert „%s“ gibt es in dieser Logik nicht", kennung)
	}
	switch s.Art {
	case "select":
		w, ok := roh.(string)
		if !ok || s.Optionen == nil || !s.Optionen.hat(w) {
			return Wert{}, fehler("„%s“: dieser Wert steht nicht zur Auswahl", s.Name)
		}
		return wortW(w), nil
	case "schedule":
		p, err := liesPlan(planAusRoh(roh))
		if err != nil {
			return Wert{}, fehler("„%s“: %s", s.Name, err.Error())
		}
		return Wert{Art: WertPlan, Plan: p}, nil
	case "boolean":
		w, err := LiesWert(roh)
		if err != nil || w.Art != WertBool {
			return Wert{}, fehler("„%s“: erwartet on oder off", s.Name)
		}
		return w, nil
	}
	w, err := LiesWert(roh)
	if err != nil {
		return Wert{}, fehler("„%s“: %s", s.Name, err.Error())
	}
	if w.Art != WertZahl || w.D != s.Vorgabe.D {
		return Wert{}, fehler("„%s“: erwartet %s", s.Name, nenne(s.Vorgabe.D))
	}
	if s.Bereich != nil && (w.V < s.Bereich[0].V-eps || w.V > s.Bereich[1].V+eps) {
		return Wert{}, fehler("„%s“: %s liegt außerhalb %s bis %s", s.Name, Zeige(w), Zeige(s.Bereich[0]), Zeige(s.Bereich[1]))
	}
	if s.Schritt != nil && s.Schritt.V > 0 {
		basis := 0.0
		if s.Bereich != nil {
			basis = s.Bereich[0].V
		}
		n := (w.V - basis) / s.Schritt.V
		if math.Abs(n-math.Round(n)) > 1e-6 {
			return Wert{}, fehler("„%s“: %s passt nicht in die Schritte von %s", s.Name, Zeige(w), Zeige(*s.Schritt))
		}
	}
	return w, nil
}

// planAusRoh bringt einen Zeitplan aus encoding/json (map, []any) in die Form des Lesers.
func planAusRoh(roh any) any {
	switch v := roh.(type) {
	case []any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = planAusRoh(v[i])
		}
		return out
	case map[string]any:
		o := &jObjekt{}
		for _, k := range []string{"days", "from", "to"} {
			if x, ok := v[k]; ok {
				o.keys = append(o.keys, k)
				o.vals = append(o.vals, planAusRoh(x))
			}
		}
		return o
	}
	return roh
}

// PruefeStellwerte prüft eine Belegung: jeder Wert für sich (LiesStellwert) und die
// Bedingungen unter constraints mit allen gestellten Werten zusammen (nicht gestellte
// gelten mit ihrer Vorgabe). Rückgabe: die gelesenen Werte.
func (L *Logik) PruefeStellwerte(roh map[string]any) (map[string]Wert, error) {
	werte := make(map[string]Wert, len(roh))
	for _, n := range L.StellListe {
		r, ok := roh[n]
		if !ok {
			continue
		}
		w, err := L.LiesStellwert(n, r)
		if err != nil {
			return nil, err
		}
		werte[n] = w
	}
	for k := range roh {
		if L.Stellwerte[k] == nil {
			return nil, fehler("Einen Stellwert „%s“ gibt es in dieser Logik nicht", k)
		}
	}
	if len(L.Zusammen) > 0 {
		gilt, err := L.zusammenGilt(werte)
		if err != nil {
			return nil, err
		}
		for i, ok := range gilt {
			if !ok {
				return nil, fehler("Diese Werte passen nicht zusammen: %s", L.Zusammen[i].Name)
			}
		}
	}
	return werte, nil
}

// SetzeStellwerte übernimmt gestellte Werte in einen Lauf; nicht genannte fallen auf ihre
// Vorgabe zurück. Zustände, Zeitgeber und Tageszähler bleiben, wie sie sind.
func (L *Logik) SetzeStellwerte(st *Lauf, werte map[string]Wert) {
	for _, n := range L.StellListe {
		if w, ok := werte[n]; ok {
			st.Stell[n] = w
		} else {
			st.Stell[n] = L.Stellwerte[n].Vorgabe
		}
	}
}

// StellwertJetzt ist ein Stellwert, wie er im Lauf gilt: Form des Dokuments, Anzeige und
// der Hilfesatz mit den Werten von jetzt.
type StellwertJetzt struct {
	Kennung string `json:"kennung"`
	Wert    any    `json:"wert"`
	Text    string `json:"text"`
	Hilfe   string `json:"hilfe,omitempty"`
}

// StellwerteJetzt beschreibt die geltenden Stellwerte eines Laufs; die Hilfesätze rechnen auf
// einer Kopie der holds-Zähler, so dass das Lesen den Lauf nie verändert.
func (L *Logik) StellwerteJetzt(st *Lauf, ein *Eingabe) []StellwertJetzt {
	lese := st.leseKopie()
	out := make([]StellwertJetzt, 0, len(L.StellListe))
	for _, n := range L.StellListe {
		w := st.Stell[n]
		j := StellwertJetzt{Kennung: n, Wert: L.StellwertRoh(n, w), Text: L.ZeigeIn(w)}
		if w.Art == WertPlan {
			j.Text = planText(w.Plan)
		}
		if ein != nil {
			if h, err := L.Hilfe(lese, ein, n); err == nil {
				j.Hilfe = h
			}
		}
		out = append(out, j)
	}
	return out
}

func planText(p *Zeitplan) string {
	if p == nil || len(p.Fenster) == 0 {
		return "nie"
	}
	var teile []string
	for _, f := range p.Fenster {
		t := f.Text
		if t == "" {
			t = uhrText(f.Von) + " bis " + uhrText(f.Bis)
		}
		teile = append(teile, t)
	}
	return strings.Join(teile, ", ")
}

// leseKopie ist der Lauf zum Lesen: dieselben Werte, eigene holds-Zähler. Ausdrücke mit
// holds() schreiben ihren Beginn; außerhalb des Takts darf das den Lauf nicht verändern.
func (st *Lauf) leseKopie() *Lauf {
	k := *st
	k.haelt = make(map[string]*float64, len(st.haelt))
	for key, v := range st.haelt {
		if v != nil {
			t := *v
			k.haelt[key] = &t
		}
	}
	return &k
}

// UebernimmLauf beginnt eine neue Fassung aus dem Lauf der vorigen (Bericht 8.9): Zustände
// mit gleichem Namen und gleicher Art behalten ihren Wert, ihren letzten Wechsel und die
// Frist eines Zeitgebers, ein Zähler bleibt in seinen neuen Grenzen; Tageszähler je Gerät
// bleiben beim gleichen Gerät. Alles andere beginnt wie nach einem Neustart. holds-Zähler
// reisen mit, wo die neue Fassung dieselbe Bedingung hat. Stellwerte setzt der Aufrufer.
func (L *Logik) UebernimmLauf(alt *Logik, altSt *Lauf, jetzt float64) *Lauf {
	st := L.NeuerLauf(jetzt)
	if alt == nil || altSt == nil {
		return st
	}
	for _, z := range L.Zustaende {
		az := alt.zustand[z.Kennung]
		al := altSt.Z[z.Kennung]
		if az == nil || al == nil || az.Art != z.Art {
			continue
		}
		l := *al
		if l.bis != nil {
			v := *l.bis
			l.bis = &v
		}
		if z.Art == "counter" {
			if l.wert > z.Bis {
				l.wert = z.Bis
			}
			if l.wert < z.Von {
				l.wert = z.Von
			}
		}
		st.Z[z.Kennung] = &l
	}
	for _, g := range L.GeraetListe {
		if ag := altSt.G[g]; ag != nil && alt.Geraete[g] != nil && alt.Geraete[g].Entity == L.Geraete[g].Entity {
			v := *ag
			st.G[g] = &v
		}
	}
	for key, v := range altSt.haelt {
		if v != nil {
			t := *v
			st.haelt[key] = &t
		}
	}
	st.tag, st.tagGilt, st.Gestartet = altSt.tag, altSt.tagGilt, altSt.Gestartet
	return st
}
