package cloud

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

// AnteileGruende is the closed vocabulary of a share-document rejection
// (docs/contracts/v2/mqtt-verbund-anteile.md §3 = steuerungsverbund.md
// dokument_ablehnung). The cloud drops a receipt with any other word.
var AnteileGruende = []string{"fremde_anlage", "box_fehlt_im_dokument", "revision_aelter", "summe_ueber_verteilbar"}

// AnteileStand is an epoch/revision pair.
type AnteileStand struct {
	Epoche   int64 `json:"epoche"`
	Revision int64 `json:"revision"`
}

// AnteileResult is the box's verdict on ONE share document (AP-15 IP-17,
// rules Y3/G5): Epoche/Revision name the judged document, Grund is empty on
// acceptance, Wirksam is the stand the box holds afterwards (nil = none).
type AnteileResult struct {
	Epoche     int64
	Revision   int64
	Angenommen bool
	Grund      string
	Wirksam    *AnteileStand
	At         time.Time
}

// AnteileResultPayload builds the identity-bound 1.0 receipt. A verdict the
// cloud would drop (unknown reason, reason on acceptance, none on rejection,
// negative numbers) is an error here - the box never sends it.
func (l *Link) AnteileResultPayload(r AnteileResult) ([]byte, error) {
	if r.Epoche < 0 || r.Revision < 0 || r.Wirksam != nil && (r.Wirksam.Epoche < 0 || r.Wirksam.Revision < 0) {
		return nil, fmt.Errorf("anteile result: negative epoch/revision")
	}
	if r.Angenommen != (r.Grund == "") || !r.Angenommen && !slices.Contains(AnteileGruende, r.Grund) {
		return nil, fmt.Errorf("anteile result: verdict %v with reason %q", r.Angenommen, r.Grund)
	}
	urteil := "angenommen"
	if !r.Angenommen {
		urteil = "abgelehnt"
	}
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"epoche":         r.Epoche,
		"revision":       r.Revision,
		"urteil":         urteil,
		"ts":             r.At.UTC().Format(time.RFC3339Nano),
	}
	if r.Grund != "" {
		payload["grund"] = r.Grund
	}
	if r.Wirksam != nil {
		payload["wirksam"] = r.Wirksam
	}
	return json.Marshal(payload)
}

// PublishAnteileResult sends the verdict on .../v2/verbund-anteile-result -
// RETAINED, QoS1, like plan-result: it is the box's latest verdict. The topic
// lives in the box's own v2/# subtree; the broker ACL already grants it.
func (l *Link) PublishAnteileResult(r AnteileResult) error {
	raw, err := l.AnteileResultPayload(r)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/verbund-anteile-result"), 1, true, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("anteile result publish timed out")
	}
	return tok.Error()
}
