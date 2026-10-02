package ladepunktsim

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Anwesenheit is one stay of a vehicle at the point, half-open
// [Ankunft, Abfahrt) like the data model's window (MP-31 § 5). Fahrzeug is
// its state on arrival - a vehicle that charged elsewhere brings that energy
// along (A1 S. 16, Abschn. 2.1.6 „Fremdtankstrom“).
type Anwesenheit struct {
	Ankunft, Abfahrt time.Time
	Fahrzeug         Fahrzeug
}

// Regler is the scenario's TEST controller: the command for the interval
// starting at t, given the point's report at t. It is not the box's control
// with protective limits (MP-39).
type Regler func(t time.Time, m Messung) Befehl

// Lauf is one deterministic scenario run.
type Lauf struct {
	Name       string
	Start      time.Time // on a quarter-hour
	Ende       time.Time
	Takt       time.Duration // divides 15 min
	Faehigkeit Faehigkeit
	// Anwesenheiten on the Takt grid, in order, not overlapping.
	Anwesenheiten []Anwesenheit
	// Umgebung is the rest of the site at t, without the charge point.
	Umgebung func(t time.Time) Umgebung
	Regler   Regler
}

// Viertelstunde carries the quarter-hour values the Festlegung computes with
// (A1 S. 32, Abschn. 4.2.1): Z2V¼/Z2E¼ „Verbrauch/Erzeugung im … Ladepunkt“
// from the point's registers, Z1NB¼/Z1NE¼ „Netzbezug/Netzeinspeisung“ of the
// whole site including the point (balanced per Takt).
type Viertelstunde struct {
	Von                  time.Time
	Z2V, Z2E, Z1NB, Z1NE float64 // kWh
	// SocPct at the end of the quarter, nil when no vehicle is plugged in.
	SocPct *float64
}

// Ergebnis of a run.
type Ergebnis struct {
	Viertelstunden []Viertelstunde
	Schritte       []Schritt
	Abfahrten      []Abfahrt
	Ende           Messung
}

// Summe adds up the quarter-hours: the period's Z2V, Z2E, Z1NB, Z1NE.
func (e Ergebnis) Summe() (z2v, z2e, z1nb, z1ne float64) {
	for _, q := range e.Viertelstunden {
		z2v += q.Z2V
		z2e += q.Z2E
		z1nb += q.Z1NB
		z1ne += q.Z1NE
	}
	return
}

// Fahren runs the scenario from Start to Ende.
func (r Lauf) Fahren() (Ergebnis, error) {
	const viertel = 15 * time.Minute
	switch {
	case r.Takt <= 0 || viertel%r.Takt != 0:
		return Ergebnis{}, errors.New("takt muss 15 min teilen")
	case !r.Ende.After(r.Start) || !r.Start.Truncate(viertel).Equal(r.Start) || !r.Ende.Truncate(viertel).Equal(r.Ende):
		return Ergebnis{}, errors.New("start und ende auf Viertelstunden, ende nach start")
	case r.Umgebung == nil || r.Regler == nil:
		return Ergebnis{}, errors.New("umgebung und regler fehlen")
	}
	vorher := r.Start
	for i, a := range r.Anwesenheiten {
		if a.Ankunft.Before(vorher) || !a.Abfahrt.After(a.Ankunft) ||
			a.Ankunft.Sub(r.Start)%r.Takt != 0 || a.Abfahrt.Sub(r.Start)%r.Takt != 0 {
			return Ergebnis{}, fmt.Errorf("anwesenheit %d: im Takt, in Reihenfolge, ohne Überschneidung", i)
		}
		vorher = a.Abfahrt
	}
	lp, err := New(r.Faehigkeit, r.Start)
	if err != nil {
		return Ergebnis{}, err
	}
	var erg Ergebnis
	var q Viertelstunde
	q.Von = r.Start
	for t := r.Start; t.Before(r.Ende); t = t.Add(r.Takt) {
		for _, a := range r.Anwesenheiten {
			if a.Abfahrt.Equal(t) {
				if _, err := lp.Abstecken(); err != nil {
					return Ergebnis{}, err
				}
			}
		}
		for _, a := range r.Anwesenheiten {
			if a.Ankunft.Equal(t) {
				if err := lp.Anstecken(a.Fahrzeug); err != nil {
					return Ergebnis{}, err
				}
			}
		}
		if err := lp.Befehlen(r.Regler(t, lp.Messung())); err != nil {
			return Ergebnis{}, err
		}
		u := r.Umgebung(t)
		s := lp.Schritt(r.Takt, u)
		erg.Schritte = append(erg.Schritte, s)
		netz := (u.HauslastKw-u.ErzeugungKw)*r.Takt.Hours() + s.VerbrauchKwh - s.ErzeugungKwh
		q.Z2V += s.VerbrauchKwh
		q.Z2E += s.ErzeugungKwh
		q.Z1NB += math.Max(0, netz)
		q.Z1NE += math.Max(0, -netz)
		if next := t.Add(r.Takt); next.Sub(q.Von) == viertel {
			q.SocPct = lp.Messung().SocPct
			erg.Viertelstunden = append(erg.Viertelstunden, q)
			q = Viertelstunde{Von: next}
		}
	}
	erg.Abfahrten = lp.Abfahrten()
	erg.Ende = lp.Messung()
	return erg, nil
}

// V2HAbend is the MP-34 evidence scenario „V2H-Abend“ (Bauplan § 8): a car
// arrives at 18:00 with 60 %, feeds the house in the evening down to its
// reserve and charges at night to the departure target for 07:00.
//
// Fixed numbers, all of them stated here so the test can recompute them:
//   - wallbox bidirectional, V2H only (no V2G), 11 kW charging, 10 kW back;
//   - vehicle 60 kWh usable, reserve (Mindest-SoC) 40 %, target 80 %,
//     11 kW both ways, √0,85 each way ((14)A2,A3,A4 = 0,85, A1 S. 35);
//   - house (sonstiger Verbrauch) 2.5 kW 18–19, 3.5 kW 19–21, 2.0 kW 21–23,
//     0.5 kW 23–07; no generation after dark;
//   - test controller: from arrival until 23:00 „entladen 10 kW“ (the V2H box
//     follows the house), 23:00–01:00 halt, from 01:00 „laden 11 kW bis 80 %“.
//
// Day: Thursday 01.10.2026 → Friday 02.10.2026, local time CEST (UTC+2), one
// minute Takt.
func V2HAbend() Lauf {
	ort := time.FixedZone("CEST", 2*3600)
	tag := func(d, h, m int) time.Time { return time.Date(2026, 10, d, h, m, 0, 0, ort) }
	ankunft, abfahrt := tag(1, 18, 0), tag(2, 7, 0)
	nachtruhe, nachtladen := tag(1, 23, 0), tag(2, 1, 0)
	fz := Fahrzeug{
		KapazitaetKwh: 60, SocPct: 60, MindestSocPct: 40, AbfahrtSocPct: 80,
		MaxLadeKw: 11, MaxEntladeKw: 11,
	}
	return Lauf{
		Name:  "V2H-Abend",
		Start: ankunft, Ende: abfahrt.Add(15 * time.Minute),
		Takt: time.Minute,
		Faehigkeit: Faehigkeit{
			Nutzbarkeit: Bidirektional, V2H: true,
			LadeleistungKw: 11, RueckspeiseleistungKw: 10,
		},
		Anwesenheiten: []Anwesenheit{{Ankunft: ankunft, Abfahrt: abfahrt, Fahrzeug: fz}},
		Umgebung: func(t time.Time) Umgebung {
			switch h := t.Hour(); {
			case h == 18:
				return Umgebung{HauslastKw: 2.5}
			case h >= 19 && h < 21:
				return Umgebung{HauslastKw: 3.5}
			case h >= 21 && h < 23:
				return Umgebung{HauslastKw: 2.0}
			default:
				return Umgebung{HauslastKw: 0.5}
			}
		},
		Regler: func(t time.Time, m Messung) Befehl {
			switch {
			case !m.Angesteckt:
				return Befehl{Richtung: Halt}
			case t.Before(nachtruhe):
				return Befehl{Richtung: Entladen, LeistungKw: 10}
			case t.Before(nachtladen):
				return Befehl{Richtung: Halt}
			default:
				return Befehl{Richtung: Laden, LeistungKw: 11, BisSocPct: fz.AbfahrtSocPct}
			}
		},
	}
}
