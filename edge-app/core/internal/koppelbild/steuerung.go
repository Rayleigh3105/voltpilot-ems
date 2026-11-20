package koppelbild

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// Takt of the box: read and write every 5 s, on a change at once but at most
// one telegram per second (contract §1).
const (
	Takt       = 5 * time.Second
	MinAbstand = time.Second
)

// Faehigkeit is one released Stellplatz as the registry push declares it: an
// actuate capability of the Anlagensteuerung with its platz (contract §15).
type Faehigkeit struct {
	Platz    int
	Kommando string
}

// Wunsch is what the box wants on one Stellplatz, in the units of the picture.
type Wunsch struct {
	Art   string
	Wert  int32
	Grund string
}

// kommandoArt maps the arbiter's command onto the kind of a Stellplatz and the
// factor into the picture's whole units (contract §15).
var kommandoArt = map[string]struct {
	art    string
	faktor float64
}{
	"limit_kw":    {"limit_w", 1000},
	"limit_pct":   {"limit_pct", 10},
	"setpoint_kw": {"setpoint_w", 1000},
	"setpoint_c":  {"setpoint_c", 10},
	"on_off":      {"on_off", 1},
	"mode":        {"mode", 1},
}

// ArtFuer names the Stellplatz kind of an arbiter command ("" = none).
func ArtFuer(kommando string) string { return kommandoArt[kommando].art }

// KommandoFuer names the arbiter command of a Stellplatz kind ("" = none).
func KommandoFuer(art string) string {
	for k, v := range kommandoArt {
		if v.art == art {
			return k
		}
	}
	return ""
}

// Befehl is one granted arbiter command of the Anlagensteuerung, as the core
// publishes it on edge/entities/{id}/command.
type Befehl struct {
	SetpointKw *float64
	SetpointC  *float64
	LimitKw    *float64
	LimitPct   *float64
	OnOff      *bool
	Mode       string
	Source     string
}

func (b Befehl) wert(kommando string) (float64, bool) {
	switch kommando {
	case "limit_kw":
		return deref(b.LimitKw)
	case "limit_pct":
		return deref(b.LimitPct)
	case "setpoint_kw":
		return deref(b.SetpointKw)
	case "setpoint_c":
		return deref(b.SetpointC)
	case "on_off":
		if b.OnOff == nil {
			return 0, false
		}
		if *b.OnOff {
			return 1, true
		}
		return 0, true
	case "mode":
		n, err := strconv.Atoi(b.Mode)
		return float64(n), err == nil && n >= 1 && n <= 8
	}
	return 0, false
}

func deref(p *float64) (float64, bool) {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
		return 0, false
	}
	return *p, true
}

// GrundAus names the wish's reason from the command's source (an answer, not
// a switch: contract §7).
func GrundAus(source string) string {
	s := strings.ToLower(source)
	switch {
	case strings.Contains(s, "plan"), strings.Contains(s, "market"):
		return "markt"
	case strings.Contains(s, "local-ui"), strings.Contains(s, "override"):
		return "hand"
	case strings.Contains(s, "grid"), strings.Contains(s, "contract"), strings.Contains(s, "cloud"):
		return "netz"
	case s != "":
		return "regel"
	}
	return "keiner"
}

// WuenscheAus turns a granted command into the wishes per Stellplatz: every
// released capability whose command carries a value. Rounded half away from
// zero into the picture's whole units; values outside int32 are no wish.
func WuenscheAus(b Befehl, faehigkeiten []Faehigkeit) map[int]Wunsch {
	out := map[int]Wunsch{}
	for _, f := range faehigkeiten {
		ka, ok := kommandoArt[f.Kommando]
		if !ok || f.Platz < 1 || f.Platz > Plaetze {
			continue
		}
		v, da := b.wert(f.Kommando)
		if !da {
			continue
		}
		w := math.Round(v * ka.faktor) // math.Round: halves away from zero
		if w < math.MinInt32+1 || w > s32Max-1 {
			continue
		}
		out[f.Platz] = Wunsch{Art: ka.art, Wert: int32(w), Grund: GrundAus(b.Source)}
	}
	return out
}

// Test is a running Schalt-Test on one Stellplatz: it wins over the arbiter
// for its time (contract §15).
type Test struct {
	Platz int
	Art   string
	Wert  int32
	Bis   time.Time
}

// Steuerung runs the Koppelbild of one controller over the box's life: its
// session, life sign, Folge per Stellplatz and the last reading.
type Steuerung struct {
	soll        *uint32
	sitzung     uint16
	herzschlag  uint16
	folge       [Plaetze]uint16
	zuletzt     [Plaetze]Wunsch
	lage        Lage
	letzte      *Lesung
	gelesenAt   time.Time
	urteil      Urteil
	telegramm   time.Time
	geschrieben []uint16
	test        *Test
	geaendert   bool
}

// Neu starts a controller's Koppelbild with a fresh session (1..65534). soll
// is the expected controller id (steuerung_kennung of the image's version);
// without it the box never writes.
func Neu(soll *uint32, sitzung uint16) *Steuerung {
	if sitzung == 0 || sitzung == 0xFFFF {
		sitzung = 1
	}
	s := &Steuerung{sitzung: sitzung}
	s.SetzeSoll(soll)
	return s
}

// SetzeSoll changes the expected controller id (a new version of the image).
func (s *Steuerung) SetzeSoll(soll *uint32) {
	if soll == nil {
		s.soll = nil
		return
	}
	v := *soll
	s.soll = &v
}

// Lies takes one reading of the acknowledgement; q nil is "no answer".
func (s *Steuerung) Lies(q []uint16, jetzt time.Time) Urteil {
	if s.soll == nil {
		s.letzte, s.urteil = nil, Urteil{Lage: LageOhneSoll}
		return s.urteil
	}
	if q == nil {
		s.letzte = nil
		s.urteil = s.lage.Nach(nil)
		return s.urteil
	}
	l := Lies(q, *s.soll)
	s.urteil = s.lage.Nach(&l)
	if l.Lesbar() {
		s.letzte, s.gelesenAt = &l, jetzt
	} else {
		s.letzte = &l
	}
	return s.urteil
}

// Urteil is the judgement of the last reading.
func (s *Steuerung) Urteil() Urteil { return s.urteil }

// SetzeTest starts (or replaces) a Schalt-Test; nil ends it.
func (s *Steuerung) SetzeTest(t *Test) {
	s.test = t
	s.geaendert = true
}

// Geaendert marks that the wishes changed: the next telegram may go at once.
func (s *Steuerung) Geaendert() { s.geaendert = true }

// Faellig reports whether a telegram is due: every Takt, on a change at once
// but never closer than MinAbstand.
func (s *Steuerung) Faellig(jetzt time.Time) bool {
	if s.telegramm.IsZero() {
		return true
	}
	seit := jetzt.Sub(s.telegramm)
	// a tenth of slack: the 5 s reading tick jitters, a telegram must not
	// skip a whole tick for a few milliseconds
	return seit >= Takt-Takt/10 || (s.geaendert && seit >= MinAbstand)
}

// Eilig reports a changed wish whose telegram may go now, before the next
// regular tick.
func (s *Steuerung) Eilig(jetzt time.Time) bool {
	return s.geaendert && !s.telegramm.IsZero() && jetzt.Sub(s.telegramm) >= MinAbstand
}

// Abstand is how long until a telegram may go at the earliest.
func (s *Steuerung) Abstand(jetzt time.Time) time.Duration {
	if s.telegramm.IsZero() {
		return 0
	}
	if d := MinAbstand - jetzt.Sub(s.telegramm); d > 0 {
		return d
	}
	return 0
}

// Telegramm builds the next telegram, or nil when the last reading does not
// allow writing (contract §10). wuensche are the arbiter's wishes per
// Stellplatz; frei is the box's two-gate posture for this controller; ebits
// the edge's state (cloud_verbunden, plan_frisch). A wish goes only onto a
// Stellplatz whose offer has the same kind in the last reading.
func (s *Steuerung) Telegramm(wuensche map[int]Wunsch, frei bool, ebits []string, jetzt time.Time) []uint16 {
	if s.soll == nil || !s.urteil.Schreibt || s.letzte == nil || !s.letzte.Lesbar() {
		return nil
	}
	if s.test != nil && !jetzt.Before(s.test.Bis) {
		s.test = nil
	}
	a := Absicht{Sitzung: s.sitzung, Herzschlag: s.herzschlag, SteuerungID: *s.soll, FristS: FristS,
		Plaetze: map[int]PlatzWunsch{}}
	a.EBits = append(a.EBits, ebits...)
	if frei {
		a.EBits = append(a.EBits, "steuerung_frei")
	}
	if s.test != nil {
		a.EBits = append(a.EBits, "probe")
		rest := int(math.Ceil(s.test.Bis.Sub(jetzt).Seconds()))
		if rest < FristMinS {
			rest = FristMinS
		}
		if rest < FristS {
			a.FristS = uint16(rest)
		}
	}
	for n := 1; n <= Plaetze; n++ {
		var w Wunsch
		switch {
		case s.test != nil && s.test.Platz == n:
			w = Wunsch{Art: s.test.Art, Wert: s.test.Wert, Grund: "test"}
		case frei && s.urteil.Wuenscht:
			if x, da := wuensche[n]; da && s.angeboten(n, x.Art) {
				w = x
			}
		}
		if w.Art == "" {
			w.Art = "keiner"
		}
		alt := s.zuletzt[n-1]
		if alt.Art == "" {
			alt.Art = "keiner"
		}
		if w.Art != alt.Art || (w.Art != "keiner" && w.Wert != alt.Wert) {
			s.folge[n-1]++
		}
		s.zuletzt[n-1] = w
		a.Plaetze[n] = PlatzWunsch{Art: w.Art, Grund: w.Grund, Wert: w.Wert, Folge: s.folge[n-1]}
	}
	t := Schreibe(a)
	s.herzschlag++
	s.telegramm = jetzt
	s.geaendert = false
	s.geschrieben = t
	s.lage.Schrieb(s.sitzung)
	return t
}

func (s *Steuerung) angeboten(n int, art string) bool {
	if s.letzte == nil || !s.letzte.Lesbar() || n < 1 || n > len(s.letzte.Plaetze) {
		return false
	}
	a := s.letzte.Plaetze[n-1].Angebot
	return a != nil && a.Art == art
}

// Angebot is the offer of Stellplatz n in the last readable reading.
func (s *Steuerung) Angebot(n int) *Angebot {
	if s.letzte == nil || !s.letzte.Lesbar() || n < 1 || n > len(s.letzte.Plaetze) {
		return nil
	}
	return s.letzte.Plaetze[n-1].Angebot
}

// Platz is Stellplatz n of the last readable reading, nil without one.
func (s *Steuerung) Platz(n int) *Platz {
	if s.letzte == nil || !s.letzte.Lesbar() || n < 1 || n > len(s.letzte.Plaetze) {
		return nil
	}
	p := s.letzte.Plaetze[n-1]
	return &p
}

// Folge is the Folge last written on Stellplatz n.
func (s *Steuerung) Folge(n int) uint16 {
	if n < 1 || n > Plaetze {
		return 0
	}
	return s.folge[n-1]
}

// PlatzStand is one Stellplatz in the box's status block.
type PlatzStand struct {
	Platz   int          `json:"platz"`
	Angebot *Angebot     `json:"angebot"`
	Wunsch  *PlatzWunsch `json:"wunsch"`
	Test    bool         `json:"test,omitempty"`
	Urteil  *string      `json:"urteil"`
	Folge   uint16       `json:"folge"`
	Wirksam *int32       `json:"wirksam"`
}

// Stand is one controller in the heartbeat block `koppel` (contract §15).
// Display only: the cloud never feeds it back into the desired state.
type Stand struct {
	Steuerung         string       `json:"steuerung"`
	DataSourceID      string       `json:"data_source_id,omitempty"`
	Lage              string       `json:"lage"`
	Grund             string       `json:"grund,omitempty"`
	GelesenAt         *time.Time   `json:"gelesen_at"`
	Bibliothek        *string      `json:"bibliothek"`
	KopfUrteil        *string      `json:"kopf_urteil"`
	RestS             *uint16      `json:"rest_s"`
	QBits             []string     `json:"q_bits"`
	AngenommenZaehler *uint16      `json:"angenommen_zaehler"`
	AbgelehntZaehler  *uint16      `json:"abgelehnt_zaehler"`
	Plaetze           []PlatzStand `json:"plaetze"`
}

// Stand is the controller's status for the heartbeat.
func (s *Steuerung) Stand() Stand {
	st := Stand{Lage: s.urteil.Lage, Plaetze: []PlatzStand{}}
	if st.Lage == "" {
		st.Lage = LageKeineAntwort
	}
	if s.letzte != nil && !s.letzte.Lesbar() {
		st.Grund = s.letzte.Grund
	}
	if s.letzte != nil && s.letzte.Lesbar() {
		if s.letzte.Grund != "" {
			st.Grund = s.letzte.Grund
		}
		k := s.letzte.Kopf
		g := s.gelesenAt.UTC()
		st.GelesenAt = &g
		if k.Bibliothek != nil {
			b := strconv.Itoa(k.Bibliothek.Haupt) + "." + strconv.Itoa(k.Bibliothek.Neben)
			st.Bibliothek = &b
		}
		st.KopfUrteil, st.RestS, st.QBits = k.KopfUrteil, k.RestS, k.QBits
		an, ab := k.AngenommenZaehler, k.AbgelehntZaehler
		st.AngenommenZaehler, st.AbgelehntZaehler = &an, &ab
	}
	for n := 1; n <= Plaetze; n++ {
		ps := PlatzStand{Platz: n}
		if w := s.zuletzt[n-1]; w.Art != "" && w.Art != "keiner" {
			ps.Wunsch = &PlatzWunsch{Art: w.Art, Grund: w.Grund, Wert: w.Wert, Folge: s.folge[n-1]}
			ps.Test = w.Grund == "test"
		}
		if p := s.Platz(n); p != nil {
			ps.Angebot, ps.Urteil, ps.Wirksam = p.Angebot, p.QUrteil, p.QWirksam
			ps.Folge = p.QFolge
		}
		if ps.Angebot != nil || ps.Wunsch != nil || (ps.Urteil != nil && *ps.Urteil != "kein_wunsch") {
			st.Plaetze = append(st.Plaetze, ps)
		}
	}
	return st
}
