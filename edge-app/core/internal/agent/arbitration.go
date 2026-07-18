package agent

// The E2 arbitration wiring (contract: docs/contracts/v2/
// edge-desired-arbitration.md + mqtt-schedule-2.0.md + plan-execution-
// ownership.md; the pure engine lives in internal/desired, the v2 plan model
// in internal/plan2). The agent:
//
//   - subscribes edge/entities/+/desired and feeds the arbiter (D-7: desires
//     are never retained; expiry falls back per entity registry failsafe),
//   - injects the ACTIVE plan slot per entity as a standing class-'market'
//     desired - from the v2 plan (…/v2/plan) and, for the battery entity
//     during the shadow phase, from the v1 plan ("v1 controls"),
//   - withdraws plan desires on staleness (fallback events) and when a new
//     plan omits an entity (release),
//   - lets a WINNING non-plan desired drive the physical v1 write path
//     (applySetpoint consults arb.HolderCommand - the certified driver keeps
//     executing edge/setpoint, so flows still never write registers),
//   - bridges the v1 control readback onto the battery entity's per-entity
//     readback topic and folds per-entity decisions into the heartbeat.
//
// A device without a pushed registry has no entities, so every hook here is a
// no-op: the v1 path stays byte-for-byte.

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

// Local-bus subscription ids (1-6 are taken in Start / the entity layer).
const (
	desiredSubscriptionID  = 7
	readbackSubscriptionID = 8
)

// newArbiter builds the arbitration engine with the agent's environment.
func (a *Agent) newArbiter() *desired.Arbiter {
	return desired.New(desired.Deps{
		Now:     func() time.Time { return time.Now().UTC() },
		Reading: a.entityGuardReading,
		EnvLimits: func() *guards.Limits {
			return &guards.Limits{
				MaxChargeKw:    a.Cfg.MaxChargeKw,
				MaxDischargeKw: a.Cfg.MaxDischargeKw,
				SocMinPct:      a.Cfg.SocMinPct,
				SocMaxPct:      a.Cfg.SocMaxPct,
			}
		},
		ExtraSolarOnly: func() bool {
			// The v1 plan's posture composes ONLY while a v1 plan exists (the
			// shadow phase - v1 controls). A pure-v2 device is governed by the
			// registry's D-9 config + the v2 plan's per-entity D-8 field; the
			// v1 nil-plan fail-safe must not force solar-only onto it.
			a.mu.Lock()
			p := a.currentPlan
			a.mu.Unlock()
			return p != nil && p.SolarOnlyCharge()
		},
		PeakShave: func(now time.Time, kw float64, l guards.Limits, r guards.Reading) (float64, bool) {
			target := a.composedPeakTarget()
			if target == nil {
				return kw, false
			}
			allowed, ok := a.peak.AllowedImport(now, *target)
			if !ok {
				return kw, false
			}
			return guards.PeakShave(kw, allowed, l, r), true
		},
		ControlEnabled: func() bool {
			a.invMu.Lock()
			family := ""
			if a.inv != nil {
				family = a.inv.Family
			}
			a.invMu.Unlock()
			return a.Cfg.ControlEnabled && a.Cfg.ControlCertified(family)
		},
		StorageFailsafe: a.storageFailsafe,
		PublishCommand: func(entityID string, payload []byte) {
			a.publishEntityRetained(entities.CommandTopic(entityID), payload)
		},
		PublishEvent: func(entityID string, payload []byte) {
			if a.Bus == nil {
				return
			}
			if err := a.Bus.Publish(desired.ArbitrationTopic(entityID), payload, false); err != nil {
				slog.Error("arbitration event publish failed", "entity", entityID, "err", err)
			}
		},
		OnDecision: func(entityID string) {
			// A decision changed. When it concerns the battery entity, nudge
			// the v1 execution path so edge/setpoint follows promptly. Async:
			// the arbiter's mutex is held here, and applySetpoint queries the
			// arbiter back.
			if entityID == a.batteryEntityID() {
				a.pokeArbitration()
			}
		},
	})
}

// storageFailsafe is the registry 'self-consumption' failsafe: the v1
// fallback (PV - load), composed with the surviving peak reserve exactly like
// applySetpoint's fallback branch. ok=false without any usable reading -
// never regulate blind.
func (a *Agent) storageFailsafe(entityID string, r guards.Reading) (float64, bool) {
	if math.IsNaN(r.PvKw) && math.IsNaN(r.LoadKw) && math.IsNaN(r.SocPct) {
		return 0, false
	}
	fb := guards.SelfConsumption(r)
	if res := a.reserveFor(entityID); res != nil && fb < 0 && !math.IsNaN(r.SocPct) && r.SocPct <= *res {
		fb = 0
	}
	return fb, true
}

// startArbitration wires the local half: the desired + readback wildcard
// subscriptions and the executor/expiry loop.
func (a *Agent) startArbitration(ctx context.Context) error {
	if err := a.Bus.Subscribe(desired.DesiredWildcard, desiredSubscriptionID, a.onEntityDesired); err != nil {
		return err
	}
	if err := a.Bus.Subscribe(entities.TopicPrefix+"+/readback", readbackSubscriptionID,
		a.onEntityReadback); err != nil {
		return err
	}
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.arbitrationLoop(ctx)
	}()
	return nil
}

// onEntityDesired ingests one desired payload from the local bus.
func (a *Agent) onEntityDesired(topic string, payload []byte) {
	id := entities.IDFromTopic(topic, "desired")
	if id == "" {
		return
	}
	a.arb.Submit(id, payload)
}

// onEntityReadback records the per-entity register-level readback verdict
// (v1 payload shape per entity - localbus.go). Feeds the heartbeat's
// per-entity all_match.
func (a *Agent) onEntityReadback(topic string, payload []byte) {
	id := entities.IDFromTopic(topic, "readback")
	if id == "" {
		return
	}
	var m struct {
		AllMatch *bool `json:"all_match"`
	}
	if err := json.Unmarshal(payload, &m); err != nil || m.AllMatch == nil {
		return
	}
	a.arbMu.Lock()
	if a.entReadback == nil {
		a.entReadback = map[string]*bool{}
	}
	a.entReadback[id] = m.AllMatch
	a.arbMu.Unlock()
}

// arbitrationLoop drives the plan executors and the arbiter's expiry/reclamp
// tick: every second (cheap no-op without entities), plus immediately on a
// decision nudge.
func (a *Agent) arbitrationLoop(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-a.arbWake:
			// A decision just changed: re-run the v1 write path promptly so
			// edge/setpoint follows the arbitration winner.
			a.applySetpoint(time.Now().UTC())
			continue
		}
		now := time.Now().UTC()
		a.runPlanExecutors(now)
		a.arb.Tick()
	}
}

// pokeArbitration nudges the loop without blocking.
func (a *Agent) pokeArbitration() {
	select {
	case a.arbWake <- struct{}{}:
	default:
	}
}

// onPlanV2 handles the retained …/v2/plan payload. Empty payload = retained
// clear: the plan's desires are withdrawn and the latched postures cleared.
func (a *Agent) onPlanV2(payload []byte) {
	now := time.Now().UTC()
	if len(payload) == 0 {
		a.arbMu.Lock()
		a.curPlan2 = nil
		a.peak2 = nil
		a.reserve2 = nil
		a.arbMu.Unlock()
		if a.plan2Store != nil {
			if err := a.plan2Store.Clear(); err != nil {
				slog.Warn("v2 plan store clear failed", "err", err)
			}
		}
		a.runPlanExecutors(now)
		return
	}
	p, err := plan2.Parse(payload, now)
	if err != nil {
		slog.Warn("v2 plan payload rejected", "err", err)
		return
	}
	snap := a.State.Get()
	if p.DeviceID != "" && snap.DeviceID != "" && p.DeviceID != snap.DeviceID {
		slog.Warn("v2 plan for another device ignored", "payload_device", p.DeviceID)
		return
	}
	a.applyPlan2(p, now)
	if a.plan2Store != nil {
		if err := a.plan2Store.Save(payload, now); err != nil {
			slog.Warn("v2 plan not persisted", "err", err)
		}
	}
	slog.Info("v2 plan cached", "plan_id", p.PlanID, "entities", len(p.Entities),
		"slot_minutes", p.SlotMinutes)
}

// applyPlan2 latches the plan + its staleness SURVIVORS (x-failsafe): the
// site peak target and per-entity reserves persist across staleness and are
// cleared only by a NEW plan that omits them.
func (a *Agent) applyPlan2(p *plan2.Plan, now time.Time) {
	a.arbMu.Lock()
	a.curPlan2 = p
	a.peak2 = p.GridImportLimitKw
	reserves := map[string]*float64{}
	for _, e := range p.Entities {
		if e.ReserveSocPct != nil {
			v := *e.ReserveSocPct
			reserves[e.ID] = &v
		}
	}
	a.reserve2 = reserves
	a.arbMu.Unlock()
	a.runPlanExecutors(now)
	a.arb.Tick()
	a.pokeArbitration()
}

// runPlanExecutors injects the ACTIVE slot of every planned entity as a
// standing market desired (schedule-2.0 §5) and withdraws entities the plans
// no longer command. The v1 plan drives the battery entity while no v2 plan
// commands it (the shadow phase - v1 controls).
func (a *Agent) runPlanExecutors(now time.Time) {
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	if len(reg.Entities) == 0 {
		return
	}
	a.arbMu.Lock()
	v2 := a.curPlan2
	prevHeld := a.planHeld
	a.arbMu.Unlock()

	held := map[string]string{}
	// The v1 plan commands the battery entity FIRST: while both plan eras
	// exist (the E13a shadow phase - "v2 publishes, v1 controls"), the v1
	// plan stays authoritative for the one entity it knows.
	if batt := reg.FirstOfType(entities.TypeBatteryHybrid); batt != nil {
		a.mu.Lock()
		p := a.currentPlan
		a.mu.Unlock()
		if raw, slotStart, ok := p.ActiveSetpoint(now); ok {
			cmds := entities.Commands{SetpointKw: &raw}
			if lim := p.ActivePvLimit(now); lim != nil && *lim >= 0 {
				v := *lim
				cmds.LimitKw = &v
			}
			ttl := p.ReceivedAt.Add(plan.StaleAfter).Sub(now)
			if ttl >= time.Second {
				a.arb.SubmitInternal(&desired.Desired{
					EntityID:  batt.ID,
					RequestID: "plan:v1:" + slotStart.UTC().Format(time.RFC3339),
					Source:    desired.Source{Kind: desired.SourcePlanExecutor},
					Priority:  desired.ClassMarket,
					TTL:       ttl,
					IssuedAt:  now,
					Commands:  cmds,
					SolarOnly: p.SolarOnlyCharge(),
				})
				held[batt.ID] = "v1"
			}
		}
	}

	// The v2 plan drives every entity the v1 plan does not command.
	if v2 != nil && v2.Fresh(now) {
		for _, pe := range v2.Entities {
			if held[pe.ID] != "" {
				continue
			}
			if reg.Find(pe.ID) == nil {
				continue // unknown entity: logged-and-skipped territory
			}
			cmds, slotStart, ok := v2.ActiveCommands(pe.ID, now)
			if !ok {
				continue
			}
			ttl := v2.ReceivedAt.Add(plan2.StaleAfter).Sub(now)
			if ttl < time.Second {
				continue
			}
			a.arb.SubmitInternal(&desired.Desired{
				EntityID:  pe.ID,
				RequestID: "plan:" + v2.PlanID + ":" + slotStart.UTC().Format(time.RFC3339),
				Source:    desired.Source{Kind: desired.SourcePlanExecutor},
				Priority:  desired.ClassMarket,
				TTL:       ttl,
				IssuedAt:  now,
				Commands:  cmds,
				SolarOnly: !pe.ChargeFromGridAllowed, // D-8: absent/false = solar-only
			})
			held[pe.ID] = "v2"
		}
	}

	// Withdraw entities no plan commands anymore: stale plan -> fallback
	// (subject absent, per contract), otherwise release.
	for id := range prevHeld {
		if held[id] != "" {
			continue
		}
		stale := false
		switch prevHeld[id] {
		case "v2":
			stale = v2 == nil || !v2.Fresh(now)
		case "v1":
			a.mu.Lock()
			p := a.currentPlan
			a.mu.Unlock()
			stale = p == nil || !p.Fresh(now)
		}
		a.arb.Withdraw(id, desired.Source{Kind: desired.SourcePlanExecutor}.Key(), stale)
	}
	a.arbMu.Lock()
	a.planHeld = held
	a.arbMu.Unlock()
}

// composedPeakTarget is the effective PS-3 site import target: the v1 plan's
// (surviving staleness, as shipped) composed with the v2 plan's site-level
// target - the tighter one wins. nil = module off.
func (a *Agent) composedPeakTarget() *float64 {
	a.mu.Lock()
	p := a.currentPlan
	a.mu.Unlock()
	t1 := p.PeakImportLimit()
	a.arbMu.Lock()
	t2 := a.peak2
	a.arbMu.Unlock()
	switch {
	case t1 == nil:
		return t2
	case t2 == nil:
		return t1
	case *t2 < *t1:
		return t2
	default:
		return t1
	}
}

// reserveFor is the surviving per-entity peak reserve: the v2 plan's entity
// reserve, else the v1 plan's site-level reserve (battery entity only).
func (a *Agent) reserveFor(entityID string) *float64 {
	a.arbMu.Lock()
	if r, ok := a.reserve2[entityID]; ok {
		a.arbMu.Unlock()
		return r
	}
	a.arbMu.Unlock()
	if entityID != a.batteryEntityID() {
		return nil
	}
	a.mu.Lock()
	p := a.currentPlan
	a.mu.Unlock()
	return p.PeakReserveSoc()
}

// peakTargetV2 returns the latched v2 site peak target (nil = none).
func (a *Agent) peakTargetV2() *float64 {
	a.arbMu.Lock()
	defer a.arbMu.Unlock()
	return a.peak2
}

// reserveV2ForBattery returns the latched v2 reserve of the battery entity.
func (a *Agent) reserveV2ForBattery() *float64 {
	id := a.batteryEntityID()
	if id == "" {
		return nil
	}
	a.arbMu.Lock()
	defer a.arbMu.Unlock()
	return a.reserve2[id]
}

// batteryEntityID returns the registry's battery-hybrid entity id ("" = none).
func (a *Agent) batteryEntityID() string {
	a.entMu.Lock()
	defer a.entMu.Unlock()
	if e := a.entRegistry.FirstOfType(entities.TypeBatteryHybrid); e != nil {
		return e.ID
	}
	return ""
}

// mirrorReadbackToEntity republishes the v1 control readback on the battery
// entity's per-entity readback topic (same payload shape, per the entity
// contract §4) and records its verdict for the heartbeat. No-op without a
// battery entity.
func (a *Agent) mirrorReadbackToEntity(payload []byte, allMatch bool) {
	id := a.batteryEntityID()
	if id == "" || a.Bus == nil {
		return
	}
	if err := a.Bus.Publish(entities.ReadbackTopic(id), payload, false); err != nil {
		slog.Error("entity readback mirror failed", "entity", id, "err", err)
	}
	v := allMatch
	a.arbMu.Lock()
	if a.entReadback == nil {
		a.entReadback = map[string]*bool{}
	}
	a.entReadback[id] = &v
	a.arbMu.Unlock()
}

// arbitrationSummary builds the heartbeat's per-entity decision map.
func (a *Agent) arbitrationSummary() map[string]cloud.EntityArbitration {
	a.entMu.Lock()
	ids := a.entRegistry.IDs()
	a.entMu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	out := map[string]cloud.EntityArbitration{}
	for _, id := range ids {
		dec, ok := a.arb.DecisionFor(id)
		entry := cloud.EntityArbitration{}
		if ok {
			entry.Holder = dec.HolderKind
			entry.Source = dec.Source
			if dec.Granted.SetpointKw != nil {
				v := *dec.Granted.SetpointKw
				entry.GrantedSetpointKw = &v
			}
		}
		a.arbMu.Lock()
		if am, has := a.entReadback[id]; has {
			entry.AllMatch = am
		}
		a.arbMu.Unlock()
		if entry.Source != "" || entry.AllMatch != nil {
			out[id] = entry
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
