// Package desired implements the E2 half of the v2 entity topic family
// (contract: docs/contracts/v2/edge-desired-arbitration.md +
// edge-desired.schema.json; the E1a config/telemetry/command half lives in
// internal/entities): parsing + validation of desired ("Wunsch") payloads and
// the per-entity ARBITRATION - priority classes (D-4), the override escape
// hatch (D-5), holder-keeps/challenger-rejected conflicts (D-6), required TTL
// with no retained desires (D-7), guard-chain clamping of the winner, and the
// arbitration result events every decision emits.
//
// Flows never write registers: the arbiter alone derives the core-owned
// retained edge/entities/{id}/command, and the driver layer executes only
// that (plan-execution-ownership.md, D-10).
package desired

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// SchemaVersion of the desired/arbitration payloads (a brand-new contract).
const SchemaVersion = "1.0"

// Class is a priority class (D-4): safety > grid > contract > market > flow.
type Class string

// The five priority classes.
const (
	ClassSafety   Class = "safety"
	ClassGrid     Class = "grid"
	ClassContract Class = "contract"
	ClassMarket   Class = "market"
	ClassFlow     Class = "flow"
)

// rank orders the classes (higher wins). The zero rank marks an unknown class.
func (c Class) rank() int {
	switch c {
	case ClassSafety:
		return 100
	case ClassGrid:
		return 90
	case ClassContract:
		return 80
	case ClassMarket:
		return 60
	case ClassFlow:
		return 40
	}
	return 0
}

// OverrideTTLCap bounds an override desire's elevation (D-5: <= 4 h).
const OverrideTTLCap = 14400 * time.Second

// SourceKind says who emitted a desired.
type SourceKind string

// The contract's source kinds.
const (
	SourceFlow         SourceKind = "flow"
	SourcePlanExecutor SourceKind = "plan-executor"
	SourceCloudCommand SourceKind = "cloud-command"
	SourceLocalUI      SourceKind = "local-ui"
)

// Source identifies a desired's emitter. Flow sources carry the compiler-
// stamped flow identity.
type Source struct {
	Kind        SourceKind `json:"kind"`
	FlowID      string     `json:"flow_id,omitempty"`
	FlowVersion int        `json:"flow_version,omitempty"`
	NodeID      string     `json:"node_id,omitempty"`
}

// Key is the REPLACE slot of a source on one entity: a new desired from the
// same source replaces its previous one (the contract's release semantics -
// "an explicit new desired from the same source"). Flow sources are keyed per
// action node; every other kind holds one slot per entity.
func (s Source) Key() string {
	if s.Kind == SourceFlow {
		return string(s.Kind) + "/" + s.FlowID + "/" + s.NodeID
	}
	return string(s.Kind)
}

// Desired is one validated wish for one entity.
type Desired struct {
	EntityID  string
	RequestID string
	Source    Source
	Priority  Class
	Override  bool
	TTL       time.Duration
	IssuedAt  time.Time

	// Commands is the wished command set. EXTERNAL desires carry exactly one
	// entry (the contract's single command); the plan executor's INTERNAL
	// market desires may carry a slot's full set (a schedule-2.0 slot can
	// command several channels of one entity).
	Commands entities.Commands
	// RequestedType is the single external command type, echoed in events;
	// empty for internal command sets (events echo the dominant entry then).
	RequestedType string

	// SolarOnly is INTERNAL (plan executor only): the schedule-2.0 per-entity
	// charge_from_grid_allowed posture, D-8 reading (absent/false = solar-only
	// clamp). External desires never carry it - for them the registry guard
	// config alone decides (D-9). ORed into the storage clamp, most
	// restrictive wins.
	SolarOnly bool

	// receivedAt anchors the TTL: min(issued_at, receive time) per contract
	// §5 (a future-dated desired gains nothing).
	receivedAt time.Time
}

// effectiveRank ranks a desired for holder selection: the class rank, with
// override elevating a class-'flow' desired ABOVE market but below contract
// (D-5). Override never changes ranking within class 'flow' itself - the D-6
// same-class rule (holder keeps) is checked on the CLASS, so two flows can
// never preempt each other via override.
func (d *Desired) effectiveRank() int {
	if d.Priority == ClassFlow && d.Override {
		return 70
	}
	return d.Priority.rank()
}

// anchor is the TTL anchor instant (min of issued_at and receive time).
func (d *Desired) anchor() time.Time {
	if !d.IssuedAt.IsZero() && d.IssuedAt.Before(d.receivedAt) {
		return d.IssuedAt
	}
	return d.receivedAt
}

// ExpiresAt is when this desired lapses.
func (d *Desired) ExpiresAt() time.Time {
	ttl := d.TTL
	if d.Override && ttl > OverrideTTLCap {
		ttl = OverrideTTLCap
	}
	return d.anchor().Add(ttl)
}

// Expired reports whether the desired's TTL has lapsed at now.
func (d *Desired) Expired(now time.Time) bool {
	return now.After(d.ExpiresAt())
}

// Ref is the compact source_ref used in arbitration events.
func (d *Desired) Ref() *SourceRef {
	r := &SourceRef{RequestID: d.RequestID, Source: d.Source, Priority: d.Priority}
	if d.Override {
		r.Override = &d.Override
	}
	return r
}

// SourceRef mirrors $defs/source_ref.
type SourceRef struct {
	RequestID string `json:"request_id"`
	Source    Source `json:"source"`
	Priority  Class  `json:"priority"`
	Override  *bool  `json:"override,omitempty"`
}

// ParseError is a validation refusal with the contract's machine-readable
// stage (validation:schema, capability:unsupported_command,
// arbitration:priority_not_allowed, ...).
type ParseError struct {
	Stage  string
	Detail string
}

func (e *ParseError) Error() string { return e.Stage + ": " + e.Detail }

func schemaErr(format string, args ...any) *ParseError {
	return &ParseError{Stage: "validation:schema", Detail: fmt.Sprintf(format, args...)}
}

// IdentityMismatchError marks a payload whose entity_id does not equal the
// topic segment. Per contract §1 the core IGNORES these (no event) - the
// caller drops silently.
type IdentityMismatchError struct{ Topic, Payload string }

func (e *IdentityMismatchError) Error() string {
	return fmt.Sprintf("payload entity_id %q does not match topic %q", e.Payload, e.Topic)
}

// Parse validates one edge/entities/{id}/desired payload against the contract
// and the topic's entity id. receivedAt anchors the TTL.
func Parse(topicEntityID string, payload []byte, receivedAt time.Time) (*Desired, error) {
	var msg struct {
		SchemaVersion string          `json:"schema_version"`
		EntityID      string          `json:"entity_id"`
		RequestID     string          `json:"request_id"`
		Source        *Source         `json:"source"`
		Priority      string          `json:"priority"`
		Override      bool            `json:"override"`
		Command       json.RawMessage `json:"command"`
		TTLSeconds    *int            `json:"ttl_s"`
		IssuedAt      string          `json:"issued_at"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return nil, schemaErr("payload unreadable: %v", err)
	}
	if msg.SchemaVersion != SchemaVersion {
		return nil, schemaErr("unsupported schema_version %q", msg.SchemaVersion)
	}
	if msg.EntityID != topicEntityID {
		return nil, &IdentityMismatchError{Topic: topicEntityID, Payload: msg.EntityID}
	}
	if msg.RequestID == "" || len(msg.RequestID) > 128 {
		return nil, schemaErr("request_id missing or too long")
	}
	if msg.Source == nil {
		return nil, schemaErr("source missing")
	}
	switch msg.Source.Kind {
	case SourceFlow:
		if msg.Source.FlowID == "" || msg.Source.FlowVersion < 1 || msg.Source.NodeID == "" {
			return nil, schemaErr("flow source requires flow_id, flow_version and node_id")
		}
	case SourcePlanExecutor, SourceCloudCommand, SourceLocalUI:
		// ok
	default:
		return nil, schemaErr("unknown source kind %q", msg.Source.Kind)
	}
	cls := Class(msg.Priority)
	if cls.rank() == 0 {
		return nil, schemaErr("unknown priority %q", msg.Priority)
	}
	if err := classAllowed(msg.Source.Kind, cls); err != nil {
		return nil, err
	}
	if msg.TTLSeconds == nil {
		return nil, schemaErr("ttl_s is required - there are no immortal desires")
	}
	if *msg.TTLSeconds < 1 || *msg.TTLSeconds > 86400 {
		return nil, schemaErr("ttl_s %d outside 1..86400", *msg.TTLSeconds)
	}
	issuedAt, err := time.Parse(time.RFC3339Nano, msg.IssuedAt)
	if err != nil {
		return nil, schemaErr("issued_at missing or not RFC 3339")
	}
	cmds, reqType, err := parseCommand(msg.Command)
	if err != nil {
		return nil, err
	}
	return &Desired{
		EntityID:      msg.EntityID,
		RequestID:     msg.RequestID,
		Source:        *msg.Source,
		Priority:      cls,
		Override:      msg.Override,
		TTL:           time.Duration(*msg.TTLSeconds) * time.Second,
		IssuedAt:      issuedAt.UTC(),
		Commands:      cmds,
		RequestedType: reqType,
		receivedAt:    receivedAt.UTC(),
	}, nil
}

// classAllowed enforces WHO may claim WHICH class (contract §3): flows (and
// the local operator surface, which is flow-level owner intent) are always
// class 'flow' - enforced in the core, never trusted to the publisher. The
// core's own plan executor injects 'market'. The reserved compliance classes
// (safety/grid/contract) arrive only as cloud-command desires when the E8
// masters land; 'safety' additionally stays guard-only today (no producer
// exists, and device protection is the clamp chain, not a wish).
func classAllowed(kind SourceKind, cls Class) error {
	notAllowed := &ParseError{Stage: "arbitration:priority_not_allowed",
		Detail: fmt.Sprintf("source kind %q may not claim priority %q", kind, cls)}
	switch kind {
	case SourceFlow, SourceLocalUI:
		if cls != ClassFlow {
			return notAllowed
		}
	case SourcePlanExecutor:
		if cls != ClassMarket {
			return notAllowed
		}
	case SourceCloudCommand:
		if cls != ClassGrid && cls != ClassContract && cls != ClassMarket {
			return notAllowed
		}
	}
	return nil
}

// parseCommand validates the single external command entry per the schema's
// per-type value rules and returns it as a one-entry command set.
func parseCommand(raw json.RawMessage) (entities.Commands, string, error) {
	if len(raw) == 0 {
		return entities.Commands{}, "", schemaErr("command missing")
	}
	var cmd struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return entities.Commands{}, "", schemaErr("command unreadable: %v", err)
	}
	num := func() (float64, error) {
		var v float64
		if err := json.Unmarshal(cmd.Value, &v); err != nil {
			return 0, schemaErr("command %s needs a numeric value", cmd.Type)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, schemaErr("command %s value not finite", cmd.Type)
		}
		return v, nil
	}
	out := entities.Commands{}
	switch cmd.Type {
	case entities.CmdSetpointKw:
		v, err := num()
		if err != nil {
			return out, "", err
		}
		out.SetpointKw = &v
	case entities.CmdLimitKw:
		v, err := num()
		if err != nil {
			return out, "", err
		}
		if v < 0 {
			return out, "", schemaErr("limit_kw must be >= 0")
		}
		out.LimitKw = &v
	case entities.CmdLimitPct:
		v, err := num()
		if err != nil {
			return out, "", err
		}
		if v < 0 || v > 100 {
			return out, "", schemaErr("limit_pct outside 0..100")
		}
		out.LimitPct = &v
	case entities.CmdOnOff:
		var b bool
		if err := json.Unmarshal(cmd.Value, &b); err != nil {
			return out, "", schemaErr("on_off needs a boolean value")
		}
		out.OnOff = &b
	case entities.CmdMode:
		var s string
		if err := json.Unmarshal(cmd.Value, &s); err != nil || s == "" || len(s) > 64 {
			return out, "", schemaErr("mode needs a 1..64 char string value")
		}
		out.Mode = s
	default:
		return out, "", schemaErr("unknown command type %q", cmd.Type)
	}
	return out, cmd.Type, nil
}

// DesiredTopic of one entity (flow runtime -> core, QoS1, never retained).
func DesiredTopic(id string) string { return entities.TopicPrefix + id + "/desired" }

// ArbitrationTopic of one entity (core -> observers, not retained).
func ArbitrationTopic(id string) string { return entities.TopicPrefix + id + "/arbitration" }

// DesiredWildcard subscribes every entity's desired topic.
const DesiredWildcard = entities.TopicPrefix + "+/desired"
