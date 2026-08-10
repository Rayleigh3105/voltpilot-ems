package agent

// The heartbeat's additive `consumers` block (Verbrauchssteuerung Inkrement 3,
// D9/§15.1): per controllable consumer entity the edge runtime state
// {state, reason_code, actual_kw, confirmed, requirement_progress}. It only
// REPORTS - the arbitration/guard chain decides elsewhere; a device without
// consumer entities sends no block, so its heartbeat stays byte-identical.

import (
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flexfallback"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// The §14.13 state vocabulary the EDGE can honestly claim. The full customer
// vocabulary (disconnected, fulfilled, missed, ...) is cloud territory - the
// edge never claims a fulfilment it cannot know.
const (
	consumerStateRunningForced    = "running_forced"
	consumerStateRunningOptimized = "running_optimized"
	consumerStateClamped          = "clamped"
	consumerStateWaiting          = "waiting"
	consumerStateOffline          = "offline"
)

// reasonRatedPower is the §15 code for a value clamp (guard chain bit).
const reasonRatedPower = "guard_rated_power"

// consumersSummary builds the heartbeat block. nil when the registry carries
// no controllable consumer entity (byte-identical heartbeat).
func (a *Agent) consumersSummary() cloud.ConsumersSummary {
	if a.arb == nil {
		return nil
	}
	now := time.Now()

	a.entMu.Lock()
	type consumerView struct {
		id       string
		hadEver  bool
		fresh    bool
		actualKw *float64
	}
	var views []consumerView
	for _, e := range a.entRegistry.Entities {
		if e.Category() != "consumer" || len(e.Capabilities.Actuate) == 0 {
			continue
		}
		v := consumerView{id: e.ID}
		if er, ok := a.entReadings[e.ID]; ok {
			v.hadEver = true
			if now.Sub(er.recv) <= entityHealthWindow {
				v.fresh = true
				if kw, has := er.channels["power_kw"]; has {
					val := kw
					v.actualKw = &val
				}
			}
		}
		views = append(views, v)
	}
	a.entMu.Unlock()
	if len(views) == 0 {
		return nil
	}

	out := cloud.ConsumersSummary{}
	for _, v := range views {
		entry := cloud.ConsumerRuntime{ActualKw: v.actualKw}

		dec, hasDec := a.arb.DecisionFor(v.id)
		var hold *guards.CycleHold
		if hasDec {
			hold = dec.Cycle
		}
		cycleState, hasCycle := a.arb.CycleStateFor(v.id)
		if hasCycle {
			entry.RequirementProgress = &cloud.ConsumerRequirementProgress{
				RuntimeSecondsToday: cycleState.RuntimeTodaySeconds,
				StartsToday:         cycleState.StartsToday,
			}
		}

		commandedOn := hasDec && grantedOn(dec.Granted.OnOff, dec.Granted.SetpointKw)

		switch {
		case hold != nil && !commandedOn:
			// The cycle guard holds a switch-on (Mindestpause / Startlimit).
			entry.State = consumerStateWaiting
			entry.ReasonCode = hold.Code
		case hold != nil && commandedOn:
			// Held ON (Mindestlaufzeit) or ramped: the run state per holder,
			// the hold as the honest reason.
			entry.State = runningState(dec.HolderKind, dec.HolderOverride)
			entry.ReasonCode = hold.Code
		case commandedOn && dec.Clamped:
			entry.State = consumerStateClamped
			entry.ReasonCode = reasonRatedPower
		case commandedOn:
			entry.State = runningState(dec.HolderKind, dec.HolderOverride)
			if dec.HolderKind == string(desired.SourceDeadlineFallback) {
				// The device started the flexible task ITSELF (Inkrement 6,
				// §15 vocabulary): honest, machine-readable - the run word
				// stays running_optimized (a user-wish-rank run, no Pflicht
				// boost), the reason names the fallback.
				entry.ReasonCode = flexfallback.ReasonRun
			}
		case v.hadEver && !v.fresh:
			// Nothing commands it AND the device went silent after having
			// reported - the device truth outranks "waiting" then.
			entry.State = consumerStateOffline
			entry.ReasonCode = "device_offline"
		default:
			entry.State = consumerStateWaiting
		}

		// Readback evidence: confirmed is TRI-STATE (nil = no evidence, never
		// claimed). A mismatch is named unless a cycle hold already explains
		// the deviation.
		a.arbMu.Lock()
		verdict := a.entReadback[v.id]
		a.arbMu.Unlock()
		if verdict != nil {
			c := *verdict
			entry.Confirmed = &c
			if !c && entry.ReasonCode == "" {
				entry.ReasonCode = "readback_mismatch"
			}
		}

		out[v.id] = entry
	}
	return out
}

// grantedOn maps a granted command set to "commanded to run".
func grantedOn(onOff *bool, setpointKw *float64) bool {
	if onOff != nil {
		return *onOff
	}
	return setpointKw != nil && !math.IsNaN(*setpointKw) && *setpointKw > 0.005
}

// runningState splits Pflichtregel from optimized operation: a flow desire
// with the D-5 override elevation is the must-run path; everything else
// (plan/market, ordinary flow, failsafe hold) runs as planned/optimized.
func runningState(holderKind string, override bool) string {
	if holderKind == "flow" && override {
		return consumerStateRunningForced
	}
	return consumerStateRunningOptimized
}
