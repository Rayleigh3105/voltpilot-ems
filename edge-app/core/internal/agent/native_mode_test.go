package agent

// Native self-regulation, end to end through applySetpoint - the CORE half of
// the Selbstregel-Modus (guards/nativemode.go).
//
// What these tests are for: `battery_mode` is what tells Layer 1 to keep its
// hands off the setpoint register, and the whole safety argument of the mode is
// that we can TAKE THE BATTERY BACK. So the questions answered here are the four
// a reviewer must be able to check without a device:
//
//  1. does an ordinary plant - one whose Layer 1 has no certificate, i.e. every
//     plant shipped today - behave byte-for-byte as before?
//  2. does the intent only appear on a covering slot, with every fact present,
//     and does it reach the WIRE where Layer 1 reads it?
//  3. does each supervision condition of the design really take it back, and
//     stay taken back for the rest of that slot?
//  4. does the heartbeat only claim "autonomous_discharge" once the DEVICE has
//     confirmed it - never because we merely stopped writing?
//
// ⚠ The verdict is read from the SNAPSHOT, which applySetpoint updates
// synchronously; the retained bus message is asserted where the point IS the
// wire. Polling the subscriber for a value the tick already decided would be a
// race, not a check.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// nativeSlotStart is the ONE covering slot every case below runs inside: the
// take-back is latched per SLOT, so a test that silently moved into the next
// slot would prove the opposite of what it claims.
var nativeSlotStart = time.Date(2026, 8, 26, 21, 15, 0, 0, time.UTC)

func nativeAgent(t *testing.T) (*Agent, string) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw = 30
	cfg.MaxDischargeKw = 30
	// The core's own write gate. Layer 1's capability catalog stays the real
	// gate for the mode; this only opens the door the core is allowed to open.
	cfg.ControlEnabled = true
	cfg.ControlCertifiedFamilies = []string{"sunspec"}
	a, addr := startBusOnlyAgent(t, cfg)
	a.invMu.Lock()
	a.inv = &inverter.Selection{Family: "sunspec"}
	a.invMu.Unlock()
	// A FRESH covering slot: the plan discharges and the cloud marked its grid
	// exchange ~ 0 (cover_load_from_battery), plus the reserve stack this mode
	// is required to supervise.
	yes, floor := true, 20.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes:          15,
		ReceivedAt:           nativeSlotStart,
		GeneratedAt:          nativeSlotStart,
		GridChargeAllowed:    &yes,
		EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start:                nativeSlotStart,
			BatterySetpointKw:    -4.3,
			CoverLoadFromBattery: true,
		}},
	}
	a.mu.Unlock()
	return a, addr
}

// nativeTick refreshes the two observation channels at `at` - the Pilsting night
// reading (house 7.117 kW, PV 0.03 kW, SoC 77 %) and a healthy control readback
// - and runs one setpoint tick. `confirmedNative` is Layer 1's answer: whether
// it really executed the native primitive on the previous cycle.
// `after` runs AFTER the refresh and BEFORE the tick - a supervision condition
// that lives in a reading would otherwise be overwritten by the refresh itself.
func nativeTick(a *Agent, at time.Time, confirmedNative bool, gridChargeBlocked *bool, after ...func(*Agent, time.Time)) {
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 77, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = at
	a.mu.Unlock()
	mode := "normal"
	if confirmedNative {
		mode = batteryModeNative
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{
			AllMatch: true, Confirm: "held", CheckedAt: at,
			Mode: mode, NativeGridChargeBlocked: gridChargeBlocked,
		}
	})
	for _, f := range after {
		if f != nil {
			f(a, at)
		}
	}
	a.applySetpoint(at)
}

func nativeOf(a *Agent) *state.NativeInfo { return a.State.Get().Native }

// (1) THE COMPATIBILITY PROMISE. Every plant shipped today runs a Layer 1 whose
// certificate catalog is empty, so it can never confirm the mode - and the core
// must then publish exactly what it published before the feature existed.
func TestAPlantWhoseLayer1CannotGoNativeIsUnchanged(t *testing.T) {
	a, addr := nativeAgent(t)
	sub := subscribeSetpoint(t, addr)
	now := nativeSlotStart.Add(time.Minute)

	// Tick 1: the intent goes out and the executor is asked to try.
	nativeTick(a, now, false, nil)
	if n := nativeOf(a); n == nil || !n.Active || n.Proven {
		t.Fatalf("the intent must stand as PENDING while the grace is open: %+v", n)
	}

	// Layer 1 keeps answering "normal" (no certificate). Past the grace the core
	// takes the battery back and stays on the proven follower.
	late := now.Add(a.nativeProofGrace() + time.Second)
	nativeTick(a, late, false, nil)
	if n := nativeOf(a); n != nil {
		t.Fatalf("an unconfirmed intent must be withdrawn: %+v", n)
	}

	waitFor(t, 5*time.Second, "the setpoint mode on the wire", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_mode"] == batteryModeSetpoint
	})
	m, _ := sub.latest()
	// The published value is the follower's, i.e. exactly what a pre-feature
	// core would have published for this reading (grid -> 0 => -7.087 kW).
	if got := m["battery_setpoint_kw"].(float64); got > -7.086 || got < -7.088 {
		t.Fatalf("the follower must carry the slot unchanged, got %v", got)
	}
	if got := executionSummary(a.State.Get()); got == nil || got.Mode == execModeAutonomousDischarge {
		t.Fatalf("the heartbeat must never claim an unconfirmed mode: %+v", got)
	}
}

// (2) The mode engages only on a covering slot, once the device confirms it -
// and the intent has to reach the WIRE, because that is the only thing Layer 1
// can read.
func TestAConfirmedCoveringSlotHandsTheSetpointToTheInverter(t *testing.T) {
	a, addr := nativeAgent(t)
	sub := subscribeSetpoint(t, addr)
	now := nativeSlotStart.Add(time.Minute)

	nativeTick(a, now, true, nil)
	n := nativeOf(a)
	if n == nil || !n.Active || !n.Proven || n.Text == "" {
		t.Fatalf("the snapshot must carry the proven mode with its sentence: %+v", n)
	}
	if n.Duty != guards.NativeDutyCoverLoad {
		t.Fatalf("the duty must name the authorising cloud flag: %q", n.Duty)
	}
	if got := executionSummary(a.State.Get()); got == nil || got.Mode != execModeAutonomousDischarge {
		t.Fatalf("a proven mode is reported as autonomous_discharge: %+v", got)
	}

	waitFor(t, 5*time.Second, "the native mode on the wire", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_mode"] == batteryModeNative
	})
	m, _ := sub.latest()
	if m["battery_native_duty"] != guards.NativeDutyCoverLoad {
		t.Fatalf("the duty must reach Layer 1 too: %v", m["battery_native_duty"])
	}
	// The reference value is STILL published: the take-back must be instant, and
	// the surfaces need a number. It is simply not written by the executor.
	if got := m["battery_setpoint_kw"].(float64); got > -7.086 || got < -7.088 {
		t.Fatalf("the reference must still be the guarded value, got %v", got)
	}

	// A slot WITHOUT the duty is the ordinary setpoint path again.
	a.mu.Lock()
	a.currentPlan.Slots[0].CoverLoadFromBattery = false
	a.mu.Unlock()
	nativeTick(a, now.Add(time.Second), true, nil)
	if n := nativeOf(a); n != nil {
		t.Fatalf("a plain slot is the setpoint path: %+v", n)
	}
}

// (3) THE SUPERVISION. Each condition of the design really takes the battery
// back on the very tick it appears - and the take-back is LATCHED for the rest
// of that slot, so a blinking fact cannot toggle the device's mode with the
// 10-second cadence.
func TestEverySupervisionConditionTakesTheBatteryBackAndLatches(t *testing.T) {
	// ⚠ latches distinguishes the two kinds of "not native" on purpose. A
	// TAKE-BACK (floor, stale measurement, lost readback, threatened peak, no
	// proof) is an EVENT observed on a flapping channel, so it is remembered for
	// the rest of the slot - re-entering would toggle the device's mode with the
	// 10-second cadence. A REFUSAL (plant rest, the operator's switch) is a
	// STATE somebody deliberately set: when it clears, resuming at once is
	// exactly what was asked for, and latching it would keep a plant on the
	// follower for a quarter hour after its pause ended.
	cases := []struct {
		name    string
		breakIt func(a *Agent, now time.Time)
		heal    func(a *Agent, now time.Time)
		latches bool
		want    string
	}{
		{"SoC reaches the reserve floor",
			func(a *Agent, now time.Time) { a.mu.Lock(); a.lastReading.SocPct = 21; a.mu.Unlock() },
			nil, true, guards.NativeFloorReached},
		{"the measurement goes stale",
			func(a *Agent, now time.Time) { a.mu.Lock(); a.lastReadingAt = now.Add(-time.Hour); a.mu.Unlock() },
			nil, true, guards.NativeStaleMeasurement},
		{"the readback stops being healthy",
			func(a *Agent, now time.Time) {
				a.State.Update(func(s *state.Snapshot) {
					s.Control = &state.ControlInfo{AllMatch: false, Confirm: "not_held", CheckedAt: now, Mode: batteryModeNative}
				})
			}, nil, true, guards.NativeNoReadback},
		{"the plant is at rest (Anlagen-Pause)",
			func(a *Agent, now time.Time) {
				a.entMu.Lock()
				a.entRegistry.PausedUntil = now.Add(time.Hour)
				a.entMu.Unlock()
			},
			func(a *Agent, now time.Time) {
				a.entMu.Lock()
				a.entRegistry.PausedUntil = time.Time{}
				a.entMu.Unlock()
			}, false, guards.NativeForeignHolder},
		{"the operator switches the mode off",
			func(a *Agent, now time.Time) { a.Cfg.NativeSelfRegulationEnabled = false },
			func(a *Agent, now time.Time) { a.Cfg.NativeSelfRegulationEnabled = true },
			false, guards.NativeOff},
		{"the billing peak is threatened",
			func(a *Agent, now time.Time) {
				// A quarter whose MEASURED import runs well above what its
				// remaining budget allows - the meter's own verdict, the only
				// one available when there is no lever left.
				a.peak.Add(now.Truncate(15*time.Minute), 60)
				a.peak.Add(now, 60)
				a.mu.Lock()
				target := 10.0
				a.currentPlan.GridImportLimitKw = &target
				a.mu.Unlock()
			},
			func(a *Agent, now time.Time) {
				a.mu.Lock()
				a.currentPlan.GridImportLimitKw = nil
				a.mu.Unlock()
			}, true, guards.NativePeakThreatened},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, _ := nativeAgent(t)
			now := nativeSlotStart.Add(time.Minute)
			nativeTick(a, now, true, nil)
			if n := nativeOf(a); n == nil || !n.Proven {
				t.Fatalf("setup: want a proven native mode, got %+v", n)
			}

			nativeTick(a, now.Add(time.Second), true, nil, c.breakIt)
			if n := nativeOf(a); n != nil {
				t.Fatalf("%s must take the battery back: %+v", c.name, n)
			}

			// The condition clears again - and the slot still finishes on the
			// proven follower. (nativeTick alone already heals the two
			// reading-based cases.)
			nativeTick(a, now.Add(2*time.Second), true, nil, c.heal)
			if latched := nativeOf(a) == nil; latched != c.latches {
				t.Fatalf("%s: latched=%v want %v (%s)", c.name, latched, c.latches, c.want)
			}

			// The NEXT slot re-arms - one transition per slot, never a permanent
			// lockout.
			next := nativeSlotStart.Add(15 * time.Minute)
			a.mu.Lock()
			a.currentPlan.Slots[0].Start = next
			a.currentPlan.ReceivedAt = next
			a.currentPlan.GeneratedAt = next
			a.mu.Unlock()
			nativeTick(a, next.Add(time.Minute), true, nil)
			if n := nativeOf(a); n == nil {
				t.Fatalf("a new slot must re-arm the mode (%s)", c.want)
			}
		})
	}
}

// (4) EEG: when we stop commanding, the grid-charge ban lives in the DEVICE's
// own configuration - so it has to prove it. Silence is not proof.
func TestOnAnEegPlantTheDeviceMustProveItCannotGridCharge(t *testing.T) {
	for _, c := range []struct {
		name    string
		blocked *bool
		native  bool
	}{
		{"the device stays silent", nil, false},
		{"the device says it CAN grid-charge", boolPtr(false), false},
		{"the device proves it cannot", boolPtr(true), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, _ := nativeAgent(t)
			// EEG posture: the plan forbids grid charging.
			a.mu.Lock()
			no := false
			a.currentPlan.GridChargeAllowed = &no
			a.mu.Unlock()

			nativeTick(a, nativeSlotStart.Add(time.Minute), true, c.blocked)
			if got := nativeOf(a) != nil; got != c.native {
				t.Fatalf("native=%v want %v", got, c.native)
			}
		})
	}
}

func boolPtr(v bool) *bool { return &v }
