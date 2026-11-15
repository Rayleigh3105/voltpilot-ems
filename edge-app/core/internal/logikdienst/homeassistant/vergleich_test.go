package homeassistant

// Der Maßstab des Übersetzers (Bericht Anhang A, Auftrag Stufe 6): eine Anlage, die wie
// die Vorlage aufgebaut ist, ergibt eine Logik, die sich wie die Hand-Übersetzung
// "heizung-treu" verhält. Beleg sind deren Vektoren: die elf Proben (mit den Namen der
// Übersetzung) und die drei nachgebauten Tage, Sekunde für Sekunde (Heizstufe,
// Netzheizen, Sperre, Vorrang, Titel der Lage, die drei Ausgänge, jeder Stufenwechsel).

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
)

const (
	tageOrdner = "../../logik/testdata/tage/"
	handPfad   = "../../../../../docs/contracts/v2/steuerlogik/heizung-treu.logic.json"
)

// handNamen sagt, welche Entität einer Anlage von Home Assistant welchem Namen der
// Hand-Übersetzung entspricht.
type handNamen struct {
	// Eingänge der Hand-Übersetzung (t1, t2, t3, netz, speicher, ladestand) → Messwert
	Eingaenge map[string]string `json:"eingaenge"`
	// Rohwerte, die mit umgekehrtem Vorzeichen zählen (Batterie: + = entladen)
	Gedreht map[string]bool `json:"gedreht"`
	// Geräte (dle, puffer2, puffer3) → ein Schalter des Geräts
	Geraete map[string]string `json:"geraete"`
	// Zustände (heizstufe, netzheizen, sperre, vorrang) und der Stellwert winter → Entität
	Zustaende map[string]string `json:"zustaende"`
	Winter    string            `json:"winter"`
}

// quelleFuer: woher die Box den Wert eines Eingangs der Hand-Übersetzung liest.
var quelleFuer = map[string]string{
	"t1": "fuehler-speicher-1.temperature", "t2": "fuehler-speicher-2.temperature", "t3": "fuehler-speicher-3.temperature",
	"netz": "site.grid", "speicher": "battery.power", "ladestand": "battery.soc",
}

func leseDateien(t *testing.T, ordner string) []Datei {
	t.Helper()
	var ds []Datei
	for _, n := range []string{"configuration.yaml", "automations.yaml", "scripts.yaml"} {
		b, err := os.ReadFile(filepath.Join(ordner, n))
		if err != nil {
			t.Fatal(err)
		}
		ds = append(ds, Datei{Name: n, Text: string(b)})
	}
	return ds
}

// uebersetzeZugeordnet übersetzt, ordnet die Lücken wie die Hand-Übersetzung zu und
// nennt je Name der Hand-Übersetzung den Namen in der Übersetzung.
func uebersetzeZugeordnet(t *testing.T, ds []Datei, hn handNamen) (*Ergebnis, map[string]string) {
	t.Helper()
	erst, err := Uebersetze(ds, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(erst.NichtUebersetzt) > 0 {
		t.Fatalf("nicht übersetzbar: %+v", erst.NichtUebersetzt)
	}
	luecke := func(entity string) *Luecke {
		for i := range erst.Luecken {
			for _, e := range erst.Luecken[i].Entities {
				if e == entity {
					return &erst.Luecken[i]
				}
			}
		}
		t.Fatalf("keine Lücke für %s", entity)
		return nil
	}
	z := map[string]Zuordnung{}
	namen := map[string]string{}
	for hand, entity := range hn.Eingaenge {
		l := luecke(entity)
		q := quelleFuer[hand]
		if hn.Gedreht[hand] {
			q = "-" + q
		}
		z[l.Kennung] = Zuordnung{Wert: q}
		namen[hand] = l.Kennung
	}
	for hand, entity := range hn.Geraete {
		l := luecke(entity)
		z[l.Kennung] = Zuordnung{Wert: "heizstab-" + hand}
		namen[hand] = l.Kennung
	}
	e, err := Uebersetze(ds, z)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.NichtUebersetzt) > 0 || e.Text == "" {
		t.Fatalf("nicht übersetzbar: %+v", e.NichtUebersetzt)
	}
	for _, l := range e.Luecken {
		if l.Wert == "" || l.Fehler != "" {
			t.Fatalf("Lücke %s offen: %+v", l.Kennung, l)
		}
	}
	for hand, entity := range hn.Zustaende {
		k, ok := e.Kennungen[entity]
		if !ok {
			t.Fatalf("%s hat keine Kennung", entity)
		}
		namen[hand] = k
	}
	namen["winter"] = e.Kennungen[hn.Winter]
	namen["sonne"] = e.Kennungen["sun.sun"]
	return e, namen
}

func lies(t *testing.T, text string) (*logik.Logik, *textform.Knoten) {
	t.Helper()
	k, err := textform.Lies([]byte(text))
	if err != nil {
		t.Fatalf("Schreibform: %v\n%s", err, text)
	}
	j, err := k.JSON()
	if err != nil {
		t.Fatal(err)
	}
	L, err := logik.Lesen(j)
	if err != nil {
		t.Fatalf("Kern: %v\n%s", err, text)
	}
	return L, k
}

// normTitel vergleicht Titel ohne Umlaute (Home Assistant schreibt oft ae, oe, ue).
func normTitel(s string) string {
	return strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss", "Ä", "Ae", "Ö", "Oe", "Ü", "Ue").Replace(strings.ToLower(s))
}

var tagAnlage = map[string]logik.ProbenGeraet{
	"dle": {KwJeAusgang: f(3), Ausgaenge: 3}, "puffer2": {KwJeAusgang: f(1.5), Ausgaenge: 3}, "puffer3": {KwJeAusgang: f(1.5), Ausgaenge: 3},
}

func f(v float64) *float64 { return &v }

// vergleicheProben spielt die Proben der Hand-Übersetzung mit den Namen der Übersetzung durch:
// jede besteht genau dann, wenn sie an der Hand-Übersetzung besteht.
func vergleicheProben(t *testing.T, e *Ergebnis, namen map[string]string) {
	t.Helper()
	roh, err := os.ReadFile(handPfad)
	if err != nil {
		t.Fatal(err)
	}
	hand, err := logik.Lesen(roh)
	if err != nil {
		t.Fatal(err)
	}
	handBericht := hand.Pruefe(tagAnlage)
	handDoc, err := textform.LiesJSON(roh)
	if err != nil {
		t.Fatal(err)
	}
	var proben *textform.Knoten
	for i, k := range handDoc.Schluessel {
		if k == "tests" {
			proben = handDoc.Kinder[i]
		}
	}
	_, doc := lies(t, e.Text)
	titel := map[string]string{}
	L, _ := lies(t, e.Text)
	for _, z := range L.Lage {
		titel[normTitel(z.Titel)] = z.Titel
	}
	umbenannt := &textform.Knoten{Art: 'a'}
	for _, p := range proben.Liste {
		neu := &textform.Knoten{Art: 'o'}
		for i, k := range p.Schluessel {
			v := p.Kinder[i]
			if k == "given" || k == "expect" {
				w := &textform.Knoten{Art: 'o'}
				for j, gk := range v.Schluessel {
					gv := v.Kinder[j]
					geraet, eig, punkt := strings.Cut(gk, ".")
					switch {
					case gk == "status":
						t2, ok := titel[normTitel(gv.Text)]
						if !ok {
							t.Fatalf("Titel %q gibt es in der Übersetzung nicht", gv.Text)
						}
						gv = &textform.Knoten{Art: 's', Text: t2}
					case gk == "clock" || gk == "restart":
					case punkt:
						gk = namen[geraet] + "." + eig
					default:
						if n, ok := namen[gk]; ok {
							gk = n
						} else {
							t.Fatalf("Probe %q: %s hat keinen Namen in der Übersetzung", p.Kinder[0].Text, gk)
						}
					}
					w.Schluessel = append(w.Schluessel, gk)
					w.Kinder = append(w.Kinder, gv)
				}
				v = w
			}
			neu.Schluessel = append(neu.Schluessel, k)
			neu.Kinder = append(neu.Kinder, v)
		}
		umbenannt.Liste = append(umbenannt.Liste, neu)
	}
	doc.Schluessel = append(doc.Schluessel, "tests")
	doc.Kinder = append(doc.Kinder, umbenannt)
	j, err := doc.JSON()
	if err != nil {
		t.Fatal(err)
	}
	mit, err := logik.Lesen(j)
	if err != nil {
		t.Fatal(err)
	}
	anlage := map[string]logik.ProbenGeraet{}
	for _, g := range []string{"dle", "puffer2", "puffer3"} {
		anlage[namen[g]] = tagAnlage[g]
	}
	bericht := mit.Pruefe(anlage)
	if len(bericht.Befunde) > 0 {
		t.Fatalf("Befunde der Prüfung: %+v", bericht.Befunde)
	}
	if len(bericht.Proben) != len(handBericht.Proben) {
		t.Fatalf("%d Proben, erwartet %d", len(bericht.Proben), len(handBericht.Proben))
	}
	bestanden := 0
	for i, p := range bericht.Proben {
		h := handBericht.Proben[i]
		if p.Bestanden != h.Bestanden {
			t.Errorf("Probe %q: besteht %v, an der Hand-Übersetzung %v (%+v)", p.Name, p.Bestanden, h.Bestanden, p.Abweichungen)
		}
		if len(p.Abweichungen) != len(h.Abweichungen) {
			t.Errorf("Probe %q: %d Abweichungen, an der Hand-Übersetzung %d", p.Name, len(p.Abweichungen), len(h.Abweichungen))
		}
		if p.Bestanden {
			bestanden++
		}
	}
	t.Logf("Proben der Hand-Übersetzung mit den Namen der Übersetzung: %d von %d bestehen, wie an der Hand-Übersetzung", bestanden, len(bericht.Proben))
}

type tagSoll struct {
	Meta struct {
		Winter   bool     `json:"winter"`
		Neustart *float64 `json:"neustart"`
		Raster   float64  `json:"raster"`
	} `json:"meta"`
	Stufenwechsel []struct {
		T    float64 `json:"t"`
		Von  int     `json:"von"`
		Nach int     `json:"nach"`
	} `json:"stufenwechsel"`
	Laeufe     map[string][][2]json.RawMessage `json:"laeufe"`
	Lagesaetze []struct {
		Nr    int    `json:"nr"`
		Titel string `json:"titel"`
	} `json:"lagesaetze"`
}

func entpacke(t *testing.T, l [][2]json.RawMessage) []string {
	var out []string
	for _, p := range l {
		n, err := strconv.Atoi(string(p[1]))
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < n; i++ {
			out = append(out, string(p[0]))
		}
	}
	return out
}

func gz(t *testing.T, pfad string) *gzip.Reader {
	t.Helper()
	fh, err := os.Open(pfad)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fh.Close() })
	r, err := gzip.NewReader(fh)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// vergleicheTage spielt die drei Tage durch die Übersetzung.
func vergleicheTage(t *testing.T, e *Ergebnis, namen map[string]string) {
	t.Helper()
	L, _ := lies(t, e.Text)
	gesamt := 0
	for _, tag := range []string{"sommer", "wechselhaft", "winter"} {
		var soll tagSoll
		if err := json.NewDecoder(gz(t, tageOrdner+tag+".erwartet.json.gz")).Decode(&soll); err != nil {
			t.Fatal(err)
		}
		titelNr := map[string]string{}
		for _, l := range soll.Lagesaetze {
			titelNr[strconv.Itoa(l.Nr)] = l.Titel
		}
		laeufe := map[string][]string{}
		for k, v := range soll.Laeufe {
			laeufe[k] = entpacke(t, v)
		}
		st := L.NeuerLauf(0)
		w, err := L.LiesStellwert(namen["winter"], map[bool]string{true: "on", false: "off"}[soll.Meta.Winter])
		if err != nil {
			t.Fatal(err)
		}
		st.Stell[namen["winter"]] = w
		leser := bufio.NewScanner(gz(t, tageOrdner+tag+".eingaben.csv.gz"))
		leser.Buffer(make([]byte, 1<<20), 1<<20)
		leser.Scan()
		spalten := strings.Split(leser.Text(), ",")
		vorher := make([]*float64, len(spalten))
		abweichend := 0
		melde := func(s int, was, ist, sollW string) {
			if abweichend < 15 {
				t.Errorf("%s, Sekunde %d: %s ist %s, erwartet %s", tag, s, was, ist, sollW)
			}
			abweichend++
		}
		var wechsel []logik.Ereignis
		for s := 0; leser.Scan(); s++ {
			teile := strings.Split(leser.Text(), ",")
			werte := make([]*float64, len(spalten))
			for i, x := range teile {
				switch x {
				case "":
					werte[i] = vorher[i]
				case "x":
				default:
					v, _ := strconv.ParseFloat(x, 64)
					werte[i] = &v
				}
			}
			vorher = werte
			if soll.Meta.Neustart != nil && float64(s) == *soll.Meta.Neustart {
				L.Neustart(st, float64(s))
			}
			ein := map[string]logik.EinWert{}
			setze := func(hand string, v *float64, d logik.Groesse, teiler float64) {
				if v == nil {
					return
				}
				x := *v / teiler
				ein[namen[hand]] = logik.EinWert{Zahl: &x, D: d}
			}
			geraete := map[string]logik.GeraetStamm{}
			for i, sp := range spalten {
				switch sp {
				case "hoehe":
					setze("sonne", werte[i], logik.GroesseWinkel, 1)
				case "netzW":
					setze("netz", werte[i], logik.GroesseKW, 1000)
				case "battW":
					setze("speicher", werte[i], logik.GroesseKW, 1000)
				case "soc":
					setze("ladestand", werte[i], logik.GroesseProzent, 1)
				case "t1", "t2", "t3":
					setze(sp, werte[i], logik.GroesseTemp, 1)
				case "dle", "puffer2", "puffer3":
					a := tagAnlage[sp]
					geraete[namen[sp]] = logik.GeraetStamm{Stufe: werte[i], KwJeAusgang: a.KwJeAusgang, Ausgaenge: a.Ausgaenge}
				}
			}
			r := L.TaktMitRaster(st, &logik.Eingabe{Jetzt: float64(s), UhrMin: float64(s) / 60, Tag: 1, DT: 1, Werte: ein, Geraete: geraete}, soll.Meta.Raster)
			for _, ev := range r.Ereignisse {
				if ev.Was == "fehler" {
					t.Fatalf("%s, Sekunde %d: Fehler im Takt: %s", tag, s, ev.Text)
				}
				if ev.Was == namen["heizstufe"] {
					wechsel = append(wechsel, ev)
				}
			}
			kurz := L.ZustandKurz(st, float64(s))
			if kurz[namen["heizstufe"]] != laeufe["heizstufe"][s] {
				melde(s, "Heizstufe", kurz[namen["heizstufe"]], laeufe["heizstufe"][s])
			}
			for _, b := range []string{"netzheizen", "vorrang"} {
				ist := strconv.FormatBool(kurz[namen[b]] == "on")
				if ist != laeufe[b][s] {
					melde(s, b, ist, laeufe[b][s])
				}
			}
			if ist := strconv.FormatBool(kurz[namen["sperre"]] != "aus"); ist != laeufe["sperre"][s] {
				melde(s, "Sperre", ist, laeufe["sperre"][s])
			}
			for _, g := range []string{"dle", "puffer2", "puffer3"} {
				if ist := strconv.Itoa(r.Ausgaenge[namen[g]].Stufe); ist != laeufe[g][s] {
					melde(s, "Ausgang "+g, ist, laeufe[g][s])
				}
			}
			if ist, sollT := normTitel(r.Lage.Titel), normTitel(titelNr[laeufe["lage"][s]]); ist != sollT {
				melde(s, "Lage", r.Lage.Titel, titelNr[laeufe["lage"][s]])
			}
		}
		if abweichend > 0 {
			t.Fatalf("%s: %d abweichende Werte", tag, abweichend)
		}
		if len(wechsel) != len(soll.Stufenwechsel) {
			t.Fatalf("%s: %d Stufenwechsel, erwartet %d", tag, len(wechsel), len(soll.Stufenwechsel))
		}
		for i, w := range wechsel {
			s := soll.Stufenwechsel[i]
			if w.T != s.T || w.Von != s.Von || w.Nach != s.Nach {
				t.Errorf("%s: Stufenwechsel %d bei %v %d→%d, erwartet bei %v %d→%d", tag, i+1, w.T, w.Von, w.Nach, s.T, s.Von, s.Nach)
			}
		}
		gesamt += len(wechsel)
	}
	if !t.Failed() {
		t.Logf("drei Tage Sekunde für Sekunde wie die Hand-Übersetzung, %d Stufenwechsel zur selben Sekunde", gesamt)
	}
}

// Die Test-Anlage des Projekts: erfunden, gleich aufgebaut wie die Vorlage des Konzepts.
var solarheizung = handNamen{
	Eingaenge: map[string]string{
		"t1": "sensor.fuehler_speicher_1_oben", "t2": "sensor.messmodul_a7c3f1e09b24_temperatur_1",
		"t3": "sensor.messmodul_a7c3f1e09b24_temperatur_3", "netz": "sensor.wr_netzleistung",
		"speicher": "sensor.wr_akkuleistung", "ladestand": "sensor.wr_ladestand",
	},
	Gedreht: map[string]bool{"speicher": true},
	Geraete: map[string]string{"dle": "switch.durchlauferhitzer_l1", "puffer2": "switch.speicher_2_l1", "puffer3": "switch.speicher_3_l1"},
	Zustaende: map[string]string{"heizstufe": "input_number.heizstufe", "netzheizen": "input_boolean.netzheizung_aktiv",
		"sperre": "timer.sperre_nach_versuch", "vorrang": "binary_sensor.solarheizung_warmwasser_zuerst"},
	Winter: "input_boolean.winterbetrieb",
}

func TestTestAnlageVerhaeltSichWieDieHandUebersetzung(t *testing.T) {
	e, namen := uebersetzeZugeordnet(t, leseDateien(t, "testdata/solarheizung"), solarheizung)
	t.Run("proben", func(t *testing.T) { vergleicheProben(t, e, namen) })
	t.Run("tage", func(t *testing.T) { vergleicheTage(t, e, namen) })
}

// TestVorlageVerhaeltSichWieDieHandUebersetzung misst eine echte Anlage auf diesem Rechner
// (vertrauliches Kundenmaterial, nie im Projekt): VP_HA_VORLAGE ist ihr Ordner,
// VP_HA_VORLAGE_NAMEN eine JSON-Datei im Aufbau von handNamen.
func TestVorlageVerhaeltSichWieDieHandUebersetzung(t *testing.T) {
	ordner, namenDatei := os.Getenv("VP_HA_VORLAGE"), os.Getenv("VP_HA_VORLAGE_NAMEN")
	if ordner == "" || namenDatei == "" {
		t.Skip("VP_HA_VORLAGE und VP_HA_VORLAGE_NAMEN nicht gesetzt")
	}
	roh, err := os.ReadFile(namenDatei)
	if err != nil {
		t.Fatal(err)
	}
	var hn handNamen
	if err := json.Unmarshal(roh, &hn); err != nil {
		t.Fatal(err)
	}
	e, namen := uebersetzeZugeordnet(t, leseDateien(t, ordner), hn)
	t.Run("proben", func(t *testing.T) { vergleicheProben(t, e, namen) })
	t.Run("tage", func(t *testing.T) { vergleicheTage(t, e, namen) })
}
