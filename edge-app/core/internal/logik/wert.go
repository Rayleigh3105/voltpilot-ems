// Package logik ist der Kern der Steuerlogik-Sprache (Vertrag: docs/contracts/v2/steuerlogik.md).
// Er liest eine Logik in ihrer kanonischen JSON-Form, prüft sie und wertet sie im Takt aus.
// Der Kern schaltet nichts: Je Takt äußert er nur, was die Geräte tun sollen; Schiedsrichter
// und Schutzgrenzen der Box bleiben davor (Rang 40, wie der Heizstab-Regler).
// Maßgeblich sind die Vektoren des Vertrags: dieselben sechs Logiken mit ihren Proben und
// die drei nachgebauten Tage entscheidet der Kern genau wie das Referenzlabor des Konzepts.
package logik

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Groesse ist die Einheit eines Werts. Rechnen und Vergleichen verlangen passende Größen.
type Groesse string

const (
	GroesseTemp    Groesse = "temp"     // °C
	GroesseDTemp   Groesse = "dtemp"    // K
	GroesseKW      Groesse = "leistung" // kW (W wird zu kW)
	GroesseProzent Groesse = "prozent"  // %
	GroesseDauer   Groesse = "dauer"    // s (min und h werden zu s)
	GroesseWinkel  Groesse = "winkel"   // °
	GroesseUhrzeit Groesse = "uhrzeit"  // Minuten seit Mitternacht
	GroesseZahl    Groesse = "zahl"     // ohne Einheit
	GroesseBool    Groesse = "bool"     // Ja/Nein (nur statisch)
	GroesseWort    Groesse = "wort"     // Wort einer Auswahl, Betriebsart, Schrittname (nur statisch)
	GroessePlan    Groesse = "plan"     // Zeitplan (nur statisch)
)

var groesseWort = map[Groesse]string{
	GroesseTemp: "Temperatur", GroesseDTemp: "Temperaturabstand", GroesseKW: "Leistung",
	GroesseProzent: "Prozent", GroesseDauer: "Dauer", GroesseWinkel: "Winkel",
	GroesseUhrzeit: "Uhrzeit", GroesseZahl: "Zahl",
}

// Eine Einheit der Schreibweise: Symbol, Größe, Faktor auf die Grundeinheit.
type einheit struct {
	sym    string
	d      Groesse
	faktor float64
}

// Reihenfolge wie im Referenzlabor: längere Symbole stehen vor ihren Präfixen nicht im Weg,
// weil kein Symbol Präfix eines anderen ist (°C wird vor ° geprüft).
var einheiten = []einheit{
	{"°C", GroesseTemp, 1}, {"K", GroesseDTemp, 1}, {"kW", GroesseKW, 1}, {"W", GroesseKW, 0.001},
	{"%", GroesseProzent, 1}, {"min", GroesseDauer, 60}, {"s", GroesseDauer, 1}, {"h", GroesseDauer, 3600},
	{"°", GroesseWinkel, 1},
}

// WertArt unterscheidet die Laufzeitwerte: unbekannt, Zahl mit Größe, Ja/Nein, Wort, Zeitplan.
type WertArt byte

const (
	WertUnbekannt WertArt = iota
	WertZahl
	WertBool
	WertWort
	WertPlan
)

// Wert ist ein Laufzeitwert der Sprache. Der Nullwert ist "unbekannt".
type Wert struct {
	Art  WertArt
	V    float64
	D    Groesse
	B    bool
	W    string
	Plan *Zeitplan
}

func unbekanntW() Wert                { return Wert{} }
func zahlW(v float64, d Groesse) Wert { return Wert{Art: WertZahl, V: v, D: d} }
func boolW(b bool) Wert               { return Wert{Art: WertBool, B: b} }
func wortW(w string) Wert             { return Wert{Art: WertWort, W: w} }

// Fehler ist ein Fehler der Sprache (Lesen, Einheiten, unbekannte Namen).
type Fehler struct{ Text string }

func (e *Fehler) Error() string { return e.Text }

func fehler(format string, a ...any) *Fehler { return &Fehler{Text: fmt.Sprintf(format, a...)} }

// Zeitplan ist der Wert eines Stellwerts der Art "schedule".
type Zeitplan struct {
	Fenster []Planfenster
}

// Planfenster ist ein Eintrag des Zeitplans: Tage, von (zählt mit), bis (zählt nicht).
type Planfenster struct {
	Tage []int // 0 = mon … 6 = sun
	Von  float64
	Bis  float64
	Text string
	// TageText sind die Tage, wie der Text sie schreibt ("mon-fri"); leer nach dem Laden von der Platte.
	TageText string
}

// Die Wochentage der Sprache (E9: englische Wörter wie Home Assistant).
var tage = []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

var uhrzeitRe = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// LiesWert liest einen festen Wert aus dem Dokument: "57 °C", "on", 3, "06:00", "unknown".
// Nach dem Vertrag gelten on und true, off und false als dasselbe.
func LiesWert(roh any) (Wert, error) {
	switch v := roh.(type) {
	case bool:
		return boolW(v), nil
	case float64:
		return zahlW(v, GroesseZahl), nil
	case nil:
		return unbekanntW(), nil
	case string:
		s := strings.TrimSpace(v)
		switch s {
		case "on", "true":
			return boolW(true), nil
		case "off", "false":
			return boolW(false), nil
		case "unknown":
			return unbekanntW(), nil
		}
		if m := uhrzeitRe.FindStringSubmatch(s); m != nil {
			h, _ := strconv.Atoi(m[1])
			min, _ := strconv.Atoi(m[2])
			return zahlW(float64(h*60+min), GroesseUhrzeit), nil
		}
		b, err := lies(s)
		if err != nil {
			return Wert{}, err
		}
		if b.t == kZahl {
			return zahlW(b.v, b.d), nil
		}
		if b.t == kUn && b.op == "-" && b.x.t == kZahl {
			return zahlW(-b.x.v, b.x.d), nil
		}
		return Wert{}, fehler("Kein Wert: „%s“", s)
	default:
		return Wert{}, fehler("Kein Wert: %v", roh)
	}
}

// liesPlan liest einen Zeitplan: Liste aus {days: "mon-fri" | "sat,sun", from: "07:00", to: "18:00"}.
func liesPlan(roh any) (*Zeitplan, error) {
	liste, ok := roh.([]any)
	if !ok || len(liste) == 0 {
		return nil, fehler("Ein Zeitplan ist eine Liste aus Tagen mit from und to")
	}
	p := &Zeitplan{}
	for _, e := range liste {
		f, ok := e.(*jObjekt)
		if !ok {
			return nil, fehler("Ein Zeitplan ist eine Liste aus Tagen mit from und to")
		}
		tageText, _ := f.wert("days").(string)
		gesehen := map[int]bool{}
		var reihenfolge []int
		for _, teil := range strings.Split(tageText, ",") {
			a, b, _ := strings.Cut(strings.TrimSpace(teil), "-")
			i := tagIndex(a)
			j := i
			if b != "" {
				j = tagIndex(b)
			}
			if i < 0 || j < 0 {
				return nil, fehler("Unbekannter Tag in „%s“", tageText)
			}
			for k := i; ; k = (k + 1) % 7 {
				if !gesehen[k] {
					gesehen[k] = true
					reihenfolge = append(reihenfolge, k)
				}
				if k == j {
					break
				}
			}
		}
		vonText, ok1 := f.wert("from").(string)
		bisText, ok2 := f.wert("to").(string)
		if !ok1 || !ok2 {
			return nil, fehler("Ein Zeitplan braucht from und to als Uhrzeit")
		}
		von, err := LiesWert(vonText)
		if err != nil {
			return nil, err
		}
		bis, err := LiesWert(bisText)
		if err != nil {
			return nil, err
		}
		if von.Art != WertZahl || bis.Art != WertZahl || von.D != GroesseUhrzeit || bis.D != GroesseUhrzeit {
			return nil, fehler("Ein Zeitplan braucht from und to als Uhrzeit")
		}
		sortiert := append([]int(nil), reihenfolge...)
		for i := 1; i < len(sortiert); i++ {
			for j := i; j > 0 && sortiert[j] < sortiert[j-1]; j-- {
				sortiert[j], sortiert[j-1] = sortiert[j-1], sortiert[j]
			}
		}
		text := titleTage(tageText) + " " + vonText + " bis " + bisText
		p.Fenster = append(p.Fenster, Planfenster{Tage: sortiert, Von: von.V, Bis: bis.V, Text: text, TageText: tageText})
	}
	return p, nil
}

func tagIndex(t string) int {
	for i, n := range tage {
		if n == t {
			return i
		}
	}
	return -1
}

// titleTage schreibt wie das Referenzlabor den ersten Buchstaben jedes Worts groß ("Mon-Fri").
func titleTage(s string) string {
	var b strings.Builder
	vorher := byte(' ')
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' && !istBuchstabe(vorher) {
			c = c - 'a' + 'A'
		}
		b.WriteByte(c)
		vorher = c
	}
	return b.String()
}

func istBuchstabe(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
