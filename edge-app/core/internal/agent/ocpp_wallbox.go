package agent

import (
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// This file is the P6 half that makes a go-e/Modbus WALLBOX a claimant of the
// SAME distributor the OCPP stations use (Konzept `vp-verbrauchsmgmt-konzept-v1`
// §4.3): the customer sees one „Ladepunkt", while the two protocols stay what
// they are - an OCPP station gets a charging profile, a wallbox gets its
// consumer setpoint.
//
// ⚠ THE PARTICIPATION RULE IS THE WHOLE SAFETY ARGUMENT, and it has exactly
// two halves that must hold TOGETHER:
//
//  1. A MEASUREMENT. The box's budget law is `budget = planbar − (Netzbezug −
//     Ladeleistung)`. A wallbox whose power nobody measures cannot be added
//     back, so it must stay BUILDING LOAD - which already protects the
//     connection (conservatively: the budget is smaller by its draw).
//  2. A LIVE GRANTED COMMAND. Only a command we may cap is a command we may
//     hand budget to. Without a fresh arbiter decision the executor RELEASES
//     the wallbox into its own logic (frc=Neutral, the §4.2 failsafe), so a
//     cap would be a promise nobody keeps.
//
// Add back what we cannot cap and the distributor would spend the same
// kilowatts twice: the OCPP stations would be handed the wallbox's power while
// it keeps drawing it. That is why the add-back and the claim are ONE
// predicate (`wallboxClaims`), evaluated from one snapshot.
//
// ⚠ AND IT IS LOOP-FREE BY CONSTRUCTION. The claim keys on the ARBITER's
// granted command, which is formed BEFORE our cap - so capping a wallbox to
// 0 kW never removes the evidence that made it a claimant, and it cannot
// oscillate between „managed" and „building load".

// wallboxMeterMaxAge is how fresh a wallbox's own `power_kw` must be to count
// as a measurement. It mirrors ocppMeterMaxAge: the two feed the same budget
// law and a different window would make the two halves disagree.
const wallboxMeterMaxAge = ocppMeterMaxAge

// wallboxClaim is one wallbox that takes part in this decision.
type wallboxClaim struct {
	cfg lastmgmt.Wallbox
	// measuredKw is its own fresh `power_kw` (>= 0). It is what the budget law
	// adds back and what the storage split subtracts.
	measuredKw float64
}

// wallboxState remembers the last decision per wallbox entity, so the consumer
// executor can apply the cap on its own cadence.
type wallboxState struct {
	mu    sync.Mutex
	caps  map[string]float64
	notes map[string]string
}

// wallboxClaims resolves which configured wallboxes take part right now, and
// names the ones that do not - an unmanaged wallbox that nobody mentions reads
// like a defect.
//
// ⚠ It is the ONE place the participation rule lives. The budget feed
// (ocppObserve) and the session build (ocppStep) both go through it, so they
// can never disagree about whose power was added back.
func (a *Agent) wallboxClaims(set lastmgmt.Settings, now time.Time) ([]wallboxClaim, map[string]string) {
	if len(set.Wallboxes) == 0 {
		return nil, nil
	}
	notes := map[string]string{}
	out := make([]wallboxClaim, 0, len(set.Wallboxes))
	for _, w := range set.Wallboxes {
		kw, measured := a.wallboxMeasuredKw(w.EntityID, now)
		if !measured {
			// ⚠ The honest half of §4.3: without a measurement it contributes
			// NO budget and is not capped by the distributor - its draw stays
			// building load, which already protects the connection, and its own
			// Steuerart keeps switching it on and off.
			notes[w.EntityID] = "ohne Leistungsmessung — sie zählt als Gebäudelast und wird vom Verteiler nicht gedeckelt"
			continue
		}
		if !a.wallboxCommanded(w.EntityID) {
			notes[w.EntityID] = "läuft gerade nach ihrer eigenen Steuerart — VoltPilot gibt ihr keinen Sollwert"
			continue
		}
		out = append(out, wallboxClaim{cfg: w, measuredKw: kw})
	}
	return out, notes
}

// wallboxMeasuredKw is the wallbox's own measured charging power. Absent /
// stale / negative = NOT a measurement (never a fabricated 0 - the house rule).
func (a *Agent) wallboxMeasuredKw(entityID string, now time.Time) (float64, bool) {
	a.entMu.Lock()
	er, ok := a.entityReading(entityID)
	a.entMu.Unlock()
	if !ok || er.recv.IsZero() || now.Sub(er.recv) > wallboxMeterMaxAge {
		return 0, false
	}
	kw, has := er.channels["power_kw"]
	if !has || math.IsNaN(kw) || math.IsInf(kw, 0) || kw < 0 {
		return 0, false
	}
	return kw, true
}

// wallboxCommanded reports whether the arbiter grants this wallbox a charge
// right now. It reads the GRANTED command, which is formed before our cap -
// see the loop-free note at the top of this file.
func (a *Agent) wallboxCommanded(entityID string) bool {
	if a.arb == nil {
		return false
	}
	dec, ok := a.arb.DecisionFor(entityID)
	if !ok {
		return false
	}
	return grantedOn(dec.Granted.OnOff, dec.Granted.SetpointKw)
}

// wallboxSessions turns the claiming wallboxes into virtual allocator sessions.
func (a *Agent) wallboxSessions(set lastmgmt.Settings, budgetKw float64, now time.Time) []lastmgmt.Session {
	claims, notes := a.wallboxClaims(set, now)
	a.noteWallboxNotes(notes)
	if len(claims) == 0 {
		return nil
	}
	out := make([]lastmgmt.Session, 0, len(claims))
	for _, c := range claims {
		maxKw := c.cfg.RatedKw
		if maxKw <= 0 {
			// No declared rating: the budget itself is the only honest ceiling
			// (the OCPP rule, verbatim).
			maxKw = budgetKw
		}
		out = append(out, lastmgmt.Session{
			Key: lastmgmt.WallboxKey(c.cfg.EntityID),
			// ⚠ A wallbox has no Vorrang flag - its place is its RANK. Setting
			// Priority would put every wallbox ahead of every station.
			MinKw: c.cfg.MinKw, MaxKw: maxKw,
			Source: c.cfg.Source,
			Rank:   c.cfg.Rank,
			BeforeStorage: lastmgmt.BeforeStorage(
				c.cfg.Rank, set.StorageRank, set.StoragePriority),
		})
	}
	return out
}

// wallboxChargingKw is what the CLAIMING wallboxes are measured drawing - the
// term the budget law adds back next to the OCPP stations'.
func (a *Agent) wallboxChargingKw(set lastmgmt.Settings, now time.Time) float64 {
	claims, _ := a.wallboxClaims(set, now)
	total := 0.0
	for _, c := range claims {
		total += c.measuredKw
	}
	return total
}

// noteWallboxCaps records this decision's wallbox allocations for the consumer
// executor. A wallbox that did not take part is FORGOTTEN rather than capped at
// 0 - the distributor made no statement about it.
func (a *Agent) noteWallboxCaps(plan lastmgmt.Plan) {
	caps := map[string]float64{}
	for _, alloc := range plan.Allocations {
		id, ok := lastmgmt.WallboxEntityID(alloc.Key)
		if !ok {
			continue
		}
		caps[id] = alloc.Kw
	}
	a.wallbox.mu.Lock()
	a.wallbox.caps = caps
	a.wallbox.mu.Unlock()
}

// noteWallboxNotes records why a configured wallbox is NOT taking part.
func (a *Agent) noteWallboxNotes(notes map[string]string) {
	a.wallbox.mu.Lock()
	a.wallbox.notes = notes
	a.wallbox.mu.Unlock()
}

// WallboxCapKw is the distributor's ceiling for one wallbox entity.
// ok=false = it is not a claimant right now, and then NOTHING about its command
// changes (the consumer executor keeps the arbiter's granted value).
//
// ⚠ RESTRICT-ONLY by construction: the caller may only ever LOWER with it.
func (a *Agent) WallboxCapKw(entityID string) (float64, bool) {
	a.wallbox.mu.Lock()
	defer a.wallbox.mu.Unlock()
	kw, ok := a.wallbox.caps[entityID]
	return kw, ok
}

// WallboxNote is the honest sentence for a configured wallbox that is not
// taking part ("" = it is, or it is not configured at all).
func (a *Agent) WallboxNote(entityID string) string {
	a.wallbox.mu.Lock()
	defer a.wallbox.mu.Unlock()
	return a.wallbox.notes[entityID]
}
