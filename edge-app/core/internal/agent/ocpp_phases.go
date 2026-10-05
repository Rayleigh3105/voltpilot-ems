package agent

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
)

// PHASENUMSCHALTUNG for OCPP stations (lastmgmt/phases.go holds the rule).
//
// A connector takes part only when BOTH sides said so: the operator allowed it
// in the wiring (`phase_switching`), and the station reported
// ConnectorSwitch3to1PhaseSupported=true. Everything else allocates exactly as
// before. The permanent safety profiles stay three-phase; only the live
// TxProfile carries numberPhases=1, and it expires with the box.

// ocppPhaseAskInterval bounds how often a station is asked again whether it
// can switch, when the operator allowed switching after it was set up.
const ocppPhaseAskInterval = 5 * time.Minute

// ocppPhaseHoldText is what a plug shows while a wanted switch is paced.
const ocppPhaseHoldText = "wartet — Phasenumschaltpause"

// ocppPhaseBands gives every eligible session its two bands and returns the
// keys that have them. Sessions of other connectors are not touched.
func (a *Agent) ocppPhaseBands(ctx context.Context, sessions []lastmgmt.Session, byKey map[string]ocppClaim,
	snap csms.Snapshot, control ocppcontrol.Policy, now time.Time) map[string]bool {
	rt := a.ocpp
	stations := map[string]csms.ChargerState{}
	for _, c := range snap.Chargers {
		stations[c.ID] = c
	}
	banded := map[string]bool{}
	for i := range sessions {
		claim, ok := byKey[sessions[i].Key]
		if !ok {
			continue // a virtual wallbox session
		}
		ranges, ok := control.SwitchRanges(claim.chargerID, claim.connectorID)
		if !ok {
			continue
		}
		station := stations[claim.chargerID]
		if !rt.phaseSwitchConfirmed(ctx, station, now) {
			continue
		}
		bands := make([]lastmgmt.PowerRange, 0, len(ranges))
		for _, r := range ranges {
			bands = append(bands, lastmgmt.PowerRange{Phases: r.Phases, MinKw: r.MinKw, MaxKw: r.MaxKw})
		}
		sessions[i].Ranges = lastmgmt.BandsOf(bands)
		rt.phasePacerFor(sessions[i].Key, claim.transactionID, commandedPhases(station, claim.connectorID))
		banded[sessions[i].Key] = true
	}
	return banded
}

// phaseSwitchConfirmed reports the station's own answer, asking it again (at a
// slow cadence) while it has none - a switch allowed after commissioning
// triggers no new commissioning.
func (rt *ocppRuntime) phaseSwitchConfirmed(ctx context.Context, c csms.ChargerState, now time.Time) bool {
	if v := c.Capabilities.PhaseSwitch; v != nil {
		return *v
	}
	if !c.Connected || !c.Capabilities.Read {
		return false
	}
	rt.mu.Lock()
	due := now.Sub(rt.phaseAsked[c.ID]) >= ocppPhaseAskInterval
	if due {
		rt.phaseAsked[c.ID] = now
	}
	rt.mu.Unlock()
	if !due {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, ocppCallTimeout)
	defer cancel()
	if err := rt.srv.RefreshPhaseSwitch(cctx, c.ID); err != nil {
		slog.Info("Ladesäule meldet nicht, ob sie auf eine Phase umschalten kann — sie lädt weiter dreiphasig",
			"charge_point_id", c.ID, "err", err)
		return false
	}
	for _, fresh := range rt.srv.Snapshot().Chargers {
		if fresh.ID == c.ID && fresh.Capabilities.PhaseSwitch != nil {
			return *fresh.Capabilities.PhaseSwitch
		}
	}
	return false
}

// commandedPhases is the phase count the station last accepted for a plug, 0
// when unknown.
func commandedPhases(c csms.ChargerState, connectorID int) int {
	for _, con := range c.Connectors {
		if con.ID == connectorID && (con.CommandedPhases == 1 || con.CommandedPhases == 3) {
			return con.CommandedPhases
		}
	}
	return 0
}

// phasePacerFor returns the pacing state of one plug, starting over for a new
// transaction. A new state starts from what the station last accepted, else
// from its three-phase default profile.
func (rt *ocppRuntime) phasePacerFor(key string, transactionID, commanded int) *lastmgmt.PhasePacer {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	p, ok := rt.phases[key]
	if !ok || p.TransactionID != transactionID {
		active := commanded
		if active == 0 {
			active = 3
		}
		fresh := lastmgmt.NewPhasePacer(active, transactionID)
		fresh.Dwell, fresh.Pause = rt.phaseDwell, rt.phasePause
		p = &fresh
		rt.phases[key] = p
	}
	return p
}

// ocppPaceSwitches feeds the free decision's bands to the pacers and narrows
// every session whose switch is not yet allowed to its ACTIVE band. true = the
// decision has to be taken again under the narrowed bands.
func (rt *ocppRuntime) ocppPaceSwitches(sessions []lastmgmt.Session, banded map[string]bool,
	plan lastmgmt.Plan, now time.Time) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	narrowed := false
	for i := range sessions {
		key := sessions[i].Key
		p := rt.phases[key]
		if !banded[key] || p == nil {
			continue
		}
		alloc, _ := plan.Get(key)
		if p.Observe(now, alloc.Phases) {
			continue
		}
		sessions[i].Ranges = sessions[i].Ranges.OnlyActive(p.Active)
		narrowed = true
	}
	return narrowed
}

// ocppPhasesFor is the phase count to command for an allocation: its band,
// or - while paused - the position the plug already holds. 0 = not a switching
// plug, which keeps the plain three-phase command.
func (rt *ocppRuntime) ocppPhasesFor(alloc lastmgmt.Allocation, banded map[string]bool) int {
	if !banded[alloc.Key] {
		return 0
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	p := rt.phases[alloc.Key]
	if p == nil {
		return 0
	}
	if alloc.Phases == 1 || alloc.Phases == 3 {
		return alloc.Phases
	}
	return p.Active
}

// ocppPhaseSwitched records a command the station ACCEPTED.
func (rt *ocppRuntime) ocppPhaseSwitched(key string, phases int, now time.Time) {
	if phases == 0 {
		return
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if p := rt.phases[key]; p != nil {
		if phases != p.Active {
			slog.Info("Ladepunkt schaltet die Phasen um",
				"key", key, "from", p.Active, "to", phases)
		}
		p.Switched(now, phases)
	}
}

// ocppForgetPhases drops the state of a plug whose session ended.
func (rt *ocppRuntime) ocppForgetPhases(key string) {
	rt.mu.Lock()
	delete(rt.phases, key)
	rt.mu.Unlock()
}

// ocppPhaseView is what the surface shows for one plug: the phase count and,
// while a switch is held back, why.
func (rt *ocppRuntime) ocppPhaseView(chargerID string, connectorID int) (int, string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	p := rt.phases[chargerID+"#"+fmt.Sprint(connectorID)]
	if p == nil {
		return 0, ""
	}
	if p.Held() {
		return p.Active, ocppPhaseHoldText
	}
	return p.Active, ""
}
