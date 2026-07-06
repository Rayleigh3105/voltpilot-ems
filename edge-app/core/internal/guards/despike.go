package guards

import (
	"math"
	"sync"
	"time"
)

// Despiker rejects transient single-sample garbage that the in-band
// plausibility gates cannot catch: the captain's real symptom is a SoC (or
// another channel) momentarily reading e.g. 2 % between two steady 94 %
// samples and then snapping straight back. That 2 % is physically impossible
// for a battery (State-of-Charge is integrative - it cannot move tens of
// percentage points in seconds) yet sits INSIDE the valid (0,100] band, so
// SocPlausible passes it. The despiker sits at the core's single local-bus
// ingest choke point (agent.onLocalTelemetry), so a dropped value never
// reaches ANY downstream consumer - dashboard tiles / energy flow (state
// snapshot), the live-chart ring (history), the cloud (store-and-forward
// buffer + status heartbeat) or the setpoint guards - regardless of which
// Layer-1 flow produced the read.
//
// It keeps the established drop-don't-fabricate philosophy: a dropped value
// simply does not exist downstream. There is NO smoothing, NO interpolation
// and NO fabricated replacement; every display keeps its last good value and
// the existing freshness UI turns honest on its own (LastTelemetry only
// advances on a kept sample).
//
// # Two regimes, chosen per channel
//
//   - SoC (rate bound): SoC is integrative and cannot step fast, so a strict,
//     physically-motivated rate limit applies. The allowed change between two
//     accepted samples is margin + maxRate*elapsed, so the bound scales with
//     the actual gap between samples. maxRate is deliberately generous (a very
//     high C-rate plus slack) - the point is to reject impossible jumps like
//     92 % in a few seconds, not to police normal charging.
//   - Power (gross jump): grid / PV / load power CAN legitimately step fast (a
//     cloud edge, a load switching on), so they are NOT rate-limited. Only a
//     GROSS excursion - both an absolute AND a large relative jump, the
//     signature of a decode error (the old "30 MW" garbage read), never normal
//     dynamics - is treated as suspect. When in doubt a power sample passes: a
//     missed power spike is cosmetic, a suppressed real transient is a bug.
//
// # Accept-after-confirmation (no deadlock, no lookahead)
//
// A suspect jump is dropped but remembered as a candidate level. If
// confirmCount consecutive readings agree with that candidate, the new level
// is adopted - so a genuinely resynced BMS or a corrected reading converges
// instead of deadlocking on the stale level forever. The earlier readings that
// established the candidate stay dropped (drop-never-alter); only from the
// confirming sample on does the channel track the new level. This needs no
// lookahead: each sample is decided when it arrives.
//
// # Long gaps / reboots
//
// If the gap since the last accepted sample exceeds gapReset, the gate resets
// for that channel and accepts the reading as a fresh baseline. A device that
// reboots after hours therefore never false-rejects its first post-reboot SoC.
type Despiker struct {
	mu      sync.Mutex
	params  map[string]channelParams
	states  map[string]*channelState
	dropped int
}

// Drop records one rejected channel value (for rate-limited diagnostics).
type Drop struct {
	Channel string
	Value   float64
}

type spikeKind int

const (
	rateBound spikeKind = iota // integrative channel (SoC): tight rate limit
	grossJump                  // power channel: only gross decode-error excursions
)

type channelParams struct {
	kind spikeKind

	// rateBound: allowed |delta| = margin + maxRatePerSec*elapsedSeconds.
	maxRatePerSec float64
	margin        float64

	// grossJump: suspect when |delta| > absFloor AND |delta| > relFactor*max(|prev|, relRef).
	absFloor  float64
	relFactor float64
	relRef    float64

	// shared: consecutive agreeing readings needed to adopt a new level, and the
	// gap beyond which the gate resets to a fresh baseline.
	confirmCount int
	gapReset     time.Duration
}

// Tuning constants. SoC bounds are physical; power bounds are deliberately
// loose so only decode-error garbage triggers them.
const (
	// socMaxRatePctPerSec allows 1 %/s (~36C) - absurdly generous for a real
	// battery, so genuine charging always passes, yet a 92 % jump over a few
	// seconds is firmly rejected.
	socMaxRatePctPerSec = 1.0
	// socMargin is base slack for sensor noise / rounding at fast cadence.
	socMargin = 5.0

	// powerAbsFloorKw: a jump smaller than this always passes (covers any real
	// household/commercial load or PV step).
	powerAbsFloorKw = 100.0
	// powerRelFactor: on top of the absolute floor, a suspect jump must also be
	// this many times the previous magnitude - so only order-of-magnitude
	// decode garbage qualifies.
	powerRelFactor = 8.0
	// powerRelRefKw keeps the relative test meaningful near zero.
	powerRelRefKw = 2.0

	// despikeConfirmCount: after this many consecutive agreeing readings a new
	// level is adopted (the earlier ones stay dropped).
	despikeConfirmCount = 3
	// despikeGapReset: beyond this gap the gate accepts a fresh baseline
	// (reboot / long outage), so it never false-rejects after a long silence.
	despikeGapReset = 5 * time.Minute
)

type channelState struct {
	haveLast bool
	last     float64
	lastTime time.Time

	haveCand  bool
	cand      float64
	candTime  time.Time
	candCount int
}

// despikeOrder fixes the iteration order so drops are reported deterministically.
var despikeOrder = []string{"soc_pct", "power_kw", "pv_power_kw", "load_kw"}

// NewDespiker builds a despiker with the default per-channel tuning.
func NewDespiker() *Despiker {
	gross := channelParams{
		kind:         grossJump,
		absFloor:     powerAbsFloorKw,
		relFactor:    powerRelFactor,
		relRef:       powerRelRefKw,
		confirmCount: despikeConfirmCount,
		gapReset:     despikeGapReset,
	}
	return &Despiker{
		params: map[string]channelParams{
			"soc_pct": {
				kind:          rateBound,
				maxRatePerSec: socMaxRatePctPerSec,
				margin:        socMargin,
				confirmCount:  despikeConfirmCount,
				gapReset:      despikeGapReset,
			},
			"power_kw":    gross,
			"pv_power_kw": gross,
			"load_kw":     gross,
		},
		states: map[string]*channelState{},
	}
}

// Accept filters a measurement map IN PLACE at observation time now, deleting
// any channel whose value is a rejected spike, and returns the channels it
// dropped (for rate-limited logging by the caller). A channel with no
// configured gate (e.g. grid_limit_kw) is always kept. Dropped channels are
// also counted in the running total exposed by DroppedTotal.
func (d *Despiker) Accept(m map[string]float64, now time.Time) []Drop {
	d.mu.Lock()
	defer d.mu.Unlock()
	var drops []Drop
	for _, key := range despikeOrder {
		v, ok := m[key]
		if !ok {
			continue
		}
		cs := d.states[key]
		if cs == nil {
			cs = &channelState{}
			d.states[key] = cs
		}
		if !d.acceptChannel(cs, d.params[key], v, now) {
			delete(m, key)
			d.dropped++
			drops = append(drops, Drop{Channel: key, Value: v})
		}
	}
	return drops
}

// DroppedTotal is the running count of samples the despiker has dropped since
// start (cheap, exposed in the state snapshot for field diagnosis).
func (d *Despiker) DroppedTotal() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.dropped
}

// acceptChannel decides whether cur is a plausible reading for one channel,
// updating that channel's accepted level / confirmation candidate.
func (d *Despiker) acceptChannel(cs *channelState, p channelParams, cur float64, now time.Time) bool {
	if !cs.haveLast {
		cs.setLast(cur, now)
		return true
	}
	elapsed := nonNeg(now.Sub(cs.lastTime))
	if elapsed >= p.gapReset {
		// Long gap / reboot: accept a fresh baseline, forget any candidate.
		cs.setLast(cur, now)
		cs.clearCand()
		return true
	}
	if !p.suspect(cs.last, cur, elapsed) {
		// Within the plausible envelope of the last accepted value.
		cs.setLast(cur, now)
		cs.clearCand()
		return true
	}
	// A suspect jump away from the accepted level. Track confirmation: if it
	// agrees with a pending candidate, count it; once confirmCount readings
	// agree, adopt the new level. Otherwise (re)start the candidate and drop.
	if cs.haveCand {
		ce := nonNeg(now.Sub(cs.candTime))
		if ce < p.gapReset && !p.suspect(cs.cand, cur, ce) {
			cs.candCount++
			cs.cand = cur
			cs.candTime = now
			if cs.candCount >= p.confirmCount {
				cs.setLast(cur, now)
				cs.clearCand()
				return true
			}
			return false
		}
	}
	cs.cand = cur
	cs.candTime = now
	cs.candCount = 1
	cs.haveCand = true
	return false
}

func (cs *channelState) setLast(v float64, t time.Time) {
	cs.haveLast = true
	cs.last = v
	cs.lastTime = t
}

func (cs *channelState) clearCand() {
	cs.haveCand = false
	cs.candCount = 0
}

// suspect reports whether cur is an implausible jump away from prev, given the
// elapsed time since prev (used only by the rate-bound regime).
func (p channelParams) suspect(prev, cur float64, elapsed time.Duration) bool {
	delta := math.Abs(cur - prev)
	switch p.kind {
	case rateBound:
		allowed := p.margin + p.maxRatePerSec*elapsed.Seconds()
		return delta > allowed
	case grossJump:
		if delta <= p.absFloor {
			return false
		}
		ref := math.Max(math.Abs(prev), p.relRef)
		return delta > p.relFactor*ref
	}
	return false
}

func nonNeg(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}
