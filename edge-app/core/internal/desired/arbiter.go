package desired

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// Deps are the arbiter's environment, supplied by the agent. Every closure
// must be safe for concurrent use; nil optional hooks disable their feature.
type Deps struct {
	// Now is the clock (tests inject a fake).
	Now func() time.Time
	// Reading returns the guard context for one entity (its own latest
	// channels, falling back to the site reading - the E1a entityGuardReading).
	Reading func(entityID string) guards.Reading
	// EnvLimits is the v1 device-config band/SoC window composed into every
	// STORAGE setpoint clamp (most restrictive wins). nil = registry only.
	EnvLimits func() *guards.Limits
	// ExtraSolarOnly ORs the v1-plan-carried solar-only posture into storage
	// clamps (the plan.SolarOnlyCharge fail-safe). nil = false.
	ExtraSolarOnly func() bool
	// PeakShave lowers a storage setpoint for the PS-3 peak defense (runs
	// AFTER all compliance clamps, restrict-only). Returns the shaved value
	// and whether the guard was active. nil = off.
	PeakShave func(now time.Time, kw float64, l guards.Limits, r guards.Reading) (float64, bool)
	// ControlEnabled is the two-gate posture stamped onto entity commands.
	ControlEnabled func() bool
	// Suspended is the operator's „Automatik pausieren" (Steuerung Stufe 4,
	// §3.7 B5). While it holds, the arbiter IGNORES every desire in the market
	// class or below - the plan executors already inject nothing, so every
	// entity falls to its REGISTRY FAILSAFE: the battery to self-consumption,
	// a device to release/off. That is the honest reading of „so, als gäbe es
	// VoltPilot nicht", and it is the ONE value the cloud could never have
	// sent as a setpoint (PV − load is the box's own arithmetic).
	//
	// ⚠ It is a GATE, not a rank change: D-4's classes and their order are
	// untouched, and everything ABOVE market (contract, grid, safety) keeps
	// binding - a pause must never suspend a compliance command. nil = never
	// suspended, which is byte-for-byte the pre-Stufe-4 behaviour.
	Suspended func() bool
	// StorageFailsafe computes a storage entity's registry failsafe value
	// (self-consumption composed with the reserve floor, the v1 fallback).
	// ok=false = no usable reading, command nothing (never regulate blind).
	StorageFailsafe func(entityID string, r guards.Reading) (float64, bool)
	// PublishCommand publishes the retained per-entity command (nil payload =
	// retained-clear). PublishEvent publishes one arbitration event.
	PublishCommand func(entityID string, payload []byte)
	// PublishEvent publishes one arbitration event (never retained, D-7).
	PublishEvent func(entityID string, payload []byte)
	// OnDecision, when set, is nudged after a decision changed an entity's
	// granted command (the agent re-runs the v1 setpoint path for the battery).
	OnDecision func(entityID string)
	// CycleLocation is the site-local timezone for the consumer cycle guard's
	// per-day start budget (Verbrauchssteuerung §13.1). nil = time.Local (the
	// device clock, which v1 pins to the site's own time).
	CycleLocation *time.Location
}

// Reason is one machine-readable event reason ({stage, detail}).
type Reason struct {
	Stage  string `json:"stage"`
	Detail string `json:"detail,omitempty"`
}

// Decision is the per-entity arbitration snapshot for the heartbeat / UI.
type Decision struct {
	// HolderKind is the holder's source kind, "" when the registry failsafe
	// runs. Source is the command-topic vocabulary: plan|desired|failsafe.
	HolderKind string
	Source     string
	Granted    entities.Commands
	// HolderOverride reports the holder's D-5 override elevation (a must-run
	// flow desire) - the heartbeat's running_forced vs running_optimized split.
	HolderOverride bool
	// HolderRank is the holder's EFFECTIVE rank (desired.go effectiveRank):
	// safety 100 > grid 90 > contract 80 > manual 75 > flow+override 70 >
	// market 60 > deadline-fallback 50 > flow 40. 0 = no holder.
	//
	// It exists for the K3 charge-point bridge (Verbrauchsmanagement v1),
	// which has to tell a DUE duty (>= 50) from a plain opportunistic wish
	// (40) - HolderKind names the SOURCE, never the standing.
	HolderRank int
	// Clamped reports that the granted command differs from the holder's wish
	// (some guard bit).
	Clamped bool
	// Cycle is the consumer cycle guard's active hold, nil when none.
	Cycle *guards.CycleHold
}

type entState struct {
	entity  entities.Entity
	desires map[string]*Desired // by Source.Key()

	holderKey  string // "" = failsafe
	inFailsafe bool   // fallback event already emitted for this failsafe episode

	// cycle is the stateful consumer cycle guard (nil for non-consumers): the
	// ONE temporal clamp every consumer command runs through - plan desires,
	// flow desires and the failsafe alike (Verbrauchssteuerung §13.1).
	cycle *guards.CycleGuard

	lastGranted     entities.Commands
	lastSource      string
	lastFingerprint string
	lastClamped     bool
	lastCycle       *guards.CycleHold
	commandCleared  bool // retained command currently cleared
}

// Arbiter arbitrates desires per entity and derives the core-owned retained
// command (the ONLY actuation output - D-10).
type Arbiter struct {
	mu     sync.Mutex
	deps   Deps
	states map[string]*entState
}

// New builds an arbiter with no entities.
func New(deps Deps) *Arbiter {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	return &Arbiter{deps: deps, states: map[string]*entState{}}
}

// SetEntities swaps the registry view: states for removed entities are
// dropped (their retained command clearing is the registry apply's job, like
// E1a), desires for surviving entities are kept.
func (a *Arbiter) SetEntities(reg entities.Registry) {
	a.mu.Lock()
	defer a.mu.Unlock()
	next := map[string]*entState{}
	for _, e := range reg.Entities {
		if st, ok := a.states[e.ID]; ok {
			st.entity = e
			st.syncCycleGuard(a.deps.CycleLocation)
			next[e.ID] = st
		} else {
			// A fresh entity STARTS in its registry failsafe - that is the
			// default state, not an event-worthy transition (fallback events
			// mark the FALL from a commanded state).
			st := &entState{entity: e, desires: map[string]*Desired{}, inFailsafe: true}
			st.syncCycleGuard(a.deps.CycleLocation)
			next[e.ID] = st
		}
	}
	a.states = next
}

// syncCycleGuard creates/updates the consumer cycle guard from the entity's
// registry limits. Non-consumers (and actuate-less composed types like
// house-load) never get one; a registry re-push updates the limits WITHOUT
// resetting the timing state.
func (st *entState) syncCycleGuard(loc *time.Location) {
	if st.entity.Category() != "consumer" || len(st.entity.Capabilities.Actuate) == 0 {
		st.cycle = nil
		return
	}
	if st.cycle == nil {
		st.cycle = guards.NewCycleGuard(st.entity.CycleLimits(), loc)
		return
	}
	st.cycle.SetLimits(st.entity.CycleLimits())
}

// Submit ingests one EXTERNAL desired payload from the local bus. Every
// admissible request is answered with an arbitration event; identity
// mismatches and unknown entities are silently ignored (the v1 rule).
func (a *Arbiter) Submit(topicEntityID string, payload []byte) {
	now := a.deps.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	st, known := a.states[topicEntityID]
	if !known {
		slog.Debug("desired for unknown entity ignored", "entity", topicEntityID)
		return
	}
	d, err := Parse(topicEntityID, payload, now)
	if err != nil {
		if _, mismatch := err.(*IdentityMismatchError); mismatch {
			slog.Debug("desired identity mismatch ignored", "entity", topicEntityID, "err", err)
			return
		}
		pe, ok := err.(*ParseError)
		if !ok {
			pe = schemaErr("%v", err)
		}
		// Correlate the refusal when the payload identifies itself well enough.
		if ref := lenientRef(payload); ref != nil {
			a.emitEvent(st, now, "rejected", ref, nil, nil,
				[]Reason{{Stage: pe.Stage, Detail: pe.Detail}}, a.holderRef(st))
		} else {
			slog.Debug("unidentifiable desired dropped", "entity", topicEntityID, "err", pe)
		}
		return
	}
	a.admit(st, d, now, false)
}

// SubmitInternal ingests a core-built desired (the plan executor's market
// injection). quiet: events are emitted only when the decision CHANGES, so
// the standing re-injection every tick stays silent.
func (a *Arbiter) SubmitInternal(d *Desired) {
	now := a.deps.Now()
	d.receivedAt = now
	a.mu.Lock()
	defer a.mu.Unlock()
	st, known := a.states[d.EntityID]
	if !known {
		return
	}
	a.admit(st, d, now, true)
}

// Withdraw removes a source's desired from an entity (plan release / stale
// plan). stale=true marks the plan-staleness fall (fallback event, subject
// absent, per the contract's example); otherwise a release event names the
// withdrawn desired. No-op when the source holds nothing.
func (a *Arbiter) Withdraw(entityID, sourceKey string, stale bool) {
	now := a.deps.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.states[entityID]
	if !ok {
		return
	}
	d, had := st.desires[sourceKey]
	if !had {
		return
	}
	delete(st.desires, sourceKey)
	wasHolder := st.holderKey == sourceKey
	if !wasHolder {
		return
	}
	st.holderKey = ""
	next := a.selectHolder(st, now)
	if next != nil {
		st.holderKey = next.Source.Key()
		a.applyDecision(st, now, next, eventCtx{
			outcome: "released", subject: d.Ref(),
			reasons: []Reason{{Stage: "arbitration:ttl", Detail: "released by emitter"}},
			force:   true,
		})
		return
	}
	if stale {
		a.fallToFailsafe(st, now, nil,
			[]Reason{{Stage: "plan:stale", Detail: "plan no longer fresh; market desires withdrawn"}})
	} else {
		a.fallToFailsafe(st, now, d.Ref(),
			[]Reason{{Stage: "arbitration:ttl", Detail: "released by emitter"}})
	}
}

// Tick advances time: expires desires, re-clamps the holder against the
// latest reading, refreshes the failsafe, republishes the retained command.
// The agent calls it on the setpoint cadence and after telemetry.
func (a *Arbiter) Tick() {
	now := a.deps.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, st := range a.states {
		a.tickEntity(st, now)
	}
}

// DecisionFor returns the current decision for one entity, ok=false when the
// entity is unknown or nothing is commanded (failsafe with no output).
func (a *Arbiter) DecisionFor(entityID string) (Decision, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.states[entityID]
	if !ok || (st.lastSource == "" && st.lastGranted.Empty()) {
		return Decision{}, false
	}
	dec := Decision{Source: st.lastSource, Granted: st.lastGranted,
		Clamped: st.lastClamped, Cycle: st.lastCycle}
	if st.holderKey != "" {
		if d := st.desires[st.holderKey]; d != nil {
			dec.HolderKind = string(d.Source.Kind)
			dec.HolderOverride = d.Override
			dec.HolderRank = d.effectiveRank()
		}
	}
	return dec, true
}

// CycleStateFor returns the consumer cycle guard's snapshot for one entity
// (ok=false for unknown entities and non-consumers). Feeds the heartbeat's
// consumers block (starts/runtime today, the active hold).
func (a *Arbiter) CycleStateFor(entityID string) (guards.CycleState, bool) {
	a.mu.Lock()
	st, ok := a.states[entityID]
	var g *guards.CycleGuard
	if ok {
		g = st.cycle
	}
	a.mu.Unlock()
	if g == nil {
		return guards.CycleState{}, false
	}
	return g.State(a.deps.Now()), true
}

// HolderCommand returns the granted command set + source kind of the desire
// currently HOLDING an entity - the hook the v1 execution path uses to let
// the arbitration winner drive the physical battery write (a flow/override
// winner, or the plan executor's market desire on a pure-v2 device). ok=false
// = no holder (registry failsafe); the v1 path stays authoritative then.
func (a *Arbiter) HolderCommand(entityID string) (entities.Commands, SourceKind, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.states[entityID]
	if !ok || st.holderKey == "" {
		return entities.Commands{}, "", false
	}
	d := st.desires[st.holderKey]
	if d == nil || a.suspended(d) {
		// Close the registry-push race: the physical v1 path must not observe a
		// just-suspended incumbent before the next Tick has moved the entity to
		// failsafe. Contract/grid/safety holders are not suspended and pass.
		return entities.Commands{}, "", false
	}
	return st.lastGranted, d.Source.Kind, true
}

// --- internals --------------------------------------------------------------

// admit runs the D-6 resolution order for one incoming desired.
func (a *Arbiter) admit(st *entState, d *Desired, now time.Time, quiet bool) {
	if d.Expired(now) {
		if !quiet {
			a.emitEvent(st, now, "rejected", d.Ref(), requestedOf(d), nil,
				[]Reason{{Stage: "arbitration:ttl", Detail: "desired already expired at receipt"}},
				a.holderRef(st))
		}
		return
	}
	// Capability gate: every wished command must be declared actuatable.
	if reason, ok := a.capabilityGate(st.entity, d); !ok {
		if !quiet {
			a.emitEvent(st, now, "rejected", d.Ref(), requestedOf(d), nil,
				[]Reason{reason}, a.holderRef(st))
		}
		return
	}

	key := d.Source.Key()
	a.pruneExpired(st, now)
	holder := st.currentHolder()

	// Same-class conflict (D-6): the holder keeps the entity; a same-class
	// challenger from ANOTHER source is rejected outright - deliberately no
	// last-writer-wins, no queueing (re-emission after the holder's TTL lapse
	// wins then). Override never helps here: the rule binds on the CLASS.
	//
	// D-6a is the ONE exemption: a MANUAL INTERVENTION (local-ui + override) is
	// the only wish with a person behind it, so a holding rule must not lock it
	// out. The exemption covers BOTH directions of the pairing, each for its own
	// reason:
	//   - manual CHALLENGER: it must be able to preempt a holding rule at all
	//     (that is K1 - before it, "Jetzt stoppen" was rejected outright while
	//     the rule kept renewing its wish every 15 s).
	//   - manual HOLDER: the rule then falls through to the normal priority
	//     path, so it is STORED and rejected with the honest arbitration:priority
	//     reason - and its 15-s re-emission keeps that stored copy alive, so the
	//     rule resumes SEAMLESSLY (contract §5 next-highest) when the
	//     intervention expires instead of leaving a failsafe gap.
	// Two manual interventions never reach here: source local-ui holds ONE slot
	// per entity, so the later one REPLACES the earlier (Source.Key) - exactly
	// the human expectation.
	manualPair := d.manualIntervention() || holder.manualIntervention()
	if holder != nil && !manualPair && holder.Source.Key() != key && holder.Priority == d.Priority {
		if !quiet {
			a.emitEvent(st, now, "rejected", d.Ref(), requestedOf(d), nil,
				[]Reason{{Stage: "arbitration:conflict",
					Detail: "entity held by a same-class desired until its TTL lapses"}},
				holder.Ref())
		}
		return
	}

	st.desires[key] = d
	prevHolderKey := st.holderKey
	best := a.selectHolder(st, now)
	if best == nil {
		return // cannot happen: d itself is active
	}
	st.holderKey = best.Source.Key()

	if best.Source.Key() != key {
		// The newcomer did not win: a higher class holds. It stays stored and
		// resumes when the holder expires (contract §5 next-highest rule).
		if !quiet {
			a.emitEvent(st, now, "rejected", d.Ref(), requestedOf(d), nil,
				[]Reason{{Stage: "arbitration:priority",
					Detail: fmt.Sprintf("a higher-priority desired holds the entity (%s)", best.Priority)}},
				best.Ref())
		}
		return
	}

	// The newcomer holds. A displaced previous holder is superseded (it stays
	// stored and resumes on the winner's expiry, contract §4 rule 1).
	var arbitrationReasons []Reason
	if prevHolderKey != "" && prevHolderKey != key {
		if prev := st.desires[prevHolderKey]; prev != nil {
			a.emitEvent(st, now, "superseded", prev.Ref(), requestedOf(prev), nil,
				[]Reason{{Stage: "arbitration:priority",
					Detail: fmt.Sprintf("preempted by class %s", d.Priority)}}, d.Ref())
		}
	}
	if d.manualIntervention() {
		arbitrationReasons = append(arbitrationReasons,
			Reason{Stage: "arbitration:override",
				Detail: "manual intervention elevated above plan and rules for its TTL"})
	} else if d.Priority == ClassFlow && d.Override {
		arbitrationReasons = append(arbitrationReasons,
			Reason{Stage: "arbitration:override", Detail: "flow desired elevated above market for its TTL"})
	}
	a.applyDecision(st, now, d, eventCtx{subject: d.Ref(), reasons: arbitrationReasons, force: !quiet})
}

// capabilityGate checks every wished command against the registry capability
// set (grid meters have none - measure-only by construction).
func (a *Arbiter) capabilityGate(e entities.Entity, d *Desired) (Reason, bool) {
	unsupported := func(cmd string) (Reason, bool) {
		return Reason{Stage: "capability:unsupported_command",
			Detail: fmt.Sprintf("entity %s does not actuate %s", e.ID, cmd)}, false
	}
	c := d.Commands
	if c.SetpointKw != nil && !e.Supports(entities.CmdSetpointKw) {
		return unsupported(entities.CmdSetpointKw)
	}
	if c.LimitKw != nil && !e.Supports(entities.CmdLimitKw) {
		return unsupported(entities.CmdLimitKw)
	}
	if c.LimitPct != nil && !e.Supports(entities.CmdLimitPct) {
		return unsupported(entities.CmdLimitPct)
	}
	if c.OnOff != nil && !e.Supports(entities.CmdOnOff) {
		return unsupported(entities.CmdOnOff)
	}
	if c.Mode != "" && !e.Supports(entities.CmdMode) {
		return unsupported(entities.CmdMode)
	}
	return Reason{}, true
}

// pruneExpired drops lapsed desires; the HOLDER's expiry emits the contract's
// expired event with the follow-up holder (or the fall to failsafe).
func (a *Arbiter) pruneExpired(st *entState, now time.Time) {
	holderExpired := (*Desired)(nil)
	for key, d := range st.desires {
		if !d.Expired(now) {
			continue
		}
		if key == st.holderKey {
			holderExpired = d
		}
		delete(st.desires, key)
	}
	if holderExpired == nil {
		return
	}
	st.holderKey = ""
	next := a.selectHolder(st, now)
	if next != nil {
		st.holderKey = next.Source.Key()
		a.applyDecision(st, now, next, eventCtx{
			outcome: "expired", subject: holderExpired.Ref(),
			reasons: []Reason{{Stage: "arbitration:ttl", Detail: "holder TTL lapsed"}},
			force:   true,
		})
		return
	}
	a.fallToFailsafe(st, now, holderExpired.Ref(),
		[]Reason{{Stage: "arbitration:ttl", Detail: "holder TTL lapsed"}})
}

// currentHolder returns the holder desire, nil in failsafe.
func (st *entState) currentHolder() *Desired {
	if st.holderKey == "" {
		return nil
	}
	return st.desires[st.holderKey]
}

// selectHolder picks the highest-ranked active desired; the CURRENT holder
// wins rank ties, otherwise the earliest-received (deterministic, no
// oscillation).
func (a *Arbiter) selectHolder(st *entState, now time.Time) *Desired {
	var best *Desired
	for _, d := range st.desires {
		if d.Expired(now) {
			continue
		}
		if a.suspended(d) {
			// „Automatik pausieren": plan, rules and manual wishes rest;
			// compliance (contract/grid/safety) never does.
			continue
		}
		if best == nil {
			best = d
			continue
		}
		switch {
		case d.effectiveRank() > best.effectiveRank():
			best = d
		case d.effectiveRank() == best.effectiveRank():
			if d.Source.Key() == st.holderKey {
				best = d
			} else if best.Source.Key() != st.holderKey && d.receivedAt.Before(best.receivedAt) {
				best = d
			}
		}
	}
	return best
}

// suspended keys on the desired's CLASS, not its effective arbitration rank:
// a bounded local-ui override is still a flow-class manual wish even though
// D-5/D-6a elevate it above market and above a rule (rank 75) during normal
// operation. Plant rest suspends ordinary, override AND manual wishes while
// preserving contract/grid/safety - „Automatik pausieren" stays a GATE, and
// K1 deliberately did not touch it.
func (a *Arbiter) suspended(d *Desired) bool {
	return d != nil && a.deps.Suspended != nil && a.deps.Suspended() &&
		d.Priority.rank() <= ClassMarket.rank()
}

// tickEntity re-evaluates one entity: expiry, holder re-clamp, failsafe.
func (a *Arbiter) tickEntity(st *entState, now time.Time) {
	a.pruneExpired(st, now)
	holder := st.currentHolder()
	if a.suspended(holder) {
		// A pause can arrive while a manual override already holds the entity.
		// Re-select now; merely filtering future selections would leave that
		// incumbent active until its TTL and defeat the plant-rest command.
		st.holderKey = ""
		holder = nil
	}
	if holder != nil {
		a.applyDecision(st, now, holder, eventCtx{subject: holder.Ref()})
		return
	}
	if st.holderKey != "" {
		// The holder vanished without pruning noticing (defensive).
		st.holderKey = ""
	}
	// Also resumes a still-live wish from the failsafe when a plant pause ends
	// by the box's own clock; no cloud re-send is required.
	if next := a.selectHolder(st, now); next != nil {
		st.holderKey = next.Source.Key()
		a.applyDecision(st, now, next, eventCtx{subject: next.Ref()})
		return
	}
	a.fallToFailsafe(st, now, nil, nil)
}

// eventCtx shapes the event applyDecision emits.
type eventCtx struct {
	// outcome overrides the accepted/clamped default (expired/released hand
	// the entity to a RESUMING holder; the event then reports that
	// transition with the subject being the leaving desire).
	outcome string
	subject *SourceRef
	reasons []Reason
	// force emits even when the decision fingerprint is unchanged (the
	// response to an external submission is always answered).
	force bool
}

// applyDecision clamps the holder's wish through the per-entity guard chain,
// publishes the retained command, and emits the arbitration event.
func (a *Arbiter) applyDecision(st *entState, now time.Time, holder *Desired, ctx eventCtx) {
	r := a.reading(st.entity.ID)
	granted, stages := a.clampFor(st, holder, now, r)
	// The consumer cycle guard runs LAST (its holds are temporal; the value
	// clamps above already bounded the level it may hold).
	granted, cycleStages, hold := applyCycle(st, now, granted)
	stages = append(stages, cycleStages...)
	st.lastCycle = hold

	source := "desired"
	if holder.Source.Kind == SourcePlanExecutor {
		source = "plan"
	}
	a.publishCommand(st, now, source, granted)

	outcome := ctx.outcome
	if outcome == "" {
		if grantedMatchesWish(holder, granted) {
			outcome = "accepted"
		} else {
			outcome = "clamped"
		}
	}
	st.lastClamped = !grantedMatchesWish(holder, granted)
	reasons := append([]Reason{}, ctx.reasons...)
	for _, s := range stages {
		reasons = append(reasons, Reason{Stage: s.Stage,
			Detail: fmt.Sprintf("%.3f -> %.3f", s.Before, s.After)})
	}
	subject := ctx.subject
	if subject == nil {
		subject = holder.Ref()
	}
	fp := cycleFingerprint(fingerprint(st.holderKey, source, granted), hold)
	if !ctx.force && fp == st.lastFingerprint {
		st.lastGranted, st.lastSource = granted, source
		return
	}
	st.lastFingerprint = fp
	st.lastGranted, st.lastSource = granted, source
	st.inFailsafe = false
	grantedJSON := grantedFor(holder, granted)
	a.emitEvent(st, now, outcome, subject, requestedOf(holder), grantedJSON, reasons, holder.Ref())
	if a.deps.OnDecision != nil {
		a.deps.OnDecision(st.entity.ID)
	}
}

// clampFor runs the per-entity guard chain (registry limits tightened by the
// v1 device config, D-8/D-9 solar-only posture, PS-3 peak shave last).
func (a *Arbiter) clampFor(st *entState, d *Desired, now time.Time, r guards.Reading) (entities.Commands, []guards.ClampStage) {
	var extra *guards.Limits
	if a.deps.EnvLimits != nil {
		extra = a.deps.EnvLimits()
	}
	solarExtra := d.SolarOnly
	if a.deps.ExtraSolarOnly != nil && a.deps.ExtraSolarOnly() {
		solarExtra = true
	}
	granted, stages := st.entity.ClampCommandsTraced(d.Commands, extra, solarExtra, r)
	if granted.SetpointKw != nil && st.entity.Type == entities.TypeBatteryHybrid && a.deps.PeakShave != nil {
		limits := st.entity.GuardChainLimits()
		if extra != nil {
			limits = guards.Limits{
				MaxChargeKw:    math.Min(limits.MaxChargeKw, extra.MaxChargeKw),
				MaxDischargeKw: math.Min(limits.MaxDischargeKw, extra.MaxDischargeKw),
				SocMinPct:      math.Max(limits.SocMinPct, extra.SocMinPct),
				SocMaxPct:      math.Min(limits.SocMaxPct, extra.SocMaxPct),
			}
		}
		if shaved, active := a.deps.PeakShave(now, *granted.SetpointKw, limits, r); active && shaved != *granted.SetpointKw {
			stages = append(stages, guards.ClampStage{Stage: guards.StagePeakShave,
				Before: *granted.SetpointKw, After: shaved})
			granted.SetpointKw = &shaved
		}
	}
	return granted, stages
}

// fallToFailsafe publishes the registry failsafe (D-9) and emits ONE fallback
// event per episode. subject non-nil = a specific desired triggered the fall
// (expiry/release); nil = plan staleness / initial state (subject absent, per
// the contract's fallback description).
func (a *Arbiter) fallToFailsafe(st *entState, now time.Time, subject *SourceRef, reasons []Reason) {
	granted, publish := a.failsafeCommand(st, now)
	// The cycle guard binds the FAILSAFE too (Geräteschutz > Failsafe, §3.1):
	// an 'off' failsafe during the minimum runtime holds the previously
	// granted state, with the honest reason. A cleared command (release /
	// nothing publishable) leaves nothing to hold onto - the guard just notes
	// the withdrawal.
	if st.cycle != nil {
		if publish {
			var cycleStages []guards.ClampStage
			var hold *guards.CycleHold
			granted, cycleStages, hold = applyCycle(st, now, granted)
			st.lastCycle = hold
			for _, s := range cycleStages {
				reasons = append(reasons, Reason{Stage: s.Stage,
					Detail: fmt.Sprintf("%.3f -> %.3f", s.Before, s.After)})
			}
		} else {
			st.cycle.NoteUncommanded(now)
			st.lastCycle = nil
		}
	}
	st.lastClamped = false
	source := "failsafe"
	if publish {
		a.publishCommand(st, now, source, granted)
	} else {
		a.clearCommand(st)
	}
	fp := cycleFingerprint(fingerprint("", source, granted), st.lastCycle)
	changed := fp != st.lastFingerprint
	st.lastFingerprint = fp
	st.lastGranted, st.lastSource = granted, source
	if st.inFailsafe && !changed && subject == nil {
		return // still the same failsafe episode, value unchanged
	}
	first := !st.inFailsafe
	st.inFailsafe = true
	if first || subject != nil {
		outcome := "fallback"
		if subject != nil {
			outcome = "expired"
			if len(reasons) > 0 && reasons[0].Stage == "arbitration:ttl" && reasons[0].Detail == "released by emitter" {
				outcome = "released"
			}
		}
		var grantedJSON any
		if publish {
			grantedJSON = commandJSON(granted, "")
		}
		a.emitEvent(st, now, outcome, subject, nil, grantedJSON,
			append(reasons, Reason{Stage: "arbitration:ttl",
				Detail: "no active desired; registry failsafe " + st.entity.Guards.Failsafe.Behavior}),
			nil)
		if a.deps.OnDecision != nil {
			a.deps.OnDecision(st.entity.ID)
		}
	}
}

// onKwThreshold separates "commanded to run" from "commanded off" on a
// setpoint (mirrors the guard deadband discipline).
const onKwThreshold = 0.005

// applyCycle runs one command set through the entity's stateful cycle guard
// (no-op for non-consumers). The guard decides the temporal ON/OFF state and
// the ramped level; the command SHAPE is preserved (an on_off wish stays an
// on_off command, a setpoint wish a setpoint) so the driver semantics never
// change under a hold.
func applyCycle(st *entState, now time.Time, granted entities.Commands) (entities.Commands, []guards.ClampStage, *guards.CycleHold) {
	if st.cycle == nil {
		return granted, nil, nil
	}
	if granted.SetpointKw == nil && granted.OnOff == nil {
		// No run-state command (limits/mode only): nothing the temporal
		// invariants govern.
		return granted, nil, nil
	}
	wishKw := math.NaN()
	if granted.SetpointKw != nil {
		wishKw = *granted.SetpointKw
	}
	wishOn := false
	if granted.OnOff != nil {
		wishOn = *granted.OnOff
	} else {
		wishOn = wishKw > onKwThreshold
	}
	on, kw, hold := st.cycle.Apply(now, wishOn, wishKw)

	out := granted
	if granted.OnOff != nil {
		v := on
		out.OnOff = &v
	}
	if granted.SetpointKw != nil {
		v := 0.0
		if on && !math.IsNaN(kw) {
			v = kw
		}
		out.SetpointKw = &v
	}
	if hold == nil {
		return out, nil, nil
	}
	stage := guards.ClampStage{Stage: cycleStage(hold.Code)}
	switch hold.Code {
	case guards.CycleReasonRamp:
		stage.Before, stage.After = wishKw, kw
	default:
		stage.Before, stage.After = boolKw(wishOn), boolKw(on)
	}
	return out, []guards.ClampStage{stage}, hold
}

func boolKw(on bool) float64 {
	if on {
		return 1
	}
	return 0
}

// cycleStage maps a cycle reason code onto its arbitration-event stage name.
func cycleStage(code string) string {
	switch code {
	case guards.CycleReasonMinOn:
		return guards.StageCycleMinOn
	case guards.CycleReasonMinOff:
		return guards.StageCycleMinOff
	case guards.CycleReasonMaxStarts:
		return guards.StageCycleMaxStarts
	case guards.CycleReasonRamp:
		return guards.StageCycleRamp
	}
	return "guard:cycle"
}

// failsafeCommand derives the registry failsafe command for one entity.
// publish=false means the retained command is CLEARED instead (release /
// measure-only, or a storage failsafe with no usable reading).
func (a *Arbiter) failsafeCommand(st *entState, now time.Time) (entities.Commands, bool) {
	e := st.entity
	r := a.reading(e.ID)
	switch e.Guards.Failsafe.Behavior {
	case "self-consumption":
		if a.deps.StorageFailsafe == nil {
			return entities.Commands{}, false
		}
		kw, ok := a.deps.StorageFailsafe(e.ID, r)
		if !ok {
			return entities.Commands{}, false
		}
		d := &Desired{EntityID: e.ID, Commands: entities.Commands{SetpointKw: &kw},
			Source: Source{Kind: SourcePlanExecutor}}
		granted, _ := a.clampFor(st, d, now, r)
		if granted.SetpointKw == nil {
			return entities.Commands{}, false
		}
		return granted, true
	case "off":
		if e.Supports(entities.CmdOnOff) {
			off := false
			return entities.Commands{OnOff: &off}, true
		}
		if e.Supports(entities.CmdSetpointKw) {
			zero := 0.0
			return entities.Commands{SetpointKw: &zero}, true
		}
		return entities.Commands{}, false
	default: // release, measure-only: nothing commanded, limits cleared
		return entities.Commands{}, false
	}
}

func (a *Arbiter) reading(entityID string) guards.Reading {
	if a.deps.Reading == nil {
		return guards.Reading{SocPct: guards.Unknown(), PvKw: guards.Unknown(),
			LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown()}
	}
	return a.deps.Reading(entityID)
}

func (a *Arbiter) publishCommand(st *entState, now time.Time, source string, granted entities.Commands) {
	if a.deps.PublishCommand == nil || granted.Empty() {
		if granted.Empty() {
			a.clearCommand(st)
		}
		return
	}
	enabled := false
	if a.deps.ControlEnabled != nil {
		enabled = a.deps.ControlEnabled()
	}
	st.commandCleared = false
	a.deps.PublishCommand(st.entity.ID, entities.CommandPayload(st.entity.ID, now, enabled, source, granted))
}

func (a *Arbiter) clearCommand(st *entState) {
	if a.deps.PublishCommand == nil || st.commandCleared {
		return
	}
	st.commandCleared = true
	a.deps.PublishCommand(st.entity.ID, nil)
}

func (a *Arbiter) holderRef(st *entState) *SourceRef {
	if h := st.currentHolder(); h != nil {
		return h.Ref()
	}
	return nil
}

// --- event payloads ---------------------------------------------------------

// commandJSON renders one $defs/command entry from a command set. preferred
// picks the echoed entry for multi-entry (plan) sets; empty = dominance order
// setpoint > limit_kw > limit_pct > on_off > mode.
func commandJSON(c entities.Commands, preferred string) map[string]any {
	entry := func(t string, v any) map[string]any { return map[string]any{"type": t, "value": v} }
	if preferred != "" {
		switch preferred {
		case entities.CmdSetpointKw:
			if c.SetpointKw != nil {
				return entry(preferred, *c.SetpointKw)
			}
		case entities.CmdLimitKw:
			if c.LimitKw != nil {
				return entry(preferred, *c.LimitKw)
			}
		case entities.CmdLimitPct:
			if c.LimitPct != nil {
				return entry(preferred, *c.LimitPct)
			}
		case entities.CmdOnOff:
			if c.OnOff != nil {
				return entry(preferred, *c.OnOff)
			}
		case entities.CmdMode:
			if c.Mode != "" {
				return entry(preferred, c.Mode)
			}
		}
		return nil
	}
	switch {
	case c.SetpointKw != nil:
		return entry(entities.CmdSetpointKw, *c.SetpointKw)
	case c.LimitKw != nil:
		return entry(entities.CmdLimitKw, *c.LimitKw)
	case c.LimitPct != nil:
		return entry(entities.CmdLimitPct, *c.LimitPct)
	case c.OnOff != nil:
		return entry(entities.CmdOnOff, *c.OnOff)
	case c.Mode != "":
		return entry(entities.CmdMode, c.Mode)
	}
	return nil
}

// requestedOf echoes the desired's requested command in event form.
func requestedOf(d *Desired) map[string]any {
	return commandJSON(d.Commands, d.RequestedType)
}

// grantedFor echoes the granted entry matching the request (nil when the
// guard chain dropped it entirely).
func grantedFor(d *Desired, granted entities.Commands) any {
	if j := commandJSON(granted, d.RequestedType); j != nil {
		return j
	}
	if j := commandJSON(granted, ""); j != nil && d.RequestedType == "" {
		return j
	}
	return nil
}

// grantedMatchesWish compares wish vs granted (W resolution) to pick
// accepted vs clamped.
func grantedMatchesWish(d *Desired, granted entities.Commands) bool {
	roundW := func(v float64) float64 { return math.Round(v*1000) / 1000 }
	eq := func(a, b *float64) bool {
		if (a == nil) != (b == nil) {
			return false
		}
		return a == nil || roundW(*a) == roundW(*b)
	}
	c := d.Commands
	if !eq(c.SetpointKw, granted.SetpointKw) || !eq(c.LimitKw, granted.LimitKw) || !eq(c.LimitPct, granted.LimitPct) {
		return false
	}
	if (c.OnOff == nil) != (granted.OnOff == nil) || (c.OnOff != nil && *c.OnOff != *granted.OnOff) {
		return false
	}
	return c.Mode == granted.Mode
}

// fingerprint identifies a DECISION (holder + source + granted) for event
// dedup - the outcome is deliberately not part of it, so the transition event
// (expired/released, emitted forced) and the follow-up steady evaluation of
// the SAME decision do not double-emit.
func fingerprint(holderKey, source string, granted entities.Commands) string {
	raw, _ := json.Marshal(granted)
	return holderKey + "|" + source + "|" + string(raw)
}

// cycleFingerprint appends the active cycle hold to a decision fingerprint: a
// newly-biting (or releasing) temporal hold IS a decision change even when
// the published command bytes stay identical - the onset must emit its event
// with the honest stage, the steady state must stay silent.
func cycleFingerprint(fp string, hold *guards.CycleHold) string {
	if hold == nil {
		return fp
	}
	return fp + "|cycle:" + hold.Code
}

// emitEvent publishes one $defs/arbitration event (never retained).
func (a *Arbiter) emitEvent(st *entState, now time.Time, outcome string, subject *SourceRef,
	requested map[string]any, granted any, reasons []Reason, holder *SourceRef) {
	if a.deps.PublishEvent == nil {
		return
	}
	if reasons == nil {
		reasons = []Reason{}
	}
	payload := map[string]any{
		"schema_version": SchemaVersion,
		"entity_id":      st.entity.ID,
		"ts":             now.UTC().Format(time.RFC3339Nano),
		"outcome":        outcome,
		"reasons":        reasons,
		"holder":         holder, // nil marshals to null = registry failsafe
		"granted":        granted,
	}
	if subject != nil {
		payload["subject"] = subject
	}
	if requested != nil {
		payload["requested"] = requested
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		slog.Error("arbitration event marshal failed", "err", err)
		return
	}
	a.deps.PublishEvent(st.entity.ID, raw)
}

// lenientRef best-effort-extracts a source_ref from an invalid payload so the
// refusal event can still be correlated. nil = unidentifiable.
func lenientRef(payload []byte) *SourceRef {
	var msg struct {
		RequestID string  `json:"request_id"`
		Source    *Source `json:"source"`
		Priority  string  `json:"priority"`
		Override  bool    `json:"override"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return nil
	}
	if msg.RequestID == "" || msg.Source == nil || msg.Source.Kind == "" {
		return nil
	}
	ref := &SourceRef{RequestID: msg.RequestID, Source: *msg.Source, Priority: Class(msg.Priority)}
	if ref.Priority.rank() == 0 {
		ref.Priority = ClassFlow
	}
	if msg.Override {
		ref.Override = &msg.Override
	}
	return ref
}
