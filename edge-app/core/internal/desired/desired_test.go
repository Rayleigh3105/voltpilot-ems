package desired

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// The CONTRACT FIXTURES (docs/contracts/v2/examples) drive the happy paths -
// moving them breaks these tests deliberately (they are the executable
// contract check, the entities-test precedent).
const fixtureDir = "../../../../docs/contracts/v2/examples"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("contract fixture unreadable: %v", err)
	}
	return raw
}

var now = time.Date(2026, 7, 18, 10, 20, 0, 0, time.UTC)

func TestParseFlowSetpointFixture(t *testing.T) {
	raw := fixture(t, "edge-desired.valid.flow-setpoint.json")
	d, err := Parse("9f6f4a1e-3c2d-4b8a-9e51-0d2f8c7a1b22", raw, now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Priority != ClassFlow || d.Source.Kind != SourceFlow || d.Source.NodeID != "n3" {
		t.Fatalf("parsed desired wrong: %+v", d)
	}
	if d.Commands.SetpointKw == nil || *d.Commands.SetpointKw != 7.4 || d.RequestedType != "setpoint_kw" {
		t.Fatalf("command wrong: %+v", d.Commands)
	}
	if d.TTL != 180*time.Second {
		t.Fatalf("ttl wrong: %v", d.TTL)
	}
	// issued_at (10:15:02) is before receive -> anchors the TTL there.
	if want := d.IssuedAt.Add(180 * time.Second); !d.ExpiresAt().Equal(want) {
		t.Fatalf("expiry %v, want %v", d.ExpiresAt(), want)
	}
}

func TestParseOverrideFixtureCapsTTL(t *testing.T) {
	raw := fixture(t, "edge-desired.valid.override-onoff.json")
	d, err := Parse("heatrod-cellar", raw, now)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Override || d.Commands.OnOff == nil || !*d.Commands.OnOff {
		t.Fatalf("override on_off wrong: %+v", d)
	}
	// Fixture ttl 3600 is under the cap; a synthetic 86400 override caps at 4 h.
	long := strings.Replace(string(raw), `"ttl_s": 3600`, `"ttl_s": 86400`, 1)
	d2, err := Parse("heatrod-cellar", []byte(long), now)
	if err != nil {
		t.Fatal(err)
	}
	if got := d2.ExpiresAt().Sub(d2.anchor()); got != OverrideTTLCap {
		t.Fatalf("override ttl not capped: %v", got)
	}
}

func TestParseMissingTTLFixtureRejected(t *testing.T) {
	raw := fixture(t, "edge-desired.invalid.missing-ttl.json")
	_, err := Parse("9f6f4a1e-3c2d-4b8a-9e51-0d2f8c7a1b22", raw, now)
	pe, ok := err.(*ParseError)
	if !ok || pe.Stage != "validation:schema" || !strings.Contains(pe.Detail, "ttl_s") {
		t.Fatalf("want schema refusal naming ttl_s, got %v", err)
	}
}

func TestParseIdentityMismatchIsSilentlyIgnorable(t *testing.T) {
	raw := fixture(t, "edge-desired.valid.flow-setpoint.json")
	_, err := Parse("another-entity", raw, now)
	if _, ok := err.(*IdentityMismatchError); !ok {
		t.Fatalf("want IdentityMismatchError, got %v", err)
	}
}

func TestParsePriorityNotAllowed(t *testing.T) {
	cases := []struct{ kind, priority string }{
		{"flow", "market"},
		{"flow", "safety"},
		{"flow", "grid"},
		{"local-ui", "market"},
		{"plan-executor", "flow"},
		{"cloud-command", "safety"},
		{"cloud-command", "flow"},
	}
	for _, c := range cases {
		payload := `{"schema_version":"1.0","entity_id":"e1","request_id":"r1",` +
			`"source":{"kind":"` + c.kind + `","flow_id":"d0eaf5aa-9b1c-4d2e-8f30-415263748596","flow_version":1,"node_id":"n1"},` +
			`"priority":"` + c.priority + `","command":{"type":"setpoint_kw","value":1},` +
			`"ttl_s":60,"issued_at":"2026-07-18T10:00:00Z"}`
		_, err := Parse("e1", []byte(payload), now)
		pe, ok := err.(*ParseError)
		if !ok || pe.Stage != "arbitration:priority_not_allowed" {
			t.Fatalf("%s claiming %s: want priority_not_allowed, got %v", c.kind, c.priority, err)
		}
	}
	// cloud-command MAY claim the reserved grid/contract classes (E8 masters).
	for _, p := range []string{"grid", "contract", "market"} {
		payload := `{"schema_version":"1.0","entity_id":"e1","request_id":"r1",` +
			`"source":{"kind":"cloud-command"},"priority":"` + p + `",` +
			`"command":{"type":"setpoint_kw","value":1},"ttl_s":60,"issued_at":"2026-07-18T10:00:00Z"}`
		if _, err := Parse("e1", []byte(payload), now); err != nil {
			t.Fatalf("cloud-command claiming %s must parse: %v", p, err)
		}
	}
}

func TestParseCommandTyping(t *testing.T) {
	mk := func(cmd string) string {
		return `{"schema_version":"1.0","entity_id":"e1","request_id":"r1",` +
			`"source":{"kind":"local-ui"},"priority":"flow","command":` + cmd +
			`,"ttl_s":60,"issued_at":"2026-07-18T10:00:00Z"}`
	}
	bad := []string{
		`{"type":"setpoint_kw","value":"x"}`,
		`{"type":"limit_kw","value":-1}`,
		`{"type":"limit_pct","value":101}`,
		`{"type":"on_off","value":1}`,
		`{"type":"mode","value":""}`,
		`{"type":"warp","value":1}`,
	}
	for _, c := range bad {
		if _, err := Parse("e1", []byte(mk(c)), now); err == nil {
			t.Fatalf("command %s must be refused", c)
		}
	}
	good, err := Parse("e1", []byte(mk(`{"type":"limit_pct","value":50}`)), now)
	if err != nil || good.Commands.LimitPct == nil || *good.Commands.LimitPct != 50 {
		t.Fatalf("limit_pct 50 must parse: %v %+v", err, good)
	}
}

func TestFutureDatedIssuedAtGainsNothing(t *testing.T) {
	payload := `{"schema_version":"1.0","entity_id":"e1","request_id":"r1",` +
		`"source":{"kind":"local-ui"},"priority":"flow",` +
		`"command":{"type":"setpoint_kw","value":1},"ttl_s":60,` +
		`"issued_at":"2026-07-18T11:00:00Z"}` // 40 min in the future
	d, err := Parse("e1", []byte(payload), now)
	if err != nil {
		t.Fatal(err)
	}
	if want := now.Add(60 * time.Second); !d.ExpiresAt().Equal(want) {
		t.Fatalf("future issued_at must anchor at receive time: expiry %v, want %v", d.ExpiresAt(), want)
	}
}

func TestSourceKeyReplacesPerNode(t *testing.T) {
	a := Source{Kind: SourceFlow, FlowID: "f1", FlowVersion: 1, NodeID: "n1"}
	b := Source{Kind: SourceFlow, FlowID: "f1", FlowVersion: 2, NodeID: "n1"}
	c := Source{Kind: SourceFlow, FlowID: "f1", FlowVersion: 1, NodeID: "n2"}
	if a.Key() != b.Key() {
		t.Fatal("a new flow VERSION must keep the same slot (replace)")
	}
	if a.Key() == c.Key() {
		t.Fatal("different action nodes are different sources")
	}
	if (Source{Kind: SourcePlanExecutor}).Key() != "plan-executor" {
		t.Fatal("plan executor key")
	}
}

var _ = entities.Commands{} // keep the import when cases shrink
