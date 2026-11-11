package verbraucherregel

// The runtime end to end inside the box program, minus the broker: the
// committed flowc artifact of a generated consumer rule
// (nodered/flowc/testdata/consumer-reactive.artifact.json - the very bytes the
// Docker box loads into Node-RED) goes through the real flow deployer
// (hash, gates, ack) into this runtime; telemetry on the local bus turns into
// the desired on edge/entities/<id>/desired, the compiled inject renews it,
// and a cleared set stops renewing (withdrawal by TTL).

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flowdeploy"
)

const artifactPath = "../../../nodered/flowc/testdata/consumer-reactive.artifact.json"

// --- fake clock --------------------------------------------------------------

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { s := !t.stopped; t.stopped = true; return s }

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

// Advance moves the clock, firing due timers in time order (outside the lock).
func (c *fakeClock) Advance(d time.Duration) {
	end := c.Now().Add(d)
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var next *fakeTimer
		for i, t := range c.timers {
			if t.stopped {
				continue
			}
			if !t.at.After(end) {
				next = t
				c.timers = append(c.timers[:i:i], c.timers[i+1:]...)
			}
			break
		}
		if next == nil {
			c.now = end
			// drop stopped timers
			kept := c.timers[:0]
			for _, t := range c.timers {
				if !t.stopped {
					kept = append(kept, t)
				}
			}
			c.timers = kept
			c.mu.Unlock()
			return
		}
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

func (c *fakeClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}

// --- fake bus ----------------------------------------------------------------

type published struct {
	topic   string
	payload map[string]any
}

type fakeBus struct {
	mu   sync.Mutex
	subs map[string]func(string, []byte)
	pubs []published
}

func newFakeBus() *fakeBus { return &fakeBus{subs: map[string]func(string, []byte){}} }

func (b *fakeBus) Subscribe(topic string, fn func(string, []byte)) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs[topic] = fn
	return nil
}

func (b *fakeBus) Publish(topic string, payload []byte, retain bool) error {
	var m map[string]any
	_ = json.Unmarshal(payload, &m)
	b.mu.Lock()
	defer b.mu.Unlock()
	if retain {
		m = map[string]any{"retained": true}
	}
	b.pubs = append(b.pubs, published{topic: topic, payload: m})
	return nil
}

func matches(filter, topic string) bool {
	f, t := strings.Split(filter, "/"), strings.Split(topic, "/")
	if len(f) != len(t) {
		return false
	}
	for i := range f {
		if f[i] != "+" && f[i] != t[i] {
			return false
		}
	}
	return true
}

// deliver hands a message to every matching subscription (as the broker would).
func (b *fakeBus) deliver(topic string, v any) {
	raw, _ := json.Marshal(v)
	b.mu.Lock()
	var fns []func(string, []byte)
	for f, fn := range b.subs {
		if matches(f, topic) {
			fns = append(fns, fn)
		}
	}
	b.mu.Unlock()
	for _, fn := range fns {
		fn(topic, raw)
	}
}

// settle waits until the sender goroutine drained, then returns all publishes.
func (b *fakeBus) settle(t *testing.T, l *Laufzeit) []published {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for len(l.out) > 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]published(nil), b.pubs...)
}

// --- the deployment around the committed artifact ------------------------------

const (
	tTenant = "00000000-0000-0000-0000-000000000001"
	tSite   = "00000000-0000-0000-0000-000000000002"
	tDevice = "00000000-0000-0000-0000-000000000003"
)

func committedArtifact(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(artifactPath)
	if err != nil {
		t.Fatal(err)
	}
	var a map[string]any
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func deployment(t *testing.T, artifacts ...map[string]any) []byte {
	t.Helper()
	arts := make([]any, 0, len(artifacts))
	for _, a := range artifacts {
		arts = append(arts, a)
	}
	raw, err := json.Marshal(map[string]any{"schema_version": "1.0", "kind": "deployment",
		"tenant_id": tTenant, "site_id": tSite, "device_id": tDevice,
		"deployed_at": "2026-08-10T09:00:00Z", "artifacts": arts})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func registry() entities.Registry {
	return entities.Registry{Revision: "rev-1", Entities: []entities.Entity{{
		ID: "wallbox-1", Type: "wallbox",
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "setpoint_kw"}}},
	}}}
}

type rig struct {
	bus   *fakeBus
	clock *fakeClock
	l     *Laufzeit
	dep   *flowdeploy.Deployer
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{bus: newFakeBus(),
		clock: &fakeClock{now: time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)}}
	r.l = New(r.bus, Options{Clock: r.clock})
	t.Cleanup(r.l.Close)
	r.dep = flowdeploy.NewDeployer(flowdeploy.Deps{DataDir: t.TempDir(), CoreVersion: "2.1.3",
		Registry: registry,
		Identity: func() flowdeploy.Identity {
			return flowdeploy.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice}
		}})
	r.dep.SetLokaleLaufzeit(r.l)
	return r
}

func (r *rig) ack(t *testing.T, flowID string) (string, string) {
	t.Helper()
	sum := r.dep.Summary()
	if sum == nil {
		t.Fatal("no flows summary")
	}
	for _, a := range sum.Applied {
		if a.FlowID == flowID {
			return a.State, a.Detail
		}
	}
	t.Fatalf("flow %s not acked", flowID)
	return "", ""
}

func desireds(pubs []published) []published {
	var out []published
	for _, p := range pubs {
		if p.topic == "edge/entities/wallbox-1/desired" {
			out = append(out, p)
		}
	}
	return out
}

func connected(v float64) map[string]any {
	return map[string]any{"schema_version": "1.0", "entity_id": "wallbox-1",
		"channels": map[string]any{"vehicle_connected": v}}
}

// --- tests -------------------------------------------------------------------

func TestArtefaktLaeuftAufDemLokalenBus(t *testing.T) {
	r := newRig(t)
	a := committedArtifact(t)
	flowID := a["flow_id"].(string)
	r.dep.HandleDeployment(deployment(t, a))
	if state, detail := r.ack(t, flowID); state != "active" {
		t.Fatalf("the committed consumer-rule artifact must run on Edge Light: %s (%s)", state, detail)
	}
	if got := r.l.Laufend(); len(got) != 1 || !strings.HasPrefix(got[0], flowID+"@") {
		t.Fatalf("running: %v", got)
	}

	// Nothing before a signal: unknown never starts.
	r.clock.Advance(1 * time.Second) // once-trigger
	if got := desireds(r.bus.settle(t, r.l)); len(got) != 0 {
		t.Fatalf("no signal, no desired: %+v", got)
	}

	// Vehicle connected (a 0/1 entity channel) -> the must_run desired at once.
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	got := desireds(r.bus.settle(t, r.l))
	if len(got) != 1 {
		t.Fatalf("one desired on connect, got %d", len(got))
	}
	p := got[0].payload
	cmd := p["command"].(map[string]any)
	src := p["source"].(map[string]any)
	if p["override"] != true || cmd["type"] != "setpoint_kw" || cmd["value"] != 11.0 ||
		p["ttl_s"] != 45.0 || p["request_id"] != "reaktiv:11" || p["priority"] != "flow" ||
		src["kind"] != "flow" || src["flow_id"] != flowID || src["flow_version"] != 3.0 ||
		src["node_id"] != "reaktiv" || p["entity_id"] != "wallbox-1" ||
		p["issued_at"] != "2026-08-10T09:00:01.000Z" {
		t.Fatalf("desired not as the palette node shapes it: %v", p)
	}

	// The compiled inject (every 15 s) renews it.
	r.clock.Advance(15 * time.Second)
	if got := desireds(r.bus.settle(t, r.l)); len(got) != 2 {
		t.Fatalf("the trigger renews: %d desireds", len(got))
	}
	// Telemetry repeating the same state publishes nothing new.
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	if got := desireds(r.bus.settle(t, r.l)); len(got) != 2 {
		t.Fatalf("same state from telemetry must not re-publish: %d", len(got))
	}
	// The same set again (retained re-delivery, reconcile) keeps the rule
	// running WITH its state - no restart: the same telemetry stays silent
	// (a fresh engine would see a new start and publish).
	r.dep.HandleDeployment(deployment(t, a))
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	if got := desireds(r.bus.settle(t, r.l)); len(got) != 2 {
		t.Fatalf("an unchanged artifact must not restart: %d desireds", len(got))
	}
	// Another entity's telemetry is not this rule's signal.
	r.bus.deliver("edge/entities/wallbox-2/telemetry", map[string]any{"schema_version": "1.0",
		"entity_id": "wallbox-2", "channels": map[string]any{"vehicle_connected": 0.0}})

	// Disconnect: the off-delay (15 s) still renews once, then it stops.
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(0))
	r.clock.Advance(60 * time.Second)
	n := len(desireds(r.bus.settle(t, r.l)))
	r.clock.Advance(120 * time.Second)
	if got := desireds(r.bus.settle(t, r.l)); len(got) != n {
		t.Fatalf("after the off-delay nothing renews: %d -> %d", n, len(got))
	}
	for _, p := range r.bus.settle(t, r.l) {
		if p.payload["retained"] == true {
			t.Fatal("desires are never retained")
		}
	}

	// Cleared set: the rule stops; even a connected vehicle gets no desired.
	r.dep.HandleDeployment(nil)
	if got := r.l.Laufend(); len(got) != 0 {
		t.Fatalf("cleared set still running: %v", got)
	}
	before := len(desireds(r.bus.settle(t, r.l)))
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	r.clock.Advance(60 * time.Second)
	if got := desireds(r.bus.settle(t, r.l)); len(got) != before {
		t.Fatalf("a stopped rule must not publish: %d -> %d", before, len(got))
	}
	if r.clock.pending() != 0 {
		t.Fatalf("stopped rule left %d timers", r.clock.pending())
	}
}

func TestGeaendertesArtefaktStartetFrisch(t *testing.T) {
	r := newRig(t)
	a := committedArtifact(t)
	r.dep.HandleDeployment(deployment(t, a))
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	first := r.l.Laufend()

	// A new policy version = a new artifact (other content hash).
	b := committedArtifact(t)
	bundle := b["bundle"].(map[string]any)
	for _, n := range bundle["nodered_flows"].([]any) {
		m := n.(map[string]any)
		if m["type"] == NodeType {
			m["ttl_s"] = 60.0
		}
	}
	raw, _ := json.Marshal(bundle)
	hash, err := flowdeploy.ContentHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	b["content_hash"] = hash
	r.dep.HandleDeployment(deployment(t, b))
	second := r.l.Laufend()
	if len(second) != 1 || second[0] == first[0] {
		t.Fatalf("changed artifact must replace the running one: %v -> %v", first, second)
	}
	// Fresh engine: the vehicle state is unknown again until the next telemetry.
	r.clock.Advance(1 * time.Second)
	before := len(desireds(r.bus.settle(t, r.l)))
	r.bus.deliver("edge/entities/wallbox-1/telemetry", connected(1))
	got := desireds(r.bus.settle(t, r.l))
	if len(got) != before+1 || got[len(got)-1].payload["ttl_s"] != 60.0 {
		t.Fatalf("the new version runs with its own config: %+v", got)
	}
}

func TestFremdeBuendelWerdenAbgelehnt(t *testing.T) {
	cases := map[string]func(m map[string]any){
		"vp-desired läuft auf dieser Box nicht": func(m map[string]any) {
			if m["type"] == NodeType {
				m["type"] = "vp-desired"
			}
		},
		"crontab": func(m map[string]any) {
			if m["type"] == "inject" {
				m["crontab"] = "0 6 * * *"
			}
		},
	}
	for want, mutate := range cases {
		t.Run(want, func(t *testing.T) {
			r := newRig(t)
			a := committedArtifact(t)
			bundle := a["bundle"].(map[string]any)
			for _, n := range bundle["nodered_flows"].([]any) {
				mutate(n.(map[string]any))
			}
			raw, _ := json.Marshal(bundle)
			hash, err := flowdeploy.ContentHash(raw)
			if err != nil {
				t.Fatal(err)
			}
			a["content_hash"] = hash
			r.dep.HandleDeployment(deployment(t, a))
			state, detail := r.ack(t, a["flow_id"].(string))
			if state != "unsupported" || !strings.Contains(detail, strings.Split(want, " ")[0]) {
				t.Fatalf("got %s (%s)", state, detail)
			}
			if len(r.l.Laufend()) != 0 {
				t.Fatal("a refused bundle must not run")
			}
		})
	}
}

func TestSiteSignaleAusEdgeTelemetry(t *testing.T) {
	// A surplus rule fed from the composite edge/telemetry (the Layer 1
	// reading, same keys as the Node-RED decode).
	r := newRig(t)
	a := committedArtifact(t)
	bundle := a["bundle"].(map[string]any)
	for _, n := range bundle["nodered_flows"].([]any) {
		m := n.(map[string]any)
		if m["type"] == NodeType {
			m["command"] = "on_off"
			m["requirements"] = []any{map[string]any{"id": "ueberschuss", "must_run": false,
				"value": true, "condition": map[string]any{"signal": "site.pv_surplus_kw",
					"source": "site", "channel": "pv_surplus_kw", "op": "gt", "value": 1.5,
					"reset_value": 1.125, "max_age_s": 120.0}}}
		}
	}
	raw, _ := json.Marshal(bundle)
	hash, _ := flowdeploy.ContentHash(raw)
	a["content_hash"] = hash
	r.dep.HandleDeployment(deployment(t, a))
	r.bus.deliver("edge/telemetry", map[string]any{"pv_power_kw": 4.0, "load_kw": 1.0,
		"soc_pct": 50.0, "ts": "2026-08-10T09:00:00.000Z"})
	got := desireds(r.bus.settle(t, r.l))
	if len(got) != 1 {
		t.Fatalf("surplus 3 kW > 1.5 must start: %d desireds", len(got))
	}
	cmd := got[0].payload["command"].(map[string]any)
	if cmd["type"] != "on_off" || cmd["value"] != true || got[0].payload["override"] != nil {
		t.Fatalf("on_off desired without override expected: %v", got[0].payload)
	}
}
