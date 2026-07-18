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

// The pilot entity types (D-10: capabilities as the foundation, domain types
// on top; further types join additively in later increments).
const (
	TypeBatteryHybrid = "battery-hybrid"
	TypeProducer      = "producer"
	TypeGridMeter     = "grid-meter"
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

func knownType(t string) bool {
	return t == TypeBatteryHybrid || t == TypeProducer || t == TypeGridMeter
}

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

// Entity is one registry descriptor.
type Entity struct {
	ID           string       `json:"entity_id"`
	Type         string       `json:"entity_type"`
	Label        string       `json:"label,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
	Guards       Guards       `json:"guards"`
	// Driver is the opaque Layer-1 self-wiring block, carried through verbatim.
	Driver json.RawMessage `json:"driver,omitempty"`
}

// Registry is the applied entity set of this device.
type Registry struct {
	Revision    string    `json:"revision"`
	PublishedAt time.Time `json:"published_at"`
	Entities    []Entity  `json:"entities"`
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
// identity and returns the registry. Entities with an unknown type or an
// invalid/duplicate id are SKIPPED with a note (forward compatibility: a
// future push carrying a wallbox to this build must not be fatal); a
// structurally invalid push or an identity mismatch is an error (the payload
// is not for this device / not this contract).
func ParseRegistryPush(payload []byte, id Identity) (Registry, []string, error) {
	var push struct {
		SchemaVersion string    `json:"schema_version"`
		TenantID      string    `json:"tenant_id"`
		SiteID        string    `json:"site_id"`
		DeviceID      string    `json:"device_id"`
		Revision      string    `json:"revision"`
		PublishedAt   time.Time `json:"published_at"`
		Entities      []Entity  `json:"entities"`
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

	reg := Registry{Revision: push.Revision, PublishedAt: push.PublishedAt}
	var skipped []string
	seen := map[string]bool{}
	for _, e := range push.Entities {
		switch {
		case !idPattern.MatchString(e.ID):
			skipped = append(skipped, fmt.Sprintf("entity %q: id not topic-safe", e.ID))
		case seen[e.ID]:
			skipped = append(skipped, fmt.Sprintf("entity %q: duplicate id", e.ID))
		case !knownType(e.Type):
			// Logged and skipped, never fatal - the schedule-2.0 unknown-entity rule.
			skipped = append(skipped, fmt.Sprintf("entity %q: unknown entity_type %q", e.ID, e.Type))
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
	switch e.Type {
	case TypeBatteryHybrid:
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
	case TypeProducer:
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
	case TypeGridMeter:
		// Measure-only by construction: every command is dropped.
	}
	return out, stages
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
	}
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
