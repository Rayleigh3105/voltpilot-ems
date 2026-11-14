package logik

import (
	"math"
	"math/big"
	"strconv"
	"strings"
)

// Zeige schreibt Werte für Menschen: deutsche Schreibweise, schmales Leerzeichen vor der
// Einheit, echtes Minus. Die Rundung entspricht dem Referenzlabor (JavaScript toFixed):
// genaue Hälften runden vom Nullpunkt weg.

const nbsp = " "

// toFixed rundet wie JavaScript Number.prototype.toFixed.
func toFixed(x float64, stellen int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return strconv.FormatFloat(x, 'f', stellen, 64)
	}
	// Eine genaue Hälfte liegt nur vor, wenn x * 10^stellen exakt auf ,5 endet.
	// Das prüft die exakte rationale Darstellung des Werts.
	r := new(big.Rat).SetFloat64(x)
	if r != nil {
		zehn := new(big.Rat).SetInt64(1)
		for i := 0; i < stellen; i++ {
			zehn.Mul(zehn, big.NewRat(10, 1))
		}
		r.Mul(r, zehn)
		if r.Denom().Cmp(big.NewInt(2)) == 0 {
			// genaue Hälfte: vom Nullpunkt weg
			halb := new(big.Rat).Abs(r)
			n := new(big.Int).Div(halb.Num(), halb.Denom()) // |r| abgerundet
			n.Add(n, big.NewInt(1))
			text := n.String()
			if stellen > 0 {
				for len(text) <= stellen {
					text = "0" + text
				}
				text = text[:len(text)-stellen] + "." + text[len(text)-stellen:]
			}
			if x < 0 {
				text = "-" + text
			}
			return text
		}
	}
	return strconv.FormatFloat(x, 'f', stellen, 64)
}

func deutsch(x float64, stellen int) string {
	s := toFixed(x, stellen)
	s = strings.ReplaceAll(s, ".", ",")
	s = strings.ReplaceAll(s, "-", "−")
	return s
}

// Zeige schreibt einen Wert mit Einheit; unbekannt heißt "kein Wert".
func Zeige(x Wert) string {
	return zeigeGrob(x, false)
}

func zeigeGrob(x Wert, grob bool) string {
	switch x.Art {
	case WertUnbekannt:
		return "kein Wert"
	case WertBool:
		if x.B {
			return "an"
		}
		return "aus"
	case WertWort:
		return x.W
	case WertPlan:
		var teile []string
		for _, f := range x.Plan.Fenster {
			teile = append(teile, f.Text)
		}
		return strings.Join(teile, ", ")
	}
	v := x.V
	if math.Abs(v) < 0.005 {
		v = 0
	}
	switch x.D {
	case GroesseTemp:
		stellen := 1
		if grob || istGanz(v) {
			stellen = 0
		}
		return deutsch(v, stellen) + nbsp + "°C"
	case GroesseDTemp:
		return deutsch(v, 0) + nbsp + "K"
	case GroesseKW:
		stellen := 2
		zehnfach := float64(v * 10) // explizite Konvertierung: keine FMA-Verschmelzung (arm64)
		if math.Abs(v) >= 10 {
			stellen = 0
		} else if math.Abs(zehnfach-jsRound(zehnfach)) < eps {
			stellen = 1
		}
		return deutsch(v, stellen) + nbsp + "kW"
	case GroesseProzent:
		return deutsch(v, 0) + nbsp + "%"
	case GroesseWinkel:
		return deutsch(v, 0) + "°"
	case GroesseUhrzeit:
		h := int(math.Floor(v / 60))
		m := int(jsRound(math.Mod(v, 60)))
		return zweistellig(h) + ":" + zweistellig(m)
	case GroesseDauer:
		switch {
		case math.Mod(v, 3600) == 0 && v >= 3600:
			return deutsch(v/3600, 0) + nbsp + "h"
		case v >= 3600:
			return deutsch(v/3600, 1) + nbsp + "h"
		case v >= 60:
			return deutsch(v/60, 0) + nbsp + "min"
		default:
			return deutsch(v, 0) + nbsp + "s"
		}
	default:
		stellen := 1
		if istGanz(v) {
			stellen = 0
		}
		return deutsch(v, stellen)
	}
}

func istGanz(v float64) bool { return v == math.Trunc(v) && !math.IsInf(v, 0) }

func zweistellig(n int) string {
	if n < 10 && n >= 0 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// wortName gibt für ein Wort einer Auswahl den Namen für den Kunden.
func (L *Logik) wortName(w string) string {
	for _, n := range L.StellListe {
		s := L.Stellwerte[n]
		if s.Art == "select" && s.Optionen != nil && s.Optionen.hat(w) {
			if name, ok := s.Optionen.wert(w).(string); ok {
				return name
			}
		}
	}
	return w
}

// ZeigeIn schreibt einen Wert wie die Oberfläche: Wörter mit ihrem Kundennamen.
func (L *Logik) ZeigeIn(x Wert) string {
	if x.Art == WertWort {
		return L.wortName(x.W)
	}
	return Zeige(x)
}

// Satz füllt {Formel}-Stellen eines Satzes mit den Werten von jetzt.
func (L *Logik) Satz(st *Lauf, ein *Eingabe, vorlage string) (string, error) {
	var b strings.Builder
	s := vorlage
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			b.WriteString(s)
			return b.String(), nil
		}
		j := strings.IndexByte(s[i:], '}')
		if j < 0 {
			b.WriteString(s)
			return b.String(), nil
		}
		b.WriteString(s[:i])
		formel := s[i+1 : i+j]
		baum, err := lies(formel)
		if err != nil {
			return "", err
		}
		x, err := L.rechne(st, ein, baum, 0)
		if err != nil {
			return "", err
		}
		b.WriteString(L.ZeigeIn(x))
		s = s[i+j+1:]
	}
}

func (L *Logik) satzSicher(st *Lauf, ein *Eingabe, vorlage string, fehlerAus *[]Ereignis) string {
	s, err := L.Satz(st, ein, vorlage)
	if err != nil {
		*fehlerAus = append(*fehlerAus, Ereignis{Was: "fehler", Text: err.Error()})
		return vorlage
	}
	return s
}

// Hilfe gibt den Hilfesatz eines Stellwerts mit den Werten von jetzt; bei Schaltern je nach Stellung.
func (L *Logik) Hilfe(st *Lauf, ein *Eingabe, kennung string) (string, error) {
	s := L.Stellwerte[kennung]
	if s == nil || s.Hilfe == nil {
		return "", nil
	}
	switch h := s.Hilfe.(type) {
	case string:
		return L.Satz(st, ein, h)
	case [2]string:
		w := st.Stell[kennung]
		if w.Art == WertBool && w.B {
			return L.Satz(st, ein, h[0])
		}
		return L.Satz(st, ein, h[1])
	}
	return "", nil
}
