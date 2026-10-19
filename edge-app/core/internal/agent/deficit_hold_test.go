package agent

// The hold (guards.DeficitCoverHold) in a slot that PLANS A CHARGE, end to end
// through applySetpoint - the regression of Herzogau 2026-10-10 17:04 (report
// vp-wr-ueberschuss-entladung-k3 §1.5, reproduced there as
// belege/nachstellung-k3_scratch_test.go).
//
// The slot 17:00 planned +1,303 kW with charge_from_surplus_only on an EEG
// site. At 17:03:15 a consumer switched on (PV 4,69 kW, house 6,83 kW): the
// trim took the charge back to 0, the deficit rule saw that 0 instead of the
// planned charge and commanded -2,14 kW on the same tick. The Deye followed
// ~12 s later, the consumer was off by then, and 1,5 kW left the storage
// through the grid connection point - twelve times in 79 minutes.
//
// What must hold now: a consumer no longer than the hold never takes the
// setpoint below 0, and a deficit that outlasts it is covered as before.
//
// Since the Captain decision A of 2026-10-13 the same holds in every other kind
// of quarter hour too - deficit_hold_slots_test.go pins those.

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// herzogauChargeSlot is the slot 15:00Z of 2026-10-10: +1,303 kW, EEG site (no
// grid charging: the field is absent, so the solar-only clamp binds), platform
// floor 5 %. trim is the cloud flag charge_from_surplus_only.
func herzogauChargeSlot(start time.Time, kw float64, trim bool) *plan.Plan {
	floor := 5.0
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: start, GeneratedAt: start,
		EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: start, BatterySetpointKw: kw, ChargeFromSurplusOnly: trim,
		}},
	}
}

// herzogauTick feeds one measurement taken at now, with a held readback, and
// runs the setpoint path - what one 5-second poll plus tick does on the box.
func herzogauTick(t *testing.T, a *Agent, now time.Time, pv, load float64) state.Snapshot {
	t.Helper()
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 37, PvKw: pv, LoadKw: load, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})
	a.applySetpoint(now)
	return a.State.Get()
}

const (
	// The quiet surplus of 17:02:55 and the consumer of 17:03:15.
	herzogauQuietPv, herzogauQuietLoad = 4.97, 4.21
	herzogauPulsePv, herzogauPulseLoad = 4.69, 6.83
)

// PULSE <= HOLD: the consumer runs for the given time and the setpoint never
// goes below 0 - not during the consumer, not after it. 15 s is the consumer of
// 17:03:15; 60 s is the longest one the rule still rides out (measured every
// 5 s, its last deficit is read 55 s after the first).
func TestAConsumerNoLongerThanTheHoldNeverTurnsAChargingSlotAround(t *testing.T) {
	for _, pulse := range []time.Duration{15 * time.Second, 30 * time.Second, guards.DeficitCoverHold} {
		t.Run(pulse.String(), func(t *testing.T) {
			a, addr := followAgentAddr(t)
			sub := subscribeSetpoint(t, addr)
			slot := time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC)
			a.mu.Lock()
			a.currentPlan = herzogauChargeSlot(slot, 1.303, true)
			a.mu.Unlock()

			// 15:02:55Z - quiet: the box charges the measured surplus.
			now := slot.Add(175 * time.Second)
			if snap := herzogauTick(t, a, now, herzogauQuietPv, herzogauQuietLoad); snap.SetpointKw != 0.76 {
				t.Fatalf("quiet surplus 0,76 kW: setpoint=%.3f, want the surplus", snap.SetpointKw)
			}

			// The consumer: charging is taken back AT ONCE, nothing is discharged.
			on := now.Add(5 * time.Second)
			for at := on; at.Before(on.Add(pulse)); at = at.Add(5 * time.Second) {
				snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad)
				if snap.SetpointKw != 0 || snap.Follow != nil {
					t.Fatalf("%s into the consumer: setpoint=%.3f follow=%+v, want a resting battery",
						at.Sub(on), snap.SetpointKw, snap.Follow)
				}
				if snap.DeficitHold == nil || snap.DeficitHold.Since == nil || !snap.DeficitHold.Since.Equal(on) {
					t.Fatalf("%s into the consumer the wait must be named, since %s: %+v",
						at.Sub(on), on.Format("15:04:05"), snap.DeficitHold)
				}
				if snap.Trim == nil || snap.Trim.PlannedKw != 1.303 {
					t.Fatalf("the trim took the planned charge back and says so: %+v", snap.Trim)
				}
			}

			// The consumer is off: for the next two minutes the setpoint stays on
			// the charging side, and the box is back on the surplus.
			off := on.Add(pulse)
			for at := off; at.Before(off.Add(2 * time.Minute)); at = at.Add(5 * time.Second) {
				snap := herzogauTick(t, a, at, 4.68, 4.17)
				if snap.SetpointKw < 0 || snap.Follow != nil || snap.DeficitHold != nil {
					t.Fatalf("%s after the consumer: setpoint=%.3f follow=%+v hold=%+v, want charging and no deficit claim",
						at.Sub(off), snap.SetpointKw, snap.Follow, snap.DeficitHold)
				}
			}
			final := a.State.Get().SetpointKw
			if math.Abs(final-0.51) > 0.001 {
				t.Fatalf("after the consumer the box charges the 0,51 kW surplus again, got %.3f", final)
			}
			// The published value is the state's value (never a hidden correction).
			waitFor(t, 5*time.Second, "the published charge", func() bool {
				m, ok := sub.latest()
				return ok && m["battery_setpoint_kw"] == final
			})
		})
	}
}

// DEFICIT > HOLD: the house stays short (a cloud, the evening). The decision of
// 2026-08-28 stands - the deficit is covered, exactly one hold time after the
// box first measured it.
func TestADeficitThatOutlastsTheHoldIsCoveredInAChargingSlot(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	slot := time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = herzogauChargeSlot(slot, 1.303, true)
	a.mu.Unlock()

	now := slot.Add(175 * time.Second)
	herzogauTick(t, a, now, herzogauQuietPv, herzogauQuietLoad)

	on := now.Add(5 * time.Second)
	for at := on; at.Before(on.Add(guards.DeficitCoverHold)); at = at.Add(5 * time.Second) {
		if snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad); snap.SetpointKw != 0 || snap.Follow != nil {
			t.Fatalf("%s into the deficit: setpoint=%.3f follow=%+v - the hold is not over",
				at.Sub(on), snap.SetpointKw, snap.Follow)
		}
	}
	covered := on.Add(guards.DeficitCoverHold)
	snap := herzogauTick(t, a, covered, herzogauPulsePv, herzogauPulseLoad)
	want := -(herzogauPulseLoad - herzogauPulsePv)
	if math.Abs(snap.SetpointKw-want) > 0.001 {
		t.Fatalf("a deficit measured for the full hold is covered: setpoint=%.3f, want %.3f", snap.SetpointKw, want)
	}
	if snap.Follow == nil || snap.Follow.Path != execModeDeficitCover || snap.Follow.Direction != guards.FollowDeepen {
		t.Fatalf("the cover names its authority: %+v", snap.Follow)
	}
	if snap.DeficitHold != nil {
		t.Fatalf("a covered deficit no longer waits: %+v", snap.DeficitHold)
	}
	waitFor(t, 5*time.Second, "the published cover", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == snap.SetpointKw
	})

	// While it stands, a RISE waits like the deficit did (Stufen-Haltezeit,
	// Captain decision A, 2026-10-19): the cover keeps its level and names the
	// wait from the tick that saw the rise ...
	rise := covered.Add(5 * time.Second)
	deeper := herzogauTick(t, a, rise, 4.60, 7.20)
	if math.Abs(deeper.SetpointKw-want) > 0.001 || deeper.DeficitHold == nil ||
		deeper.DeficitHold.Since == nil || !deeper.DeficitHold.Since.Equal(rise) {
		t.Fatalf("a rise of a standing deficit waits: setpoint=%.3f hold=%+v, want %.3f and a wait since %s",
			deeper.SetpointKw, deeper.DeficitHold, want, rise.Format("15:04:05"))
	}
	// ... and the moment the house is no longer short the discharge is gone: the
	// very tick that measures the surplus charges it.
	back := herzogauTick(t, a, covered.Add(10*time.Second), 4.68, 4.17)
	if math.Abs(back.SetpointKw-0.51) > 0.001 || back.Follow != nil {
		t.Fatalf("with the surplus back the box charges it at once: setpoint=%.3f follow=%+v", back.SetpointKw, back.Follow)
	}
	// A consumer after that is a new consumer: it waits again.
	again := herzogauTick(t, a, covered.Add(15*time.Second), herzogauPulsePv, herzogauPulseLoad)
	if again.SetpointKw != 0 || again.DeficitHold == nil {
		t.Fatalf("a new deficit starts a new wait: setpoint=%.3f hold=%+v", again.SetpointKw, again.DeficitHold)
	}
}

// The hold measures the HOUSE, not the slot and not the rule's permission: a
// deficit that stood - and is covered - in a resting slot is not made to wait
// when the next slot plans a charge, and a readback that drops out for one tick
// (the rule is refused for that tick, as before) does not start the minute
// again.
func TestAStandingDeficitDoesNotWaitAgainAtASlotBoundaryOrAfterALostReadback(t *testing.T) {
	a, _ := followAgentAddr(t)
	rest := time.Date(2026, 10, 10, 14, 45, 0, 0, time.UTC)
	charge := rest.Add(15 * time.Minute)
	floor := 5.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: rest, GeneratedAt: rest,
		EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{
			{Start: rest, BatterySetpointKw: 0},
			{Start: charge, BatterySetpointKw: 1.303, ChargeFromSurplusOnly: true},
		},
	}
	a.mu.Unlock()

	// Resting slot: the deficit waits for the hold like everywhere (decision A,
	// 2026-10-13) and is covered once it has stood - 30 s before the boundary.
	first := charge.Add(-90 * time.Second)
	for at := first; at.Before(first.Add(guards.DeficitCoverHold)); at = at.Add(5 * time.Second) {
		if snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad); snap.SetpointKw != 0 || snap.DeficitHold == nil {
			t.Fatalf("%s into the deficit of a resting slot: setpoint=%.3f hold=%+v, want a named wait",
				at.Sub(first), snap.SetpointKw, snap.DeficitHold)
		}
	}
	for at := first.Add(guards.DeficitCoverHold); at.Before(charge); at = at.Add(5 * time.Second) {
		if snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad); snap.SetpointKw >= 0 || snap.DeficitHold != nil {
			t.Fatalf("a deficit that stood is covered in a resting slot: setpoint=%.3f hold=%+v", snap.SetpointKw, snap.DeficitHold)
		}
	}
	// The charging slot begins with the house still short: the cover continues.
	snap := herzogauTick(t, a, charge, herzogauPulsePv, herzogauPulseLoad)
	if snap.SetpointKw >= 0 || snap.Follow == nil || snap.DeficitHold != nil {
		t.Fatalf("90 s of measured deficit carry into the charging slot: setpoint=%.3f follow=%+v hold=%+v",
			snap.SetpointKw, snap.Follow, snap.DeficitHold)
	}

	// One readback cycle is lost: the rule is refused for this tick ...
	lost := charge.Add(5 * time.Second)
	a.mu.Lock()
	a.lastReadingAt = lost
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: false, Confirm: "mismatch", CheckedAt: lost}
	})
	a.applySetpoint(lost)
	if snap := a.State.Get(); snap.SetpointKw != 0 || snap.DeficitHold != nil {
		t.Fatalf("without a held readback nothing is discharged and nothing 'waits': setpoint=%.3f hold=%+v",
			snap.SetpointKw, snap.DeficitHold)
	}
	// ... and with the readback back the cover is too, without a new minute.
	snap = herzogauTick(t, a, charge.Add(10*time.Second), herzogauPulsePv, herzogauPulseLoad)
	if snap.SetpointKw >= 0 || snap.DeficitHold != nil {
		t.Fatalf("the deficit has stood all along - cover it: setpoint=%.3f hold=%+v", snap.SetpointKw, snap.DeficitHold)
	}
}

// The slot's INTENT decides, not what a clamp left of it for a moment: with the
// storage at its ceiling the planned charge is clamped to 0 before any trim
// runs - it is still a slot that plans a charge, and a short consumer must not
// discharge a full battery into the surplus that returns seconds later.
func TestAChargingSlotStaysOneWhileAComplianceClampHoldsItsChargeAtZero(t *testing.T) {
	a, _ := followAgentAddr(t)
	slot := time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = herzogauChargeSlot(slot, 1.303, true)
	a.mu.Unlock()
	now := slot.Add(3 * time.Minute)
	full := func(at time.Time, pv, load float64) state.Snapshot {
		a.mu.Lock()
		a.lastReading = guards.Reading{SocPct: a.Cfg.SocMaxPct, PvKw: pv, LoadKw: load, GridLimitKw: guards.Unknown()}
		a.lastReadingAt = at
		a.mu.Unlock()
		a.State.Update(func(s *state.Snapshot) {
			s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: at}
		})
		a.applySetpoint(at)
		return a.State.Get()
	}
	if snap := full(now, herzogauQuietPv, herzogauQuietLoad); snap.SetpointKw != 0 {
		t.Fatalf("a full storage does not charge: setpoint=%.3f", snap.SetpointKw)
	}
	snap := full(now.Add(5*time.Second), herzogauPulsePv, herzogauPulseLoad)
	if snap.SetpointKw != 0 || snap.Follow != nil || snap.DeficitHold == nil {
		t.Fatalf("the consumer in a charging slot waits, clamp or not: setpoint=%.3f follow=%+v hold=%+v",
			snap.SetpointKw, snap.Follow, snap.DeficitHold)
	}
}

// The same promise in the closed loop with dead time (the device models of the
// Prüflauf, surplus_short_consumer_scenario_test.go), in every kind of quarter
// hour: a PV surplus, then a cloud - the house is 1,5 kW short for five minutes
// - then the sun again. On every device the discharge starts no earlier than
// the hold after the deficit began, the deficit is then covered, and when the
// sun returns the discharge is gone after one reaction.
func TestARealDeficitIsCoveredAfterTheHoldOnEveryDevice(t *testing.T) {
	const cloudAt, cloudS = 120.0, 300.0
	hold := guards.DeficitCoverHold.Seconds()
	charging := benchSlotKind{name: "Lade-Viertelstunde"}
	for _, kind := range append([]benchSlotKind{charging}, benchSlotKinds()...) {
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				sc := benchScenario{
					start: time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC),
					pvKw:  5.0, planKw: 1.303, surplus: true, socPct: 37,
					segments: []benchSegment{
						{seconds: int(cloudAt), surplusKw: 0.8},
						{seconds: int(cloudS), surplusKw: -1.5},
						{seconds: 240, surplusKw: 0.8},
					},
				}
				if kind.name != charging.name {
					sc = kind.apply(sc)
				}
				res := runBench(t, dev, sc)
				coverAt, backAt := -1.0, -1.0
				for _, w := range res.setpoints {
					if coverAt < 0 && w.kw < -0.005 {
						coverAt = w.at
					}
					if coverAt >= 0 && backAt < 0 && w.at > cloudAt+cloudS && w.kw >= -0.005 {
						backAt = w.at
					}
				}
				cadence := dev.damp.MaxCadence.Seconds()
				t.Logf("%s, %s: Defizit 1,5 kW ab t=%.0f s für %.0f s - Entladung ab t=%.0f s (%.0f s nach Beginn), "+
					"Entladung zurückgenommen %.0f s nach dem Ende; %s",
					kind.name, dev.name, cloudAt, cloudS, coverAt, coverAt-cloudAt, backAt-(cloudAt+cloudS), res)
				if coverAt < 0 {
					t.Fatalf("a five-minute deficit was never covered: %s", res)
				}
				// Never before the deficit stood for the hold ...
				if coverAt-cloudAt < hold {
					t.Errorf("discharge %.0f s after the deficit began - before the hold of %.0f s", coverAt-cloudAt, hold)
				}
				// ... and no later than the device lets the box prove it: one Messtakt
				// until the deficit shows, one more until a pair a full hold later is
				// complete, and a poll plus a tick each time.
				if latest := hold + 2*(cadence+benchPollEvery+benchTickEvery); coverAt-cloudAt > latest {
					t.Errorf("discharge %.0f s after the deficit began, want <= %.0f s (hold + two Messtakte)", coverAt-cloudAt, latest)
				}
				// Covered: of the deficit that remained after the cover began, the
				// storage delivers all but the reserve the follower keeps.
				remaining := 1.5 * (cloudAt + cloudS - coverAt) / 3600
				if res.dischargedKwh < 0.5*remaining {
					t.Errorf("discharged %.3f kWh of the %.3f kWh the house was short after the cover began", res.dischargedKwh, remaining)
				}
				// The sun is back: the discharge is gone after one reaction, and the
				// storage fed the grid no longer than that.
				if backAt < 0 {
					t.Fatalf("the discharge was never taken back after the cloud: %s", res)
				}
				reaction := cadence + benchPollEvery + benchTickEvery
				if backAt-(cloudAt+cloudS) > reaction {
					t.Errorf("discharge taken back %.0f s after the cloud, want one reaction (<= %.0f s)", backAt-(cloudAt+cloudS), reaction)
				}
				if limit := reaction + dev.deadS + 3*dev.tauS; res.storageExportS > limit {
					t.Errorf("the storage fed the grid for %.0f s after the cloud, want <= %.0f s", res.storageExportS, limit)
				}
				last := res.setpoints[len(res.setpoints)-1]
				if last.kw < -0.005 {
					t.Errorf("after the cloud no discharge may stand, last setpoint %.3f kW", last.kw)
				}
				// A slot that charges the surplus is back on the charging side.
				if kind.name == charging.name && last.kw <= 0 {
					t.Errorf("after the cloud the box charges the surplus again, last setpoint %.3f kW", last.kw)
				}
			})
		}
	}
}

// And the other half in the closed loop: consumers of 30 s, 45 s and a full
// hold never discharge the storage on any device, however late or irregularly
// it reports the consumer's end. This is what counting to the newest
// MEASUREMENT (instead of to the clock) buys: a box that merely waited a minute
// on the reading it had would discharge for a 45 s consumer whose end the
// device reports 20 s late - and send that discharge into the grid.
func TestAConsumerOfUpToAHoldNeverDischargesOnAnyDevice(t *testing.T) {
	hold := guards.DeficitCoverHold.Seconds()
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			sc := benchScenario{
				start: time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC),
				pvKw:  5.0, planKw: 1.303, surplus: true, socPct: 37,
				segments: []benchSegment{{
					seconds: 2700, surplusKw: 1.2, pulseKw: 2.6,
					pulseS: []float64{30, 45, hold, 52, 38, hold},
					gapS:   []float64{151, 163, 177, 149, 168},
				}},
			}
			res := runBench(t, dev, sc)
			t.Logf("%s: %s", dev.name, res)
			if res.consumers < 15 {
				t.Fatalf("only %d consumers", res.consumers)
			}
			if res.dischargeWrites > 0 || res.minSetpointKw < 0 || res.storageExportedKwh > 1e-6 {
				t.Errorf("%d discharge commands, lowest setpoint %.3f kW, %.4f kWh from the storage into the grid - "+
					"no consumer here outlasts the hold", res.dischargeWrites, res.minSetpointKw, res.storageExportedKwh)
			}
		})
	}
}
