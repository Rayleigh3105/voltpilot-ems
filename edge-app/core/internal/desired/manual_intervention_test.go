package desired

// D-6a — the MANUAL INTERVENTION outranks a rule (Verbrauchsmanagement v1,
// Korrektur K1; concept `vp-verbrauchsmgmt-konzept-v1` §1.2 S9 + §2.2 K1).
//
// Before K1 the Sofortaktion ("Jetzt stoppen") and the storage intervention
// ("Ladestand halten") travelled as local-ui + override = class flow, rank 70 -
// exactly the rank of a compiled must_run rule. The D-6 same-class rule then
// rejected the human outright as long as the rule kept renewing its wish every
// 15 s. These tests pin the corrected ladder: the manual intervention wins
// against a rule, nothing above rank 75 is touched, the rule resumes
// seamlessly, and a second intervention replaces the first.

import (
	"encoding/json"
	"testing"
	"time"
)

// externalDesireTTL is externalDesire with an explicit TTL (the shared helper
// pins 900 s); a manual intervention's TTL is what the portal chose.
func externalDesireTTL(entity string, source SourceKind, priority Class,
	kw float64, override bool, ttlS int, issued time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": entity,
		"request_id": string(source) + ":" + issued.Format(time.RFC3339Nano),
		"source":     map[string]any{"kind": source}, "priority": priority,
		"override": override, "ttl_s": ttlS,
		"issued_at": issued.Format(time.RFC3339Nano),
		"command":   map[string]any{"type": "setpoint_kw", "value": kw},
	})
	return raw
}

// manualDesire is the wire shape both cloud publishers emit
// (ConsumerOverridePublisher for a consumer, DeviceOverrideService for the
// storage): source local-ui, class flow, override, bounded TTL.
func manualDesire(entity string, kw float64, ttlS int, issued time.Time) []byte {
	return externalDesireTTL(entity, SourceLocalUI, ClassFlow, kw, true, ttlS, issued)
}

// (a) The human beats a HOLDING rule - and the rule takes the entity back by
// itself when the intervention lapses (contract §5 next-highest), without a
// failsafe blip and without waiting for the next 15-s re-emission.
func TestManualInterventionBeatsAHoldingRuleAndTheRuleResumesSeamlessly(t *testing.T) {
	h := newConsumerHarness(t)
	start := h.clock

	// The compiled must_run rule holds the wallbox at 11 kW (flow + override).
	h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, h.clock))
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("rule holder granted %v, want 11", got)
	}

	// "Jetzt stoppen": the manual intervention preempts it.
	h.arb.Submit("wb-1", manualDesire("wb-1", 0, 900, h.clock))
	if got := h.setpointOf("wb-1"); got != 0 {
		t.Fatalf("manual intervention granted %v, want 0 - K1: the human must win", got)
	}
	e := h.lastEvent()
	if e.Outcome != "accepted" && e.Outcome != "clamped" {
		t.Fatalf("manual intervention must be accepted, got %+v", e)
	}
	if e.Holder == nil || e.Holder.Source.Kind != SourceLocalUI {
		t.Fatalf("holder must be the manual intervention: %+v", e.Holder)
	}
	if !hasStage(e.Reasons, "arbitration:override") {
		t.Fatalf("the elevation must stay loud (arbitration:override): %+v", e.Reasons)
	}
	// The displaced rule is superseded, not dropped.
	if sup := h.eventBefore(1); sup.Outcome != "superseded" ||
		sup.Subject == nil || sup.Subject.Source.NodeID != "vp-consumer-policy" {
		t.Fatalf("displaced rule must be superseded: %+v", sup)
	}

	// The rule keeps renewing every 15 s. Each renewal is REJECTED - but with
	// the honest priority reason, and it refreshes the stored copy (that is
	// what makes the resume below seamless).
	for _, at := range []int{15, 890} {
		h.clock = start.Add(time.Duration(at) * time.Second)
		h.arb.Submit("wb-1", flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, h.clock))
		e := h.lastEvent()
		if e.Outcome != "rejected" || !hasStage(e.Reasons, "arbitration:priority") {
			t.Fatalf("renewal at +%ds must be rejected/priority, got %+v", at, e)
		}
		if hasStage(e.Reasons, "arbitration:conflict") {
			t.Fatalf("renewal at +%ds must NOT read as a same-class conflict any more: %+v", at, e)
		}
		if got := h.setpointOf("wb-1"); got != 0 {
			t.Fatalf("device moved to %v while the manual intervention holds", got)
		}
	}

	// The intervention lapses: the still-live rule resumes on the next tick,
	// no re-submission needed, no failsafe in between.
	mark := len(h.events)
	h.clock = start.Add(901 * time.Second)
	h.arb.Tick()
	for _, ev := range h.events[mark:] {
		var got event
		if err := json.Unmarshal(ev.payload, &got); err == nil && got.Outcome == "fallback" {
			t.Fatalf("the handover must not blip through the failsafe: %+v", got)
		}
	}
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("rule must resume at 11 after the intervention lapsed, got %v", got)
	}
	e = h.lastEvent()
	if e.Outcome != "expired" || e.Holder == nil || e.Holder.Source.NodeID != "vp-consumer-policy" {
		t.Fatalf("expiry must hand the entity back to the rule: %+v", e)
	}
	if e.Subject == nil || e.Subject.Source.Kind != SourceLocalUI {
		t.Fatalf("the expiring subject must be the intervention: %+v", e.Subject)
	}
}

// (b) Nothing above rank 75 is touched: a contract/grid/safety holder refuses
// the intervention with the plain priority reason and its command stands.
func TestManualInterventionNeverOutranksCompliance(t *testing.T) {
	for _, cls := range []Class{ClassContract, ClassGrid, ClassSafety} {
		h := newConsumerHarness(t)
		h.arb.SubmitInternal(gridDesire("wb-1", 2, cls, 10*time.Minute, h.clock))
		if got := h.setpointOf("wb-1"); got != 2 {
			t.Fatalf("[%s] compliance holder granted %v, want 2", cls, got)
		}

		h.arb.Submit("wb-1", manualDesire("wb-1", 11, 900, h.clock))
		e := h.lastEvent()
		if e.Outcome != "rejected" || !hasStage(e.Reasons, "arbitration:priority") {
			t.Fatalf("[%s] manual vs %s must be rejected/priority, got %+v", cls, cls, e)
		}
		if got := h.setpointOf("wb-1"); got != 2 {
			t.Fatalf("[%s] compliance command must stand, got %v", cls, got)
		}
		if e.Holder == nil || e.Holder.Priority != cls {
			t.Fatalf("[%s] holder must stay the compliance desire: %+v", cls, e.Holder)
		}
	}
}

// The ladder itself: 40 < 70 < 75 < 80. A rule's override stays at 70, so two
// RULES still cannot preempt each other (D-6 unchanged); only the human's wish
// climbs to 75, and it stays below contract.
func TestManualInterventionRankSitsBetweenRuleAndContract(t *testing.T) {
	at := now
	rule := mustParse(t, flowDesire("wb-1", "vp-consumer-policy", 11, 45, true, at), at)
	plainFlow := mustParse(t, flowDesire("wb-1", "vp-consumer-policy", 11, 45, false, at), at)
	manual := mustParse(t, manualDesire("wb-1", 0, 900, at), at)
	// A local-ui wish WITHOUT override is an ordinary flow wish - only the
	// bounded, deliberate intervention climbs.
	plainLocal := mustParse(t, externalDesireTTL("wb-1", SourceLocalUI, ClassFlow, 0, false, 900, at), at)

	if got := plainFlow.effectiveRank(); got != ClassFlow.rank() {
		t.Fatalf("plain flow rank %d, want %d", got, ClassFlow.rank())
	}
	if got := plainLocal.effectiveRank(); got != ClassFlow.rank() {
		t.Fatalf("local-ui without override rank %d, want %d", got, ClassFlow.rank())
	}
	if got := rule.effectiveRank(); got != 70 {
		t.Fatalf("rule override rank %d, want 70 (D-5 unchanged)", got)
	}
	if got := manual.effectiveRank(); got != ManualRank {
		t.Fatalf("manual intervention rank %d, want %d", got, ManualRank)
	}
	if !(rule.effectiveRank() < manual.effectiveRank() &&
		manual.effectiveRank() < ClassContract.rank()) {
		t.Fatalf("ladder broken: rule %d < manual %d < contract %d",
			rule.effectiveRank(), manual.effectiveRank(), ClassContract.rank())
	}
	if !manual.manualIntervention() || rule.manualIntervention() || plainLocal.manualIntervention() {
		t.Fatal("manualIntervention must be local-ui AND override, nothing else")
	}
}

// (c) The STORAGE intervention (device_override: "Ladestand halten" /
// "Speicher jetzt laden") behaves identically - and it is a priority
// statement, never a guard bypass: the solar-only charge clamp still binds.
func TestStorageManualInterventionBeatsAHoldingRuleAndStillPassesTheGuardChain(t *testing.T) {
	h := newHarness(t)

	// A rule holds the battery discharging at 8 kW.
	h.arb.Submit("batt-main", flowDesire("batt-main", "vp-consumer-policy", -8, 45, true, h.clock))
	if got := h.setpointOf("batt-main"); got != -8 {
		t.Fatalf("rule holder granted %v, want -8", got)
	}

	// "Ladestand halten" = setpoint 0 from the portal.
	h.arb.Submit("batt-main", manualDesire("batt-main", 0, 900, h.clock))
	if got := h.setpointOf("batt-main"); got != 0 {
		t.Fatalf("storage intervention granted %v, want 0 - K1: the human must win", got)
	}
	if e := h.lastEvent(); e.Holder == nil || e.Holder.Source.Kind != SourceLocalUI {
		t.Fatalf("holder must be the manual intervention: %+v", e.Holder)
	}

	// "Speicher jetzt laden" with 12 kW: the EEG solar-only clamp (pv 6.2 kW)
	// still reduces it - rank 75 buys priority, never a wider guard band.
	h.clock = h.clock.Add(time.Second)
	h.arb.Submit("batt-main", manualDesire("batt-main", 12, 900, h.clock))
	got := h.setpointOf("batt-main")
	if got != 6.2 {
		t.Fatalf("manual charge granted %v, want the solar-only 6.2", got)
	}
	e := h.lastEvent()
	if e.Outcome != "clamped" || !hasStage(e.Reasons, "guard:solar_only_charge") {
		t.Fatalf("the guard clamp must stay loud on a manual intervention: %+v", e)
	}
}

// (d) Two interventions in a row: the LATER one replaces the earlier. Source
// local-ui holds ONE slot per entity, so this is the Source.Key replace
// semantics - never a same-class conflict against oneself, and never two
// human wishes queued against each other.
func TestTheLaterManualInterventionReplacesTheEarlierOne(t *testing.T) {
	h := newConsumerHarness(t)

	h.arb.Submit("wb-1", manualDesire("wb-1", 0, 900, h.clock))
	if got := h.setpointOf("wb-1"); got != 0 {
		t.Fatalf("first intervention granted %v, want 0", got)
	}

	h.clock = h.clock.Add(30 * time.Second)
	h.arb.Submit("wb-1", manualDesire("wb-1", 7, 900, h.clock))
	e := h.lastEvent()
	if e.Outcome == "rejected" {
		t.Fatalf("a second intervention must never be rejected against the first: %+v", e)
	}
	if got := h.setpointOf("wb-1"); got != 7 {
		t.Fatalf("second intervention granted %v, want 7", got)
	}

	// Proof that it really is ONE slot: withdrawing the local-ui key leaves no
	// second human wish behind - the entity falls to its failsafe.
	h.arb.Withdraw("wb-1", Source{Kind: SourceLocalUI}.Key(), false)
	if _, ok := h.lastCommand("wb-1"); ok {
		t.Fatal("withdrawing the one local-ui slot must release the wallbox (failsafe release)")
	}
}

// mustParse parses a wire desired the way Submit does, for the rank pins.
func mustParse(t *testing.T, payload []byte, at time.Time) *Desired {
	t.Helper()
	var id struct {
		EntityID string `json:"entity_id"`
	}
	if err := json.Unmarshal(payload, &id); err != nil {
		t.Fatalf("fixture unreadable: %v", err)
	}
	d, err := Parse(id.EntityID, payload, at)
	if err != nil {
		t.Fatalf("fixture rejected: %v", err)
	}
	return d
}

// eventBefore returns the n-th event counted back from the last one.
func (h *harness) eventBefore(n int) event {
	h.t.Helper()
	i := len(h.events) - 1 - n
	if i < 0 {
		h.t.Fatalf("only %d events emitted, cannot look back %d", len(h.events), n)
	}
	var e event
	if err := json.Unmarshal(h.events[i].payload, &e); err != nil {
		h.t.Fatalf("event unreadable: %v", err)
	}
	return e
}
