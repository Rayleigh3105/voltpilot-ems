package agent

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// „Sonne + Speicher" (2026-10-06) at the STATION: what the vehicle is really
// allowed to draw, read from the charging profile the box installed. Only the
// simulator stands behind these numbers (ocppsim) - no bench, no real battery.

// releaseHome is a single-family house: 35 kW connection, AC minimum 1,4 kW.
func releaseHome(t *testing.T, a *Agent, storage lastmgmt.StoragePriority) {
	t.Helper()
	set := lastmgmt.Settings{
		GridLimitKw: 35, MarginPct: 10, MinPowerKw: 1.4,
		RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 12,
		SurplusPolicy: lastmgmt.PolicyFast, StoragePriority: storage,
	}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

// releaseStation registers an 11-kW wallbox on „Sonne + Speicher" and plugs a
// car that would take all of it.
func releaseStation(t *testing.T, a *Agent, id string) *ocppsim.Station {
	t.Helper()
	st := ocppStation(t, a, id, 1, 11)
	src, rel := "nur_sonne", true
	if _, err := a.ocpp.srv.Update(id, csms.UpdateRequest{Source: &src, StorageRelease: &rel}); err != nil {
		t.Fatalf("source: %v", err)
	}
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 1.4}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID(id)
		return len(c.ActiveConnectors()) == 1
	})
	return st
}

// releasePlan is a fresh plan whose running slot carries a 30-% floor and a
// 5-kW battery.
func releasePlan(now time.Time, floor *float64) *plan.Plan {
	max := 5.0
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		ReleaseMaxDischargeKw: &max,
		Slots:                 []plan.Slot{{Start: now.Add(-time.Minute), BatterySetpointKw: -1, ReleaseFloorSocPct: floor}},
	}
}

func releaseFacts(a *Agent, p *plan.Plan, soc float64, ready bool) {
	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = p
	a.lastReading = guards.Reading{SocPct: soc, PvKw: 4, LoadKw: 1, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	note := ""
	if !ready {
		note = "Eine Regel oder ein Handeingriff hält den Speicher"
	}
	a.noteReleaseReadiness(now, ready, note)
}

func TestSonneSpeicherGivesTheCarTheSunPlusTheBattery(t *testing.T) {
	a := ocppAgent(t, nil)
	releaseHome(t, a, lastmgmt.StorageBeforeCars)
	s1 := releaseStation(t, a, "WALLBOX-1")
	floor := 30.0
	// House 1 kW, PV 4 kW: 3 kW of sun. The battery covers what the car
	// takes beyond it (measured -5 kW once the car draws 8).
	for i := 0; i < 4; i++ {
		releaseFacts(a, releasePlan(time.Now().UTC(), &floor), 80, true)
		batt := 0.0
		if drawOf(s1, 1)() > 3.5 {
			batt = -(drawOf(s1, 1)() - 3)
		}
		measureSurplus(t, a, 1, 4, batt, s1)
		a.ocppStep(context.Background())
	}
	nearKwSoon(t, "3 kW sun + 5 kW battery", drawOf(s1, 1), 8)
	info := a.State.Get().Ocpp
	if !info.StorageReleaseActive || info.StorageReleaseMode != string(lastmgmt.ReleaseActive) {
		t.Fatalf("the box must say it releases: %+v / %q", info.StorageReleaseMode, info.StorageReleaseNote)
	}
	nearKw(t, "released", *info.StorageReleaseKw, 5)
	if !strings.Contains(info.StorageReleaseNote, "30 %") {
		t.Fatalf("the sentence names the floor: %q", info.StorageReleaseNote)
	}
	if hb := a.chargersSummary(); hb.StorageReleaseMode != "frei" || hb.StorageReleaseFloorPct == nil {
		t.Fatalf("the heartbeat carries the stage: %+v", hb)
	}
}

func TestSonneSpeicherFallsBackToNurSonneOnEveryUnknown(t *testing.T) {
	floor := 30.0
	cases := map[string]struct {
		plan  func(now time.Time) *plan.Plan
		soc   float64
		ready bool
		mode  lastmgmt.ReleaseMode
	}{
		"stale plan": {func(now time.Time) *plan.Plan {
			p := releasePlan(now, &floor)
			p.ReceivedAt = now.Add(-plan.StaleAfter - time.Minute)
			return p
		}, 80, true, lastmgmt.ReleaseNoPlan},
		"no floor in this slot": {func(now time.Time) *plan.Plan { return releasePlan(now, nil) }, 80, true,
			lastmgmt.ReleasePlanTrades},
		"battery held": {func(now time.Time) *plan.Plan { return releasePlan(now, &floor) }, 80, false,
			lastmgmt.ReleaseBatteryPath},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a := ocppAgent(t, nil)
			releaseHome(t, a, lastmgmt.StorageBeforeCars)
			s1 := releaseStation(t, a, "WALLBOX-1")
			for i := 0; i < 3; i++ {
				releaseFacts(a, c.plan(time.Now().UTC()), c.soc, c.ready)
				measureSurplus(t, a, 1, 4, 0, s1)
				a.ocppStep(context.Background())
			}
			nearKwSoon(t, "only the sun, like „Nur Sonne“", drawOf(s1, 1), 3)
			info := a.State.Get().Ocpp
			if info.StorageReleaseActive || info.StorageReleaseMode != string(c.mode) || info.StorageReleaseNote == "" {
				t.Fatalf("mode %q / %q, want %q", info.StorageReleaseMode, info.StorageReleaseNote, c.mode)
			}
		})
	}
}

func TestAtItsFloorTheBatteryIsServedFirstEvenOnACarsFirstSite(t *testing.T) {
	a := ocppAgent(t, nil)
	releaseHome(t, a, lastmgmt.CarsBeforeStorage)
	s1 := releaseStation(t, a, "WALLBOX-1")
	floor := 30.0
	// PV 6, house 1, the battery takes 2 of the 5 kW surplus.
	for i := 0; i < 4; i++ {
		releaseFacts(a, releasePlan(time.Now().UTC(), &floor), 30.5, true)
		measureSurplus(t, a, 1, 6, 2, s1)
		a.ocppStep(context.Background())
	}
	nearKwSoon(t, "the car gets what the battery leaves, not the whole surplus", drawOf(s1, 1), 3)
	if v, _ := a.ocpp.release.Last(); !v.StorageFirst || v.Mode != lastmgmt.ReleaseAtFloor {
		t.Fatalf("verdict %+v", v)
	}
	if _, ok := a.OcppBatteryChargeCap(time.Now().UTC()); ok {
		t.Fatal("below its floor the battery must not be capped for this car")
	}
}

func TestASiteWithoutTheSourceReportsNothing(t *testing.T) {
	a := ocppAgent(t, nil)
	releaseHome(t, a, lastmgmt.StorageBeforeCars)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 11)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 1.4}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	measureSurplus(t, a, 1, 4, 0, s1)
	a.ocppStep(context.Background())
	info := a.State.Get().Ocpp
	if info.StorageReleaseActive || info.StorageReleaseMode != string(lastmgmt.ReleaseOff) {
		t.Fatalf("no release station, no release: %+v", info.StorageReleaseMode)
	}
	if hb := a.chargersSummary(); hb.StorageReleaseMode != "" {
		t.Fatalf("an inactive feature is no heartbeat stage: %q", hb.StorageReleaseMode)
	}
}

// --- the battery side: the release cover in applySetpoint -------------------

func releaseCoverAgent(t *testing.T) (*Agent, *setpointSubscriber) {
	t.Helper()
	a, addr := followAgentAddr(t)
	a.Cfg.ControlEnabled = true
	a.Cfg.OcppEnabled = true
	a.Cfg.OcppPort = 0
	a.Cfg.ConsumerControlEnabled = true
	if err := a.startOcpp(context.Background()); err != nil {
		t.Fatalf("startOcpp: %v", err)
	}
	t.Cleanup(a.stopOcpp)
	return a, subscribeSetpoint(t, addr)
}

// releaseCoverTick runs one battery tick: plan slot +3 kW charge from the sun,
// PV 6 kW, house + car 12 kW.
func releaseCoverTick(t *testing.T, a *Agent, now time.Time, floor *float64, soc float64, inUse bool) {
	t.Helper()
	yes, eff := true, 5.0
	max := 5.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &eff, ReleaseMaxDischargeKw: &max,
		Slots: []plan.Slot{{Start: now, BatterySetpointKw: 3, ReleaseFloorSocPct: floor}},
	}
	a.lastReading = guards.Reading{SocPct: soc, PvKw: 6, LoadKw: 12, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})
	if inUse {
		// The charge-point pass decided a few seconds ago, at 80 % - the
		// battery reading of THIS tick may already be lower.
		f, decided := 30.0, 80.0
		a.ocpp.release.Decide(lastmgmt.ReleaseInput{
			Now: now, PlanFresh: true, MaxDischargeKw: &max, FloorPct: &f, SocPct: &decided,
			Measured: true, BatteryReady: true, BmsDischargeKw: math.NaN(),
		})
		a.ocpp.setPlan(&lastmgmt.Plan{StorageReleaseUsedKw: 5})
	}
	a.applySetpoint(now)
}

func TestTheReleaseCoverStopsAPlannedChargeWhileTheCarDrawsTheBattery(t *testing.T) {
	a, sub := releaseCoverAgent(t)
	now := time.Now().UTC()
	floor := 30.0
	releaseCoverTick(t, a, now, &floor, 80, true)
	waitFor(t, 5*time.Second, "the cover follows pv - load", func() bool {
		m, ok := sub.latest()
		return ok && m["battery_setpoint_kw"] == -6.0
	})
	snap := a.State.Get()
	if snap.ReleaseCoverKw == nil || *snap.ReleaseCoverKw != -6 {
		t.Fatalf("the correction is named: %+v", snap.ReleaseCoverKw)
	}
	if ready, _ := a.releaseReady.get(now, a.releaseReadyWindow()); !ready {
		t.Fatal("this tick's battery path is ready for a release")
	}
}

func TestTheReleaseCoverNeverActsWithoutUseOrInATradeSlotOrBelowTheFloor(t *testing.T) {
	floor := 30.0
	cases := map[string]struct {
		floor *float64
		soc   float64
		inUse bool
		want  float64
	}{
		"no car draws the battery":    {&floor, 80, false, 3},
		"the plan trades this slot":   {nil, 80, true, 3},
		"the battery is at its floor": {&floor, 30, true, 0},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a, sub := releaseCoverAgent(t)
			now := time.Now().UTC()
			releaseCoverTick(t, a, now, c.floor, c.soc, c.inUse)
			waitFor(t, 5*time.Second, "the published setpoint", func() bool {
				m, ok := sub.latest()
				return ok && m["battery_setpoint_kw"] == c.want
			})
		})
	}
}
