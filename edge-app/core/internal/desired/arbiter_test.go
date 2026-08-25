package desired

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// --- harness ----------------------------------------------------------------

type published struct {
	entity  string
	payload []byte // nil = retained clear
}

type harness struct {
	t         *testing.T
	arb       *Arbiter
	clock     time.Time
	commands  []published
	events    []published
	reading   guards.Reading
	failsafe  func(id string, r guards.Reading) (float64, bool)
	suspended bool
}

func f64(v float64) *float64 { return &v }

func batteryEntity() entities.Entity {
	no := false
	return entities.Entity{
		ID:   "batt-main",
		Type: entities.TypeBatteryHybrid,
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: "setpoint_kw"}, {Command: "limit_kw"}},
		},
		Guards: entities.Guards{
			Limits: entities.GuardLimits{
				MaxChargeKw: f64(15), MaxDischargeKw: f64(15),
				SocMinPct: f64(5), SocMaxPct: f64(95),
				ChargeFromGridAllowed: &no,
			},
			Failsafe: entities.Failsafe{Behavior: "self-consumption"},
		},
	}
}

func producerEntity() entities.Entity {
	return entities.Entity{
		ID:   "pv-roof",
		Type: entities.TypeProducer,
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: "limit_kw"}, {Command: "limit_pct"}},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxGenerationKw: f64(27)},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
	}
}

func meterEntity() entities.Entity {
	return entities.Entity{
		ID: "grid-meter-1", Type: entities.TypeGridMeter,
		Guards: entities.Guards{Failsafe: entities.Failsafe{Behavior: "measure-only"}},
	}
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, clock: now,
		reading: guards.Reading{SocPct: 50, PvKw: 6.2, LoadKw: 1, GridLimitKw: guards.Unknown()}}
	h.failsafe = func(id string, r guards.Reading) (float64, bool) {
		return guards.SelfConsumption(r), true
	}
	h.arb = New(Deps{
		Now:             func() time.Time { return h.clock },
		Reading:         func(string) guards.Reading { return h.reading },
		Suspended:       func() bool { return h.suspended },
		ControlEnabled:  func() bool { return true },
		StorageFailsafe: func(id string, r guards.Reading) (float64, bool) { return h.failsafe(id, r) },
		PublishCommand: func(id string, p []byte) {
			h.commands = append(h.commands, published{id, p})
		},
		PublishEvent: func(id string, p []byte) {
			h.events = append(h.events, published{id, p})
		},
	})
	h.arb.SetEntities(entities.Registry{Revision: "rev-t", Entities: []entities.Entity{
		batteryEntity(), producerEntity(), meterEntity(),
	}})
	return h
}

type event struct {
	SchemaVersion string          `json:"schema_version"`
	EntityID      string          `json:"entity_id"`
	Ts            string          `json:"ts"`
	Outcome       string          `json:"outcome"`
	Subject       *SourceRef      `json:"subject"`
	Requested     json.RawMessage `json:"requested"`
	Granted       json.RawMessage `json:"granted"`
	Reasons       []Reason        `json:"reasons"`
	Holder        *SourceRef      `json:"holder"`
}

func (h *harness) lastEvent() event {
	h.t.Helper()
	if len(h.events) == 0 {
		h.t.Fatal("no arbitration event emitted")
	}
	var e event
	if err := json.Unmarshal(h.events[len(h.events)-1].payload, &e); err != nil {
		h.t.Fatalf("event unreadable: %v", err)
	}
	if e.SchemaVersion != "1.0" || e.EntityID == "" || e.Ts == "" || e.Outcome == "" || e.Reasons == nil {
		h.t.Fatalf("event misses required contract fields: %s", h.events[len(h.events)-1].payload)
	}
	return e
}

func (h *harness) lastCommand(entity string) (map[string]any, bool) {
	h.t.Helper()
	for i := len(h.commands) - 1; i >= 0; i-- {
		if h.commands[i].entity == entity {
			if h.commands[i].payload == nil {
				return nil, false
			}
			var m map[string]any
			if err := json.Unmarshal(h.commands[i].payload, &m); err != nil {
				h.t.Fatalf("command unreadable: %v", err)
			}
			return m, true
		}
	}
	h.t.Fatalf("no command published for %s", entity)
	return nil, false
}

func (h *harness) setpointOf(entity string) float64 {
	h.t.Helper()
	cmd, ok := h.lastCommand(entity)
	if !ok {
		h.t.Fatalf("command for %s is cleared", entity)
	}
	cmds := cmd["commands"].(map[string]any)
	v, ok := cmds["setpoint_kw"].(float64)
	if !ok {
		h.t.Fatalf("command carries no setpoint: %v", cmd)
	}
	return v
}

func flowDesire(entity, node string, kw float64, ttlS int, override bool, issued time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"entity_id":      entity,
		"request_id":     node + ":" + issued.Format(time.RFC3339),
		"source": map[string]any{"kind": "flow",
			"flow_id": "d0eaf5aa-9b1c-4d2e-8f30-415263748596", "flow_version": 2, "node_id": node},
		"priority":  "flow",
		"override":  override,
		"command":   map[string]any{"type": "setpoint_kw", "value": kw},
		"ttl_s":     ttlS,
		"issued_at": issued.Format(time.RFC3339),
	})
	return raw
}

func marketDesire(entity string, kw float64, ttl time.Duration) *Desired {
	return &Desired{
		EntityID:  entity,
		RequestID: "plan:" + entity,
		Source:    Source{Kind: SourcePlanExecutor},
		Priority:  ClassMarket,
		TTL:       ttl,
		IssuedAt:  now,
		Commands:  entities.Commands{SetpointKw: &kw},
		SolarOnly: false,
	}
}

func externalDesire(entity string, source SourceKind, priority Class,
	kw float64, override bool, issued time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": entity,
		"request_id": string(source) + ":" + issued.Format(time.RFC3339Nano),
		"source":     map[string]any{"kind": source}, "priority": priority,
		"override": override, "ttl_s": 900,
		"issued_at": issued.Format(time.RFC3339Nano),
		"command":   map[string]any{"type": "setpoint_kw", "value": kw},
	})
	return raw
}

func TestPlantRestSuspendsAnIncumbentManualOverrideButNeverCompliance(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", externalDesire(
		"batt-main", SourceLocalUI, ClassFlow, 0, true, h.clock))
	if got := h.setpointOf("batt-main"); got != 0 {
		t.Fatalf("manual hold = %v, want 0", got)
	}

	// Suspension is a live gate: it must evict an ALREADY holding override,
	// not merely filter desires submitted after the pause began.
	h.suspended = true
	h.arb.Tick()
	if got := h.setpointOf("batt-main"); got != 5.2 { // PV 6.2 - load 1
		t.Fatalf("paused battery = %v, want local self-consumption 5.2", got)
	}
	if dec, ok := h.arb.DecisionFor("batt-main"); !ok || dec.HolderKind != "" || dec.Source != "failsafe" {
		t.Fatalf("paused decision must be holderless failsafe: %+v ok=%v", dec, ok)
	}

	// Grid/contract/safety sit above market and remain eligible throughout the
	// pause. This is the safety boundary, not an all-commands kill switch.
	h.clock = h.clock.Add(time.Second)
	h.arb.Submit("batt-main", externalDesire(
		"batt-main", SourceCloudCommand, ClassGrid, -2, false, h.clock))
	if got := h.setpointOf("batt-main"); got != -2 {
		t.Fatalf("grid command during pause = %v, want -2", got)
	}

	// When the local clock ends the pause, the still-live manual intervention
	// resumes without a cloud re-send after compliance releases.
	h.suspended = false
	h.arb.Withdraw("batt-main", Source{Kind: SourceCloudCommand}.Key(), false)
	if got := h.setpointOf("batt-main"); got != 0 {
		t.Fatalf("manual hold after pause = %v, want resumed 0", got)
	}
}

// --- P1: accept, hold, command --------------------------------------------

func TestFlowDesireAcceptedBecomesHolderAndCommands(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", -4, 180, false, h.clock))

	e := h.lastEvent()
	if e.Outcome != "accepted" || e.Holder == nil || e.Holder.Source.Kind != SourceFlow {
		t.Fatalf("want accepted with flow holder, got %+v", e)
	}
	if got := h.setpointOf("batt-main"); got != -4 {
		t.Fatalf("granted setpoint %v, want -4", got)
	}
	cmd, _ := h.lastCommand("batt-main")
	if cmd["source"] != "desired" || cmd["control_enabled"] != true {
		t.Fatalf("command envelope wrong: %v", cmd)
	}
	if dec, ok := h.arb.DecisionFor("batt-main"); !ok || dec.HolderKind != "flow" || dec.Source != "desired" {
		t.Fatalf("decision snapshot wrong: %+v ok=%v", dec, ok)
	}
}

// --- P2: guard clamp with stage attribution ---------------------------------

func TestBeyondBoundsDesireIsClampedWithGuardStage(t *testing.T) {
	h := newHarness(t)
	// Registry band 15, solar-only active (D-8 charge_from_grid_allowed=false),
	// measured PV 6.2 -> a +20 charge wish lands at 6.2.
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", 20, 180, false, h.clock))

	e := h.lastEvent()
	if e.Outcome != "clamped" {
		t.Fatalf("want clamped, got %s", e.Outcome)
	}
	var granted struct {
		Type  string  `json:"type"`
		Value float64 `json:"value"`
	}
	if err := json.Unmarshal(e.Granted, &granted); err != nil || granted.Type != "setpoint_kw" || granted.Value != 6.2 {
		t.Fatalf("granted %s, want setpoint 6.2", e.Granted)
	}
	stages := []string{}
	for _, r := range e.Reasons {
		stages = append(stages, r.Stage)
	}
	if !contains(stages, guards.StageRatedBand) || !contains(stages, guards.StageSolarOnlyCharge) {
		t.Fatalf("reasons must name rated_band + solar_only_charge, got %v", stages)
	}
	if got := h.setpointOf("batt-main"); got != 6.2 {
		t.Fatalf("command %v, want the CLAMPED 6.2 - never the raw wish", got)
	}
}

// --- P3: same-class conflict ------------------------------------------------

func TestSameClassChallengerRejectedUntilHolderTTLLapses(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", -4, 300, false, h.clock))
	before := h.setpointOf("batt-main")

	// A SECOND flow (different node) challenges: holder keeps, challenger
	// rejected with arbitration:conflict (D-6, no oscillation).
	h.arb.Submit("batt-main", flowDesire("batt-main", "nOther", 5, 300, false, h.clock))
	e := h.lastEvent()
	if e.Outcome != "rejected" || e.Reasons[0].Stage != "arbitration:conflict" {
		t.Fatalf("want rejected/conflict, got %+v", e)
	}
	if e.Holder == nil || e.Holder.Source.NodeID != "n3" {
		t.Fatalf("holder must stay n3: %+v", e.Holder)
	}
	if string(e.Granted) != "null" {
		t.Fatalf("rejected event granted must be null, got %s", e.Granted)
	}
	if got := h.setpointOf("batt-main"); got != before {
		t.Fatalf("device value moved on a rejected challenger: %v", got)
	}
	// An override does NOT break the same-class rule (override elevates above
	// market only, never within class flow).
	h.arb.Submit("batt-main", flowDesire("batt-main", "nOther", 5, 300, true, h.clock))
	if e := h.lastEvent(); e.Outcome != "rejected" || e.Reasons[0].Stage != "arbitration:conflict" {
		t.Fatalf("override challenger must still be conflict-rejected, got %+v", e)
	}

	// After the holder's TTL lapses, the challenger's re-emission wins.
	h.clock = h.clock.Add(301 * time.Second)
	h.arb.Submit("batt-main", flowDesire("batt-main", "nOther", 5, 300, false, h.clock))
	if e := h.lastEvent(); e.Outcome != "clamped" && e.Outcome != "accepted" {
		t.Fatalf("challenger must win after holder TTL lapse, got %+v", e)
	} else if e.Holder.Source.NodeID != "nOther" {
		t.Fatalf("holder must be nOther now: %+v", e.Holder)
	}
}

// --- P4: override vs plan, resume on expiry ---------------------------------

func TestOverrideSupersedesPlanAndPlanResumesOnExpiry(t *testing.T) {
	h := newHarness(t)
	h.arb.SubmitInternal(marketDesire("batt-main", 12, 30*time.Minute))
	if got := h.setpointOf("batt-main"); got != 6.2 {
		// plan +12 charge clamped to measured pv 6.2 (registry solar-only)
		t.Fatalf("plan granted %v, want 6.2", got)
	}
	cmd, _ := h.lastCommand("batt-main")
	if cmd["source"] != "plan" {
		t.Fatalf("plan holder must command as source=plan: %v", cmd)
	}

	// A plain (non-override) flow desire loses to market...
	h.arb.Submit("batt-main", flowDesire("batt-main", "n7", -8, 600, false, h.clock))
	if e := h.lastEvent(); e.Outcome != "rejected" || e.Reasons[0].Stage != "arbitration:priority" {
		t.Fatalf("plain flow vs market must be rejected/priority, got %+v", e)
	}

	// ...an override elevates above market: superseded event + new holder.
	h.arb.Submit("batt-main", flowDesire("batt-main", "n9", -8, 600, true, h.clock))
	var superseded, response *event
	for i := len(h.events) - 2; i < len(h.events); i++ {
		var e event
		_ = json.Unmarshal(h.events[i].payload, &e)
		switch e.Outcome {
		case "superseded":
			superseded = &e
		case "accepted", "clamped":
			response = &e
		}
	}
	if superseded == nil || superseded.Subject.Source.Kind != SourcePlanExecutor {
		t.Fatalf("plan holder must receive superseded, events: %d", len(h.events))
	}
	if response == nil || !hasStage(response.Reasons, "arbitration:override") {
		t.Fatalf("override elevation must be loud (arbitration:override): %+v", response)
	}
	if got := h.setpointOf("batt-main"); got != -8 {
		t.Fatalf("override granted %v, want -8 discharge", got)
	}

	// TTL expiry: the plan re-takes the entity.
	h.clock = h.clock.Add(601 * time.Second)
	h.arb.Tick()
	e := h.lastEvent()
	if e.Outcome != "expired" || e.Holder == nil || e.Holder.Source.Kind != SourcePlanExecutor {
		t.Fatalf("plan must resume on override expiry, got %+v", e)
	}
	if got := h.setpointOf("batt-main"); got != 6.2 {
		t.Fatalf("plan value must be re-commanded, got %v", got)
	}
}

// --- next-highest resume + failsafe fall ------------------------------------

func TestQueuedLowerPriorityResumesAndFailsafeFallsLast(t *testing.T) {
	h := newHarness(t)
	h.arb.SubmitInternal(marketDesire("batt-main", 12, 10*time.Minute))
	// A plain flow desire queues below market.
	h.arb.Submit("batt-main", flowDesire("batt-main", "n7", -3, 30*60, false, h.clock))

	// The plan withdraws (stale): the QUEUED flow desire takes over.
	h.arb.Withdraw("batt-main", "plan-executor", true)
	e := h.lastEvent()
	if e.Holder == nil || e.Holder.Source.NodeID != "n7" {
		t.Fatalf("queued flow desire must resume, got %+v", e)
	}
	if got := h.setpointOf("batt-main"); got != -3 {
		t.Fatalf("resumed granted %v, want -3", got)
	}

	// Its expiry with nothing left falls to the registry failsafe
	// (self-consumption = pv 6.2 - load 1 = 5.2).
	h.clock = h.clock.Add(31 * time.Minute)
	h.arb.Tick()
	e = h.lastEvent()
	if e.Outcome != "expired" || e.Holder != nil {
		t.Fatalf("want expired with null holder (failsafe), got %+v", e)
	}
	if got := h.setpointOf("batt-main"); got != 5.2 {
		t.Fatalf("failsafe self-consumption %v, want 5.2", got)
	}
	cmd, _ := h.lastCommand("batt-main")
	if cmd["source"] != "failsafe" {
		t.Fatalf("failsafe command source wrong: %v", cmd)
	}
}

func TestPlanStalenessFallsToFailsafeWithFallbackEvent(t *testing.T) {
	h := newHarness(t)
	h.arb.SubmitInternal(marketDesire("batt-main", 12, 10*time.Minute))
	h.arb.Withdraw("batt-main", "plan-executor", true)
	e := h.lastEvent()
	if e.Outcome != "fallback" || e.Subject != nil || e.Holder != nil {
		t.Fatalf("plan staleness must emit fallback with absent subject + null holder, got %+v", e)
	}
	if !hasStage(e.Reasons, "plan:stale") {
		t.Fatalf("fallback reasons must name plan:stale, got %+v", e.Reasons)
	}
}

// --- producer + meter --------------------------------------------------------

func TestProducerLimitReduceOnlyAndReleaseFailsafe(t *testing.T) {
	h := newHarness(t)
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "pv-roof", "request_id": "r-lim",
		"source":   map[string]any{"kind": "cloud-command"},
		"priority": "grid",
		"command":  map[string]any{"type": "limit_kw", "value": 40.0},
		"ttl_s":    120, "issued_at": h.clock.Format(time.RFC3339),
	})
	h.arb.Submit("pv-roof", raw)
	e := h.lastEvent()
	if e.Outcome != "clamped" || !hasStage(e.Reasons, guards.StageLimitReduceOnly) {
		t.Fatalf("40 kW limit on a 27 kW nameplate must clamp reduce-only, got %+v", e)
	}
	cmd, ok := h.lastCommand("pv-roof")
	if !ok || cmd["commands"].(map[string]any)["limit_kw"] != 27.0 {
		t.Fatalf("producer command wrong: %v", cmd)
	}

	// Expiry: failsafe 'release' clears the retained command (limits cleared).
	h.clock = h.clock.Add(3 * time.Minute)
	h.arb.Tick()
	if _, ok := h.lastCommand("pv-roof"); ok {
		t.Fatal("release failsafe must CLEAR the retained command")
	}
}

func TestMeterRejectsEveryCommand(t *testing.T) {
	h := newHarness(t)
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "grid-meter-1", "request_id": "r-m",
		"source":   map[string]any{"kind": "local-ui"},
		"priority": "flow",
		"command":  map[string]any{"type": "on_off", "value": false},
		"ttl_s":    60, "issued_at": h.clock.Format(time.RFC3339),
	})
	h.arb.Submit("grid-meter-1", raw)
	e := h.lastEvent()
	if e.Outcome != "rejected" || e.Reasons[0].Stage != "capability:unsupported_command" {
		t.Fatalf("meter must reject with capability stage, got %+v", e)
	}
	for _, c := range h.commands {
		if c.entity == "grid-meter-1" && c.payload != nil {
			t.Fatal("a measure-only entity must never be commanded")
		}
	}
}

// --- hygiene -----------------------------------------------------------------

func TestUnknownEntityAndIdentityMismatchAreSilent(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("nobody", flowDesire("nobody", "n1", 1, 60, false, h.clock))
	mismatch := flowDesire("batt-main", "n1", 1, 60, false, h.clock)
	h.arb.Submit("pv-roof", mismatch) // topic != payload entity_id
	if len(h.events) != 0 {
		t.Fatalf("unknown entity / identity mismatch must be silent, got %d events", len(h.events))
	}
}

func TestInvalidPayloadEmitsCorrelatedRejection(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", fixtureBytes(t, "edge-desired.invalid.missing-ttl.json", "batt-main"))
	e := h.lastEvent()
	if e.Outcome != "rejected" || e.Reasons[0].Stage != "validation:schema" {
		t.Fatalf("want schema rejection, got %+v", e)
	}
	if e.Subject == nil || e.Subject.RequestID == "" {
		t.Fatalf("rejection must correlate via subject: %+v", e)
	}
}

func TestSameSourceReemissionRefreshesWithoutOwnershipChange(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", -4, 120, false, h.clock))
	h.clock = h.clock.Add(100 * time.Second)
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", -4, 120, false, h.clock))
	// 130 s after the FIRST emission the refreshed TTL still holds.
	h.clock = h.clock.Add(30 * time.Second)
	h.arb.Tick()
	if dec, ok := h.arb.DecisionFor("batt-main"); !ok || dec.HolderKind != "flow" {
		t.Fatalf("refresh must keep the holder: %+v ok=%v", dec, ok)
	}
	if got := h.setpointOf("batt-main"); got != -4 {
		t.Fatalf("held value %v, want -4", got)
	}
}

func TestHolderReclampFollowsReadingChanges(t *testing.T) {
	h := newHarness(t)
	h.arb.Submit("batt-main", flowDesire("batt-main", "n3", 10, 600, false, h.clock))
	if got := h.setpointOf("batt-main"); got != 6.2 {
		t.Fatalf("initial clamp %v, want 6.2 (pv)", got)
	}
	// PV drops: the standing wish is re-clamped on the next tick.
	h.reading.PvKw = 2.5
	h.clock = h.clock.Add(5 * time.Second)
	h.arb.Tick()
	if got := h.setpointOf("batt-main"); got != 2.5 {
		t.Fatalf("re-clamp %v, want 2.5", got)
	}
	e := h.lastEvent()
	if e.Outcome != "clamped" {
		t.Fatalf("re-clamp must surface as a clamped event, got %+v", e)
	}
}

func fixtureBytes(t *testing.T, name, entity string) []byte {
	raw := string(fixture(t, name))
	raw = strings.ReplaceAll(raw, "9f6f4a1e-3c2d-4b8a-9e51-0d2f8c7a1b22", entity)
	return []byte(raw)
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func hasStage(reasons []Reason, stage string) bool {
	for _, r := range reasons {
		if r.Stage == stage {
			return true
		}
	}
	return false
}

var _ = fmt.Sprintf
var _ = math.NaN
