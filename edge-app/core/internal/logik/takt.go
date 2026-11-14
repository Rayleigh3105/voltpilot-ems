package logik

import "math"

// Ein Takt, jede Sekunde, in dieser Reihenfolge: Werte lesen und ihr Alter prüfen;
// Zustände in der Reihenfolge des Textes fortschreiben; Ausgänge bilden; Meldungen prüfen;
// Lage bestimmen (die erste zutreffende Zeile). Der Kern schaltet nichts: Die Ausgänge
// sind nur geäußerte Wünsche; Schiedsrichter und Schutzgrenzen der Box bleiben davor.

// EinWert ist ein gelesener Wert mit Alter. Zahl und Bool nil heißt: kein Wert.
type EinWert struct {
	Zahl  *float64
	Bool  *bool
	Alter float64
	D     Groesse // leer: aus der Quelle des Eingangs abgeleitet
}

// GeraetStamm sind die Angaben der Anlage zu einem Gerät im Takt.
type GeraetStamm struct {
	Stufe           *float64    // zurückgelesener Stand: Zahl der eingeschalteten Ausgänge
	KwJeAusgang     *float64    // Leistung je Ausgang (Angabe am Gerät)
	Ausgaenge       int         // Zahl der Ausgänge; 0 heißt 3 (wie das Referenzlabor)
	SollwertBereich *[2]float64 // Bereich, auf den das Gerät einen Sollwert begrenzt
	SollwertSchritt *float64    // Schrittweite des Geräts; der Sollwert wird darauf gerundet
	Betriebsarten   []string    // die Betriebsarten, die das Gerät kennt; leer heißt: nicht bekannt
	Sollwert        *float64    // zurückgelesener Sollwert des Geräts in °C
	Betriebsart     string      // zurückgelesene Betriebsart; leer heißt: unbekannt
}

// Eingabe ist alles, was ein Takt von außen bekommt.
type Eingabe struct {
	Jetzt     float64 // Sekunden, monoton
	UhrMin    float64 // Minuten seit Mitternacht (darf Bruchteile tragen)
	Tag       int     // wechselt um Mitternacht; setzt die Tageszähler zurück
	Wochentag int     // 0 = mon … 6 = sun
	DT        float64 // Sekunden seit dem letzten Takt; 0 heißt 1
	Werte     map[string]EinWert
	Geraete   map[string]GeraetStamm
}

type zustandLauf struct {
	art     string // "boolean", "timer", "counter"
	an      bool
	wert    int
	seit    float64
	zuletzt string
	bis     *float64
}

type geraetLauf struct {
	ausgangsSekunden float64
	wunsch           float64
}

type meldungLauf struct {
	aktiv   bool
	zuletzt *float64
}

// Lauf ist der gemerkte Zustand einer laufenden Logik.
type Lauf struct {
	Stell     map[string]Wert
	Z         map[string]*zustandLauf
	G         map[string]*geraetLauf
	haelt     map[string]*float64
	M         []meldungLauf
	tag       int
	tagGilt   bool
	Gestartet float64
}

// NeuerLauf beginnt eine Logik: Stellwerte auf Vorgabe, Zustände wie nach einem Neustart.
func (L *Logik) NeuerLauf(jetzt float64) *Lauf {
	st := &Lauf{
		Stell: map[string]Wert{}, Z: map[string]*zustandLauf{}, G: map[string]*geraetLauf{},
		haelt: map[string]*float64{}, M: make([]meldungLauf, len(L.Meldungen)), Gestartet: jetzt,
	}
	for _, n := range L.StellListe {
		st.Stell[n] = L.Stellwerte[n].Vorgabe
	}
	for _, z := range L.Zustaende {
		st.Z[z.Kennung] = z.neuerLauf(jetzt, nil)
	}
	for _, g := range L.GeraetListe {
		st.G[g] = &geraetLauf{}
	}
	return st
}

// neuerLauf bildet den Zustand nach einem Neustart; alt trägt den vorigen Stand für "keep".
func (z *Zustand) neuerLauf(jetzt float64, alt *zustandLauf) *zustandLauf {
	switch z.Art {
	case "boolean":
		an := z.Neustart == neustartAn
		if z.Neustart == neustartBleibt && alt != nil {
			an = alt.an
		}
		return &zustandLauf{art: "boolean", an: an, seit: jetzt}
	case "counter":
		wert := z.NeustartWert
		if z.Neustart == neustartBleibt {
			if alt != nil {
				wert = alt.wert
			} else {
				wert = z.Von
			}
		}
		return &zustandLauf{art: "counter", wert: wert, seit: jetzt, zuletzt: "start"}
	default:
		l := &zustandLauf{art: "timer"}
		if z.Neustart == neustartBleibt && alt != nil {
			l.bis = alt.bis
		}
		return l
	}
}

// Neustart setzt die Zustände, wie "after_restart" es sagt; Stellwerte und Tageszähler bleiben.
func (L *Logik) Neustart(st *Lauf, jetzt float64) {
	for _, z := range L.Zustaende {
		st.Z[z.Kennung] = z.neuerLauf(jetzt, st.Z[z.Kennung])
	}
	st.haelt = map[string]*float64{}
	st.Gestartet = jetzt
}

// Ausgang ist der Wunsch der Logik für ein Gerät in einem Takt.
type Ausgang struct {
	HatStufe  bool
	Stufe     int
	Unbekannt bool // die Stufe war nicht berechenbar und wurde 0

	HatEin bool
	Ein    *bool // nil: kein Wunsch, es gilt der Ruhewert des Geräts

	HatSollwert bool
	Sollwert    *Wert // nil: kein Wunsch

	HatBetriebsart bool
	Betriebsart    string // leer: kein Wunsch

	HatAnteil bool
	Anteil    *float64 // nil: kein Wunsch
}

// Ereignis ist ein Wechsel, den der Verlauf festhält.
type Ereignis struct {
	T         float64
	Was       string // Kennung des Zustands, "meldung" oder "fehler"
	VonAn     bool   // Schalter
	NachAn    bool
	Von       int // Zähler
	Nach      int
	Schritt   string
	Grund     string
	Gestartet string // Zeitgeber, den ein Schritt gestartet hat

	// Meldung
	MeldungNr int
	An        []string
	Text      string
}

// Lage ist der Zustand der Logik als Titel und Satz für den Kunden.
type Lage struct {
	Nr    int
	Titel string
	Art   string
	Satz  string
}

// TaktErgebnis ist, was ein Takt äußert.
type TaktErgebnis struct {
	Ausgaenge  map[string]Ausgang
	Lage       Lage
	Ereignisse []Ereignis
}

type taktOpt struct {
	raster float64 // Zählerschritte nur, wenn jetzt ein Vielfaches ist (Vergleich mit der Vorlage)
}

// TaktMitRaster prüft Zählerschritte nur im Raster; nur für den Vergleich mit der Vorlage.
func (L *Logik) TaktMitRaster(st *Lauf, ein *Eingabe, raster float64) TaktErgebnis {
	return L.takt(st, ein, taktOpt{raster: raster})
}

// Takt wertet die Logik für einen Zeitpunkt aus.
func (L *Logik) Takt(st *Lauf, ein *Eingabe) TaktErgebnis {
	return L.takt(st, ein, taktOpt{})
}

// pruefeListe wertet eine Bedingungsliste aus: modus "alle" oder "eines".
// Rückgabe: Ergebnis (-1 unbekannt, 0 falsch, 1 wahr) und die erste wahre Bedingung.
func (L *Logik) pruefeListe(st *Lauf, ein *Eingabe, liste []Bedingung, modus string, fehlerAus *[]Ereignis, jetzt float64) (int8, *Bedingung) {
	if liste == nil {
		return 1, nil
	}
	var ersteWahr *Bedingung
	falsch, unbekannt, wahr := false, false, false
	for i := range liste {
		b := &liste[i]
		x, err := L.rechne(st, ein, b.Baum, 0)
		if err != nil {
			*fehlerAus = append(*fehlerAus, Ereignis{T: jetzt, Was: "fehler", Text: err.Error()})
			x = unbekanntW()
		}
		switch {
		case x.Art == WertUnbekannt:
			unbekannt = true
		case x.Art == WertBool && x.B:
			wahr = true
			if ersteWahr == nil {
				ersteWahr = b
			}
		case x.Art == WertBool:
			falsch = true
		default:
			*fehlerAus = append(*fehlerAus, Ereignis{T: jetzt, Was: "fehler", Text: "Hier steht kein Ja/Nein: „" + b.Baum.src + "“"})
			unbekannt = true
		}
	}
	if modus == "alle" {
		if falsch {
			return 0, ersteWahr
		}
		if unbekannt {
			return -1, ersteWahr
		}
		return 1, ersteWahr
	}
	if wahr {
		return 1, ersteWahr
	}
	if unbekannt {
		return -1, ersteWahr
	}
	return 0, ersteWahr
}

// rechneSicher wertet einen Ausdruck; ein Fehler gilt als unbekannt und wird gemeldet (Vertrag 8.10).
func (L *Logik) rechneSicher(st *Lauf, ein *Eingabe, b *baum, fehlerAus *[]Ereignis, jetzt float64) Wert {
	x, err := L.rechne(st, ein, b, 0)
	if err != nil {
		*fehlerAus = append(*fehlerAus, Ereignis{T: jetzt, Was: "fehler", Text: err.Error()})
		return unbekanntW()
	}
	return x
}

func (L *Logik) takt(st *Lauf, ein *Eingabe, opt taktOpt) TaktErgebnis {
	var ereignisse []Ereignis
	dt := ein.DT
	if dt == 0 {
		dt = 1
	}
	if !st.tagGilt || st.tag != ein.Tag {
		for _, g := range st.G {
			g.ausgangsSekunden = 0
		}
		st.tag = ein.Tag
		st.tagGilt = true
	}
	for _, g := range L.GeraetListe {
		stamm := ein.Geraete[g]
		if stamm.Stufe != nil && *stamm.Stufe != 0 {
			st.G[g].ausgangsSekunden += *stamm.Stufe * dt
		}
	}

	for _, e := range L.Zustaende {
		z := st.Z[e.Kennung]
		switch e.Art {
		case "boolean":
			aus1, ausGrund1 := L.pruefeListe(st, ein, e.Aus, "alle", &ereignisse, ein.Jetzt)
			aus2, ausGrund2 := L.pruefeListe(st, ein, e.AusEines, "eines", &ereignisse, ein.Jetzt)
			an1, _ := L.pruefeListe(st, ein, e.An, "alle", &ereignisse, ein.Jetzt)
			an2, _ := L.pruefeListe(st, ein, e.AnEines, "eines", &ereignisse, ein.Jetzt)
			hatAus := e.Aus != nil || e.AusEines != nil
			hatAn := e.An != nil || e.AnEines != nil
			aus := hatAus && (e.Aus == nil || aus1 == 1) && (e.AusEines == nil || aus2 == 1)
			an := hatAn && (e.An == nil || an1 == 1) && (e.AnEines == nil || an2 == 1)
			if z.an && aus {
				z.an = false
				z.seit = ein.Jetzt
				grund := ""
				if e.AusEines != nil && ausGrund2 != nil {
					grund = ausGrund2.Name
					if grund == "" {
						grund = ausGrund2.Baum.src
					}
				} else if ausGrund1 != nil {
					grund = ausGrund1.Name
					if grund == "" {
						grund = ausGrund1.Baum.src
					}
				}
				ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: e.Kennung, VonAn: true, NachAn: false, Grund: grund})
			} else if !z.an && an && !aus {
				z.an = true
				z.seit = ein.Jetzt
				ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: e.Kennung, VonAn: false, NachAn: true})
			}
		case "counter":
			imRaster := opt.raster == 0 || math.Mod(ein.Jetzt, opt.raster) == 0
			if !imRaster {
				continue
			}
			for _, s := range e.Schritte {
				warte := s.Fruehestens
				if s.FruehestensBaum != nil {
					fw := L.rechneSicher(st, ein, s.FruehestensBaum, &ereignisse, ein.Jetzt)
					if fw.Art != WertZahl {
						continue
					}
					warte = fw.V
				}
				if ein.Jetzt-z.seit < warte {
					continue
				}
				a, _ := L.pruefeListe(st, ein, s.Alle, "alle", &ereignisse, ein.Jetzt)
				bOk, bGrund := L.pruefeListe(st, ein, s.Eines, "eines", &ereignisse, ein.Jetzt)
				if a != 1 || (s.Eines != nil && bOk != 1) {
					continue
				}
				ziel := z.wert + s.Um
				if s.Setze != nil {
					gesetzt := L.rechneSicher(st, ein, s.Setze, &ereignisse, ein.Jetzt)
					if gesetzt.Art != WertZahl {
						continue
					}
					ziel = int(jsRound(gesetzt.V))
				}
				if ziel > e.Bis {
					ziel = e.Bis
				}
				if ziel < e.Von {
					ziel = e.Von
				}
				if ziel == z.wert {
					continue
				}
				grund := ""
				if s.Eines != nil && bGrund != nil {
					grund = bGrund.Name
					if grund == "" {
						grund = bGrund.Baum.src
					}
				}
				gestartet := ""
				if s.DannStarte != "" {
					start := true
					if s.DannWenn != nil {
						x := L.rechneSicher(st, ein, s.DannWenn, &ereignisse, ein.Jetzt)
						start = x.Art == WertBool && x.B
					}
					if start {
						zg := L.zustand[s.DannStarte]
						dauer := L.rechneSicher(st, ein, zg.Dauer, &ereignisse, ein.Jetzt)
						if dauer.Art == WertZahl && dauer.V > 0 {
							bis := ein.Jetzt + dauer.V
							st.Z[s.DannStarte].bis = &bis
						} else {
							st.Z[s.DannStarte].bis = nil
						}
						gestartet = s.DannStarte
					}
				}
				ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: e.Kennung, Von: z.wert, Nach: ziel, Schritt: s.Name, Grund: grund, Gestartet: gestartet})
				z.wert = ziel
				z.seit = ein.Jetzt
				z.zuletzt = s.Name
				break
			}
		}
	}

	// Ausgänge: je Gerät, was gelten soll. Unbekannt heißt bei Stufen 0, sonst kein Wunsch.
	ausgaenge := map[string]Ausgang{}
	for _, g := range L.AusgangListe {
		arten := L.Ausgaenge[g]
		stamm := ein.Geraete[g]
		var o Ausgang
		if b, ok := arten["level"]; ok {
			o.HatStufe = true
			x := L.rechneSicher(st, ein, b, &ereignisse, ein.Jetzt)
			max := stamm.Ausgaenge
			if max == 0 {
				max = 3
			}
			if x.Art != WertZahl {
				o.Stufe = 0
				o.Unbekannt = true
			} else {
				s := int(jsRound(x.V))
				if s < 0 {
					s = 0
				}
				if s > max {
					s = max
				}
				o.Stufe = s
			}
		}
		if b, ok := arten["on_off"]; ok {
			o.HatEin = true
			x := L.rechneSicher(st, ein, b, &ereignisse, ein.Jetzt)
			if x.Art == WertBool {
				v := x.B
				o.Ein = &v
			} else if x.Art != WertUnbekannt {
				ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: "fehler", Text: "Hier steht kein Ja/Nein: „" + b.src + "“"})
			}
		}
		if b, ok := arten["setpoint"]; ok {
			o.HatSollwert = true
			x := L.rechneSicher(st, ein, b, &ereignisse, ein.Jetzt)
			if x.Art == WertZahl {
				x.V = aufGeraet(x.V, stamm)
				o.Sollwert = &x
			}
		}
		if b, ok := arten["mode"]; ok {
			o.HatBetriebsart = true
			x := L.rechneSicher(st, ein, b, &ereignisse, ein.Jetzt)
			if x.Art == WertWort {
				if kenntBetriebsart(stamm, x.W) {
					o.Betriebsart = x.W
				} else {
					// Ein Wort, das das Gerät nicht kennt, ist kein Wunsch: es gilt sein Ruhewert.
					ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: "fehler", Text: "Das Gerät kennt die Betriebsart „" + x.W + "“ nicht"})
				}
			} else if x.Art != WertUnbekannt {
				ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: "fehler", Text: "Die Betriebsart ist ein Wort: „" + b.src + "“"})
			}
		}
		if b, ok := arten["percent"]; ok {
			o.HatAnteil = true
			x := L.rechneSicher(st, ein, b, &ereignisse, ein.Jetzt)
			if x.Art == WertZahl {
				v := x.V
				if v < 0 {
					v = 0
				}
				if v > 100 {
					v = 100
				}
				o.Anteil = &v
			}
		}
		ausgaenge[g] = o
	}
	for g, o := range ausgaenge {
		if o.HatStufe {
			if lauf := st.G[g]; lauf != nil {
				lauf.wunsch = float64(o.Stufe) // was die Logik in diesem Takt will
			}
		}
	}

	// Meldungen: einmal, wenn die Bedingung eintritt; frühestens nach "wieder" erneut.
	for i, m := range L.Meldungen {
		x := L.rechneSicher(st, ein, m.Wenn, &ereignisse, ein.Jetzt)
		trifft := x.Art == WertBool && x.B
		z := &st.M[i]
		if trifft && !z.aktiv && (z.zuletzt == nil || ein.Jetzt-*z.zuletzt >= m.Wieder) {
			t := ein.Jetzt
			z.zuletzt = &t
			ereignisse = append(ereignisse, Ereignis{T: ein.Jetzt, Was: "meldung", MeldungNr: i, An: m.An, Text: L.satzSicher(st, ein, m.Satz, &ereignisse)})
		}
		z.aktiv = trifft
	}

	return TaktErgebnis{Ausgaenge: ausgaenge, Lage: L.lageJetzt(st, ein, &ereignisse), Ereignisse: ereignisse}
}

func (L *Logik) lageJetzt(st *Lauf, ein *Eingabe, fehlerAus *[]Ereignis) Lage {
	for i, z := range L.Lage {
		trifft := z.Sonst
		if !trifft {
			x := L.rechneSicher(st, ein, z.Wenn, fehlerAus, ein.Jetzt)
			trifft = x.Art == WertBool && x.B
		}
		if trifft {
			return Lage{Nr: i, Titel: z.Titel, Art: z.Art, Satz: L.satzSicher(st, ein, z.Satz, fehlerAus)}
		}
	}
	return Lage{Nr: -1, Titel: "Unbekannt", Art: "waiting"}
}

// jsRound rundet wie JavaScript Math.round: halbe Werte zur nächsthöheren Zahl.
func jsRound(x float64) float64 {
	return math.Floor(x + 0.5)
}

// aufGeraet rundet einen Sollwert auf die Schrittweite des Geräts (gezählt ab dem unteren
// Ende seines Bereichs, sonst ab 0) und begrenzt ihn auf den Bereich. Halbe Schritte runden
// zum nächsthöheren Wert, wie jsRound.
func aufGeraet(v float64, stamm GeraetStamm) float64 {
	if s := stamm.SollwertSchritt; s != nil && *s > 0 {
		basis := 0.0
		if br := stamm.SollwertBereich; br != nil {
			basis = br[0]
		}
		v = basis + jsRound((v-basis)/ *s)**s
		v = math.Round(v*1e9) / 1e9 // Rundungsrest der Gleitkommazahl
	}
	if br := stamm.SollwertBereich; br != nil {
		if v < br[0] {
			v = br[0]
		}
		if v > br[1] {
			v = br[1]
		}
	}
	return v
}

// kenntBetriebsart sagt, ob das Gerät die Betriebsart kennt; ohne Liste gilt jedes Wort.
func kenntBetriebsart(stamm GeraetStamm, w string) bool {
	if len(stamm.Betriebsarten) == 0 {
		return true
	}
	for _, b := range stamm.Betriebsarten {
		if b == w {
			return true
		}
	}
	return false
}
