package logik

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Die drei nachgebauten Tage aus dem Referenzlabor des Konzepts (Bericht Abschnitt 3):
// die Vorlage steuert die Anlage, dieselbe Aufzeichnung geht in den Kern (1:1-Fassung,
// Minutenraster 60 s). Der Kern muss jede Sekunde dasselbe entscheiden wie das Labor:
// Heizstufe, Netzheizen, Sperre, Vorrang, Lage samt Satz und die drei Ausgänge, dazu
// alle 177 Stufenwechsel zur selben Sekunde mit Schritt und Grund.

type tagErwartet struct {
	Meta struct {
		Winter   bool     `json:"winter"`
		Neustart *float64 `json:"neustart"`
		Raster   float64  `json:"raster"`
		Anlage   map[string]struct {
			KwProAusgang float64 `json:"kw_per_output"`
			Ausgaenge    int     `json:"outputs"`
		} `json:"anlage"`
	} `json:"meta"`
	Stufenwechsel []struct {
		T       float64 `json:"t"`
		Von     int     `json:"von"`
		Nach    int     `json:"nach"`
		Schritt string  `json:"schritt"`
		Grund   *string `json:"grund"`
	} `json:"stufenwechsel"`
	Laeufe     map[string]json.RawMessage `json:"laeufe"`
	Lagesaetze []struct {
		T     float64 `json:"t"`
		Nr    int     `json:"nr"`
		Titel string  `json:"titel"`
		Satz  string  `json:"satz"`
	} `json:"lagesaetze"`
}

// lauf entpackt einen lauflängen-kodierten Strom [[wert, anzahl], …] zu einem Wert je Sekunde.
func entpackeLauf[T any](t *testing.T, roh json.RawMessage, wandle func(json.RawMessage) T) []T {
	t.Helper()
	var paare [][2]json.RawMessage
	if err := json.Unmarshal(roh, &paare); err != nil {
		t.Fatalf("Lauf lesen: %v", err)
	}
	var aus []T
	for _, p := range paare {
		var n int
		if err := json.Unmarshal(p[1], &n); err != nil {
			t.Fatalf("Lauf lesen: %v", err)
		}
		v := wandle(p[0])
		for i := 0; i < n; i++ {
			aus = append(aus, v)
		}
	}
	return aus
}

func alsInt(t *testing.T) func(json.RawMessage) int {
	return func(r json.RawMessage) int {
		var v int
		if err := json.Unmarshal(r, &v); err != nil {
			t.Fatalf("Zahl lesen: %v", err)
		}
		return v
	}
}

func alsBool(t *testing.T) func(json.RawMessage) bool {
	return func(r json.RawMessage) bool {
		var v bool
		if err := json.Unmarshal(r, &v); err != nil {
			t.Fatalf("Ja/Nein lesen: %v", err)
		}
		return v
	}
}

func liesGz(t *testing.T, pfad string) *gzip.Reader {
	t.Helper()
	f, err := os.Open(pfad)
	if err != nil {
		t.Fatalf("%s: %v", pfad, err)
	}
	t.Cleanup(func() { f.Close() })
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("%s: %v", pfad, err)
	}
	return gz
}

type tagEingabe struct {
	hoehe, netzW, battW, soc, t1, t2, t3 *float64
	dle, puffer2, puffer3                float64
}

func liesEingaben(t *testing.T, name string) []tagEingabe {
	t.Helper()
	leser := bufio.NewScanner(liesGz(t, "testdata/tage/"+name+".eingaben.csv.gz"))
	leser.Buffer(make([]byte, 1024*1024), 1024*1024)
	if !leser.Scan() {
		t.Fatal("leere Eingabedatei")
	}
	kopf := strings.Split(leser.Text(), ",")
	erwartet := []string{"hoehe", "netzW", "battW", "soc", "t1", "t2", "t3", "dle", "puffer2", "puffer3"}
	if strings.Join(kopf, ",") != strings.Join(erwartet, ",") {
		t.Fatalf("unerwartete Spalten: %v", kopf)
	}
	var aus []tagEingabe
	vorher := make([]*float64, len(kopf))
	for leser.Scan() {
		teile := strings.Split(leser.Text(), ",")
		if len(teile) != len(kopf) {
			t.Fatalf("Zeile %d: %d Spalten", len(aus)+2, len(teile))
		}
		werte := make([]*float64, len(kopf))
		for i, text := range teile {
			switch text {
			case "":
				werte[i] = vorher[i]
			case "x":
				werte[i] = nil
			default:
				v, err := strconv.ParseFloat(text, 64)
				if err != nil {
					t.Fatalf("Zeile %d: %v", len(aus)+2, err)
				}
				werte[i] = &v
			}
		}
		vorher = werte
		pflicht := func(i int) float64 {
			if werte[i] == nil {
				t.Fatalf("Zeile %d: Spalte %s fehlt", len(aus)+2, kopf[i])
			}
			return *werte[i]
		}
		aus = append(aus, tagEingabe{
			hoehe: werte[0], netzW: werte[1], battW: werte[2], soc: werte[3],
			t1: werte[4], t2: werte[5], t3: werte[6],
			dle: pflicht(7), puffer2: pflicht(8), puffer3: pflicht(9),
		})
	}
	if err := leser.Err(); err != nil {
		t.Fatalf("Eingaben lesen: %v", err)
	}
	if len(aus) != 86400 {
		t.Fatalf("86400 Sekunden erwartet, %d gelesen", len(aus))
	}
	return aus
}

func TestDreiTageWieDasLabor(t *testing.T) {
	roh, err := os.ReadFile(dokumentePfad + "/steuerlogik/heizung-treu.logic.json")
	if err != nil {
		t.Fatalf("Dokument lesen: %v", err)
	}
	erwarteteWechsel := map[string]int{"sommer": 44, "wechselhaft": 87, "winter": 46}
	gesamt := 0
	for _, tag := range []string{"sommer", "wechselhaft", "winter"} {
		t.Run(tag, func(t *testing.T) {
			L, err := Lesen(roh)
			if err != nil {
				t.Fatalf("Lesen: %v", err)
			}
			var erwartet tagErwartet
			dec := json.NewDecoder(liesGz(t, "testdata/tage/"+tag+".erwartet.json.gz"))
			if err := dec.Decode(&erwartet); err != nil {
				t.Fatalf("Erwartung lesen: %v", err)
			}
			eingaben := liesEingaben(t, tag)

			sollHeizstufe := entpackeLauf(t, erwartet.Laeufe["heizstufe"], alsInt(t))
			sollNetzheizen := entpackeLauf(t, erwartet.Laeufe["netzheizen"], alsBool(t))
			sollSperre := entpackeLauf(t, erwartet.Laeufe["sperre"], alsBool(t))
			sollVorrang := entpackeLauf(t, erwartet.Laeufe["vorrang"], alsBool(t))
			sollLage := entpackeLauf(t, erwartet.Laeufe["lage"], alsInt(t))
			sollStufen := map[string][]int{}
			for _, g := range []string{"dle", "puffer2", "puffer3"} {
				sollStufen[g] = entpackeLauf(t, erwartet.Laeufe[g], alsInt(t))
			}

			st := L.NeuerLauf(0)
			st.Stell["winter"] = boolW(erwartet.Meta.Winter)
			stamm := map[string]GeraetStamm{}
			for g, a := range erwartet.Meta.Anlage {
				kw := a.KwProAusgang
				stamm[g] = GeraetStamm{KwJeAusgang: &kw, Ausgaenge: a.Ausgaenge}
			}
			var wechsel []Ereignis
			var lagen []Lage
			var lagenT []float64
			letzteLage := -2
			abweichungen := 0
			melde := func(s int, was string, ist, soll any) {
				if abweichungen < 20 {
					t.Errorf("Sekunde %d: %s ist %v, erwartet %v", s, was, ist, soll)
				}
				abweichungen++
			}
			for s := 0; s < 86400; s++ {
				if erwartet.Meta.Neustart != nil && float64(s) == *erwartet.Meta.Neustart {
					L.Neustart(st, float64(s))
				}
				e := eingaben[s]
				werte := map[string]EinWert{}
				setze := func(k string, v *float64, d Groesse, teiler float64) {
					if v == nil {
						return
					}
					w := *v / teiler
					werte[k] = EinWert{Zahl: &w, D: d}
				}
				setze("t1", e.t1, GroesseTemp, 1)
				setze("t2", e.t2, GroesseTemp, 1)
				setze("t3", e.t3, GroesseTemp, 1)
				setze("netz", e.netzW, GroesseKW, 1000)
				setze("speicher", e.battW, GroesseKW, 1000)
				setze("ladestand", e.soc, GroesseProzent, 1)
				setze("sonne", e.hoehe, GroesseWinkel, 1)
				geraete := map[string]GeraetStamm{}
				for g, basis := range stamm {
					b := basis
					var stufe float64
					switch g {
					case "dle":
						stufe = e.dle
					case "puffer2":
						stufe = e.puffer2
					default:
						stufe = e.puffer3
					}
					b.Stufe = &stufe
					geraete[g] = b
				}
				ein := &Eingabe{Jetzt: float64(s), UhrMin: float64(s) / 60, Tag: 1, DT: 1, Werte: werte, Geraete: geraete}
				r := L.TaktMitRaster(st, ein, erwartet.Meta.Raster)
				for _, ev := range r.Ereignisse {
					if ev.Was == "heizstufe" {
						wechsel = append(wechsel, ev)
					}
					if ev.Was == "fehler" {
						t.Fatalf("Sekunde %d: Fehler im Takt: %s", s, ev.Text)
					}
				}
				if st.Z["heizstufe"].wert != sollHeizstufe[s] {
					melde(s, "Heizstufe", st.Z["heizstufe"].wert, sollHeizstufe[s])
				}
				if st.Z["netzheizen"].an != sollNetzheizen[s] {
					melde(s, "Netzheizen", st.Z["netzheizen"].an, sollNetzheizen[s])
				}
				sperre := st.Z["sperre"].bis != nil && float64(s) < *st.Z["sperre"].bis
				if sperre != sollSperre[s] {
					melde(s, "Sperre", sperre, sollSperre[s])
				}
				if st.Z["vorrang"].an != sollVorrang[s] {
					melde(s, "Vorrang", st.Z["vorrang"].an, sollVorrang[s])
				}
				if r.Lage.Nr != sollLage[s] {
					melde(s, "Lage", r.Lage.Nr, sollLage[s])
				}
				for _, g := range []string{"dle", "puffer2", "puffer3"} {
					if r.Ausgaenge[g].Stufe != sollStufen[g][s] {
						melde(s, "Ausgang "+g, r.Ausgaenge[g].Stufe, sollStufen[g][s])
					}
				}
				if r.Lage.Nr != letzteLage {
					lagen = append(lagen, r.Lage)
					lagenT = append(lagenT, float64(s))
					letzteLage = r.Lage.Nr
				}
			}
			if abweichungen > 0 {
				t.Fatalf("%d abweichende Sekunden", abweichungen)
			}

			if len(wechsel) != erwarteteWechsel[tag] || len(wechsel) != len(erwartet.Stufenwechsel) {
				t.Fatalf("%d Stufenwechsel, erwartet %d", len(wechsel), erwarteteWechsel[tag])
			}
			for i, w := range wechsel {
				soll := erwartet.Stufenwechsel[i]
				grund := ""
				if soll.Grund != nil {
					grund = *soll.Grund
				}
				if w.T != soll.T || w.Von != soll.Von || w.Nach != soll.Nach || w.Schritt != soll.Schritt || w.Grund != grund {
					t.Errorf("Stufenwechsel %d: t=%v %d→%d „%s“ (%s), erwartet t=%v %d→%d „%s“ (%s)",
						i+1, w.T, w.Von, w.Nach, w.Schritt, w.Grund, soll.T, soll.Von, soll.Nach, soll.Schritt, grund)
				}
			}
			gesamt += len(wechsel)

			if len(lagen) != len(erwartet.Lagesaetze) {
				t.Fatalf("%d Lagewechsel, erwartet %d", len(lagen), len(erwartet.Lagesaetze))
			}
			for i, l := range lagen {
				soll := erwartet.Lagesaetze[i]
				if lagenT[i] != soll.T || l.Nr != soll.Nr || l.Titel != soll.Titel || l.Satz != soll.Satz {
					t.Errorf("Lagewechsel %d (Sekunde %v): Nr %d „%s“ / %q, erwartet (Sekunde %v) Nr %d „%s“ / %q",
						i+1, lagenT[i], l.Nr, l.Titel, l.Satz, soll.T, soll.Nr, soll.Titel, soll.Satz)
				}
			}
		})
	}
	if !t.Failed() && gesamt != 177 {
		t.Errorf("177 Stufenwechsel über drei Tage erwartet, %d gezählt", gesamt)
	}
}
