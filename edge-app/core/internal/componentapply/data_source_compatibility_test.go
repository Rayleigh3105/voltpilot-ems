package componentapply

import (
	"encoding/json"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"os"
	"reflect"
	"testing"
	"time"
)

// This test also runs unchanged on the pre-IP13 origin/uems Core.
func TestLegacyCoreAcceptsOpaqueSourceIdentity(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/examples/edge-entity.valid.registry-push.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	json.Unmarshal(raw, &doc)
	id := entities.Identity{TenantID: doc["tenant_id"].(string), SiteID: doc["site_id"].(string), DeviceID: doc["device_id"].(string)}
	before, _, err := entities.ParseRegistryPush(raw, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range doc["entities"].([]any) {
		e := item.(map[string]any)
		d, _ := e["driver"].(map[string]any)
		if d == nil {
			d = map[string]any{}
			e["driver"] = d
		}
		d["data_source_id"] = "DQ-4"
	}
	raw, _ = json.Marshal(doc)
	after, skipped, err := entities.ParseRegistryPush(raw, id)
	if err != nil || len(skipped) != 0 || len(after.Entities) != len(before.Entities) {
		t.Fatalf("old registry rejected metadata: %v %v", err, skipped)
	}
	for i, e := range after.Entities {
		_, oldOK, oldErr := ParseDriver(before.Entities[i])
		_, newOK, newErr := ParseDriver(e)
		if oldOK != newOK || (oldErr == nil) != (newErr == nil) {
			t.Fatal("metadata changed driver admission")
		}
		// A metadata-only driver remains unread, just like an absent driver.
	}
	now := time.Now()
	_, e1 := Derive(before, inverter.DefaultCatalog(), nil, now)
	_, e2 := Derive(after, inverter.DefaultCatalog(), nil, now)
	if !reflect.DeepEqual(e1, e2) {
		t.Fatalf("changed apply acceptance: %v / %v", e1, e2)
	}
}
