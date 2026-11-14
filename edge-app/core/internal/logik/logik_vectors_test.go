package logik

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Die Vertragsvektoren: sechs Logiken mit ihren Proben aus dem Referenzlabor des
// Steuerlogik-Konzepts. Der Kern muss jeden Vektor genau wie das Labor entscheiden;
// Abweichungen sind Fehler, keine Auslegung (docs/contracts/v2/steuerlogik.md).

const vektorenPfad = "../../../../docs/contracts/v2/steuerlogik-vectors.json"
const dokumentePfad = "../../../../docs/contracts/v2"

type vektorDatei struct {
	SchemaVersion string        `json:"schema_version"`
	Logiken       []vektorLogik `json:"logiken"`
}

type vektorLogik struct {
	Name     string                  `json:"name"`
	Datei    string                  `json:"datei"`
	Anlage   map[string]vektorGeraet `json:"anlage"`
	Pruefung vektorPruefung          `json:"pruefung"`
	Proben   []vektorProbe           `json:"proben"`
}

type vektorGeraet struct {
	KwProAusgang    *float64  `json:"kw_per_output"`
	Ausgaenge       int       `json:"outputs"`
	SollwertBereich []float64 `json:"setpoint_range"`
}

type vektorPruefung struct {
	Ausdruecke int              `json:"ausdruecke"`
	Befunde    int              `json:"befunde"`
	Zusammen   []vektorZusammen `json:"zusammen"`
	Zielwerte  []string         `json:"zielwerte"`
}

type vektorZusammen struct {
	Name       string `json:"name"`
	Gilt       bool   `json:"gilt"`
	Verletzbar bool   `json:"im_bereich_verletzbar"`
}

type vektorProbe struct {
	Name         string             `json:"name"`
	Besteht      bool               `json:"besteht"`
	Abweichungen []vektorAbweichung `json:"abweichungen"`
}

type vektorAbweichung struct {
	Stelle string `json:"stelle"`
	Soll   string `json:"soll"`
	Ist    string `json:"ist"`
}

func liesVektoren(t *testing.T) vektorDatei {
	t.Helper()
	roh, err := os.ReadFile(vektorenPfad)
	if err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	var v vektorDatei
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	return v
}

func (g vektorGeraet) nachKern() ProbenGeraet {
	p := ProbenGeraet{KwJeAusgang: g.KwProAusgang, Ausgaenge: g.Ausgaenge}
	if len(g.SollwertBereich) == 2 {
		p.SollwertBereich = &[2]float64{g.SollwertBereich[0], g.SollwertBereich[1]}
	}
	return p
}

// Die Zahlen sind festgenagelt, damit kein Vektor still verschwindet oder dazukommt:
// sechs Logiken, 50 Proben, eine davon besteht gewollt nicht (B1 der 1:1-Fassung).
func TestVektorenZaehlung(t *testing.T) {
	v := liesVektoren(t)
	if len(v.Logiken) != 6 {
		t.Fatalf("6 Logiken erwartet, %d gelesen", len(v.Logiken))
	}
	proben := 0
	durchgefallen := 0
	for _, l := range v.Logiken {
		proben += len(l.Proben)
		for _, p := range l.Proben {
			if !p.Besteht {
				durchgefallen++
			}
		}
	}
	if proben != 50 {
		t.Fatalf("50 Proben erwartet, %d gelesen", proben)
	}
	if durchgefallen != 1 {
		t.Fatalf("genau eine gewollt nicht bestehende Probe erwartet, %d gelesen", durchgefallen)
	}
	erwartet := map[string]int{"heizung-treu": 11, "heizung": 13, "wasser": 5, "kuehlraum": 8, "waermepumpe": 6, "klima": 7}
	for _, l := range v.Logiken {
		if len(l.Proben) != erwartet[l.Name] {
			t.Errorf("%s: %d Proben erwartet, %d gelesen", l.Name, erwartet[l.Name], len(l.Proben))
		}
	}
}

func TestVektorenWieDasLabor(t *testing.T) {
	v := liesVektoren(t)
	for _, vl := range v.Logiken {
		t.Run(vl.Name, func(t *testing.T) {
			roh, err := os.ReadFile(filepath.Join(dokumentePfad, vl.Datei))
			if err != nil {
				t.Fatalf("Dokument lesen: %v", err)
			}
			L, err := Lesen(roh)
			if err != nil {
				t.Fatalf("Lesen: %v", err)
			}
			anlage := map[string]ProbenGeraet{}
			for k, g := range vl.Anlage {
				anlage[k] = g.nachKern()
			}
			bericht := L.Pruefe(anlage)

			// Punkt 1 und 2: Aufbau, Einheiten, Stellwerte.
			if bericht.Ausdruecke != vl.Pruefung.Ausdruecke {
				t.Errorf("Ausdrücke: %d erwartet, %d gezählt", vl.Pruefung.Ausdruecke, bericht.Ausdruecke)
			}
			for _, b := range bericht.Befunde {
				t.Errorf("unerwarteter Befund: %s", b.Text)
			}
			if len(bericht.Zusammen) != len(vl.Pruefung.Zusammen) {
				t.Fatalf("constraints: %d erwartet, %d geprüft", len(vl.Pruefung.Zusammen), len(bericht.Zusammen))
			}
			for i, z := range bericht.Zusammen {
				soll := vl.Pruefung.Zusammen[i]
				if z.Name != soll.Name || z.Gilt != soll.Gilt || z.Verletzbar != soll.Verletzbar {
					t.Errorf("constraints „%s“: gilt=%v verletzbar=%v, erwartet gilt=%v verletzbar=%v",
						z.Name, z.Gilt, z.Verletzbar, soll.Gilt, soll.Verletzbar)
				}
			}
			var ziele []string
			for _, n := range L.StellListe {
				if L.Stellwerte[n].Zielwert() {
					ziele = append(ziele, n)
				}
			}
			sortiere(ziele)
			if !gleicheListe(ziele, vl.Pruefung.Zielwerte) {
				t.Errorf("Zielwerte (E2): %v erwartet, %v erkannt", vl.Pruefung.Zielwerte, ziele)
			}

			// Punkt 3: jede Probe entscheidet wie das Labor.
			if len(bericht.Proben) != len(vl.Proben) {
				t.Fatalf("Proben: %d erwartet, %d gelaufen", len(vl.Proben), len(bericht.Proben))
			}
			for i, soll := range vl.Proben {
				ist := bericht.Proben[i]
				if ist.Name != soll.Name {
					t.Errorf("Probe %d heißt „%s“, erwartet „%s“", i+1, ist.Name, soll.Name)
					continue
				}
				if ist.Bestanden != soll.Besteht {
					t.Errorf("Probe „%s“: bestanden=%v, erwartet %v (Abweichungen: %v)", ist.Name, ist.Bestanden, soll.Besteht, ist.Abweichungen)
					continue
				}
				if len(ist.Abweichungen) != len(soll.Abweichungen) {
					t.Errorf("Probe „%s“: %d Abweichungen, erwartet %d: %v", ist.Name, len(ist.Abweichungen), len(soll.Abweichungen), ist.Abweichungen)
					continue
				}
				for j, a := range ist.Abweichungen {
					s := soll.Abweichungen[j]
					if a.Stelle != s.Stelle || a.Soll != s.Soll || a.Ist != s.Ist {
						t.Errorf("Probe „%s“: Abweichung %v, erwartet %v", ist.Name, a, s)
					}
				}
			}

			// Nach E5 = C ist eine Logik ohne Proben erlaubt; diese sechs haben welche.
			if len(L.Proben) > 0 {
				for _, h := range bericht.Hinweise {
					if h == "Keine Proben: Verhalten nicht belegt" {
						t.Errorf("Hinweis „Keine Proben“ trotz %d Proben", len(L.Proben))
					}
				}
			}
			// Die 1:1-Fassung sperrt wegen der gewollt nicht bestehenden Probe (E5: vorhandene Proben sperren).
			erwarteSperre := vl.Name == "heizung-treu"
			if bericht.Sperrt() != erwarteSperre {
				t.Errorf("Sperrt() = %v, erwartet %v", bericht.Sperrt(), erwarteSperre)
			}
		})
	}
}

func sortiere(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func gleicheListe(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
