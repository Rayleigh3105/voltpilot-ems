package agent

import (
	"encoding/json"
	"strings"
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

	// Layer 1 proves the candidate on a cycle of this source - the executor's
	// hand-over readback as it arrives through the palette (contract vectors).
	a.onControlReadback("", readbackVector(t, "f11_pilot_takt2_uebergabe", now, nil))
	// A real Deye sample carries the battery power (without it there is no
	// sample - the stale-telemetry clock keeps running).
	tel, _ := json.Marshal(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano),
		"pv_power_kw": 45.0, "power_kw": -0.2, "battery_power_kw": 20.0, "load_kw": 6.0, "soc_pct": 52.0})
	a.onLocalTelemetry("", tel)
	got := a.NativePilotSnapshot()
	if got.Run == nil || !got.Run.Proven || got.Run.Metrics.WriteCycles != 1 || got.Run.Metrics.Samples < 1 {
		t.Fatalf("the proof and the sample feed the run: %+v", got.Run)
	}
	if ci := a.State.Get().Control; ci == nil || ci.Mode != "native" || !ci.NativeCurtailsOwnPv ||
		ci.NativeCandidate != "grid_zero" || !ci.Wrote || ci.NativeCapabilities == nil {
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
	if _, err := a.NativePilotStart(nativepilot.Request{Candidate: "grid_zero", Intent: "surplus_charge"}); err != nil {
		t.Fatal(err)
	}
	a.onControlReadback("", readbackVector(t, "f11_pilot_takt1_konfiguration_lesen", now, nil))
	got := a.NativePilotSnapshot()
	if got.Run == nil || !strings.Contains(got.Run.Refusal, "eigene Konfiguration") || got.Run.Proven ||
		got.Run.Readbacks != 1 || got.Run.LastMode != "normal" {
		t.Fatalf("refusal: %+v", got.Run)
	}
	// A cycle of ANOTHER source proves nothing about the run.
	a.onControlReadback("", readbackVector(t, "f11_pilot_takt2_uebergabe", now, map[string]any{"source": "schedule"}))
	if got := a.NativePilotSnapshot(); got.Run.Proven || got.Run.Readbacks != 1 {
		t.Fatalf("a foreign cycle is no proof: %+v", got.Run)
	}
}

// f11Replay drives the Herzogau F11 run of 29.09.2026 through the REAL
// readback path: Layer 1's readbacks every 10 s (tick 1 reads the device
// configuration, tick 2 hands over, then the heartbeat) and the telemetry of
// 12:01 (export 10.57 kW, from +20 s 14.12 kW charging at 3.81 kW import).
// `shaped` maps a contract-vector case to what the core receives.
func f11Replay(t *testing.T, shaped func(name string, at time.Time) []byte) *nativepilot.RunView {
	t.Helper()
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	floor := 5.0
	a.mu.Lock()
	a.currentPlan.EffectiveFloorSocPct = &floor
	a.mu.Unlock()
	v, err := a.NativePilotStart(nativepilot.Request{Candidate: "grid_zero", Intent: "surplus_charge", Case: "F11", Minutes: 15})
	if err != nil || v.Run == nil {
		t.Fatalf("start: %v", err)
	}
	t0 := v.Run.StartedAt
	ticks := map[int]string{1: "f11_pilot_takt1_konfiguration_lesen", 11: "f11_pilot_takt2_uebergabe"}
	for s := 21; s <= 81; s += 10 {
		ticks[s] = "f11_pilot_takt3_herzschlag"
	}
	for s := 0; s <= 90; s++ {
		at := t0.Add(time.Duration(s)*time.Second + 500*time.Millisecond)
		if name, ok := ticks[s]; ok {
			a.onControlReadback("", shaped(name, at))
		}
		if s%5 == 0 {
			grid, batt := -10.57, 0.01
			if s >= 20 {
				grid, batt = 3.81, 14.12
			}
			raw, _ := json.Marshal(map[string]any{"ts": at.Format(time.RFC3339Nano),
				"pv_power_kw": 48.0, "power_kw": grid, "battery_power_kw": batt, "load_kw": 37.4, "soc_pct": 19.0})
			a.onLocalTelemetry("", raw)
			a.mu.Lock()
			a.lastReadingAt = at
			a.mu.Unlock()
		}
		if s%10 == 9 {
			a.applySetpoint(at) // the clock-driven checks: deadline, stale, proof grace
		}
	}
	return a.NativePilotSnapshot().Run
}

// With the palette forwarding the proof, the F11 run is proven on the
// hand-over tick and counts its write cycles - and then the supervision takes
// the 29.09. physics back (charging from the grid), instead of the old
// "nicht übernommen" after 60 s with 0 write cycles.
func TestNativePilotF11ProvenThroughThePalette(t *testing.T) {
	r := f11Replay(t, func(name string, at time.Time) []byte { return readbackVector(t, name, at, nil) })
	if !r.Proven || r.Metrics.ProvenAfterS == nil || *r.Metrics.ProvenAfterS > 12 || r.Metrics.WriteCycles < 1 {
		t.Fatalf("proven on tick 2 with write cycles: %+v", r)
	}
	t.Logf("proven after %.1f s, %d write cycles, end %+v", *r.Metrics.ProvenAfterS, r.Metrics.WriteCycles, r.End)
	if r.End == nil || r.End.Code != nativepilot.TakeBackGridLoad {
		t.Fatalf("the 29.09. physics ends in the take-back: %+v", r.End)
	}
	if r.Readbacks != 9 || r.LastMode != "native" {
		t.Fatalf("readbacks %d, last mode %q", r.Readbacks, r.LastMode)
	}
}

// The 29.09. failure itself (the proof fields dropped on the way): the end
// no longer blames the inverter - its registers held - but says what arrived.
func TestNativePilotWithoutProofNamesWhatArrived(t *testing.T) {
	r := f11Replay(t, func(name string, at time.Time) []byte {
		return readbackVector(t, name, at, map[string]any{"mode": "normal", "wrote": nil,
			"native": nil, "native_refusal": nil, "native_precondition": nil, "native_capabilities": nil})
	})
	if r.Proven || r.End == nil || r.End.Code != nativepilot.AbortUnproven || r.Metrics.WriteCycles != 0 {
		t.Fatalf("as on 29.09.: nicht_uebernommen, 0 write cycles: %+v", r)
	}
	if strings.Contains(r.End.Text, "Der Wechselrichter hat den Kandidaten nicht übernommen") ||
		!strings.Contains(r.End.Text, "7 Rückmeldungen") || !strings.Contains(r.End.Text, "„normal“") {
		t.Fatalf("the sentence names what arrived, not the inverter: %q", r.End.Text)
	}
	if r.Readbacks != 7 || r.LastMode != "normal" {
		t.Fatalf("readbacks %d, last mode %q", r.Readbacks, r.LastMode)
	}
}
