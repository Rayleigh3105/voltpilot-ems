package wagobild

import (
	"regexp"
	"time"
)

// Device events and value quality from a judged reading (wago-ereignisse.js
// on device-events.js): device_restart when the heartbeat runs backwards,
// frozen_source once when it has stood for three readings, range_limit once
// per card group when a value reads the type's "invalid" value. Each event is
// sent once per change of state. The bit of the range limit in the status
// words is not established (§9), so no status bit is interpreted: the raw
// status word only rides along.

// EreignisTopic is the local bus branch of device events.
const EreignisTopic = "edge/events"

// Ereignis is one device event (edge/events).
type Ereignis struct {
	Art               string `json:"art"`
	Zeitpunkt         string `json:"zeitpunkt"`
	Datenquelle       string `json:"datenquelle"`
	Komponente        string `json:"komponente,omitempty"`
	HerzschlagVorher  *int   `json:"herzschlag_vorher,omitempty"`
	HerzschlagNachher *int   `json:"herzschlag_nachher,omitempty"`
	Lesungen          *int   `json:"lesungen,omitempty"`
	Herzschlag        *int   `json:"herzschlag,omitempty"`
	Statuswort        *int   `json:"statuswort,omitempty"`
}

var kennungRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func kennungOK(s string) bool { return len(s) >= 1 && len(s) <= 128 && kennungRe.MatchString(s) }

// gueltig is device-events.js ereignis(): an event with a missing mandatory
// field or a malformed one is not sent at all.
func (e Ereignis) gueltig() bool {
	if !kennungOK(e.Datenquelle) || (e.Komponente != "" && !kennungOK(e.Komponente)) {
		return false
	}
	for _, v := range []*int{e.HerzschlagVorher, e.HerzschlagNachher, e.Herzschlag} {
		if v != nil && *v < 0 {
			return false
		}
	}
	if e.Lesungen != nil && *e.Lesungen < 1 {
		return false
	}
	return e.Statuswort == nil || (*e.Statuswort >= 0 && *e.Statuswort <= 65535)
}

// Zeit is the contract's spelling of a point in time: UTC, to the second.
func Zeit(t time.Time) string { return t.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z") }

// Qualitaet is the quality of one card value.
type Qualitaet struct {
	Steckplatz int     `json:"steckplatz"`
	Nr         int     `json:"nr"`
	Messkanal  string  `json:"messkanal"`
	Qualitaet  *string `json:"qualitaet"`
}

// Ereignisse keeps what was already reported per controller and card.
type Ereignisse struct {
	eingefroren map[string]bool
	begrenzt    map[string]map[int]bool
}

func gruppeVon(nr int) int { return (nr-1)/4 + 1 }

func statuswort1(k Karte, gruppe int) *int {
	if k.Statuswoerter == nil {
		return nil
	}
	return zahl(k.Statuswoerter[(gruppe-1)*Statuswoerter/3])
}

func liestUngueltig(k Karte, i int) bool {
	inv, ok := ungueltig[Messwerte[i].Datentyp]
	if !ok || k.MesswerteRoh == nil || k.MesswerteRoh[i] == nil {
		return false
	}
	return *k.MesswerteRoh[i] == float64(inv)
}

// Lesung is lesung(): the events of one judged reading and the quality of
// each card value. komponente names a card's component (may return "").
func (e *Ereignisse) Lesung(g Gepruefte, datenquelle, steuerung string, komponente func(Karte, int) string,
	zeitpunkt time.Time) ([]Ereignis, []Qualitaet) {
	if e.eingefroren == nil {
		e.eingefroren, e.begrenzt = map[string]bool{}, map[string]map[int]bool{}
	}
	var raus []Ereignis
	melde := func(ev Ereignis) {
		ev.Datenquelle, ev.Zeitpunkt = datenquelle, Zeit(zeitpunkt)
		if ev.gueltig() {
			raus = append(raus, ev)
		}
	}
	if g.HerzschlagUrteil != nil && *g.HerzschlagUrteil == "rueckwaerts" {
		melde(Ereignis{Art: "device_restart", HerzschlagVorher: g.HerzschlagVorher, HerzschlagNachher: g.HerzschlagNachher})
	}
	steht := g.Qualitaet != nil && *g.Qualitaet == QualitaetAlt
	if steht && !e.eingefroren[steuerung] {
		melde(Ereignis{Art: "frozen_source", Lesungen: zahl(g.Steht), Herzschlag: g.HerzschlagNachher})
	}
	if g.Steht == 0 {
		delete(e.eingefroren, steuerung)
	} else if steht {
		e.eingefroren[steuerung] = true
	}
	if g.Ergebnis != "erkannt" {
		e.vergissKarten(steuerung)
		return raus, []Qualitaet{}
	}
	qualitaet := []Qualitaet{}
	for index, k := range g.Karten {
		schluessel := steuerung + "#" + itoa(k.Steckplatz)
		if k.Ergebnis != "gelesen" {
			delete(e.begrenzt, schluessel)
			continue
		}
		kennung := ""
		if komponente != nil {
			kennung = komponente(k, index)
		}
		stand := e.begrenzt[schluessel]
		if stand == nil {
			stand = map[int]bool{}
		}
		for gruppe := 1; gruppe <= 3; gruppe++ {
			treffer := false
			for i, m := range Messwerte {
				if gruppeVon(m.Nr) == gruppe && liestUngueltig(k, i) {
					treffer = true
				}
			}
			if treffer && !stand[gruppe] {
				melde(Ereignis{Art: "range_limit", Komponente: kennung, Statuswort: statuswort1(k, gruppe)})
			}
			stand[gruppe] = treffer
		}
		e.begrenzt[schluessel] = stand
		for i, m := range Messwerte {
			var q *string
			switch {
			case liestUngueltig(k, i):
				s := "invalid"
				q = &s
			case k.Messwerte[i] == nil:
			default:
				q = g.Qualitaet
			}
			qualitaet = append(qualitaet, Qualitaet{Steckplatz: k.Steckplatz, Nr: m.Nr, Messkanal: m.Schluessel, Qualitaet: q})
		}
	}
	return raus, qualitaet
}

func (e *Ereignisse) vergissKarten(steuerung string) {
	for k := range e.begrenzt {
		if len(k) > len(steuerung) && k[:len(steuerung)+1] == steuerung+"#" {
			delete(e.begrenzt, k)
		}
	}
}

// Vergiss drops a controller.
func (e *Ereignisse) Vergiss(steuerung string) {
	delete(e.eingefroren, steuerung)
	e.vergissKarten(steuerung)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}
