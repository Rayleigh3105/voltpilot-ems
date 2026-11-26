package agent

// End-to-end reproduction for the SECOND round of vp-schalten-sofort
// (Captain-Befund auf #2035, 26.11.2026): "etwa eine Sekunde" von Klick bis
// bestätigtem Zustand im Portal-Datenweg. Treibt den ECHTEN Produktionspfad -
// onDesiredDownlink (wie die Cloud-Verbindung ihn aus dem MQTT-Umschlag der
// Portal-Überschreibung aufruft), die ECHTE consumerControlLoop mit ihrem
// Produktionstakt, den ECHTEN statusHeartbeatLoop mit statusHeartbeatEvery/
// statusKickMinGap - gegen den Pro-3-Stub.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// manualOnOffOverride is the exact envelope shape the cloud link hands
// onDesiredDownlink (ConsumerOverridePublisher's ems/.../v2/desired payload,
// Source local-ui + override + class flow = a manual intervention, D-6a).
func manualOnOffOverride(entityID string, on bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"entity_id":      entityID,
		"request_id":     fmt.Sprintf("override:%s:%d", entityID, time.Now().UnixNano()),
		"source":         map[string]any{"kind": "local-ui"},
		"priority":       "flow",
		"override":       true,
		"ttl_s":          7200,
		"issued_at":      time.Now().UTC().Format(time.RFC3339Nano),
		"command":        map[string]any{"type": "on_off", "value": on},
	})
	return raw
}

func manualWithdraw(entityID string) []byte {
	raw, _ := json.Marshal(map[string]any{"entity_id": entityID, "withdraw": true})
	return raw
}

// runConsumerControlLoop drives the REAL loop (production ticker) and stops
// it on cleanup - the test-local twin of startConsumerControl, without
// touching a.done (no shutdown path in this test needs it).
func runConsumerControlLoop(t *testing.T, a *Agent) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.consumerControlLoop(ctx)
	}()
	t.Cleanup(func() { cancel(); <-done })
}

// The reproduction: a manual override arrives exactly as the portal/API
// sends it. It must not wait out consumerControlTick before the box even
// tries the Shelly write (onEntityDesired wakes consumerControlLoop right
// after admitting it), and its own confirmation must not wait out
// statusKickMinGap even though a heartbeat just went out moments before
// (the one-shot exemption, consumer_override_now.go). Target: click ->
// confirmed heartbeat typically <= 1.5 s.
func TestManualOverrideWakesTheControlLoopAndSkipsStatusKickMinGap(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-sofort-2"
	reg := stageRodRegistry(id, host, port)
	arb := minimalArbiter(reg)

	bus, readbacks, done := stageBus(t, id)
	defer done()

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	if err := a.Bus.Subscribe(desired.DesiredWildcard, desiredSubscriptionID, a.onEntityDesired); err != nil {
		t.Fatal(err)
	}
	if err := a.Bus.Subscribe(entities.TopicPrefix+"+/readback", readbackSubscriptionID, a.onEntityReadback); err != nil {
		t.Fatal(err)
	}

	rec := &consumerHeartbeatRecorder{sum: a.consumersSummary}
	hbCtx, hbCancel := context.WithCancel(context.Background())
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		statusHeartbeatLoop(hbCtx, statusHeartbeatEvery, statusKickMinGap, a.statusKick(), a.priorityStatusKick(), rec.publish)
	}()
	t.Cleanup(func() { hbCancel(); <-hbDone })

	runConsumerControlLoop(t, a)

	// A box's own startup self-assert (no decision yet, fail-safe off) seeds
	// the fingerprint baseline before the real test begins - the production
	// ticker is too slow to wait out in a unit test, so wake it once by hand,
	// exactly like a real box's very first pass after boot.
	a.requestConsumerControlNow()
	waitFor(t, 3*time.Second, "the startup self-assert readback", func() bool { return len(readbacks()) > 0 })

	// Recent, unrelated heartbeat traffic: a fresh send puts statusKickMinGap
	// fully in the way of anything that is NOT exempt from it.
	a.requestStatusHeartbeat()
	waitFor(t, 1*time.Second, "the seed heartbeat went out", func() bool {
		at, _ := rec.snapshot()
		return len(at) >= 1
	})
	seeded, _ := rec.snapshot()
	fromIdx := len(seeded)

	// The click.
	click := time.Now()
	a.onDesiredDownlink(manualOnOffOverride(id, true))

	waitFor(t, 2*time.Second, "the heartbeat confirms all 3 outputs on", func() bool {
		at, sent := rec.snapshot()
		return !confirmedStageAt(at, sent, id, 3, fromIdx).IsZero()
	})
	at, sent := rec.snapshot()
	confirmedAt := confirmedStageAt(at, sent, id, 3, fromIdx)
	latency := confirmedAt.Sub(click)
	t.Logf("Handeingriff-Klick -> bestätigter Herzschlag: %v", latency)
	if latency > 1500*time.Millisecond {
		t.Fatalf("Klick bis Bestätigung dauerte %v, Ziel <= 1.5 s", latency)
	}
	if latency >= statusKickMinGap {
		t.Fatalf("die Bestätigung wartete offenbar statusKickMinGap (%v) aus: %v", statusKickMinGap, latency)
	}

	// "Automatik fortsetzen" is a Handeingriff too, and the confirmation above
	// already left a FRESH "last send" behind - statusKickMinGap is still
	// fully in the way for anything that is not exempt, no second seed needed.
	fromIdx2 := len(sent)

	resume := time.Now()
	a.onDesiredDownlink(manualWithdraw(id))
	waitFor(t, 2*time.Second, "the heartbeat confirms the stage fell back to off", func() bool {
		at, sent := rec.snapshot()
		return !confirmedStageAt(at, sent, id, 0, fromIdx2).IsZero()
	})
	at2, sent2 := rec.snapshot()
	resumedAt := confirmedStageAt(at2, sent2, id, 0, fromIdx2)
	resumeLatency := resumedAt.Sub(resume)
	t.Logf("Automatik fortsetzen -> bestätigter Herzschlag: %v", resumeLatency)
	if resumeLatency > 1500*time.Millisecond {
		t.Fatalf("Automatik-fortsetzen-Bestätigung dauerte %v, Ziel <= 1.5 s", resumeLatency)
	}
}

// A guard that holds must still hold: the immediate wake only reads and
// reports the already-arbitrated decision sooner, it never bypasses the
// cycle guard. A restart wish during the Mindestpause is rejected honestly,
// and the box stays off; "sofort ehrlich ablehnen" shows up as the heartbeat
// saying so within the same tight bound, not as the stab switching on.
func TestManualOverrideWakeNeverBypassesTheCycleGuard(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-sofort-guard"
	reg := stageRodRegistry(id, host, port)
	minOff := 600.0
	reg.Entities[0].Guards.Limits.MinOffSeconds = &minOff
	arb := minimalArbiter(reg)

	bus, readbacks, done := stageBus(t, id)
	defer done()
	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	if err := a.Bus.Subscribe(desired.DesiredWildcard, desiredSubscriptionID, a.onEntityDesired); err != nil {
		t.Fatal(err)
	}
	if err := a.Bus.Subscribe(entities.TopicPrefix+"+/readback", readbackSubscriptionID, a.onEntityReadback); err != nil {
		t.Fatal(err)
	}
	runConsumerControlLoop(t, a)

	// Run once, then stop: the Mindestpause clock starts now.
	a.onDesiredDownlink(manualOnOffOverride(id, true))
	waitFor(t, 2*time.Second, "the rod ran once", func() bool { return len(readbacks()) > 0 })
	a.onDesiredDownlink(manualWithdraw(id))
	waitFor(t, 2*time.Second, "the rod stopped", func() bool {
		on, _ := dev.snapshot()
		return !on[0] && !on[1] && !on[2]
	})

	// Immediately ask to restart: the cycle guard's min-off must hold it,
	// guard logic unchanged by the wake.
	before, _ := dev.snapshot()
	a.onDesiredDownlink(manualOnOffOverride(id, true))
	waitFor(t, 2*time.Second, "the arbiter recorded the held restart", func() bool {
		dec, ok := a.arb.DecisionFor(id)
		return ok && dec.Cycle != nil
	})
	dec, _ := a.arb.DecisionFor(id)
	if dec.Cycle == nil {
		t.Fatalf("expected the min-off cycle guard to hold the restart")
	}
	// Give the woken pass every chance to run, then confirm nothing switched on.
	time.Sleep(200 * time.Millisecond)
	after, _ := dev.snapshot()
	if after != before {
		t.Fatalf("the held restart must never reach the device: before=%v after=%v", before, after)
	}
	hb := a.consumersSummary()[id]
	if hb.State != consumerStateWaiting || hb.ReasonCode != dec.Cycle.Code {
		t.Fatalf("the heartbeat must name the hold honestly, got state=%q reason=%q", hb.State, hb.ReasonCode)
	}
}
