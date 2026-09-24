// Damped measurement following: the general fallback of the concept "Der
// Wechselrichter regelt, die Box setzt Absicht und Grenzen" (§6.5, Captain
// decision E2 A, 2026-09-24) for every device without an own mode of its own
// or without a proven way to hand it the job.
//
// The live case (Anlage Herzogau, 2026-09-24 17:15-17:27, scout report
// vp-herzogau-laden-bei-bezug-h4 §1.4/§4.1): in a charge_from_surplus_only slot
// the in-slot corrections (trim, surplus store/absorption) set the battery to
// the measured surplus on every setpoint tick - 60 changes of register 1109
// between 8,04 and 34,44 kW in twelve minutes, and 33 of 62 Deye measurements
// showed the battery charging while the grid delivered. Two properties of the
// device made a proportional follower swing behind the clouds instead of
// converging:
//
//   - the Deye follows a write only after 15-20 s, while the box re-evaluated
//     every ~10 s on a reading taken BEFORE its own last write had settled;
//   - it refreshes its measurement registers only every 5-25 s, and in 14 of 86
//     refreshes the grid half arrived ~5 s before the battery half. The surplus
//     is "battery - grid" (the house balance cancels every other PV source), so
//     a new grid beside an old battery moved it by the battery's own response
//     (17:20:10: 8,04 kW read, ~13,9 kW real) - the box then chased its own
//     echo.
//
// The damper closes exactly these two gaps and changes nothing else:
//
//  1. MEASURE, THEN SET. The measured corrections act on a CONTROL READING that
//     only advances when a device measurement pair exists whose BOTH halves
//     (grid and battery) were refreshed no earlier than the last write plus the
//     device's settle time. Between two such pairs the corrections see the same
//     values and therefore compute the same target - no write chases a reading
//     that still shows the previous command.
//     ONE narrow exception, and it only ever RETREATS: after a write that took
//     the battery back toward zero, a newer but unsettled pair may lower it
//     further - if its grid half is at least as new as its battery half. The
//     echo that makes unsettled pairs dangerous cannot mislead that step: the
//     surplus is "battery - grid", and while the battery falls behind a lower
//     command, a battery half no newer than the grid half makes the surplus look
//     LARGER (a discharge being reduced: the deficit look larger), so it can only
//     ever retreat too little, never spuriously. (A battery half NEWER than the
//     grid half errs the other way and waits.) A cloud edge the first pair
//     caught half way is then followed down without waiting a settle time in the
//     import - a raise always waits.
//  2. THE EXPENSIVE DIRECTION AT ONCE, THE CHEAP ONE DAMPED. Every measured
//     correction is bounded against exactly one side of the grid-zero point: a
//     charge never beyond the surplus (it would be bought), a discharge never
//     beyond the house deficit (the storage would be sold). The CLOUD picked
//     that side from the site's import and export prices when it set the slot
//     duty (services/optimization slot_trim.py); the box still knows no price.
//     Retreating from that side happens in ONE step on a fresh pair;
//     approaching it happens in ramps of at most RampKw per fresh pair, onto the
//     measured surplus (deficit) minus ReserveKw.
//  3. A DEADBAND: a change below DeadbandKw is not written. Single outliers
//     are the existing despiker's job (the control reading is built from the
//     despiked channels).
//
// Safety posture - the damper can only ever pick a value the chain already
// allows:
//
//   - It acts only while a measured correction is engaged. Its output lies on
//     the correction's own side of zero (never a direction flip), never beyond
//     the larger of command and correction target, and never below the command
//     a RAISING correction raises (it cannot trim where only absorption was
//     authorized). Everything else in the chain is restrict-only relative to
//     that interval.
//   - The caller re-runs the damped value through Clamp with the LIVE reading,
//     so rated band, SoC window, EEG solar-only charge and the §14a envelope bind
//     on every tick even while the economic target waits for a settled pair;
//     the peak guard, the cars-first cap and the export watchdog run after it
//     on live values as before.
//   - Unknown pv or load is a refusal (the control reading goes blind and the
//     corrections release - never regulate blind).
//
// NOT for persistent-lever surfaces (Deye Time-of-Use, and GoodWe/Growatt once
// supported): Layer 1 writes those on change with a dwell of >= 900 s
// (nodered/DEYE.md), so there is no box regulation to damp - the concept keeps
// them on their own mode with a few plan changes a day. Their profile is Off
// and the corrections pass through byte-identical.
package guards

import (
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
)

// DampProfile is the per-device timing and shaping of the damped follower.
type DampProfile struct {
	// Off disables the damper (no device, or a persistent-lever surface): the
	// corrections pass through unchanged.
	Off bool
	// Settle is how long the device needs to follow a write (Einschwingzeit). A
	// measurement taken earlier still shows the previous command.
	Settle time.Duration
	// MaxCadence is the longest gap between two refreshes of the device's
	// measurement registers (Messtakt). A channel that has not changed for longer
	// was re-measured with the same value - a battery resting at exactly 0 W
	// must not stall the gate forever.
	MaxCadence time.Duration
	// RampKw is the largest step per fresh pair TOWARD the expensive side.
	RampKw float64
	// ReserveKw is the distance the damped value keeps from the measured
	// surplus/deficit on the cheap side.
	ReserveKw float64
	// DeadbandKw is the smallest change worth a write.
	DeadbandKw float64
}

// DefaultDampProfile is the Vorgabe for every device whose control profile
// states no timing of its own: the values measured on the Deye at Herzogau
// (2026-09-24: follows a write after 15-20 s, refreshes every 5-25 s) - the
// slowest device measured so far, so a faster one only waits a little longer
// than it would need to. Ramp, reserve and deadband are the box's own shaping
// (concept §6.5) and stay here for every device.
func DefaultDampProfile() DampProfile {
	return DampProfile{
		Settle:     15 * time.Second,
		MaxCadence: 25 * time.Second,
		RampKw:     3,
		ReserveKw:  0.5,
		DeadbandKw: 0.2,
	}
}

// DampControlPathPersistent is the control-path readback naming a
// persistent-lever surface (the Deye Time-of-Use synthesis, state.ControlPath).
const DampControlPathPersistent = "tou"

// DampProfileFor returns the damping profile for the selected device and the
// control surface Layer 1 reports it is driving (dev.ControlPath). The timing
// comes from the device's CONTROL PROFILE (catalog/control-profiles, K7):
// Einschwingzeit and Messtakt where the profile states them, the Vorgabe per
// value where it does not; a profile that says the box must not regulate this
// device (a persistent lever) turns the damper Off. No family (no inverter
// selected - nothing is ever written then) is Off, and so is a persistent-lever
// surface even without a profile: that rule is the EEPROM's safety net and
// does not hang on a data file.
func DampProfileFor(dev controlprofile.Device) DampProfile {
	if dev.Family == "" || dev.ControlPath == DampControlPathPersistent {
		return DampProfile{Off: true}
	}
	return dampProfileFrom(controlprofile.For(dev))
}

// dampProfileFrom maps a control profile's damping statement onto the
// follower: each missing value keeps the Vorgabe.
func dampProfileFrom(prof controlprofile.Profile, ok bool) DampProfile {
	p := DefaultDampProfile()
	if !ok {
		return p
	}
	d := prof.Damping
	if d.BoxRegulates != nil && !*d.BoxRegulates {
		return DampProfile{Off: true}
	}
	if d.SettleS != nil {
		p.Settle = time.Duration(*d.SettleS * float64(time.Second))
	}
	if d.CadenceS != nil {
		p.MaxCadence = time.Duration(*d.CadenceS * float64(time.Second))
	}
	return p
}

// dampWriteResolutionKw is the 1 W resolution below which two setpoints are
// the same write.
const dampWriteResolutionKw = 0.001

// FollowDamper holds the device measurement clock, the last write and the
// damped level across setpoint ticks. Concurrency-safe like its siblings (the
// setpoint path is reachable from the tick loop, the schedule handler and the
// web API; Observe runs on the telemetry path).
type FollowDamper struct {
	mu sync.Mutex

	// Device measurement clock: when each half of the surplus pair last CHANGED
	// and when the latest device sample arrived.
	sampleAt           time.Time
	gridAt, battAt     time.Time
	grid, batt         float64
	gridSeen, battSeen bool

	// The last write (the final published setpoint) and whether it took the
	// battery back toward zero.
	wroteKw      float64
	wroteAt      time.Time
	wroteValid   bool
	wroteRetreat bool

	// The control reading: the last settled pair's pv/load and its time.
	usedAt         time.Time
	ctlPv, ctlLoad float64
	ctlValid       bool

	// The damped level on the correction's own side (magnitude) and its sign.
	engaged bool
	sigma   float64
	held    float64
}

// NewFollowDamper returns an empty damper.
func NewFollowDamper() *FollowDamper { return &FollowDamper{} }

// Observe records one kept device sample: its time and the two halves of the
// surplus pair as the device reported them (NaN = not in this sample). A half
// counts as refreshed when its value changed.
func (d *FollowDamper) Observe(ts time.Time, gridKw, battKw float64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sampleAt = ts
	if finite(gridKw) && (!d.gridSeen || gridKw != d.grid) {
		d.grid, d.gridAt, d.gridSeen = gridKw, ts, true
	}
	if finite(battKw) && (!d.battSeen || battKw != d.batt) {
		d.batt, d.battAt, d.battSeen = battKw, ts, true
	}
}

// pairAt is the time from which BOTH halves of the current pair are known to be
// measured: the older of the two refresh times, where an unchanged half counts
// as re-measured at least MaxCadence before the latest sample. Zero without any
// observed sample.
func (d *FollowDamper) pairAt(p DampProfile) time.Time {
	if d.sampleAt.IsZero() {
		return time.Time{}
	}
	floor := d.sampleAt.Add(-p.MaxCadence)
	refreshed := func(changed time.Time) time.Time {
		if changed.After(floor) {
			return changed
		}
		return floor
	}
	at := d.sampleAt
	if d.gridSeen {
		if g := refreshed(d.gridAt); g.Before(at) {
			at = g
		}
	}
	if d.battSeen {
		if b := refreshed(d.battAt); b.Before(at) {
			at = b
		}
	}
	return at
}

// DampPair is Gate's verdict on the device pair of this tick.
type DampPair int

const (
	// DampPairNone: no new usable pair - hold.
	DampPairNone DampPair = iota
	// DampPairRetreat: a new pair measured before the last write settled, after
	// a write that took the battery back toward zero. Good for a further
	// retreat only.
	DampPairRetreat
	// DampPairSettled: a new pair measured after the last write settled.
	DampPairSettled
)

// Gate returns the reading the measured corrections may act on at now, and
// which kind of new pair this tick consumed. readingAt is the live
// reading's sample time (used as the pair time when no device sample was ever
// observed). The control reading keeps the live SoC and grid limit - only the
// surplus inputs pv/load are held.
//
// A pair counts as settled when it is newer than the one used before and was
// measured no earlier than the last write plus Settle. When writes the damper
// did not cause (a plan step, the peak guard) keep the settle clock running,
// the control reading is not allowed to age past twice Settle+MaxCadence: then
// the newest pair is taken as it is.
func (d *FollowDamper) Gate(now time.Time, p DampProfile, r Reading, readingAt time.Time) (Reading, DampPair) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p.Off {
		d.ctlValid, d.usedAt = false, time.Time{}
		return r, DampPairNone
	}
	if !known(r.PvKw) || !known(r.LoadKw) {
		d.ctlValid = false
		return r, DampPairNone
	}
	at := d.pairAt(p)
	if at.IsZero() {
		at = readingAt
	}
	pair := DampPairNone
	if !at.IsZero() && at.After(d.usedAt) {
		settled := !d.wroteValid || !at.Before(d.wroteAt.Add(p.Settle))
		aged := d.ctlValid && now.Sub(d.usedAt) >= 2*(p.Settle+p.MaxCadence)
		switch {
		case settled || aged:
			pair = DampPairSettled
		case d.ctlValid && d.wroteRetreat && !d.gridAt.Before(d.battAt):
			pair = DampPairRetreat
		}
		if pair != DampPairNone {
			d.usedAt, d.ctlPv, d.ctlLoad, d.ctlValid = at, r.PvKw, r.LoadKw, true
		}
	}
	c := r
	if !d.ctlValid {
		// No settled pair since the reading went blind: the corrections must
		// not act on an unsettled one.
		c.PvKw, c.LoadKw = Unknown(), Unknown()
		return c, DampPairNone
	}
	c.PvKw, c.LoadKw = d.ctlPv, d.ctlLoad
	return c, pair
}

// Shape damps the result of the measured corrections.
//
// commandedKw is the command BEFORE the corrections (after Clamp and the holder
// override), targetKw their result on the control reading, engaged whether any
// of them is engaged (biting or inside its release dwell), pair Gate's verdict
// for this tick and ctl the control reading. It returns the value to write and
// whether the damper shaped it; the caller re-clamps a shaped value with the
// live reading.
func (d *FollowDamper) Shape(p DampProfile, commandedKw, targetKw float64, engaged bool, pair DampPair, ctl Reading) (float64, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p.Off || !engaged || !finite(commandedKw) || !finite(targetKw) {
		d.engaged = false
		return targetKw, false
	}
	// The correction's side: its own target's sign, or the command's while the
	// target rests at zero. No correction crosses zero, so both agree.
	sigma := 1.0
	if targetKw < 0 || (targetKw == 0 && commandedKw < 0) {
		sigma = -1
	}
	t, c := sigma*targetKw, sigma*commandedKw
	started := !d.engaged || d.sigma != sigma
	lo, hi := 0.0, math.Max(t, c)
	if t > c {
		// A RAISING correction (absorption, deepened discharge) never undercuts
		// the command it raises - except that a level still below it from a
		// lowering correction (trim -> absorption inside one slot) ramps up
		// THROUGH the command instead of jumping onto it.
		lo = math.Max(c, 0)
		if !started && d.held < lo {
			lo = d.held
		}
	}
	if started {
		// The correction starts where the uncorrected command stands - the
		// value the device was last asked for.
		d.engaged, d.sigma, d.held = true, sigma, math.Max(c, 0)
	}
	// A new target only on a new pair - or on the first engagement, whose
	// control reading is by construction the last consumed one. A pair that is
	// only good for a retreat never raises.
	if (pair != DampPairNone || started) && known(ctl.PvKw) && known(ctl.LoadKw) {
		room := sigma * (ctl.PvKw - ctl.LoadKw) // surplus (charge) / deficit (discharge)
		goal := math.Min(t, room-p.ReserveKw)
		goal = math.Max(lo, math.Min(hi, goal))
		switch {
		case goal < d.held-p.DeadbandKw:
			d.held = goal // retreat from the expensive side at once
		case goal > d.held+p.DeadbandKw && pair != DampPairRetreat:
			d.held = math.Min(goal, d.held+p.RampKw) // approach it in ramps
		}
	}
	d.held = math.Max(lo, math.Min(hi, d.held))
	return math.Round(sigma*d.held*1000) / 1000, true
}

// Commit records the final published setpoint; a changed value is a write and
// restarts the settle clock.
func (d *FollowDamper) Commit(now time.Time, kw float64) {
	if !finite(kw) {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.wroteValid || math.Abs(kw-d.wroteKw) > dampWriteResolutionKw {
		// Toward zero on the same side (or to zero): the battery now falls
		// behind the command, never rises.
		d.wroteRetreat = d.wroteValid && kw*d.wroteKw >= 0 && math.Abs(kw) < math.Abs(d.wroteKw)
		d.wroteKw, d.wroteAt, d.wroteValid = kw, now, true
	}
}

// Engaged reports whether the damper currently shapes a correction.
func (d *FollowDamper) Engaged() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.engaged
}

// Release drops the damped level and the control reading (used by the setpoint
// path's early exits: without a reading, or while a bounded test write owns the
// inverter, nothing may be carried across). The device clock stays - it is a
// fact about the device, not about a correction.
func (d *FollowDamper) Release() {
	d.mu.Lock()
	d.engaged, d.ctlValid, d.usedAt, d.wroteValid = false, false, time.Time{}, false
	d.mu.Unlock()
}
