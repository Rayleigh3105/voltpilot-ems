package desired

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// The Inkrement-4 chain proofs (docs/verbrauchssteuerung.md §13.3): the
// compiled reactive consumer rule arrives as a class-'flow' desire whose
// override the COMPILER stamped from a validated must_run - these tests pin
// what that override may and may never do on the arbitration chain. No rule
// here is new; they prove the existing chain is NOT loosened by the new
// publisher.

// gridDesire is a compliance-class holder (e.g. a §14a-adjacent cloud
// command) - the class an override must NEVER preempt.
func gridDesire(entity string, kw float64, cls Class, ttl time.Duration, issued time.Time) *Desired {
	return &Desired{
		EntityID:  entity,
		RequestID: string(cls) + ":" + entity,
		Source:    Source{Kind: SourceCloudCommand},
		Priority:  cls,
		TTL:       ttl,
		IssuedAt:  issued,
		Commands:  entities.Commands{SetpointKw: &kw},
	}
}

// flowOnOffDesire is the reactive rule's on_off wish over the real Submit
// (JSON) path - override exactly as the vp-consumer-policy node publishes it.
func flowOnOffDesire(entity, node string, on bool, ttlS int, override bool, issued time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"entity_id":      entity,
		"request_id":     node + ":" + issued.Format(time.RFC3339),
		"source": map[string]any{"kind": "flow",
			"flow_id": "d0eaf5aa-9b1c-4d2e-8f30-415263748596", "flow_version": 3, "node_id": node},
		"priority":  "flow",
		"override":  override,
		"command":   map[string]any{"type": "on_off", "value": on},
		"ttl_s":     ttlS,
		"issued_at": issued.Format(time.RFC3339),
	})
	return raw
}

// A must_run override preempts the PLAN (market) on a consumer - and the plan
// resumes the moment the rule's renewed short TTL is left to lapse (the
// vehicle unplugged / the condition fell): withdrawal is the ABSENCE of
// renewal, never a message that could get lost.
func TestReactiveOverridePreemptsThePlanAndWithdrawsByTTL(t *testing.T) {
	h := newConsumerHarness(t)

	// The plan holds the wallbox at 3 kW (an optimized slot).
	h.arb.SubmitInternal(marketDesire("wb-1", 3, 30*time.Minute))
	if got := h.setpointOf("wb-1"); got != 3 {
		t.Fatalf("plan granted %v, want 3", got)
	}

	// Pflichtregel aktiv: the reactive rule wishes 11 kW with a SHORT TTL.
	h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, h.clock))
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("override granted %v, want 11", got)
	}

	// Renewals keep it alive without ownership churn.
	h.clock = h.clock.Add(15 * time.Second)
	h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, h.clock))
	h.clock = h.clock.Add(15 * time.Second)
	h.arb.Tick()
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("renewed override lost the entity: %v", got)
	}

	// The renewal stops (condition fell). After the last TTL lapses the plan
	// re-takes the wallbox - no explicit withdraw message needed.
	h.clock = h.clock.Add(46 * time.Second)
	h.arb.Tick()
	if e := h.lastEvent(); e.Outcome != "expired" {
		t.Fatalf("want expired on TTL lapse, got %+v", e)
	}
	if got := h.setpointOf("wb-1"); got != 3 {
		t.Fatalf("plan must resume at 3 after withdrawal, got %v", got)
	}
}

// The override elevates ONLY above market: a grid- or contract-class holder
// refuses it with the plain priority reason, and its command stands untouched.
func TestReactiveOverrideNeverPreemptsGridOrContract(t *testing.T) {
	for _, cls := range []Class{ClassGrid, ClassContract} {
		h := newConsumerHarness(t)
		h.arb.SubmitInternal(gridDesire("wb-1", 2, cls, 10*time.Minute, h.clock))
		if got := h.setpointOf("wb-1"); got != 2 {
			t.Fatalf("[%s] compliance holder granted %v, want 2", cls, got)
		}

		h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, h.clock))
		e := h.lastEvent()
		if e.Outcome != "rejected" || !hasStage(e.Reasons, "arbitration:priority") {
			t.Fatalf("[%s] override vs %s must be rejected/priority, got %+v", cls, cls, e)
		}
		if got := h.setpointOf("wb-1"); got != 2 {
			t.Fatalf("[%s] compliance command must stand, got %v", cls, got)
		}
	}
}

// An override is a PRIORITY statement, never a guard bypass: the value clamp
// (consumer band) and the cycle guard hold word for word - compared here
// against the identical non-override wish, stage for stage.
func TestReactiveOverrideNeverLoosensGuardOrCycleChain(t *testing.T) {
	// Value clamp: a 22-kW wish on the 11-kW wallbox is clamped either way.
	h := newConsumerHarness(t)
	h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 22, 120, true, h.clock))
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("override must be clamped to the consumer band, got %v", got)
	}
	if e := h.lastEvent(); e.Outcome != "clamped" {
		t.Fatalf("clamp must be loud, got %+v", e)
	}

	// Cycle guard: the rod's min-off pause holds an OVERRIDE restart exactly
	// like a plan restart (Geräteschutz beats every priority).
	h = newConsumerHarness(t)
	h.arb.Submit("rod-1", flowOnOffDesire("rod-1", "vp-consumer-policy", true, 600, true, h.clock))
	if !h.onOffOf("rod-1") {
		t.Fatal("initial override on refused")
	}
	h.clock = h.clock.Add(3 * time.Minute) // past min-on
	h.arb.Submit("rod-1", flowOnOffDesire("rod-1", "vp-consumer-policy", false, 600, true, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("override off refused after min-on elapsed")
	}
	h.clock = h.clock.Add(20 * time.Second) // inside the 60-s min-off pause
	h.arb.Submit("rod-1", flowOnOffDesire("rod-1", "vp-consumer-policy", true, 600, true, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("min-off pause violated by an override restart")
	}
	dec, ok := h.arb.DecisionFor("rod-1")
	if !ok || dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOff {
		t.Fatalf("Decision.Cycle = %+v, want guard_min_off on the override too", dec.Cycle)
	}
}

// The 4-h override cap holds END TO END: a rule asking for more is capped at
// parse (pinned separately) and the holder really falls after 4 h.
func TestReactiveOverrideCapExpiresAfterFourHours(t *testing.T) {
	h := newConsumerHarness(t)
	h.arb.SubmitInternal(marketDesire("wb-1", 3, 8*time.Hour))
	h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 6*3600, true, h.clock))
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("override granted %v, want 11", got)
	}

	// One second before the cap the override still holds ...
	h.clock = h.clock.Add(OverrideTTLCap - time.Second)
	h.arb.Tick()
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("override must still hold before the cap, got %v", got)
	}
	// ... one second after, the asked-for 6 h count for nothing.
	h.clock = h.clock.Add(2 * time.Second)
	h.arb.Tick()
	if got := h.setpointOf("wb-1"); got != 3 {
		t.Fatalf("override must expire at the 4-h cap, got %v", got)
	}
}
