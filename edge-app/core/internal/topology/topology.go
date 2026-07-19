// Package topology is the shared derivation of the Anlagen-Topologie-Read-Model
// (AE1, contract docs/contracts/v2/topology-read-model.md): the ONE pure
// function that turns {resolved capabilities + live values} into the hub
// topology the adaptive energy-flow diagram renders. This Go copy is the
// canonical implementation; the TS twin (frontend/portal/src/topology.ts) and
// the Java twin (services/api .../topology) MUST stay byte-identical on the
// shared vectors (docs/contracts/v2/topology-vectors.json - the jcs-vectors
// precedent). The edge builds the Input from its applied entity registry + the
// latest per-entity local readings; the portal from the cloud read-model.
package topology

import "math"

// SchemaVersion of the topology read-model (a brand-new contract at 1.0).
const SchemaVersion = "1.0"

// DeadbandKw: below this magnitude a spoke counts as idle (the live.ts /
// dashboard.js 0.05 kW deadband).
const DeadbandKw = 0.05

// The role vocabulary (extensible). Rendered German labels live in the UI.
const (
	RolePV       = "pv"
	RoleStorage  = "storage"
	RoleConsumer = "consumer"
	RoleGrid     = "grid"
)

// canonicalRoleOrder is the deterministic node emission order.
var canonicalRoleOrder = []string{RolePV, RoleStorage, RoleConsumer, RoleGrid}

// socChannel is the one measure channel treated as a SoC input (feeds the
// storage node's soc_pct, never a flow member) regardless of assigned role.
const socChannel = "soc_pct"

// CapabilityInput is one resolved capability of an entity: its measure channel,
// the role it is assigned to ("" = unassigned/informational, skipped), the
// maßgeblich flag, and the latest live value (nil = unknown, never a fabricated
// 0).
type CapabilityInput struct {
	Channel string   `json:"channel"`
	Role    string   `json:"role"`
	Primary bool     `json:"primary"`
	Value   *float64 `json:"value"`
}

// EntityInput is one entity with its resolved capabilities.
type EntityInput struct {
	ID           string            `json:"id"`
	Type         string            `json:"type"`
	Label        string            `json:"label"`
	Category     string            `json:"category"`
	Health       string            `json:"health"`
	Capabilities []CapabilityInput `json:"capabilities"`
}

// Input is the whole site as an entity graph.
type Input struct {
	Entities []EntityInput `json:"entities"`
}

// FlowMember is one contributing entity of a role node.
type FlowMember struct {
	EntityID string   `json:"entity_id"`
	Label    string   `json:"label"`
	Primary  bool     `json:"primary"`
	ValueKw  *float64 `json:"value_kw,omitempty"`
}

// FlowNode is one role node of the hub topology.
type FlowNode struct {
	Role       string       `json:"role"`
	ValueKw    *float64     `json:"value_kw,omitempty"`
	SocPct     *float64     `json:"soc_pct,omitempty"`
	FlowActive bool         `json:"flow_active"`
	Direction  string       `json:"direction,omitempty"`
	Members    []FlowMember `json:"members"`
}

// Topology is the derived hub topology (only present roles, canonical order).
type Topology struct {
	SchemaVersion string     `json:"schema_version"`
	Nodes         []FlowNode `json:"nodes"`
}

// DefaultRole maps a measure channel + entity category to its default role
// (the mapping is overridable in the cloud; the edge and the pilot run on
// defaults). category is storage|producer|meter|consumer (the cloud type
// catalog); the edge's "measure-only" is accepted as "meter".
func DefaultRole(category, channel string) string {
	switch channel {
	case "pv_power_kw":
		return RolePV
	case "battery_power_kw", socChannel:
		return RoleStorage
	case "power_kw":
		switch category {
		case "storage":
			return RoleStorage
		case "producer":
			return RolePV
		case "consumer":
			return RoleConsumer
		case "meter", "measure-only":
			return RoleGrid
		}
	}
	return ""
}

// roleCap pairs a resolved capability with its owning entity, preserving input
// order for deterministic member lists.
type roleCap struct {
	entity EntityInput
	cap    CapabilityInput
}

// Derive builds the hub topology from resolved capabilities + live values.
// Pure and deterministic: roles are emitted in canonical order, members in
// input order, all kW rounded to 3 decimals, an absent value never coerced to
// 0. See topology-read-model.md for the aggregation + sign rules.
func Derive(in Input) Topology {
	buckets := map[string][]roleCap{}
	for _, e := range in.Entities {
		for _, c := range e.Capabilities {
			if c.Role == "" {
				continue
			}
			buckets[c.Role] = append(buckets[c.Role], roleCap{entity: e, cap: c})
		}
	}

	nodes := make([]FlowNode, 0, len(buckets))
	for _, role := range canonicalRoleOrder {
		caps, ok := buckets[role]
		if !ok {
			continue
		}
		switch role {
		case RoleGrid:
			nodes = append(nodes, gridNode(role, caps))
		case RoleStorage:
			nodes = append(nodes, storageNode(role, caps))
		default:
			nodes = append(nodes, sumNode(role, caps))
		}
	}
	// A role reached via an override but carrying only a soc_pct/no flow cap
	// still emits (present), handled inside the builders.
	return Topology{SchemaVersion: SchemaVersion, Nodes: nodes}
}

// sumNode aggregates a producing/consuming role: value = |Σ flow members|,
// direction fixed by the role (pv -> in, consumer -> out).
func sumNode(role string, caps []roleCap) FlowNode {
	members := make([]FlowMember, 0, len(caps))
	var sum float64
	hasValue := false
	for _, rc := range caps {
		if rc.cap.Channel == socChannel {
			continue
		}
		members = append(members, member(rc))
		if rc.cap.Value != nil {
			sum += *rc.cap.Value
			hasValue = true
		}
	}
	node := FlowNode{Role: role, Members: members}
	if !hasValue {
		return node
	}
	mag := round3(math.Abs(sum))
	node.ValueKw = &mag
	if mag > DeadbandKw {
		node.FlowActive = true
		if role == RoleConsumer {
			node.Direction = "out"
		} else {
			node.Direction = "in"
		}
	}
	return node
}

// storageNode aggregates battery power (measured) and lifts the SoC from the
// primary (else first) soc_pct capability. Charge (+) -> out, discharge (-) -> in.
func storageNode(role string, caps []roleCap) FlowNode {
	members := make([]FlowMember, 0, len(caps))
	var sum float64
	hasValue := false
	var soc *float64
	var socPrimary bool
	for _, rc := range caps {
		if rc.cap.Channel == socChannel {
			if rc.cap.Value == nil {
				continue
			}
			// Prefer the primary soc; otherwise the first one seen.
			if soc == nil || (rc.cap.Primary && !socPrimary) {
				v := round3(*rc.cap.Value)
				soc = &v
				socPrimary = rc.cap.Primary
			}
			continue
		}
		members = append(members, member(rc))
		if rc.cap.Value != nil {
			sum += *rc.cap.Value
			hasValue = true
		}
	}
	node := FlowNode{Role: role, SocPct: soc, Members: members}
	if !hasValue {
		return node
	}
	mag := round3(math.Abs(sum))
	node.ValueKw = &mag
	if mag > DeadbandKw {
		node.FlowActive = true
		if sum > 0 {
			node.Direction = "out" // charging: hub -> battery
		} else {
			node.Direction = "in" // discharging: battery -> hub
		}
	}
	return node
}

// gridNode takes the maßgebliche (primary, else first) member's SIGNED value -
// never a sum. Import (+) -> in, export (-) -> out.
func gridNode(role string, caps []roleCap) FlowNode {
	members := make([]FlowMember, 0, len(caps))
	primaryIdx := -1
	for i, rc := range caps {
		members = append(members, member(rc))
		if primaryIdx == -1 && rc.cap.Primary {
			primaryIdx = i
		}
	}
	if primaryIdx == -1 && len(caps) > 0 {
		primaryIdx = 0
	}
	node := FlowNode{Role: role, Members: members}
	if primaryIdx == -1 {
		return node
	}
	v := caps[primaryIdx].cap.Value
	if v == nil {
		return node
	}
	mag := round3(math.Abs(*v))
	node.ValueKw = &mag
	if mag > DeadbandKw {
		node.FlowActive = true
		if *v > 0 {
			node.Direction = "in" // import (Bezug)
		} else {
			node.Direction = "out" // export (Einspeisung)
		}
	}
	return node
}

func member(rc roleCap) FlowMember {
	m := FlowMember{EntityID: rc.entity.ID, Label: rc.entity.Label, Primary: rc.cap.Primary}
	if rc.cap.Value != nil {
		v := round3(*rc.cap.Value)
		m.ValueKw = &v
	}
	return m
}

func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}

// --- Default resolution (edge path: no overrides) --------------------------

// RawChannel is one measure channel + its latest live value before role
// resolution.
type RawChannel struct {
	Channel string
	Value   *float64
}

// RawEntity is an entity before role resolution - the shape the edge builds
// from its applied registry + latest readings.
type RawEntity struct {
	ID, Type, Label, Category, Health string
	Channels                          []RawChannel
}

// Resolve assigns each channel its DefaultRole and the default maßgeblich flag
// (the FIRST capability of each role, in entity+channel order, is primary),
// producing the Derive Input. This is the edge/pilot path; the cloud layers
// stored overrides on top of the same defaults. Channels that resolve to no
// role are kept (role "") so Derive skips them consistently.
func Resolve(raw []RawEntity) Input {
	firstOfRole := map[string]bool{}
	entities := make([]EntityInput, 0, len(raw))
	for _, e := range raw {
		caps := make([]CapabilityInput, 0, len(e.Channels))
		for _, ch := range e.Channels {
			role := DefaultRole(e.Category, ch.Channel)
			primary := false
			if role != "" && !firstOfRole[role] {
				primary = true
				firstOfRole[role] = true
			}
			caps = append(caps, CapabilityInput{
				Channel: ch.Channel, Role: role, Primary: primary, Value: ch.Value,
			})
		}
		entities = append(entities, EntityInput{
			ID: e.ID, Type: e.Type, Label: e.Label, Category: e.Category,
			Health: e.Health, Capabilities: caps,
		})
	}
	return Input{Entities: entities}
}
