// Package entities implements the E1a half of the v2 entity topic family
// (contract: docs/contracts/v2/edge-entity-config.md + edge-entity.schema.json;
// desired/arbitration are E2's half): the entity registry pushed by the cloud
// on ems/{t}/{s}/{d}/v2/entities, the per-entity RETAINED local config
// (edge/entities/{id}/config, decision D-3 - the per-source pattern), the
// per-entity local telemetry, the core-owned retained command, and the
// per-entity guard chain built FROM REGISTRY CONFIG (decision D-9: limits +
// failsafe live in the registry, never in plans) - the generalization of the
// v1 env-derived guards.Limits.
//
// Coexistence: a device without a pushed registry behaves byte-for-byte v1;
// nothing in the v1 local namespace changes.
package entities

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// SchemaVersion of every payload in this package (a brand-new contract).
const SchemaVersion = "1.0"

// The known catalog entity types (D-10: capabilities as the foundation,
// domain types on top). The vocabulary is OPEN since E1b - the cloud type
// catalog is data, and an unknown well-formed type is accepted here with its
// guard semantics INFERRED from what it declares (see category), never from
// its name. These constants cover the types with pinned semantics.
const (
	TypeBatteryHybrid = "battery-hybrid"
	TypeProducer      = "producer"
	TypeGridMeter     = "grid-meter"
	TypeWallbox       = "wallbox"
	TypeHeatingRod    = "heating-rod"
	TypeGenericLoad   = "generic-load"
)

// The D-14 command vocabulary, shared with edge-desired and mqtt-schedule-2.0.
const (
	CmdSetpointKw = "setpoint_kw"
	CmdOnOff      = "on_off"
	CmdLimitPct   = "limit_pct"
	CmdLimitKw    = "limit_kw"
	CmdMode       = "mode"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// typePattern is the contract's open kebab-case entity_type vocabulary
// (E1b): well-formedness is the only gate - the TYPE CATALOG lives in the
// cloud as data, and behavior here keys on declared capabilities/guards.
var typePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

func wellFormedType(t string) bool { return typePattern.MatchString(t) }

// MeasureCap declares one reportable channel.
type MeasureCap struct {
	Channel string `json:"channel"`
	Unit    string `json:"unit,omitempty"`
}

// ActuateCap declares one commandable capability with optional bounds.
type ActuateCap struct {
	Command string   `json:"command"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Modes   []string `json:"modes,omitempty"`
}

// Capabilities of one entity. A measure-only entity has no Actuate list.
type Capabilities struct {
	Measure []MeasureCap `json:"measure,omitempty"`
	Actuate []ActuateCap `json:"actuate,omitempty"`
}

// GuardLimits are the per-entity guard-chain inputs from the registry (D-9).
type GuardLimits struct {
	MaxChargeKw           *float64 `json:"max_charge_kw,omitempty"`
	MaxDischargeKw        *float64 `json:"max_discharge_kw,omitempty"`
	SocMinPct             *float64 `json:"soc_min_pct,omitempty"`
	SocMaxPct             *float64 `json:"soc_max_pct,omitempty"`
	ChargeFromGridAllowed *bool    `json:"charge_from_grid_allowed,omitempty"`
	MaxGenerationKw       *float64 `json:"max_generation_kw,omitempty"`
	MaxConsumptionKw      *float64 `json:"max_consumption_kw,omitempty"`
	// The consumer cycle-guard limits (Verbrauchssteuerung Inkrement 3,
	// additive; sourced from consumer_profile via the registry push). Absent =
	// that axis inactive - never an invented protection.
	MinOnSeconds    *float64 `json:"min_on_seconds,omitempty"`
	MinOffSeconds   *float64 `json:"min_off_seconds,omitempty"`
	MaxStartsPerDay *float64 `json:"max_starts_per_day,omitempty"`
	RampKwPerMin    *float64 `json:"ramp_kw_per_min,omitempty"`
}

// Failsafe is what the entity falls back to when nothing commands it.
type Failsafe struct {
	Behavior string `json:"behavior"`
}

// Guards is the registry guard block of one entity.
type Guards struct {
	Limits   GuardLimits `json:"limits,omitempty"`
	Failsafe Failsafe    `json:"failsafe"`
}

// FlexRequirement is one ACTIVE required_by_deadline duty of a consumer
// entity (Verbrauchssteuerung Inkrement 6, D-20; $defs/flex_requirement) -
// the data the edge-local deadline fallback needs. OPTIONAL + ADDITIVE: an
// old cloud omits the block, an old edge ignores it. power_kw and command are
// RESOLVED cloud-side from the policy target + consumer_profile (one truth);
// the edge never re-derives policy semantics. Validation/semantics live in
// internal/flexfallback.ParseRequirement.
type FlexRequirement struct {
	ID             string   `json:"id"`
	Timezone       string   `json:"timezone,omitempty"`
	Days           string   `json:"days"`
	From           string   `json:"from"`
	To             string   `json:"to"`
	RuntimeMinutes *float64 `json:"runtime_minutes,omitempty"`
	EnergyKwh      *float64 `json:"energy_kwh,omitempty"`
	Contiguous     *bool    `json:"contiguous,omitempty"`
	PowerKw        float64  `json:"power_kw"`
	Command        string   `json:"command"`
}

// RoleAssignment is ONE stored capability->role assignment of an entity, as
// the portal keeps it (AE1 entity_role_assignment; contract descriptor
// role_assignment, Befund L4). The assignment is made per CHANNEL, not per
// entity, so a descriptor carries a LIST.
//
// OPTIONAL + ADDITIVE: an absent block (an older cloud, and every plant that
// never re-assigned anything) leaves topology.DefaultRole in charge, exactly
// as before. A role this build does not know falls SILENTLY back to the
// default - a role is display, never a control path, so it must not be able to
// refuse the whole push.
type RoleAssignment struct {
	Channel string `json:"channel"`
	Role    string `json:"role"`
	Primary bool   `json:"primary,omitempty"`
}

// Entity is one registry descriptor.
type Entity struct {
	ID           string       `json:"entity_id"`
	Type         string       `json:"entity_type"`
	Label        string       `json:"label,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
	Guards       Guards       `json:"guards"`
	// Driver is the opaque Layer-1 self-wiring block, carried through verbatim.
	Driver json.RawMessage `json:"driver,omitempty"`
	// EdgeSourceID is the edge-local source id this entity was adopted from
	// (the cloud's measurement_point.edge_source_id pin, OPTIONAL + additive
	// since 2026-07-29, vp-vier-erzeuger-p9 PR 4a). It lets the device map its
	// OWN source readings onto the entity for the LOCAL display (Topology) -
	// deterministic instead of order-guessing. Empty = not adopted / old cloud.
	EdgeSourceID string `json:"edge_source_id,omitempty"`
	// FlexRequirements are the consumer's active deadline duties for the
	// edge-local fallback (Inkrement 6, D-20). Empty = no fallback.
	FlexRequirements []FlexRequirement `json:"flex_requirements,omitempty"`
	// ChargePointID is the OCPP ChargePointId this entity IS, echoed from the
	// cloud binding device_charge_point.entity_id (Cockpit Phase 1 / E1).
	// OPTIONAL + ADDITIVE: it is the twin of EdgeSourceID one transport over -
	// a charge point is not a source in sources.json (it dials US), so its
	// readings could not be mapped onto the entity by any other key. Empty =
	// not a charge point / an older cloud, and then the box publishes no
	// per-entity charge-point telemetry at all.
	ChargePointID string `json:"charge_point_id,omitempty"`
	// OwnerClaimed says an ACTIVE customer rule claims this component
	// (Steuerung Stufe 3, vp-steuerung-konzept-b3 §3.7 A3). The plan
	// executors then inject NO market desire for it, so the rule's flow-class
	// desire wins because no competitor exists - the arbiter, the priority
	// classes and D-4/D-5/D-6 stay untouched. ABSENT = false: an older cloud
	// and every unclaimed component behave byte-for-byte as before.
	OwnerClaimed bool `json:"owner_claimed,omitempty"`
	// RoleAssignment is the portal's stored capability->role assignment of
	// this component (Befund L4). Until it travelled, PUT …/topology-roles
	// only wrote the cloud table and the box always resolved through
	// topology.DefaultRole - so a re-purposed measurement point or a meter
	// marked maßgeblich looked DIFFERENT on :8484 than in the portal. Consumed
	// by Agent.Topology/topology.Resolve for the LOCAL display only; the
	// component applier (componentapply.Derive) never reads it, so
	// inverter.json/sources.json keep deriving their role from the entity type.
	RoleAssignment []RoleAssignment `json:"role_assignment,omitempty"`
}

// Registry is the applied entity set of this device.
type Registry struct {
	Revision    string    `json:"revision"`
	PublishedAt time.Time `json:"published_at"`
	Entities    []Entity  `json:"entities"`
	// PausedUntil is the operator's „Automatik pausieren" (Steuerung Stufe 4,
	// §3.7 B5): until this instant the plan executors inject NOTHING and the
	// arbiter ignores every desire BELOW the market class, so every component
	// falls to its registry failsafe - the battery to self-consumption, a
	// device to release/off. That is exactly „so, als gäbe es VoltPilot
	// nicht", and it is the only value the cloud could NOT have sent as a
	// setpoint (PV − load is a number only the box can compute).
	//
	// ⚠ It is an ABSOLUTE instant, never a duration: the registry push is
	// RETAINED, so a box that was offline when the pause expired must be able
	// to lift it by its OWN clock instead of waiting for a message that may
	// never come. ABSENT (the zero value) = no pause, which is what every
	// older cloud sends and what every unpaused plant sends.
	//
	// ⚠ What a pause does NOT touch: measuring, the guard chain, § 14a, the
	// curtailment and the export guard. They all live BELOW arbitration.
	PausedUntil time.Time `json:"automation_paused_until,omitempty"`
	// PausedUntilRevoked is „Ruhe bis zum Start" (UEMS AP-01 IP-4, rule R0):
	// a plant that belongs to „Steuern & Optimieren" but was not started rests
	// UNTIL REVOKED - the same pause as above, but with no end at all. Only a
	// push WITHOUT the field lifts it; no clock, no expired PausedUntil does.
	//
	// ⚠ ADDITIVE: absent/false is byte-for-byte the timed pause above. The
	// cloud still sends a rolling PausedUntil (push time + 4 h) next to it -
	// that end exists ONLY for an older box that does not know this field.
	// Shared vectors: docs/contracts/v2/override-vectors.json.
	PausedUntilRevoked bool `json:"automation_paused_until_revoked,omitempty"`
	// ComponentAuthority is WHO owns this PLANT's device configuration
	// (Einheitsmodell Stufe 1, contract registry_push.component_authority):
	// "portal" = the cloud is the Soll and the box DERIVES its local
	// inverter/sources files from the driver blocks of this push; anything else
	// - including ABSENT, which is what an older cloud sends - is "box" and
	// changes nothing about the local device configuration. The derivation
	// itself lives in internal/componentapply; this field is only carried.
	ComponentAuthority string `json:"component_authority,omitempty"`
}

// Find returns the entity with the given id, or nil.
func (r Registry) Find(id string) *Entity {
	for i := range r.Entities {
		if r.Entities[i].ID == id {
			return &r.Entities[i]
		}
	}
	return nil
}

// FirstOfType returns the first entity of the given type, or nil.
func (r Registry) FirstOfType(entityType string) *Entity {
	for i := range r.Entities {
		if r.Entities[i].Type == entityType {
			return &r.Entities[i]
		}
	}
	return nil
}

// Paused reports whether the operator's „Automatik pausieren" is in force at
// `now` (Steuerung Stufe 4, §3.7 B5). A zero instant is never a pause.
//
// „Ruhe bis zum Start" (R0) rests until revoked: PausedUntilRevoked wins over
// every end and every clock. This is the ONE gate of all three pause halves -
// the plan executors, the arbiter's Suspended and the v1 applySetpoint path
// all ask it - and it sits ABOVE the guard chain, which it never touches.
func (r Registry) Paused(now time.Time) bool {
	return r.PausedUntilRevoked || (!r.PausedUntil.IsZero() && now.Before(r.PausedUntil))
}

// Claimed reports whether an ACTIVE customer rule claims this entity
// (Steuerung Stufe 3, §3.7 A3). An unknown entity is never claimed - a plan
// executor that cannot find its subject has nothing to skip.
func (r Registry) Claimed(id string) bool {
	e := r.Find(id)
	return e != nil && e.OwnerClaimed
}

// IDs returns the entity ids in registry order.
func (r Registry) IDs() []string {
	ids := make([]string, 0, len(r.Entities))
	for _, e := range r.Entities {
		ids = append(ids, e.ID)
	}
	return ids
}

// Identity is the cloud identity the push must match (topic==payload rule).
type Identity struct {
	TenantID, SiteID, DeviceID string
}

// ParseRegistryPush validates a …/v2/entities payload against the device
// identity and returns the registry. Entities with a MALFORMED type or an
// invalid/duplicate id are SKIPPED with a note; an unknown but well-formed
// type is ACCEPTED (E1b open vocabulary - guard semantics come from the
// declared capabilities/guards, so a future catalog type reaching this build
// is data, not an error). A structurally invalid push or an identity
// mismatch is an error (the payload is not for this device / not this
// contract).
func ParseRegistryPush(payload []byte, id Identity) (Registry, []string, error) {
	var push struct {
		SchemaVersion      string    `json:"schema_version"`
		TenantID           string    `json:"tenant_id"`
		SiteID             string    `json:"site_id"`
		DeviceID           string    `json:"device_id"`
		Revision           string    `json:"revision"`
		PublishedAt        time.Time `json:"published_at"`
		ComponentAuthority string    `json:"component_authority"`
		PausedUntil        time.Time `json:"automation_paused_until"`
		PausedUntilRevoked bool      `json:"automation_paused_until_revoked"`
		Entities           []Entity  `json:"entities"`
	}
	if err := json.Unmarshal(payload, &push); err != nil {
		return Registry{}, nil, fmt.Errorf("entity registry push unreadable: %w", err)
	}
	if push.SchemaVersion != SchemaVersion {
		return Registry{}, nil, fmt.Errorf("unsupported registry push schema_version %q", push.SchemaVersion)
	}
	if !strings.EqualFold(push.TenantID, id.TenantID) || !strings.EqualFold(push.SiteID, id.SiteID) ||
		!strings.EqualFold(push.DeviceID, id.DeviceID) {
		return Registry{}, nil, fmt.Errorf("registry push identity %s/%s/%s does not match this device",
			push.TenantID, push.SiteID, push.DeviceID)
	}
	if push.Revision == "" {
		return Registry{}, nil, fmt.Errorf("registry push carries no revision")
	}

	reg := Registry{Revision: push.Revision, PublishedAt: push.PublishedAt,
		ComponentAuthority: push.ComponentAuthority, PausedUntil: push.PausedUntil,
		PausedUntilRevoked: push.PausedUntilRevoked}
	var skipped []string
	seen := map[string]bool{}
	for _, e := range push.Entities {
		switch {
		case !idPattern.MatchString(e.ID):
			skipped = append(skipped, fmt.Sprintf("entity %q: id not topic-safe", e.ID))
		case seen[e.ID]:
			skipped = append(skipped, fmt.Sprintf("entity %q: duplicate id", e.ID))
		case !wellFormedType(e.Type):
			// Logged and skipped, never fatal - the schedule-2.0 unknown-entity rule.
			skipped = append(skipped, fmt.Sprintf("entity %q: malformed entity_type %q", e.ID, e.Type))
		default:
			seen[e.ID] = true
			reg.Entities = append(reg.Entities, e)
		}
	}
	return reg, skipped, nil
}

// ConfigPayload renders the retained edge/entities/{id}/config message.
func (e Entity) ConfigPayload(revision string) []byte {
	raw, _ := json.Marshal(struct {
		SchemaVersion string `json:"schema_version"`
		Entity
		Revision string `json:"revision,omitempty"`
	}{SchemaVersion: SchemaVersion, Entity: e, Revision: revision})
	return raw
}

// --- Local per-entity telemetry -------------------------------------------

// Telemetry is one accepted edge/entities/{id}/telemetry reading.
type Telemetry struct {
	EntityID string
	Ts       time.Time // zero = sender gave none (use receive time)
	Channels map[string]float64
}

// ParseTelemetry validates a local per-entity telemetry payload against the
// topic's entity id (identity rule: mismatches are ignored by the caller).
func ParseTelemetry(topicEntityID string, payload []byte) (Telemetry, error) {
	var msg struct {
		SchemaVersion string             `json:"schema_version"`
		EntityID      string             `json:"entity_id"`
		Ts            string             `json:"ts"`
		Channels      map[string]float64 `json:"channels"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return Telemetry{}, fmt.Errorf("entity telemetry unreadable: %w", err)
	}
	if msg.SchemaVersion != SchemaVersion {
		return Telemetry{}, fmt.Errorf("unsupported entity telemetry schema_version %q", msg.SchemaVersion)
	}
	if msg.EntityID != topicEntityID {
		return Telemetry{}, fmt.Errorf("payload entity_id %q does not match topic %q", msg.EntityID, topicEntityID)
	}
	t := Telemetry{EntityID: msg.EntityID, Channels: map[string]float64{}}
	for name, v := range msg.Channels {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			continue // absent, never a fabricated value
		}
		t.Channels[name] = v
	}
	if len(t.Channels) == 0 {
		return Telemetry{}, fmt.Errorf("entity telemetry carries no usable channels")
	}
	if msg.Ts != "" {
		if ts, err := time.Parse(time.RFC3339Nano, msg.Ts); err == nil {
			t.Ts = ts
		}
	}
	return t, nil
}

// --- Core-owned retained command ------------------------------------------

// Commands carries the granted values keyed by the D-14 vocabulary.
type Commands struct {
	SetpointKw *float64 `json:"setpoint_kw,omitempty"`
	LimitKw    *float64 `json:"limit_kw,omitempty"`
	LimitPct   *float64 `json:"limit_pct,omitempty"`
	OnOff      *bool    `json:"on_off,omitempty"`
	Mode       string   `json:"mode,omitempty"`
}

// Empty reports whether no command is set.
func (c Commands) Empty() bool {
	return c.SetpointKw == nil && c.LimitKw == nil && c.LimitPct == nil &&
		c.OnOff == nil && c.Mode == ""
}

// CommandPayload renders the retained edge/entities/{id}/command message.
func CommandPayload(entityID string, ts time.Time, controlEnabled bool, source string,
	cmds Commands) []byte {
	raw, _ := json.Marshal(struct {
		SchemaVersion  string   `json:"schema_version"`
		EntityID       string   `json:"entity_id"`
		Ts             string   `json:"ts"`
		ControlEnabled bool     `json:"control_enabled"`
		Source         string   `json:"source,omitempty"`
		Commands       Commands `json:"commands"`
	}{SchemaVersion, entityID, ts.UTC().Format(time.RFC3339Nano), controlEnabled, source, cmds})
	return raw
}

// --- Per-entity guard chain (D-9: built from registry config) --------------

// allows reports whether the entity's declared capabilities include a command.
func (e Entity) allows(command string) bool {
	for _, cap := range e.Capabilities.Actuate {
		if cap.Command == command {
			return true
		}
	}
	return false
}

// Supports is the exported capability gate: whether the registry declared the
// command actuatable on this entity (the desired contract's
// capability:unsupported_command check runs against this).
func (e Entity) Supports(command string) bool { return e.allows(command) }

// GuardChainLimits builds the v1 guard-chain inputs from the entity's registry
// guard config. Absent bounds disable that clamp (infinite band / open SoC
// window) - EXCEPT charge_from_grid_allowed, where absent means NOT allowed
// (D-8: only an explicit true releases the solar-only-charge clamp).
func (e Entity) GuardChainLimits() guards.Limits {
	l := guards.Limits{
		MaxChargeKw:    math.Inf(1),
		MaxDischargeKw: math.Inf(1),
		SocMinPct:      math.Inf(-1),
		SocMaxPct:      math.Inf(1),
		SolarOnlyCharge: e.Guards.Limits.ChargeFromGridAllowed == nil ||
			!*e.Guards.Limits.ChargeFromGridAllowed,
	}
	if v := e.Guards.Limits.MaxChargeKw; v != nil {
		l.MaxChargeKw = *v
	}
	if v := e.Guards.Limits.MaxDischargeKw; v != nil {
		l.MaxDischargeKw = *v
	}
	if v := e.Guards.Limits.SocMinPct; v != nil {
		l.SocMinPct = *v
	}
	if v := e.Guards.Limits.SocMaxPct; v != nil {
		l.SocMaxPct = *v
	}
	return l
}

// CycleLimits maps the registry's cycle-guard fields onto the stateful
// guard's limit set (Verbrauchssteuerung Inkrement 3). Absent, non-finite or
// negative values deactivate their axis - the no-invented-protection rule.
func (e Entity) CycleLimits() guards.CycleLimits {
	sec := func(v *float64) time.Duration {
		if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) || *v <= 0 {
			return 0
		}
		return time.Duration(*v * float64(time.Second))
	}
	l := guards.CycleLimits{
		MinOn:  sec(e.Guards.Limits.MinOnSeconds),
		MinOff: sec(e.Guards.Limits.MinOffSeconds),
	}
	if v := e.Guards.Limits.MaxStartsPerDay; v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v > 0 {
		l.MaxStartsPerDay = int(*v)
	}
	if v := e.Guards.Limits.RampKwPerMin; v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v > 0 {
		l.RampKwPerMin = *v
	}
	return l
}

// ClampCommands applies the per-entity restrict-only guard chain to a set of
// wished commands and returns what may actually be commanded: capability gate
// first (a command the registry never declared is dropped - the desired
// contract's capability:unsupported_command), then the type's clamps. Guards
// only ever restrict; a grid meter (measure-only failsafe, no actuate
// capabilities) yields nothing.
func (e Entity) ClampCommands(c Commands, r guards.Reading) Commands {
	out, _ := e.ClampCommandsTraced(c, nil, false, r)
	return out
}

// ClampCommandsTraced is ClampCommands with stage attribution (the v2
// arbitration events' reasons[].stage) and an OPTIONAL extra limits
// tightening: `extra` composes the v1 device-config band/SoC window into the
// chain (most restrictive wins - the E1a double-clamp expressed as one traced
// chain), `extraSolarOnly` ORs the v1 plan-carried solar-only posture in.
// ClampCommands delegates here, so the two can never drift.
func (e Entity) ClampCommandsTraced(c Commands, extra *guards.Limits, extraSolarOnly bool,
	r guards.Reading) (Commands, []guards.ClampStage) {
	out := Commands{}
	var stages []guards.ClampStage
	limits := e.GuardChainLimits()
	if extra != nil {
		limits = tightenLimits(limits, *extra)
	}
	limits.SolarOnlyCharge = limits.SolarOnlyCharge || extraSolarOnly
	noteLimit := func(stage string, before, after float64) {
		if after != before {
			stages = append(stages, guards.ClampStage{Stage: stage, Before: before, After: after})
		}
	}
	switch e.category() {
	case catStorage:
		if c.SetpointKw != nil && e.allows(CmdSetpointKw) {
			v, tr := guards.ClampTraced(*c.SetpointKw, limits, r)
			stages = append(stages, tr...)
			out.SetpointKw = &v
		}
		if c.LimitKw != nil && e.allows(CmdLimitKw) {
			v := clampLimitKw(*c.LimitKw, e.Guards.Limits.MaxGenerationKw)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitKw, v)
			out.LimitKw = &v
		}
		if c.LimitPct != nil && e.allows(CmdLimitPct) {
			v := clampPct(*c.LimitPct)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitPct, v)
			out.LimitPct = &v
		}
	case catProducer:
		// Generators are never commanded to produce - only ever capped
		// (limit_* reduce-only, the v1 pv_limit_kw safety posture).
		if c.LimitKw != nil && e.allows(CmdLimitKw) {
			v := clampLimitKw(*c.LimitKw, e.Guards.Limits.MaxGenerationKw)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitKw, v)
			out.LimitKw = &v
		}
		if c.LimitPct != nil && e.allows(CmdLimitPct) {
			v := clampPct(*c.LimitPct)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitPct, v)
			out.LimitPct = &v
		}
	case catConsumer:
		// Consumers are only ever commanded to CONSUME (+ = consume, V2G out
		// of scope): the setpoint band is [0, min(capability max,
		// max_consumption_kw)]; limits reduce-only against the same caps.
		if c.SetpointKw != nil && e.allows(CmdSetpointKw) {
			v := consumerCap(*c.SetpointKw, e.capMax(CmdSetpointKw), e.Guards.Limits.MaxConsumptionKw)
			noteLimit(guards.StageRatedBand, *c.SetpointKw, v)
			out.SetpointKw = &v
		}
		if c.LimitKw != nil && e.allows(CmdLimitKw) {
			v := consumerCap(*c.LimitKw, e.capMax(CmdLimitKw), e.Guards.Limits.MaxConsumptionKw)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitKw, v)
			out.LimitKw = &v
		}
		if c.LimitPct != nil && e.allows(CmdLimitPct) {
			v := clampPct(*c.LimitPct)
			noteLimit(guards.StageLimitReduceOnly, *c.LimitPct, v)
			out.LimitPct = &v
		}
		if c.OnOff != nil && e.allows(CmdOnOff) {
			v := *c.OnOff
			out.OnOff = &v
		}
		if c.Mode != "" && e.allows(CmdMode) && e.modeDeclared(c.Mode) {
			out.Mode = c.Mode
		}
	case catMeasureOnly:
		// Measure-only by construction: every command is dropped.
	}
	return out, stages
}

// Guard-semantics categories. The pilot types keep their pinned semantics;
// everything else is inferred from DECLARED config (D-10: capabilities are
// the foundation - an unknown future type gets safe semantics from what it
// declares, never from its name).
// The guard-semantics categories. Exported since Einheitsmodell Stufe 1 so the
// component applier can key its role derivation on the SAME vocabulary the
// guard chain uses, instead of re-spelling the strings.
const (
	CategoryStorage     = "storage"
	CategoryProducer    = "producer"
	CategoryConsumer    = "consumer"
	CategoryMeasureOnly = "measure-only"
)

const (
	catStorage     = CategoryStorage
	catProducer    = CategoryProducer
	catConsumer    = CategoryConsumer
	catMeasureOnly = CategoryMeasureOnly
)

// Category returns the guard-semantics category ("storage"|"producer"|
// "consumer"|"measure-only") - the exported form for the topology read-model's
// default role resolution (the cloud type catalog uses "meter" for the same
// role, accepted as an alias by topology.DefaultRole).
func (e Entity) Category() string { return e.category() }

func (e Entity) category() string {
	switch e.Type {
	case TypeBatteryHybrid:
		return catStorage
	case TypeProducer:
		return catProducer
	case TypeGridMeter:
		return catMeasureOnly
	case TypeHouseLoad:
		// Pinned like the other composed types, and deliberately NOT left to
		// the inference below: a house-load declares no actuate capability, so
		// the "measure-only" fallback would categorize it as a METER and the
		// topology read-model would aggregate the Hausverbrauch into the Netz
		// node instead of emitting its own Verbraucher node. The cloud type
		// catalog (services/api .../entitytypes/catalog.json) says category
		// consumer - this keeps the edge's derivation in agreement with it.
		// Guard-safe: with no actuate capability the capability gate (allows)
		// refuses every command whatever the category says.
		return catConsumer
	}
	if e.Guards.Failsafe.Behavior == "measure-only" || len(e.Capabilities.Actuate) == 0 {
		return catMeasureOnly
	}
	l := e.Guards.Limits
	if l.MaxChargeKw != nil || l.MaxDischargeKw != nil || l.SocMinPct != nil ||
		l.SocMaxPct != nil || l.ChargeFromGridAllowed != nil {
		// Storage-shaped guards: the full battery chain incl. the D-8
		// solar-only posture - fail-safe for a future storage type.
		return catStorage
	}
	if l.MaxGenerationKw != nil {
		return catProducer
	}
	return catConsumer
}

// capMax returns the declared upper bound of an actuate capability, or nil.
func (e Entity) capMax(command string) *float64 {
	for _, cap := range e.Capabilities.Actuate {
		if cap.Command == command {
			return cap.Max
		}
	}
	return nil
}

// modeDeclared reports whether a mode is in the declared set of the mode
// capability (a capability without a declared set accepts any mode).
func (e Entity) modeDeclared(mode string) bool {
	for _, cap := range e.Capabilities.Actuate {
		if cap.Command != CmdMode {
			continue
		}
		if len(cap.Modes) == 0 {
			return true
		}
		for _, m := range cap.Modes {
			if m == mode {
				return true
			}
		}
		return false
	}
	return false
}

// consumerCap clamps a consumer command value to [0, min(capability max,
// rated max_consumption_kw)] - restrict-only, never raised.
func consumerCap(v float64, capMax, rated *float64) float64 {
	if math.IsNaN(v) || v < 0 {
		v = 0
	}
	if capMax != nil && v > *capMax {
		v = *capMax
	}
	if rated != nil && v > *rated {
		v = *rated
	}
	return math.Round(v*1000) / 1000
}

// tightenLimits composes two limit sets, most restrictive wins: the narrower
// band, the tighter SoC window, solar-only if either demands it. This is how
// the v1 device config (env-derived guards.Limits) and the registry guard
// config both stay binding on one write path.
func tightenLimits(a, b guards.Limits) guards.Limits {
	return guards.Limits{
		MaxChargeKw:     math.Min(a.MaxChargeKw, b.MaxChargeKw),
		MaxDischargeKw:  math.Min(a.MaxDischargeKw, b.MaxDischargeKw),
		SocMinPct:       math.Max(a.SocMinPct, b.SocMinPct),
		SocMaxPct:       math.Min(a.SocMaxPct, b.SocMaxPct),
		SolarOnlyCharge: a.SolarOnlyCharge || b.SolarOnlyCharge,
		// The BMS envelope (P5c) rides through the tightening like every
		// other bound. The registry side never carries one - it is a LIVE
		// statement of the pack, not stored configuration - so in practice
		// exactly one side has it; two would compose the same way as the
		// numbers above.
		Bms: tightenBms(a.Bms, b.Bms),
	}
}

// tightenBms composes two BMS envelopes into the more restrictive one. nil on
// a side means "said nothing" and never restricts.
func tightenBms(a, b *guards.BmsEnvelope) *guards.BmsEnvelope {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	return &guards.BmsEnvelope{
		ChargeKw:         minKnown(a.ChargeKw, b.ChargeKw),
		DischargeKw:      minKnown(a.DischargeKw, b.DischargeKw),
		ChargeBlocked:    a.ChargeBlocked || b.ChargeBlocked,
		DischargeBlocked: a.DischargeBlocked || b.DischargeBlocked,
	}
}

// minKnown is math.Min with NaN meaning "no statement" instead of poisoning
// the result: an absent limit must not silently erase a present one.
func minKnown(a, b float64) float64 {
	if math.IsNaN(a) {
		return b
	}
	if math.IsNaN(b) {
		return a
	}
	return math.Min(a, b)
}

// clampLimitKw keeps a generation cap non-negative and within the nameplate.
func clampLimitKw(v float64, nameplate *float64) float64 {
	if math.IsNaN(v) || v < 0 {
		v = 0
	}
	if nameplate != nil && v > *nameplate {
		v = *nameplate
	}
	return math.Round(v*1000) / 1000
}

func clampPct(v float64) float64 {
	if math.IsNaN(v) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return math.Round(v*1000) / 1000
}

// --- Topics ----------------------------------------------------------------

// TopicPrefix of the local per-entity family (D-3).
const TopicPrefix = "edge/entities/"

// TelemetryWildcard subscribes every entity's local telemetry.
const TelemetryWildcard = TopicPrefix + "+/telemetry"

// ConfigTopic of one entity (retained; empty payload clears = entity removed).
func ConfigTopic(id string) string { return TopicPrefix + id + "/config" }

// TelemetryTopic of one entity (Layer 1 -> core, not retained).
func TelemetryTopic(id string) string { return TopicPrefix + id + "/telemetry" }

// CommandTopic of one entity (core-owned, retained).
func CommandTopic(id string) string { return TopicPrefix + id + "/command" }

// ReadbackTopic of one entity (Layer 1 -> core, v1 readback payload shape).
func ReadbackTopic(id string) string { return TopicPrefix + id + "/readback" }

// IDFromTopic extracts the entity id from edge/entities/{id}/{leaf}, or ""
// when the topic does not match that shape.
func IDFromTopic(topic, leaf string) string {
	if !strings.HasPrefix(topic, TopicPrefix) || !strings.HasSuffix(topic, "/"+leaf) {
		return ""
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(topic, TopicPrefix), "/"+leaf)
	if mid == "" || strings.Contains(mid, "/") {
		return ""
	}
	return mid
}
