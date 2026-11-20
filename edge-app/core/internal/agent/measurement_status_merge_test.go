package agent

// Firstmate review of PR #1886 (vp-logik-s1-fuehler), reproduced at the
// exact boundary where the defect lived: onMeasurementStatus, fed the SAME
// two raw LocalStatus documents layer1's settings reader and the Shelly
// sensor reader each actually publish on an Edge Light box for the same
// plan revision - a working Fühler point must end up accepted in the
// stored/forwarded document, never shadowed by layer1's blanket
// "edge_too_old" refusal of every point it does not itself recognize.
// measurements.StatusMerger has the unit-level coverage of the merge rule
// itself; this test is the end-to-end proof at the agent boundary, in both
// arrival orders.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

const fuehlerPointKey = "shelly.gen2plus.temperature[100].tc"

// layer1's shape before the measurement library (the former closed set): it
// walked the whole plan, did not recognize the Fühler point, and refused it.
// The merger must still let the owner's acceptance win over such a refusal.
const layer1BlanketRejection = `{"revision":12,"applied_at":"2026-11-14T12:00:00Z",` +
	`"accepted":[],"rejected":[{"point_key":"` + fuehlerPointKey + `","reason":"edge_too_old"}]}`

// the Shelly sensor reader's own shape (shelly_sensors.go
// publishShellySensorStatus): it owns this point and accepts it.
const fuehlerAcceptance = `{"revision":12,"applied_at":"2026-11-14T12:00:01Z",` +
	`"accepted":["` + fuehlerPointKey + `"],"rejected":[]}`

func newTestAgentForStatus(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	return &Agent{Cfg: cfg, measurementStatusMerger: measurements.NewStatusMerger(),
		measurementIdentity: measurements.Identity{TenantID: "t1", SiteID: "s1", DeviceID: "d1"}}
}

func storedStatus(t *testing.T, a *Agent) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(a.Cfg.DataDir, "measurement-status.json"))
	if err != nil {
		t.Fatalf("stored status unreadable: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("stored status unparseable: %v raw=%s", err, raw)
	}
	return doc
}

// The exact order the bug report described: layer1's blanket refusal
// arrives FIRST (it processes the whole retained plan synchronously),
// the Fühler reader's acceptance SECOND.
func TestOnMeasurementStatusMergesFuehlerAcceptanceAfterLayer1Rejection(t *testing.T) {
	a := newTestAgentForStatus(t)
	a.onMeasurementStatus("", []byte(layer1BlanketRejection))
	a.onMeasurementStatus("", []byte(fuehlerAcceptance))

	doc := storedStatus(t, a)
	accepted, _ := doc["accepted"].([]any)
	rejected, _ := doc["rejected"].([]any)
	if len(accepted) != 1 || accepted[0] != fuehlerPointKey {
		t.Fatalf("accepted = %v, want the Fühler point accepted", accepted)
	}
	if len(rejected) != 0 {
		t.Fatalf("rejected = %v, want none - a working point must never show abgelehnt", rejected)
	}
}

// The opposite order - a goroutine publish (publishShellySensorStatus runs
// in one) could just as easily land first. The merged result must be
// identical either way.
func TestOnMeasurementStatusMergeIsOrderIndependentAcrossTheTwoReaders(t *testing.T) {
	a := newTestAgentForStatus(t)
	a.onMeasurementStatus("", []byte(fuehlerAcceptance))
	a.onMeasurementStatus("", []byte(layer1BlanketRejection))

	doc := storedStatus(t, a)
	accepted, _ := doc["accepted"].([]any)
	rejected, _ := doc["rejected"].([]any)
	if len(accepted) != 1 || accepted[0] != fuehlerPointKey {
		t.Fatalf("accepted = %v, want the Fühler point accepted regardless of arrival order", accepted)
	}
	if len(rejected) != 0 {
		t.Fatalf("rejected = %v, want none", rejected)
	}
}

// A genuinely unsupported point (neither reader owns it) still shows
// rejected - the merge must not swallow real refusals, only resolve the
// specific conflict of one reader's blanket sweep versus another's
// ownership.
func TestOnMeasurementStatusKeepsARealRejectionForAnUnownedPoint(t *testing.T) {
	a := newTestAgentForStatus(t)
	a.onMeasurementStatus("", []byte(`{"revision":1,"applied_at":"2026-11-14T12:00:00Z",`+
		`"accepted":[],"rejected":[{"point_key":"sunspec.unsupported.thing","reason":"unknown_point"}]}`))

	doc := storedStatus(t, a)
	rejected, _ := doc["rejected"].([]any)
	if len(rejected) != 1 {
		t.Fatalf("rejected = %v, want the one real refusal kept", rejected)
	}
}
