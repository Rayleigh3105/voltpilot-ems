package agent

// The edge-local deadline fallback, agent half (Verbrauchssteuerung
// Inkrement 6, D-20). Proves: with VP_CONSUMER_CONTROL_ENABLED off NOTHING
// happens (byte-identical); a due duty without a fresh plan self-starts
// through the arbitration chain and the heartbeat names flex_deadline_fallback;
// a fresh plan silences/preempts it seamlessly; unknown progress starts
// nothing; fulfilment (from confirmed telemetry) withdraws; and the confirmed
// progress survives a reboot (flexfallback.json).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flexfallback"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

// newFlexTestAgent builds an agent with the consumer master switch ON (the
// fallback's gate) and its own data dir.
func newFlexTestAgent(t *testing.T, dir string) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = dir
	cfg.ConsumerControlEnabled = true
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)
	return a
}

// windowAround renders a local Berlin window [now-before, now+after] as the
// contract's HH:MM strings. Crossing midnight is fine - the requirement's
// overnight semantics anchor it on the day of `from`.
func windowAround(now time.Time, before, after time.Duration) (string, string) {
	loc, _ := time.LoadLocation("Europe/Berlin")
	from := now.Add(-before).In(loc)
	to := now.Add(after).In(loc)
	return fmt.Sprintf("%02d:%02d", from.Hour(), from.Minute()),
		fmt.Sprintf("%02d:%02d", to.Hour(), to.Minute())
}

// flexRegistry builds a registry with ONE pump consumer carrying a deadline
// duty whose window covers now. runtimeMin sized by the caller: larger than
// the window = always past the latest start ("due"), tiny = not yet due.
func flexRegistry(now time.Time, runtimeMin float64) entities.Registry {
	from, to := windowAround(now, 2*time.Hour, 3*time.Hour)
	tr := true
	return entities.Registry{Revision: "rev-flex", Entities: []entities.Entity{
		{
			ID: "pump-1", Type: entities.TypeGenericLoad, Label: "Stallpumpe",
			Capabilities: entities.Capabilities{
				Measure: []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}},
				Actuate: []entities.ActuateCap{{Command: "on_off"}},
			},
			Guards: entities.Guards{
				Limits:   entities.GuardLimits{MaxConsumptionKw: f64p(2.2)},
				Failsafe: entities.Failsafe{Behavior: "off"},
			},
			FlexRequirements: []entities.FlexRequirement{{
				ID: "pump-daily", Timezone: "Europe/Berlin",
				Days: "daily", From: from, To: to,
				RuntimeMinutes: &runtimeMin, Contiguous: &tr,
				PowerKw: 2.2, Command: entities.CmdOnOff,
			}},
		},
	}}
}

// evidence marks the pump's own telemetry fresh (progress KNOWN) by feeding a
// sample through the real ingest hook.
func evidence(t *testing.T, a *Agent, kw float64) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "pump-1",
		"channels": map[string]float64{"power_kw": kw},
	})
	a.onEntityTelemetry("edge/entities/pump-1/telemetry", payload)
}

func TestFlagOffIsByteIdentical(t *testing.T) {
	a := newGateTestAgent(t) // ConsumerControlEnabled = false (the default)
	now := time.Now().UTC()
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(flexRegistry(now, 600))
	evidence(t, a, 0)
	a.runFlexFallback(now)
	if dec, ok := a.arb.DecisionFor("pump-1"); ok && dec.Source == "desired" {
		t.Fatalf("flag off must never emit a fallback wish: %+v", dec)
	}
	a.flexMu.Lock()
	reqs, track := a.flexReqs, a.flexTrack
	a.flexMu.Unlock()
	if len(reqs) != 0 || len(track) != 0 {
		t.Fatal("flag off must build no fallback state at all")
	}
	if _, err := os.Stat(filepath.Join(a.Cfg.DataDir, flexStateFile)); !os.IsNotExist(err) {
		t.Fatal("flag off must never write flexfallback.json")
	}
}

func TestDueDutySelfStartsAndAFreshPlanPreempts(t *testing.T) {
	a := newFlexTestAgent(t, t.TempDir())
	now := time.Now().UTC()
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(flexRegistry(now, 600)) // 10h demand in a 5h window: due
	evidence(t, a, 0)

	a.runFlexFallback(now)
	dec, ok := a.arb.DecisionFor("pump-1")
	if !ok || dec.HolderKind != "deadline-fallback" {
		t.Fatalf("the due duty must self-start: %+v (ok=%v)", dec, ok)
	}
	if dec.Granted.OnOff == nil || !*dec.Granted.OnOff {
		t.Fatalf("fallback must command on: %+v", dec.Granted)
	}
	if dec.HolderOverride {
		t.Fatal("the fallback must never be an override")
	}
	// The heartbeat names the run honestly.
	sum := a.consumersSummary()
	pump := sum["pump-1"]
	if pump.State != "running_optimized" || pump.ReasonCode != flexfallback.ReasonRun {
		t.Fatalf("heartbeat must report flex_deadline_fallback: %+v", pump)
	}

	// A fresh v2 plan arrives: the fallback withdraws and the plan's own
	// desire (already injected by the executors in the same pass) holds.
	a.arbMu.Lock()
	a.curPlan2 = &plan2.Plan{PlanID: "p-fresh", ReceivedAt: now, SlotMinutes: 15,
		Entities: []plan2.Entity{{ID: "pump-1"}}}
	a.arbMu.Unlock()
	a.runFlexFallback(now)
	if dec, ok := a.arb.DecisionFor("pump-1"); ok && dec.HolderKind == "deadline-fallback" {
		t.Fatalf("a fresh plan must silence the fallback: %+v", dec)
	}
	sum = a.consumersSummary()
	if r := sum["pump-1"].ReasonCode; r == flexfallback.ReasonRun {
		t.Fatal("the heartbeat must not keep claiming the fallback run")
	}
}

func TestUnknownProgressStartsNothing(t *testing.T) {
	a := newFlexTestAgent(t, t.TempDir())
	now := time.Now().UTC()
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(flexRegistry(now, 600))
	// NO telemetry evidence: the pump never reported - progress unknown.
	a.runFlexFallback(now)
	if dec, ok := a.arb.DecisionFor("pump-1"); ok && dec.HolderKind == "deadline-fallback" {
		t.Fatalf("unknown progress must never start (kein erfundener Lauf): %+v", dec)
	}
	a.flexMu.Lock()
	reason := a.flexLast["pump-1"]
	a.flexMu.Unlock()
	if reason != flexfallback.ReasonProgressUnknown {
		t.Fatalf("the refusal must name its reason, got %q", reason)
	}
}

func TestConfirmedFulfilmentWithdrawsTheWish(t *testing.T) {
	a := newFlexTestAgent(t, t.TempDir())
	now := time.Now().UTC()
	a.setEntityIdentity("t", "s", "d")
	// 1 minute demand in a 5h window - and it is DUE only because we make it
	// so via progress arithmetic below; use a big demand first to start.
	a.applyEntityRegistry(flexRegistry(now, 600))
	evidence(t, a, 0)
	a.runFlexFallback(now)
	if dec, ok := a.arb.DecisionFor("pump-1"); !ok || dec.HolderKind != "deadline-fallback" {
		t.Fatal("precondition: fallback must hold")
	}

	// Confirmed running samples fulfil the duty (600 min demand is too big to
	// fulfil in test time - swap the registry to a 2-min demand and accrue it).
	a.applyEntityRegistry(flexRegistry(now, 2))
	a.flexMu.Lock()
	inst, _ := a.flexReqs["pump-1"][0].CurrentInstance(now)
	a.flexTrack = map[string]map[string]*flexfallback.Tracker{
		"pump-1": {"pump-daily": {InstanceKey: inst.Key,
			Progress: flexfallback.Progress{RuntimeSeconds: 180}}},
	}
	a.flexMu.Unlock()
	evidence(t, a, 2.2)
	a.runFlexFallback(now)
	if dec, ok := a.arb.DecisionFor("pump-1"); ok && dec.HolderKind == "deadline-fallback" {
		t.Fatalf("a fulfilled duty must withdraw the wish: %+v", dec)
	}
	a.flexMu.Lock()
	reason := a.flexLast["pump-1"]
	a.flexMu.Unlock()
	if reason != flexfallback.ReasonFulfilled {
		t.Fatalf("expected fulfilled, got %q", reason)
	}
}

func TestConfirmedProgressSurvivesAReboot(t *testing.T) {
	dir := t.TempDir()
	a := newFlexTestAgent(t, dir)
	now := time.Now().UTC()
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(flexRegistry(now, 600))

	// Two confirmed samples one minute apart accrue 60 s of runtime.
	a.observeFlexProgress("pump-1", map[string]float64{"power_kw": 2.2}, now.Add(-time.Minute))
	a.observeFlexProgress("pump-1", map[string]float64{"power_kw": 2.2}, now)
	a.runFlexFallback(now) // first save (dirty, interval elapsed since zero)
	if _, err := os.Stat(filepath.Join(dir, flexStateFile)); err != nil {
		t.Fatalf("progress not persisted: %v", err)
	}
	a.Stop()

	b := newFlexTestAgent(t, dir)
	b.setEntityIdentity("t", "s", "d")
	b.applyEntityRegistry(flexRegistry(now, 600))
	inst, _ := b.flexReqs["pump-1"][0].CurrentInstance(now)
	p := b.flexProgressFor("pump-1", "pump-daily", inst.Key)
	if p.RuntimeSeconds < 59 || p.RuntimeSeconds > 61 {
		t.Fatalf("restored progress = %+v, want ~60 s", p)
	}
}
