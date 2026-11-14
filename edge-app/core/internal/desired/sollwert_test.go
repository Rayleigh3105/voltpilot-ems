package desired

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// Steuerlogik K2: a device that regulates itself (air conditioner, heat pump,
// cold-room controller) gets a setpoint in °C inside its released band and
// step, a mode from its closed list, at least min_change_interval_s between two
// changes, and its rest values when nothing commands it.

func klimaEntity() entities.Entity {
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	return entities.Entity{
		ID: "klima-buero", Type: "modbus-device",
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
			{Command: "on_off", Rest: raw("false")},
			{Command: "setpoint_c", Min: f64(16), Max: f64(30), Step: f64(0.5), Rest: raw("24")},
			{Command: "mode", Modes: []string{"cool", "heat", "fan_only"}, Rest: raw(`"cool"`)},
		}},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MinChangeIntervalSeconds: f64(300)},
			Failsafe: entities.Failsafe{Behavior: "rest"},
		},
	}
}

func newKlimaHarness(t *testing.T) *harness {
	h := newHarness(t)
	h.arb.SetEntities(entities.Registry{Revision: "rev-k", Entities: []entities.Entity{klimaEntity()}})
	return h
}

func (h *harness) logikDesire(sp *float64, mode string, on *bool) *Desired {
	return &Desired{
		EntityID: "klima-buero", RequestID: "logik", Priority: ClassFlow, TTL: 45 * time.Second,
		IssuedAt: h.clock, Source: Source{Kind: SourceFlow, FlowID: "logik", NodeID: "klima"},
		Commands: entities.Commands{SetpointC: sp, Mode: mode, OnOff: on},
	}
}

func (h *harness) granted(entity string) entities.Commands {
	h.t.Helper()
	d, ok := h.arb.DecisionFor(entity)
	if !ok {
		h.t.Fatalf("no decision for %s", entity)
	}
	return d.Granted
}

func TestSetpointCParsedFromExternalDesire(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "klima-buero", "request_id": "r1",
		"source": map[string]any{"kind": "local-ui"}, "priority": "flow", "ttl_s": 60,
		"issued_at": now.Format(time.RFC3339), "command": map[string]any{"type": "setpoint_c", "value": 21.3},
	})
	d, err := Parse("klima-buero", raw, now)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if d.Commands.SetpointC == nil || *d.Commands.SetpointC != 21.3 || d.RequestedType != "setpoint_c" {
		t.Fatalf("setpoint_c not parsed: %+v", d.Commands)
	}
	bad, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "klima-buero", "request_id": "r2",
		"source": map[string]any{"kind": "local-ui"}, "priority": "flow", "ttl_s": 60,
		"issued_at": now.Format(time.RFC3339), "command": map[string]any{"type": "setpoint_c", "value": "warm"},
	})
	if _, err := Parse("klima-buero", bad, now); err == nil {
		t.Fatal("a non-numeric setpoint_c must be refused")
	}
}

func TestSetpointCClampedToBandAndStep(t *testing.T) {
	h := newKlimaHarness(t)
	on := true
	h.arb.SubmitInternal(h.logikDesire(f64(21.26), "cool", &on))
	g := h.granted("klima-buero")
	if g.SetpointC == nil || *g.SetpointC != 21.5 || g.Mode != "cool" || g.OnOff == nil || !*g.OnOff {
		t.Fatalf("21.26 °C on 0.5 K from 16 °C must grant 21.5, cool, on: %+v", g)
	}
	cmd, _ := h.lastCommand("klima-buero")
	if c := cmd["commands"].(map[string]any); c["setpoint_c"] != 21.5 {
		t.Fatalf("retained command carries setpoint_c: %v", cmd)
	}

	// Below the band: clamped to 16 °C - after the change interval. The agent
	// ticks the arbiter on its cadence, so the expired wish fell to the rest
	// values in between (held by the interval).
	h.clock = h.clock.Add(50 * time.Second)
	h.arb.Tick()
	h.clock = h.clock.Add(251 * time.Second)
	h.arb.SubmitInternal(h.logikDesire(f64(9), "cool", &on))
	if g := h.granted("klima-buero"); *g.SetpointC != 16 {
		t.Fatalf("9 °C must be clamped to the band's 16 °C, got %v", *g.SetpointC)
	}
}

func TestUndeclaredModeDropped(t *testing.T) {
	h := newKlimaHarness(t)
	h.arb.SubmitInternal(h.logikDesire(f64(22), "dry", nil))
	g := h.granted("klima-buero")
	if g.Mode != "" || g.SetpointC == nil {
		t.Fatalf("a mode outside the device's list is dropped, the setpoint stays: %+v", g)
	}
}

func TestSetpointCRefusedWithoutCapability(t *testing.T) {
	h := newHarness(t) // battery, producer, meter: none declares setpoint_c
	sp := 21.0
	h.arb.SubmitInternal(&Desired{EntityID: "batt-main", RequestID: "x", Priority: ClassFlow,
		TTL: time.Minute, IssuedAt: now, Source: Source{Kind: SourceFlow, FlowID: "f", NodeID: "n"},
		Commands: entities.Commands{SetpointC: &sp}})
	if d, ok := h.arb.DecisionFor("batt-main"); ok && d.Granted.SetpointC != nil {
		t.Fatalf("setpoint_c on an entity without the capability: %+v", d.Granted)
	}
}

func TestChangeIntervalHoldsThenReleases(t *testing.T) {
	h := newKlimaHarness(t)
	h.arb.SubmitInternal(h.logikDesire(f64(25), "cool", nil))
	start := h.clock

	// 60 s later the logic wants 23.5 °C and heat: both are held at the old values.
	h.clock = start.Add(60 * time.Second)
	h.arb.SubmitInternal(h.logikDesire(f64(23.5), "heat", nil))
	d, _ := h.arb.DecisionFor("klima-buero")
	if *d.Granted.SetpointC != 25 || d.Granted.Mode != "cool" || len(d.Change) != 2 {
		t.Fatalf("changes inside 300 s must be held: %+v holds=%+v", d.Granted, d.Change)
	}
	e := h.lastEvent()
	found := false
	for _, r := range e.Reasons {
		if r.Stage == guards.StageChangeInterval {
			found = true
		}
	}
	if !found {
		t.Fatalf("the held change carries its honest stage: %+v", e.Reasons)
	}

	// After the interval the standing wish lands (the agent's ticks in between
	// let the lapsed wish fall to the rest values, held by the interval as well).
	h.clock = start.Add(120 * time.Second)
	h.arb.Tick()
	if g := h.granted("klima-buero"); *g.SetpointC != 25 {
		t.Fatalf("the rest setpoint is a change too and waits: %+v", g)
	}
	h.clock = start.Add(301 * time.Second)
	h.arb.SubmitInternal(h.logikDesire(f64(23.5), "heat", nil))
	d, _ = h.arb.DecisionFor("klima-buero")
	if *d.Granted.SetpointC != 23.5 || d.Granted.Mode != "heat" || len(d.Change) != 0 {
		t.Fatalf("after 300 s the change lands: %+v holds=%+v", d.Granted, d.Change)
	}
}

func TestRestFailsafeAfterExpiry(t *testing.T) {
	h := newKlimaHarness(t)
	on := true
	h.arb.SubmitInternal(h.logikDesire(f64(22), "cool", &on))
	// The logic stops wishing: after its TTL the device falls to its rest values -
	// but the rest setpoint is a change too and waits for the interval.
	h.clock = h.clock.Add(50 * time.Second)
	h.arb.Tick()
	d, ok := h.arb.DecisionFor("klima-buero")
	if !ok || d.Source != "failsafe" {
		t.Fatalf("expected the failsafe after the TTL, got %+v", d)
	}
	if d.Granted.OnOff == nil || *d.Granted.OnOff || d.Granted.Mode != "cool" || *d.Granted.SetpointC != 22 {
		t.Fatalf("rest: off and cool at once, the setpoint held by the interval: %+v", d.Granted)
	}
	h.clock = h.clock.Add(300 * time.Second)
	h.arb.Tick()
	if g := h.granted("klima-buero"); *g.SetpointC != 24 {
		t.Fatalf("after the interval the rest setpoint 24 °C applies: %+v", g)
	}
}

func TestRestWithoutDeclaredValuesClears(t *testing.T) {
	e := klimaEntity()
	for i := range e.Capabilities.Actuate {
		e.Capabilities.Actuate[i].Rest = nil
	}
	h := newHarness(t)
	h.arb.SetEntities(entities.Registry{Revision: "r", Entities: []entities.Entity{e}})
	h.arb.Tick()
	if d, ok := h.arb.DecisionFor("klima-buero"); ok && !d.Granted.Empty() {
		t.Fatalf("failsafe rest without any rest value commands nothing: %+v", d.Granted)
	}
}
