package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

func TestBuiltSupportsMatchesContractAndDoesNotInventLocalScheduling(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/edge-supports-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Capabilities []struct {
			Name       string
			Advertised bool
			Evidence   string
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	var expected []string
	for _, c := range vectors.Capabilities {
		if c.Advertised {
			expected = append(expected, c.Name)
		}
	}
	if !reflect.DeepEqual(BuiltSupports(), expected) {
		t.Fatalf("supports = %v; want %v", BuiltSupports(), expected)
	}
	for _, name := range BuiltSupports() {
		if name == "assignment_effective_at" {
			t.Fatalf("unbuilt capability: %s", name)
		}
	}
	// "Only what is built" is checked, not promised: every advertised capability
	// names a file in this tree, and that file has to exist. events (AP-07 IP-19)
	// joins the list exactly because internal/boxevents really sends.
	eventsGebaut := false
	ruheGemeldet := false
	for _, c := range vectors.Capabilities {
		if !c.Advertised {
			continue
		}
		if c.Evidence == "" {
			t.Fatalf("%s advertises without evidence", c.Name)
		}
		if _, err := os.Stat(filepath.Join("../../../..", c.Evidence)); err != nil {
			t.Fatalf("%s: evidence %s missing: %v", c.Name, c.Evidence, err)
		}
		if c.Name == "events" {
			eventsGebaut = true
		}
		if c.Name == "automation_paused_until_revoked" {
			ruheGemeldet = true
		}
	}
	if !eventsGebaut {
		t.Fatal("events is built but not advertised")
	}
	// The capability and the code behind it are one promise: decode the real
	// registry field, prove that it outlives every rolling end, and require the
	// same runtime to advertise the name. Removing either half makes this fail.
	var reg entities.Registry
	if err := json.Unmarshal([]byte(`{"automation_paused_until_revoked":true}`), &reg); err != nil {
		t.Fatal(err)
	}
	if !reg.Paused(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)) || !ruheGemeldet {
		t.Fatalf("Ruhe-until-revoked implementation and advertisement diverged: registry=%+v advertised=%v",
			reg, ruheGemeldet)
	}
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "unchanged-version")
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, StatusExtension{Supports: BuiltSupports()}); err != nil {
		t.Fatal(err)
	}
	wire := sink.last(t)
	raw, _ = json.Marshal(wire["supports"])
	var got []string
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, expected) || wire["schema_version"] != "1.0" || wire["version"] != "unchanged-version" {
		t.Fatalf("heartbeat: %v", wire)
	}
	if _, exists := wire["data_sources"]; exists {
		t.Fatal("supports invented source status")
	}
}
