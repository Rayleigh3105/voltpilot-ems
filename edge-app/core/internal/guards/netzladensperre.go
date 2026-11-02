// The Netzladen-Sperre: the LAST word on a charge command before the box
// hands it to the device, for every plant whose grid charging is not allowed.
//
// Captain decisions EN-1 A and EN-4 A (2026-11-02, task vp-netzladen-harte-
// sperre): "Ich will auf keinen Fall, dass der Speicher vom Netz beladen wird,
// wenn Grid Charging aus ist. Das darf nie wieder passieren." The live case
// (Anlage Herzogau, 02.11.2026 08:39-15:37): the battery charged 27,2 kWh, 25,6
// kWh of it while the house drew from the grid (house 6,5 kW, PV 1-3 kW). The
// box clamped the charge only to the MEASURED PV (FK3, Clamp stage 4), so the
// PV went into the battery and the grid fed the house - grid power in the
// storage at the connection point, which is how the Bundesnetzagentur reads it
// since its MiSpeL determination of 2026-10-01.
//
// This stage sets the bound at the END of the chain, after every stage that
// may raise or reshape a charge (the in-slot corrections, the surplus
// absorption, the NS-3 B hold, the damper, the cars-first cap, the
// Sprungprobe), so the guarantee does not depend on what any of them does. The
// same bound as a stateless stage (Limits.StrictExclusivity) serves only the
// writes this stage never sees - the v2 arbiter's own clamp, a window bound
// that forces a flow in the device's own mode, the First-Light test. Here it
// adds what a stateless clamp cannot know:
//
//   - THE AGE. A live reading older than NetzladenMessAlter, or none at all,
//     gives a bound of 0 - the battery does not charge on a picture of the
//     plant it no longer has. The Deye's own watchdog (register 1101 = 60 s)
//     is untouched.
//   - THE READING. The surplus is "battery - grid" (the house balance cancels
//     every other PV source), so right after a write a new grid half beside an
//     old battery half shows a surplus the plant does not have - smaller after
//     a raise, larger after a cut. A bound on the raw live reading would cut on
//     the echo of every raise and swing (it did, in the damper's replays). The
//     bound therefore rests on the follower's CONTROL reading (K1,
//     followdamper.go: it only advances on a pair measured after the last
//     write settled), the live reading only where there is none.
//   - THE DIRECTION. Lowering acts at once: on every new control reading, and
//     on the very tick a fresh live grid value shows IMPORT while the battery
//     charges - import is the violation itself, no echo produces it, and the
//     bound then rests on the live reading. Raising is damped like the
//     follower: the bound climbs at most RampKw at a time, and only on a
//     reading taken at least Settle after its last change.
//   - THE DEADBAND. The house load is derived (pv + grid - battery) and
//     wanders by a few tens of watts between readings; a bound that followed
//     it exactly would rewrite the device on every one. So the bound never
//     rises above the reading: a lowering goes DeadbandKw below the bound the
//     reading allows, a rise needs more than twice DeadbandKw of room and
//     stops DeadbandKw short. The reserve thus lies between R and
//     R + 2 x DeadbandKw, never below R.
//   - LIMITED PV. Where the PV is held back on purpose - the box's own cap
//     (planned curtailment, its live tracker, the feed-in watchdog: all aim at
//     ZERO export) stands at the measured production, or the device's own
//     feed-in limit stands at the measured export - the measured surplus is
//     not the surplus the plant has: it is exactly what the battery takes. A
//     bound "surplus - reserve" would then lower the charge by the reserve on
//     every reading, the PV would be curtailed by as much, and the charge
//     would ratchet down to 0 (at a negative price: curtailing the sun and
//     not storing it). There, and only with a fresh grid value, the reserve
//     bound rests: the meter is the judge - import cuts at once on the live
//     reading, as everywhere - and the bound climbs damped toward the command.
//
// Safety posture: it only ever LOWERS a charge, never touches a discharge, and
// never commands anything on its own. Plants with grid charging allowed never
// reach it (active = false) and keep their setpoint byte for byte.
package guards

import (
	"math"
	"sync"
	"time"
)

// NetzladenMessAlter is the oldest measurement the Netzladen-Sperre charges
// on: older, the bound is 0.
const NetzladenMessAlter = 30 * time.Second

// NetzladenBezugKw is the live import at the connection point above which the
// Netzladen-Sperre takes a charge back on the same tick, on the live reading -
// above meter noise, far below anything worth buying into a battery.
const NetzladenBezugKw = 0.1

// NetzladenSperreInput is one tick's view of the plant for the lock.
type NetzladenSperreInput struct {
	// Active is the plant's posture: grid charging not allowed, or the plan
	// field absent / no plan (fail-safe like Limits.SolarOnlyCharge).
	Active bool
	// CommandKw is the final command of the chain (+ charge / - discharge).
	CommandKw float64
	// Live is the latest reading and LiveAt when it was taken.
	Live   Reading
	LiveAt time.Time
	// Control is the follower's control reading (FollowDamper.Gate) - pv/load
	// of the last settled pair; Unknown pv or load = none, then Live is used.
	Control Reading
	// GridKw is the live grid value at the connection point (+ import /
	// - export), counted only when GridFresh.
	GridKw    float64
	GridFresh bool
	// Profile is the device's damping profile (Settle and RampKw; an Off or
	// empty profile falls back to DefaultDampProfile - the lock always damps
	// its rise).
	Profile DampProfile
	// PvCapKw is the plant PV cap the box itself published on its last tick
	// (pv_limit_kw: planned curtailment, live tracker, feed-in watchdog);
	// nil = none in force.
	PvCapKw *float64
	// DeviceExportLimitKw is the feed-in limit the device itself holds (read
	// from its registers); nil = unknown or none.
	DeviceExportLimitKw *float64
}

// NetzladenSperreResult is one evaluation of the last stage.
type NetzladenSperreResult struct {
	// Active is true while the lock is in force (grid charging not allowed).
	Active bool
	// CommandedKw is the command entering the stage.
	CommandedKw float64
	// Kw is the command leaving it: min(CommandedKw, CapKw) for a charge,
	// CommandedKw unchanged otherwise.
	Kw float64
	// CapKw is the bound in force on this tick (damped upward).
	CapKw float64
	// SurplusKw is the measured surplus pv - load the bound rests on; NaN when
	// the reading is unknown or too old (Blind).
	SurplusKw float64
	// Blind is true when the reading is unknown or older than
	// NetzladenMessAlter - the bound is then 0.
	Blind bool
	// Importing is true when a fresh live grid value showed import while the
	// command charged - the bound then rests on the live reading at once.
	Importing bool
	// PvLimited is true when the PV is held back on purpose (the box's cap at
	// the production, or the device's feed-in limit at the export) and a fresh
	// grid value judges instead of the reserve bound.
	PvLimited bool
	// Lowered is true when the stage lowered the command on this tick.
	Lowered bool
}

// NetzladenSperre holds the damped bound. Concurrency-safe like its siblings
// (the setpoint path is reachable from the tick loop, the schedule handler and
// the web API).
type NetzladenSperre struct {
	mu        sync.Mutex
	init      bool
	capKw     float64
	changedAt time.Time
}

// NewNetzladenSperre returns a released lock.
func NewNetzladenSperre() *NetzladenSperre { return &NetzladenSperre{} }

// Apply evaluates the lock for this tick.
func (s *NetzladenSperre) Apply(now time.Time, in NetzladenSperreInput) NetzladenSperreResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	kw := in.CommandKw
	res := NetzladenSperreResult{Active: in.Active, CommandedKw: kw, Kw: kw, SurplusKw: math.NaN()}
	if !in.Active {
		s.init = false
		return res
	}

	settle, ramp, band := in.Profile.Settle, in.Profile.RampKw, in.Profile.DeadbandKw
	def := DefaultDampProfile()
	if in.Profile.Off || settle <= 0 {
		settle = def.Settle
	}
	if in.Profile.Off || !(ramp > 0) || math.IsInf(ramp, 0) {
		ramp = def.RampKw
	}
	if in.Profile.Off || !(band >= 0) || math.IsInf(band, 0) {
		band = def.DeadbandKw
	}

	// A reading a few milliseconds "in the future" (it arrived after the tick
	// took its clock) is fresh, not stale.
	fresh := !in.LiveAt.IsZero() && now.Sub(in.LiveAt) <= NetzladenMessAlter
	raw := 0.0
	if fresh && known(in.Live.PvKw) && known(in.Live.LoadKw) {
		src := in.Control
		if !known(src.PvKw) || !known(src.LoadKw) {
			src = in.Live
		}
		res.SurplusKw = src.PvKw - src.LoadKw
		raw = netzladenCapKw(src)
		gridKnown := in.GridFresh && known(in.GridKw) && !math.IsInf(in.GridKw, 0)
		if gridKnown && in.GridKw <= NetzladenBezugKw &&
			((in.PvCapKw != nil && in.Live.PvKw >= *in.PvCapKw-band) ||
				(in.DeviceExportLimitKw != nil && -in.GridKw >= *in.DeviceExportLimitKw-band)) {
			res.PvLimited = true
			raw = math.Inf(1)
		}
		if kw > 0 && gridKnown && in.GridKw > NetzladenBezugKw {
			res.Importing = true
			if live := netzladenCapKw(in.Live); live < raw {
				raw = live
				res.SurplusKw = in.Live.PvKw - in.Live.LoadKw
			}
		}
	} else {
		res.Blind = true
	}

	switch {
	case !s.init && math.IsInf(raw, 1):
		s.init, s.capKw, s.changedAt = true, math.Max(kw, 0), now
	case !s.init:
		s.init, s.capKw, s.changedAt = true, raw, now
	case raw < s.capKw:
		// Lowering acts at once, the deadband below what the reading allows.
		// The time only moves when the lowered bound actually changes the
		// command: that write is what a later reading must have settled after.
		low := math.Max(raw-band, 0)
		if kw > low {
			s.changedAt = now
		}
		s.capKw = low
	case raw > s.capKw+2*band && !in.LiveAt.Before(s.changedAt.Add(settle)):
		// Toward the reading's bound - or, with the PV held back (raw +Inf),
		// toward the command, never past it.
		next := math.Min(raw-band, s.capKw+ramp)
		if math.IsInf(raw, 1) {
			next = math.Min(next, math.Max(kw, s.capKw))
		}
		if next > s.capKw {
			s.capKw = next
			s.changedAt = now
		}
	}
	res.CapKw = math.Round(s.capKw*1000) / 1000

	if kw > s.capKw {
		res.Kw = res.CapKw
		res.Lowered = true
	}
	return res
}
