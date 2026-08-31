package topology

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// vectorsPath is the ONE shared derivation vector file, also consumed by the TS
// (frontend/portal/src/topology.test.ts) and Java (TopologyDeriverTest) twins,
// so all three produce the SAME node set from the SAME input.
const vectorsPath = "../../../../docs/contracts/v2/topology-vectors.json"

type vectorFile struct {
	Cases []struct {
		Name     string   `json:"name"`
		Input    Input    `json:"input"`
		Expected Topology `json:"expected"`
	} `json:"cases"`
	DefaultRoleCases []struct {
		Name       string `json:"name"`
		Type       string `json:"type"`
		Category   string `json:"category"`
		Channel    string `json:"channel"`
		Connection string `json:"connection"`
		Expected   string `json:"expected"`
	} `json:"default_role_cases"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("reading topology vectors: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parsing topology vectors: %v", err)
	}
	if len(vf.Cases) == 0 {
		t.Fatal("topology vectors carry no cases")
	}
	return vf
}

// TestDeriveMatchesSharedVectors is the cross-language contract: Derive(input)
// must equal the committed expected topology for every case - the same
// assertion the TS twin makes, so the two draw byte-identical node sets.
func TestDeriveMatchesSharedVectors(t *testing.T) {
	vf := loadVectors(t)
	for _, c := range vf.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Derive(c.Input)
			if !reflect.DeepEqual(got, c.Expected) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(c.Expected, "", "  ")
				t.Fatalf("topology mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
			// Re-marshalling the derived value must reproduce the same JSON the
			// expected (parsed then re-marshalled) yields - the byte-level check.
			gotBytes, _ := json.Marshal(got)
			wantBytes, _ := json.Marshal(c.Expected)
			if string(gotBytes) != string(wantBytes) {
				t.Fatalf("topology JSON mismatch\n got: %s\nwant: %s", gotBytes, wantBytes)
			}
		})
	}
}

// TestDefaultRoleMatchesSharedVectors pins the MAPPING across the three twins.
// The derive vectors cannot cover it - they carry roles that are already
// resolved - and it is exactly where the copies drift (a charge point is
// category "consumer", so only the TYPE keeps it out of the house node).
func TestDefaultRoleMatchesSharedVectors(t *testing.T) {
	vf := loadVectors(t)
	if len(vf.DefaultRoleCases) == 0 {
		t.Fatal("topology vectors carry no default_role_cases")
	}
	for _, c := range vf.DefaultRoleCases {
		t.Run(c.Name, func(t *testing.T) {
			got := DefaultRole(c.Type, c.Category, c.Channel, c.Connection)
			if got != c.Expected {
				t.Fatalf("DefaultRole(%q,%q,%q,%q)=%q want %q",
					c.Type, c.Category, c.Channel, c.Connection, got, c.Expected)
			}
		})
	}
}

// TestChargingRolesAreAppendedSoOlderVectorsStayByteIdentical: the two charging
// roles sit at the END of the canonical order, so every case authored before
// them emits exactly the nodes it always did.
func TestChargingRolesAreAppendedSoOlderVectorsStayByteIdentical(t *testing.T) {
	want := []string{RolePV, RoleStorage, RoleConsumer, RoleGrid, RoleCharging, RoleChargingOwn}
	if !reflect.DeepEqual(canonicalRoleOrder, want) {
		t.Fatalf("canonical role order = %v, want %v", canonicalRoleOrder, want)
	}
}

// TestResolveKeepsAChargePointOutOfTheHouseAndTheBattery is the edge path of
// C2: the box resolves roles itself, so the type + connection must reach
// DefaultRole from RawEntity - a wallbox on its own connection may never sum
// into the house node, and its soc_pct may never reach the storage node.
func TestResolveKeepsAChargePointOutOfTheHouseAndTheBattery(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	in := Resolve([]RawEntity{
		{ID: "H", Type: "house-load", Category: "consumer", Channels: []RawChannel{
			{Channel: "power_kw", Value: f(4.2)},
		}},
		{ID: "W", Type: TypeWallbox, Category: "consumer", Channels: []RawChannel{
			{Channel: "power_kw", Value: f(11)},
			{Channel: socChannel, Value: f(80)},
		}},
		{ID: "C", Type: TypeEvCharger, Category: "consumer", Connection: ConnectionEigen,
			Channels: []RawChannel{{Channel: "power_kw", Value: f(22)}}},
	})
	roles := map[string]string{}
	for _, e := range in.Entities {
		for _, c := range e.Capabilities {
			roles[e.ID+"/"+c.Channel] = c.Role
		}
	}
	for k, want := range map[string]string{
		"H/power_kw": RoleConsumer,
		"W/power_kw": RoleCharging,
		"W/soc_pct":  "",
		"C/power_kw": RoleChargingOwn,
	} {
		if roles[k] != want {
			t.Errorf("role of %s = %q, want %q", k, roles[k], want)
		}
	}
	top := Derive(in)
	byRole := map[string]FlowNode{}
	for _, n := range top.Nodes {
		byRole[n.Role] = n
	}
	if _, has := byRole[RoleStorage]; has {
		t.Error("a wallbox's soc_pct minted a storage node - that is the CAR's charge, not the house battery's")
	}
	if got := byRole[RoleConsumer]; len(got.Members) != 1 || got.Members[0].EntityID != "H" {
		t.Errorf("house node members = %+v, want only the house-load", got.Members)
	}
	if got := byRole[RoleCharging]; got.ValueKw == nil || *got.ValueKw != 11 || got.Direction != "out" {
		t.Errorf("charging node = %+v, want 11 kW out", got)
	}
	if got := byRole[RoleChargingOwn]; got.ValueKw == nil || *got.ValueKw != 22 {
		t.Errorf("charging-own node = %+v, want 22 kW", got)
	}
}

// TestResolveMarksFirstOfRolePrimary pins the edge/pilot default: the FIRST
// capability of each role is maßgeblich, absent overrides.
func TestResolveMarksFirstOfRolePrimary(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	in := Resolve([]RawEntity{
		{ID: "A", Type: "battery-hybrid", Label: "Deye", Category: "storage", Health: "ok",
			Channels: []RawChannel{
				{Channel: "soc_pct", Value: f(62.5)},
				{Channel: "battery_power_kw", Value: f(1)},
				{Channel: "pv_power_kw", Value: f(2)},
			}},
		{ID: "C", Type: "grid-meter", Label: "Netz", Category: "meter", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f(-3)}}},
	})
	// storage: the soc_pct (first storage cap) is primary, battery_power_kw not.
	socCap := in.Entities[0].Capabilities[0]
	battCap := in.Entities[0].Capabilities[1]
	pvCap := in.Entities[0].Capabilities[2]
	gridCap := in.Entities[1].Capabilities[0]
	if socCap.Role != RoleStorage || !socCap.Primary {
		t.Errorf("soc cap: role=%q primary=%v", socCap.Role, socCap.Primary)
	}
	if battCap.Primary {
		t.Error("battery cap should not be primary (soc_pct is first of storage)")
	}
	if pvCap.Role != RolePV || !pvCap.Primary {
		t.Errorf("pv cap: role=%q primary=%v", pvCap.Role, pvCap.Primary)
	}
	if gridCap.Role != RoleGrid || !gridCap.Primary {
		t.Errorf("grid cap: role=%q primary=%v", gridCap.Role, gridCap.Primary)
	}
	// And Derive over the resolved input still lifts the SoC and builds 3 nodes.
	topo := Derive(in)
	if len(topo.Nodes) != 3 {
		t.Fatalf("want 3 nodes, got %d", len(topo.Nodes))
	}
	if topo.Nodes[1].Role != RoleStorage || topo.Nodes[1].SocPct == nil || *topo.Nodes[1].SocPct != 62.5 {
		t.Errorf("storage node SoC not lifted: %+v", topo.Nodes[1])
	}
}

// --- Befund L4: die im Portal gespeicherte Rollen-Zuordnung gewinnt ---------

func f64(v float64) *float64 { return &v }

func rolesOf(in Input) map[string]CapabilityInput {
	out := map[string]CapabilityInput{}
	for _, e := range in.Entities {
		for _, c := range e.Capabilities {
			out[e.ID+"/"+c.Channel] = c
		}
	}
	return out
}

// TestResolvePrefersThePushedRoleOverTheDefault is the whole point of Befund
// L4: an operator who re-purposes a measurement point in the portal must see
// the SAME energy flow on :8484. Before the assignment travelled, this channel
// resolved to the house node on the box while the portal drew it as PV.
func TestResolvePrefersThePushedRoleOverTheDefault(t *testing.T) {
	in := Resolve([]RawEntity{
		{ID: "L", Type: "generic-load", Category: "consumer", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f64(3),
				Assigned: &RoleAssignment{Role: RolePV}}}},
	})
	got := rolesOf(in)["L/power_kw"]
	if got.Role != RolePV {
		t.Fatalf("role = %q, want the pushed %q (the default would be %q)",
			got.Role, RolePV, RoleConsumer)
	}
	// ⚠ An assignment carries its OWN maßgeblich flag, and an absent one means
	// false - VERBATIM the cloud rule (TopologyService.topology takes
	// ov.primary() as it stands). A role can therefore end up with no primary
	// at all, which both nodes tolerate by falling back to the first member;
	// inventing one here would make the box disagree with the portal.
	if got.Primary {
		t.Error("an assignment without primary must not be handed the default flag")
	}
	top := Derive(in)
	if len(top.Nodes) != 1 || top.Nodes[0].Role != RolePV {
		t.Fatalf("nodes = %+v, want a single pv node", top.Nodes)
	}
}

// TestResolveHonoursTheExplicitPrimaryMeter is the second half of L4: the
// operator picks the SECOND grid meter as maßgeblich. The first one must give
// up the flag it only held by position - otherwise the site would carry two
// primaries and the box would disagree with the portal about which meter
// counts.
func TestResolveHonoursTheExplicitPrimaryMeter(t *testing.T) {
	in := Resolve([]RawEntity{
		{ID: "M1", Type: "grid-meter", Category: "meter", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f64(1)}}},
		{ID: "M2", Type: "grid-meter", Category: "meter", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f64(2),
				Assigned: &RoleAssignment{Role: RoleGrid, Primary: true}}}},
	})
	got := rolesOf(in)
	if got["M1/power_kw"].Primary {
		t.Error("the FIRST meter kept the default maßgeblich flag although the operator picked the second")
	}
	if !got["M2/power_kw"].Primary {
		t.Error("the operator's maßgebliche meter is not marked")
	}
	// Both still belong to grid - a primary pick is not a re-assignment.
	if got["M1/power_kw"].Role != RoleGrid || got["M2/power_kw"].Role != RoleGrid {
		t.Errorf("roles = %q / %q, want both grid",
			got["M1/power_kw"].Role, got["M2/power_kw"].Role)
	}
}

// TestResolveFallsBackSilentlyOnAnUnknownRole: a newer cloud may name a role
// this build has never learned. It must lose the assignment, not the diagram -
// a role is presentation, never a control path.
func TestResolveFallsBackSilentlyOnAnUnknownRole(t *testing.T) {
	in := Resolve([]RawEntity{
		{ID: "G", Type: "grid-meter", Category: "meter", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f64(-3),
				Assigned: &RoleAssignment{Role: "waermepumpe-2027", Primary: true}}}},
	})
	got := rolesOf(in)["G/power_kw"]
	if got.Role != RoleGrid {
		t.Fatalf("role = %q, want the DEFAULT %q after an unknown word", got.Role, RoleGrid)
	}
	if !got.Primary {
		t.Error("with the unknown assignment dropped, the default primary rule must apply again")
	}
	if top := Derive(in); len(top.Nodes) != 1 || top.Nodes[0].Role != RoleGrid {
		t.Fatalf("nodes = %+v, want the grid node to survive an unknown role", top.Nodes)
	}
}

// TestResolveWithoutAssignmentsIsByteIdentical: every plant that never
// re-assigned anything - and every older cloud - must resolve exactly as
// before. Additive in the literal sense.
func TestResolveWithoutAssignmentsIsByteIdentical(t *testing.T) {
	raw := []RawEntity{
		{ID: "A", Type: "battery-hybrid", Label: "Deye", Category: "storage", Health: "ok",
			Channels: []RawChannel{
				{Channel: "soc_pct", Value: f64(62.5)},
				{Channel: "battery_power_kw", Value: f64(1)},
				{Channel: "pv_power_kw", Value: f64(2)},
			}},
		{ID: "B", Type: "producer", Category: "producer", Health: "ok",
			Channels: []RawChannel{{Channel: "pv_power_kw", Value: f64(4)}}},
		{ID: "C", Type: "grid-meter", Category: "meter", Health: "ok",
			Channels: []RawChannel{{Channel: "power_kw", Value: f64(-3)}}},
	}
	want, err := json.Marshal(Derive(Resolve(raw)))
	if err != nil {
		t.Fatal(err)
	}
	// The same input with an explicitly EMPTY assignment set must not differ.
	for i := range raw {
		for j := range raw[i].Channels {
			raw[i].Channels[j].Assigned = nil
		}
	}
	got, err := json.Marshal(Derive(Resolve(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("topology drifted without any assignment:\n got %s\nwant %s", got, want)
	}
}

// TestResolveExplicitPrimaryWinsEvenWhenItComesLast pins the ORDER-independence
// the cloud rule has (TopologyService.topology collects the explicit primaries
// before the loop). Without the two-pass shape the first pv capability would
// grab the flag on its way past and the site would report two primaries.
func TestResolveExplicitPrimaryWinsEvenWhenItComesLast(t *testing.T) {
	in := Resolve([]RawEntity{
		{ID: "H", Type: "battery-hybrid", Category: "storage", Health: "ok",
			Channels: []RawChannel{{Channel: "pv_power_kw", Value: f64(2)}}},
		{ID: "P", Type: "producer", Category: "producer", Health: "ok",
			Channels: []RawChannel{{Channel: "pv_power_kw", Value: f64(9),
				Assigned: &RoleAssignment{Role: RolePV, Primary: true}}}},
	})
	got := rolesOf(in)
	if got["H/pv_power_kw"].Primary {
		t.Error("the hybrid grabbed the maßgeblich flag although the producer was picked explicitly")
	}
	if !got["P/pv_power_kw"].Primary {
		t.Error("the explicitly picked producer is not maßgeblich")
	}
}

// TestIsKnownRoleCoversExactlyTheCanonicalSet keeps the gate honest: it must
// accept every role Derive can emit and nothing else.
func TestIsKnownRoleCoversExactlyTheCanonicalSet(t *testing.T) {
	for _, r := range canonicalRoleOrder {
		if !IsKnownRole(r) {
			t.Errorf("IsKnownRole(%q) = false, want true", r)
		}
	}
	for _, r := range []string{"", " ", "PV", "battery", "charging_own"} {
		if IsKnownRole(r) {
			t.Errorf("IsKnownRole(%q) = true, want false", r)
		}
	}
}
