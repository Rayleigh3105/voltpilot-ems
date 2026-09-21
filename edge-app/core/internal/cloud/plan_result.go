package cloud

import (
	"encoding/json"
	"fmt"
	"time"
)

// PlanResult is the box's verdict on ONE plan 2.0 (contract
// docs/contracts/v2/mqtt-plan-result.md, AP-15 IP-10, rules P3/Y3). PlanID and
// GeneratedAt are empty when the payload could not be read; Grund is empty on
// acceptance and a word of the closed plan2.Grund* vocabulary on rejection.
type PlanResult struct {
	PlanID      string
	GeneratedAt string
	Angenommen  bool
	Grund       string
	At          time.Time
}

// PlanResultPayload builds the identity-bound 1.0 envelope. lauf_nr and
// anteile_revision stay absent until the plan carries a run number (IP-15)
// and the box holds shares (IP-17).
func (l *Link) PlanResultPayload(r PlanResult) ([]byte, error) {
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"ts":             r.At.UTC().Format(time.RFC3339Nano),
		"angenommen":     r.Angenommen,
	}
	if r.PlanID != "" {
		payload["plan_id"] = r.PlanID
	}
	if r.GeneratedAt != "" {
		payload["generated_at"] = r.GeneratedAt
	}
	if !r.Angenommen {
		payload["grund"] = r.Grund
	}
	return json.Marshal(payload)
}

// PublishPlanResult sends the verdict on .../v2/plan-result - RETAINED, QoS1:
// it is the box's latest verdict (like measurement-config-status), so a
// reconnecting cloud consumer reads it at once. The topic lives in the box's
// own v2/# subtree; the broker ACL already grants it.
func (l *Link) PublishPlanResult(r PlanResult) error {
	raw, err := l.PlanResultPayload(r)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/plan-result"), 1, true, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("plan result publish timed out")
	}
	return tok.Error()
}

// GemeinsameSteuerung is the optional heartbeat mirror of Y3 (block
// `gemeinsame_steuerung`, status stays 1.0). It is sent while the box holds a
// plan 2.0 (IP-10) or an accepted share document (IP-17); a box with neither
// sends no block. The share fields stay absent without a document, so the
// block of a box without one is byte-identical to IP-10. Bezug in Waechter
// waits for the import twin of the feed-in guard (IP-18).
type GemeinsameSteuerung struct {
	PlanID          string    `json:"plan_id,omitempty"`
	Waechter        *Waechter `json:"waechter,omitempty"`
	MesspunktAlterS *int      `json:"messpunkt_alter_s,omitempty"`
	Rolle           string    `json:"rolle,omitempty"`
	AnteileRevision *int64    `json:"anteile_revision,omitempty"`
	AnteileEpoche   *int64    `json:"anteile_epoche,omitempty"`
	// AnteileKw are the EFFECTIVE own shares per direction (kW), the decimal
	// text of the accepted document - "alt" of every two-step change (Y3, A18).
	AnteileKw *AnteileKw `json:"anteile_kw,omitempty"`
}

// AnteileKw is the own share per direction in kW.
type AnteileKw struct {
	Einspeisung json.Number `json:"einspeisung"`
	Bezug       json.Number `json:"bezug"`
}

// Waechter is the guard stage per direction, the export_guard.state words.
type Waechter struct {
	Einspeisung string `json:"einspeisung,omitempty"`
	Bezug       string `json:"bezug,omitempty"`
}
