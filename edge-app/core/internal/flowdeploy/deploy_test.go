package flowdeploy

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// --- fake Node-RED admin --------------------------------------------------

// fakeNR models the GLOBAL /flows API: a stored node array that honors the
// ids the caller supplies (exactly what the real full-config API does, unlike
// the per-flow POST /flow which generates ids).
type fakeNR struct {
	mu      sync.Mutex
	palette string
	config  []json.RawMessage
	posts   int
	fail    bool
}

func newFakeNR() *fakeNR {
	return &fakeNR{palette: "0.2.0"}
}

func (f *fakeNR) PaletteVersion() (string, error) {
	if f.fail {
		return "", fmt.Errorf("runtime down")
	}
	return f.palette, nil
}

func (f *fakeNR) GetFlows() ([]json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return nil, fmt.Errorf("runtime down")
	}
	return append([]json.RawMessage(nil), f.config...), nil
}

func (f *fakeNR) PostFlows(flows []json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return fmt.Errorf("runtime down")
	}
	f.posts++
	f.config = append([]json.RawMessage(nil), flows...)
	return nil
}

// tabIDs returns the ids of tab nodes in the stored config.
func (f *fakeNR) tabIDs() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for _, raw := range f.config {
		var n struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &n) == nil && n.Type == "tab" {
			out[n.ID] = true
		}
	}
	return out
}

// --- fixtures ---------------------------------------------------------------

const (
	tTenant = "00000000-0000-0000-0000-000000000001"
	tSite   = "00000000-0000-0000-0000-000000000002"
	tDevice = "00000000-0000-0000-0000-000000000003"
	tFlowID = "4e1c2b3a-5d6e-4f70-8123-456789abcdef"
)

func testRegistry() entities.Registry {
	return entities.Registry{Revision: "rev-1", Entities: []entities.Entity{
		{
			ID: "batt-main", Type: entities.TypeBatteryHybrid,
			Capabilities: entities.Capabilities{
				Measure: []entities.MeasureCap{{Channel: "soc_pct"}},
				Actuate: []entities.ActuateCap{{Command: "setpoint_kw"}},
			},
			Guards: entities.Guards{Failsafe: entities.Failsafe{Behavior: "self-consumption"}},
		},
	}}
}

// makeArtifact builds a deployable artifact with a correct content hash.
func makeArtifact(t *testing.T, version int, mutate func(map[string]any)) map[string]any {
	t.Helper()
	tabID := fmt.Sprintf("vpflow-4e1c2b3a-v%d", version)
	bundle := map[string]any{
		"format":  "nodered-tabs",
		"tab_ids": []any{tabID},
		"nodered_flows": []any{
			map[string]any{
				"id":    tabID,
				"type":  "tab",
				"label": fmt.Sprintf("VP Flow v%d", version),
				"info":  fmt.Sprintf("@vp-flow flow_id=%s flow_version=%d", tFlowID, version),
			},
			map[string]any{
				"id": tabID + "-n1", "type": "vp-desired", "z": tabID,
				"entity": "batt-main", "command": "setpoint_kw", "ttl_s": 180,
			},
		},
	}
	bundleRaw, _ := json.Marshal(bundle)
	hash, err := ContentHash(bundleRaw)
	if err != nil {
		t.Fatal(err)
	}
	a := map[string]any{
		"schema_version":      "1.0",
		"kind":                "artifact",
		"artifact_id":         "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
		"flow_id":             tFlowID,
		"flow_version":        version,
		"runtime":             "edge",
		"content_hash":        hash,
		"compiled_at":         "2026-07-18T11:02:33Z",
		"compiler_version":    "1.0.0",
		"min_palette_version": "0.2.0",
		"min_core_version":    "0.1.0",
		"required_entities": []any{
			map[string]any{"entity_id": "batt-main",
				"capabilities": []any{"measure:soc_pct", "actuate:setpoint_kw"}},
		},
		"bundle": bundle,
	}
	if mutate != nil {
		mutate(a)
	}
	return a
}

func makeDeployment(t *testing.T, artifacts ...map[string]any) []byte {
	t.Helper()
	arts := make([]any, 0, len(artifacts))
	for _, a := range artifacts {
		arts = append(arts, a)
	}
	raw, err := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"kind":           "deployment",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"deployed_at":    "2026-07-18T12:00:00Z",
		"artifacts":      arts,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func newDeployer(t *testing.T, nr NRClient) *Deployer {
	t.Helper()
	return NewDeployer(Deps{
		NR:          nr,
		DataDir:     t.TempDir(),
		CoreVersion: "2.1.3",
		Registry:    testRegistry,
		Identity: func() Identity {
			return Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice}
		},
	})
}

func ackOf(t *testing.T, dep *Deployer, flowID string) (state, detail string) {
	t.Helper()
	sum := dep.Summary()
	if sum == nil {
		t.Fatal("no flows summary")
	}
	for _, a := range sum.Applied {
		if a.FlowID == flowID {
			return a.State, a.Detail
		}
	}
	t.Fatalf("flow %s not acked: %+v", flowID, sum.Applied)
	return "", ""
}

// --- tests ------------------------------------------------------------------

func TestApplyReplaceAndClear(t *testing.T) {
	nr := newFakeNR()
	dep := newDeployer(t, nr)

	// A vendor tab pre-exists in the runtime; it must survive every apply.
	vendor := json.RawMessage(`{"id":"tab-auto","type":"tab","label":"Vorlage"}`)
	nr.config = []json.RawMessage{vendor}

	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil)))
	if state, detail := ackOf(t, dep, tFlowID); state != "active" {
		t.Fatalf("want active, got %s (%s)", state, detail)
	}
	tabs := nr.tabIDs()
	if !tabs["vpflow-4e1c2b3a-v7"] || !tabs["tab-auto"] || nr.posts != 1 {
		t.Fatalf("tab not created / vendor lost: %v posts=%d", tabs, nr.posts)
	}

	// Idempotent redeploy: same payload converges without churn (no POST).
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil)))
	if nr.posts != 1 {
		t.Fatalf("idempotent redeploy must not rewrite: posts=%d", nr.posts)
	}

	// A NEW version replaces: deterministic new tab id, the old tab removed,
	// the vendor tab untouched.
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 8, nil)))
	tabs = nr.tabIDs()
	if !tabs["vpflow-4e1c2b3a-v8"] || tabs["vpflow-4e1c2b3a-v7"] || !tabs["tab-auto"] {
		t.Fatalf("v7->v8 replace wrong: %v", tabs)
	}

	// Retained-clear removes every artifact tab; the vendor tab stays.
	dep.HandleDeployment(nil)
	tabs = nr.tabIDs()
	if len(tabs) != 1 || !tabs["tab-auto"] {
		t.Fatalf("clear must remove all artifact tabs, keep vendor: %v", tabs)
	}
	sum := dep.Summary()
	if sum == nil || len(sum.Applied) != 0 {
		t.Fatalf("cleared summary must be empty: %+v", sum)
	}
}

func TestRefusalAcks(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(map[string]any)
		wantState  string
		wantDetail string
	}{
		{"palette gate", func(a map[string]any) { a["min_palette_version"] = "9.9.9" },
			"unsupported", "Palette"},
		{"core gate", func(a map[string]any) { a["min_core_version"] = "9.9.9" },
			"unsupported", "Core"},
		{"unknown entity", func(a map[string]any) {
			a["required_entities"] = []any{map[string]any{"entity_id": "nobody",
				"capabilities": []any{"measure:power_kw"}}}
		}, "unsupported", "nicht bekannt"},
		{"missing capability", func(a map[string]any) {
			a["required_entities"] = []any{map[string]any{"entity_id": "batt-main",
				"capabilities": []any{"actuate:on_off"}}}
		}, "unsupported", "bietet"},
		{"cloud runtime", func(a map[string]any) { a["runtime"] = "cloud" },
			"unsupported", "Laufzeit"},
		{"hash mismatch", func(a map[string]any) {
			a["content_hash"] = "sha256:" + strings.Repeat("0", 64)
		}, "error", "content_hash"},
	}
	for _, c := range cases {
		nr := newFakeNR()
		dep := newDeployer(t, nr)
		dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, c.mutate)))
		state, detail := ackOf(t, dep, tFlowID)
		if state != c.wantState || !strings.Contains(detail, c.wantDetail) {
			t.Errorf("%s: got %s (%s), want %s (*%s*)", c.name, state, detail, c.wantState, c.wantDetail)
		}
		if len(nr.tabIDs()) != 0 {
			t.Errorf("%s: refused artifact must not be deployed", c.name)
		}
	}
}

func TestUnmarkedTabIsRefused(t *testing.T) {
	nr := newFakeNR()
	dep := newDeployer(t, nr)
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, func(a map[string]any) {
		bundle := a["bundle"].(map[string]any)
		flows := bundle["nodered_flows"].([]any)
		tab := flows[0].(map[string]any)
		tab["info"] = "just a note" // no @vp-flow marker
		raw, _ := json.Marshal(bundle)
		hash, _ := ContentHash(raw)
		a["content_hash"] = hash
	})))
	state, detail := ackOf(t, dep, tFlowID)
	if state != "error" || !strings.Contains(detail, "@vp-flow") {
		t.Fatalf("unmarked tab must be refused naming the marker: %s (%s)", state, detail)
	}
}

func TestPartialSetApplies(t *testing.T) {
	// One failing artifact never blocks the others (apply is per artifact).
	nr := newFakeNR()
	dep := newDeployer(t, nr)
	bad := makeArtifact(t, 3, func(a map[string]any) {
		a["flow_id"] = "aaaaaaaa-0000-0000-0000-000000000001"
		a["min_palette_version"] = "9.9.9"
		bundle := a["bundle"].(map[string]any)
		bundle["tab_ids"] = []any{"vpflow-bad-v3"}
		flows := bundle["nodered_flows"].([]any)
		flows[0].(map[string]any)["id"] = "vpflow-bad-v3"
		flows[1].(map[string]any)["z"] = "vpflow-bad-v3"
		flows[1].(map[string]any)["id"] = "vpflow-bad-v3-n1"
		raw, _ := json.Marshal(bundle)
		hash, _ := ContentHash(raw)
		a["content_hash"] = hash
	})
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil), bad))
	if state, _ := ackOf(t, dep, tFlowID); state != "active" {
		t.Fatalf("good artifact must apply, got %s", state)
	}
	if state, _ := ackOf(t, dep, "aaaaaaaa-0000-0000-0000-000000000001"); state != "unsupported" {
		t.Fatalf("bad artifact must be refused, got %s", state)
	}
	if !nr.tabIDs()["vpflow-4e1c2b3a-v7"] {
		t.Fatal("good artifact tab missing")
	}
	if nr.tabIDs()["vpflow-bad-v3"] {
		t.Fatal("refused artifact tab deployed")
	}
}

func TestUnconfiguredRuntimeAcksHonestly(t *testing.T) {
	dep := newDeployer(t, nil) // no NR client = VP_NODERED_ADMIN_URL unset
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil)))
	state, detail := ackOf(t, dep, tFlowID)
	if state != "error" || !strings.Contains(detail, "VP_NODERED_ADMIN_URL") {
		t.Fatalf("unconfigured runtime must ack error naming the setting: %s (%s)", state, detail)
	}
}

func TestIdentityMismatchIsRejected(t *testing.T) {
	nr := newFakeNR()
	dep := newDeployer(t, nr)
	payload := strings.Replace(string(makeDeployment(t, makeArtifact(t, 7, nil))),
		tDevice, "99999999-0000-0000-0000-000000000009", 1)
	dep.HandleDeployment([]byte(payload))
	if dep.Summary() != nil {
		t.Fatal("a foreign deployment must not be adopted")
	}
	if len(nr.tabIDs()) != 0 {
		t.Fatal("a foreign deployment must not deploy")
	}
}

func TestPersistedDeploymentSelfHealsOnReconcile(t *testing.T) {
	nr := newFakeNR()
	dep := newDeployer(t, nr)
	dir := dep.dir
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil)))
	if !nr.tabIDs()["vpflow-4e1c2b3a-v7"] {
		t.Fatal("precondition: tab deployed")
	}

	// A fresh core boot (new deployer, same data dir) against a WIPED runtime
	// (reseed dropped the artifact tab): Reconcile restores from truth.
	nr2 := newFakeNR()
	dep2 := NewDeployer(Deps{NR: nr2, DataDir: dir, CoreVersion: "2.1.3",
		Registry: testRegistry,
		Identity: func() Identity {
			return Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice}
		}})
	dep2.Reconcile()
	if !nr2.tabIDs()["vpflow-4e1c2b3a-v7"] {
		t.Fatal("persisted deployment must self-heal the dropped artifact tab")
	}
	if state, _ := ackOf(t, dep2, tFlowID); state != "active" {
		t.Fatal("self-healed artifact must ack active")
	}
}

func TestVersionSatisfies(t *testing.T) {
	cases := []struct {
		installed, min string
		want           bool
	}{
		{"0.2.0", "0.2.0", true},
		{"0.2.1", "0.2.0", true},
		{"0.2.0", "0.2.1", false},
		{"1.0.0", "0.9.9", true},
		{"dev", "2.0.0", true},   // unstamped build passes (documented)
		{"", "2.0.0", true},      // unknown installed passes
		{"1.0.0", "garbage", false}, // garbled gate refuses
		{"2.1.3-rc1", "2.1.3", true},
	}
	for _, c := range cases {
		if got := versionSatisfies(c.installed, c.min); got != c.want {
			t.Errorf("versionSatisfies(%q,%q) = %v, want %v", c.installed, c.min, got, c.want)
		}
	}
}
