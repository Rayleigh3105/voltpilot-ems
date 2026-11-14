package logik

// Das Blatt „Warum?“ (Bericht 6.5, 8.6): je Zustand die benannten Bedingungen, die als
// Nächstes über ihn entscheiden, mit Haken und den Werten von jetzt. Die Liste ist kein
// zweiter Text: sie entsteht aus denselben Bedingungen, die der Takt auswertet. Gelesen wird
// auf einer Kopie der holds-Zähler - das Lesen verändert den Lauf nie.

import (
	"strconv"
	"strings"
)

// WarumGruppe ist eine Liste benannter Bedingungen, die über einen Zustand entscheidet. Satz ist ihre
// Überschrift für den Kunden: der Satz aus dem Text (on_text, off_text, text eines Schritts) mit den
// Werten von jetzt, sonst einer aus dem Wortschatz (Eigen false) - nie die Kennung eines Zustands
// oder Schritts. Zustand, Name und Schritt bleiben für Maschinen.
type WarumGruppe struct {
	Zustand string `json:"zustand"`
	Name    string `json:"name"`
	Satz    string `json:"satz"`
	Eigen   bool   `json:"eigen,omitempty"`
	// Was: "an" (schaltet ein, wenn), "aus" (schaltet aus, wenn) oder "schritt" (ein Zählerschritt).
	Was     string `json:"was"`
	Schritt string `json:"schritt,omitempty"`
	// Modus: "alle" müssen gelten oder "eines" genügt.
	Modus string `json:"modus"`
	// WartetS: so viele Sekunden, bis der Schritt frühestens wieder darf (not_before).
	WartetS     int              `json:"wartet_s,omitempty"`
	Bedingungen []WarumBedingung `json:"bedingungen"`
}

// WarumBedingung ist eine Bedingung mit ihrem Stand; Ok nil heißt unbekannt. Formel sagt, dass der
// Text keinen Namen trägt und Name die Formel selbst ist (die Oberfläche zeigt sie als Formel).
type WarumBedingung struct {
	Name   string      `json:"name"`
	Ok     *bool       `json:"ok"`
	Formel bool        `json:"formel,omitempty"`
	Werte  []WarumWert `json:"werte,omitempty"`
}

// WarumWert ist ein Wert, der in einer Bedingung steckt: ein gemessener Wert oder ein Stellwert.
type WarumWert struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// Grenzen der Liste: sie reist im Herzschlag.
const (
	maxWarumGruppen  = 24
	maxWarumWerte    = 3
	warumKeinWertTxt = "kein Wert"
)

// Warum bildet die Liste für einen Lauf nach dem Takt mit derselben Eingabe.
func (L *Logik) Warum(st *Lauf, ein *Eingabe) []WarumGruppe {
	if ein == nil {
		return nil
	}
	lese := st.leseKopie()
	var out []WarumGruppe
	gruppe := func(z *Zustand, was string, s *Schritt, modus string, liste []Bedingung, wartet float64) {
		if liste == nil || len(out) >= maxWarumGruppen {
			return
		}
		name := z.Name
		if name == "" {
			name = z.Kennung
		}
		g := WarumGruppe{Zustand: z.Kennung, Name: name, Was: was, Modus: modus,
			Bedingungen: make([]WarumBedingung, 0, len(liste))}
		if s != nil {
			g.Schritt = s.Name
		}
		g.Satz, g.Eigen = L.warumSatz(lese, ein, z, was, s)
		if wartet > 0 {
			g.WartetS = int(wartet + 0.999)
		}
		for i := range liste {
			g.Bedingungen = append(g.Bedingungen, L.warumBedingung(lese, ein, &liste[i]))
		}
		out = append(out, g)
	}
	for _, z := range L.Zustaende {
		l := st.Z[z.Kennung]
		if l == nil {
			continue
		}
		switch z.Art {
		case "boolean":
			if l.an {
				gruppe(z, "aus", nil, "alle", z.Aus, 0)
				gruppe(z, "aus", nil, "eines", z.AusEines, 0)
			} else {
				gruppe(z, "an", nil, "alle", z.An, 0)
				gruppe(z, "an", nil, "eines", z.AnEines, 0)
			}
		case "counter":
			for _, s := range z.Schritte {
				warte := s.Fruehestens
				if s.FruehestensBaum != nil {
					if fw, err := L.rechne(lese, ein, s.FruehestensBaum, 0); err == nil && fw.Art == WertZahl {
						warte = fw.V
					}
				}
				rest := l.seit + warte - ein.Jetzt
				gruppe(z, "schritt", s, "alle", s.Alle, rest)
				gruppe(z, "schritt", s, "eines", s.Eines, rest)
			}
		}
	}
	return out
}

// warumSatz ist die Überschrift einer Gruppe: der Satz aus dem Text mit den Werten von jetzt, sonst
// einer aus dem Wortschatz (zweiter Wert false).
func (L *Logik) warumSatz(st *Lauf, ein *Eingabe, z *Zustand, was string, s *Schritt) (string, bool) {
	if eigen := eigenerSatz(z, was, s); eigen != "" {
		if t, err := L.Satz(st, ein, eigen); err == nil {
			return t, true
		}
	}
	return wortSatz(z, was, s), false
}

// eigenerSatz ist der Satz, den der Text für die Gruppe mitbringt; leer, wenn er fehlt.
func eigenerSatz(z *Zustand, was string, s *Schritt) string {
	switch {
	case s != nil:
		return s.Text
	case was == "an":
		return z.AnText
	}
	return z.AusText
}

// wortSatz bildet die Überschrift aus dem Wortschatz: der Name des Zustands, wenn der Text einen
// nennt, und was geschieht - beginnt, endet, um 1 höher, auf 0. Eine Kennung erscheint nie.
func wortSatz(z *Zustand, was string, s *Schritt) string {
	if s == nil {
		tut := map[string]string{"an": "beginnt", "aus": "endet"}[was]
		if z.HatName {
			return "„" + z.Name + "“ " + tut
		}
		return map[string]string{"an": "Schaltet ein", "aus": "Schaltet aus"}[was]
	}
	var tut string
	switch {
	case s.HatUm && s.Um > 0:
		tut = "um " + strconv.Itoa(s.Um) + " höher"
	case s.HatUm && s.Um < 0:
		tut = "um " + strconv.Itoa(-s.Um) + " niedriger"
	case s.HatUm:
		tut = "bleibt"
	case s.Setze != nil && s.Setze.t == kZahl:
		tut = "auf " + strings.Replace(strconv.FormatFloat(s.Setze.v, 'f', -1, 64), ".", ",", 1)
	default:
		tut = "wird neu gesetzt"
	}
	if z.HatName {
		return z.Name + " " + tut
	}
	return strings.ToUpper(tut[:1]) + tut[1:]
}

func (L *Logik) warumBedingung(st *Lauf, ein *Eingabe, b *Bedingung) WarumBedingung {
	wb := WarumBedingung{Name: b.Name}
	if wb.Name == "" {
		wb.Name, wb.Formel = b.Baum.src, true
	}
	if x, err := L.rechne(st, ein, b.Baum, 0); err == nil && x.Art == WertBool {
		ok := x.B
		wb.Ok = &ok
	}
	gesehen := map[string]bool{}
	var geh func(n *baum, tiefe int)
	geh = func(n *baum, tiefe int) {
		if n == nil || len(wb.Werte) >= maxWarumWerte || tiefe > 16 {
			return
		}
		switch n.t {
		case kName:
			if gesehen[n.n] {
				return
			}
			gesehen[n.n] = true
			if e, ok := L.Werte[n.n]; ok {
				text := warumKeinWertTxt
				if w, err := L.hole(st, ein, n.n, 0); err == nil && w.Art != WertUnbekannt {
					text = L.ZeigeIn(w)
				}
				name := e.Name
				if name == "" {
					name = n.n
				}
				wb.Werte = append(wb.Werte, WarumWert{Name: name, Text: text})
			} else if s, ok := L.Stellwerte[n.n]; ok {
				wb.Werte = append(wb.Werte, WarumWert{Name: s.Name, Text: L.ZeigeIn(st.Stell[n.n])})
			} else if m, ok := L.Merker[n.n]; ok {
				geh(m, tiefe+1)
			}
		case kBin:
			geh(n.l, tiefe+1)
			geh(n.r, tiefe+1)
		case kUn, kKlammer:
			geh(n.x, tiefe+1)
		case kRuf:
			for _, a := range n.args {
				geh(a, tiefe+1)
			}
		}
	}
	geh(b.Baum, 0)
	return wb
}
