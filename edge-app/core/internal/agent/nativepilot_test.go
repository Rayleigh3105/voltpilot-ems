package agent

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/nativepilot"
)

// K5 Pilotfenster der Deye-Ladeseite, durch den ECHTEN Sollwert-, Telemetrie-
// und Rueckmeldepfad: ohne Lauf kein Feld; armiert traegt der Sollwert den
// Kandidaten (native_window, grid_charge_allowed=false); der Beleg des Geraets
// speist den Lauf; nach dem Abbruch uebernimmt der Plan.
func TestNativePilotPublishesTheCandidateAndEndsIntoThePlan(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	floor := 20.0
	a.mu.Lock()
	a.currentPlan.EffectiveFloorSocPct = &floor
	a.mu.Unlock()
	sub := subscribeSetpoint(t, addr)

	a.applySetpoint(now)
	waitFor(t, 3*time.Second, "plan setpoint", func() bool { m, ok := sub.latest(); return ok && m["source"] != nil })
	if m, _ := sub.latest(); m["native_pilot"] != nil {
		t.Fatalf("without an armed run the setpoint carries no pilot: %v", m)
	}

	v, err := a.NativePilotStart(nativepilot.Request{Candidate: "grid_zero", Intent: "surplus_charge", Case: "F11", Minutes: 5})
	if err != nil || v.Run == nil || !v.Run.Active {
		t.Fatalf("start: %v %+v", err, v)
	}
	if _, err := a.NativePilotStart(nativepilot.Request{Candidate: "own_config"}); err == nil {
		t.Fatal("one run at a time")
	}
	a.applySetpoint(now)
	waitFor(t, 3*time.Second, "pilot setpoint", func() bool { m, ok := sub.latest(); return ok && m["native_pilot"] != nil })
	m, _ := sub.latest()
	pilot, _ := m["native_pilot"].(map[string]any)
	if m["source"] != nativePilotSource || m["battery_mode"] != "native_window" ||
		m["battery_native_intent"] != "surplus_charge" || m["grid_charge_allowed"] != false ||
		m["battery_window_min_kw"] != 0.0 || m["battery_window_max_kw"] != 30.0 ||
		pilot["candidate"] != "grid_zero" || pilot["intent"] != "surplus_charge" || pilot["run"] != v.Run.ID {
		t.Fatalf("pilot setpoint: %v", m)
	}

	// Layer 1 proves the candidate on a cycle of this source.
	rb, _ := json.Marshal(map[string]any{
		"ts": now.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": nativePilotSource,
		"mode": "native", "all_match": true, "control_path": "remote", "wrote": true,
		"native":    map[string]any{"intent": "surplus_charge", "candidate": "grid_zero", "grid_charge_blocked": true, "curtails_own_pv": true},
		"registers": []map[string]any{{"role": "remote_mode", "match": true}},
	})
	a.onControlReadback("", rb)
	// A real Deye sample carries the battery power (without it there is no
	// sample - the stale-telemetry clock keeps running).
	tel, _ := json.Marshal(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano),
		"pv_power_kw": 45.0, "power_kw": -0.2, "battery_power_kw": 20.0, "load_kw": 6.0, "soc_pct": 52.0})
	a.onLocalTelemetry("", tel)
	got := a.NativePilotSnapshot()
	if got.Run == nil || !got.Run.Proven || got.Run.Metrics.WriteCycles != 1 || got.Run.Metrics.Samples < 1 {
		t.Fatalf("the proof and the sample feed the run: %+v", got.Run)
	}
	if ci := a.State.Get().Control; ci == nil || !ci.NativeCurtailsOwnPv || ci.NativeCandidate != "grid_zero" || !ci.Wrote {
		t.Fatalf("the readback fields are parsed: %+v", ci)
	}

	// The operator ends it: the plan takes over on the next tick.
	end := a.NativePilotAbort()
	if end.Run == nil || end.Run.Active || end.Run.End == nil || end.Run.End.Code != nativepilot.EndOperator {
		t.Fatalf("abort: %+v", end.Run)
	}
	a.applySetpoint(now.Add(time.Second))
	waitFor(t, 3*time.Second, "plan again", func() bool { m, ok := sub.latest(); return ok && m["native_pilot"] == nil })
	if m, _ := sub.latest(); m["source"] == nativePilotSource {
		t.Fatalf("after the run the plan publishes: %v", m)
	}
}

// A Layer-1 refusal is carried into the run and names why nothing moved.
func TestNativePilotCarriesTheLayer1Refusal(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	floor := 20.0
	a.mu.Lock()
	a.currentPlan.EffectiveFloorSocPct = &floor
	a.mu.Unlock()
	if _, err := a.NativePilotStart(nativepilot.Request{Candidate: "own_config", Intent: "self_consumption"}); err != nil {
		t.Fatal(err)
	}
	rb, _ := json.Marshal(map[string]any{
		"ts": now.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": nativePilotSource,
		"mode": "normal", "all_match": true, "control_path": "remote",
		"native_refusal": "Arbeitsmodus „Selling First“ mit aktivem Zeitfenster-Programm",
		"registers":      []map[string]any{{"role": "battery_power", "match": true}},
	})
	a.onControlReadback("", rb)
	if got := a.NativePilotSnapshot(); got.Run == nil || got.Run.Refusal == "" || got.Run.Proven {
		t.Fatalf("refusal: %+v", got.Run)
	}
	// A cycle of ANOTHER source proves nothing about the run.
	rb2, _ := json.Marshal(map[string]any{
		"ts": now.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": "schedule",
		"mode": "native", "all_match": true, "native": map[string]any{"intent": "self_consumption", "grid_charge_blocked": true},
		"registers": []map[string]any{{"role": "remote_mode", "match": true}},
	})
	a.onControlReadback("", rb2)
	if got := a.NativePilotSnapshot(); got.Run.Proven {
		t.Fatal("a foreign cycle is no proof")
	}
}
