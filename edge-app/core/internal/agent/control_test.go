package agent

// Inverter-control tests for the core: the setpoint carries the kill-switch +
// certification verdict and the (optionally curtailed) pv_limit; a control
// readback from Layer 1 lands in the snapshot and folds into the heartbeat.

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// setpointSubscriber records the retained edge/setpoint messages.
type setpointSubscriber struct {
	client pahomqtt.Client
	mu     sync.Mutex
	last   map[string]any
}

func subscribeSetpoint(t *testing.T, busAddr string) *setpointSubscriber {
	t.Helper()
	s := &setpointSubscriber{}
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-sp-sub").
		SetConnectTimeout(5 * time.Second)
	s.client = pahomqtt.NewClient(opts)
	if tok := s.client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("setpoint subscriber connect: %v", tok.Error())
	}
	if tok := s.client.Subscribe(localbus.TopicSetpoint, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		var m map[string]any
		if json.Unmarshal(msg.Payload(), &m) == nil {
			s.mu.Lock()
			s.last = m
			s.mu.Unlock()
		}
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("setpoint subscribe: %v", tok.Error())
	}
	t.Cleanup(func() { s.client.Disconnect(100) })
	return s
}

func (s *setpointSubscriber) latest() (map[string]any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil {
		return nil, false
	}
	return s.last, true
}

// freshPlan builds a one-slot plan whose slot is active at now, optionally with
// a PV feed-in cap.
func freshPlan(now time.Time, kw float64, pvLimit *float64) *plan.Plan {
	start := now.Add(-1 * time.Minute)
	return &plan.Plan{
		SlotMinutes: 15,
		ReceivedAt:  now,
		Slots:       []plan.Slot{{Start: start, BatterySetpointKw: kw, PvLimitKw: pvLimit}},
	}
}

func TestSetpointCarriesKillSwitchAndPvLimit(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true // no inverter selected -> certified -> control on
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	cap := 3.0
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -25, &cap)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "setpoint with control + pv_limit", func() bool {
		m, ok := sub.latest()
		return ok && m["control_enabled"] == true
	})
	m, _ := sub.latest()
	if m["control_enabled"] != true {
		t.Fatalf("control_enabled not true: %v", m)
	}
	if m["pv_limit_kw"].(float64) != 3.0 {
		t.Fatalf("pv_limit_kw = %v, want 3", m["pv_limit_kw"])
	}
	if m["grid_charge_allowed"] != false {
		t.Fatalf("grid_charge_allowed should default false: %v", m)
	}
	if m["source"] != "schedule" {
		t.Fatalf("source = %v", m["source"])
	}
	if !a.State.Get().ControlEnabled {
		t.Fatalf("snapshot ControlEnabled should be true")
	}
}

func TestSetpointKillSwitchOffByDefault(t *testing.T) {
	cfg := config.Defaults() // ControlEnabled defaults false
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -10, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "setpoint published", func() bool {
		_, ok := sub.latest()
		return ok
	})
	m, _ := sub.latest()
	if m["control_enabled"] != false {
		t.Fatalf("control_enabled must default false: %v", m)
	}
	// No cap on the slot -> no pv_limit_kw key at all (adapter clears any latch).
	if _, present := m["pv_limit_kw"]; present {
		t.Fatalf("pv_limit_kw must be absent without a cap: %v", m)
	}
}

// TestSetpointEegSolarOnlyClamp: a plan carrying grid_charge_allowed=false
// (EEG site, P5) clamps the commanded charge to the MEASURED PV surplus
// before the setpoint is published, and turns the forwarded adapter-level
// grid_charge_allowed off even when the device-local config permits it. A
// plan WITHOUT the field (legacy/hand-crafted payload) clamps too - fail-safe,
// only an explicit grid_charge_allowed=true releases the clamp.
func TestSetpointEegSolarOnlyClamp(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.GridChargeAllowed = true // device-local gate open: the PLAN must win
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	eegFalse := false

	// EEG plan commands +20 kW charge; measured pv 5 / load 4 -> surplus 1.
	p := freshPlan(now, 20, nil)
	p.GridChargeAllowed = &eegFalse
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "EEG-clamped setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 1.0
	})
	m, _ := sub.latest()
	if m["battery_setpoint_kw"] != 1.0 {
		t.Fatalf("EEG charge must clamp to the measured surplus: %v", m["battery_setpoint_kw"])
	}
	if m["grid_charge_allowed"] != false {
		t.Fatalf("plan grid_charge_allowed=false must gate the adapter bit: %v", m)
	}
	if a.State.Get().SetpointKw != 1.0 {
		t.Fatalf("snapshot setpoint: %v", a.State.Get().SetpointKw)
	}

	// Zero surplus (pv 2 < load 4): the same command clamps to 0 - never a
	// grid charge on an EEG site, whatever the schedule says.
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "zero-surplus clamp", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 0.0
	})

	// Legacy plan WITHOUT the field: FAIL-SAFE - clamps exactly like an EEG
	// plan (only an explicit grid_charge_allowed=true releases the clamp; the
	// optimizer always publishes the field, so only legacy/hand-crafted
	// payloads take this path). pv 5 / load 4 -> the +20 kW command clamps to
	// the 1 kW surplus and the adapter bit stays off.
	a.mu.Lock()
	a.currentPlan = freshPlan(now, 20, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "legacy plan clamped fail-safe", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 1.0
	})
	m, _ = sub.latest()
	if m["grid_charge_allowed"] != false {
		t.Fatalf("a plan without the field must keep the adapter bit off (fail-safe): %v", m)
	}

	// Merchant plan (field true): grid charging stays permitted - no regression.
	eegTrue := true
	p = freshPlan(now, 20, nil)
	p.GridChargeAllowed = &eegTrue
	a.mu.Lock()
	a.currentPlan = p
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "merchant plan unclamped", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 20.0 && m["grid_charge_allowed"] == true
	})
}

func TestControlReadbackLandsInSnapshotAndHeartbeat(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)

	commanded := -4.0
	actual := -4.0
	payload, _ := json.Marshal(map[string]any{
		"ts":              "2026-07-08T12:00:03Z",
		"family":          "sunspec",
		"source":          "schedule",
		"slot_start":      "2026-07-08T12:00:00Z",
		"control_enabled": true,
		"certified":       true,
		"all_match":       true,
		"mismatch_roles":  []string{},
		"registers": []map[string]any{
			{"role": "battery_power", "fc": 3, "addr": 40, "commanded_raw": 64536, "commanded_kw": commanded, "actual_raw": 64536, "actual_kw": actual, "match": true},
			{"role": "control_enable", "fc": 3, "addr": 41, "commanded_raw": 1, "actual_raw": 1, "match": true},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, payload)

	snap := a.State.Get()
	if snap.Control == nil {
		t.Fatal("snapshot Control is nil after a readback")
	}
	if !snap.Control.AllMatch || len(snap.Control.Registers) != 2 {
		t.Fatalf("control snapshot: %+v", snap.Control)
	}
	// The heartbeat summary distils commanded/confirmed kW from battery_power.
	sum := controlSummary(snap)
	if sum == nil || sum.CommandedKw == nil || *sum.CommandedKw != commanded || sum.ConfirmedKw == nil || *sum.ConfirmedKw != actual {
		t.Fatalf("control summary: %+v", sum)
	}
	if !sum.AllMatch {
		t.Fatalf("summary all_match should be true")
	}
}

func TestControlReadbackMismatchSurfaces(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)

	commanded := -4.0
	actual := -1.2
	payload, _ := json.Marshal(map[string]any{
		"family": "sunspec", "source": "schedule", "all_match": false, "control_enabled": true, "certified": true,
		"mismatch_roles": []string{"battery_power"},
		"registers": []map[string]any{
			{"role": "battery_power", "fc": 3, "addr": 40, "commanded_raw": 64536, "commanded_kw": commanded, "actual_raw": 65416, "actual_kw": actual, "match": false},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, payload)

	snap := a.State.Get()
	if snap.Control == nil || snap.Control.AllMatch {
		t.Fatalf("expected a mismatch snapshot: %+v", snap.Control)
	}
	sum := controlSummary(snap)
	if sum.AllMatch || len(sum.MismatchRoles) != 1 || sum.MismatchRoles[0] != "battery_power" {
		t.Fatalf("mismatch summary: %+v", sum)
	}
}

func TestControlSummaryNilWithoutReadback(t *testing.T) {
	if controlSummary(state.Snapshot{}) != nil {
		t.Fatal("controlSummary should be nil without a readback")
	}
}
