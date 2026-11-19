package layer1

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// anlagensteuerung_quelle on Edge Light: the core applies a portal plan with
// what Layer 1 reads (componentapply.Options.SourceReads = ReadsAsSource); a
// plant controller is derived without that question, as on the Docker box.
// This pins that the push of the shared vectors applies on Edge Light and that
// the source list the core publishes from it binds the component's pin to the
// controller's connection - the half the palette did on the Docker box.
func TestEdgeLightAppliesThePlantControllerOfTheSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/anlagensteuerung-quelle-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Faelle []struct {
			EdgeSourceID string          `json:"edge_source_id"`
			Driver       json.RawMessage `json:"driver"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Faelle) == 0 {
		t.Fatalf("Vektoren: %v", err)
	}
	fall := v.Faelle[0]
	push := `{"schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
	  "revision":"2026-11-19T08:00:00Z","published_at":"2026-11-19T08:00:00Z",
	  "component_authority":"portal","entities":[
	   {"entity_id":"00000000-0000-0000-0000-0000000e2001","entity_type":"anlagensteuerung",
	    "label":"Anlagensteuerung","edge_source_id":"` + fall.EdgeSourceID + `",
	    "capabilities":{},"guards":{},"driver":` + string(fall.Driver) + `}]}`
	reg, skipped, err := entities.ParseRegistryPush([]byte(push), entities.Identity{
		TenantID: "t1", SiteID: "s1", DeviceID: "d1"})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("Push: %v %v", err, skipped)
	}
	plan, err := componentapply.DeriveWith(reg, inverter.Catalog{}, nil, time.Now(),
		componentapply.Options{SourceReads: ReadsAsSource})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Rejected) != 0 || len(plan.Sources) != 1 || plan.Sources[0].Role != sources.RolePlantController {
		t.Fatalf("Edge Light wendet die Steuerung nicht an: %+v / %+v", plan.Rejected, plan.Sources)
	}
	quellen := erzQuellenAus(sourcesConfig(map[string]any{"id": plan.Sources[0].ID, "role": plan.Sources[0].Role,
		"communication": plan.Sources[0].Communication, "family": plan.Sources[0].Family,
		"connection": plan.Sources[0].Connection}))
	q, ok := quellen[fall.EdgeSourceID]
	if !ok || q.IP != plan.Sources[0].Connection.IP || q.Port != plan.Sources[0].Connection.Port ||
		q.UnitID != plan.Sources[0].Connection.UnitID {
		t.Fatalf("Pin %s ohne Verbindung: %+v", fall.EdgeSourceID, quellen)
	}
}
