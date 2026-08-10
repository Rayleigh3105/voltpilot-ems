package desired

// The internal deadline-fallback class (Verbrauchssteuerung Inkrement 6,
// D-20): rank 50 between plain flow (40) and market (60), below the D-5 flow
// override (70). The tests pin the four load-bearing properties: no external
// publisher can claim it, a fresh plan preempts it SEAMLESSLY (supersede -
// never a failsafe blip), a reactive Pflichtregel outranks it, and the cycle
// guard binds on its wish like on every other consumer command.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

func fallbackDesire(entity string, ttl time.Duration, issued time.Time) *Desired {
	on := true
	return &Desired{
		EntityID:  entity,
		RequestID: "flex-fallback:pump@2026-07-18",
		Source:    Source{Kind: SourceDeadlineFallback},
		Priority:  ClassDeadlineFallback,
		TTL:       ttl,
		IssuedAt:  issued,
		Commands:  entities.Commands{OnOff: &on},
	}
}

func TestNoExternalPublisherCanClaimTheFallbackClass(t *testing.T) {
	// The source KIND is refused at parse (validation:schema).
	payload := []byte(`{"schema_version":"1.0","entity_id":"rod-1",
	 "request_id":"evil-1","source":{"kind":"deadline-fallback"},
	 "priority":"deadline-fallback","command":{"type":"on_off","value":true},
	 "ttl_s":60,"issued_at":"2026-07-18T10:20:00Z"}`)
	if _, err := Parse("rod-1", payload, now); err == nil {
		t.Fatal("an external deadline-fallback source kind must be refused")
	} else if !strings.Contains(err.Error(), "unknown source kind") {
		t.Fatalf("wrong refusal: %v", err)
	}
	// And no ALLOWED kind may claim the CLASS (arbitration:priority_not_allowed).
	for _, kind := range []string{"flow", "local-ui", "plan-executor", "cloud-command"} {
		src := `{"kind":"` + kind + `"}`
		if kind == "flow" {
			src = `{"kind":"flow","flow_id":"aa1c2b3a-5d6e-4f70-8123-456789abcdaa","flow_version":1,"node_id":"n1"}`
		}
		p := []byte(`{"schema_version":"1.0","entity_id":"rod-1",
		 "request_id":"evil-2","source":` + src + `,
		 "priority":"deadline-fallback","command":{"type":"on_off","value":true},
		 "ttl_s":60,"issued_at":"2026-07-18T10:20:00Z"}`)
		_, err := Parse("rod-1", p, now)
		if err == nil {
			t.Fatalf("kind %s must not claim class deadline-fallback", kind)
		}
		pe, ok := err.(*ParseError)
		if !ok || pe.Stage != "arbitration:priority_not_allowed" {
			t.Fatalf("kind %s: wrong refusal %v", kind, err)
		}
	}
}

func TestAFreshPlanPreemptsTheFallbackSeamlessly(t *testing.T) {
	h := newConsumerHarness(t)

	// The fallback holds the rod ON.
	h.arb.SubmitInternal(fallbackDesire("rod-1", 60*time.Second, h.clock))
	if !h.onOffOf("rod-1") {
		t.Fatal("fallback wish must command the rod on")
	}

	// A fresh plan's market desire arrives: rank 60 > 50 - it SUPERSEDES the
	// fallback holder directly. The retained command flips plan-side without
	// ever passing through the failsafe (no off blip against the cycle guard).
	before := len(h.commands)
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 120, h.clock))
	cmd, ok := h.lastCommand("rod-1")
	if !ok {
		t.Fatal("plan takeover cleared the command")
	}
	if cmd["source"] != "plan" {
		t.Fatalf("holder after plan arrival = %v, want plan", cmd["source"])
	}
	for _, p := range h.commands[before:] {
		if p.entity != "rod-1" || p.payload == nil {
			continue
		}
		var m struct {
			Source string `json:"source"`
		}
		if err := json.Unmarshal(p.payload, &m); err != nil {
			t.Fatalf("command unreadable: %v", err)
		}
		if m.Source == "failsafe" {
			t.Fatal("the takeover must never pass through the failsafe (blip)")
		}
	}
}

func TestTheFallbackNeverPreemptsAFreshPlanHolder(t *testing.T) {
	h := newConsumerHarness(t)
	h.arb.SubmitInternal(onOffDesire("rod-1", false, 120, h.clock))
	h.arb.SubmitInternal(fallbackDesire("rod-1", 60*time.Second, h.clock))
	cmd, ok := h.lastCommand("rod-1")
	if !ok {
		t.Fatal("command cleared")
	}
	if cmd["source"] != "plan" {
		t.Fatalf("the plan must keep holding, got %v", cmd["source"])
	}
	cmds := cmd["commands"].(map[string]any)
	if on, _ := cmds["on_off"].(bool); on {
		t.Fatal("the plan's OFF must stand - the fallback may not outrank a fresh plan")
	}
}

func TestAReactivePflichtregelOutranksTheFallback(t *testing.T) {
	h := newConsumerHarness(t)
	h.arb.SubmitInternal(fallbackDesire("wb-1", 60*time.Second, h.clock))
	// A must-run reactive rule (flow + override, rank 70) preempts.
	h.arb.Submit("wb-1", flowDesire("wb-1", "reaktiv", 11, 60, true, h.clock))
	cmd, ok := h.lastCommand("wb-1")
	if !ok {
		t.Fatal("command cleared")
	}
	if cmd["source"] != "desired" {
		t.Fatalf("override must hold, got %v", cmd["source"])
	}
	cmds := cmd["commands"].(map[string]any)
	if sp, _ := cmds["setpoint_kw"].(float64); sp != 11 {
		t.Fatalf("override setpoint = %v", sp)
	}

	// A PLAIN flow wish (rank 40) does NOT preempt a holding fallback.
	h2 := newConsumerHarness(t)
	h2.arb.SubmitInternal(fallbackDesire("wb-1", 60*time.Second, h2.clock))
	h2.arb.Submit("wb-1", flowDesire("wb-1", "opportunistisch", 3, 60, false, h2.clock))
	cmd, ok = h2.lastCommand("wb-1")
	if !ok {
		t.Fatal("command cleared")
	}
	cmds = cmd["commands"].(map[string]any)
	if on, _ := cmds["on_off"].(bool); !on {
		t.Fatal("the due deadline duty must outrank a plain opportunistic wish")
	}
}

func TestTheCycleGuardBindsOnTheFallbackWish(t *testing.T) {
	h := newConsumerHarness(t)
	// Exhaust the rod's min-off: command it on, then off (plan), then the
	// fallback wants it back on within the 60 s Mindestpause.
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 5, h.clock))
	h.clock = h.clock.Add(3 * time.Minute) // past min-on (120 s); desire expires
	h.arb.Tick()                           // falls to failsafe off -> min-off armed
	h.clock = h.clock.Add(10 * time.Second)
	h.arb.SubmitInternal(fallbackDesire("rod-1", 60*time.Second, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("the Mindestpause must hold the fallback's switch-on")
	}
	dec, ok := h.arb.DecisionFor("rod-1")
	if !ok || dec.Cycle == nil || dec.Cycle.Code != "guard_min_off" {
		t.Fatalf("the hold must name its honest reason: %+v", dec)
	}
	// After the pause the SAME renewed wish switches on.
	h.clock = h.clock.Add(2 * time.Minute)
	h.arb.SubmitInternal(fallbackDesire("rod-1", 60*time.Second, h.clock))
	if !h.onOffOf("rod-1") {
		t.Fatal("after the Mindestpause the fallback must run")
	}
	dec, _ = h.arb.DecisionFor("rod-1")
	if dec.HolderKind != string(SourceDeadlineFallback) {
		t.Fatalf("holder kind = %q", dec.HolderKind)
	}
	if dec.HolderOverride {
		t.Fatal("the fallback must NEVER carry the override elevation")
	}
}
