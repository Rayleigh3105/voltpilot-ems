package cloud

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
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
		if name == "assignment_effective_at" || name == "events" {
			t.Fatalf("unbuilt capability: %s", name)
		}
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
