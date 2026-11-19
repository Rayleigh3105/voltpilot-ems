// Package koppelbild is the box side of the VoltPilot-Koppelbild v1
// (docs/contracts/v2/koppelbild.md): the box writes wishes into the
// controller's holding registers 0..63, the controller's library block decides
// and acknowledges in the input registers 1000..1115. The controller always
// decides; every wish runs out by itself.
//
// This file is the picture itself: the telegram writer (Schreibe), the reader
// of the acknowledgement (Lies) and the seal. lage.go judges a reading over
// time (life sign, restart, second writer), steuerung.go runs one controller.
// The vectors (koppelbild-vectors.json) are the specification; vertrag_test.go
// runs every case through all three.
package koppelbild

// Addresses and lengths, fixed per version 1.0 (contract §2).
const (
	WBasis       = 0
	WWoerter     = 64
	QBasis       = 1000
	QWoerter     = 116
	Plaetze      = 8
	wPlatz       = 16
	wPlatzLaenge = 6
	qPlatz       = 20
	qPlatzLaenge = 12
	wSiegel      = 15
	qSiegel      = 19
	version      = 0x0100
	hauptversion = 1

	// FristMinS and FristMaxS bound frist_s (contract §3).
	FristMinS = 5
	FristMaxS = 600
	// FristS is the box's frist: twelve lost telegrams at 5 s until the wish
	// runs out.
	FristS = 60

	s32Max = 0x7FFFFFFF
	u32Max = 0xFFFFFFFF
)

var (
	sigW   = [2]uint16{0x5650, 0x4B57} // "VP" "KW"
	sigQ   = [2]uint16{0x5650, 0x4B51} // "VP" "KQ"
	pruefW = [2]uint16{0x0102, 0x0304}
)

// The closed vocabularies (contract §7). The index is the code.
var (
	ArtNamen        = []string{"keiner", "limit_w", "limit_pct", "setpoint_w", "on_off", "mode", "setpoint_c"}
	ZielNamen       = []string{"", "erzeugung_gesamt", "erzeugungseinheit", "speicher", "verbraucher", "netzbezug", "einspeisung", "probe"}
	GrundNamen      = []string{"keiner", "markt", "netz", "regel", "hand", "test"}
	KopfUrteilNamen = []string{"keins", "angenommen", "signatur_fremd", "version_fremd", "wortfolge_falsch",
		"siegel_falsch", "steuerung_fremd", "kopf_ungueltig", "abgelaufen", "gesperrt"}
	QUrteilNamen = []string{"kein_wunsch", "angenommen", "begrenzt", "art_fremd", "wert_ungueltig",
		"nicht_bereit", "ueberstimmt", "abgelaufen"}
)

// The bit fields (contract §6), in bit order.
var (
	EBitNamen = []string{"cloud_verbunden", "plan_frisch", "steuerung_frei", "probe"}
	QBitNamen = []string{"fernsteuerung_frei", "edge_lebt", "hand_ort"}
	ABitNamen = []string{"bereit", "grund_stoerung", "grund_hand_ort", "grund_wartung", "grund_vorrang", "grund_sonstiger"}
)

// artBand is the natural band of each kind; an offer outside it (or turned
// round) is no capability (angebot_ungueltig, contract §7).
var artBand = map[string][2]int64{
	"limit_w":    {0, s32Max - 1},
	"limit_pct":  {0, 1000},
	"setpoint_w": {-s32Max, s32Max - 1},
	"on_off":     {0, 1},
	"mode":       {1, 8},
	"setpoint_c": {-s32Max, s32Max - 1},
}

func code(namen []string, name string) (uint16, bool) {
	for i, n := range namen {
		if n == name && n != "" {
			return uint16(i), true
		}
	}
	return 0, false
}

// Crc16 is CRC-16/MODBUS over the words, high byte first (contract §8).
func Crc16(woerter []uint16) uint16 {
	c := uint16(0xFFFF)
	for _, w := range woerter {
		for _, b := range [2]uint16{w >> 8, w & 0xFF} {
			c ^= b
			for i := 0; i < 8; i++ {
				if c&1 != 0 {
					c = c>>1 ^ 0xA001
				} else {
					c >>= 1
				}
			}
		}
	}
	return c
}

func siegel(w []uint16, ohne int) uint16 {
	rest := make([]uint16, 0, len(w)-1)
	rest = append(rest, w[:ohne]...)
	return Crc16(append(rest, w[ohne+1:]...))
}

func setze32(w []uint16, a int, v uint32) {
	w[a], w[a+1] = uint16(v>>16), uint16(v)
}

func roh32(w []uint16, a int) uint32 { return uint32(w[a])<<16 | uint32(w[a+1]) }

func bits(namen []string, gesetzt []string) uint16 {
	var b uint16
	for _, g := range gesetzt {
		if c, ok := code(namen, g); ok {
			b |= 1 << c
		}
	}
	return b
}

func bitNamen(namen []string, w uint16) []string {
	out := []string{}
	for i, n := range namen {
		if w>>i&1 == 1 {
			out = append(out, n)
		}
	}
	return out
}

// PlatzWunsch is what the box wishes on one Stellplatz. Art "keiner" (or "")
// is no wish; Folge counts every change of kind or value.
type PlatzWunsch struct {
	Art   string `json:"art"`
	Grund string `json:"grund"`
	Wert  int32  `json:"wert"`
	Folge uint16 `json:"folge"`
}

// Absicht is one telegram the box means to write.
type Absicht struct {
	Sitzung     uint16              `json:"sitzung"`
	Herzschlag  uint16              `json:"herzschlag"`
	SteuerungID uint32              `json:"steuerung_id"`
	FristS      uint16              `json:"frist_s"`
	EBits       []string            `json:"e_bits"`
	Plaetze     map[int]PlatzWunsch `json:"plaetze"`
}

// Schreibe builds the 64 words of a telegram, always whole and sealed
// (contract §3). A Stellplatz without a wish carries kind 0 and the type
// maximum; its Folge stays.
func Schreibe(a Absicht) []uint16 {
	w := make([]uint16, WWoerter)
	w[0], w[1], w[2], w[3] = sigW[0], sigW[1], pruefW[0], pruefW[1]
	w[4] = version
	w[5] = Plaetze
	w[6] = a.Sitzung
	w[7] = a.Herzschlag
	setze32(w, 8, a.SteuerungID)
	w[10] = a.FristS
	w[11] = bits(EBitNamen, a.EBits)
	for n := 1; n <= Plaetze; n++ {
		b := wPlatz + (n-1)*wPlatzLaenge
		p, da := a.Plaetze[n]
		art, mit := code(ArtNamen, p.Art)
		if !da || !mit || art == 0 {
			w[b], w[b+1] = 0, 0
			setze32(w, b+2, s32Max)
		} else {
			g, _ := code(GrundNamen, p.Grund)
			w[b], w[b+1] = art, g
			setze32(w, b+2, uint32(p.Wert))
		}
		w[b+4] = p.Folge
	}
	w[wSiegel] = siegel(w, wSiegel)
	return w
}

// Angebot is what a Stellplatz offers (contract §4), in the units of its kind.
type Angebot struct {
	Art  string   `json:"art"`
	Ziel string   `json:"ziel"`
	Nr   uint16   `json:"nr"`
	Min  int32    `json:"min"`
	Max  int32    `json:"max"`
	Bits []string `json:"bits"`
}

// Bereit reports a_bits bit 0.
func (a Angebot) Bereit() bool {
	for _, b := range a.Bits {
		if b == "bereit" {
			return true
		}
	}
	return false
}

// Platz is one Stellplatz of a reading. Nil fields are no value; Leer names why.
type Platz struct {
	N        int               `json:"n"`
	Angebot  *Angebot          `json:"angebot"`
	QUrteil  *string           `json:"q_urteil"`
	QFolge   uint16            `json:"q_folge"`
	QWirksam *int32            `json:"q_wirksam"`
	Leer     map[string]string `json:"leer"`
}

// Bibliothek is the library version of a reading.
type Bibliothek struct {
	Haupt int `json:"haupt"`
	Neben int `json:"neben"`
}

// Kopf is the head of a readable acknowledgement.
type Kopf struct {
	VersionHaupt      int         `json:"version_haupt"`
	VersionNeben      int         `json:"version_neben"`
	PlatzAnzahl       int         `json:"platz_anzahl"`
	Herzschlag        uint16      `json:"herzschlag"`
	SteuerungID       *uint32     `json:"steuerung_id"`
	QSitzung          uint16      `json:"q_sitzung"`
	QHerzschlag       uint16      `json:"q_herzschlag"`
	AngenommenZaehler uint16      `json:"angenommen_zaehler"`
	AbgelehntZaehler  uint16      `json:"abgelehnt_zaehler"`
	Bibliothek        *Bibliothek `json:"bibliothek"`
	KopfUrteil        *string     `json:"kopf_urteil"`
	RestS             *uint16     `json:"rest_s"`
	QBits             []string    `json:"q_bits"`
}

// HatQBit reports a q_bits flag; unknown bits read as not set.
func (k Kopf) HatQBit(name string) bool {
	for _, b := range k.QBits {
		if b == name {
			return true
		}
	}
	return false
}

// Lesung is one reading of the acknowledgement (contract §9). Ergebnis is
// "lesbar" or "nicht_lesbar"; Grund names why not, or steuerung_id_abweichend
// for a readable head of the wrong controller.
type Lesung struct {
	Ergebnis string            `json:"ergebnis"`
	Grund    string            `json:"grund,omitempty"`
	Kopf     *Kopf             `json:"kopf,omitempty"`
	Leer     map[string]string `json:"leer,omitempty"`
	Plaetze  []Platz           `json:"plaetze,omitempty"`
}

// Lesbar reports whether the head and the values may be used.
func (l Lesung) Lesbar() bool { return l.Ergebnis == "lesbar" }

// Lies reads the 116 words of the acknowledgement against the expected
// controller id, in the order of contract §9.
func Lies(q []uint16, soll uint32) Lesung {
	nicht := func(g string) Lesung { return Lesung{Ergebnis: "nicht_lesbar", Grund: g} }
	switch {
	case len(q) < QWoerter:
		return nicht("zu_wenig_woerter")
	case q[0] != sigQ[0] || q[1] != sigQ[1]:
		return nicht("signatur_fremd")
	case q[4]>>8 != hauptversion:
		return nicht("version_fremd")
	case q[2] != pruefW[0] || q[3] != pruefW[1]:
		return nicht("wortfolge_falsch")
	case siegel(q[:QWoerter], qSiegel) != q[qSiegel]:
		return nicht("siegel_falsch")
	case q[5] > Plaetze:
		return nicht("platz_anzahl_ungueltig")
	}
	leer := map[string]string{}
	k := &Kopf{VersionHaupt: int(q[4] >> 8), VersionNeben: int(q[4] & 0xFF), PlatzAnzahl: int(q[5]),
		Herzschlag: q[6], QSitzung: q[11], QHerzschlag: q[12], AngenommenZaehler: q[15], AbgelehntZaehler: q[16]}
	if id := roh32(q, 8); id != u32Max {
		k.SteuerungID = &id
	}
	if q[7] == 0xFFFF {
		leer["bibliothek"] = "ungueltig"
	} else {
		k.Bibliothek = &Bibliothek{Haupt: int(q[7] >> 8), Neben: int(q[7] & 0xFF)}
	}
	k.KopfUrteil = vokabular(KopfUrteilNamen, q[10], "kopf_urteil", leer)
	if q[13] == 0xFFFF {
		leer["rest_s"] = "ungueltig"
	} else {
		r := q[13]
		k.RestS = &r
	}
	if q[14] == 0xFFFF {
		leer["q_bits"] = "ungueltig"
	} else {
		k.QBits = bitNamen(QBitNamen, q[14])
	}
	plaetze := make([]Platz, Plaetze)
	for n := 1; n <= Plaetze; n++ {
		b := qPlatz + (n-1)*qPlatzLaenge
		p := Platz{N: n, Leer: map[string]string{}}
		p.Angebot = liesAngebot(q, b, p.Leer)
		p.QUrteil = vokabular(QUrteilNamen, q[b+8], "q_urteil", p.Leer)
		p.QFolge = q[b+9]
		if wk := roh32(q, b+10); wk == s32Max {
			p.Leer["q_wirksam"] = "ungueltig"
		} else {
			v := int32(wk)
			p.QWirksam = &v
		}
		plaetze[n-1] = p
	}
	l := Lesung{Ergebnis: "lesbar", Kopf: k, Leer: leer, Plaetze: plaetze}
	if k.SteuerungID == nil || *k.SteuerungID != soll {
		l.Grund = "steuerung_id_abweichend"
	}
	return l
}

func vokabular(namen []string, w uint16, feld string, leer map[string]string) *string {
	switch {
	case w == 0xFFFF:
		leer[feld] = "ungueltig"
	case int(w) >= len(namen) || namen[w] == "":
		leer[feld] = "fremd"
	default:
		n := namen[w]
		return &n
	}
	return nil
}

func liesAngebot(q []uint16, b int, leer map[string]string) *Angebot {
	art := vokabular(ArtNamen, q[b], "a_art", leer)
	if art == nil || *art == "keiner" {
		return nil
	}
	ziel := vokabular(ZielNamen, q[b+1], "a_ziel", leer)
	if ziel == nil {
		return nil
	}
	lo, hi := roh32(q, b+4), roh32(q, b+6)
	band := artBand[*art]
	if lo == s32Max || hi == s32Max || q[b+2] == 0xFFFF || q[b+3] == 0xFFFF ||
		int64(int32(lo)) < band[0] || int32(lo) > int32(hi) || int64(int32(hi)) > band[1] {
		leer["angebot"] = "angebot_ungueltig"
		return nil
	}
	return &Angebot{Art: *art, Ziel: *ziel, Nr: q[b+2], Min: int32(lo), Max: int32(hi), Bits: bitNamen(ABitNamen, q[b+3])}
}
