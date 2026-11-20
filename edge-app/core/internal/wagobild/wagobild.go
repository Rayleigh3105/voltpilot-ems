// Package wagobild is the Go twin of the reader of the "VoltPilot-Registerbild
// WAGO v1" (docs/contracts/v2/wago-registerbild.md): the energy cards
// 750-494/-495 of a WAGO controller, copied by the plant program into one
// register range the box reads over Modbus TCP. Source of truth are the
// palette modules edge-app/nodered/measurements/wago-registerbild.js (reading,
// request plan), wago-kopf.js (head check, heartbeat watch, nameplate, the
// probe's head report) and wago-ereignisse.js (device events, value quality).
//
// Pure: no socket, no bus. Held to docs/contracts/v2/wago-registerbild-
// vectors.json (V1-V13) and edge-app/nodered/measurements/wago-vectors.json.
package wagobild

import (
	"errors"
	"strings"
)

// Contract constants (§3, §4, §7).
const (
	Signatur1            = 0x5650
	Signatur2            = 0x5242
	Hauptversion         = 1
	KopflaengeMin        = 12
	KartenblocklaengeMin = 42
	WortfolgePruefwert   = 0x01020304
	MaxWoerterJeAnfrage  = 120
	Statuswoerter        = 12
	// Typenschild is the controller's nameplate (0xFA10, 8 words) - shown,
	// never used for identity.
	TypenschildAdresse = 0xfa10
	TypenschildWoerter = 8
)

// Head offsets.
const (
	kopfSignatur1    = 0
	kopfSignatur2    = 1
	kopfHauptversion = 2
	kopfNebenversion = 3
	kopfKopflaenge   = 4
	kopfBlocklaenge  = 5
	kopfKartenzahl   = 6
	kopfHerzschlag   = 7
	kopfPruefwert    = 8
	kopfKennung      = 10
)

// Card offsets and validity bits.
const (
	karteSteckplatz    = 0
	karteKartentyp     = 1
	karteVariante      = 2
	karteGueltigkeit   = 3
	karteRegister32    = 4
	karteRegister35    = 5
	karteStatuswoerter = 6

	bitKarteGelesen  = 0
	bitRegister32    = 1
	bitRegister35    = 2
	bitStatuswoerter = 3
)

// Messwert is one of the twelve standard values of a card block.
type Messwert struct {
	Nr         int
	Schluessel string
	Offset     int
	Datentyp   string // "" = data type not established: never a value
}

// Messwerte is the standard set E9 (§4.3).
var Messwerte = []Messwert{
	{1, "energy_import_total", 18, "UInt32"},
	{2, "energy_export_total", 20, ""},
	{3, "power_l1", 22, "Int32"},
	{4, "power_l2", 24, "Int32"},
	{5, "power_l3", 26, "Int32"},
	{6, "voltage_l1", 28, "UInt32"},
	{7, "voltage_l2", 30, "UInt32"},
	{8, "voltage_l3", 32, "UInt32"},
	{9, "current_l1", 34, "UInt32"},
	{10, "current_l2", 36, "UInt32"},
	{11, "current_l3", 38, "UInt32"},
	{12, "frequency", 40, "UInt32"},
}

// ungueltig is the one value of a data type that means "no value".
var ungueltig = map[string]uint32{"UInt32": 4294967295, "Int32": 2147483647}

// Wert32 is a 32-bit value from two words in the plant's word order.
func Wert32(w []uint16, i int, wortfolge string) uint32 {
	a, b := uint32(w[i]), uint32(w[i+1])
	if wortfolge == "little" {
		a, b = b, a
	}
	return a<<16 | b
}

// Deute32 is the value of a raw word pair by data type; ok=false for the
// "invalid" value of the type or a data type that is not established.
func Deute32(roh uint32, datentyp string) (float64, bool) {
	inv, ok := ungueltig[datentyp]
	if !ok || roh == inv {
		return 0, false
	}
	if datentyp == "Int32" {
		return float64(int32(roh)), true
	}
	return float64(roh), true
}

// Parameter are the per-plant parameters of an image (§2).
type Parameter struct {
	Basisadresse      int
	Funktionscode     int
	Wortfolge         string
	Kartenzahl        int
	Kopflaenge        int // 0 = 12
	Kartenblocklaenge int // 0 = 42
	MaxWoerter        int // 0 = 120
}

// Anfrage is one request of a reading.
type Anfrage struct {
	Start    int  `json:"start"`
	Count    int  `json:"count"`
	Kopf     bool `json:"kopf"`
	KarteVon int  `json:"karte_von"`
	Karten   int  `json:"karten"`
}

// PlaneAnfragen is planeAnfragen(): at most 120 words per request, a card
// block never split across two requests (§7).
func PlaneAnfragen(p Parameter) ([]Anfrage, error) {
	kopf, block, maxW := p.Kopflaenge, p.Kartenblocklaenge, p.MaxWoerter
	if kopf == 0 {
		kopf = KopflaengeMin
	}
	if block == 0 {
		block = KartenblocklaengeMin
	}
	if maxW == 0 {
		maxW = MaxWoerterJeAnfrage
	}
	switch {
	case p.Basisadresse < 0 || p.Basisadresse > 65535:
		return nil, errors.New("Basisadresse ausserhalb 0 … 65 535")
	case p.Kartenzahl < 0:
		return nil, errors.New("Kartenzahl fehlt")
	case kopf < KopflaengeMin || block < KartenblocklaengeMin:
		return nil, errors.New("Kopf- oder Kartenblocklaenge unter dem Vertrag")
	case p.Basisadresse+kopf+p.Kartenzahl*block > 65536:
		return nil, errors.New("Registerbild reicht ueber den Adressraum hinaus")
	case block > maxW:
		return nil, errors.New("Ein Karten-Block passt in keine Anfrage")
	}
	var out []Anfrage
	adresse, vorlauf, naechste := p.Basisadresse, kopf, 0
	for naechste < p.Kartenzahl || vorlauf > 0 {
		karten := min(p.Kartenzahl-naechste, (maxW-vorlauf)/block)
		out = append(out, Anfrage{Start: adresse, Count: vorlauf + karten*block, Kopf: vorlauf > 0,
			KarteVon: naechste, Karten: karten})
		adresse += vorlauf + karten*block
		naechste += karten
		vorlauf = 0
	}
	return out, nil
}

// Kopf is a readable head.
type Kopf struct {
	Hauptversion      int    `json:"hauptversion"`
	Nebenversion      int    `json:"nebenversion"`
	Kopflaenge        int    `json:"kopflaenge"`
	Kartenblocklaenge int    `json:"kartenblocklaenge"`
	Kartenzahl        int    `json:"kartenzahl"`
	Herzschlag        int    `json:"herzschlag"`
	ControllerKennung uint32 `json:"controller_kennung"`
}

// Karte is one card block as read.
type Karte struct {
	Steckplatz       int        `json:"steckplatz"`
	Kartentyp        int        `json:"kartentyp"`
	Variante         int        `json:"variante"`
	Gueltigkeit      int        `json:"gueltigkeit"`
	Ergebnis         string     `json:"ergebnis"`
	Kartenregister32 *int       `json:"kartenregister_32"`
	Kartenregister35 *int       `json:"kartenregister_35"`
	Statuswoerter    []int      `json:"statuswoerter"`
	MesswerteRoh     []*float64 `json:"messwerte_roh"`
	Messwerte        []*float64 `json:"messwerte"`
}

// Lesung is one reading of an image.
type Lesung struct {
	Ergebnis string  `json:"ergebnis"` // erkannt | nicht_lesbar
	Grund    *string `json:"grund"`
	Kopf     *Kopf   `json:"kopf"`
	Karten   []Karte `json:"karten"`
}

// SollKarte is the expected card on a slot.
type SollKarte struct {
	Steckplatz int  `json:"steckplatz"`
	Kartentyp  int  `json:"kartentyp"`
	Variante   *int `json:"variante,omitempty"`
}

// Soll is the plant's expected layout (Hardwareblatt); a nil field is not
// checked - never a 0.
type Soll struct {
	Kartenzahl        *int        `json:"kartenzahl,omitempty"`
	ControllerKennung *int64      `json:"controller_kennung,omitempty"`
	Karten            []SollKarte `json:"karten"`
}

func nichtLesbar(grund string, k *Kopf) Lesung {
	return Lesung{Ergebnis: "nicht_lesbar", Grund: &grund, Kopf: k, Karten: []Karte{}}
}

func zahl(v int) *int { return &v }

func liesKarte(w []uint16, start, block int, wortfolge string, soll *SollKarte) Karte {
	b := func(off int) int { return int(w[start+off]) }
	k := Karte{Steckplatz: b(karteSteckplatz), Kartentyp: b(karteKartentyp), Variante: b(karteVariante),
		Gueltigkeit: b(karteGueltigkeit)}
	ohne := func(ergebnis string) Karte {
		k.Ergebnis = ergebnis
		return k
	}
	if k.Kartentyp != 494 && k.Kartentyp != 495 {
		return ohne("kartentyp_fremd")
	}
	if soll != nil && (k.Steckplatz != soll.Steckplatz || k.Kartentyp != soll.Kartentyp ||
		(soll.Variante != nil && k.Variante != *soll.Variante)) {
		return ohne("aufbau_abweichend")
	}
	gesetzt := func(bit int) bool { return k.Gueltigkeit&(1<<bit) != 0 }
	if !gesetzt(bitKarteGelesen) {
		return ohne("nicht_gelesen")
	}
	k.Ergebnis = "gelesen"
	if gesetzt(bitRegister32) {
		k.Kartenregister32 = zahl(b(karteRegister32))
	}
	if gesetzt(bitRegister35) {
		k.Kartenregister35 = zahl(b(karteRegister35))
	}
	if gesetzt(bitStatuswoerter) {
		k.Statuswoerter = make([]int, Statuswoerter)
		for i := range k.Statuswoerter {
			k.Statuswoerter[i] = b(karteStatuswoerter + i)
		}
	}
	k.MesswerteRoh = make([]*float64, len(Messwerte))
	k.Messwerte = make([]*float64, len(Messwerte))
	for i, m := range Messwerte {
		if m.Offset+2 > block {
			continue // a field the (older) block does not carry is unknown, not 0
		}
		roh := Wert32(w, start+m.Offset, wortfolge)
		r := float64(roh)
		k.MesswerteRoh[i] = &r
		if v, ok := Deute32(roh, m.Datentyp); ok {
			k.Messwerte[i] = &v
		}
	}
	return k
}

// LiesRegisterbild is liesRegisterbild(): the reasons of §5 in this order,
// each of them "not readable: not one card value".
func LiesRegisterbild(w []uint16, p Parameter, soll *Soll) Lesung {
	wortfolge := p.Wortfolge
	if wortfolge == "" {
		wortfolge = "big"
	}
	if len(w) <= kopfSignatur2 {
		return nichtLesbar("laenge_ungueltig", nil)
	}
	if w[kopfSignatur1] != Signatur1 || w[kopfSignatur2] != Signatur2 {
		return nichtLesbar("signatur_fremd", nil)
	}
	if len(w) <= kopfHauptversion {
		return nichtLesbar("laenge_ungueltig", nil)
	}
	if w[kopfHauptversion] != Hauptversion {
		return nichtLesbar("hauptversion_fremd", nil)
	}
	if len(w) < KopflaengeMin {
		return nichtLesbar("laenge_ungueltig", nil)
	}
	kopf, block := int(w[kopfKopflaenge]), int(w[kopfBlocklaenge])
	if kopf < KopflaengeMin || block < KartenblocklaengeMin {
		return nichtLesbar("laenge_ungueltig", nil)
	}
	kartenzahl := int(w[kopfKartenzahl])
	if len(w) < kopf+kartenzahl*block || p.Basisadresse+kopf+kartenzahl*block > 65536 {
		return nichtLesbar("laenge_ungueltig", nil)
	}
	if Wert32(w, kopfPruefwert, wortfolge) != WortfolgePruefwert {
		return nichtLesbar("wortfolge_abweichend", nil)
	}
	k := &Kopf{Hauptversion: int(w[kopfHauptversion]), Nebenversion: int(w[kopfNebenversion]),
		Kopflaenge: kopf, Kartenblocklaenge: block, Kartenzahl: kartenzahl, Herzschlag: int(w[kopfHerzschlag]),
		ControllerKennung: Wert32(w, kopfKennung, wortfolge)}
	if soll != nil && soll.Kartenzahl != nil && kartenzahl != *soll.Kartenzahl {
		return nichtLesbar("kartenzahl_abweichend", k)
	}
	if soll != nil && soll.ControllerKennung != nil && int64(k.ControllerKennung) != *soll.ControllerKennung {
		return nichtLesbar("controller_kennung_abweichend", k)
	}
	karten := make([]Karte, 0, kartenzahl)
	for n := 0; n < kartenzahl; n++ {
		var s *SollKarte
		if soll != nil && n < len(soll.Karten) {
			s = &soll.Karten[n]
		}
		karten = append(karten, liesKarte(w, kopf+n*block, block, wortfolge, s))
	}
	return Lesung{Ergebnis: "erkannt", Kopf: k, Karten: karten}
}

// HerzschlagUrteil is herzschlagUrteil(): how a heartbeat relates to the
// previous reading - nothing more.
func HerzschlagUrteil(vorher *int, jetzt, schrittgrenze int) string {
	switch {
	case vorher == nil:
		return "erste_lesung"
	case jetzt == *vorher:
		return "steht"
	case jetzt > *vorher:
		return "laeuft"
	case jetzt+0x10000-*vorher <= schrittgrenze:
		return "ueberlauf"
	}
	return "rueckwaerts"
}

// liesTypenschild is liesTypenschild(): the nameplate's bytes as Latin-1
// characters, control characters blanked, trimmed; nil when nothing is left.
func liesTypenschild(w []uint16) *string {
	if len(w) == 0 {
		return nil
	}
	var b strings.Builder
	for _, x := range w {
		for _, c := range []byte{byte(x >> 8), byte(x)} {
			if c < 0x20 || c == 0x7f {
				b.WriteRune(' ')
			} else {
				b.WriteRune(rune(c))
			}
		}
	}
	s := strings.Trim(b.String(), " \t\n\v\f\r ")
	if s == "" {
		return nil
	}
	return &s
}
