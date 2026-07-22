package agent

// Portal v3 M5 Part C: the additive, FEATURE-FLAGGED per-node flow-state block
// on the status heartbeat. What must hold:
//
//   * with the flag OFF (the default) nothing is recorded and NO block is
//     emitted - the portal editor then shows channel values only and never a
//     guessed node state;
//   * with the flag ON the reported states are carried verbatim, absent fields
//     stay absent, the set is BOUNDED, and a state the device stopped
//     refreshing expires instead of pretending to be live.

import (
	"encoding/json"
	"testing"
	"time"
)

func statusMsg(t *testing.T, flowID, nodeID, state, text string) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"flow_id": flowID, "node_id": nodeID, "state": state, "text": text,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestFlowNodeStatusBlockIsAbsentWithoutTheFlag(t *testing.T) {
	a := newGateTestAgent(t)
	a.Cfg.FlowNodeStatusEnabled = false

	a.onFlowNodeStatus("edge/flow/node-status", statusMsg(t, "flow-1", "schwelle1", "active", "erfüllt"))

	if len(a.flowNodeStates) != 0 {
		t.Fatalf("nothing may be recorded while the feature is off, got %+v", a.flowNodeStates)
	}
	if sum := a.flowNodeStatusSummary(); sum != nil {
		t.Fatalf("no block may be emitted while the feature is off, got %+v", sum)
	}
}

func TestFlowNodeStatusBlockReportsWhatTheDeviceSaid(t *testing.T) {
	a := newGateTestAgent(t)
	a.Cfg.FlowNodeStatusEnabled = true

	// An empty block while nothing was reported - never a fabricated entry.
	if sum := a.flowNodeStatusSummary(); sum != nil {
		t.Fatalf("expected no block before any report, got %+v", sum)
	}

	a.onFlowNodeStatus("", statusMsg(t, "flow-1", "steuern1", "active", "EIN"))
	a.onFlowNodeStatus("", statusMsg(t, "flow-1", "schwelle1", "idle", ""))
	// Malformed / incomplete messages are dropped, not guessed at.
	a.onFlowNodeStatus("", []byte("not json"))
	a.onFlowNodeStatus("", statusMsg(t, "", "x", "active", ""))
	a.onFlowNodeStatus("", statusMsg(t, "flow-1", "y", "", ""))

	sum := a.flowNodeStatusSummary()
	if sum == nil || len(sum.Nodes) != 2 {
		t.Fatalf("expected exactly the two well-formed states, got %+v", sum)
	}
	// Deterministic order (flow, node) so the heartbeat does not churn.
	if sum.Nodes[0].NodeID != "schwelle1" || sum.Nodes[1].NodeID != "steuern1" {
		t.Fatalf("unexpected order: %+v", sum.Nodes)
	}
	if sum.Nodes[1].State != "active" || sum.Nodes[1].Text != "EIN" {
		t.Fatalf("the device's own words must survive: %+v", sum.Nodes[1])
	}
	if sum.Nodes[0].Text != "" || sum.Nodes[0].Since != "" {
		t.Fatalf("absent fields must stay absent: %+v", sum.Nodes[0])
	}
}

func TestFlowNodeStatusIsBoundedAndExpires(t *testing.T) {
	a := newGateTestAgent(t)
	a.Cfg.FlowNodeStatusEnabled = true

	for i := 0; i < maxTrackedFlowNodes+50; i++ {
		a.onFlowNodeStatus("", statusMsg(t, "flow-1", "n"+string(rune('a'+i%26))+string(rune('a'+i/26)),
			"active", ""))
	}
	if len(a.flowNodeStates) > maxTrackedFlowNodes {
		t.Fatalf("the tracked set must stay bounded, got %d", len(a.flowNodeStates))
	}

	// A state the device stopped refreshing is not "live" - it expires.
	a.flowNodeMu.Lock()
	for k, st := range a.flowNodeStates {
		st.seen = time.Now().Add(-2 * flowNodeStateTTL)
		a.flowNodeStates[k] = st
	}
	a.flowNodeMu.Unlock()
	if sum := a.flowNodeStatusSummary(); sum != nil {
		t.Fatalf("expired states must not be reported, got %+v", sum)
	}
}
