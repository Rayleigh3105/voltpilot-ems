package agent

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// herzogauUnderChargePlan is the FRESH one-slot plan of the reported incident:
// the optimizer had already decided to store, it just under-estimated the
// surplus (its nowcast had measured the plant while OUR OWN curtailment cap was
// still holding it down). No cloud absorption duty on the slot - lambda had
// collapsed to ~wear/2 because the plan's own trajectory fills the battery
// inside the horizon anyway, which is exactly why the economic flag is silent
// on the days it was built for.
func herzogauUnderChargePlan(now time.Time, kw float64) *plan.Plan {
	no, floor := false, 35.0
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &no, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: now, BatterySetpointKw: kw,
			ChargeSurplusToBattery: false,
		}},
	}
}

// herzogauUnderChargeReading is box/state-final.json of 2026-08-29 10:53:13
// local, read verbatim: PV 56,907 kW, house 29,013 kW, storage 38 %.
func herzogauUnderChargeReading() guards.Reading {
	return guards.Reading{
		SocPct: 38, PvKw: 56.907, LoadKw: 29.013, GridLimitKw: guards.Unknown(),
	}
}

// THE REGRESSION (scout report vp-herzogau-einspeisung-statt-laden-h3 §4/§8 B1):
// the plan commanded +9,82 kW, the plant measured a 27,894 kW surplus, and the
// difference left the site at a NEGATIVE price with the storage at 38 %. No
// guard raised it: the trim only lowers, the follower only acts on a discharge,
// and the top-band buffer needs an IDLE command AND a nearly full battery.
func TestUnderEstimatedChargeIsRaisedToTheMeasuredSurplus(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 8, 53, 13, 0, time.UTC)

	a.mu.Lock()
	a.currentPlan = herzogauUnderChargePlan(now, 9.82)
	a.lastReading = herzogauUnderChargeReading()
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the raised charge", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 27.894
	})

	snap := a.State.Get()
	if snap.Absorb == nil || !snap.Absorb.Active || snap.Absorb.Path != execModeSurplusStore {
		t.Fatalf("surplus-storage execution evidence = %+v", snap.Absorb)
	}
	if snap.Absorb.PlannedKw != 9.82 {
		t.Fatalf("planned comparison = %.3f kW, want the Fahrplan's own 9.82 kW", snap.Absorb.PlannedKw)
	}
	if snap.Absorb.SurplusKw == nil || math.Abs(*snap.Absorb.SurplusKw-27.894) > 1e-9 {
		t.Fatalf("measured surplus = %+v, want 27.894 kW", snap.Absorb.SurplusKw)
	}
	// The whole point: the export the incident measured is gone.
	if grid := 29.013 + snap.SetpointKw - 56.907; math.Abs(grid) > .001 {
		t.Fatalf("grid = %.3f kW, want zero (the incident exported ~18 kW)", grid)
	}
	if ex := controlSummary(snap).Execution; ex == nil || ex.Mode != execModeSurplusStore ||
		ex.PlannedKw == nil || *ex.PlannedKw != 9.82 ||
		ex.SurplusKw == nil || math.Abs(*ex.SurplusKw-27.894) > 1e-9 || !ex.MeasurementsFresh {
		t.Fatalf("heartbeat must name the surplus storage: %+v", ex)
	}
}

// The correction is MAGNITUDE-ONLY on a direction the plan is already writing,
// so it deliberately demands no held readback - exactly like the established
// cloud absorption it shares its controller with, and unlike the two rules that
// START a direction from an idle command (those need the independently held
// Layer-1 evidence). Requiring it here would make a strictly smaller correction
// stricter than the larger one it sits next to.
func TestSurplusStorageNeedsNoHeldReadbackForAMagnitudeCorrection(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 8, 53, 13, 0, time.UTC)

	a.mu.Lock()
	a.currentPlan, a.lastReading, a.lastReadingAt = herzogauUnderChargePlan(now, 9.82),
		herzogauUnderChargeReading(), now
	a.mu.Unlock()
	// No state.ControlInfo at all - nothing has confirmed a register yet.

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the raised charge", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 27.894
	})
	if snap := a.State.Get(); snap.Absorb == nil || snap.Absorb.Path != execModeSurplusStore {
		t.Fatalf("surplus-storage execution evidence = %+v", snap.Absorb)
	}
}

// The raise is bounded by the SAME authoritative chain the command came from:
// with a surplus larger than the inverter's rated charge power the correction
// stops at the rated band, never at the surplus.
func TestTheRaisedChargeStillObeysTheRatedBand(t *testing.T) {
	a, addr := followAgentAddr(t) // MaxChargeKw = 30
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)

	a.mu.Lock()
	a.currentPlan = herzogauUnderChargePlan(now, 9.82)
	r := herzogauUnderChargeReading()
	r.PvKw = 80 // a surplus of 50,987 kW - far beyond what the Deye can take
	a.lastReading = r
	a.lastReadingAt = now
	a.mu.Unlock()

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the rated-band ceiling", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 30.0
	})
	if snap := a.State.Get(); snap.SetpointKw != 30 {
		t.Fatalf("setpoint = %.3f kW, want the 30 kW rated charge power", snap.SetpointKw)
	}
}

// Everything the rule must leave exactly as it was. Each case runs the FULL
// setpoint path, so a regression shows up as a changed published value.
func TestSurplusStorageLeavesEveryOtherIntentUntouched(t *testing.T) {
	cases := []struct {
		name    string
		planned float64
		want    float64
		patch   func(*plan.Plan, *guards.Reading)
	}{{
		// A deliberate sale is a DIRECTION. No economic or trust guard flips one.
		name: "planned sale", planned: -30, want: -30,
	}, {
		// An idle command is a different question: it needs the cloud's own-
		// consumption marker to tell an own-consumption slot from a sell slot,
		// so this rule refuses it and the slot exports exactly as before.
		name: "idle command without the cover-load marker", planned: 0, want: 0,
	}, {
		// The house eats the production: there is no surplus to store, and the
		// rule must never buy the difference.
		name: "no measured surplus", planned: 9.82, want: 9.82,
		patch: func(_ *plan.Plan, r *guards.Reading) { r.PvKw = 20; r.LoadKw = 29.013 },
	}, {
		// Never regulate blind - an unknown measurement is a refusal, not a
		// guessed zero. Grid charging is released here ON PURPOSE, so the
		// upstream EEG solar-only clamp (which zeroes a blind charge by itself)
		// cannot mask what this rule does.
		name: "unknown pv", planned: 9.82, want: 9.82,
		patch: func(p *plan.Plan, r *guards.Reading) {
			yes := true
			p.GridChargeAllowed = &yes
			r.PvKw = guards.Unknown()
		},
	}, {
		// At the configured ceiling there is nothing left to fill. The
		// authoritative clamp has already zeroed the charge; the rule must not
		// resurrect it.
		name: "battery at the ceiling", planned: 9.82, want: 0,
		patch: func(_ *plan.Plan, r *guards.Reading) { r.SocPct = 95 },
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, addr := followAgentAddr(t)
			sub := subscribeSetpoint(t, addr)
			now := time.Date(2026, 8, 29, 8, 53, 13, 0, time.UTC)
			p := herzogauUnderChargePlan(now, tc.planned)
			r := herzogauUnderChargeReading()
			if tc.patch != nil {
				tc.patch(p, &r)
			}
			a.mu.Lock()
			a.currentPlan, a.lastReading, a.lastReadingAt = p, r, now
			a.mu.Unlock()

			a.applySetpoint(now)
			waitFor(t, 5*time.Second, "the untouched command", func() bool {
				m, ok := sub.latest()
				return ok && m["battery_setpoint_kw"] == tc.want
			})
			if snap := a.State.Get(); snap.Absorb != nil && snap.Absorb.Active {
				t.Fatalf("nothing may be raised here: %+v", snap.Absorb)
			}
		})
	}
}

// Where the CLOUD authorized the absorption it keeps its own name: the local
// trust floor must never re-label a decision the plan itself made, or the
// portal would credit the box with an economic verdict nobody computed there.
func TestTheCloudDutyKeepsItsOwnNameWhenBothWouldApply(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 8, 53, 13, 0, time.UTC)

	p := herzogauUnderChargePlan(now, 9.82)
	p.Slots[0].ChargeSurplusToBattery = true
	a.mu.Lock()
	a.currentPlan, a.lastReading, a.lastReadingAt = p, herzogauUnderChargeReading(), now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the cloud absorption", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 27.894
	})
	snap := a.State.Get()
	if snap.Absorb == nil || !snap.Absorb.Active || snap.Absorb.Path != "" {
		t.Fatalf("the cloud-economic path must stay unnamed-local: %+v", snap.Absorb)
	}
	if ex := controlSummary(snap).Execution; ex == nil || ex.Mode != execModeAbsorb {
		t.Fatalf("heartbeat must keep reporting the cloud duty: %+v", ex)
	}
}

// A plant at rest is a plant at rest: the pause hands the battery to the local
// self-consumption rule, and no market-side correction may reach past it.
func TestSurplusStorageIsInactiveWhileTheAutomationIsPaused(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Date(2026, 8, 29, 8, 53, 13, 0, time.UTC)
	until := now.Add(time.Hour)

	a.mu.Lock()
	a.currentPlan, a.lastReading, a.lastReadingAt = herzogauUnderChargePlan(now, 9.82),
		herzogauUnderChargeReading(), now
	a.mu.Unlock()
	a.entMu.Lock()
	a.entRegistry = entities.Registry{PausedUntil: until}
	a.entMu.Unlock()

	a.applySetpoint(now)
	// The self-consumption fallback already follows pv - load, so it lands on
	// the surplus by ITS OWN rule - and reports the pause, never a correction.
	waitFor(t, 5*time.Second, "the paused fallback", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == 27.894
	})
	if snap := a.State.Get(); snap.Absorb != nil && snap.Absorb.Active {
		t.Fatalf("a paused plant reports no market correction: %+v", snap.Absorb)
	}
}
