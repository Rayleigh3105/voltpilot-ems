package agent

import (
	"fmt"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

// beurteilePlan2 judges one …/v2/plan payload exactly as onPlanV2 always did
// (plan2.Parse, then the device identity) and names the verdict for the plan
// receipt (docs/contracts/v2/mqtt-plan-result.md, AP-15 IP-10, P3). The plan
// is nil on every rejection; the receipt still names the plan when its
// plan_id is readable.
func beurteilePlan2(payload []byte, ownDevice string, now time.Time) (*plan2.Plan, cloud.PlanResult, error) {
	planID, generatedAt := plan2.Kennung(payload)
	r := cloud.PlanResult{PlanID: planID, GeneratedAt: generatedAt, At: now}
	p, err := plan2.Parse(payload, now)
	if err != nil {
		r.Grund = plan2.Grund(err)
		return nil, r, err
	}
	if p.DeviceID != "" && ownDevice != "" && p.DeviceID != ownDevice {
		r.Grund = plan2.GrundFremdeBox
		return nil, r, fmt.Errorf("v2 plan for device %s", p.DeviceID)
	}
	r.Angenommen = true
	return p, r, nil
}

// quittierePlan2 sends the receipt without blocking the MQTT callback that
// delivered the plan. No link = no receipt: the retained plan is redelivered
// after the next connect and judged again.
func (a *Agent) quittierePlan2(r cloud.PlanResult) {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return
	}
	go func() {
		if err := link.PublishPlanResult(r); err != nil {
			slog.Warn("plan result publish failed", "err", err, "plan_id", r.PlanID)
		}
	}()
}

// gemeinsameSteuerung is the Y3 heartbeat mirror: present while the box
// holds a plan 2.0 with a plan_id (IP-10) or an accepted share document
// (IP-17), so a box with neither keeps its heartbeat. The guard stage and the
// age of the own measuring point come from the feed-in guard that exists
// today; the share fields (rolle, epoch, revision, effective own share per
// direction) come only from a held document, so the block of a box without
// one stays byte-identical to IP-10. Bezug waits for IP-18.
func (a *Agent) gemeinsameSteuerung() *cloud.GemeinsameSteuerung {
	a.arbMu.Lock()
	p := a.curPlan2
	a.arbMu.Unlock()
	h := a.heldAnteile()
	hatPlan := p != nil && p.PlanID != ""
	if !hatPlan && h == nil {
		return nil
	}
	block := &cloud.GemeinsameSteuerung{}
	if hatPlan {
		block.PlanID = p.PlanID
	}
	if g := a.State.Get().ExportGuard; g != nil {
		if g.State != "" {
			block.Waechter = &cloud.Waechter{Einspeisung: g.State}
		}
		if g.MeasurementAgeSeconds != nil {
			age := *g.MeasurementAgeSeconds
			block.MesspunktAlterS = &age
		}
	}
	if h != nil {
		epoche, revision := h.Stand.Epoche, h.Stand.Revision
		block.Rolle = h.Rolle
		block.AnteileEpoche = &epoche
		block.AnteileRevision = &revision
		block.AnteileKw = &cloud.AnteileKw{Einspeisung: h.AnteilKw["einspeisung"], Bezug: h.AnteilKw["bezug"]}
	}
	return block
}
