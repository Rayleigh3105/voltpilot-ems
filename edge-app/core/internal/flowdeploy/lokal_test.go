package flowdeploy

// The local runtime (Edge Light's Go twin of the generated consumer rule):
// without Node-RED, the deployer hands verified artifacts to it instead of
// acking "not configured"; a bundle the runtime cannot run is refused with its
// reason; with Node-RED (the Docker box) it is never consulted.

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type fakeLokal struct {
	version string
	calls   [][]Artifact
}

func (f *fakeLokal) PaletteVersion() string { return f.version }

func (f *fakeLokal) Annehmbar(b Bundle) (bool, string) {
	for _, raw := range b.NoderedFlows {
		if strings.Contains(string(raw), `"vp-desired"`) {
			return false, "Knoten vp-desired läuft auf dieser Box nicht"
		}
	}
	return true, ""
}

func (f *fakeLokal) Angleichen(a []Artifact) error {
	f.calls = append(f.calls, append([]Artifact(nil), a...))
	return nil
}

func (f *fakeLokal) last() []Artifact {
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

// consumerRuleArtifact turns the test artifact into the generated-rule shape.
func consumerRuleArtifact(t *testing.T, version int, minPalette string) map[string]any {
	t.Helper()
	return makeArtifact(t, version, func(a map[string]any) {
		b := a["bundle"].(map[string]any)
		nodes := b["nodered_flows"].([]any)
		n := nodes[1].(map[string]any)
		n["type"] = "vp-consumer-policy"
		raw := mustJSON(t, b)
		hash, err := ContentHash(raw)
		if err != nil {
			t.Fatal(err)
		}
		a["content_hash"] = hash
		a["min_palette_version"] = minPalette
	})
}

func newLokalDeployer(t *testing.T, l LokaleLaufzeit) *Deployer {
	t.Helper()
	dep := newDeployer(t, nil)
	if l != nil {
		dep.SetLokaleLaufzeit(l)
	}
	return dep
}

func TestLokaleLaufzeitFuehrtAus(t *testing.T) {
	l := &fakeLokal{version: "0.5.0"}
	dep := newLokalDeployer(t, l)
	dep.HandleDeployment(makeDeployment(t, consumerRuleArtifact(t, 3, "0.5.0")))
	if state, detail := ackOf(t, dep, tFlowID); state != "active" {
		t.Fatalf("local runtime must ack active: %s (%s)", state, detail)
	}
	if got := l.last(); len(got) != 1 || got[0].FlowID != tFlowID || got[0].FlowVersion != 3 {
		t.Fatalf("Angleichen got %+v", got)
	}
	// Retained clear: the runtime is told to run nothing.
	dep.HandleDeployment(nil)
	if got := l.last(); len(got) != 0 {
		t.Fatalf("clear must stop every local flow, got %+v", got)
	}
}

func TestLokaleLaufzeitLehntFremdesBuendelAb(t *testing.T) {
	l := &fakeLokal{version: "0.5.0"}
	dep := newLokalDeployer(t, l)
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 7, nil)))
	state, detail := ackOf(t, dep, tFlowID)
	if state != "unsupported" || !strings.Contains(detail, "vp-desired") {
		t.Fatalf("a bundle the runtime cannot run is unsupported with its reason: %s (%s)", state, detail)
	}
	if got := l.last(); len(got) != 0 {
		t.Fatalf("a refused artifact must not run: %+v", got)
	}
}

func TestLokaleLaufzeitPaletteTor(t *testing.T) {
	l := &fakeLokal{version: "0.5.0"}
	dep := newLokalDeployer(t, l)
	dep.HandleDeployment(makeDeployment(t, consumerRuleArtifact(t, 3, "0.6.0")))
	state, detail := ackOf(t, dep, tFlowID)
	if state != "unsupported" || !strings.Contains(detail, "0.6.0") {
		t.Fatalf("a newer palette floor than the twin reproduces is refused: %s (%s)", state, detail)
	}
}

func TestLokaleLaufzeitNachtraeglichAngehaengt(t *testing.T) {
	dep := newDeployer(t, nil)
	dep.HandleDeployment(makeDeployment(t, consumerRuleArtifact(t, 3, "0.5.0")))
	if state, _ := ackOf(t, dep, tFlowID); state != "error" {
		t.Fatalf("before the runtime is attached the ack is the honest error, got %s", state)
	}
	l := &fakeLokal{version: "0.5.0"}
	dep.SetLokaleLaufzeit(l)
	if state, detail := ackOf(t, dep, tFlowID); state != "active" {
		t.Fatalf("attaching the runtime re-applies at once: %s (%s)", state, detail)
	}
	if len(l.last()) != 1 {
		t.Fatalf("Angleichen got %+v", l.last())
	}
}

func TestLokaleLaufzeitNachNeustartAusDerPlatte(t *testing.T) {
	dir := t.TempDir()
	mk := func() *Deployer {
		return NewDeployer(Deps{DataDir: dir, CoreVersion: "2.1.3", Registry: testRegistry,
			Identity: func() Identity { return Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice} }})
	}
	mk().HandleDeployment(makeDeployment(t, consumerRuleArtifact(t, 3, "0.5.0")))
	// Restart without the cloud: the persisted set runs as soon as the
	// runtime is attached.
	dep := mk()
	l := &fakeLokal{version: "0.5.0"}
	dep.SetLokaleLaufzeit(l)
	if got := l.last(); len(got) != 1 || got[0].FlowID != tFlowID {
		t.Fatalf("persisted set must run after a restart, got %+v", got)
	}
}

func TestMitNodeREDKeineLokaleLaufzeit(t *testing.T) {
	nr := newFakeNR()
	nr.palette = "0.5.0"
	l := &fakeLokal{version: "0.5.0"}
	dep := NewDeployer(Deps{NR: nr, DataDir: t.TempDir(), CoreVersion: "2.1.3", Registry: testRegistry,
		Identity: func() Identity { return Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice} },
		Lokal:    l})
	dep.HandleDeployment(makeDeployment(t, consumerRuleArtifact(t, 3, "0.5.0")))
	if state, detail := ackOf(t, dep, tFlowID); state != "active" {
		t.Fatalf("Node-RED path: %s (%s)", state, detail)
	}
	if len(l.calls) != 0 {
		t.Fatalf("with Node-RED the local runtime is never consulted: %+v", l.calls)
	}
	if !nr.tabIDs()["vpflow-4e1c2b3a-v3"] {
		t.Fatal("the artifact must land in Node-RED")
	}
}
