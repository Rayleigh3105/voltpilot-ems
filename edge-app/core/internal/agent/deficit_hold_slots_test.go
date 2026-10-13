package agent

// The hold in EVERY kind of quarter hour (Captain decision A, 2026-10-13), end
// to end through applySetpoint - the twin of deficit_hold_test.go, which pins
// the slot that plans a charge (E2 A, 2026-10-10).
//
// The Zusatzlauf of edge-2026.10.1 measured what the charging slot's hold left
// open: in a quarter hour without a planned charge the storage still fed the
// grid behind a short consumer (22,3 Wh behind six of them, up to 20 s in one
// stretch), because there the first measured deficit was covered at once and
// the device executed the discharge after the consumer had gone.
//
// What must hold now, whoever authorizes the cover - the local trust rule in a
// slot that rests, the cloud's cover_load_from_battery, the cloud's
// unplanned_load_discharge: a consumer no longer than the hold never produces a
// discharge setpoint, and a deficit that outlasts it is covered exactly one hold
// time after the box first measured it.

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// standDeficit declares the deficit of the agent's CURRENT reading one that has
// stood: the clock of the hold first judged it a full guards.DeficitCoverHold
// before the reading was measured, so the tick at now finds it sustained. For
// the many tests whose subject is what a cover DOES once it may run (its
// bounds, its name, its readback grace) - when it may begin is pinned in this
// file. Call it after the reading is set and before the tick; a tick that
// measures no deficit restarts the clock like on the box.
//
// A reading without a measurement time (the oldest follower tests set none) is
// stamped with now: on the box every reading carries one, and without it no
// deficit can ever be shown to have stood.
func standDeficit(a *Agent, now time.Time) {
	a.mu.Lock()
	if a.lastReadingAt.IsZero() {
		a.lastReadingAt = now
	}
	r, measuredAt := a.lastReading, a.lastReadingAt
	a.mu.Unlock()
	at := measuredAt.Add(-guards.DeficitCoverHold)
	a.deficitHold.Observe(at, at, true, r.PvKw, r.LoadKw)
}

// holdSlotKind is one kind of quarter hour in which a measured deficit may
// become a discharge, and the name its cover carries once it runs.
type holdSlotKind struct {
	name string
	slot plan.Slot
	path string
}

func holdSlotKinds() []holdSlotKind {
	return []holdSlotKind{
		// The plan rests and carries no duty: the local trust rule of 2026-08-28.
		{"Ruhe-Viertelstunde", plan.Slot{BatterySetpointKw: 0}, execModeDeficitCover},
		// The cloud marked the slot worth covering; its setpoint is the forecast.
		{"Deck-Viertelstunde (cover_load_from_battery)",
			plan.Slot{BatterySetpointKw: -1.0, CoverLoadFromBattery: true}, execModeFollow},
		// The plan rests and the cloud authorized starting a discharge.
		{"ungeplante Lastdeckung (unplanned_load_discharge)",
			plan.Slot{BatterySetpointKw: 0, UnplannedLoadDischarge: true}, execModeIdleFollow},
	}
}

func (k holdSlotKind) plan(start time.Time) *plan.Plan {
	floor := 5.0
	slot := k.slot
	slot.Start = start
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: start, GeneratedAt: start,
		EffectiveFloorSocPct: &floor,
		Slots:                []plan.Slot{slot},
	}
}

// noDischarge is "the battery was not asked to deliver": a setpoint at rest or
// charging, and no cover claimed (a covering slot may still say that it LIMITED
// the plan's forecast discharge - that is the opposite of a cover).
func noDischarge(snap state.Snapshot) bool {
	return snap.SetpointKw >= 0 && (snap.Follow == nil || snap.Follow.Direction == guards.FollowReduce)
}

// PULSE <= HOLD, in every kind of slot: the consumer of Herzogau 17:03:15 and
// two longer ones never take the setpoint below 0 - not while they run, not
// after they stopped.
func TestAConsumerNoLongerThanTheHoldNeverDischargesInAnySlotKind(t *testing.T) {
	for _, kind := range holdSlotKinds() {
		for _, pulse := range []time.Duration{15 * time.Second, 30 * time.Second, guards.DeficitCoverHold} {
			t.Run(kind.name+"/"+pulse.String(), func(t *testing.T) {
				a, _ := followAgentAddr(t)
				slot := time.Date(2026, 10, 13, 15, 0, 0, 0, time.UTC)
				a.mu.Lock()
				a.currentPlan = kind.plan(slot)
				a.mu.Unlock()

				// Quiet: PV covers the house.
				now := slot.Add(175 * time.Second)
				if snap := herzogauTick(t, a, now, herzogauQuietPv, herzogauQuietLoad); !noDischarge(snap) || snap.DeficitHold != nil {
					t.Fatalf("quiet surplus: setpoint=%.3f follow=%+v hold=%+v", snap.SetpointKw, snap.Follow, snap.DeficitHold)
				}

				// The consumer: the battery rests, and the box says why.
				on := now.Add(5 * time.Second)
				for at := on; at.Before(on.Add(pulse)); at = at.Add(5 * time.Second) {
					snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad)
					if snap.SetpointKw != 0 || !noDischarge(snap) {
						t.Fatalf("%s into the consumer: setpoint=%.3f follow=%+v, want a resting battery",
							at.Sub(on), snap.SetpointKw, snap.Follow)
					}
					h := snap.DeficitHold
					if h == nil || h.Since == nil || !h.Since.Equal(on) || h.HoldS != guards.DeficitCoverHold.Seconds() {
						t.Fatalf("%s into the consumer the wait must be named, since %s: %+v",
							at.Sub(on), on.Format("15:04:05"), h)
					}
				}

				// Off again: nothing is discharged afterwards either, nothing waits.
				off := on.Add(pulse)
				for at := off; at.Before(off.Add(2 * time.Minute)); at = at.Add(5 * time.Second) {
					snap := herzogauTick(t, a, at, 4.68, 4.17)
					if !noDischarge(snap) || snap.DeficitHold != nil {
						t.Fatalf("%s after the consumer: setpoint=%.3f follow=%+v hold=%+v, want no discharge and no deficit claim",
							at.Sub(off), snap.SetpointKw, snap.Follow, snap.DeficitHold)
					}
				}
			})
		}
	}
}

// DEFICIT > HOLD, in every kind of slot: the house stays short (a cloud, the
// evening). It is covered - exactly one hold time after the box first measured
// it, under the name of the authority that covers it.
func TestADeficitThatOutlastsTheHoldIsCoveredInEverySlotKind(t *testing.T) {
	for _, kind := range holdSlotKinds() {
		t.Run(kind.name, func(t *testing.T) {
			a, addr := followAgentAddr(t)
			sub := subscribeSetpoint(t, addr)
			slot := time.Date(2026, 10, 13, 15, 0, 0, 0, time.UTC)
			a.mu.Lock()
			a.currentPlan = kind.plan(slot)
			a.mu.Unlock()

			now := slot.Add(175 * time.Second)
			herzogauTick(t, a, now, herzogauQuietPv, herzogauQuietLoad)

			on := now.Add(5 * time.Second)
			for at := on; at.Before(on.Add(guards.DeficitCoverHold)); at = at.Add(5 * time.Second) {
				if snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad); snap.SetpointKw != 0 || !noDischarge(snap) {
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
			if snap.Follow == nil || snap.Follow.Path != kind.path || snap.Follow.Direction != guards.FollowDeepen {
				t.Fatalf("the cover names its authority (%s): %+v", kind.path, snap.Follow)
			}
			if snap.DeficitHold != nil {
				t.Fatalf("a covered deficit no longer waits: %+v", snap.DeficitHold)
			}
			waitFor(t, 5*time.Second, "the published cover", func() bool {
				m, ok := sub.latest()
				return ok && m["battery_setpoint_kw"] == snap.SetpointKw
			})

			// While it stands, the cover follows the deficit tick by tick without a
			// second wait ...
			deeper := herzogauTick(t, a, covered.Add(5*time.Second), 4.60, 7.20)
			if math.Abs(deeper.SetpointKw-(-2.6)) > 0.001 || deeper.DeficitHold != nil {
				t.Fatalf("a standing cover follows the deficit: setpoint=%.3f hold=%+v", deeper.SetpointKw, deeper.DeficitHold)
			}
			// ... and the moment the house is no longer short the discharge is gone.
			back := herzogauTick(t, a, covered.Add(10*time.Second), 4.68, 4.17)
			if !noDischarge(back) || back.DeficitHold != nil {
				t.Fatalf("with the surplus back the discharge is gone at once: setpoint=%.3f follow=%+v", back.SetpointKw, back.Follow)
			}
			// A consumer after that is a new consumer: it waits again.
			again := herzogauTick(t, a, covered.Add(15*time.Second), herzogauPulsePv, herzogauPulseLoad)
			if again.SetpointKw != 0 || again.DeficitHold == nil {
				t.Fatalf("a new deficit starts a new wait: setpoint=%.3f hold=%+v", again.SetpointKw, again.DeficitHold)
			}
		})
	}
}

// A WAIT, NOT AN OUTAGE - the night of a covering slot. The house has been
// short for minutes, the battery covers it. Then the measurement drops out for
// longer than the freshness window: the clock of the hold restarts (a gap in
// the evidence is not a deficit that lasted), but the cover that runs is KEPT -
// it only cannot grow until the deficit has stood again. Without that, every
// missed poll at night would cost a minute and a half of the whole house load.
func TestARunningCoverIsKeptThroughAGapInTheEvidenceAndOnlyCannotGrow(t *testing.T) {
	a, _ := followAgentAddr(t)
	slot := time.Date(2026, 10, 13, 21, 0, 0, 0, time.UTC)
	floor := 5.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: slot, GeneratedAt: slot,
		EffectiveFloorSocPct: &floor,
		Slots:                []plan.Slot{{Start: slot, BatterySetpointKw: -1.5, CoverLoadFromBattery: true}},
	}
	a.mu.Unlock()
	hold := guards.DeficitCoverHold

	// Night: no PV, the house draws 0,5 kW. After the hold the forecast -1,5 kW
	// is followed to the house.
	start := slot.Add(time.Minute)
	for at := start; !at.After(start.Add(hold)); at = at.Add(5 * time.Second) {
		herzogauTick(t, a, at, 0, 0.5)
	}
	running := start.Add(hold)
	if snap := a.State.Get(); math.Abs(snap.SetpointKw-(-0.5)) > 0.001 {
		t.Fatalf("the standing night deficit is covered: setpoint=%.3f follow=%+v", snap.SetpointKw, snap.Follow)
	}

	// 45 s without a measurement: three ticks on a reading that is no longer
	// fresh. The cover stays where it is.
	for _, gap := range []time.Duration{35 * time.Second, 40 * time.Second, 45 * time.Second} {
		at := running.Add(gap)
		a.State.Update(func(s *state.Snapshot) {
			s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: at}
		})
		a.applySetpoint(at)
		if snap := a.State.Get(); math.Abs(snap.SetpointKw-(-0.5)) > 0.001 {
			t.Fatalf("%s without a measurement: setpoint=%.3f - a running cover must not be dropped", gap, snap.SetpointKw)
		}
	}
	if _, standing := a.deficitHold.Since(); standing {
		t.Fatal("a stale reading is a gap in the evidence: the clock must have restarted")
	}

	// The measurement is back and shows a load step. It has not stood: the
	// cover keeps its level, and the box says that it waits.
	back := running.Add(50 * time.Second)
	for at := back; at.Before(back.Add(hold)); at = at.Add(5 * time.Second) {
		snap := herzogauTick(t, a, at, 0, 3.0)
		if math.Abs(snap.SetpointKw-(-0.5)) > 0.001 || snap.DeficitHold == nil {
			t.Fatalf("%s after the gap: setpoint=%.3f hold=%+v, want the kept level and a named wait",
				at.Sub(back), snap.SetpointKw, snap.DeficitHold)
		}
	}
	// ... until it has: then the step is covered in full.
	snap := herzogauTick(t, a, back.Add(hold), 0, 3.0)
	if math.Abs(snap.SetpointKw-(-3.0)) > 0.001 || snap.DeficitHold != nil ||
		snap.Follow == nil || snap.Follow.Path != execModeFollow {
		t.Fatalf("a load step that stood is covered: setpoint=%.3f follow=%+v hold=%+v", snap.SetpointKw, snap.Follow, snap.DeficitHold)
	}
	// Lowering needs no clock: the house draws less, the cover follows at once.
	if snap := herzogauTick(t, a, back.Add(hold+5*time.Second), 0, 0.3); math.Abs(snap.SetpointKw-(-0.3)) > 0.001 {
		t.Fatalf("lowering is immediate: setpoint=%.3f", snap.SetpointKw)
	}
}

// A PLANNED SALE IS NO DEFICIT COVER. A slot whose plan commands a discharge and
// carries no duty runs its value from the first tick, deficit or not, stood or
// not - the hold only ever withholds what a measurement would ADD.
func TestAPlannedSaleRunsUnchangedWhileADeficitWaits(t *testing.T) {
	a, _ := followAgentAddr(t)
	slot := time.Date(2026, 10, 13, 18, 0, 0, 0, time.UTC)
	floor := 5.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: slot, GeneratedAt: slot,
		EffectiveFloorSocPct: &floor,
		Slots:                []plan.Slot{{Start: slot, BatterySetpointKw: -8}},
	}
	a.mu.Unlock()
	// The house is 2,14 kW short; the plan sells 8 kW.
	for at := slot.Add(10 * time.Second); at.Before(slot.Add(2 * time.Minute)); at = at.Add(5 * time.Second) {
		snap := herzogauTick(t, a, at, herzogauPulsePv, herzogauPulseLoad)
		if snap.SetpointKw != -8 || snap.Follow != nil || snap.DeficitHold != nil {
			t.Fatalf("%s: a planned sale runs unchanged and nothing waits: setpoint=%.3f follow=%+v hold=%+v",
				at.Sub(slot), snap.SetpointKw, snap.Follow, snap.DeficitHold)
		}
	}
}
