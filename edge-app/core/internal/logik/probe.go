package logik

import (
	"math"
	"strconv"
	"strings"
)

// Eine Probe ist ein Fall mit erwartetem Ergebnis: given (Werte, Stellwerte, Zustand,
// Uhrzeit, Neustart), after (Dauer), expect (Zustände, Stufen der Geräte, Lage).
// Sie läuft im Sekundentakt mit einem Gerät, das jedem Wunsch folgt.

// ProbenGeraet sind die Angaben der Anlage, die eine Probe über ein Gerät wissen muss.
type ProbenGeraet struct {
	KwJeAusgang     *float64
	Ausgaenge       int
	SollwertBereich *[2]float64
}

// Abweichung ist eine Erwartung, die nach dem Lauf nicht zutrifft.
type Abweichung struct {
	Stelle string
	Soll   string
	Ist    string
}

// ProbenErgebnis ist das Ergebnis eines durchgespielten Falls.
type ProbenErgebnis struct {
	Name         string
	Bestanden    bool
	Abweichungen []Abweichung
	Ereignisse   []Ereignis
	Lage         Lage
}

// FuehreProbe spielt eine Probe durch: Zustand herstellen, Takt für Takt laufen, Erwartungen prüfen.
func (L *Logik) FuehreProbe(p *Probe, anlage map[string]ProbenGeraet) (*ProbenErgebnis, error) {
	jetzt := 0.0
	st := L.NeuerLauf(jetzt)
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 12 * 60, Tag: 1, DT: 1, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{}}
	for _, k := range L.GeraetListe {
		a := anlage[k]
		stufe := 0.0
		ein.Geraete[k] = GeraetStamm{Stufe: &stufe, KwJeAusgang: a.KwJeAusgang, Ausgaenge: a.Ausgaenge, SollwertBereich: a.SollwertBereich}
	}
	neu := false
	for i, k := range p.Gegeben.keys {
		roh := p.Gegeben.vals[i]
		switch {
		case k == "clock":
			w, err := LiesWert(roh)
			if err != nil || w.Art != WertZahl {
				return nil, fehler("Probe „%s“: clock ist eine Uhrzeit", p.Name)
			}
			ein.UhrMin = w.V
		case k == "weekday":
			tag := tagIndex(anyText(roh))
			if tag < 0 {
				return nil, fehler("Probe „%s“: unbekannter Wochentag %s", p.Name, anyText(roh))
			}
			ein.Wochentag = tag
		case k == "restart":
			w, err := LiesWert(roh)
			if err != nil {
				return nil, err
			}
			neu = w.Art == WertBool && w.B
		default:
			if _, ok := L.Werte[k]; ok {
				w, err := LiesWert(roh)
				if err != nil {
					return nil, fehler("Probe „%s“: %s", p.Name, err.Error())
				}
				switch w.Art {
				case WertUnbekannt:
					ein.Werte[k] = EinWert{}
				case WertBool:
					b := w.B
					ein.Werte[k] = EinWert{Bool: &b}
				default:
					v := w.V
					ein.Werte[k] = EinWert{Zahl: &v, D: w.D}
				}
				continue
			}
			if s, ok := L.Stellwerte[k]; ok {
				if s.Art == "select" {
					st.Stell[k] = wortW(anyText(roh))
				} else {
					w, err := LiesWert(roh)
					if err != nil {
						return nil, fehler("Probe „%s“: %s", p.Name, err.Error())
					}
					st.Stell[k] = w
				}
				continue
			}
			if z, ok := st.Z[k]; ok {
				switch z.art {
				case "boolean":
					w, err := LiesWert(roh)
					if err != nil {
						return nil, err
					}
					z.an = w.Art == WertBool && w.B
				case "counter":
					zahl, ok := roh.(jZahl)
					if !ok {
						return nil, fehler("Probe „%s“: %s ist eine Zahl", p.Name, k)
					}
					z.wert = int(zahl.v)
				default:
					w, err := LiesWert(roh)
					if err != nil {
						return nil, err
					}
					if w.Art == WertBool && w.B {
						dauer, err := L.rechne(st, ein, L.zustand[k].Dauer, 0)
						if err == nil && dauer.Art == WertZahl {
							bis := jetzt + dauer.V
							z.bis = &bis
						}
					}
				}
				continue
			}
			return nil, fehler("Probe „%s“: unbekannter Name %s", p.Name, k)
		}
	}
	if neu {
		L.Neustart(st, jetzt)
	}
	nach := p.Nach
	if nach == nil {
		nach = "1 min"
	}
	dauerW, err := LiesWert(nach)
	if err != nil || dauerW.Art != WertZahl {
		return nil, fehler("Probe „%s“: after ist eine Dauer", p.Name)
	}
	dauer := dauerW.V
	start := ein.UhrMin * 60
	var letzte TaktErgebnis
	var ereignisse []Ereignis
	for s := 0.0; s <= dauer; s++ {
		ein.Jetzt = jetzt + s
		ein.UhrMin = math.Mod((start+s)/60, 1440)
		letzte = L.Takt(st, ein)
		ereignisse = append(ereignisse, letzte.Ereignisse...)
		for _, k := range L.GeraetListe {
			o, ok := letzte.Ausgaenge[k]
			if !ok {
				continue
			}
			stufe := 0.0
			if o.HatStufe {
				stufe = float64(o.Stufe)
			} else if o.Ein != nil && *o.Ein {
				stufe = 1
			}
			stamm := ein.Geraete[k]
			stamm.Stufe = &stufe
			ein.Geraete[k] = stamm // ideales Gerät: folgt dem Wunsch
		}
	}
	r := &ProbenErgebnis{Name: p.Name, Ereignisse: ereignisse, Lage: letzte.Lage}
	for i, k := range p.Erwarte.keys {
		soll := p.Erwarte.vals[i]
		sollText := anyText(soll)
		var ist string
		switch {
		case k == "status":
			ist = letzte.Lage.Titel
		case k == "notifications":
			n := 0
			for _, e := range ereignisse {
				if e.Was == "meldung" {
					n++
				}
			}
			ist = strconv.Itoa(n)
		case strings.HasSuffix(k, ".level"):
			g := strings.TrimSuffix(k, ".level")
			ist = strconv.Itoa(letzte.Ausgaenge[g].Stufe)
		case strings.HasSuffix(k, ".on_off"):
			g := strings.TrimSuffix(k, ".on_off")
			x := letzte.Ausgaenge[g].Ein
			switch {
			case x == nil:
				ist = "none"
			case *x:
				ist = "on"
			default:
				ist = "off"
			}
		case strings.HasSuffix(k, ".mode"):
			g := strings.TrimSuffix(k, ".mode")
			ist = letzte.Ausgaenge[g].Betriebsart
			if ist == "" {
				ist = "none"
			}
		case strings.HasSuffix(k, ".setpoint"):
			g := strings.TrimSuffix(k, ".setpoint")
			x := letzte.Ausgaenge[g].Sollwert
			if x == nil {
				ist = "none"
			} else {
				ist = Zeige(*x)
			}
			w, err := LiesWert(soll)
			if err != nil {
				return nil, fehler("Probe „%s“: %s", p.Name, err.Error())
			}
			sollText = Zeige(w)
		default:
			z, ok := st.Z[k]
			if !ok {
				return nil, fehler("Probe „%s“: unbekannte Erwartung %s", p.Name, k)
			}
			switch z.art {
			case "counter":
				ist = strconv.Itoa(z.wert)
			case "boolean":
				ist = anAus(z.an)
			default:
				ist = anAus(z.bis != nil && ein.Jetzt < *z.bis)
			}
		}
		if ist != sollText {
			r.Abweichungen = append(r.Abweichungen, Abweichung{Stelle: k, Soll: sollText, Ist: ist})
		}
	}
	r.Bestanden = len(r.Abweichungen) == 0
	return r, nil
}

func anAus(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
