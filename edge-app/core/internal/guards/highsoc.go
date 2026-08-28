// High-SoC load coverage is the narrow customer-trust override for an idle
// optimizer slot: a battery sitting at its configured upper bound must not buy
// ordinary house load from the grid merely because the marginal model values
// the same energy a little higher later.
//
// This is deliberately NOT a second optimizer. It only opens a small, bounded
// headroom window at the top of the battery:
//
//   - enter only within one percentage point of the configured SoC ceiling;
//   - follow only a measured import from a genuinely idle command;
//   - stop five percentage points below the ceiling, or at the full
//     cloud-computed reserve stack when that is higher;
//   - release immediately on stale/missing facts or a different holder/plan.
//
// The state provides hysteresis between the one-point entry threshold and the
// five-point release threshold. Without it a 94.0 % reading on a 95 % ceiling
// would engage for one tick, fall to 93.9 %, and stop before creating useful
// headroom.
package guards

import (
	"math"
	"sync"
)

const (
	// HighSocEngageHeadroomPct is how close the measured SoC must be to the
	// configured upper limit before customer expectation outranks later value.
	HighSocEngageHeadroomPct = 1.0
	// HighSocReliefBandPct is the maximum top band this rule may make available.
	// It is intentionally small: the optimizer keeps all energy below it.
	HighSocReliefBandPct = 5.0
	// HighSocImportDeadbandKw keeps meter noise from arming a battery cycle.
	HighSocImportDeadbandKw = 0.2
	// HighSocIdleDeadbandKw is the same real-idle boundary as the additive
	// unplanned-load schedule duty. A charge or sale is never reinterpreted.
	HighSocIdleDeadbandKw = 0.05
)

// HighSocInput is every fact needed by the bounded rule. Nil/invalid facts are
// refusals; no default is invented for a control decision.
type HighSocInput struct {
	Eligible          bool
	MeasurementsFresh bool
	CommandKw         float64
	SocPct            float64
	SocMaxPct         float64
	EffectiveFloorPct *float64
	PvKw              float64
	LoadKw            float64
}

// HighSocDecision authorizes the existing idle load follower and gives it the
// tighter floor it must apply. FloorPct is non-nil exactly while Active.
type HighSocDecision struct {
	Active   bool
	FloorPct *float64
}

// HighSocRelief carries the top-band hysteresis across setpoint ticks.
type HighSocRelief struct {
	mu    sync.Mutex
	armed bool
}

func NewHighSocRelief() *HighSocRelief { return &HighSocRelief{} }

// Decide returns whether the idle follower may cover the measured house load
// for this tick. Every structural ambiguity releases the latch immediately.
func (h *HighSocRelief) Decide(in HighSocInput) HighSocDecision {
	h.mu.Lock()
	defer h.mu.Unlock()

	refuse := func() HighSocDecision {
		h.armed = false
		return HighSocDecision{}
	}
	if !in.Eligible || !in.MeasurementsFresh ||
		!finite(in.CommandKw) || math.Abs(in.CommandKw) > HighSocIdleDeadbandKw ||
		!finite(in.SocPct) || !finite(in.SocMaxPct) ||
		in.SocMaxPct <= 0 || in.SocMaxPct > 100 || in.EffectiveFloorPct == nil ||
		!finite(*in.EffectiveFloorPct) || *in.EffectiveFloorPct < 0 || *in.EffectiveFloorPct > 100 ||
		!finite(in.PvKw) || !finite(in.LoadKw) {
		return refuse()
	}

	// The command as it stands would import this much. The rule never creates
	// export and never cycles for a rounding-sized exchange.
	if in.LoadKw+in.CommandKw-in.PvKw <= HighSocImportDeadbandKw {
		return refuse()
	}

	releaseFloor := math.Max(in.SocMaxPct-HighSocReliefBandPct, *in.EffectiveFloorPct)
	engageAt := in.SocMaxPct - HighSocEngageHeadroomPct
	// No usable top band remains above the customer's/cloud's reserve stack.
	if releaseFloor >= engageAt {
		return refuse()
	}

	if h.armed {
		if in.SocPct <= releaseFloor {
			return refuse()
		}
	} else {
		if in.SocPct < engageAt || in.SocPct <= releaseFloor {
			return HighSocDecision{}
		}
		h.armed = true
	}

	floor := releaseFloor
	return HighSocDecision{Active: true, FloorPct: &floor}
}

func (h *HighSocRelief) Release() {
	h.mu.Lock()
	h.armed = false
	h.mu.Unlock()
}
