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
