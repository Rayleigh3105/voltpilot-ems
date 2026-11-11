// Package heizstab is the heating-rod CONTROLLER of the box (Heizstab-Konzept
// V1, decided 31.10.2026; contract docs/contracts/v2/heizstab-regler.md): it
// picks the stage of a heating rod (1, 2 or 3 phases) from the measured PV
// surplus, here on the box, every tick - without the cloud (HZ-7 = A) and
// without Node-RED (Edge Light has none).
//
// Why a controller of its own instead of the reactive rule flow: the rule
// compares a threshold with `pv - load` and does not see that the rod's own
// draw is part of the load - a running rod eats the very surplus that started
// it and the rule flutters. Here the rod's power is added back:
//
//	available = export (+ battery adjustments) + the rod's own power - reserve
//
// with the rod's power MEASURED, or else the kW of its CONFIRMED stage (what
// the Shelly reports, never what was asked).
//
// The order with the battery follows the portal's "Reihenfolge bei knapper
// Leistung" (HZ-6): below the battery = battery first (only what would really
// be exported, a discharge counts against the rod), above it = rod first (the
// battery's measured charge counts as available, a discharge still against).
// A battery discharging into the rod is never surplus.
//
// Timing (concept §3/§4, Flicker and relay wear): up only after the surplus
// held 60 s, one stage at a time, and not within the hold time after a change;
// down at once after 30 s of import > 0.1 kW, straight to the stage that fits;
// fully off only after the minimum run (at most that long on import); on again
// only after the minimum pause; a budget of switch operations per rolling hour
// (counted per output switched - conservative for every single output). A
// missing or stale measurement starts nothing and switches off after 60 s.
//
// The package is pure: Step folds one tick into the persisted State and says
// what stage the rod should run and why. The agent turns that into a
// rule-class wish for the arbiter, so every guard, the cycle guard, a manual
// "Jetzt heizen" and "Automatik pausieren" keep their say.
package heizstab

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

// Modes of the block. V1 knows one: PV surplus in stages.
const ModeSurplus = "ueberschuss"

// Order with the battery (HZ-6).
const (
	StorageFirst = "speicher_zuerst"
	RodFirst     = "heizstab_zuerst"
)

// Defaults of the block (concept §3 "Mindestzeiten").
const (
	DefaultReserveKw          = 0.2
	DefaultMinRunS            = 300
	DefaultMinPauseS          = 300
	DefaultHoldS              = 120
	DefaultSwitchesPerHour    = 12
	upAfter                   = 60 * time.Second
	downAfter                 = 30 * time.Second
	importThresholdKw         = 0.1
	measurementMaxAge         = 30 * time.Second
	blindOffAfter             = 60 * time.Second
	switchWindow              = time.Hour
	stageKwTolerance          = 1e-6
	maxRecordedSwitchesPerRod = 64
)

// Reason codes (machine words next to the German sentence).
const (
	CodeSurplus      = "ueberschuss"
	CodeNoSurplus    = "kein_ueberschuss"
	CodeWaitUp       = "ueberschuss_pruefen"
	CodeMinPause     = "mindestpause"
	CodeMinRun       = "mindestlauf"
	CodeHold         = "haltezeit"
	CodeSwitchBudget = "schaltgrenze"
	CodeBlind        = "messwerte_fehlen"
	CodeCap          = "hoechste_stufe"
	CodeNoStages     = "stufen_unbekannt"
)

// Params is the `heizstab` block of an entity descriptor (registry push),
// composed by the cloud from the customer's Steuerart.
type Params struct {
	Mode            string   `json:"modus"`
	ReserveKw       *float64 `json:"reserve_kw,omitempty"`
	MaxOutputs      int      `json:"hoechste_stufe,omitempty"`
	Order           string   `json:"vorrang,omitempty"`
	MinRunS         int      `json:"mindestlauf_s,omitempty"`
	MinPauseS       int      `json:"mindestpause_s,omitempty"`
	HoldS           int      `json:"haltezeit_s,omitempty"`
	SwitchesPerHour int      `json:"schaltungen_je_stunde,omitempty"`
}

// ParseParams reads the block; ok=false when it is absent or names no mode
// this box runs (then there is no controller - nothing is guessed).
func ParseParams(raw json.RawMessage) (Params, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Params{}, false, nil
	}
	var p Params
	if err := json.Unmarshal(raw, &p); err != nil {
		return Params{}, false, fmt.Errorf("heizstab: Block nicht lesbar: %w", err)
	}
	if p.Mode != ModeSurplus {
		return p, false, nil
	}
	if p.ReserveKw != nil && (math.IsNaN(*p.ReserveKw) || math.IsInf(*p.ReserveKw, 0) || *p.ReserveKw < 0) {
		return Params{}, false, fmt.Errorf("heizstab: reserve_kw muss >= 0 sein")
	}
	if p.MaxOutputs < 0 || p.MinRunS < 0 || p.MinPauseS < 0 || p.HoldS < 0 || p.SwitchesPerHour < 0 {
		return Params{}, false, fmt.Errorf("heizstab: negative Zeit oder Grenze")
	}
	switch p.Order {
	case "", StorageFirst, RodFirst:
	default:
		return Params{}, false, fmt.Errorf("heizstab: unbekannter vorrang %q", p.Order)
	}
	return p, true, nil
}

func (p Params) reserve() float64 {
	if p.ReserveKw == nil {
		return DefaultReserveKw
	}
	return *p.ReserveKw
}

func orDefault(v, d int) time.Duration {
	if v == 0 {
		v = d
	}
	return time.Duration(v) * time.Second
}

func (p Params) minRun() time.Duration   { return orDefault(p.MinRunS, DefaultMinRunS) }
func (p Params) minPause() time.Duration { return orDefault(p.MinPauseS, DefaultMinPauseS) }
func (p Params) hold() time.Duration     { return orDefault(p.HoldS, DefaultHoldS) }
func (p Params) switchBudget() int {
	if p.SwitchesPerHour == 0 {
		return DefaultSwitchesPerHour
	}
	return p.SwitchesPerHour
}

// Stage is one allowed stage of the rod: outputs on together and the most it
// draws (the driver's restrict-only ceiling).
type Stage struct {
	Outputs int     `json:"outputs"`
	Kw      float64 `json:"kw"`
}

// Inputs is one tick's view of the site.
type Inputs struct {
	Now time.Time
	// GridKw is the connection point, signed (+ import, - export), with the
	// time it was measured; nil = no reading.
	GridKw *float64
	GridAt time.Time
	// BatteryKw is the battery's measured power, signed (+ charging,
	// - discharging); nil = no reading (then the order collapses to the
	// measured status quo).
	BatteryKw *float64
	BatteryAt time.Time
	// RodKw is the rod's own draw now: measured, or the kW of its CONFIRMED
	// stage; nil = unknown.
	RodKw *float64
}

// State is the controller's memory of one rod, persisted across restarts so
// a pause or a minimum run is never forgotten by a reboot.
type State struct {
	Stage       int         `json:"stufe"` // index into the stages, 0 = off
	Since       time.Time   `json:"seit,omitempty"`
	LastOn      time.Time   `json:"zuletzt_ein,omitempty"`
	LastOff     time.Time   `json:"zuletzt_aus,omitempty"`
	Switches    []time.Time `json:"schaltungen,omitempty"`
	UpSince     time.Time   `json:"ueberschuss_seit,omitempty"`
	ImportSince time.Time   `json:"bezug_seit,omitempty"`
	BlindSince  time.Time   `json:"blind_seit,omitempty"`
}

// Decision is what the rod should run now and why.
type Decision struct {
	// Stage indexes the stages (0 = off); Outputs/Kw describe it.
	Stage   int
	Outputs int
	Kw      float64
	// Changed: this tick moved the stage.
	Changed bool
	Code    string
	Reason  string
	// AvailableKw is the surplus the rod may use (nil while blind).
	AvailableKw *float64
	// NextUpAt is the earliest moment a higher stage may start (zero = now or
	// not applicable).
	NextUpAt time.Time
}

// Step folds one tick into the state and decides the stage. stages must be
// ascending (by outputs) and non-empty.
func Step(p Params, stages []Stage, st *State, in Inputs) Decision {
	now := in.Now
	if len(stages) == 0 {
		st.UpSince, st.ImportSince = time.Time{}, time.Time{}
		if st.Stage != 0 {
			change(st, stages, 0, now)
		}
		return decision(stages, st, false, CodeNoStages,
			"Die Leistung je Stufe ist unbekannt - der Heizstab bleibt aus.", nil, time.Time{})
	}
	if st.Stage > len(stages) {
		st.Stage = len(stages)
	}
	pruneSwitches(st, now)
	top := capIndex(p, stages)

	fresh := in.GridKw != nil && !math.IsNaN(*in.GridKw) && !math.IsInf(*in.GridKw, 0) &&
		now.Sub(in.GridAt) <= measurementMaxAge && in.RodKw != nil
	if !fresh {
		st.UpSince, st.ImportSince = time.Time{}, time.Time{}
		if st.BlindSince.IsZero() {
			st.BlindSince = now
		}
		if st.Stage > 0 && now.Sub(st.BlindSince) >= blindOffAfter {
			change(st, stages, 0, now)
			return decision(stages, st, true, CodeBlind,
				"Seit einer Minute fehlen frische Messwerte - der Heizstab ist aus.", nil, time.Time{})
		}
		return decision(stages, st, false, CodeBlind,
			"Messwerte fehlen - keine neue Stufe, nach einer Minute aus.", nil, time.Time{})
	}
	st.BlindSince = time.Time{}

	batt := 0.0
	if in.BatteryKw != nil && !math.IsNaN(*in.BatteryKw) && !math.IsInf(*in.BatteryKw, 0) &&
		now.Sub(in.BatteryAt) <= measurementMaxAge {
		batt = *in.BatteryKw
	}
	excess := -*in.GridKw
	if p.Order == RodFirst {
		excess += batt // the battery's charge is the rod's to take; a discharge is not sun
	} else {
		excess += math.Min(0, batt) // battery first: only a discharge counts (against the rod)
	}
	avail := excess + *in.RodKw - p.reserve()
	availR := math.Round(avail*1000) / 1000
	target := 0
	for i := 1; i <= top; i++ {
		if stages[i-1].Kw <= avail*(1+stageKwTolerance)+1e-9 {
			target = i
		}
	}

	if excess < -importThresholdKw {
		if st.ImportSince.IsZero() {
			st.ImportSince = now
		}
	} else {
		st.ImportSince = time.Time{}
	}
	if target > st.Stage {
		if st.UpSince.IsZero() {
			st.UpSince = now
		}
	} else {
		st.UpSince = time.Time{}
	}

	cur := st.Stage
	switch {
	case cur > top:
		// The highest allowed stage was lowered: follow at once (restrict-only).
		change(st, stages, top, now)
		return decision(stages, st, true, CodeCap,
			"Die höchste erlaubte Stufe wurde gesenkt.", &availR, time.Time{})

	case target < cur && !st.ImportSince.IsZero() && now.Sub(st.ImportSince) >= downAfter:
		next := target
		if next == 0 && now.Sub(st.LastOn) < p.minRun() {
			next = 1 // the lowest stage keeps the minimum run (at most that long on import)
		}
		if next < cur {
			change(st, stages, next, now)
			code, reason := CodeNoSurplus, "Netzbezug seit 30 Sekunden - eine kleinere Stufe."
			if next == 0 {
				reason = "Kein Überschuss mehr - der Heizstab ist aus."
			}
			return decision(stages, st, true, code, reason, &availR, time.Time{})
		}
		return decision(stages, st, false, CodeMinRun,
			"Netzbezug, aber die Mindestlaufzeit läuft noch.", &availR, st.LastOn.Add(p.minRun()))

	case target > cur:
		next := cur + 1
		// Every gate that still runs; the one that ends LAST names the reason
		// (a tie goes to the later rule in this list).
		gate := now
		code, reason := CodeWaitUp, "Überschuss für eine höhere Stufe - wird eine Minute geprüft."
		consider := func(t time.Time, c, r string) {
			if t.After(now) && !t.Before(gate) {
				gate, code, reason = t, c, r
			}
		}
		consider(st.UpSince.Add(upAfter), CodeWaitUp, reason)
		if cur == 0 && !st.LastOff.IsZero() {
			consider(st.LastOff.Add(p.minPause()), CodeMinPause, "Überschuss da, aber die Mindestpause läuft noch.")
		}
		if !st.Since.IsZero() {
			consider(st.Since.Add(p.hold()), CodeHold, "Überschuss da, aber die Haltezeit nach dem letzten Wechsel läuft noch.")
		}
		if ops := switchOps(stages, cur, next); len(st.Switches)+ops > p.switchBudget() {
			first := now.Add(switchWindow)
			if len(st.Switches) > 0 {
				first = st.Switches[0].Add(switchWindow)
			}
			return decision(stages, st, false, CodeSwitchBudget,
				fmt.Sprintf("Überschuss da, aber %d Schaltungen in der letzten Stunde sind erreicht.", p.switchBudget()),
				&availR, maxTime(gate, first))
		}
		if gate.After(now) {
			return decision(stages, st, false, code, reason, &availR, gate)
		}
		change(st, stages, next, now)
		return decision(stages, st, true, CodeSurplus, "Überschuss - eine Stufe höher.", &availR, time.Time{})
	}

	if cur == 0 {
		return decision(stages, st, false, CodeNoSurplus, "Kein Überschuss für die kleinste Stufe.", &availR, time.Time{})
	}
	if !st.ImportSince.IsZero() && target < cur {
		return decision(stages, st, false, CodeNoSurplus,
			"Netzbezug - hält er 30 Sekunden an, folgt eine kleinere Stufe.", &availR, time.Time{})
	}
	return decision(stages, st, false, CodeSurplus, "Heizt mit Überschuss.", &availR, time.Time{})
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// capIndex is the highest stage index the block allows.
func capIndex(p Params, stages []Stage) int {
	top := len(stages)
	if p.MaxOutputs > 0 {
		top = 0
		for i, s := range stages {
			if s.Outputs <= p.MaxOutputs {
				top = i + 1
			}
		}
	}
	return top
}

func outputsOf(stages []Stage, idx int) int {
	if idx <= 0 || idx > len(stages) {
		return 0
	}
	return stages[idx-1].Outputs
}

// switchOps is the number of outputs a stage change switches.
func switchOps(stages []Stage, from, to int) int {
	d := outputsOf(stages, to) - outputsOf(stages, from)
	if d < 0 {
		d = -d
	}
	return d
}

func change(st *State, stages []Stage, to int, now time.Time) {
	for i := 0; i < switchOps(stages, st.Stage, to); i++ {
		st.Switches = append(st.Switches, now)
	}
	if len(st.Switches) > maxRecordedSwitchesPerRod {
		st.Switches = st.Switches[len(st.Switches)-maxRecordedSwitchesPerRod:]
	}
	if st.Stage == 0 && to > 0 {
		st.LastOn = now
	}
	if to == 0 && st.Stage > 0 {
		st.LastOff = now
	}
	st.Stage, st.Since = to, now
	st.UpSince, st.ImportSince = time.Time{}, time.Time{}
}

func pruneSwitches(st *State, now time.Time) {
	keep := st.Switches[:0]
	for _, t := range st.Switches {
		if now.Sub(t) < switchWindow {
			keep = append(keep, t)
		}
	}
	st.Switches = keep
}

func decision(stages []Stage, st *State, changed bool, code, reason string, avail *float64, nextUp time.Time) Decision {
	d := Decision{Stage: st.Stage, Changed: changed, Code: code, Reason: reason, AvailableKw: avail, NextUpAt: nextUp}
	if st.Stage > 0 && st.Stage <= len(stages) {
		d.Outputs, d.Kw = stages[st.Stage-1].Outputs, stages[st.Stage-1].Kw
	}
	return d
}
