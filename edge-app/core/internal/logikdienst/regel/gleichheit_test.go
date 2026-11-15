package regel

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
)

// Der Gleichheitsbeleg (Stufe 6, Zusammenführen): jede Regel der Vektoren, übersetzt und im Kern
// Sekunde für Sekunde ausgeführt, wünscht in jeder Sekunde dasselbe wie derselbe Flow, mit flowc
// kompiliert und wie in Node-RED ausgeführt (edge-app/nodered/flowc/regel-kern-vectors.gen.js) -
// außer in den Abschnitten, die die Vektoren mit Grund und dem Wert des Kerns nennen.

const vektorPfad = "../../../../../docs/contracts/v2/regel-kern-vectors.json"

// vektorEreignis ist ein Messwert oder ein Preis, der in Sekunde T ankommt.
type vektorEreignis struct {
	T          int
	Quelle     string
	Wert       float64
	Preis      bool
	GueltigBis int
}

type vektorAbweichung struct {
	Von   int             `json:"von"`
	Bis   int             `json:"bis"`
	Kern  json.RawMessage `json:"kern"`
	Grund string          `json:"grund"`
}

type vektorFall struct {
	Name      string          `json:"name"`
	Satz      string          `json:"satz"`
	Start     string          `json:"start"`
	Dauer     int             `json:"dauer_s"`
	Dokument  json.RawMessage `json:"dokument"`
	Messwerte []struct {
		Quelle string       `json:"quelle"`
		Proben [][2]float64 `json:"proben"`
	} `json:"messwerte"`
	Preise       [][3]float64       `json:"preise"`
	Ereignisse   []vektorEreignis   `json:"-"`
	NodeRed      [][2]any           `json:"nodered"`
	Abweichungen []vektorAbweichung `json:"abweichungen"`
}

type vektorDatei struct {
	TTL    int `json:"ttl_s"`
	Anlage []struct {
		ID    string   `json:"id"`
		Name  string   `json:"name"`
		Typ   string   `json:"typ"`
		Misst []string `json:"misst"`
	} `json:"anlage"`
	Faelle []vektorFall `json:"faelle"`
}

func liesVektoren(t *testing.T) (vektorDatei, Anlage) {
	t.Helper()
	roh, err := os.ReadFile(vektorPfad)
	if err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	var v vektorDatei
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	for i := range v.Faelle {
		f := &v.Faelle[i]
		for _, m := range f.Messwerte {
			for _, p := range m.Proben {
				f.Ereignisse = append(f.Ereignisse, vektorEreignis{T: int(p[0]), Quelle: m.Quelle, Wert: p[1]})
			}
		}
		for _, p := range f.Preise {
			f.Ereignisse = append(f.Ereignisse, vektorEreignis{T: int(p[0]), Quelle: "price.current", Wert: p[1],
				Preis: true, GueltigBis: int(p[2])})
		}
		sort.SliceStable(f.Ereignisse, func(a, b int) bool { return f.Ereignisse[a].T < f.Ereignisse[b].T })
	}
	a := Anlage{}
	for _, g := range v.Anlage {
		a[g.ID] = Geraet{Name: g.Name, Typ: g.Typ, Misst: g.Misst}
	}
	return v, a
}

// wunschText macht aus einem Wunsch einen vergleichbaren Text: "true", "false", eine Zahl, "null".
func wunschText(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return json.Number(strconvF(x)).String()
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}

func strconvF(v float64) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

func entpacke(t *testing.T, rle [][2]any) []string {
	t.Helper()
	var out []string
	for _, p := range rle {
		n, ok := p[1].(float64)
		if !ok {
			t.Fatalf("Lauf: Anzahl %v", p[1])
		}
		for i := 0; i < int(n); i++ {
			out = append(out, wunschText(p[0]))
		}
	}
	return out
}

func kernLogik(t *testing.T, text string) *logik.Logik {
	t.Helper()
	baum, err := textform.Lies([]byte(text))
	if err != nil {
		t.Fatalf("Übersetzung nicht lesbar: %v\n%s", err, text)
	}
	kanonisch, err := baum.JSON()
	if err != nil {
		t.Fatalf("Übersetzung nicht kanonisch: %v", err)
	}
	L, err := logik.Lesen(kanonisch)
	if err != nil {
		t.Fatalf("Kern liest die Übersetzung nicht: %v\n%s", err, text)
	}
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("Prüfung sperrt die Übersetzung: %+v\n%s", b.Befunde, text)
	}
	return L
}

// kernLauf führt die übersetzte Logik über die Zeitleiste aus: je Sekunde ein Takt mit den
// Werten der Ereignisse (Alter ab ihrer Ankunft), der Preis nur, solange er gilt (die Box liest
// ihn so, agent.logikQuelle über pricefeed.Current).
func kernLauf(t *testing.T, L *logik.Logik, f vektorFall) []string {
	t.Helper()
	start, err := time.Parse(time.RFC3339, f.Start)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	zone, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("Zeitzone: %v", err)
	}
	kennung := map[string]string{}
	for _, n := range L.WertListe {
		kennung[L.Werte[n].Source] = n
	}
	type letzter struct {
		v     float64
		t     int
		bis   int
		preis bool
	}
	letzte := map[string]*letzter{}
	st := L.NeuerLauf(0)
	var out []string
	e := 0
	for s := 0; s < f.Dauer; s++ {
		for e < len(f.Ereignisse) && f.Ereignisse[e].T <= s {
			ev := f.Ereignisse[e]
			e++
			letzte[ev.Quelle] = &letzter{v: ev.Wert, t: ev.T, bis: ev.GueltigBis, preis: ev.Preis}
		}
		jetzt := start.Add(time.Duration(s) * time.Second).In(zone)
		ein := &logik.Eingabe{
			Jetzt:     float64(s),
			UhrMin:    float64(jetzt.Hour())*60 + float64(jetzt.Minute()) + float64(jetzt.Second())/60,
			Tag:       jetzt.Year()*1000 + jetzt.YearDay(),
			Wochentag: (int(jetzt.Weekday()) + 6) % 7,
			DT:        1,
			Werte:     map[string]logik.EinWert{},
			Geraete:   map[string]logik.GeraetStamm{"geraet": {}},
		}
		for quelle, l := range letzte {
			n, ok := kennung[quelle]
			if !ok || (l.preis && s >= l.bis) {
				continue
			}
			v := l.v
			ein.Werte[n] = logik.EinWert{Zahl: &v, Alter: float64(s - l.t)}
		}
		a := L.Takt(st, ein).Ausgaenge["geraet"]
		switch {
		case a.HatEin && a.Ein != nil:
			out = append(out, wunschText(*a.Ein))
		case a.HatSollwert && a.Sollwert != nil:
			out = append(out, wunschText(a.Sollwert.V))
		default:
			out = append(out, "null")
		}
	}
	return out
}

func TestKernEntscheidetWieNodeRed(t *testing.T) {
	v, anlage := liesVektoren(t)
	if len(v.Faelle) < 10 {
		t.Fatalf("zu wenige Fälle: %d", len(v.Faelle))
	}
	for _, f := range v.Faelle {
		t.Run(f.Name, func(t *testing.T) {
			erg, err := UebersetzeDokument(f.Dokument, anlage, Herkunft{Name: f.Name, Fassung: 1})
			if err != nil {
				t.Fatalf("Lesen: %v", err)
			}
			if len(erg.Gruende) > 0 {
				t.Fatalf("nicht übersetzt: %+v", erg.Gruende)
			}
			L := kernLogik(t, erg.Text)
			kern := kernLauf(t, L, f)
			alt := entpacke(t, f.NodeRed)
			if len(alt) != f.Dauer || len(kern) != f.Dauer {
				t.Fatalf("Länge: nodered %d, kern %d, dauer %d", len(alt), len(kern), f.Dauer)
			}
			erwartet := append([]string(nil), alt...)
			for _, ab := range f.Abweichungen {
				var w any
				if err := json.Unmarshal(ab.Kern, &w); err != nil {
					t.Fatalf("Abweichung: %v", err)
				}
				for s := ab.Von; s < ab.Bis && s < f.Dauer; s++ {
					if erwartet[s] == wunschText(w) {
						t.Errorf("Abweichung „%s“ in Sekunde %d nennt den Wert des alten Wegs (%s)", ab.Grund, s, erwartet[s])
					}
					erwartet[s] = wunschText(w)
				}
			}
			fehler := 0
			for s := range erwartet {
				if kern[s] != erwartet[s] {
					if fehler < 8 {
						t.Errorf("Sekunde %d (%s): Kern %s, erwartet %s (Node-RED %s)", s,
							zeitpunkt(f.Start, s), kern[s], erwartet[s], alt[s])
					}
					fehler++
				}
			}
			if fehler > 0 {
				t.Errorf("%d Sekunden verschieden\n%s", fehler, erg.Text)
			}
			// Mindestens ein Wechsel, sonst belegt der Fall nichts.
			wechsel := 0
			for s := 1; s < len(alt); s++ {
				if alt[s] != alt[s-1] {
					wechsel++
				}
			}
			if wechsel == 0 && !strings.HasPrefix(f.Name, "Abweichung") {
				t.Errorf("der Fall wechselt nie")
			}
		})
	}
}

func zeitpunkt(start string, s int) string {
	t0, err := time.Parse(time.RFC3339, start)
	if err != nil {
		return "?"
	}
	zone, _ := time.LoadLocation("Europe/Berlin")
	return t0.Add(time.Duration(s) * time.Second).In(zone).Format("15:04:05")
}
