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
