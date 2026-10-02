// Package ladepunktsim is the simulator of a BIDIRECTIONAL charge point with a
// vehicle behind it (MiSpeL MP-34, Bauplan § 8 Stufe B, Entscheid E3 = D:
// software depth first, V2H before V2G). It is the counterpart the later box
// work proves itself against: the pilot wallbox over its manufacturer
// interface (MP-40), the box's discharge command with protective limits
// (MP-39) and OCPP 2.0.1/2.1 (MP-35…MP-37). None of those live here.
//
// The vocabulary is the Festlegung's (BNetzA „MiSpeL“, Beschluss 01.10.2026,
// Anlage 1 = A1): charging is „Verbrauch im Ladepunkt“, feeding back is
// „Erzeugung im Ladepunkt“, whichever vehicle is plugged in (A1 S. 27,
// Abschn. 3.2.5). The simulated meter is Z2 at the charge point and reports
// both directions as separate registers, the way an OCPP meter does
// (Energy.Active.Import.Register / Energy.Active.Export.Register) - never one
// signed number, so charge and discharge cannot be swapped by a sign.
// Contract of the data model: docs/contracts/v2/mispel-ladepunkt-bidirektional.md.
//
// This file is the PURE model (no clock of its own, no I/O, no socket); the
// scenario runner is szenario.go. The discharge command is a TEST command of
// the rig, not a product path. Simulator evidence never replaces the hardware
// test bench (MP-42).
//
// Dev/rig tool. It is never part of a customer image.
package ladepunktsim

import (
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// Nutzbarkeit vocabulary, verbatim from the data model (MP-31) and A1 S. 7
// (Begriff „Ladepunkt“): „ausschließlich unidirektional nutzbar“ versus
// „bidirektional nutzbar“.
const (
	Unidirektional = "unidirektional"
	Bidirektional  = "bidirektional"
)

// WirkungsgradJeWeg is the default efficiency of ONE direction (charging or
// discharging), √0,85: the Festlegung fixes the round trip in a charge point
// at (14)A2,A3,A4 = 0,85 „mangels geeigneter Messwerte“ (A1 S. 35), and the
// optimizer (MP-33) splits it the same way. A full round trip in this
// simulator therefore reproduces (14) exactly; a vehicle with measured
// efficiencies sets its own.
var WirkungsgradJeWeg = math.Sqrt(0.85)

// Faehigkeit is what the wallbox can do technically - the simulator side of
// the data model's `faehigkeit` (MP-31 § 2). V2H means feeding the house
// only: the box never pushes vehicle energy into the grid, so its discharge
// is capped at the house's own deficit at that moment. V2G lifts the cap.
type Faehigkeit struct {
	Nutzbarkeit string
	V2H, V2G    bool
	// LadeleistungKw is the wallbox's highest charging power (> 0).
	LadeleistungKw float64
	// RueckspeiseleistungKw is its highest feed-back power; > 0 exactly when
	// bidirectional (the simulator cannot run an unknown limit).
	RueckspeiseleistungKw float64
}

// Pruefen checks the shape with the data model's rules (MP-31 § 2): a
// unidirectional point carries no feed-back data at all; a bidirectional one
// names at least one of V2H/V2G.
func (f Faehigkeit) Pruefen() error {
	if !(f.LadeleistungKw > 0) {
		return errors.New("ladeleistung_kw muss über 0 liegen")
	}
	switch f.Nutzbarkeit {
	case Unidirektional:
		if f.V2H || f.V2G || f.RueckspeiseleistungKw != 0 {
			return errors.New("unidirektional: keine Angaben zur Rückspeisung (MP-31 grund angaben_ohne_rueckspeisung)")
		}
	case Bidirektional:
		if !f.V2H && !f.V2G {
			return errors.New("bidirektional: mindestens V2H oder V2G (A1 S. 26 Fn. 21)")
		}
		if !(f.RueckspeiseleistungKw > 0) {
			return errors.New("bidirektional: rueckspeiseleistung_kw muss über 0 liegen")
		}
	default:
		return fmt.Errorf("nutzbarkeit %q unbekannt (unidirektional|bidirektional)", f.Nutzbarkeit)
	}
	return nil
}

// Fahrzeug is the vehicle behind the plug. The data model gives a vehicle no
// identity of its own (A1 S. 27); here it is only the physics.
type Fahrzeug struct {
	// KapazitaetKwh is the usable capacity (> 0).
	KapazitaetKwh float64
	// SocPct is the state of charge now, 0..100.
	SocPct float64
	// MindestSocPct is the reserve: discharging never goes below it.
	MindestSocPct float64
	// AbfahrtSocPct is the departure target; 0 = not said. Checked, not
	// enforced: reaching it is the planner's job (MP-33), the simulator only
	// records at unplugging whether it was reached.
	AbfahrtSocPct float64
	// MaxLadeKw / MaxEntladeKw are the vehicle's own limits at the AC side
	// (> 0); the wallbox's limits apply on top.
	MaxLadeKw, MaxEntladeKw float64
	// WirkungsgradLaden / WirkungsgradEntladen, 0 = WirkungsgradJeWeg.
	WirkungsgradLaden, WirkungsgradEntladen float64
}

func (v Fahrzeug) pruefen() error {
	switch {
	case !(v.KapazitaetKwh > 0):
		return errors.New("kapazitaet_kwh muss über 0 liegen")
	case v.SocPct < 0 || v.SocPct > 100:
		return errors.New("soc_pct außerhalb 0..100")
	case v.MindestSocPct < 0 || v.MindestSocPct > 100:
		return errors.New("mindest_soc_pct außerhalb 0..100")
	case v.AbfahrtSocPct != 0 && (v.AbfahrtSocPct < v.MindestSocPct || v.AbfahrtSocPct > 100):
		return errors.New("abfahrt_soc_pct nicht unter mindest_soc_pct und höchstens 100 (MP-31 grund abfahrt_soc)")
	case !(v.MaxLadeKw > 0) || !(v.MaxEntladeKw > 0):
		return errors.New("max_lade_kw und max_entlade_kw müssen über 0 liegen")
	case v.WirkungsgradLaden < 0 || v.WirkungsgradLaden > 1 || v.WirkungsgradEntladen < 0 || v.WirkungsgradEntladen > 1:
		return errors.New("wirkungsgrad außerhalb 0..1")
	}
	return nil
}

func (v Fahrzeug) etaLaden() float64 {
	if v.WirkungsgradLaden > 0 {
		return v.WirkungsgradLaden
	}
	return WirkungsgradJeWeg
}

func (v Fahrzeug) etaEntladen() float64 {
	if v.WirkungsgradEntladen > 0 {
		return v.WirkungsgradEntladen
	}
	return WirkungsgradJeWeg
}

// Richtung of a command - explicit words instead of a signed setpoint.
type Richtung string

const (
	Halt     Richtung = "halt"
	Laden    Richtung = "laden"
	Entladen Richtung = "entladen"
)

// Befehl is the rig's TEST command to the wallbox. It is a wish, not an
// effect: what the box then does is the Schritt result and the meter.
type Befehl struct {
	Richtung Richtung
	// LeistungKw is the wished power at the meter (AC side), >= 0.
	LeistungKw float64
	// BisSocPct ends the command at this state of charge (charging: up to,
	// discharging: down to - never below the vehicle's reserve). 0 = no end
	// of its own (charging stops at 100 %, discharging at the reserve).
	BisSocPct float64
}

// Umgebung is the rest of the site in the same moment, without the charge
// point: sonstiger Verbrauch and sonstige Erzeugung behind the grid meter Z1.
// The wallbox needs it only for one thing - a V2H-only box must not push
// vehicle energy into the grid.
type Umgebung struct {
	HauslastKw  float64
	ErzeugungKw float64
}

// Why a command was not executed verbatim. Unknown is not zero: an unplugged
// point says `abgesteckt`, it does not pretend to have charged 0 kW on
// purpose.
const (
	GrundAbgesteckt      = "abgesteckt"
	GrundUnidirektional  = "unidirektional"
	GrundLeistungsgrenze = "leistungsgrenze"
	GrundNurHaus         = "nur_haus"
	GrundMindestSoc      = "mindest_soc"
	GrundZielErreicht    = "ziel_erreicht"
	GrundVoll            = "voll"
)

// Schritt is what happened in one simulated interval.
type Schritt struct {
	Von, Bis time.Time
	Befehl   Befehl
	// VerbrauchKwh / ErzeugungKwh are this interval's „Verbrauch im
	// Ladepunkt“ and „Erzeugung im Ladepunkt“ at the meter (A1 S. 27); at most
	// one of them is non-zero.
	VerbrauchKwh, ErzeugungKwh float64
	// Abweichung: the command was not executed verbatim, Grund says why.
	Abweichung bool
	Grund      string
}

// LeistungKw is the interval's mean power at the meter, positive = charging
// (Verbrauch im Ladepunkt), negative = feeding back (Erzeugung im Ladepunkt).
// Only for the scenario's grid balance - the meter itself is unsigned.
func (s Schritt) LeistungKw() float64 {
	h := s.Bis.Sub(s.Von).Hours()
	if h <= 0 {
		return 0
	}
	return (s.VerbrauchKwh - s.ErzeugungKwh) / h
}

// Messung is what the charge point reports, named after the OCPP measurands
// of the measurement catalog (catalog/measurement-points, source ocpp).
type Messung struct {
	Zeit       time.Time
	Angesteckt bool
	// SocPct is the vehicle's state of charge (SoC); nil when unplugged -
	// unknown, never 0.
	SocPct *float64
	// LeistungBezugKw is Power.Active.Import (charging), LeistungRueckspeisungKw
	// Power.Active.Export (feeding back), both >= 0, mean of the last interval.
	LeistungBezugKw, LeistungRueckspeisungKw float64
	// ZaehlerVerbrauchKwh is Energy.Active.Import.Register - the Z2V side of
	// Z2 at the charge point; ZaehlerErzeugungKwh is
	// Energy.Active.Export.Register - the Z2E side (A1 S. 32, Abschn. 4.2.1).
	// Both only ever grow.
	ZaehlerVerbrauchKwh, ZaehlerErzeugungKwh float64
}

// Abfahrt is recorded at every unplugging.
type Abfahrt struct {
	Zeit   time.Time
	SocPct float64
	// ZielPct is the vehicle's AbfahrtSocPct (0 = none was said); Erreicht is
	// false only when a target was said and missed.
	ZielPct  float64
	Erreicht bool
}

// Ladepunkt is one simulated bidirectional (or unidirectional) wallbox.
type Ladepunkt struct {
	mu        sync.Mutex
	f         Faehigkeit
	jetzt     time.Time
	fahrzeug  *Fahrzeug
	befehl    Befehl
	zaehlerV  float64
	zaehlerE  float64
	letzter   Schritt
	abfahrten []Abfahrt
}

// New builds a wallbox with no vehicle, its meter at 0 kWh, at time start.
func New(f Faehigkeit, start time.Time) (*Ladepunkt, error) {
	if err := f.Pruefen(); err != nil {
		return nil, err
	}
	return &Ladepunkt{f: f, jetzt: start, befehl: Befehl{Richtung: Halt}}, nil
}

// Faehigkeit returns the configuration.
func (l *Ladepunkt) Faehigkeit() Faehigkeit { return l.f }

// Anstecken plugs a vehicle in. The point starts in Halt: a fresh vehicle
// never inherits an older command.
func (l *Ladepunkt) Anstecken(v Fahrzeug) error {
	if err := v.pruefen(); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fahrzeug != nil {
		return errors.New("schon angesteckt")
	}
	l.fahrzeug = &v
	l.befehl = Befehl{Richtung: Halt}
	return nil
}

// Abstecken unplugs. Power stops at once and the held command is dropped -
// the physical fact behind the box's „sofortiger Abbruch beim Abstecken“
// (MP-39); a re-plugged vehicle does not resume. It returns the vehicle as it
// leaves and records the departure.
func (l *Ladepunkt) Abstecken() (Fahrzeug, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fahrzeug == nil {
		return Fahrzeug{}, errors.New("nicht angesteckt")
	}
	v := *l.fahrzeug
	l.fahrzeug = nil
	l.befehl = Befehl{Richtung: Halt}
	l.letzter = Schritt{Von: l.jetzt, Bis: l.jetzt, Befehl: l.befehl}
	l.abfahrten = append(l.abfahrten, Abfahrt{
		Zeit: l.jetzt, SocPct: v.SocPct, ZielPct: v.AbfahrtSocPct,
		Erreicht: v.AbfahrtSocPct == 0 || v.SocPct >= v.AbfahrtSocPct-socToleranz,
	})
	return v, nil
}

// Befehlen hands the point a test command. It is accepted as a wish in every
// state; Schritt reports honestly what came of it.
func (l *Ladepunkt) Befehlen(b Befehl) error {
	switch b.Richtung {
	case Halt, Laden, Entladen:
	default:
		return fmt.Errorf("richtung %q unbekannt (halt|laden|entladen)", b.Richtung)
	}
	if b.LeistungKw < 0 || math.IsNaN(b.LeistungKw) || b.BisSocPct < 0 || b.BisSocPct > 100 {
		return errors.New("leistung_kw >= 0 und bis_soc_pct 0..100")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.befehl = b
	return nil
}

// socToleranz absorbs float noise at a limit (in percentage points).
const socToleranz = 1e-9

// Schritt advances the point by dt with the site around it as given and
// executes the held command within every limit: plug, capability, wallbox
// and vehicle power, the V2H cap, reserve, target and full battery. A limit
// reached inside the interval ends the flow exactly there.
func (l *Ladepunkt) Schritt(dt time.Duration, u Umgebung) Schritt {
	l.mu.Lock()
	defer l.mu.Unlock()
	von := l.jetzt
	l.jetzt = l.jetzt.Add(dt)
	s := Schritt{Von: von, Bis: l.jetzt, Befehl: l.befehl}
	h := dt.Hours()
	b := l.befehl
	if h <= 0 || b.Richtung == Halt || b.LeistungKw <= 0 {
		l.letzter = s
		return s
	}
	v := l.fahrzeug
	if v == nil {
		s.Abweichung, s.Grund = true, GrundAbgesteckt
		l.letzter = s
		return s
	}
	kwh := v.KapazitaetKwh
	switch b.Richtung {
	case Laden:
		p, grund := b.LeistungKw, ""
		if grenze := math.Min(l.f.LadeleistungKw, v.MaxLadeKw); p > grenze {
			p, grund = grenze, GrundLeistungsgrenze
		}
		ziel, zielGrund := 100.0, GrundVoll
		if b.BisSocPct > 0 && b.BisSocPct < 100 {
			ziel, zielGrund = b.BisSocPct, GrundZielErreicht
		}
		raumKwh := math.Max(0, (ziel-v.SocPct)/100*kwh) / v.etaLaden() // at the meter
		if e := p * h; e < raumKwh {
			v.SocPct += e * v.etaLaden() / kwh * 100
			s.VerbrauchKwh = e
		} else {
			if raumKwh > 0 {
				v.SocPct = ziel // land exactly on the limit
			}
			s.VerbrauchKwh, grund = raumKwh, zielGrund
		}
		s.Abweichung, s.Grund = grund != "", grund
		l.zaehlerV += s.VerbrauchKwh
	case Entladen:
		if l.f.Nutzbarkeit != Bidirektional {
			s.Abweichung, s.Grund = true, GrundUnidirektional
			break
		}
		p, grund := b.LeistungKw, ""
		if grenze := math.Min(l.f.RueckspeiseleistungKw, v.MaxEntladeKw); p > grenze {
			p, grund = grenze, GrundLeistungsgrenze
		}
		if !l.f.V2G {
			// V2H only: feed the house's deficit, never the grid.
			if defizit := math.Max(0, u.HauslastKw-u.ErzeugungKw); p > defizit {
				p, grund = defizit, GrundNurHaus
			}
		}
		boden, bodenGrund := v.MindestSocPct, GrundMindestSoc
		if b.BisSocPct > v.MindestSocPct {
			boden, bodenGrund = b.BisSocPct, GrundZielErreicht
		}
		vorratKwh := math.Max(0, (v.SocPct-boden)/100*kwh) * v.etaEntladen() // at the meter
		if e := p * h; e < vorratKwh {
			v.SocPct -= e / v.etaEntladen() / kwh * 100
			s.ErzeugungKwh = e
		} else {
			if vorratKwh > 0 {
				v.SocPct = boden
			}
			s.ErzeugungKwh, grund = vorratKwh, bodenGrund
		}
		s.Abweichung, s.Grund = grund != "", grund
		l.zaehlerE += s.ErzeugungKwh
	}
	l.letzter = s
	return s
}

// Messung is the point's report now.
func (l *Ladepunkt) Messung() Messung {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := Messung{
		Zeit:                l.jetzt,
		Angesteckt:          l.fahrzeug != nil,
		ZaehlerVerbrauchKwh: l.zaehlerV,
		ZaehlerErzeugungKwh: l.zaehlerE,
	}
	if l.fahrzeug != nil {
		soc := l.fahrzeug.SocPct
		m.SocPct = &soc
	}
	if h := l.letzter.Bis.Sub(l.letzter.Von).Hours(); h > 0 {
		m.LeistungBezugKw = l.letzter.VerbrauchKwh / h
		m.LeistungRueckspeisungKw = l.letzter.ErzeugungKwh / h
	}
	return m
}

// Abfahrten lists every recorded departure, oldest first.
func (l *Ladepunkt) Abfahrten() []Abfahrt {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Abfahrt(nil), l.abfahrten...)
}
