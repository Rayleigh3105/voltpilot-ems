package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
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
			BoxArten   []string `json:"box_arten"`
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	// Each box type reports from its own build (edge-supports.md "Je
	// Box-Art"): box_arten names the types that carry a word, absent = both.
	erwartet := func(boxArt string) []string {
		var out []string
		for _, c := range vectors.Capabilities {
			if c.Advertised && (c.BoxArten == nil || slices.Contains(c.BoxArten, boxArt)) {
				out = append(out, c.Name)
			}
		}
		return out
	}
	expected := erwartet(geraetesuche.BoxArtDocker)
	for _, boxArt := range []string{geraetesuche.BoxArtDocker, geraetesuche.BoxArtEdgeLight} {
		if got := BuiltSupports(boxArt); !reflect.DeepEqual(got, erwartet(boxArt)) {
			t.Fatalf("%s: supports = %v; want %v", boxArt, got, erwartet(boxArt))
		}
		if !slices.Contains(BuiltSupports(boxArt), "geraetesuche") {
			t.Fatalf("%s: the search module is built into both binaries but not advertised", boxArt)
		}
	}
	if !reflect.DeepEqual(BuiltSupports(""), expected) {
		t.Fatal("an unnamed box type is not the Docker box")
	}
	// Edge Light has no Node-RED palette: the words whose way ends there are
	// not its own.
	for _, name := range []string{"measurement_config_per_component", "erzeuger_registerbild", "anlagensteuerung_quelle"} {
		if slices.Contains(BuiltSupports(geraetesuche.BoxArtEdgeLight), name) {
			t.Fatalf("Edge Light advertises %s", name)
		}
	}
	for _, name := range BuiltSupports(geraetesuche.BoxArtDocker) {
		if name == "assignment_effective_at" {
			t.Fatalf("unbuilt capability: %s", name)
		}
	}
	if UpdateBackend(geraetesuche.BoxArtEdgeLight) != "light" || UpdateBackend(geraetesuche.BoxArtDocker) != "compose" ||
		UpdateBackend("") != "compose" {
		t.Fatal("update.backend does not name the box type")
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
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, StatusExtension{Supports: BuiltSupports(geraetesuche.BoxArtDocker)}); err != nil {
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
