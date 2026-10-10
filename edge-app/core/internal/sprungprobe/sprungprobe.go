// Package sprungprobe is the box half of the Sprungprobe of a Gemeinsame
// Steuerung (UEMS AP-15 IP-21, Kasten E3 = A, T5; contract
// docs/contracts/v2/mqtt-sprungprobe.md §2/§3): a bounded, LOWERING jump of ONE
// of the box's own set values, twice, then back - and a report of what the box
// itself measured. The cloud judges the jump against the grid meter of the
// leading box; the box never judges (uems/SprungprobeRegel is not twinned here).
//
// It is a limited probe executor (§6.3): no new write path to a device, no new
// register release, no change to the arbitration. The probe only ever adds a
// CEILING that the agent composes most-restrictive-wins into the final
// setpoint (Kappe, Laden) - it can never widen anything the plan, a share or a
// watchdog allows. Every own watchdog stands above it: the moment one
// intervenes, the probe is aborted and the ceiling is gone on the same tick.
//
// Pure: no clock, no bus, no MQTT. The agent feeds it the tick time and what it
// observed (Lage) and gets the ceiling back (Wunsch).
package sprungprobe

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

// Bounds of an order (named constants of the contract; the cloud sends 50 kW,
// 60 s, twice, 60 s pause at most). An order outside them is not run.
const (
	MaxSprungKw       = 50.0
	MaxDauerS         = 60
	MinWiederholungen = 2
	MaxWiederholungen = 3
	MaxPauseS         = 120
	// EinschwingenS: the own measurement "during" starts this long after the
	// jump - the same settling window the cloud evaluates the grid meter with.
	EinschwingenS = 20
	// NachlaufS: after the last jump the box waits this long before it
	// reports, so the grid meter's telemetry has reached the cloud.
	NachlaufS = 30
	// MinStellgroesseKw: below this there is nothing to lower - the probe does
	// not start (keine_stellgroesse) instead of pretending a jump.
	MinStellgroesseKw = 1.0
)

// Art is what the probe lowers - always the safe direction (§5.3).
type Art string

const (
	// ErzeugungSenken caps the plant's PV below what it produces now.
	ErzeugungSenken Art = "erzeugung_senken"
	// VerbrauchSenken takes back the battery's charge below what it takes now.
	VerbrauchSenken Art = "verbrauch_senken"
)

// Stellgroesse names the set value in the report.
func (a Art) Stellgroesse() string {
	if a == ErzeugungSenken {
		return "pv_kappe"
	}
	return "batterie_laden"
}

// Abort reasons (closed vocabulary shared with the cloud,
// SprungprobeRegel.GRUENDE_ABGEBROCHEN).
const (
	Einspeisewaechter = "einspeisewaechter"
	Bezugswaechter    = "bezugswaechter"
	Eingefroren       = "eingefroren"
	Geraeteschutz     = "geraeteschutz"
	RegelungAus       = "regelung_aus"
	KeineStellgroesse = "keine_stellgroesse"
	Abgelaufen        = "abgelaufen"
	Neustart          = "neustart"
)

// Identitaet is the box's own identity; an order for another box is not read
// (topic and payload identity, like the share document - T4).
type Identitaet struct{ Mandant, Anlage, Box string }

// ErrNichtIhres: the order names another tenant, site or box.
var ErrNichtIhres = errors.New("sprungprobe: order for another box")

// Auftrag is the order on .../v2/sprungprobe (contract §2).
type Auftrag struct {
	SchemaVersion  string    `json:"schema_version"`
	TenantID       string    `json:"tenant_id"`
	SiteID         string    `json:"site_id"`
	DeviceID       string    `json:"device_id"`
	ProbeID        string    `json:"probe_id"`
	Art            Art       `json:"art"`
	SprungKw       float64   `json:"sprung_kw"`
	DauerS         int       `json:"dauer_s"`
	Wiederholungen int       `json:"wiederholungen"`
	PauseS         int       `json:"pause_s"`
	GueltigBis     time.Time `json:"gueltig_bis"`
	Ts             time.Time `json:"ts"`
}

// Lesen reads and checks one order: identity first (another box's order is
// ErrNichtIhres and silently ignored by the caller), then every bound.
func Lesen(own Identitaet, payload []byte) (Auftrag, error) {
	var a Auftrag
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return Auftrag{}, fmt.Errorf("sprungprobe: unreadable order: %w", err)
	}
	if a.TenantID != own.Mandant || a.SiteID != own.Anlage || a.DeviceID != own.Box || own.Box == "" {
		return Auftrag{}, ErrNichtIhres
	}
	switch {
	case a.SchemaVersion != "1.0":
		return Auftrag{}, fmt.Errorf("sprungprobe: schema_version %q", a.SchemaVersion)
	case a.ProbeID == "":
		return Auftrag{}, errors.New("sprungprobe: probe_id missing")
	case a.Art != ErzeugungSenken && a.Art != VerbrauchSenken:
		return Auftrag{}, fmt.Errorf("sprungprobe: art %q", a.Art)
	case !(a.SprungKw > 0) || a.SprungKw > MaxSprungKw:
		return Auftrag{}, fmt.Errorf("sprungprobe: sprung_kw %v outside (0, %v]", a.SprungKw, MaxSprungKw)
	case a.DauerS <= EinschwingenS || a.DauerS > MaxDauerS:
		return Auftrag{}, fmt.Errorf("sprungprobe: dauer_s %d outside (%d, %d]", a.DauerS, EinschwingenS, MaxDauerS)
	case a.Wiederholungen < MinWiederholungen || a.Wiederholungen > MaxWiederholungen:
		return Auftrag{}, fmt.Errorf("sprungprobe: wiederholungen %d", a.Wiederholungen)
	case a.PauseS < 0 || a.PauseS > MaxPauseS:
		return Auftrag{}, fmt.Errorf("sprungprobe: pause_s %d", a.PauseS)
	case a.GueltigBis.IsZero():
		return Auftrag{}, errors.New("sprungprobe: gueltig_bis missing")
	}
	return a, nil
}

// Lage is what the agent observed on THIS tick, before the probe acts.
type Lage struct {
	// IstKw is the own measurement of the set value, as a magnitude: the
	// plant's PV (erzeugung_senken) or the battery's charge
	// (verbrauch_senken). NaN = unknown - never a fabricated 0.
	IstKw float64
	// Waechter is the abort reason of an own watchdog that intervened on this
	// tick ("" = none). The probe never overrules one.
	Waechter string
	// RegelungAn: the setpoint is actually written (control enabled). Without
	// it a jump would be a report of nothing.
	RegelungAn bool
}

// Wunsch is the probe's ceiling on its set value for this tick: the plant's PV
// cap or the battery's charge (kW, >= 0). nil = the probe asks nothing - the
// set value is exactly what it would be without a probe.
type Wunsch struct {
	Art      Art
	DeckelKw *float64
}

// Sprung is one finished jump in the report: von/bis and the own measurement
// before and during (magnitudes; nil = unknown).
type Sprung struct {
	Von        time.Time `json:"von"`
	Bis        time.Time `json:"bis"`
	VorherKw   *float64  `json:"vorher_kw"`
	WaehrendKw *float64  `json:"waehrend_kw"`
}

// Bericht is the report on .../v2/sprungprobe-result (contract §3), without
// the identity fields the link adds.
type Bericht struct {
	ProbeID      string
	Art          Art
	Stellgroesse string
	Spruenge     []Sprung
	Abgebrochen  bool
	Grund        string
	Ts           time.Time
}

type phase int

const (
	phaseWarten phase = iota // first tick not seen yet
	phaseSprung
	phasePause
	phaseNachlauf
	phaseFertig
)

// Probe is one running order. Not safe for concurrent use; the agent holds it
// under its own lock.
type Probe struct {
	a        Auftrag
	phase    phase
	seit     time.Time // start of the current phase
	vorher   float64   // own measurement at the start of the current jump
	deckel   float64   // the jump's ceiling, anchored at its start
	samples  []float64 // own measurements from EinschwingenS until the jump's end
	spruenge []Sprung
	grund    string
	abbruch  bool
	ende     time.Time
}

// Neu starts an order received at now. An order past gueltig_bis is not run:
// it is finished at once, aborted with "abgelaufen".
func Neu(a Auftrag, now time.Time) *Probe {
	p := &Probe{a: a}
	if now.After(a.GueltigBis) {
		p.abbrechen(Abgelaufen, now)
	}
	return p
}

// Art is what the order lowers.
func (p *Probe) Art() Art { return p.a.Art }

// ProbeID is the order's id.
func (p *Probe) ProbeID() string { return p.a.ProbeID }

// Fertig: the probe asks nothing any more and its report is ready.
func (p *Probe) Fertig() bool { return p.phase == phaseFertig }

// Laeuft: a jump or the pause between two is in progress (the set value may
// be lowered now or on a later tick of this order).
func (p *Probe) Laeuft() bool { return p.phase == phaseSprung || p.phase == phasePause }

// Schritt advances the probe to now with what the agent observed and returns
// the ceiling for this tick. An own watchdog, control off, an unknown or too
// small set value, or an order running past its bound abort AT ONCE: the
// ceiling of the same tick is already nil - the set value is back.
func (p *Probe) Schritt(now time.Time, l Lage) Wunsch {
	if p.phase == phaseFertig {
		return Wunsch{Art: p.a.Art}
	}
	if p.phase != phaseNachlauf {
		if !l.RegelungAn {
			p.abbrechen(RegelungAus, now)
			return Wunsch{Art: p.a.Art}
		}
		if l.Waechter != "" {
			p.abbrechen(l.Waechter, now)
			return Wunsch{Art: p.a.Art}
		}
		if now.After(p.letzterZeitpunkt()) {
			p.abbrechen(Abgelaufen, now)
			return Wunsch{Art: p.a.Art}
		}
	}
	switch p.phase {
	case phaseWarten:
		if now.After(p.a.GueltigBis) {
			p.abbrechen(Abgelaufen, now)
			return Wunsch{Art: p.a.Art}
		}
		return p.springen(now, l)
	case phaseSprung:
		von := p.seit
		bis := von.Add(time.Duration(p.a.DauerS) * time.Second)
		if now.Before(bis) {
			if !now.Before(von.Add(EinschwingenS*time.Second)) && !math.IsNaN(l.IstKw) {
				p.samples = append(p.samples, math.Max(l.IstKw, 0))
			}
			return p.wunsch()
		}
		// the jump is over: back on THIS tick, report it with its nominal end
		p.spruenge = append(p.spruenge, Sprung{Von: von, Bis: bis, VorherKw: kw(p.vorher), WaehrendKw: mittel(p.samples)})
		if len(p.spruenge) >= p.a.Wiederholungen {
			p.phase, p.seit = phaseNachlauf, now
			return Wunsch{Art: p.a.Art}
		}
		p.phase, p.seit = phasePause, now
		return Wunsch{Art: p.a.Art}
	case phasePause:
		if now.Sub(p.seit) < time.Duration(p.a.PauseS)*time.Second {
			return Wunsch{Art: p.a.Art}
		}
		return p.springen(now, l)
	case phaseNachlauf:
		if now.Sub(p.seit) >= NachlaufS*time.Second {
			p.phase, p.ende = phaseFertig, now
		}
	}
	return Wunsch{Art: p.a.Art}
}

// springen starts a jump on this tick, anchored at the own measurement: the
// ceiling stays fixed for the whole jump (a ceiling that followed the falling
// value would ratchet down).
func (p *Probe) springen(now time.Time, l Lage) Wunsch {
	if math.IsNaN(l.IstKw) || l.IstKw < MinStellgroesseKw {
		p.abbrechen(KeineStellgroesse, now)
		return Wunsch{Art: p.a.Art}
	}
	p.phase, p.seit, p.samples = phaseSprung, now, nil
	p.vorher = l.IstKw
	p.deckel = math.Max(l.IstKw-p.a.SprungKw, 0)
	return p.wunsch()
}

func (p *Probe) wunsch() Wunsch {
	d := p.deckel
	return Wunsch{Art: p.a.Art, DeckelKw: &d}
}

// letzterZeitpunkt bounds the whole order: gueltig_bis to start, then every
// jump, pause and the run-out, plus one minute of slack for ticks.
func (p *Probe) letzterZeitpunkt() time.Time {
	d := time.Duration(p.a.Wiederholungen*p.a.DauerS+(p.a.Wiederholungen-1)*p.a.PauseS+NachlaufS+60) * time.Second
	return p.a.GueltigBis.Add(d)
}

// Abbrechen aborts a running probe with a verdict the agent forms AFTER
// Schritt on the same tick (the feed-in watchdog, control off). Only a jump,
// a pause or a not yet started probe is aborted; the run-out is not.
func (p *Probe) Abbrechen(now time.Time, grund string) {
	if p.phase == phaseWarten || p.phase == phaseSprung || p.phase == phasePause {
		p.abbrechen(grund, now)
	}
}

func (p *Probe) abbrechen(grund string, now time.Time) {
	p.phase, p.abbruch, p.grund, p.ende = phaseFertig, true, grund, now
}

// Bericht is the report of a finished probe; ok false while it runs.
// Only finished jumps are reported - an aborted one carries no measurement.
func (p *Probe) Bericht() (Bericht, bool) {
	if p.phase != phaseFertig {
		return Bericht{}, false
	}
	return Bericht{ProbeID: p.a.ProbeID, Art: p.a.Art, Stellgroesse: p.a.Art.Stellgroesse(),
		Spruenge: append([]Sprung(nil), p.spruenge...), Abgebrochen: p.abbruch, Grund: p.grund, Ts: p.ende}, true
}

// Kappe composes the probe's ceiling into the plant's PV cap: the minimum,
// never a widening. Without a ceiling (or for another set value) the cap is
// returned unchanged - the same pointer.
func Kappe(pvLimit *float64, w Wunsch) *float64 {
	if w.Art != ErzeugungSenken || w.DeckelKw == nil {
		return pvLimit
	}
	if pvLimit != nil && *pvLimit <= *w.DeckelKw {
		return pvLimit
	}
	v := *w.DeckelKw
	return &v
}

// Laden composes the probe's ceiling into the battery setpoint (+ charge,
// - discharge): it only ever lowers a CHARGE, never below 0 - a discharge or
// an idle battery is returned unchanged, and nothing is ever raised.
func Laden(kw float64, w Wunsch) float64 {
	if w.Art != VerbrauchSenken || w.DeckelKw == nil || kw <= *w.DeckelKw {
		return kw
	}
	return *w.DeckelKw
}

func kw(v float64) *float64 {
	if math.IsNaN(v) {
		return nil
	}
	x := math.Round(math.Max(v, 0)*1000) / 1000
	return &x
}

func mittel(s []float64) *float64 {
	if len(s) == 0 {
		return nil
	}
	sum := 0.0
	for _, v := range s {
		sum += v
	}
	return kw(sum / float64(len(s)))
}
