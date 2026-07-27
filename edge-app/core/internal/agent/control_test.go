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
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
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

// TestSetpointGateIsTheAllowlistNotTheDefault is the safety spine of ON-by-default
// control: even with ControlEnabled=true (the default), an UNCERTIFIED inverter
// family (the pilot Deye) makes control_enabled=false on edge/setpoint, so Layer 1
// writes NOTHING. The per-model certification allowlist is the real per-device gate;
// the global switch is only the coarse stop.
func TestSetpointGateIsTheAllowlistNotTheDefault(t *testing.T) {
	cfg := config.Defaults() // ControlEnabled defaults TRUE now
	cfg.DataDir = t.TempDir()
	if !cfg.ControlEnabled {
		t.Fatal("precondition: control must be ON by default")
	}
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	// Select the pilot Deye (family hybrid_3p) - deliberately NOT in the allowlist.
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}

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
	// ON by default, but the uncertified Deye family gates it OFF -> no live write.
	if m["control_enabled"] != false {
		t.Fatalf("uncertified Deye must yield control_enabled=false despite ON default: %v", m)
	}
	if a.State.Get().ControlEnabled {
		t.Fatal("snapshot ControlEnabled must be false for an uncertified inverter")
	}
	if a.State.Get().ControlCertified {
		t.Fatal("snapshot ControlCertified must be false for the pilot Deye family")
	}
}

// TestSetpointGlobalStopWinsOverACertifiedFamily proves VP_CONTROL_ENABLED=false is
// still the global off-switch even for a certified (dev/sim, empty-family) path.
func TestSetpointGlobalStopWinsOverACertifiedFamily(t *testing.T) {
	cfg := config.Defaults()
	cfg.ControlEnabled = false // operator kill-switch OFF
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg) // no inverter selected -> family "" is certified
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -10, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "setpoint published", func() bool { _, ok := sub.latest(); return ok })
	m, _ := sub.latest()
	if m["control_enabled"] != false {
		t.Fatalf("VP_CONTROL_ENABLED=false must force control_enabled=false: %v", m)
	}
	// No cap on the slot -> no pv_limit_kw key at all (adapter clears any latch).
	if _, present := m["pv_limit_kw"]; present {
		t.Fatalf("pv_limit_kw must be absent without a cap: %v", m)
	}
}

// TestSetpointEegSolarOnlyClamp: a plan carrying grid_charge_allowed=false
// (EEG site, P5) clamps the commanded charge to the MEASURED PV production
// (PV-bus semantics since FK3: charge up to the full actual PV, the house
// may import its load in parallel) before the setpoint is published, and
// turns the forwarded adapter-level grid_charge_allowed off even when the
// device-local config permits it. A plan WITHOUT the field (legacy/
// hand-crafted payload) clamps too - fail-safe, only an explicit
// grid_charge_allowed=true releases the clamp.
func TestSetpointEegSolarOnlyClamp(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.GridChargeAllowed = true // device-local gate open: the PLAN must win
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	eegFalse := false

	// EEG plan commands +20 kW charge; measured pv 5 / load 4 -> the PV-bus
	// clamp caps at the full production 5 (NOT the pre-FK3 surplus 1 - the
	// house imports its 4 kW load in parallel).
	p := freshPlan(now, 20, nil)
	p.GridChargeAllowed = &eegFalse
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)

	waitFor(t, 5*time.Second, "EEG-clamped setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 5.0
	})
	m, _ := sub.latest()
	if m["battery_setpoint_kw"] != 5.0 {
		t.Fatalf("EEG charge must clamp to the measured production: %v", m["battery_setpoint_kw"])
	}
	if m["grid_charge_allowed"] != false {
		t.Fatalf("plan grid_charge_allowed=false must gate the adapter bit: %v", m)
	}
	if a.State.Get().SetpointKw != 5.0 {
		t.Fatalf("snapshot setpoint: %v", a.State.Get().SetpointKw)
	}

	// No production (pv 0): the same command clamps to 0 - never a grid
	// charge on an EEG site, whatever the schedule says.
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 0, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "zero-production clamp", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 0.0
	})

	// Legacy plan WITHOUT the field: FAIL-SAFE - clamps exactly like an EEG
	// plan (only an explicit grid_charge_allowed=true releases the clamp; the
	// optimizer always publishes the field, so only legacy/hand-crafted
	// payloads take this path). pv 5 / load 4 -> the +20 kW command clamps to
	// the 5 kW production and the adapter bit stays off.
	a.mu.Lock()
	a.currentPlan = freshPlan(now, 20, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "legacy plan clamped fail-safe", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 5.0
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
		// The readback node's dual-controller awareness rides along.
		"dual_controller": map[string]any{
			"only_controller_required": true, "possible_conflict": true,
			"reason": "Der Wechselrichter hält den geschriebenen Sollwert nicht (battery_power).",
		},
		"registers": []map[string]any{
			{"role": "battery_power", "fc": 3, "addr": 40, "commanded_raw": 64536, "commanded_kw": commanded, "actual_raw": 65416, "actual_kw": actual, "match": false},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, payload)

	snap := a.State.Get()
	if snap.Control == nil || snap.Control.AllMatch {
		t.Fatalf("expected a mismatch snapshot: %+v", snap.Control)
	}
	// The dual-controller conflict is stored on the snapshot and forwarded to the cloud.
	if !snap.Control.PossibleConflict {
		t.Fatal("possible_conflict must land in the snapshot for the :8484 warning")
	}
	if snap.Control.ConflictReason == "" {
		t.Fatal("conflict reason must be carried for the operator")
	}
	sum := controlSummary(snap)
	if sum.AllMatch || len(sum.MismatchRoles) != 1 || sum.MismatchRoles[0] != "battery_power" {
		t.Fatalf("mismatch summary: %+v", sum)
	}
	if !sum.PossibleConflict {
		t.Fatal("the heartbeat control summary must forward possible_conflict to the cloud")
	}
}

func TestControlSummaryNilWithoutReadback(t *testing.T) {
	if controlSummary(state.Snapshot{}) != nil {
		t.Fatal("controlSummary should be nil without a readback")
	}
}

// TestBlockedControlReadbackSurfacesToTheCardButNotTheHeartbeat pins the Defect 2
// card path: a control plan that is EMPTY because something is WRONG (unknown
// nameplate/scale) is published as a blocked readback with NO registers. It must
// land on the snapshot (so the :8484 card shows the CAUSE instead of an eternal
// "warte auf Rückmeldung") yet must NOT fold into the status heartbeat (the cloud
// contract stays byte-identical to before - no summary when nothing is confirmed).
func TestBlockedControlReadbackSurfacesToTheCardButNotTheHeartbeat(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)

	reason := "Fernsteuerung: Nennleistung des Modells unbekannt - bitte das genaue Wechselrichter-Modell auswählen."
	payload, _ := json.Marshal(map[string]any{
		"ts": "2026-07-27T12:00:03Z", "family": "hybrid_3p", "source": "schedule",
		"control_enabled": true, "certified": true, "control_path": "remote",
		"blocked": true, "reason": reason,
		"registers": []map[string]any{}, // a blocked readback legitimately has none
	})
	a.onControlReadback(localbus.TopicControlReadback, payload)

	snap := a.State.Get()
	if snap.Control == nil {
		t.Fatal("a blocked readback must land on the snapshot for the card")
	}
	if !snap.Control.Blocked || snap.Control.Reason != reason {
		t.Fatalf("blocked/reason not carried: %+v", snap.Control)
	}
	if len(snap.Control.Registers) != 0 {
		t.Fatalf("a blocked readback must have no registers: %+v", snap.Control.Registers)
	}
	// It must NOT fold into the heartbeat (preserve the pre-Defect-2 cloud contract).
	if sum := controlSummary(snap); sum != nil {
		t.Fatalf("a blocked control info must not produce a heartbeat summary: %+v", sum)
	}

	// A genuinely empty (non-blocked) readback is still DROPPED - the blocked path is
	// the ONLY reason a 0-register message is accepted.
	before := a.State.Get().Control
	empty, _ := json.Marshal(map[string]any{"family": "sunspec", "registers": []map[string]any{}})
	a.onControlReadback(localbus.TopicControlReadback, empty)
	if a.State.Get().Control != before {
		t.Fatal("a non-blocked 0-register readback must be dropped, leaving Control unchanged")
	}

	// A subsequent REAL readback (registers present) clears the blocked state.
	real, _ := json.Marshal(map[string]any{
		"family": "hybrid_3p", "source": "schedule", "all_match": true, "control_enabled": true, "certified": true,
		"registers": []map[string]any{
			{"role": "battery_power", "fc": 3, "addr": 1109, "commanded_raw": 33, "actual_raw": 33, "match": true},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, real)
	if got := a.State.Get().Control; got == nil || got.Blocked || len(got.Registers) != 1 {
		t.Fatalf("a real readback must clear the blocked state: %+v", got)
	}
}

// TestRemoteControlPathSurfacesToTheOperator pins the visibility half of the Deye
// REMOTE-MODE path: which surface is steering the inverter must be visible on the
// :8484 card AND transmitted to the cloud - we never silently switch control
// surfaces on a customer's battery. It also pins that the read-only status
// register (1121) is carried as an OBSERVATION and never as a commanded register
// (it must not be able to fabricate or break all_match).
func TestRemoteControlPathSurfacesToTheOperator(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)

	commanded := -0.99
	payload, _ := json.Marshal(map[string]any{
		"ts":                "2026-07-27T12:00:03Z",
		"family":            "hybrid_3p",
		"source":            "calibration",
		"control_enabled":   true,
		"certified":         false,
		"all_match":         true,
		"mismatch_roles":    []string{},
		"control_path":      "remote",
		"remote_status_raw": 1,
		"registers": []map[string]any{
			// 1109: +33 units of 0.1 % of a 30 kW nameplate = 0,99 kW discharge.
			{"role": "battery_power", "fc": 3, "addr": 0x0455, "commanded_raw": 33, "commanded_kw": commanded, "actual_raw": 33, "actual_kw": commanded, "match": true},
			{"role": "remote_mode", "fc": 3, "addr": 0x044c, "commanded_raw": 1, "actual_raw": 1, "match": true},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, payload)

	snap := a.State.Get()
	if snap.Control == nil || snap.Control.ControlPath != "remote" {
		t.Fatalf("the :8484 card must see the active control path: %+v", snap.Control)
	}
	if snap.Control.RemoteStatusRaw == nil || *snap.Control.RemoteStatusRaw != 1 {
		t.Fatalf("the remote-control status register must be surfaced: %+v", snap.Control)
	}
	for _, r := range snap.Control.Registers {
		if r.Role == "remote_status" {
			t.Fatal("1121 is read-only: it must NEVER sit in the commanded-vs-actual list")
		}
	}
	sum := controlSummary(snap)
	if sum == nil || sum.ControlPath != "remote" {
		t.Fatalf("the cloud heartbeat must carry the control path: %+v", sum)
	}
	if sum.CommandedKw == nil || *sum.CommandedKw != commanded {
		t.Fatalf("the remote setpoint must decode to kW for the money/verdict paths: %+v", sum)
	}

	// A ToU readback (or an older Layer 1 that sets nothing) stays byte-compatible.
	old, _ := json.Marshal(map[string]any{
		"ts": "2026-07-27T12:05:03Z", "family": "hybrid_3p", "source": "schedule",
		"control_enabled": true, "certified": false, "all_match": true,
		"registers": []map[string]any{
			{"role": "tou_enable", "fc": 3, "addr": 0x0092, "commanded_raw": 255, "actual_raw": 255, "match": true},
		},
	})
	a.onControlReadback(localbus.TopicControlReadback, old)
	snap = a.State.Get()
	if snap.Control.ControlPath != "" || snap.Control.RemoteStatusRaw != nil {
		t.Fatalf("an adapter that sets neither field must stay unchanged: %+v", snap.Control)
	}
}

// TestSetpointCarriesTheSocCeiling pins the ceiling half of the guard band on
// edge/setpoint. The Deye remote-mode adapter arms the inverter's OWN constant-SoC
// belt (register 1108) with the bound that matches the command direction, which is
// safety-critical because a field report says the inverter's own min/max-SoC
// protections may not apply in remote mode.
func TestSetpointCarriesTheSocCeiling(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.SocMinPct, cfg.SocMaxPct = 12, 88
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -5, nil)
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 5, LoadKw: 4, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "setpoint carries both SoC bounds", func() bool {
		m, ok := sub.latest()
		return ok && m["soc_min_pct"] == 12.0 && m["soc_max_pct"] == 88.0
	})
}
