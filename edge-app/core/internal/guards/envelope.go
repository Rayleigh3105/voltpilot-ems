package guards

import (
	"math"
	"sync"
)

// Envelope is the physical-plausibility guard: a hard bound derived from the
// CONFIGURED inverter model, enforced REGARDLESS of the operator's despike
// sensitivity preset. It closes the gap the rate-based Despiker leaves open at
// slow sample cadence: the rate model allows margin + rate*elapsed of change, so
// at a ~10 s cadence even a tight "Streng" preset tolerates a tens-of-kW
// single-sample step - a 12 kW inverter briefly reading ~26 kW passes the rate
// gate and, because the dashboard's battery curve is DERIVED (battery =
// grid - load + pv), snaps the green line to an impossible value and back.
//
// The inverter's nameplate rating is authoritative physics: a 12 kW inverter can
// neither generate nor move ~26 kW, whatever the preset says. The Envelope uses
// that to bound the channels the inverter actually limits:
//
//   - PV generation (pv_power_kw) is bounded by the inverter (DC over-sizing is
//     allowed, so the bound is generous: rating * pvFactor + slack).
//   - Battery charge/discharge is bounded by the inverter. The battery is not a
//     measured channel; it is DERIVED from the power balance, so the Envelope
//     enforces the bound on the DERIVED value and, when it is exceeded, holds the
//     offending MEASURED channel (the one whose jump vs its last accepted value
//     explains the excursion). This is what catches the captain's grid spike:
//     pure grid import is NOT inverter-bounded (it follows the house connection),
//     but an UNBALANCED grid spike (grid jumps while load/pv do not) drives the
//     derived battery out of the physical envelope and is caught there. A
//     genuine high grid draw is always balanced by load, so the derived battery
//     stays in-envelope and passes.
//
// Hold-last continuity is preserved exactly like the Despiker: a rejected value
// is REPLACED with that channel's last in-envelope value (never a gap, never
// interpolation). The Envelope keeps its OWN last-good state, independent of the
// Despiker's rate state, and runs AFTER the Despiker at the same ingest choke
// point, so a value the rate gate accepted can still be overridden here.
//
// Unlike the Despiker's accept-after-confirmation, a beyond-envelope value is
// never "adopted": it is physically impossible for the configured model, so a
// PERSISTENT beyond-envelope reading indicates a scaling/model misconfiguration
// (e.g. a wrong power_scale, or the wrong model picked) that the operator fixes
// on the device - not something to silently start trusting. The derived-battery
// check only ever fires on an UNBALANCED excursion, so a genuine sustained
// (balanced) load/grid change is never pinned.
//
// When no inverter is selected, or the selected model has no known rating, the
// Envelope is INACTIVE and passes everything through untouched.
type Envelope struct {
	mu sync.Mutex

	maxPvKw      float64 // 0 => PV not bounded
	maxBatteryKw float64 // 0 => battery not bounded (no-battery family / unknown)

	states  map[string]float64 // per-channel last in-envelope value (hold-last)
	haveVal map[string]bool
	dropped int
	byChan  map[string]int
}

// Envelope margins over the nameplate rating. Deliberately generous: the point
// is to catch physically-impossible garbage (2-3x rating), never to clip real
// dynamics. PV allows DC over-sizing; battery allows brief inverter overload.
const (
	envPvFactor      = 2.0 // PV DC over-sizing headroom over AC rating
	envBatteryFactor = 1.5 // battery charge/discharge headroom over AC rating
	envAbsoluteSlack = 2.0 // kW added to every bound so tiny inverters aren't over-tight
)

// gridChannel is the measured grid coupling-point power the derived battery uses.
const gridChannel = "power_kw"

// NewEnvelope builds an inactive envelope (no inverter rating known yet).
func NewEnvelope() *Envelope {
	return &Envelope{states: map[string]float64{}, haveVal: map[string]bool{}, byChan: map[string]int{}}
}

// EnvelopeFor builds the bounds for a selected inverter: ratedKw is the model's
// nameplate AC power, hasBattery whether the register-map family models a
// battery. A ratedKw <= 0 yields an inactive envelope.
func EnvelopeFor(ratedKw float64, hasBattery bool) (maxPvKw, maxBatteryKw float64) {
	if ratedKw <= 0 {
		return 0, 0
	}
	maxPvKw = ratedKw*envPvFactor + envAbsoluteSlack
	if hasBattery {
		maxBatteryKw = ratedKw*envBatteryFactor + envAbsoluteSlack
	}
	return maxPvKw, maxBatteryKw
}

// SetBounds installs new bounds live (called when the inverter selection
// changes). Zero bounds disable the respective check; both zero => inactive.
// The last-good state is preserved so continuity is not broken by a reconfigure.
func (e *Envelope) SetBounds(maxPvKw, maxBatteryKw float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.maxPvKw = maxPvKw
	e.maxBatteryKw = maxBatteryKw
}

// Active reports whether any bound is in force.
func (e *Envelope) Active() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.maxPvKw > 0 || e.maxBatteryKw > 0
}

// Accept enforces the physical envelope on a measurement map IN PLACE at
// observation time: any channel driven beyond the physical envelope (directly,
// for PV, or via the derived battery, for an unbalanced grid/load/pv spike) is
// REPLACED with that channel's last in-envelope value (hold-last). The rejected
// channels are returned for logging. An inactive envelope is a no-op.
func (e *Envelope) Accept(m map[string]float64) []Drop {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.maxPvKw <= 0 && e.maxBatteryKw <= 0 {
		return nil
	}

	var drops []Drop
	held := map[string]bool{}
	hold := func(key string) {
		// Mark held either way, so a violating channel is never adopted as a
		// baseline at the end (that would pin the garbage value forever).
		held[key] = true
		if !e.haveVal[key] {
			// No last-good yet: we cannot substitute, so the raw value stays this
			// once. It self-corrects as soon as a real in-envelope reading arrives.
			return
		}
		last := e.states[key]
		cur := m[key]
		m[key] = last
		e.dropped++
		e.byChan[key]++
		drops = append(drops, Drop{Channel: key, Value: cur, Held: last})
	}

	// 1. Direct PV bound (covers no-battery families where the battery-balance
	//    check does not apply, and any family's raw PV spike).
	if e.maxPvKw > 0 {
		if v, ok := m["pv_power_kw"]; ok && math.Abs(v) > e.maxPvKw {
			hold("pv_power_kw")
		}
	}

	// 2. Derived-battery consistency: battery = grid - load + pv. When the balance
	//    yields a battery beyond the inverter's bound, the sample is suspect. Hold
	//    the offending measured channel (largest jump vs its last in-envelope
	//    value); recompute and, if still beyond, hold the next-largest. Never hold
	//    more channels than needed to bring the derived battery back in-envelope.
	if e.maxBatteryKw > 0 {
		for i := 0; i < 3; i++ { // at most the three measured channels
			batt, ok := derivedBattery(m)
			if !ok || math.Abs(batt) <= e.maxBatteryKw {
				break
			}
			off, ok := e.offender(m, held)
			if !ok {
				break // nothing left to hold (no baselines) - leave as-is
			}
			hold(off)
		}
	}

	// Update the last-good baselines for every present channel that was NOT held
	// this sample (a held channel keeps its previous baseline).
	for _, key := range envChannels {
		if v, ok := m[key]; ok && !held[key] {
			e.states[key] = v
			e.haveVal[key] = true
		}
	}
	return drops
}

// envChannels are the measured channels the envelope tracks / can hold.
var envChannels = []string{gridChannel, "load_kw", "pv_power_kw"}

// envMinJumpKw is the smallest deviation from a channel's last in-envelope value
// that counts as "the channel jumped". If NO measured channel moved by at least
// this much yet the derived battery is beyond envelope, the excursion cannot be
// attributed to a spike - it is a steady beyond-envelope state (a scaling/model
// misconfiguration to fix on the device), which the envelope leaves visible
// rather than fabricating pointless holds.
const envMinJumpKw = 0.5

// offender returns the measured channel whose current value deviates most from
// its last in-envelope value (the most likely spike), skipping already-held
// channels, channels with no baseline yet, and channels that did not meaningfully
// move (envMinJumpKw). ok=false when no channel is a plausible culprit.
func (e *Envelope) offender(m map[string]float64, held map[string]bool) (string, bool) {
	best := ""
	bestJump := envMinJumpKw
	for _, key := range envChannels {
		if held[key] {
			continue
		}
		cur, ok := m[key]
		if !ok {
			continue
		}
		if !e.haveVal[key] {
			continue
		}
		last := e.states[key]
		if jump := math.Abs(cur - last); jump > bestJump {
			bestJump = jump
			best = key
		}
	}
	return best, best != ""
}

// derivedBattery computes battery = grid - load + pv from the map, ok=false when
// any of the three measured channels is absent.
func derivedBattery(m map[string]float64) (float64, bool) {
	grid, g := m[gridChannel]
	load, l := m["load_kw"]
	pv, p := m["pv_power_kw"]
	if !g || !l || !p {
		return 0, false
	}
	return grid - load + pv, true
}

// DroppedTotal is the running count of envelope rejections since start.
func (e *Envelope) DroppedTotal() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.dropped
}

// DroppedByChannel returns a copy of the per-channel envelope rejection counts.
func (e *Envelope) DroppedByChannel() map[string]int {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]int, len(e.byChan))
	for k, v := range e.byChan {
		out[k] = v
	}
	return out
}
