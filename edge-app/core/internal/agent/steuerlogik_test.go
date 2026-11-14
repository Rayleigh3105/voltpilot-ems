package agent

// Steuerlogik running along over the REAL path (evidence of the supports word
// steuerlogik_mitlauf): the service beside the API builds the artifact from
// the contract's heat pump example, the box takes it from the retained
// v2/flows set, the run computes every second with the site sample and the
// Fühler of Stufe 1, the old control (here: someone switching the Shelly by
// hand, as Home Assistant does at the pilot) is read back over the source
// path, and the heartbeat block carries wish against observed state. Nothing
// reaches the arbiter and no switching request reaches the device.

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/pricefeed"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

const (
	tLogikTenant = "t-logik"
	tLogikSite   = "s-logik"
	tLogikDevice = "d-logik"
	tLogikFlow   = "5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b"
)

func logikDeployment(t *testing.T, artifacts ...json.RawMessage) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"schema_version": "1.0", "kind": "deployment",
		"tenant_id": tLogikTenant, "site_id": tLogikSite, "device_id": tLogikDevice,
		"deployed_at": "2026-11-14T12:00:00Z", "artifacts": artifacts,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func fuehlerBatch(t *testing.T, entity string, tc float64, at time.Time) []byte {
	t.Helper()
	id, _ := json.Marshal(entity)
	raw, err := json.Marshal(measurements.LocalBatch{CatalogVersion: "test", ObservedAt: at, Samples: []measurements.Sample{{
		PointKey: "shelly.gen2plus.temperature[100].tc", Raw: tc, Decoded: tc, Quality: "good",
		ObservedAt: &at, EntityID: id,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSteuerlogikLaeuftMitUndSchaltetNicht(t *testing.T) {
	// The heat pump's SG-Ready contact: a Shelly Plus 1, switched by the old
	// control. The box's own control is off, as at the pilot.
	contact := &shellyFakeGen2{}
	srv := httptest.NewServer(contact.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg := rodShellyRegistry("waermepumpe-1", host, port, false, 0)
	reg.Entities[0].EdgeSourceID = "src-wp"
	arb := minimalArbiter(reg)
	a := shellyAgent(t, reg, arb, srv.Client())
	a.Cfg.ControlEnabled, a.Cfg.ConsumerControlEnabled = false, false
	a.entIdentity = entities.Identity{TenantID: tLogikTenant, SiteID: tLogikSite, DeviceID: tLogikDevice}
	a.srcs = []sources.Source{{ID: "src-wp", Role: "consumer", Brand: "shelly",
		Communication: inverter.CommShellyHTTP, Connection: inverter.Connection{IP: host, Port: port}, IntervalS: 30}}
	a.srcReadings = map[string]sourceReading{}
	// The ticks run on their own clock that ends at the wall clock, so the
	// source reading is fresh like on a running box.
	now := time.Now().Add(-22 * time.Minute).Truncate(time.Second)
	a.flowDep = a.newFlowDeployer()
	a.logik = a.newLogikLaufzeit(func() time.Time { return now })
	a.flowDep.SetLogikLaufzeit(logikAdapter{a.logik})

	// The service builds the artifact from the contract's example, unchanged.
	text, err := os.ReadFile("../../../../docs/contracts/v2/steuerlogik/waermepumpe.logic.yaml")
	if err != nil {
		t.Fatal(err)
	}
	breite, laenge := 48.1, 11.6
	art, bericht, err := logikdienst.Artefakt(logikdienst.Auftrag{Text: string(text), FlowID: tLogikFlow,
		FlowVersion: 1, Site: &logikdienst.Ort{Timezone: "Europe/Berlin", Latitude: &breite, Longitude: &laenge}})
	if err != nil || bericht.Sperrt {
		t.Fatalf("Dienst: %v %+v", err, bericht)
	}
	a.onFlows(logikDeployment(t, art))
	flows := a.flowsSummary()
	if flows == nil || len(flows.Applied) != 1 || flows.Applied[0].State != "active" {
		t.Fatalf("ack: %+v", flows)
	}

	// 21 minutes of surplus with a cold tank, the contact stays open.
	readContact := func() {
		on, _, _, _ := contact.snapshot()
		raw, _ := json.Marshal(map[string]any{"relay_on": on})
		a.onSourceTelemetry(sources.TopicPrefix+"src-wp/telemetry", raw)
	}
	readContact()
	beat := func(n int) {
		for i := 0; i < n; i++ {
			now = now.Add(time.Second)
			if now.Unix()%30 == 0 {
				a.logikObserve(now, map[string]float64{"power_kw": -3}, nil)
				a.logikObserveSamples(fuehlerBatch(t, "fuehler-puffer-oben", 42, now))
			}
			a.logik.Tick(now)
		}
	}
	a.logikObserve(now, map[string]float64{"power_kw": -3}, nil)
	a.logikObserveSamples(fuehlerBatch(t, "fuehler-puffer-oben", 42, now))
	beat(21 * 60)

	sum := a.logikSummary()
	if sum == nil || len(sum.Laeufe) != 1 {
		t.Fatalf("logik block: %+v", sum)
	}
	l := sum.Laeufe[0]
	if l.FlowID != tLogikFlow || l.FlowVersion != 1 || l.Zustand != "mitlaufend" || l.Name != "Wärmepumpe" ||
		l.ContentHash != flows.Applied[0].ContentHash {
		t.Fatalf("head: %+v", l)
	}
	if l.Lage == nil || l.Lage.Titel != "Speichert Sonnenstrom" || len(l.Unbekannt) != 0 {
		t.Fatalf("state: lage %+v unbekannt %v", l.Lage, l.Unbekannt)
	}
	wp := l.Geraete["wp"]
	if wp.Wunsch == nil || !*wp.Wunsch.Ein || wp.Ist == nil || *wp.Ist.Ein || wp.AbweichendS == 0 {
		t.Fatalf("comparison: %+v", wp)
	}

	// The old control closes the contact - by hand, not through the box.
	contact.mu.Lock()
	contact.on = true
	contact.mu.Unlock()
	readContact()
	beat(30)
	l = a.logikSummary().Laeufe[0]
	last := l.Wechsel[len(l.Wechsel)-1]
	if last.Was != "ist" || last.Neu == nil || !*last.Neu.Ein || last.Andere == nil || !*last.Andere.Ein {
		t.Fatalf("log: %+v", l.Wechsel)
	}
	if l.Geraete["wp"].AbweichendS != wp.AbweichendS {
		t.Fatalf("no deviation once both agree: %+v", l.Geraete["wp"])
	}

	// Nothing switched: no wish in the arbiter, no request to the device, no
	// claim on the entity.
	arb.Tick()
	if dec, ok := arb.DecisionFor("waermepumpe-1"); ok && (dec.HolderKind != "" || dec.Source != "failsafe") {
		t.Fatalf("the run reached the arbiter: %+v", dec)
	}
	if _, setCalls, _, _ := contact.snapshot(); setCalls != 0 {
		t.Fatalf("%d switching requests reached the device", setCalls)
	}
	if a.entRegistry.Claimed("waermepumpe-1") {
		t.Fatal("the run claimed the device")
	}

	// The heartbeat block on the wire.
	raw, _ := json.Marshal(cloud.StatusExtension{Logik: a.logikSummary()}.Logik)
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil || len(wire["laeufe"].([]any)) != 1 {
		t.Fatalf("wire: %s", raw)
	}
	if !slices.Contains(cloud.BuiltSupports(geraetesuche.BoxArtEdgeLight), "steuerlogik_mitlauf") ||
		!slices.Contains(cloud.BuiltSupports(geraetesuche.BoxArtDocker), "steuerlogik_mitlauf") {
		t.Fatal("both box kinds advertise what they run")
	}

	// A withdrawn logic stops at once and leaves the heartbeat.
	a.onFlows(logikDeployment(t))
	if a.logikSummary() != nil {
		t.Fatal("withdrawn logic still reported")
	}
}

// A Fühler with two probes is ambiguous for <entity>.temperature: unknown,
// never one of them by guess. Site values keep their own age.
func TestLogikQuelleBleibtEhrlich(t *testing.T) {
	a := &Agent{}
	now := time.Now()
	a.logikObserve(now.Add(-90*time.Second), map[string]float64{"power_kw": 1.5, "soc_pct": 80}, nil)
	a.logikObserve(now, map[string]float64{"soc_pct": 81}, nil)
	if w := a.logikQuelle("site.grid", now); w.Zahl == nil || *w.Zahl != 1.5 || w.Alter < 89 {
		t.Fatalf("grid keeps its own age: %+v", w)
	}
	if w := a.logikQuelle("battery.power", now); w.Zahl != nil {
		t.Fatalf("battery never measured must be unknown: %+v", w)
	}
	a.logikObserveSamples(fuehlerBatch(t, "f1", 40, now))
	if w := a.logikQuelle("f1.temperature", now); w.Zahl == nil || *w.Zahl != 40 {
		t.Fatalf("one probe: %+v", w)
	}
	id, _ := json.Marshal("f1")
	raw, _ := json.Marshal(measurements.LocalBatch{CatalogVersion: "test", ObservedAt: now, Samples: []measurements.Sample{{
		PointKey: "shelly.gen2plus.temperature[101].tc", Raw: 55.0, Decoded: 55.0, Quality: "good", EntityID: id}}})
	a.logikObserveSamples(raw)
	if w := a.logikQuelle("f1.temperature", now); w.Zahl != nil {
		t.Fatalf("two probes are ambiguous: %+v", w)
	}
	if w := a.logikQuelle("f1.open", now); w.Zahl != nil || w.Bool != nil {
		t.Fatalf("an input contact is not bound in this stage: %+v", w)
	}

	// The spot price of the price feed while it is valid; unknown before and
	// after (mqtt-price-current.md: stale counts as unknown).
	a.priceFeedMirror = pricefeed.New(func([]byte) error { return nil })
	if w := a.logikQuelle("price.current", now); w.Zahl != nil {
		t.Fatalf("no price yet: %+v", w)
	}
	slot := now.UTC().Truncate(15 * time.Minute)
	raw, _ = json.Marshal(map[string]any{"schema_version": "1.0", "tenant_id": "t", "site_id": "s", "device_id": "d",
		"generated_at": slot.Format(time.RFC3339), "slot_start": slot.Format(time.RFC3339),
		"slot_end": slot.Add(15 * time.Minute).Format(time.RFC3339), "price_ct_kwh": 4.2, "unit": "ct/kWh",
		"bidding_zone": "DE-LU"})
	doc, err := pricefeed.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	a.priceFeedMirror.Accept(doc)
	if w := a.logikQuelle("price.current", now); w.Zahl == nil || *w.Zahl != 4.2 {
		t.Fatalf("fresh price: %+v", w)
	}
	if w := a.logikQuelle("price.current", slot.Add(21*time.Minute)); w.Zahl != nil {
		t.Fatalf("expired price must be unknown: %+v", w)
	}
}
