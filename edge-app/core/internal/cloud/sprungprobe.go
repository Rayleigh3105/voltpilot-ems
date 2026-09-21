package cloud

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sprungprobe"
)

// sprungprobeGruende is the closed abort vocabulary the cloud accepts
// (docs/contracts/v2/mqtt-sprungprobe.md §3, SprungprobeRegel.GRUENDE_ABGEBROCHEN).
var sprungprobeGruende = []string{sprungprobe.Einspeisewaechter, sprungprobe.Bezugswaechter,
	sprungprobe.Eingefroren, sprungprobe.Geraeteschutz, sprungprobe.RegelungAus, sprungprobe.KeineStellgroesse,
	sprungprobe.Abgelaufen, sprungprobe.Neustart}

// SprungprobeResultPayload builds the identity-bound 1.0 report (AP-15 IP-21).
// A report the cloud would drop (unknown abort reason, a reason without an
// abort, more than three jumps) is an error here - the box never sends it.
func (l *Link) SprungprobeResultPayload(b sprungprobe.Bericht) ([]byte, error) {
	if b.Abgebrochen != (b.Grund != "") || b.Abgebrochen && !slices.Contains(sprungprobeGruende, b.Grund) {
		return nil, fmt.Errorf("sprungprobe result: abort %v with reason %q", b.Abgebrochen, b.Grund)
	}
	if len(b.Spruenge) > sprungprobe.MaxWiederholungen || b.ProbeID == "" {
		return nil, fmt.Errorf("sprungprobe result: %d jumps, probe %q", len(b.Spruenge), b.ProbeID)
	}
	spruenge := make([]map[string]any, 0, len(b.Spruenge))
	for _, s := range b.Spruenge {
		spruenge = append(spruenge, map[string]any{
			"von": s.Von.UTC().Format(time.RFC3339Nano), "bis": s.Bis.UTC().Format(time.RFC3339Nano),
			"vorher_kw": s.VorherKw, "waehrend_kw": s.WaehrendKw,
		})
	}
	payload := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      l.identity.TenantID,
		"site_id":        l.identity.SiteID,
		"device_id":      l.identity.DeviceID,
		"probe_id":       b.ProbeID,
		"art":            string(b.Art),
		"stellgroesse":   b.Stellgroesse,
		"spruenge":       spruenge,
		"abgebrochen":    b.Abgebrochen,
		"ts":             b.Ts.UTC().Format(time.RFC3339Nano),
	}
	if b.Abgebrochen {
		payload["grund"] = b.Grund
	}
	return json.Marshal(payload)
}

// PublishSprungprobeResult sends the report on .../v2/sprungprobe-result -
// NOT retained (the cloud judges each probe_id once; a retained report would
// only be a stale copy), QoS1, in the box's own v2/# subtree.
func (l *Link) PublishSprungprobeResult(b sprungprobe.Bericht) error {
	raw, err := l.SprungprobeResultPayload(b)
	if err != nil {
		return err
	}
	tok := l.client.Publish(l.topic("v2/sprungprobe-result"), 1, false, raw)
	if !tok.WaitTimeout(10 * time.Second) {
		return fmt.Errorf("sprungprobe result publish timed out")
	}
	return tok.Error()
}
