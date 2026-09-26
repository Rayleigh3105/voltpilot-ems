package agent

// Native self-regulation on an EEG plant, driven through the REAL sequence the
// Deye executor answers with (K3, concept §2.3 "EEG-Beleg vor Übergabe").
//
// The tests next door start from a device that already confirmed its own mode.
// That skips the one sequence an EEG plant has to survive: the hand-over is
// requested by the core's intent, the executor reads the device's own
// grid-charge configuration BEFORE it lets go (deyeNativePrecondition), and only
// the tick after that is native. If the core demanded the in-mode proof before
// it even published the intent, the intent never reached the wire, the device
// never went native, and the proof could never exist - the mode was dead on
// every EEG plant.
//
// The readbacks are fed as the JSON Layer 1 publishes on edge/control/readback
// (onControlReadback), so the wire contract is part of what is proven here.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// eegNativeAgent is nativeAgent on an EEG plant: the plan forbids grid charging.
func eegNativeAgent(t *testing.T) (*Agent, string) {
	t.Helper()
	a, addr := nativeAgent(t)
	no := false
	a.mu.Lock()
	a.currentPlan.GridChargeAllowed = &no
	a.mu.Unlock()
	return a, addr
}

// deyeCycle is one Layer-1 readback as the Deye executor publishes it.
// mode "normal" = the follower carried the cycle, "native" = 1100 read back 0.
// precondition / inMode are the two places the device's grid-charge answer can
// ride: read BEFORE the hand-over (native_precondition) or read back IN the
// device's own mode (native). nil leaves the block out - "the device did not say".
func deyeCycle(at time.Time, mode string, precondition, inMode *bool) []byte {
	m := map[string]any{
		"ts": at.Format(time.RFC3339), "family": "hybrid_3p", "source": "plan",
		"mode": mode, "all_match": true, "control_path": "remote",
		"registers": []map[string]any{{"role": "remote_mode", "match": true}},
	}
	if precondition != nil {
		m["native_precondition"] = map[string]any{"grid_charge_blocked": *precondition}
	}
	if inMode != nil {
		m["native"] = map[string]any{"grid_charge_blocked": *inMode}
	}
	b, _ := json.Marshal(m)
	return b
}

// eegTick refreshes the reading (the Pilsting night values nativeTick uses),
// delivers Layer 1's readback of the PREVIOUS cycle and runs one setpoint tick.
func eegTick(a *Agent, at time.Time, readback []byte) {
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 77, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = at
	a.mu.Unlock()
	a.onControlReadback("", readback)
	a.applySetpoint(at)
}

// THE HENNE-EI SEQUENCE: erst normal, dann nativ.
func TestOnAnEegPlantTheIntentReachesTheDeviceBeforeItsProofExists(t *testing.T) {
	a, addr := eegNativeAgent(t)
	sub := subscribeSetpoint(t, addr)
	t0 := nativeSlotStart.Add(time.Minute)

	// Tick 1: the plant arrives on the ordinary follower. Nobody has asked the
	// device anything yet, so there is no grid-charge statement at all. The
	// intent must still go out - it is what makes the executor ASK.
	eegTick(a, t0, deyeCycle(t0, "normal", nil, nil))
	if n := nativeOf(a); n == nil || !n.Active || n.Proven {
		t.Fatalf("tick 1: the intent must stand as PENDING before any proof can exist: %+v", n)
	}
	waitFor(t, 5*time.Second, "the native intent on the wire", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_mode"] == batteryModeNative
	})

	// Tick 2: the executor read the device's own Program-1 charging (0x00AC)
	// BEFORE any hand-over and found it Disabled. No hand-over yet (the follower
	// carried that cycle), so the mode is still only pending.
	t1 := t0.Add(10 * time.Second)
	eegTick(a, t1, deyeCycle(t1, "normal", boolPtr(true), nil))
	if n := nativeOf(a); n == nil || !n.Active || n.Proven {
		t.Fatalf("tick 2: a pre-hand-over proof keeps the intent pending: %+v", n)
	}
	if got := executionSummary(a.State.Get()); got != nil && got.Mode == execModeAutonomousDischarge {
		t.Fatalf("tick 2: nothing is autonomous before the device confirmed it: %+v", got)
	}

	// Tick 3: the hand-over landed (1100 == 0) and the device repeats, in its own
	// mode, that it cannot charge from the grid. Only now is the mode proven.
	t2 := t1.Add(10 * time.Second)
	eegTick(a, t2, deyeCycle(t2, "native", boolPtr(true), boolPtr(true)))
	n := nativeOf(a)
	if n == nil || !n.Proven {
		t.Fatalf("tick 3: the device proved both the mode and the ban: %+v", n)
	}
	if got := executionSummary(a.State.Get()); got == nil || got.Mode != execModeAutonomousDischarge {
		t.Fatalf("tick 3: a proven mode is reported as autonomous_discharge: %+v", got)
	}
}

// mustBePending asserts the starting point of every case below: the intent
// stands, unproven. Without it a case that never engaged would "take back"
// nothing and pass for the wrong reason.
func mustBePending(t *testing.T, a *Agent) {
	t.Helper()
	if n := nativeOf(a); n == nil || !n.Active || n.Proven {
		t.Fatalf("setup: the intent must stand as PENDING first: %+v", n)
	}
}

// The EEG rule itself is NOT relaxed: every answer that is not a proof still
// takes the battery back, and the take-back holds for the rest of the slot.
func TestOnAnEegPlantEveryAnswerThatIsNoProofTakesTheBatteryBack(t *testing.T) {
	t.Run("the device says BEFORE the hand-over that it may charge from the grid", func(t *testing.T) {
		a, addr := eegNativeAgent(t)
		sub := subscribeSetpoint(t, addr)
		t0 := nativeSlotStart.Add(time.Minute)
		eegTick(a, t0, deyeCycle(t0, "normal", nil, nil))
		mustBePending(t, a)

		t1 := t0.Add(10 * time.Second)
		eegTick(a, t1, deyeCycle(t1, "normal", boolPtr(false), nil))
		if n := nativeOf(a); n != nil {
			t.Fatalf("a device that may grid-charge must never be handed over: %+v", n)
		}
		waitFor(t, 5*time.Second, "the setpoint mode on the wire", func() bool {
			m, ok := sub.latest()
			return ok && m["battery_mode"] == batteryModeSetpoint
		})
		// Latched for the slot: even a later claim does not re-open it.
		t2 := t1.Add(10 * time.Second)
		eegTick(a, t2, deyeCycle(t2, "native", boolPtr(true), boolPtr(true)))
		if n := nativeOf(a); n != nil {
			t.Fatalf("the take-back holds for the rest of the slot: %+v", n)
		}
	})

	t.Run("the device is in its own mode but does not repeat the proof", func(t *testing.T) {
		a, _ := eegNativeAgent(t)
		t0 := nativeSlotStart.Add(time.Minute)
		eegTick(a, t0, deyeCycle(t0, "normal", nil, nil))
		mustBePending(t, a)
		// A proof read BEFORE the hand-over does not stand in for one read in
		// the device's own mode: once it regulates itself, it must say so itself.
		t1 := t0.Add(10 * time.Second)
		eegTick(a, t1, deyeCycle(t1, "native", boolPtr(true), nil))
		if n := nativeOf(a); n != nil {
			t.Fatalf("a native mode without its own proof is taken back: %+v", n)
		}
	})

	t.Run("the device says in its own mode that it may charge from the grid", func(t *testing.T) {
		a, _ := eegNativeAgent(t)
		t0 := nativeSlotStart.Add(time.Minute)
		eegTick(a, t0, deyeCycle(t0, "normal", nil, nil))
		mustBePending(t, a)
		t1 := t0.Add(10 * time.Second)
		eegTick(a, t1, deyeCycle(t1, "native", boolPtr(true), boolPtr(false)))
		if n := nativeOf(a); n != nil {
			t.Fatalf("a native mode whose device may grid-charge is taken back: %+v", n)
		}
	})

	t.Run("the device never answers within the grace", func(t *testing.T) {
		a, _ := eegNativeAgent(t)
		t0 := nativeSlotStart.Add(time.Minute)
		eegTick(a, t0, deyeCycle(t0, "normal", nil, nil))
		mustBePending(t, a)
		late := t0.Add(a.nativeProofGrace() + time.Second)
		eegTick(a, late, deyeCycle(late, "normal", nil, nil))
		if n := nativeOf(a); n != nil {
			t.Fatalf("an EEG intent the device never answered is withdrawn: %+v", n)
		}
	})
}
