// Package erzeugerbild is the Go twin of the Node-RED reader of the
// "VoltPilot-Registerbild Erzeuger v1" (contract
// docs/contracts/v2/erzeuger-registerbild.md, EZ-1; JS
// edge-app/nodered/measurements/erzeuger-registerbild.js, EZ-5).
//
// The controller of a generating plant (a WAGO PFC200 or any other Modbus TCP
// server) lays out the plant in fixed input registers from address 0: head,
// plant and grid point, grid operator, direct marketer, effect, and one block
// of ten words per unit. This package says, word by word, whether a field is a
// value - nothing else. What follows from a reading (quality, events, which
// value is sent when, the site sample) lives next to it in stufe.go,
// meldung.go and quelle.go; the bus and the socket live in internal/layer1.
//
// ⚠ Read only. The values never steer anything; the cloud plans, the core
// guards, the SPS decides (concept vp-pfc200-edge-konzept §4.1).
//
// Twin rule: the contract vectors (erzeuger-registerbild-vectors.json) and the
// runtime vectors generated from the JS modules
// (edge-app/nodered/measurements/erzeuger-laufzeit-vectors.json) are the
// specification. Whoever changes the JS reader regenerates the runtime vectors;
// the Go tests then show whether this twin has to follow.
package erzeugerbild

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The fixed facts of the image (contract §2, §3). They say nothing about
// hardware, only how controller and box understand each other.
const (
	Signatur1          = 0x5650 // "VP"
	Signatur2          = 0x455A // "EZ"
	Hauptversion       = 1
	WortfolgePruefwert = 0x01020304
	Kopflaenge         = 12
	// FesterTeil is head + plant + grid operator + direct marketer + effect.
	FesterTeil    = 38
	EinheitLaenge = 10
	MaxEinheiten  = 10
	// NameWoerter is one name: 16 words = 32 characters.
	NameWoerter = 16
	// MaxWoerterJeAnfrage is the box's bound per request
	// (docs/contracts/v2/measurement-budget-vectors.json).
	MaxWoerterJeAnfrage = 120
	// LesetaktS is the family's read cadence (EW-5 A): every 5 s.
	LesetaktS = 5
	// Familie and Quellenart name the catalog family and its source kind.
	Familie    = "voltpilot.erzeuger_registerbild_v1"
	Quellenart = "erzeuger_registerbild"
)

// Offsets in the head, from the base address.
const (
	kopfSignatur1     = 0
	kopfSignatur2     = 1
	kopfWortfolge     = 2
	kopfVersion       = 4
	kopfTeAnzahl      = 5
	kopfHerzschlag    = 6
	kopfProgrammstand = 7
	kopfSteuerungID   = 8
	kopfAnlagenart    = 10
	kopfBeschreibung  = 11
)

// Reasons an image is not readable, in the order they are checked (contract
// §7), then the three Soll reasons of the box.
const (
	GrundZuWenigWoerter        = "zu_wenig_woerter"
	GrundSignaturFremd         = "signatur_fremd"
	GrundVersionFremd          = "version_fremd"
	GrundWortfolgeFalsch       = "wortfolge_falsch"
	GrundTeAnzahlUngueltig     = "te_anzahl_ungueltig"
	GrundTeAnzahlAbweichend    = "te_anzahl_abweichend"
	GrundSteuerungIDAbweichend = "steuerung_id_abweichend"
	GrundAnlagenartAbweichend  = "anlagenart_abweichend"
)

// Reasons a single field carries no value (contract §7).
const (
	LeerGueltigkeit = "gueltigkeit"
	LeerUngueltig   = "ungueltig"
	LeerFremd       = "fremd"
)

// Results of a reading.
const (
	ErgebnisErkannt     = "erkannt"
	ErgebnisNichtLesbar = "nicht_lesbar"
)

// istSollGrund: the image itself is readable - its heartbeat is an observation -
// it just does not match the installed plant.
func istSollGrund(grund string) bool {
	return grund == GrundTeAnzahlAbweichend || grund == GrundSteuerungIDAbweichend ||
		grund == GrundAnlagenartAbweichend
}

// Typ is a register type of the image.
type Typ string

// The four types of the image (contract §1): no floats, no coils.
const (
	U16 Typ = "U16"
	S16 Typ = "S16"
	U32 Typ = "U32"
	S32 Typ = "S32"
)

// ungueltig is the type maximum: "invalid is never 0".
func (t Typ) ungueltig() uint32 {
	switch t {
	case U16:
		return 0xFFFF
	case S16:
		return 0x7FFF
	case U32:
		return 0xFFFFFFFF
	}
	return 0x7FFFFFFF
}

func (t Typ) breit() bool { return t == U32 || t == S32 }

// The vocabularies of the image (contract §5). A value outside is no value.
var aufzaehlungen = map[string][]int64{
	"anlagenart": {1, 2, 3},
	"zustand":    {0, 1, 2, 3, 4, 5, 6},
	"n_kanal":    {0, 1, 2, 3},
	"d_kanal":    {0, 1, 2},
	"quelle_p":   {0, 1, 2, 3, 4, 5, 6},
	"t_art":      {1, 2},
}

func imVokabular(name string, v int64) bool {
	for _, c := range aufzaehlungen[name] {
		if c == v {
			return true
		}
	}
	return false
}

// Deckung names the bit of which bit field covers a value (contract §4).
type Deckung struct {
	Feld string
	Bit  uint
}

// Feld is one field of the running image behind the head - the twin of FELDER.
type Feld struct {
	Abschnitt   string // kopf, a, nb, dv, wirkung ("" for a unit field)
	Name        string
	Offset      int // from the base address, or from the start of the unit block
	Typ         Typ
	Art         string // zahl, zustand, bitfeld
	Aufzaehlung string
	Masseinheit string
	Faktor      float64 // 0 = none
	// Klasse says when the value is sent (meldung.go): schnell (with Totband),
	// zustand (every change), zaehler (at the selection's cadence).
	Klasse  string
	Totband *float64
	Gueltig *Deckung
	// Ueberlauf: the counter runs from 65535 to 0, 0xFFFF is a value (EZ-1 A2).
	Ueberlauf bool
	Einheit   bool
}

func totband(v float64) *float64 { return &v }

// Felder is the field table in the order of the JS reader (FELDER).
var Felder = []Feld{
	{Abschnitt: "kopf", Name: "te_anzahl", Offset: 5, Typ: U16, Art: "zahl", Klasse: "zustand"},
	{Abschnitt: "kopf", Name: "programmstand", Offset: 7, Typ: U16, Art: "zahl", Klasse: "zustand"},
	{Abschnitt: "kopf", Name: "steuerung_id", Offset: 8, Typ: U32, Art: "zahl", Klasse: "zustand"},
	{Abschnitt: "kopf", Name: "anlagenart", Offset: 10, Typ: U16, Art: "zustand", Aufzaehlung: "anlagenart", Klasse: "zustand"},
	{Abschnitt: "a", Name: "a_gueltig", Offset: 12, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Abschnitt: "a", Name: "a_alter_s", Offset: 13, Typ: U16, Art: "zahl", Masseinheit: "s", Klasse: "schnell", Totband: totband(5)},
	{Abschnitt: "a", Name: "p_nvp_w", Offset: 14, Typ: S32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"a_gueltig", 0}},
	{Abschnitt: "a", Name: "p_erzeugung_w", Offset: 16, Typ: S32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"a_gueltig", 3}},
	{Abschnitt: "a", Name: "anlage_zustand", Offset: 18, Typ: U16, Art: "zustand", Aufzaehlung: "zustand", Klasse: "zustand"},
	{Abschnitt: "a", Name: "a_bits", Offset: 19, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Abschnitt: "a", Name: "speicher_fuellstand", Offset: 20, Typ: U16, Art: "zahl", Masseinheit: "%", Faktor: 0.1, Klasse: "schnell", Totband: totband(0.5), Gueltig: &Deckung{"a_gueltig", 4}},
	{Abschnitt: "a", Name: "p_installiert_kw", Offset: 21, Typ: U16, Art: "zahl", Masseinheit: "kW", Klasse: "zustand"},
	{Abschnitt: "nb", Name: "n_kanal", Offset: 22, Typ: U16, Art: "zustand", Aufzaehlung: "n_kanal", Klasse: "zustand"},
	{Abschnitt: "nb", Name: "n_bits", Offset: 23, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Abschnitt: "nb", Name: "n_p_prozent", Offset: 24, Typ: U16, Art: "zahl", Masseinheit: "%", Faktor: 0.1, Klasse: "schnell", Totband: totband(0), Gueltig: &Deckung{"n_bits", 0}},
	{Abschnitt: "nb", Name: "n_cosphi", Offset: 25, Typ: S16, Art: "zahl", Faktor: 0.001, Klasse: "schnell", Totband: totband(0), Gueltig: &Deckung{"n_bits", 0}},
	{Abschnitt: "nb", Name: "n_seit_s", Offset: 26, Typ: U16, Art: "zahl", Masseinheit: "s", Klasse: "zaehler"},
	{Abschnitt: "nb", Name: "n_zaehler", Offset: 27, Typ: U16, Art: "zahl", Klasse: "zaehler", Ueberlauf: true},
	{Abschnitt: "dv", Name: "d_kanal", Offset: 28, Typ: U16, Art: "zustand", Aufzaehlung: "d_kanal", Klasse: "zustand"},
	{Abschnitt: "dv", Name: "d_bits", Offset: 29, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Abschnitt: "dv", Name: "d_soll_w", Offset: 30, Typ: U32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"d_bits", 0}},
	{Abschnitt: "dv", Name: "d_seit_s", Offset: 32, Typ: U16, Art: "zahl", Masseinheit: "s", Klasse: "zaehler", Gueltig: &Deckung{"d_bits", 0}},
	{Abschnitt: "dv", Name: "d_zaehler", Offset: 33, Typ: U16, Art: "zahl", Klasse: "zaehler", Ueberlauf: true, Gueltig: &Deckung{"d_bits", 0}},
	{Abschnitt: "wirkung", Name: "quelle_p", Offset: 34, Typ: U16, Art: "zustand", Aufzaehlung: "quelle_p", Klasse: "zustand", Gueltig: &Deckung{"s_bits", 0}},
	{Abschnitt: "wirkung", Name: "s_bits", Offset: 35, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Abschnitt: "wirkung", Name: "p_grenze_w", Offset: 36, Typ: U32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"s_bits", 0}},
	{Einheit: true, Name: "t_zustand", Offset: 0, Typ: U16, Art: "zustand", Aufzaehlung: "zustand", Klasse: "zustand", Gueltig: &Deckung{"t_bits", 0}},
	{Einheit: true, Name: "t_bits", Offset: 1, Typ: U16, Art: "bitfeld", Klasse: "zustand"},
	{Einheit: true, Name: "t_art", Offset: 2, Typ: U16, Art: "zustand", Aufzaehlung: "t_art", Klasse: "zustand"},
	{Einheit: true, Name: "t_nenn_kw", Offset: 3, Typ: U16, Art: "zahl", Masseinheit: "kW", Klasse: "zustand"},
	{Einheit: true, Name: "t_p_ist_w", Offset: 4, Typ: S32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"t_bits", 0}},
	{Einheit: true, Name: "t_p_soll_w", Offset: 6, Typ: U32, Art: "zahl", Masseinheit: "W", Klasse: "schnell", Totband: totband(500), Gueltig: &Deckung{"t_bits", 1}},
	{Einheit: true, Name: "t_e", Offset: 8, Typ: U32, Art: "zahl", Masseinheit: "kWh", Faktor: 0.1, Klasse: "zaehler", Gueltig: &Deckung{"t_bits", 0}},
}

// The names relative to beschreibung_ab (contract §6).
const (
	offsetNetzbetreiber    = 0
	offsetDirektvermarkter = 16
	offsetTypName          = 32
)

// ---------------------------------------------------------------- numbers

// wert32 is two words as a 32-bit pattern in the parameter's word order.
func wert32(w []uint16, i int, wortfolge string) uint32 {
	a, b := uint32(w[i]), uint32(w[i+1])
	if wortfolge == "little" {
		a, b = b, a
	}
	return a<<16 | b
}

func rohVon(w []uint16, i int, t Typ, wortfolge string) uint32 {
	if t.breit() {
		return wert32(w, i, wortfolge)
	}
	return uint32(w[i])
}

func mitVorzeichen(roh uint32, t Typ) int64 {
	switch t {
	case S16:
		return int64(int16(uint16(roh)))
	case S32:
		return int64(int32(roh))
	}
	return int64(roh)
}

// jsRound is JavaScript's Math.round: half towards +Infinity. The explicit
// float64(...) conversions keep Go from fusing multiply and add into one FMA
// (arm64), which would round differently than JavaScript and the Mango.
func jsRound(x float64) float64 { return math.Floor(float64(x) + 0.5) }

// skaliert is Math.round(zahl * faktor * 1e6) / 1e6 of the JS reader.
func skaliert(zahl int64, faktor float64) float64 {
	p := float64(float64(zahl) * faktor)
	q := float64(p * 1e6)
	return jsRound(q) / 1e6
}

// liesName reads an ISO-8859-1 name of 16 words, high byte first, ending at
// the first 0 byte. ok=false: empty or not all words there ("keiner").
func liesName(w []uint16, start int) (string, bool) {
	var b strings.Builder
	for i := 0; i < NameWoerter; i++ {
		if start+i < 0 || start+i >= len(w) {
			return "", false
		}
		x := w[start+i]
		for _, c := range []byte{byte(x >> 8), byte(x)} {
			if c == 0 {
				return b.String(), b.Len() > 0
			}
			b.WriteRune(rune(c))
		}
	}
	return b.String(), b.Len() > 0
}

// ---------------------------------------------------------------- planning

// LaengeBild is the running image's word count with n units: 38 + 10·n.
func LaengeBild(teAnzahl int) int { return FesterTeil + teAnzahl*EinheitLaenge }

// Anfrage is one planned read of the running image.
type Anfrage struct {
	Start      int
	Count      int
	Kopf       bool
	EinheitVon int
	Einheiten  int
}

// PlaneAnfragen plans the running image: at most maxWoerter per request and a
// unit block NEVER split (its halves could come from two program cycles). Up
// to 8 units one request, from 9 two (EZ-1 A1).
func PlaneAnfragen(basisadresse, teAnzahl, maxWoerter int) ([]Anfrage, error) {
	if basisadresse < 0 || basisadresse > 65535 {
		return nil, fmt.Errorf("Basisadresse ausserhalb 0 … 65 535")
	}
	if teAnzahl < 1 || teAnzahl > MaxEinheiten {
		return nil, fmt.Errorf("Zahl der Einheiten ausserhalb 1 … 10")
	}
	if basisadresse+LaengeBild(teAnzahl) > 65536 {
		return nil, fmt.Errorf("Registerbild reicht ueber den Adressraum hinaus")
	}
	if maxWoerter <= 0 {
		maxWoerter = MaxWoerterJeAnfrage
	}
	if FesterTeil > maxWoerter {
		return nil, fmt.Errorf("Der feste Teil passt in keine Anfrage")
	}
	var out []Anfrage
	adresse, vorlauf, naechste := basisadresse, FesterTeil, 0
	for naechste < teAnzahl || vorlauf > 0 {
		einheiten := min(teAnzahl-naechste, (maxWoerter-vorlauf)/EinheitLaenge)
		out = append(out, Anfrage{Start: adresse, Count: vorlauf + einheiten*EinheitLaenge,
			Kopf: vorlauf > 0, EinheitVon: naechste + 1, Einheiten: einheiten})
		adresse += vorlauf + einheiten*EinheitLaenge
		naechste += einheiten
		vorlauf = 0
	}
	return out, nil
}

// Bereich is a span of registers.
type Bereich struct {
	Start int
	Count int
}

// NamensBereich is where the names stand - ok=false when the image carries
// none: beschreibung_ab 0 or 0xFFFF, a span reaching into the running words or
// beyond the address space (the image itself stays readable, contract §6).
func NamensBereich(k *Kopf, basisadresse int) (Bereich, bool) {
	if k == nil || !k.Voll {
		return Bereich{}, false
	}
	ab := k.BeschreibungAb
	if ab == 0 || ab == 0xFFFF || ab < LaengeBild(k.TeAnzahl) {
		return Bereich{}, false
	}
	count := 2*NameWoerter + k.TeAnzahl*NameWoerter
	if basisadresse+ab+count > 65536 {
		return Bereich{}, false
	}
	return Bereich{Start: basisadresse + ab, Count: count}, true
}

// PlaneNamen: at most seven names (112 words) per request, a name never split.
func PlaneNamen(b Bereich, ok bool, maxWoerter int) []Bereich {
	if !ok {
		return nil
	}
	if maxWoerter <= 0 {
		maxWoerter = MaxWoerterJeAnfrage
	}
	je := (maxWoerter / NameWoerter) * NameWoerter
	var out []Bereich
	for s := 0; s < b.Count; s += je {
		out = append(out, Bereich{Start: b.Start + s, Count: min(je, b.Count-s)})
	}
	return out
}

// ---------------------------------------------------------------- reading

// Kopf is what the head check knows for sure. After a foreign major version
// or a wrong word order only the version (Voll=false); otherwise the head.
type Kopf struct {
	Hauptversion int
	Nebenversion int
	Voll         bool

	TeAnzahl       int
	Herzschlag     int
	Programmstand  *int   // nil: 0xFFFF
	SteuerungID    *int64 // nil: 0xFFFFFFFF
	Anlagenart     *int   // nil: outside the vocabulary
	BeschreibungAb int
}

// LiesKopf checks the head in the contract's order (§7): length, signature
// (before the word order), major version, check value, number of units.
func LiesKopf(w []uint16, wortfolge string) (string, *Kopf) {
	if len(w) < Kopflaenge {
		return GrundZuWenigWoerter, nil
	}
	if w[kopfSignatur1] != Signatur1 || w[kopfSignatur2] != Signatur2 {
		return GrundSignaturFremd, nil
	}
	version := int(w[kopfVersion])
	k := &Kopf{Hauptversion: version >> 8, Nebenversion: version & 0xFF}
	if k.Hauptversion != Hauptversion {
		return GrundVersionFremd, k
	}
	if wert32(w, kopfWortfolge, wortfolge) != WortfolgePruefwert {
		return GrundWortfolgeFalsch, k
	}
	k.Voll = true
	k.TeAnzahl = int(w[kopfTeAnzahl])
	k.Herzschlag = int(w[kopfHerzschlag])
	if p := int(w[kopfProgrammstand]); p != 0xFFFF {
		k.Programmstand = &p
	}
	if id := wert32(w, kopfSteuerungID, wortfolge); id != 0xFFFFFFFF {
		v := int64(id)
		k.SteuerungID = &v
	}
	if a := int(w[kopfAnlagenart]); imVokabular("anlagenart", int64(a)) {
		k.Anlagenart = &a
	}
	k.BeschreibungAb = int(w[kopfBeschreibung])
	if k.TeAnzahl < 1 || k.TeAnzahl > MaxEinheiten {
		return GrundTeAnzahlUngueltig, k
	}
	return "", k
}

// Wert is one field of a reading: a value or the reason it is none.
type Wert struct {
	Punkt     string
	Feld      string
	Abschnitt string // kopf, a, nb, dv, wirkung, or te<n>
	Einheit   int    // TE-Nr. from 1; 0 for the fixed sections
	Art       string
	Klasse    string
	Totband   *float64

	// Wert is the value in the field's unit (nil: no value, see Grund).
	Wert *float64
	// Roh is what the JS reader calls roh: the unsigned pattern when the
	// field is not a value by its covering bit or type maximum, the signed
	// number otherwise.
	Roh   int64
	Grund string

	// Qualitaet is set by the stage: good, stale, uncertain, invalid; "" =
	// no sample.
	Qualitaet string
}

// Lesung is one interpreted reading of the running image.
type Lesung struct {
	Ergebnis string
	Grund    string
	Kopf     *Kopf
	Werte    []Wert
}

// Soll is what the installed plant expects (0/nil = not checked).
type Soll struct {
	TeAnzahl    int
	SteuerungID *int64
	Anlagenart  int
	// AlterSchwelleS replaces the default threshold of a_alter_s (stufe.go).
	AlterSchwelleS *int
}

func nichtLesbar(grund string, k *Kopf) Lesung {
	return Lesung{Ergebnis: ErgebnisNichtLesbar, Grund: grund, Kopf: k}
}

// PunktVon is the measurement point of a field: erzeuger.<abschnitt>.<feld>,
// per unit erzeuger.te[<n>].<feld> with n from 1 (catalog EZ-6).
func PunktVon(f Feld, einheit int) string {
	if f.Einheit {
		return "erzeuger.te[" + strconv.Itoa(einheit) + "]." + f.Name
	}
	return "erzeuger." + f.Abschnitt + "." + f.Name
}

func bitfelder(felder []Feld, w []uint16, start int, wortfolge string) map[string]*uint32 {
	out := map[string]*uint32{}
	for _, f := range felder {
		if f.Art != "bitfeld" {
			continue
		}
		roh := rohVon(w, start+f.Offset, f.Typ, wortfolge)
		if roh == f.Typ.ungueltig() {
			out[f.Name] = nil
		} else {
			v := roh
			out[f.Name] = &v
		}
	}
	return out
}

func deuteFeld(f Feld, w []uint16, start int, wortfolge string, bits map[string]*uint32) (wert *float64, roh int64, grund string) {
	r := rohVon(w, start+f.Offset, f.Typ, wortfolge)
	// The contract's order: the covering bit, then the type maximum, then the
	// vocabulary.
	if f.Gueltig != nil {
		deckend := bits[f.Gueltig.Feld]
		if deckend == nil || *deckend&(1<<f.Gueltig.Bit) == 0 {
			return nil, int64(r), LeerGueltigkeit
		}
	}
	if !f.Ueberlauf && r == f.Typ.ungueltig() {
		return nil, int64(r), LeerUngueltig
	}
	zahl := mitVorzeichen(r, f.Typ)
	if f.Aufzaehlung != "" && !imVokabular(f.Aufzaehlung, zahl) {
		return nil, zahl, LeerFremd
	}
	v := float64(zahl)
	if f.Faktor != 0 {
		v = skaliert(zahl, f.Faktor)
	}
	return &v, zahl, ""
}

// Lies interprets the running image. w[0] is the word at the base address;
// all 38 + 10·n words must be there (n from the head). Every reason means not
// a single value - rather no number than a wrong one. With a Soll reason the
// head is readable and travels with the reading ("3 units instead of 2").
func Lies(w []uint16, wortfolge string, soll *Soll) Lesung {
	if wortfolge == "" {
		wortfolge = "big"
	}
	grund, k := LiesKopf(w, wortfolge)
	if grund != "" {
		if grund == GrundTeAnzahlUngueltig {
			return nichtLesbar(grund, k)
		}
		return nichtLesbar(grund, nil)
	}
	if len(w) < LaengeBild(k.TeAnzahl) {
		return nichtLesbar(GrundZuWenigWoerter, k)
	}
	if soll != nil {
		if soll.TeAnzahl > 0 && k.TeAnzahl != soll.TeAnzahl {
			// A unit came or went: numbers are never re-attached silently.
			return nichtLesbar(GrundTeAnzahlAbweichend, k)
		}
		if soll.SteuerungID != nil && (k.SteuerungID == nil || *k.SteuerungID != *soll.SteuerungID) {
			return nichtLesbar(GrundSteuerungIDAbweichend, k)
		}
		if soll.Anlagenart > 0 && (k.Anlagenart == nil || *k.Anlagenart != soll.Anlagenart) {
			return nichtLesbar(GrundAnlagenartAbweichend, k)
		}
	}
	var anlage, einheit []Feld
	for _, f := range Felder {
		if f.Einheit {
			einheit = append(einheit, f)
		} else {
			anlage = append(anlage, f)
		}
	}
	l := Lesung{Ergebnis: ErgebnisErkannt, Kopf: k}
	eintrag := func(f Feld, n, start int, bits map[string]*uint32) {
		v := Wert{Punkt: PunktVon(f, n), Feld: f.Name, Abschnitt: f.Abschnitt, Art: f.Art,
			Klasse: f.Klasse, Totband: f.Totband}
		if f.Einheit {
			v.Abschnitt = "te" + strconv.Itoa(n)
			v.Einheit = n
		}
		v.Wert, v.Roh, v.Grund = deuteFeld(f, w, start, wortfolge, bits)
		l.Werte = append(l.Werte, v)
	}
	bitsAnlage := bitfelder(anlage, w, 0, wortfolge)
	for _, f := range anlage {
		eintrag(f, 0, 0, bitsAnlage)
	}
	for n := 1; n <= k.TeAnzahl; n++ {
		// Unit n starts at 38 + (n-1)·10 - with the count FROM THE HEAD.
		start := FesterTeil + (n-1)*EinheitLaenge
		bits := bitfelder(einheit, w, start, wortfolge)
		for _, f := range einheit {
			eintrag(f, n, start, bits)
		}
	}
	return l
}

// Name is one name of the image; Wert nil = "keiner" or not read.
type Name struct {
	Feld    string
	Einheit int
	Wert    *string
}

// LiesNamen interprets the names; w[0] is the word at base + beschreibung_ab.
// Names are no measurement points (catalog EZ-6): they travel with the probe.
func LiesNamen(w []uint16, teAnzahl int) []Name {
	name := func(start int) *string {
		if w == nil {
			return nil
		}
		if s, ok := liesName(w, start); ok {
			return &s
		}
		return nil
	}
	out := []Name{
		{Feld: "netzbetreiber_name", Wert: name(offsetNetzbetreiber)},
		{Feld: "direktvermarkter_name", Wert: name(offsetDirektvermarkter)},
	}
	for e := 1; e <= teAnzahl; e++ {
		out = append(out, Name{Feld: "t_typ_name", Einheit: e, Wert: name(offsetTypName + (e-1)*NameWoerter)})
	}
	return out
}

// HerzschlagUrteil is how the heartbeat relates to the previous reading.
// ueberlauf (65535 → 0 with a small step) is no restart (EZ-1 A2).
func HerzschlagUrteil(vorher *int, jetzt, schrittgrenze int) string {
	if vorher == nil {
		return "erste_lesung"
	}
	switch {
	case jetzt == *vorher:
		return "steht"
	case jetzt > *vorher:
		return "laeuft"
	case jetzt+0x10000-*vorher <= schrittgrenze:
		return "ueberlauf"
	}
	return "rueckwaerts"
}

// ---------------------------------------------------------------- points

var punktMuster = regexp.MustCompile(`^erzeuger\.(?:(kopf|a|nb|dv|wirkung)|te\[(\d+|\*)])\.([a-z0-9_]+)$`)

// PunktTeile splits a point key; einheit -1 is the catalog template te[*],
// 0 a fixed section. ok=false: not a point of this image.
func PunktTeile(pointKey string) (abschnitt string, einheit int, feld string, ok bool) {
	m := punktMuster.FindStringSubmatch(pointKey)
	if m == nil {
		return "", 0, "", false
	}
	if m[1] != "" {
		return m[1], 0, m[3], true
	}
	if m[2] == "*" {
		return "te", -1, m[3], true
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return "", 0, "", false
	}
	return "te", n, m[3], true
}

// PunkteFuer lists all points of an image with n units - the box's view of
// the family, in the order of the field table.
func PunkteFuer(teAnzahl int) []string {
	var out []string
	for _, f := range Felder {
		if !f.Einheit {
			out = append(out, PunktVon(f, 0))
		}
	}
	for e := 1; e <= teAnzahl; e++ {
		for _, f := range Felder {
			if f.Einheit {
				out = append(out, PunktVon(f, e))
			}
		}
	}
	return out
}

// IstPunkt reports whether a point key names a field this reader knows.
func IstPunkt(pointKey string) bool {
	abschnitt, _, feld, ok := PunktTeile(pointKey)
	if !ok {
		return false
	}
	for _, f := range Felder {
		if f.Name != feld {
			continue
		}
		if f.Einheit {
			// te[0] is a key of the template too; that no unit 0 exists is
			// the plan's verdict (driver_unavailable), as in the palette.
			return abschnitt == "te"
		}
		return f.Abschnitt == abschnitt
	}
	return false
}
