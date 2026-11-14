package logik

// Das Blatt „Warum?“ (Bericht 6.5, 8.6): je Zustand die benannten Bedingungen, die als
// Nächstes über ihn entscheiden, mit Haken und den Werten von jetzt. Die Liste ist kein
// zweiter Text: sie entsteht aus denselben Bedingungen, die der Takt auswertet. Gelesen wird
// auf einer Kopie der holds-Zähler - das Lesen verändert den Lauf nie.

// WarumGruppe ist eine Liste benannter Bedingungen, die über einen Zustand entscheidet.
type WarumGruppe struct {
	Zustand string `json:"zustand"`
	Name    string `json:"name"`
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
	gruppe := func(z *Zustand, was, schritt, modus string, liste []Bedingung, wartet float64) {
		if liste == nil || len(out) >= maxWarumGruppen {
			return
		}
		name := z.Name
		if name == "" {
			name = z.Kennung
		}
		g := WarumGruppe{Zustand: z.Kennung, Name: name, Was: was, Schritt: schritt, Modus: modus,
			Bedingungen: make([]WarumBedingung, 0, len(liste))}
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
				gruppe(z, "aus", "", "alle", z.Aus, 0)
				gruppe(z, "aus", "", "eines", z.AusEines, 0)
			} else {
				gruppe(z, "an", "", "alle", z.An, 0)
				gruppe(z, "an", "", "eines", z.AnEines, 0)
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
				gruppe(z, "schritt", s.Name, "alle", s.Alle, rest)
				gruppe(z, "schritt", s.Name, "eines", s.Eines, rest)
			}
		}
	}
	return out
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
