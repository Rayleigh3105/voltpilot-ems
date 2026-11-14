package logik

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Die Gerätevektoren (Klima, Heizung, Kälte; K2/K3): Sollwert mit Bereich und Schrittweite
// des Geräts, die geschlossene Liste seiner Betriebsarten und der zurückgelesene Stand
// (docs/contracts/v2/steuerlogik-geraete-vectors.json). Anders als die Laborvektoren sind
// sie von Hand geschrieben; der Kern ist hier die Referenz, der Dienst neben der API liest
// dieselbe Datei.

const geraeteVektorenPfad = "../../../../docs/contracts/v2/steuerlogik-geraete-vectors.json"

type geraeteVektorDatei struct {
	SchemaVersion string              `json:"schema_version"`
	Faelle        []geraeteVektorFall `json:"faelle"`
}

type geraeteVektorFall struct {
	Name    string                         `json:"name"`
	Datei   string                         `json:"datei"`
	Anlage  map[string]geraeteVektorGeraet `json:"anlage"`
	Befunde []string                       `json:"befunde"`
	Proben  []geraeteVektorProbe           `json:"proben"`
}

type geraeteVektorGeraet struct {
	SollwertBereich []float64 `json:"setpoint_range"`
	SollwertSchritt *float64  `json:"setpoint_step"`
	Betriebsarten   []string  `json:"modes"`
}

type geraeteVektorProbe struct {
	Name         string             `json:"name"`
	Given        json.RawMessage    `json:"given"` // roh: die Reihenfolge ist Bedeutung
	After        string             `json:"after"`
	Expect       json.RawMessage    `json:"expect"`
	Besteht      bool               `json:"besteht"`
	Abweichungen []vektorAbweichung `json:"abweichungen"`
}

func (g geraeteVektorGeraet) nachKern() ProbenGeraet {
	p := ProbenGeraet{SollwertSchritt: g.SollwertSchritt, Betriebsarten: g.Betriebsarten}
	if len(g.SollwertBereich) == 2 {
		p.SollwertBereich = &[2]float64{g.SollwertBereich[0], g.SollwertBereich[1]}
	}
	return p
}

// MitProben ersetzt die Proben einer Logik durch die des Falls. Die Wurzel des Dokuments
// ist ungeordnet; die Reihenfolge in given und states bleibt roh erhalten.
func mitProben(t *testing.T, dokument []byte, proben []geraeteVektorProbe) []byte {
	t.Helper()
	var wurzel map[string]json.RawMessage
	if err := json.Unmarshal(dokument, &wurzel); err != nil {
		t.Fatalf("Dokument lesen: %v", err)
	}
	type probe struct {
		Name   string          `json:"name"`
		Given  json.RawMessage `json:"given"`
		After  string          `json:"after"`
		Expect json.RawMessage `json:"expect"`
	}
	var liste []probe
	for _, p := range proben {
		liste = append(liste, probe{p.Name, p.Given, p.After, p.Expect})
	}
	roh, err := json.Marshal(liste)
	if err != nil {
		t.Fatal(err)
	}
	wurzel["tests"] = roh
	aus, err := json.Marshal(wurzel)
	if err != nil {
		t.Fatal(err)
	}
	return aus
}

func TestGeraeteVektoren(t *testing.T) {
	roh, err := os.ReadFile(geraeteVektorenPfad)
	if err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	var v geraeteVektorDatei
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	if v.SchemaVersion != "1.0" || len(v.Faelle) != 5 {
		t.Fatalf("5 Fälle in Version 1.0 erwartet, %d in %s gelesen", len(v.Faelle), v.SchemaVersion)
	}
	for _, f := range v.Faelle {
		t.Run(f.Name, func(t *testing.T) {
			dok, err := os.ReadFile(filepath.Join(dokumentePfad, f.Datei))
			if err != nil {
				t.Fatalf("Dokument lesen: %v", err)
			}
			L, err := Lesen(mitProben(t, dok, f.Proben))
			if err != nil {
				t.Fatalf("Lesen: %v", err)
			}
			anlage := map[string]ProbenGeraet{}
			for k, g := range f.Anlage {
				anlage[k] = g.nachKern()
			}
			bericht := L.Pruefe(anlage)
			var befunde []string
			for _, b := range bericht.Befunde {
				befunde = append(befunde, b.Text)
			}
			if !gleicheListe(befunde, f.Befunde) {
				t.Errorf("Befunde %q, erwartet %q", befunde, f.Befunde)
			}
			// Jede Probe auch dann, wenn die Prüfung schon sperrt: sie zeigt, was die Box
			// mit diesem Gerät täte.
			for i, soll := range f.Proben {
				ist, err := L.FuehreProbe(L.Proben[i], anlage)
				if err != nil {
					t.Fatalf("Probe „%s“: %v", soll.Name, err)
				}
				if ist.Bestanden != soll.Besteht || len(ist.Abweichungen) != len(soll.Abweichungen) {
					t.Errorf("Probe „%s“: bestanden=%v %v, erwartet %v %v", soll.Name, ist.Bestanden,
						ist.Abweichungen, soll.Besteht, soll.Abweichungen)
					continue
				}
				for j, a := range ist.Abweichungen {
					s := soll.Abweichungen[j]
					// Die Vektoren schreiben ein gewöhnliches Leerzeichen vor die Einheit.
					if a.Stelle != s.Stelle || ohneNBSP(a.Soll) != s.Soll || ohneNBSP(a.Ist) != s.Ist {
						t.Errorf("Probe „%s“: Abweichung %v, erwartet %v", soll.Name, a, s)
					}
				}
			}
		})
	}
}

// Das neue Beispiel besteht ohne Angaben der Anlage seine eigenen Proben, wie die sechs
// Laborlogiken.
func TestWaermepumpeModbusBestehtSelbst(t *testing.T) {
	roh, err := os.ReadFile(filepath.Join(dokumentePfad, "steuerlogik/waermepumpe-modbus.logic.json"))
	if err != nil {
		t.Fatal(err)
	}
	L, err := Lesen(roh)
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	b := L.Pruefe(nil)
	if b.Sperrt() || len(b.Proben) != 5 {
		t.Fatalf("Prüfung sperrt=%v, %d Proben, Befunde %v", b.Sperrt(), len(b.Proben), b.Befunde)
	}
}

// Takt: ein Wort, das das Gerät nicht kennt, ist kein Wunsch und ein Fehler-Ereignis;
// der Sollwert wird gerundet und begrenzt; die Rücklesung ist .setpoint und .mode.
func TestTaktMitGeraeteangaben(t *testing.T) {
	text := `{"logic":1,"name":"T","devices":{"g":{"entity":"e","name":"G"}},` +
		`"settings":{"soll":{"name":"S","default":"21.26 °C","range":["5 °C","40 °C"],"step":"0.01 K"},` +
		`"art":{"name":"A","type":"select","default":"dry","options":{"dry":"Trocknen","heat":"Heizen"}}},` +
		`"outputs":{"g":{"setpoint":"soll","mode":"art"}},` +
		`"status":[{"when":"g.mode == heat and g.setpoint > 20 °C","title":"Warm","type":"idle","text":"{g.setpoint}"},` +
		`{"else":true,"title":"Sonst","type":"idle","text":""}]}`
	L, err := Lesen([]byte(text))
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	st := L.NeuerLauf(0)
	schritt := 0.5
	ruecksoll := 21.5
	ein := &Eingabe{Jetzt: 1, UhrMin: 600, Tag: 1, DT: 1, Werte: map[string]EinWert{}, Geraete: map[string]GeraetStamm{
		"g": {SollwertBereich: &[2]float64{16, 30}, SollwertSchritt: &schritt, Betriebsarten: []string{"heat", "cool"},
			Sollwert: &ruecksoll, Betriebsart: "heat"},
	}}
	erg := L.Takt(st, ein)
	a := erg.Ausgaenge["g"]
	if a.Sollwert == nil || a.Sollwert.V != 21.5 {
		t.Fatalf("Sollwert 21,26 °C auf 0,5 K ab 16 °C: 21,5 erwartet, %v", a.Sollwert)
	}
	if a.Betriebsart != "" || !a.HatBetriebsart {
		t.Fatalf("„dry“ kennt das Gerät nicht: kein Wunsch erwartet, %q", a.Betriebsart)
	}
	fehler := 0
	for _, e := range erg.Ereignisse {
		if e.Was == "fehler" && e.Text == "Das Gerät kennt die Betriebsart „dry“ nicht" {
			fehler++
		}
	}
	if fehler != 1 {
		t.Fatalf("ein Fehler-Ereignis erwartet: %+v", erg.Ereignisse)
	}
	if erg.Lage.Titel != "Warm" || erg.Lage.Satz != "21,5\u00a0°C" {
		t.Fatalf("Lage aus der Rücklesung: %q %q", erg.Lage.Titel, erg.Lage.Satz)
	}
	// Ohne Rücklesung ist .setpoint unbekannt, nie 0.
	g := ein.Geraete["g"]
	g.Sollwert, g.Betriebsart = nil, ""
	ein.Geraete["g"] = g
	ein.Jetzt = 2
	if erg := L.Takt(st, ein); erg.Lage.Titel != "Sonst" {
		t.Fatalf("ohne Rücklesung: Lage %q", erg.Lage.Titel)
	}
}

func ohneNBSP(s string) string { return strings.ReplaceAll(s, "\u00a0", " ") }
