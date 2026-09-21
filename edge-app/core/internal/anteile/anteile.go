// Package anteile is the box side of the shares of a Gemeinsame Steuerung
// (UEMS AP-15 IP-17; contracts docs/contracts/v2/steuerungsverbund.md and
// mqtt-verbund-anteile.md): the Go twin of the share rules (NW-1 - the same
// vectors as Java SteuerungsverbundAnteile and the Python reference), the
// wire reading of the share document, and its store on disk (Y2).
//
// Pure: no MQTT, no clock. All arithmetic is exact (math/big.Rat on the
// decimal text of the JSON numbers) - a float64 would turn 24.6 kW into 24.7
// kW when rounding up. Whoever changes a rule changes the vector file AND all
// twins.
package anteile

import (
	"errors"
	"math/big"
	"slices"
	"sort"
)

// Richtungen are the two directions that carry shares; the grid operator's
// curtailment is a narrowing, not a share.
var Richtungen = []string{"einspeisung", "bezug"}

// Closed vocabularies (steuerungsverbund.md §2), compared word for word with
// the vector file.
var (
	Rollen            = []string{"fuehrt", "steuert_mit", "liest"}
	AuslegungUrteile  = []string{"passt", "auslegung_passt_nicht", "vorbehalt_ueber_grenze"}
	DokumentUrteile   = []string{Angenommen, Abgelehnt}
	DokumentAblehnung = []string{GrundFremdeAnlage, GrundBoxFehlt, GrundRevisionAelter, GrundSummeUeberVerteilbar}
)

// The verdict words of the box on one share document.
const (
	Angenommen                = "angenommen"
	Abgelehnt                 = "abgelehnt"
	GrundFremdeAnlage         = "fremde_anlage"
	GrundBoxFehlt             = "box_fehlt_im_dokument"
	GrundRevisionAelter       = "revision_aelter"
	GrundSummeUeberVerteilbar = "summe_ueber_verteilbar"
)

// verteilReihenfolge is G4: first the co-controlling boxes, then the leading one.
var verteilReihenfolge = []string{"steuert_mit", "fuehrt"}

// Mitglied is one member in ONE direction: rated power and device fallback of
// the box in kW.
type Mitglied struct {
	Box         string
	Rolle       string
	NennKw      *big.Rat
	RueckfallKw *big.Rat
}

// Auslegung is the verdict of one direction, all kW values in tenths of a kW.
// SummeRueckfall is absent on vorbehalt_ueber_grenze, Ungenutzt on every
// verdict but passt; Anteile is then empty.
type Auslegung struct {
	Urteil                string
	VerteilbarZehntel     int64
	SummeRueckfallZehntel *int64
	AnteileZehntel        map[string]int64
	UngenutztZehntel      *int64
}

// Ablehnung is the arming refusal of this verdict: none for passt, otherwise
// auslegung_passt_nicht (E2 = A).
func (a Auslegung) Ablehnung() string {
	if a.Urteil == "passt" {
		return ""
	}
	return "auslegung_passt_nicht"
}

// ErrEingang marks an invalid input (negative, a box twice, a reading box as
// member, fallback above rated power on the RAW values) - no verdict.
var ErrEingang = errors.New("ungueltiger Eingang")

// Verteilen computes the shares of one direction (G2-G4, E2 = A): inputs
// finer than 0.1 kW round to the safe side (limit and rated power down,
// reserve and fallback up), every pro-rata addition rounds down, and the
// rounding rest stays unused.
func Verteilen(grenzeKw, vorbehaltKw *big.Rat, mitglieder []Mitglied) (Auslegung, error) {
	if negativ(grenzeKw) || negativ(vorbehaltKw) {
		return Auslegung{}, ErrEingang
	}
	gesehen := map[string]bool{}
	rueckfall := map[string]int64{}
	nenn := map[string]int64{}
	for _, m := range mitglieder {
		if negativ(m.NennKw) || negativ(m.RueckfallKw) || gesehen[m.Box] ||
			!slices.Contains(verteilReihenfolge, m.Rolle) || m.RueckfallKw.Cmp(m.NennKw) > 0 {
			return Auslegung{}, ErrEingang
		}
		gesehen[m.Box] = true
		f := zehntelAuf(m.RueckfallKw)
		rueckfall[m.Box] = f
		// the share is never below the rounded-up fallback, even when the
		// rounded-down rated power lies below it (22.08/22.08 kW -> 22.1 kW)
		nenn[m.Box] = max(zehntelAb(m.NennKw), f)
	}
	verteilbar := zehntelAb(grenzeKw) - zehntelAuf(vorbehaltKw)
	if verteilbar < 0 {
		return Auslegung{Urteil: "vorbehalt_ueber_grenze", VerteilbarZehntel: verteilbar,
			AnteileZehntel: map[string]int64{}}, nil
	}
	var summeRueckfall int64
	for _, f := range rueckfall {
		summeRueckfall += f
	}
	if summeRueckfall > verteilbar {
		return Auslegung{Urteil: "auslegung_passt_nicht", VerteilbarZehntel: verteilbar,
			SummeRueckfallZehntel: &summeRueckfall, AnteileZehntel: map[string]int64{}}, nil
	}
	rest := verteilbar - summeRueckfall
	anteil := map[string]int64{}
	for b, f := range rueckfall {
		anteil[b] = f
	}
	for _, rolle := range verteilReihenfolge {
		var gruppe []string
		for _, m := range mitglieder {
			if m.Rolle == rolle {
				gruppe = append(gruppe, m.Box)
			}
		}
		bedarf := map[string]int64{}
		var gesamt int64
		for _, b := range gruppe {
			bedarf[b] = nenn[b] - anteil[b]
			gesamt += bedarf[b]
		}
		if gesamt == 0 || rest == 0 {
			continue
		}
		if gesamt <= rest {
			for _, b := range gruppe {
				anteil[b] += bedarf[b]
			}
			rest -= gesamt
			continue
		}
		for _, b := range gruppe {
			anteil[b] += rest * bedarf[b] / gesamt // integer division = rounded down
		}
		rest = 0 // the rounding rest stays unused, it does not move on
	}
	var vergeben int64
	for _, z := range anteil {
		vergeben += z
	}
	ungenutzt := verteilbar - vergeben
	return Auslegung{Urteil: "passt", VerteilbarZehntel: verteilbar, SummeRueckfallZehntel: &summeRueckfall,
		AnteileZehntel: anteil, UngenutztZehntel: &ungenutzt}, nil
}

// Uebergang is the transition state of the two-step change (G5), the boxes
// that must receipt it, and whether a target state follows.
type Uebergang struct {
	Uebergang      map[string]*big.Rat
	VerengteBoxen  []string
	ZweiterSchritt bool
}

// Uebergangsstand is G5: per box the smaller of old and new; a box missing in
// one state stands there with 0.
func Uebergangsstand(alt, neu map[string]*big.Rat) Uebergang {
	boxen := map[string]bool{}
	for b := range alt {
		boxen[b] = true
	}
	for b := range neu {
		boxen[b] = true
	}
	sortiert := make([]string, 0, len(boxen))
	for b := range boxen {
		sortiert = append(sortiert, b)
	}
	sort.Strings(sortiert)
	u := Uebergang{Uebergang: map[string]*big.Rat{}, VerengteBoxen: []string{}}
	for _, b := range sortiert {
		a, n := oderNull(alt[b]), oderNull(neu[b])
		m := a
		if n.Cmp(a) < 0 {
			m = n
		}
		u.Uebergang[b] = m
		if m.Cmp(a) < 0 {
			u.VerengteBoxen = append(u.VerengteBoxen, b)
		}
		if m.Cmp(n) != 0 {
			u.ZweiterSchritt = true
		}
	}
	return u
}

// Identitaet is who the box is - tenant, site and own id (T4).
type Identitaet struct {
	Mandant string
	Anlage  string
	Box     string
}

// Stand is the effective epoch and revision of a box.
type Stand struct {
	Epoche   int64 `json:"epoche"`
	Revision int64 `json:"revision"`
}

// Dokument is a share document with the WHOLE table per direction and the
// distributable power (Y1).
type Dokument struct {
	Mandant    string
	Anlage     string
	Epoche     int64
	Revision   int64
	Verteilbar map[string]*big.Rat
	Anteile    map[string]map[string]*big.Rat
}

// Pruefung is the box's verdict; Grund only on abgelehnt.
type Pruefung struct {
	Urteil string
	Grund  string
}

// Angenommen reports the acceptance.
func (p Pruefung) Angenommen() bool { return p.Urteil == Angenommen }

// DokumentPruefen checks one share document on the box, in this order:
// tenant and site, the own id in BOTH directions (unknown is no zero), epoch
// and revision only rise (the same revision again is accepted), per
// direction sum <= distributable - exact, without rounding. stand nil = the
// box holds no document yet.
func DokumentPruefen(id Identitaet, stand *Stand, d Dokument) Pruefung {
	if id.Mandant != d.Mandant || id.Anlage != d.Anlage {
		return Pruefung{Abgelehnt, GrundFremdeAnlage}
	}
	for _, r := range Richtungen {
		if _, ok := d.Anteile[r][id.Box]; !ok {
			return Pruefung{Abgelehnt, GrundBoxFehlt}
		}
	}
	if stand != nil && (d.Epoche < stand.Epoche || d.Epoche == stand.Epoche && d.Revision < stand.Revision) {
		return Pruefung{Abgelehnt, GrundRevisionAelter}
	}
	for _, r := range Richtungen {
		summe := new(big.Rat)
		for _, kw := range d.Anteile[r] {
			summe.Add(summe, kw)
		}
		if summe.Cmp(oderNull(d.Verteilbar[r])) > 0 {
			return Pruefung{Abgelehnt, GrundSummeUeberVerteilbar}
		}
	}
	return Pruefung{Urteil: Angenommen}
}

func negativ(kw *big.Rat) bool { return kw == nil || kw.Sign() < 0 }

func oderNull(kw *big.Rat) *big.Rat {
	if kw == nil {
		return new(big.Rat)
	}
	return kw
}

// zehntelAb is floor(kw * 10) for non-negative kw; zehntelAuf the ceiling.
func zehntelAb(kw *big.Rat) int64 {
	z := new(big.Rat).Mul(kw, big.NewRat(10, 1))
	return new(big.Int).Quo(z.Num(), z.Denom()).Int64()
}

func zehntelAuf(kw *big.Rat) int64 {
	z := new(big.Rat).Mul(kw, big.NewRat(10, 1))
	q, r := new(big.Int).QuoRem(z.Num(), z.Denom(), new(big.Int))
	if r.Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}
