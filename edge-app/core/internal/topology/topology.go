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
	// RoleCharging: charge points BEHIND the house connection. Their kilowatts
	// are already inside the house-load measurement, so the node is a BRANCH
	// off the consumer node and the house sum stays "everything behind the
	// connection point" (concept vp-verbraucher-cockpit-k1 §6, E3).
	RoleCharging = "charging"
	// RoleChargingOwn: charge points on their OWN grid connection / meter.
	// Their kilowatts are NOT in the house-load measurement, so the node hangs
	// at the hub NEXT TO the house and the house never contains them. Two
	// roles, not one node with two attachments: the two sums are measured at
	// two DIFFERENT connection points, and adding them would be one number
	// with two meanings.
	RoleChargingOwn = "charging-own"
)

// canonicalRoleOrder is the deterministic node emission order. The charging
// roles are APPENDED on purpose: every vector authored before them stays
// byte-identical, because a site without a charge point emits neither node.
var canonicalRoleOrder = []string{
	RolePV, RoleStorage, RoleConsumer, RoleGrid, RoleCharging, RoleChargingOwn,
}

// IsKnownRole reports whether this build understands a role word. It is the
// ONE gate on a role that arrives from the cloud (RawChannel.Assigned, Befund
// L4): an unknown word is DROPPED and the channel falls back to DefaultRole,
// never refused - a role is presentation, and a future cloud must be able to
// name a role an older box has not learned yet without tearing its energy flow
// apart.
func IsKnownRole(role string) bool {
	for _, r := range canonicalRoleOrder {
		if r == role {
			return true
		}
	}
	return false
}

// The entity TYPES that are charge points. Their power is charging, never
// ordinary house load - and their soc_pct belongs to the CAR (see DefaultRole).
const (
	TypeEvCharger = "ev-charger"
	TypeWallbox   = "wallbox"
)

// The entity TYPES a customer DEFINED THEMSELVES in the portal (Einheitsmodell
// Stufe 3/4, vp-modbus-baukasten-k6): a free Modbus sensor and - once the
// customer passed the guided switch test - a free Modbus switching device.
// Their measure channels are named by the CUSTOMER, not by a driver we wrote.
const (
	TypeModbusGeneric = "modbus-generic"
	TypeModbusLoad    = "modbus-load"
)

// IsSelfBuiltType reports whether an entity TYPE was defined by the customer
// themselves. Like IsChargingType this cannot be answered on the category: a
// modbus-generic is category "meter" (it declares no actuate capability) and a
// modbus-load is category "consumer", exactly like a grid meter and a heating
// rod - which is precisely why the TYPE has to answer it.
func IsSelfBuiltType(entityType string) bool {
	return entityType == TypeModbusGeneric || entityType == TypeModbusLoad
}

// The connection of a charge point (Cockpit Phase 1 / C1): behind the house
// connection, or on its own. "" = the portal never said - read as haus, the
// safe direction: the house measurement is assumed to contain it, exactly what
// the box's budget law already assumes.
const (
	ConnectionHaus  = "haus"
	ConnectionEigen = "eigen"
)

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

// IsChargingType reports whether an entity TYPE is a charge point. The
// distinction cannot be made on the category: ev-charger and wallbox are both
// category "consumer" in the type catalog, exactly like a heating rod.
func IsChargingType(entityType string) bool {
	return entityType == TypeEvCharger || entityType == TypeWallbox
}

// DefaultRole maps an entity TYPE + category + measure channel + charge-point
// connection to the default role (the mapping is overridable in the cloud; the
// edge and the pilot run on defaults). category is storage|producer|meter|
// consumer (the cloud type catalog); the edge's "measure-only" is accepted as
// "meter". connection is only consulted for charge points ("" = haus).
//
// ⚠ THE TYPE IS CHECKED FIRST, and that is the whole point of the parameter:
// a charge point is category "consumer", so without it its power would sum
// into the house node it is already measured inside, and its soc_pct would
// fall through to the storage rule below and start filling in the HOUSE
// battery's state of charge (the reason agent/ocpp_entities.go deliberately
// never publishes it). Both are wrong about a customer's plant, so they are
// answered here rather than left to the restraint of every producer.
func DefaultRole(entityType, category, channel, connection string) string {
	// ⚠ A SELF-BUILT device NEVER gets an energy-flow role - not even for a
	// channel it happens to have named `power_kw`. Two independent reasons,
	// and the first one is a promise the platform already printed:
	//
	//  1. Bilanz-Ehrlichkeit (Einheitsmodell Stufe 3): "ein Selbstbau-Sensor
	//     ist ein Topologie-Knoten mit eigenen Messwerten und geht NICHT in die
	//     Energiebilanz ein" - the assistant says exactly that to the customer
	//     while they define the device.
	//  2. Without this branch the category decided, and a modbus-generic is
	//     category "meter" (it declares no actuate capability) - so a channel
	//     called `power_kw` fell into the meter rule and the customer's
	//     cistern/heat-pump sensor was rendered AS THE GRID CONNECTION POINT
	//     (scout vp-portal-box-spiegel-s2, L5). The grid node may only ever be
	//     built from a real grid meter. A modbus-load is category "consumer"
	//     and would double-count into the house node it is already measured
	//     inside - the identical argument that moved charge points out of the
	//     consumer role above.
	//
	// The channels themselves are NOT lost: they keep their own per-entity
	// measurements (Messwerte/Verlauf), and the box lists the device in its own
	// "Eigene Geräte" group on :8484. Only the energy BALANCE stays untouched.
	//
	// ⚠ This is the DEFAULT, and an explicit stored assignment still wins over
	// it in Resolve (Befund L4) - deliberately: the override exists for exactly
	// "the platform's default is wrong for MY plant", and an operator who says
	// so is not guessing. What L5 was about is the default being a falsehood on
	// its own.
	if IsSelfBuiltType(entityType) {
		return ""
	}
	if IsChargingType(entityType) {
		switch channel {
		case "power_kw":
			if connection == ConnectionEigen {
				return RoleChargingOwn
			}
			return RoleCharging
		case socChannel:
			// The CAR's state of charge, not the station's and not the house
			// battery's. Never a flow member, never another node's SoC.
			return ""
		}
		return ""
	}
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

// isConsuming reports whether a summed role draws FROM the hub (direction
// "out"): the house and both charging roles.
func isConsuming(role string) bool {
	return role == RoleConsumer || role == RoleCharging || role == RoleChargingOwn
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
		if isConsuming(role) {
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
	// Assigned is the CLOUD's stored role assignment for this channel (AE1
	// entity_role_assignment, delivered in the registry push as
	// descriptor.role_assignment). nil = none stored -> DefaultRole decides,
	// which is what every plant without a re-assignment and every older cloud
	// sends. A role word this build does not know is dropped by Resolve.
	Assigned *RoleAssignment
}

// RoleAssignment is the cloud's stored assignment of ONE channel: the role it
// belongs to and whether it is the maßgebliche (primary) measurement of that
// role.
type RoleAssignment struct {
	Role    string
	Primary bool
}

// RawEntity is an entity before role resolution - the shape the edge builds
// from its applied registry + latest readings.
type RawEntity struct {
	ID, Type, Label, Category, Health string
	// Connection is only meaningful for a charge point: haus|eigen, "" = not
	// stated (read as haus). See DefaultRole.
	Connection string
	Channels   []RawChannel
}

// Resolve assigns each channel its role and the maßgeblich flag, producing the
// Derive Input. A channel with a CLOUD assignment (RawChannel.Assigned, the
// registry push's descriptor.role_assignment - Befund L4) takes it; every other
// channel keeps its DefaultRole and the default rule "the FIRST capability of
// each role, in entity+channel order, is primary".
//
// ⚠ THE RULE IS THE CLOUD'S, VERBATIM (TopologyService.topology): the default
// primary is only handed out for roles for which NOBODY was explicitly marked
// maßgeblich, so an operator who picks the second grid meter does not end up
// with two primaries - the first one silently keeping the flag it got by
// position. Both twins must keep this shape, otherwise :8484 and the portal
// draw two different energy flows over the same plant, which is exactly the
// defect this consumes the assignment for.
//
// ⚠ An assignment naming a role this build does not know is DROPPED (the
// channel falls back to its default), never an error: a role is presentation,
// not a control path, and a newer cloud must not be able to break an older
// box's diagram. Channels that resolve to no role at all are kept (role "") so
// Derive skips them consistently.
func Resolve(raw []RawEntity) Input {
	// Roles somebody was explicitly marked maßgeblich for - computed over the
	// WHOLE site first, because the default primary below must know about an
	// explicit pick that appears only later in the input order.
	explicitPrimary := map[string]bool{}
	for _, e := range raw {
		for _, ch := range e.Channels {
			if r, ok := assignedRole(ch); ok && ch.Assigned.Primary {
				explicitPrimary[r] = true
			}
		}
	}
	firstOfRole := map[string]bool{}
	entities := make([]EntityInput, 0, len(raw))
	for _, e := range raw {
		caps := make([]CapabilityInput, 0, len(e.Channels))
		for _, ch := range e.Channels {
			role := DefaultRole(e.Type, e.Category, ch.Channel, e.Connection)
			primary := false
			if r, ok := assignedRole(ch); ok {
				role, primary = r, ch.Assigned.Primary
			} else if role != "" && !explicitPrimary[role] && !firstOfRole[role] {
				primary = true
			}
			if role != "" {
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

// assignedRole reports the cloud-assigned role of a channel, if it carries one
// this build understands. It is the single place the unknown-role fallback
// lives, so no caller can forget it.
func assignedRole(ch RawChannel) (string, bool) {
	if ch.Assigned == nil || !IsKnownRole(ch.Assigned.Role) {
		return "", false
	}
	return ch.Assigned.Role, true
}
