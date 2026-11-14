package agent

// Steuerlogik-Konzept Stufe 1: the add-on sensor reader end to end - a
// selected point_key template bound to a Shelly entity reads its add-on
// sensors and publishes samples on the local bus, exactly like the Deye
// settings reader (layer1/einstellungen.go) does for its own closed set.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// fuehlerRegistry builds a one-entity registry: a sensor-only Shelly (no
// Channel/Channels at all - a device that switches nothing).
func fuehlerRegistry(id, ip string, port int) entities.Registry {
	driver := json.RawMessage(fmt.Sprintf(
		`{"brand":"shelly","communication":"shelly_http","connection":{"ip":%q,"port":%d}}`, ip, port))
	e := entities.Entity{ID: id, Type: "fuehler", Label: "Fühler", Driver: driver}
	return entities.Registry{Revision: "rev-fuehler", Entities: []entities.Entity{e}}
}

func shellySensorMessplan(catalogVersion string, entityID, pointKey string, cadenceS int) []byte {
	raw, _ := json.Marshal(map[string]any{
		"revision":        int64(1),
		"catalog_version": catalogVersion,
		"selections": []map[string]any{
			{"point_key": pointKey, "cadence_s": cadenceS, "entity_id": entityID},
		},
	})
	return raw
}

// gen2AddonServer answers like a Shelly Plus Add-on (sensor-only, no switch
// at all): one temperature probe (id 100) and one digital input (id 101).
func gen2AddonServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"id":"shellyplusaddon-1","mac":"AABBCC","gen":2,"model":"SNSN-0043X",` +
				`"app":"PlusAddOn","auth_en":false}`))
		case "/rpc/Shelly.GetStatus":
			_, _ = w.Write([]byte(`{"temperature:100":{"id":100,"tC":24.3},"input:101":{"id":101,"state":true}}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

// A selected temperature template, bound to a sensor-only entity, publishes
// a concrete sample with the device's own component id and an honest value -
// the Stufe-1 end-to-end path, independent of the control executor and its
// kill-switches (Cfg stays at its zero-value default: VP_CONTROL_ENABLED
// off).
func TestShellySensorPassPublishesTemperatureSample(t *testing.T) {
	srv := gen2AddonServer(t)
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "sensor-shelly-1"
	reg := fuehlerRegistry(id, host, port)

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	samples, sub := busObserver(t, addr, "fuehler-samples", "edge/measurements/samples")
	defer sub.Disconnect(0)

	a := &Agent{entRegistry: reg, shellyDoer: goeHTTPDoer{c: srv.Client()}}
	a.Bus = bus
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", id, "shelly.gen2plus.temperature[*].tc", 30))

	a.runShellySensorPass(context.Background(), a.shellyDoer, map[string]time.Time{}, time.Now())

	waitFor(t, 3*time.Second, "sample published", func() bool { return len(samples()) > 0 })
	batch := samples()[len(samples())-1]
	got := batch["samples"].([]any)[0].(map[string]any)
	if got["point_key"] != "shelly.gen2plus.temperature[100].tc" {
		t.Fatalf("point_key = %v, want the component id substituted", got["point_key"])
	}
	if got["raw"].(float64) != 24.3 {
		t.Fatalf("raw = %v, want 24.3", got["raw"])
	}
	if got["quality"] != "good" {
		t.Fatalf("quality = %v, want good", got["quality"])
	}
}

// Two templates (temperature + input) selected for the same entity read the
// device ONCE and publish both - never a second request for the second
// point.
func TestShellySensorPassReadsOnceForMultipleSelections(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"id":"x","mac":"AABBCC","gen":2,"model":"SNSN-0043X","app":"PlusAddOn","auth_en":false}`))
		case "/rpc/Shelly.GetStatus":
			_, _ = w.Write([]byte(`{"temperature:100":{"id":100,"tC":18.0},"input:101":{"id":101,"state":false}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "sensor-shelly-2"
	reg := fuehlerRegistry(id, host, port)

	a := &Agent{entRegistry: reg, shellyDoer: goeHTTPDoer{c: srv.Client()}}
	// Both selections arrive together, exactly as the retained config
	// carries them.
	raw, _ := json.Marshal(map[string]any{
		"revision": int64(1), "catalog_version": "2026.10.21.1",
		"selections": []map[string]any{
			{"point_key": "shelly.gen2plus.temperature[*].tc", "cadence_s": 30, "entity_id": id},
			{"point_key": "shelly.gen2plus.input[*].state", "cadence_s": 30, "entity_id": id},
		},
	})
	a.onShellySensorPlan("", raw)

	before := requests
	a.runShellySensorPass(context.Background(), a.shellyDoer, map[string]time.Time{}, time.Now())
	if got := requests - before; got != 2 { // /shelly + Shelly.GetStatus, ONE pass for both selections
		t.Fatalf("requests = %d, want exactly 2 (one detect, one status) for two selections", got)
	}
}

// A probe the device names but could not read (tC: null) contributes no
// sample - "fehlend ist keine Null", never a fabricated 0°.
func TestShellySensorPassSkipsUnreadableProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"id":"x","mac":"AABBCC","gen":2,"model":"SNSN-0043X","app":"PlusAddOn","auth_en":false}`))
		case "/rpc/Shelly.GetStatus":
			_, _ = w.Write([]byte(`{"temperature:100":{"id":100,"tC":null,"errors":["read"]}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "sensor-shelly-3"
	reg := fuehlerRegistry(id, host, port)

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	samples, sub := busObserver(t, addr, "fuehler-missing", "edge/measurements/samples")
	defer sub.Disconnect(0)

	a := &Agent{entRegistry: reg, shellyDoer: goeHTTPDoer{c: srv.Client()}}
	a.Bus = bus
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", id, "shelly.gen2plus.temperature[*].tc", 30))
	a.runShellySensorPass(context.Background(), a.shellyDoer, map[string]time.Time{}, time.Now())

	time.Sleep(300 * time.Millisecond)
	if got := samples(); len(got) != 0 {
		t.Fatalf("an unreadable probe must publish NO sample, got %v", got)
	}
}

// The add-on module is absent entirely (a plain relay-less Shelly without
// any temperature:*/input:* component): no sample, never an invented one.
func TestShellySensorPassNoAddonModulePublishesNothing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"id":"x","mac":"AABBCC","gen":2,"model":"SNSW-001X16EU","app":"Plus1","auth_en":false}`))
		case "/rpc/Shelly.GetStatus":
			_, _ = w.Write([]byte(`{"switch:0":{"id":0,"output":false},"sys":{"restart_required":false}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "sensor-shelly-4"
	reg := fuehlerRegistry(id, host, port)

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	samples, sub := busObserver(t, addr, "fuehler-noaddon", "edge/measurements/samples")
	defer sub.Disconnect(0)

	a := &Agent{entRegistry: reg, shellyDoer: goeHTTPDoer{c: srv.Client()}}
	a.Bus = bus
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", id, "shelly.gen2plus.temperature[*].tc", 30))
	a.runShellySensorPass(context.Background(), a.shellyDoer, map[string]time.Time{}, time.Now())

	time.Sleep(300 * time.Millisecond)
	if got := samples(); len(got) != 0 {
		t.Fatalf("an absent add-on module must publish NO sample, got %v", got)
	}
}

// A selection whose entity_id does not resolve to any known entity (the
// component was removed, or never existed) is simply skipped - no read, no
// panic, no guessed component.
func TestShellySensorPassUnknownEntitySkipped(t *testing.T) {
	a := &Agent{entRegistry: entities.Registry{}}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "ghost", "shelly.gen2plus.temperature[*].tc", 30))
	a.runShellySensorPass(context.Background(), goeHTTPDoer{c: http.DefaultClient}, map[string]time.Time{}, time.Now())
	// No panic, no HTTP call possible without a resolvable device - success
	// is simply reaching here.
}

// A selection below the catalog's cadence floor never enters the plan at
// all (never read faster than the catalog allows).
func TestOnShellySensorPlanRejectsCadenceBelowFloor(t *testing.T) {
	a := &Agent{}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "e1", "shelly.gen2plus.temperature[*].tc", 5))
	if len(a.shellySensorPlan) != 0 {
		t.Fatalf("plan = %+v, want empty (cadence below the 30 s floor)", a.shellySensorPlan)
	}
}

// A point_key this reader does not know (another family's point, or a
// typo) never enters the plan - never a guessed template.
func TestOnShellySensorPlanIgnoresUnknownPointKey(t *testing.T) {
	a := &Agent{}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "e1", "deye.hybrid_1p.settings.battery-low-soc", 300))
	if len(a.shellySensorPlan) != 0 {
		t.Fatalf("plan = %+v, want empty (not a Shelly sensor template)", a.shellySensorPlan)
	}
}

// Firstmate review of the first version of this change: a working Fühler
// point must report itself ACCEPTED on the status topic, never leave the
// field to layer1's blanket "edge_too_old" refusal of the same point_key -
// see the package comment and measurements.StatusMerger for the full
// defect. This is the reader's OWN partial verdict, asserted straight off
// the bus (never through the merge, which measurements.StatusMerger already
// covers in isolation).
func TestOnShellySensorPlanPublishesAcceptedStatusForItsOwnPoint(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	statuses, sub := busObserver(t, addr, "fuehler-status-accept", "edge/measurements/config-status")
	defer sub.Disconnect(0)

	a := &Agent{Bus: bus}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "e1", "shelly.gen2plus.temperature[*].tc", 30))

	waitFor(t, 3*time.Second, "status published", func() bool { return len(statuses()) > 0 })
	got := statuses()[len(statuses())-1]
	accepted := got["accepted"].([]any)
	if len(accepted) != 1 || accepted[0] != "shelly.gen2plus.temperature[*].tc" {
		t.Fatalf("accepted = %v, want exactly this reader's own point", accepted)
	}
	if rejected, ok := got["rejected"].([]any); ok && len(rejected) != 0 {
		t.Fatalf("rejected = %v, want none", rejected)
	}
	if int64(got["revision"].(float64)) != 1 {
		t.Fatalf("revision = %v, want 1", got["revision"])
	}
}

// A selection naming no entity_id can never be bound to a device - reported
// binding_unavailable (Stufe 3c's existing word), never silently dropped
// with no explanation at all.
func TestOnShellySensorPlanPublishesBindingUnavailableWithoutEntityID(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	statuses, sub := busObserver(t, addr, "fuehler-status-unbound", "edge/measurements/config-status")
	defer sub.Disconnect(0)

	a := &Agent{Bus: bus}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "", "shelly.gen2plus.temperature[*].tc", 30))

	waitFor(t, 3*time.Second, "status published", func() bool { return len(statuses()) > 0 })
	got := statuses()[len(statuses())-1]
	rejected := got["rejected"].([]any)[0].(map[string]any)
	if rejected["reason"] != "binding_unavailable" {
		t.Fatalf("reason = %v, want binding_unavailable", rejected["reason"])
	}
	if accepted, ok := got["accepted"].([]any); ok && len(accepted) != 0 {
		t.Fatalf("accepted = %v, want none", accepted)
	}
	if len(a.shellySensorPlan) != 0 {
		t.Fatalf("plan = %+v, want empty - unbound, never read", a.shellySensorPlan)
	}
}

// A cadence below the catalog floor is reported invalid_cadence (layer1's
// own word for the identical situation), not silently dropped.
func TestOnShellySensorPlanPublishesInvalidCadenceRejection(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	statuses, sub := busObserver(t, addr, "fuehler-status-cadence", "edge/measurements/config-status")
	defer sub.Disconnect(0)

	a := &Agent{Bus: bus}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "e1", "shelly.gen2plus.temperature[*].tc", 5))

	waitFor(t, 3*time.Second, "status published", func() bool { return len(statuses()) > 0 })
	got := statuses()[len(statuses())-1]
	rejected := got["rejected"].([]any)[0].(map[string]any)
	if rejected["reason"] != "invalid_cadence" {
		t.Fatalf("reason = %v, want invalid_cadence", rejected["reason"])
	}
}

// A point_key this reader does not own is never mentioned on the status
// topic at all - "a reader may only judge points that belong to it"; no
// publish happens, leaving the field entirely to the point's actual owner.
func TestOnShellySensorPlanPublishesNothingForUnownedPointKey(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	statuses, sub := busObserver(t, addr, "fuehler-status-unowned", "edge/measurements/config-status")
	defer sub.Disconnect(0)

	a := &Agent{Bus: bus}
	a.onShellySensorPlan("", shellySensorMessplan("2026.10.21.1", "e1", "deye.hybrid_1p.settings.battery-low-soc", 300))

	time.Sleep(300 * time.Millisecond)
	if got := statuses(); len(got) != 0 {
		t.Fatalf("status published = %v, want none for a point this reader does not own", got)
	}
}
