package agent

// Die Schaltspur der Box (vp-schalten-3s) auf dem ECHTEN Pfad: onDesiredDownlink
// mit dem Umschlag der API, der lokale Bus mit dem Schiedsrichter, die echte
// consumerControlLoop gegen den Pro-3-Stub und der echte statusHeartbeatLoop.
// Der Herzschlag trägt die request_id des Portals mit den Zeitpunkten der Box
// zurück - auch dann, wenn eine Schutzregel den Wunsch hält und nichts
// geschrieben wird.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

func overrideWithRequestID(t *testing.T, entityID, requestID string, on bool) []byte {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(manualOnOffOverride(entityID, on), &env); err != nil {
		t.Fatal(err)
	}
	env["request_id"] = requestID
	raw, _ := json.Marshal(env)
	return raw
}

func traceIn(sent []cloud.ConsumersSummary, id, requestID string, from int, ok func(*cloud.ConsumerTrace) bool) *cloud.ConsumerTrace {
	for i := from; i < len(sent); i++ {
		if e, has := sent[i][id]; has && e.Trace != nil && e.Trace.RequestID == requestID && ok(e.Trace) {
			return e.Trace
		}
	}
	return nil
}

func parseTraceTime(t *testing.T, what, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatalf("%s %q: %v", what, s, err)
	}
	return at
}

type traceRig struct {
	a   *Agent
	dev *pro3Stage
	rec *consumerHeartbeatRecorder
}

func newTraceRig(t *testing.T, id string, minOff *float64) traceRig {
	t.Helper()
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	t.Cleanup(srv.Close)
	host, port := splitHostPort(t, srv.URL)
	reg := stageRodRegistry(id, host, port)
	if minOff != nil {
		reg.Entities[0].Guards.Limits.MinOffSeconds = minOff
	}
	arb := minimalArbiter(reg)
	bus, readbacks, done := stageBus(t, id)
	t.Cleanup(done)
	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	if err := a.Bus.Subscribe(desired.DesiredWildcard, desiredSubscriptionID, a.onEntityDesired); err != nil {
		t.Fatal(err)
	}
	if err := a.Bus.Subscribe(entities.TopicPrefix+"+/readback", readbackSubscriptionID, a.onEntityReadback); err != nil {
		t.Fatal(err)
	}
	rec := &consumerHeartbeatRecorder{sum: a.consumersSummary}
	ctx, cancel := context.WithCancel(context.Background())
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		statusHeartbeatLoop(ctx, statusHeartbeatEvery, statusKickMinGap, a.statusKick(), a.priorityStatusKick(), rec.publish)
	}()
	t.Cleanup(func() { cancel(); <-hbDone })
	runConsumerControlLoop(t, a)
	a.requestConsumerControlNow()
	waitFor(t, 3*time.Second, "the startup self-assert readback", func() bool { return len(readbacks()) > 0 })
	return traceRig{a: a, dev: dev, rec: rec}
}

func TestDerHerzschlagTraegtDieSchaltspurMitDenZeitpunktenDerBox(t *testing.T) {
	id := "rod-spur"
	r := newTraceRig(t, id, nil)
	_, seeded := r.rec.snapshot()
	spur := "override:" + id + ":3f6d7b1e-0000-4000-8000-000000000001"

	click := time.Now()
	r.a.onDesiredDownlink(overrideWithRequestID(t, id, spur, true))

	var tr *cloud.ConsumerTrace
	waitFor(t, 2*time.Second, "the heartbeat carries the trace with its read back", func() bool {
		_, sent := r.rec.snapshot()
		tr = traceIn(sent, id, spur, len(seeded), func(c *cloud.ConsumerTrace) bool { return c.ReadBackAt != "" })
		return tr != nil
	})
	if tr.Outcome != traceWritten {
		t.Fatalf("outcome = %q, want %q", tr.Outcome, traceWritten)
	}
	received := parseTraceTime(t, "received_at", tr.ReceivedAt)
	admitted := parseTraceTime(t, "admitted_at", tr.AdmittedAt)
	written := parseTraceTime(t, "written_at", tr.WrittenAt)
	readBack := parseTraceTime(t, "read_back_at", tr.ReadBackAt)
	if received.Before(click.Add(-time.Millisecond)) || admitted.Before(received) || written.Before(admitted) ||
		readBack.Before(written) {
		t.Fatalf("the steps must be in order: received %v admitted %v written %v read back %v",
			received, admitted, written, readBack)
	}
	t.Logf("Box: empfangen +0, entschieden +%v, geschrieben +%v, zurückgelesen +%v",
		admitted.Sub(received), written.Sub(received), readBack.Sub(received))
}

func TestEinGehaltenerWunschStehtAlsUrteilInDerSpurOhneGeraeteZeitpunkte(t *testing.T) {
	id := "rod-spur-guard"
	minOff := 600.0
	r := newTraceRig(t, id, &minOff)
	r.a.onDesiredDownlink(manualOnOffOverride(id, true))
	waitFor(t, 2*time.Second, "the rod ran once", func() bool { on, _ := r.dev.snapshot(); return on[0] })
	r.a.onDesiredDownlink(manualWithdraw(id))
	waitFor(t, 2*time.Second, "the rod stopped", func() bool {
		on, _ := r.dev.snapshot()
		return !on[0] && !on[1] && !on[2]
	})

	spur := "override:" + id + ":3f6d7b1e-0000-4000-8000-000000000002"
	r.a.onDesiredDownlink(overrideWithRequestID(t, id, spur, true))
	waitFor(t, 2*time.Second, "the trace names the hold", func() bool {
		tr := r.a.consumerTraceFor(id, time.Now())
		return tr != nil && tr.RequestID == spur && tr.Outcome == traceHeld
	})
	time.Sleep(300 * time.Millisecond) // the woken pass ran; nothing may have been written
	tr := r.a.consumerTraceFor(id, time.Now())
	if tr.ReasonCode != "guard_min_off" || tr.AdmittedAt == "" || tr.WrittenAt != "" {
		t.Fatalf("a held wish: reason guard_min_off, admitted, never written - got %+v", *tr)
	}
}

func TestDieRuecknahmeTraegtIhreSpurUndAlteSpurenVerfallen(t *testing.T) {
	a := &Agent{}
	now := time.Now()
	a.traceReceived("x", "override:x:1", now)
	a.traceAdmitted("x", "override:x:1", now.Add(time.Millisecond), traceWithdrawn, "")
	tr := a.consumerTraceFor("x", now.Add(time.Second))
	if tr == nil || tr.Outcome != traceWithdrawn || tr.AdmittedAt == "" {
		t.Fatalf("withdraw trace = %+v", tr)
	}
	// A foreign request id never stamps the open trace.
	a.traceReceived("y", "override:y:1", now)
	a.traceAdmitted("y", "override:y:2", now, "", "")
	if got := a.consumerTraceFor("y", now); got.AdmittedAt != "" {
		t.Fatalf("a foreign request id stamped the trace: %+v", got)
	}
	if a.consumerTraceFor("x", now.Add(consumerTraceWindow+time.Second)) != nil {
		t.Fatal("a trace older than consumerTraceWindow must leave the heartbeat")
	}
}

// vp-schalten-3s, Captain-Befund 27.11.2026: hält eine Schutzregel den
// Handeingriff (hier die Mindestpause), schreibt die Box nichts - und ihre
// Antwort darf trotzdem nicht auf den nächsten statusHeartbeatEvery warten,
// auch nicht, wenn gerade ein Herzschlag lief (statusKickMinGap).
func TestEinGehaltenerHandeingriffAntwortetSofortImHerzschlag(t *testing.T) {
	id := "rod-spur-sofort"
	minOff := 600.0
	r := newTraceRig(t, id, &minOff)
	r.a.onDesiredDownlink(manualOnOffOverride(id, true))
	waitFor(t, 2*time.Second, "the rod ran once", func() bool { on, _ := r.dev.snapshot(); return on[0] })
	r.a.onDesiredDownlink(manualWithdraw(id))
	waitFor(t, 2*time.Second, "the rod stopped", func() bool {
		on, _ := r.dev.snapshot()
		return !on[0] && !on[1] && !on[2]
	})
	// Frischer Herzschlag: statusKickMinGap stünde jeder normalen Anforderung im Weg.
	r.a.requestStatusHeartbeat()
	time.Sleep(100 * time.Millisecond)
	_, vorher := r.rec.snapshot()

	click := time.Now()
	r.a.onDesiredDownlink(manualOnOffOverride(id, true))
	var gehaltenAm time.Time
	waitFor(t, 3*time.Second, "the heartbeat names the hold", func() bool {
		at, sent := r.rec.snapshot()
		for i := len(vorher); i < len(sent); i++ {
			if e, ok := sent[i][id]; ok && e.ReasonCode == "guard_min_off" {
				gehaltenAm = at[i]
				return true
			}
		}
		return false
	})
	if d := gehaltenAm.Sub(click); d > 1500*time.Millisecond {
		t.Fatalf("die Antwort 'gehalten' kam erst nach %v - sie wartete offenbar auf den Takt", d)
	}
	if on, _ := r.dev.snapshot(); on[0] || on[1] || on[2] {
		t.Fatalf("die Mindestpause muss halten: %v", on)
	}
}

// Ein Handeingriff, dessen Stand schon anliegt (hier "Aus" an einem Stab, der
// schon aus ist), hat nichts zu schreiben - auch er antwortet sofort.
func TestEinHandeingriffOhneEtwasZuSchreibenAntwortetSofort(t *testing.T) {
	id := "rod-spur-schon-so"
	r := newTraceRig(t, id, nil)
	r.a.requestStatusHeartbeat()
	time.Sleep(100 * time.Millisecond)
	_, vorher := r.rec.snapshot()
	spur := "override:" + id + ":3f6d7b1e-0000-4000-8000-000000000003"

	click := time.Now()
	r.a.onDesiredDownlink(overrideWithRequestID(t, id, spur, false))
	var am time.Time
	waitFor(t, 3*time.Second, "the heartbeat answers the manual Aus", func() bool {
		at, sent := r.rec.snapshot()
		for i := len(vorher); i < len(sent); i++ {
			if e, ok := sent[i][id]; ok && e.Trace != nil && e.Trace.RequestID == spur && e.Trace.Outcome != "" {
				am = at[i]
				return true
			}
		}
		return false
	})
	if d := am.Sub(click); d > 1500*time.Millisecond {
		t.Fatalf("die Antwort kam erst nach %v", d)
	}
}
