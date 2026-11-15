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
	SollwertSchritt *float64
	Betriebsarten   []string
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
	// Uhr ist die Uhrzeit am Beginn der Probe (Minuten seit Mitternacht; ohne clock 12:00):
	// „So verhält sie sich“ ordnet die Proben eines Bausteins so zu einem Tag (Stufe 5).
	Uhr float64
}

// FuehreProbe spielt eine Probe durch: Zustand herstellen, Takt für Takt laufen, Erwartungen prüfen.
func (L *Logik) FuehreProbe(p *Probe, anlage map[string]ProbenGeraet) (*ProbenErgebnis, error) {
	jetzt := 0.0
	st := L.NeuerLauf(jetzt)
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 12 * 60, Tag: 1, DT: 1, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{}}
	for _, k := range L.GeraetListe {
		a := anlage[k]
		stufe := 0.0
		ein.Geraete[k] = GeraetStamm{Stufe: &stufe, KwJeAusgang: a.KwJeAusgang, Ausgaenge: a.Ausgaenge,
			SollwertBereich: a.SollwertBereich, SollwertSchritt: a.SollwertSchritt, Betriebsarten: a.Betriebsarten}
	}
	neu := false
	// Stellwerte zuerst: Ein Wert unter given darf eine Formel über Stellwerte sein
	// ("mindest - 2 K", Stufe 5), gerechnet mit den Stellwerten dieser Probe.
	for i, k := range p.Gegeben.keys {
		s, ok := L.Stellwerte[k]
		if !ok {
			continue
		}
		roh := p.Gegeben.vals[i]
		if s.Art == "select" {
			st.Stell[k] = wortW(anyText(roh))
			continue
		}
		w, err := LiesWert(roh)
		if err != nil {
			return nil, fehler("Probe „%s“: %s", p.Name, err.Error())
		}
		st.Stell[k] = w
	}
	for i, k := range p.Gegeben.keys {
		roh := p.Gegeben.vals[i]
		if _, ok := L.Stellwerte[k]; ok {
			continue
		}
		switch {
		case k == "clock":
			w, err := L.gegebenWert(p, k, roh, st, ein)
			if err != nil || w.Art != WertZahl || (w.D != GroesseUhrzeit && w.D != GroesseZahl) {
				return nil, fehler("Probe „%s“: clock ist eine Uhrzeit", p.Name)
			}
			ein.UhrMin = math.Mod(math.Mod(w.V, 1440)+1440, 1440)
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
			if e, ok := L.Werte[k]; ok {
				w, err := L.gegebenWert(p, k, roh, st, ein)
				if err != nil {
					return nil, err
				}
				if w.Art == WertZahl && w.D != GroesseZahl && (e.GroesseBool || w.D != e.Groesse) {
					return nil, fehler("Probe „%s“: %s ist %s, nicht %s", p.Name, k, nenne(e.Groesse), nenne(w.D))
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
			if o.Sollwert != nil {
				v := o.Sollwert.V
				stamm.Sollwert = &v
			}
			if o.Betriebsart != "" {
				stamm.Betriebsart = o.Betriebsart
			}
			ein.Geraete[k] = stamm // ideales Gerät: folgt dem Wunsch
		}
	}
	r := &ProbenErgebnis{Name: p.Name, Ereignisse: ereignisse, Lage: letzte.Lage, Uhr: start / 60}
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
			// Wie unter given darf der erwartete Sollwert eine Formel über Stellwerte sein
			// ("normal - vorrat"): so bleibt die Probe wahr, wenn jemand den Wert stellt.
			w, err := L.gegebenWert(p, k, soll, st, ein)
			if err != nil {
				return nil, err
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

// gegebenWert liest einen Wert unter given (und einen erwarteten Sollwert): einen festen Wert ("57 °C") oder eine Formel über
// Stellwerte ("mindest - 2 K", "netz_ab"), gerechnet mit den Stellwerten dieser Probe. So bleibt
// eine Probe wahr, wenn jemand einen Stellwert ändert - die Proben eines Bausteins müssen das
// für jeden Wert im Bereich (Stufe 5). Eine Formel kennt nur Stellwerte, feste Werte, Wörter
// und min, max, if; was nicht als Formel lesbar ist, meldet der Fehler des festen Werts.
func (L *Logik) gegebenWert(p *Probe, k string, roh any, st *Lauf, ein *Eingabe) (Wert, error) {
	w, err := LiesWert(roh)
	if err == nil {
		return w, nil
	}
	text, ok := roh.(string)
	if !ok {
		return Wert{}, fehler("Probe „%s“: %s", p.Name, err.Error())
	}
	b, ferr := lies(text)
	if ferr != nil {
		return Wert{}, fehler("Probe „%s“: %s", p.Name, err.Error())
	}
	if n := L.nichtNurStellwerte(b); n != "" {
		return Wert{}, fehler("Probe „%s“: %s: eine Formel unter given kennt nur Stellwerte, nicht „%s“", p.Name, k, n)
	}
	if _, gerr := L.groesse(b, nil); gerr != nil {
		return Wert{}, fehler("Probe „%s“: %s: %s", p.Name, k, gerr.Error())
	}
	v, rerr := L.rechne(st, ein, b, 0)
	if rerr != nil {
		return Wert{}, fehler("Probe „%s“: %s: %s", p.Name, k, rerr.Error())
	}
	return v, nil
}

// nichtNurStellwerte nennt den ersten Namen oder Aufruf einer Formel, der kein Stellwert, kein
// Wort und keine der Funktionen min, max, if ist; leer, wenn es keinen gibt.
func (L *Logik) nichtNurStellwerte(b *baum) string {
	if b == nil {
		return ""
	}
	switch b.t {
	case kName:
		if _, ok := L.Stellwerte[b.n]; ok || L.woerter[b.n] {
			return ""
		}
		return b.n
	case kRuf:
		if b.f != "min" && b.f != "max" && b.f != "if" {
			return b.f + "()"
		}
		for _, a := range b.args {
			if n := L.nichtNurStellwerte(a); n != "" {
				return n
			}
		}
		return ""
	}
	for _, x := range []*baum{b.x, b.l, b.r} {
		if n := L.nichtNurStellwerte(x); n != "" {
			return n
		}
	}
	return ""
}

func anAus(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
