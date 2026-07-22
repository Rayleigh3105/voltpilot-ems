package agent

// The E2 flow-artifact consumption glue (contract: docs/contracts/v2/
// flow-artifact.md): the retained deployment set on …/v2/flows is verified
// (hash, version gates, capability requirements vs the entity registry),
// persisted, and materialized as @vp-flow-marked tabs in the Node-RED runtime
// via its Admin API (internal/flowdeploy). The heartbeat's additive `flows`
// block acknowledges per artifact; a periodic reconcile restores dropped
// artifact tabs from truth (the reseed contract's self-heal half).

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
)

// flowReconcileInterval is the self-heal cadence: the deployment is retained
// (re-arrives on every reconnect) and persisted (survives cloud-less boots);
// this loop additionally repairs a Node-RED restart/reseed that dropped
// artifact tabs while the core kept running.
const flowReconcileInterval = time.Minute

// newFlowDeployer builds the deployer from config (nil NR client when the
// admin endpoint is not configured - honest 'error' acks instead of silence).
func (a *Agent) newFlowDeployer() *flowdeploy.Deployer {
	var nr flowdeploy.NRClient
	if a.Cfg.NodeRedAdminURL != "" {
		nr = flowdeploy.NewHTTPNRClient(a.Cfg.NodeRedAdminURL, a.Cfg.NodeRedUser, a.Cfg.NodeRedPassword)
	}
	return flowdeploy.NewDeployer(flowdeploy.Deps{
		NR:          nr,
		DataDir:     a.Cfg.DataDir,
		CoreVersion: Version,
		Registry: func() entities.Registry {
			a.entMu.Lock()
			defer a.entMu.Unlock()
			return a.entRegistry
		},
		Identity: func() flowdeploy.Identity {
			a.entMu.Lock()
			defer a.entMu.Unlock()
			return flowdeploy.Identity{TenantID: a.entIdentity.TenantID,
				SiteID: a.entIdentity.SiteID, DeviceID: a.entIdentity.DeviceID}
		},
	})
}

// onFlows handles the retained …/v2/flows payload from the cloud link.
func (a *Agent) onFlows(payload []byte) {
	if a.flowDep == nil {
		return
	}
	a.flowDep.HandleDeployment(payload)
}

// flowReconcileLoop periodically re-applies the persisted deployment set.
func (a *Agent) flowReconcileLoop(ctx context.Context) {
	t := time.NewTicker(flowReconcileInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.flowDep.Reconcile()
		}
	}
}

// flowsSummary builds the heartbeat flows-ack block; nil while flow
// deployment never saw a set.
func (a *Agent) flowsSummary() *cloud.FlowsSummary {
	if a.flowDep == nil {
		return nil
	}
	return a.flowDep.Summary()
}

// --- Portal v3 M5 Part C: per-node live state (additive, feature-flagged) ---

// flowNodeStateTTL drops a node state the device has not refreshed - a state
// from an hour ago is not "live" and would mislead the editor.
const flowNodeStateTTL = 10 * time.Minute

// onFlowNodeStatus records ONE node's reported state from the local bus
// (edge/flow/node-status, published by the vp-node-status palette node flowc
// wires from the compiled nodes). Pure recording: nothing here commands
// anything, and a malformed message is dropped, never guessed at.
func (a *Agent) onFlowNodeStatus(_ string, payload []byte) {
	if !a.Cfg.FlowNodeStatusEnabled {
		return // the flag is the whole feature gate; without it we record nothing
	}
	var msg struct {
		FlowID string `json:"flow_id"`
		NodeID string `json:"node_id"`
		State  string `json:"state"`
		Text   string `json:"text"`
		Since  string `json:"since"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	if msg.FlowID == "" || msg.NodeID == "" || msg.State == "" {
		return
	}
	a.flowNodeMu.Lock()
	defer a.flowNodeMu.Unlock()
	if a.flowNodeStates == nil {
		a.flowNodeStates = map[string]flowNodeState{}
	}
	// Bounded: a runaway flow can never inflate the heartbeat or the map.
	key := msg.FlowID + "#" + msg.NodeID
	if _, known := a.flowNodeStates[key]; !known && len(a.flowNodeStates) >= maxTrackedFlowNodes {
		return
	}
	a.flowNodeStates[key] = flowNodeState{
		flowID: msg.FlowID, nodeID: msg.NodeID, state: msg.State,
		text: msg.Text, since: msg.Since, seen: time.Now().UTC(),
	}
}

// maxTrackedFlowNodes bounds the in-memory map (see maxFlowNodeStates in cloud).
const maxTrackedFlowNodes = 256

type flowNodeState struct {
	flowID string
	nodeID string
	state  string
	text   string
	since  string
	seen   time.Time
}

// flowNodeStatusSummary builds the additive heartbeat block. nil when the flag
// is off or nothing was reported, so a bare heartbeat stays byte-identical and
// the portal editor honestly shows no per-node state.
func (a *Agent) flowNodeStatusSummary() *cloud.FlowNodeStatusSummary {
	if !a.Cfg.FlowNodeStatusEnabled {
		return nil
	}
	now := time.Now().UTC()
	a.flowNodeMu.Lock()
	defer a.flowNodeMu.Unlock()
	if len(a.flowNodeStates) == 0 {
		return nil
	}
	sum := &cloud.FlowNodeStatusSummary{ReportedAt: now.Format(time.RFC3339)}
	for key, st := range a.flowNodeStates {
		if now.Sub(st.seen) > flowNodeStateTTL {
			delete(a.flowNodeStates, key)
			continue
		}
		sum.Nodes = append(sum.Nodes, cloud.FlowNodeState{
			FlowID: st.flowID, NodeID: st.nodeID, State: st.state,
			Text: st.text, Since: st.since,
		})
	}
	if len(sum.Nodes) == 0 {
		return nil
	}
	sort.Slice(sum.Nodes, func(i, j int) bool {
		if sum.Nodes[i].FlowID != sum.Nodes[j].FlowID {
			return sum.Nodes[i].FlowID < sum.Nodes[j].FlowID
		}
		return sum.Nodes[i].NodeID < sum.Nodes[j].NodeID
	})
	return sum
}
