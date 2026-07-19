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

func TestDefaultRole(t *testing.T) {
	cases := []struct {
		category, channel, want string
	}{
		{"storage", "pv_power_kw", RolePV},
		{"producer", "pv_power_kw", RolePV},
		{"storage", "battery_power_kw", RoleStorage},
		{"storage", "soc_pct", RoleStorage},
		{"storage", "power_kw", RoleStorage},
		{"producer", "power_kw", RolePV},
		{"consumer", "power_kw", RoleConsumer},
		{"meter", "power_kw", RoleGrid},
		{"measure-only", "power_kw", RoleGrid},
		{"consumer", "energy_kwh", ""},
		{"meter", "frequency_hz", ""},
	}
	for _, c := range cases {
		if got := DefaultRole(c.category, c.channel); got != c.want {
			t.Errorf("DefaultRole(%q,%q)=%q want %q", c.category, c.channel, got, c.want)
		}
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
