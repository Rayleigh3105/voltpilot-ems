package agent

// E2 integration test: the September-gate chain at the Go tier, against a
// real in-process cloud broker (plain, dev-URL path) + the real embedded
// local bus + a fake Node-RED Admin API (httptest):
//
//	P1  a desired on the local bus wins arbitration; event + retained command
//	P2  a beyond-bounds desired is CLAMPED (registry band) with the guard
//	    stage in reasons, and edge/setpoint carries the CLAMPED value - the
//	    write path never sees the raw wish
//	P3  a same-class challenger is rejected (conflict), no oscillation
//	P4  an override desired supersedes the v2 plan and the plan resumes on
//	    TTL expiry
//	P5  a v2 plan drives BOTH entities per slot; an aged redelivery is stale
//	    immediately and every entity falls to its registry failsafe
//	P6  a retained deployment set is applied to the (fake) flow runtime and
//	    acked active in the heartbeat flows block
//
// The compose rig (edge-app/test/e2e-v2-compose.sh) proves the same chain
// with real Node-RED + the certified sunspec simulator.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
)

// fakeNRServer is a minimal Node-RED Admin API (auth token + /nodes with the
// real content negotiation + the GLOBAL /flows config endpoint) backed by a
// node array - faithful to the real runtime: /flows honors the caller's node
// ids (the per-flow POST /flow does NOT, which is why the deployer avoids it).
type fakeNRServer struct {
	mu     sync.Mutex
	config []json.RawMessage
}

func (f *fakeNRServer) tabIDs() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for _, raw := range f.config {
		var n struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &n) == nil && n.Type == "tab" {
			out[n.ID] = true
		}
	}
	return out
}

func startFakeNR(t *testing.T) (*fakeNRServer, *httptest.Server) {
	t.Helper()
	f := &fakeNRServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "tok"})
	})
	mux.HandleFunc("GET /nodes", func(w http.ResponseWriter, r *http.Request) {
		// Faithful to real Node-RED: /nodes content-negotiates and serves an
		// HTML/script bundle unless JSON is asked for (caught live by the
		// September-Gate rig - the client must send Accept: application/json).
		if !strings.Contains(r.Header.Get("Accept"), "application/json") {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<!DOCTYPE html><script></script>"))
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"module": flowdeploy.PaletteModule, "version": "0.2.0"},
		})
	})
	mux.HandleFunc("GET /flows", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		nodes := f.config
		if nodes == nil {
			nodes = []json.RawMessage{}
		}
		_ = json.NewEncoder(w).Encode(nodes)
	})
	mux.HandleFunc("POST /flows", func(w http.ResponseWriter, r *http.Request) {
		var nodes []json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&nodes); err != nil {
			http.Error(w, "bad config", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.config = nodes
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return f, srv
}

// planV2 builds a schedule-2.0 payload whose single slot covers "now".
func planV2(generatedAt time.Time, battKw, pvLimitKw float64) []byte {
	slotStart := time.Now().UTC().Truncate(15 * time.Minute)
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "2.0",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"plan_id":        "7c9e6679-7425-40de-944b-e07fc1f90ae7",
		"generated_at":   generatedAt.UTC().Format(time.RFC3339),
		"slot_minutes":   15,
		"entities": []any{
			map[string]any{
				"entity_id": entBattery,
				"kind":      "storage",
				// D-8: explicit true so the plan may command a grid charge in
				// this test (the registry itself says NOT allowed - most
				// restrictive wins is proven separately).
				"charge_from_grid_allowed": true,
				"slots": []any{map[string]any{
					"start":    slotStart.Format(time.RFC3339),
					"commands": map[string]any{"setpoint_kw": battKw},
				}},
			},
			map[string]any{
				"entity_id": entProducer,
				"kind":      "pv-generation",
				"slots": []any{map[string]any{
					"start":    slotStart.Format(time.RFC3339),
					"commands": map[string]any{"limit_kw": pvLimitKw},
				}},
			},
		},
	})
	return raw
}

func desiredPayload(entity, node string, kw float64, ttlS int, override bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"entity_id":      entity,
		"request_id":     node + "-" + fmt.Sprint(time.Now().UnixNano()),
		"source": map[string]any{"kind": "flow",
			"flow_id":      "4e1c2b3a-5d6e-4f70-8123-456789abcdef",
			"flow_version": 7, "node_id": node},
		"priority":  "flow",
		"override":  override,
		"command":   map[string]any{"type": "setpoint_kw", "value": kw},
		"ttl_s":     ttlS,
		"issued_at": time.Now().UTC().Format(time.RFC3339),
	})
	return raw
}

func TestArbitrationChainDesiredPlanOverrideStaleness(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	cb := startPlainCloudBroker(t)
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		registryPush("rev-arb", true))

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = tTenant, tSite, tDevice
	cfg.DevCloudURL = "tcp://" + cb.addr
	cfg.SetpointInterval = time.Second
	cfg.SetpointIntervalSeconds = 1

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	waitFor(t, 15*time.Second, "cloud connected", func() bool {
		return a.State.Get().CloudConnected
	})

	// Observers on the local bus.
	sub := pahoClient(t, cfg.LocalMQTTAddr, "arb-watch")
	var mu sync.Mutex
	var events []map[string]any
	commands := map[string][]string{}
	var setpoints []map[string]any
	subscribe := func(topic string, into func(topic string, payload []byte)) {
		if tok := sub.Subscribe(topic, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
			into(msg.Topic(), msg.Payload())
		}); tok.Wait() && tok.Error() != nil {
			t.Fatal(tok.Error())
		}
	}
	subscribe("edge/entities/+/arbitration", func(_ string, p []byte) {
		var e map[string]any
		if json.Unmarshal(p, &e) == nil {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
		}
	})
	subscribe("edge/entities/+/command", func(topic string, p []byte) {
		mu.Lock()
		commands[topic] = append(commands[topic], string(p))
		mu.Unlock()
	})
	subscribe("edge/setpoint", func(_ string, p []byte) {
		var m map[string]any
		if json.Unmarshal(p, &m) == nil {
			mu.Lock()
			setpoints = append(setpoints, m)
			mu.Unlock()
		}
	})
	lastEventWhere := func(pred func(map[string]any) bool) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		for i := len(events) - 1; i >= 0; i-- {
			if pred(events[i]) {
				return events[i]
			}
		}
		return nil
	}
	lastCommand := func(entity string) (map[string]any, bool) {
		mu.Lock()
		defer mu.Unlock()
		list := commands["edge/entities/"+entity+"/command"]
		for i := len(list) - 1; i >= 0; i-- {
			if list[i] == "" {
				return nil, false // retained clear
			}
			var m map[string]any
			if json.Unmarshal([]byte(list[i]), &m) == nil {
				return m, true
			}
		}
		return nil, false
	}
	cmdSetpoint := func(entity string) (float64, string, bool) {
		m, ok := lastCommand(entity)
		if !ok {
			return 0, "", false
		}
		cmds, _ := m["commands"].(map[string]any)
		v, has := cmds["setpoint_kw"].(float64)
		if !has {
			return 0, m["source"].(string), false
		}
		return v, m["source"].(string), true
	}
	lastSetpoint := func() (float64, string, bool) {
		mu.Lock()
		defer mu.Unlock()
		if len(setpoints) == 0 {
			return 0, "", false
		}
		m := setpoints[len(setpoints)-1]
		kw, _ := m["battery_setpoint_kw"].(float64)
		src, _ := m["source"].(string)
		return kw, src, true
	}

	// Telemetry: pv 5, load 1, soc 50 -> failsafe self-consumption +4,
	// registry band 2 -> the battery failsafe command is 2.
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now(), 5, 1, 50, 100)
	waitFor(t, 15*time.Second, "failsafe battery command", func() bool {
		v, src, ok := cmdSetpoint(entBattery)
		return ok && src == "failsafe" && v == 2
	})

	// --- P1+P2: a beyond-bounds flow desired is clamped and DRIVES the
	// physical path with the clamped value.
	pub := pahoClient(t, cfg.LocalMQTTAddr, "flow-pub")
	if tok := pub.Publish("edge/entities/"+entBattery+"/desired", 1, false,
		desiredPayload(entBattery, "n3", -6, 20, false)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "clamped arbitration event", func() bool {
		e := lastEventWhere(func(e map[string]any) bool { return e["outcome"] == "clamped" })
		if e == nil {
			return false
		}
		granted, _ := e["granted"].(map[string]any)
		return granted != nil && granted["value"] == -2.0
	})
	e := lastEventWhere(func(e map[string]any) bool { return e["outcome"] == "clamped" })
	if !strings.Contains(fmt.Sprint(e["reasons"]), "guard:rated_band") {
		t.Fatalf("clamp reasons must name guard:rated_band: %v", e["reasons"])
	}
	waitFor(t, 15*time.Second, "edge/setpoint follows the clamped desired", func() bool {
		kw, src, ok := lastSetpoint()
		return ok && src == "desired" && kw == -2
	})
	waitFor(t, 15*time.Second, "battery command source desired", func() bool {
		v, src, ok := cmdSetpoint(entBattery)
		return ok && src == "desired" && v == -2
	})

	// --- P3: a same-class challenger is rejected with conflict.
	if tok := pub.Publish("edge/entities/"+entBattery+"/desired", 1, false,
		desiredPayload(entBattery, "nOther", 1, 20, false)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "conflict rejection", func() bool {
		return lastEventWhere(func(e map[string]any) bool {
			return e["outcome"] == "rejected" &&
				strings.Contains(fmt.Sprint(e["reasons"]), "arbitration:conflict")
		}) != nil
	})
	if kw, src, _ := lastSetpoint(); src != "desired" || kw != -2 {
		t.Fatalf("holder must keep the device: %v %s", kw, src)
	}

	// --- P5 first half: after the flow desire expires, the retained v2 plan
	// takes over BOTH entities (battery setpoint + producer limit).
	cb.publishRetained(fmt.Sprintf("ems/%s/%s/%s/v2/plan", tTenant, tSite, tDevice),
		planV2(time.Now(), 1.5, 20))
	waitFor(t, 90*time.Second, "plan commands the battery", func() bool {
		v, src, ok := cmdSetpoint(entBattery)
		return ok && src == "plan" && v == 1.5
	})
	waitFor(t, 15*time.Second, "plan caps the producer", func() bool {
		m, ok := lastCommand(entProducer)
		if !ok {
			return false
		}
		cmds, _ := m["commands"].(map[string]any)
		return m["source"] == "plan" && cmds["limit_kw"] == 20.0
	})
	waitFor(t, 15*time.Second, "v1 write path executes the plan value", func() bool {
		kw, _, ok := lastSetpoint()
		return ok && kw == 1.5
	})

	// --- P4: an override elevates above market, then the plan resumes.
	if tok := pub.Publish("edge/entities/"+entBattery+"/desired", 1, false,
		desiredPayload(entBattery, "nBoost", -1, 3, true)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "override takes the battery", func() bool {
		kw, src, ok := lastSetpoint()
		return ok && src == "desired" && kw == -1
	})
	if lastEventWhere(func(e map[string]any) bool {
		return strings.Contains(fmt.Sprint(e["reasons"]), "arbitration:override")
	}) == nil {
		t.Fatal("override elevation must be loud in the events")
	}
	if lastEventWhere(func(e map[string]any) bool { return e["outcome"] == "superseded" }) == nil {
		t.Fatal("the plan holder must receive a superseded event")
	}
	waitFor(t, 30*time.Second, "plan resumes after override TTL", func() bool {
		v, src, ok := cmdSetpoint(entBattery)
		return ok && src == "plan" && v == 1.5
	})
	if lastEventWhere(func(e map[string]any) bool { return e["outcome"] == "expired" }) == nil {
		t.Fatal("override expiry must emit an expired event")
	}

	// --- P5 second half: an AGED redelivery (generated_at 2h back) is stale
	// immediately - every entity falls to its registry failsafe; the
	// producer's 'release' failsafe CLEARS its retained command.
	cb.publishRetained(fmt.Sprintf("ems/%s/%s/%s/v2/plan", tTenant, tSite, tDevice),
		planV2(time.Now().Add(-2*time.Hour), 1.5, 20))
	defer func() {
		if t.Failed() {
			mu.Lock()
			list := commands["edge/entities/"+entBattery+"/command"]
			if len(list) > 3 {
				list = list[len(list)-3:]
			}
			t.Logf("last battery commands: %v", list)
			if len(events) > 4 {
				events = events[len(events)-4:]
			}
			t.Logf("last events: %v", events)
			mu.Unlock()
		}
	}()
	// The still-live n3 desire resumes FIRST (next-highest active desired,
	// contract §5), then expires; only then does the entity fall to its
	// registry failsafe - the wait spans both transitions.
	waitFor(t, 45*time.Second, "battery falls to failsafe", func() bool {
		v, src, ok := cmdSetpoint(entBattery)
		return ok && src == "failsafe" && v == 2
	})
	waitFor(t, 30*time.Second, "producer command cleared (release failsafe)", func() bool {
		mu.Lock()
		defer mu.Unlock()
		list := commands["edge/entities/"+entProducer+"/command"]
		return len(list) > 0 && list[len(list)-1] == ""
	})
	if lastEventWhere(func(e map[string]any) bool { return e["outcome"] == "fallback" }) == nil {
		t.Fatal("plan staleness must emit fallback events")
	}
}

func TestFlowDeploymentAppliedAndAcked(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	cb := startPlainCloudBroker(t)
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		registryPush("rev-flows", true))
	nr, nrSrv := startFakeNR(t)

	// A deployment whose artifact needs the battery entity, retained BEFORE
	// the device connects (convergence-from-retention).
	tabID := "vpflow-4e1c2b3a-v7"
	bundle := map[string]any{
		"format":  "nodered-tabs",
		"tab_ids": []any{tabID},
		"nodered_flows": []any{
			map[string]any{"id": tabID, "type": "tab", "label": "VP Flow v7",
				"info": "@vp-flow flow_id=4e1c2b3a-5d6e-4f70-8123-456789abcdef flow_version=7"},
			map[string]any{"id": tabID + "-n1", "type": "vp-desired", "z": tabID,
				"entity": entBattery, "command": "setpoint_kw", "ttl_s": 180},
		},
	}
	bundleRaw, _ := json.Marshal(bundle)
	hash, err := flowdeploy.ContentHash(bundleRaw)
	if err != nil {
		t.Fatal(err)
	}
	deployment, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "kind": "deployment",
		"tenant_id": tTenant, "site_id": tSite, "device_id": tDevice,
		"deployed_at": time.Now().UTC().Format(time.RFC3339),
		"artifacts": []any{map[string]any{
			"schema_version": "1.0", "kind": "artifact",
			"artifact_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
			"flow_id":     "4e1c2b3a-5d6e-4f70-8123-456789abcdef",
			"flow_version": 7, "runtime": "edge",
			"content_hash": hash,
			"compiled_at":  "2026-07-18T11:02:33Z", "compiler_version": "1.0.0",
			"min_palette_version": "0.2.0", "min_core_version": "0.1.0",
			"required_entities": []any{map[string]any{
				"entity_id": entBattery, "capabilities": []any{"actuate:setpoint_kw"}}},
			"bundle": bundle,
		}},
	})
	cb.publishRetained(fmt.Sprintf("ems/%s/%s/%s/v2/flows", tTenant, tSite, tDevice), deployment)

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = tTenant, tSite, tDevice
	cfg.DevCloudURL = "tcp://" + cb.addr
	cfg.NodeRedAdminURL = nrSrv.URL
	cfg.NodeRedPassword = "test"
	cfg.SetpointInterval = time.Second
	cfg.SetpointIntervalSeconds = 1

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	// The tab lands in the (fake) flow runtime...
	waitFor(t, 20*time.Second, "artifact tab materialized", func() bool {
		return nr.tabIDs()[tabID]
	})
	// ...and the heartbeat acks it active with the exact hash.
	waitFor(t, 30*time.Second, "flows ack in heartbeat", func() bool {
		return cb.statusWith(`"flows":`) && cb.statusWith(`"state":"active"`) &&
			cb.statusWith(hash)
	})

	// The read-only "Aktive Steuerung" view (report §7) reflects the SAME real
	// core state: the deployed flow appears with its active ack + palette, and
	// the battery entity surfaces as an arbitration winner once the flow's
	// desired holds it.
	waitFor(t, 20*time.Second, "active_control reflects the deployed flow", func() bool {
		ac := a.ActiveControl()
		hasFlow := false
		for _, f := range ac.Flows {
			if f.ContentHash == hash && f.State == "active" {
				hasFlow = true
			}
		}
		hasBattery := false
		for _, e := range ac.Entities {
			if e.EntityID == entBattery && e.Source != "" {
				hasBattery = true
			}
		}
		return hasFlow && ac.PaletteVersion != "" && hasBattery
	})

	// Clearing the retained set removes the tab and empties the ack list.
	cb.publishRetained(fmt.Sprintf("ems/%s/%s/%s/v2/flows", tTenant, tSite, tDevice), nil)
	waitFor(t, 20*time.Second, "artifact tab removed on clear", func() bool {
		return !nr.tabIDs()[tabID]
	})
}
