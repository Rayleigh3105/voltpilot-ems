package agent

// The Netzladen-Sperre end to end (captain decisions EN-1 A / EN-4 A,
// 2026-11-02, guards/netzladensperre.go): with grid charging not allowed the
// box never writes a charge above max(measured pv - load - 1 kW, 0), a reading
// older than 30 s or unknown gives 0, whatever the plan, the in-slot
// corrections or the NS-3 B hold ask for. A plant with grid charging allowed
// keeps its setpoint byte for byte.

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// sperreTelemetry feeds one Deye snapshot through the real telemetry path:
// the house load is DERIVED there (pv + grid - battery), exactly as live.
func sperreTelemetry(a *Agent, at time.Time, pvKw, houseKw, battKw float64) {
	payload, _ := json.Marshal(map[string]any{
		"ts":               at.Format(time.RFC3339Nano),
		"power_kw":         round3(houseKw + battKw - pvKw), // + import
		"battery_power_kw": round3(battKw),
		"pv_power_kw":      round3(pvKw),
		"soc_pct":          40.0,
	})
	a.onLocalTelemetry("", payload)
}

func sperrePlan(now time.Time, kw float64, gridChargeAllowed *bool, slot plan.Slot) *plan.Plan {
	slot.Start = now.Truncate(15 * time.Minute)
	slot.BatterySetpointKw = kw
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: gridChargeAllowed,
		// MiSpeL MP-14: the route that leaves grid charging to the bit, so the
		// bit alone decides here as before.
		Foerderweg: plan.FoerderwegUngefoerdert,
		Slots:      []plan.Slot{slot},
	}
}

// Herzogau 02.11.2026 08:39-15:37: house 6,5 kW, PV 1-3 kW, the plan of 14:30
// UTC charged +7,6 kW the next morning - and the box clamped only to the PV.
func TestNetzladenSperreHerzogau0211KeinLadenBeiBezug(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	no, yes := false, true

	now := time.Date(2026, 11, 3, 8, 30, 5, 0, time.UTC) // 09:30:05 local
	for _, posture := range []struct {
		name string
		gca  *bool
	}{{"grid_charge_allowed=false", &no}, {"field absent (fail-safe)", nil}} {
		for _, c := range []struct{ pv, batt float64 }{{1, 0}, {2, 0}, {3, 0}, {3, 5.4}, {1.5, 7.6}} {
			now = now.Add(10 * time.Second)
			a.mu.Lock()
			a.currentPlan = sperrePlan(now, 7.6, posture.gca, plan.Slot{})
			a.mu.Unlock()
			sperreTelemetry(a, now, c.pv, 6.5, c.batt)
			a.applySetpoint(now)
			// FK3 alone would have let the PV through (1-3 kW); the plan
			// clamp (stage 4b) and the last stage both hold 0.
			if s := a.State.Get(); s.SetpointKw != 0 {
				t.Fatalf("%s, pv %v, battery %v: setpoint %v, want 0 - the house imports",
					posture.name, c.pv, c.batt, s.SetpointKw)
			}
		}
	}

	// With a real surplus the battery charges it - minus the reserve.
	now = now.Add(10 * time.Second)
	a.mu.Lock()
	a.currentPlan = sperrePlan(now, 7.6, &no, plan.Slot{})
	a.mu.Unlock()
	sperreTelemetry(a, now, 12, 6.5, 0)
	// The bound was 0 a moment ago: it climbs on settled readings only.
	for i := 0; i < 6; i++ {
		now = now.Add(20 * time.Second)
		sperreTelemetry(a, now, 12, 6.5, a.State.Get().SetpointKw)
		a.applySetpoint(now)
	}
	// The bound stops the deadband short of what the reading allows.
	if got, max := a.State.Get().SetpointKw, 12-6.5-guards.NetzladenReserveKw; got > max+1e-9 || got < max-0.4 {
		t.Fatalf("surplus 5.5: setpoint %v, want the surplus minus the reserve %v (less at most 2 deadbands)", got, max)
	}

	// The counter-case: grid charging allowed - the same plant charges the
	// plan's 7,6 kW while the house imports, untouched by the lock.
	b, _ := startBusOnlyAgent(t, cfg)
	now = now.Add(10 * time.Second)
	b.mu.Lock()
	b.currentPlan = sperrePlan(now, 7.6, &yes, plan.Slot{})
	b.mu.Unlock()
	sperreTelemetry(b, now, 2, 6.5, 0)
	b.applySetpoint(now)
	if s := b.State.Get(); s.SetpointKw != 7.6 || s.NetzladenSperre != nil {
		t.Fatalf("merchant plant: setpoint %v (block %+v), want the plan's 7.6 untouched", s.SetpointKw, s.NetzladenSperre)
	}
}

// SW-1 A (captain decision 2026-11-02): the lock follows the BNetzA measure at
// the connection point and makes NO exception for the hybrid's own DC PV. FK3
// argued "the PV bus feeds the battery, the grid feeds the house - two
// separate flows on a DC hybrid"; in the balance it is still charging while
// importing. Deye DC PV 8 kW, house 9 kW, the plan charges the PV bus with
// 8 kW: the bound is max(pv_total - house - R, 0) over ALL PV = 0.
func TestNetzladenSperreDcPvChargingWhileImportingIsZero(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	no := false

	now := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = sperrePlan(now, 8, &no, plan.Slot{})
	a.mu.Unlock()
	// The Deye charges its whole DC PV (8 kW) while the house draws 9 kW from
	// the grid - the picture FK3 called "two separate flows".
	sperreTelemetry(a, now, 8, 9, 8)
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got != 0 {
		t.Fatalf("DC-PV charging while the house imports: setpoint %v, want 0", got)
	}
	// The same through the stateless stage (v2 arbiter, a forced window bound,
	// First-Light): 8 kW of PV, 9 kW of house -> 0. FK3 alone allowed 8.
	l := guards.Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 5, SocMaxPct: 95,
		SolarOnlyCharge: true, StrictExclusivity: true}
	if got := guards.Clamp(8, l, guards.Reading{SocPct: 40, PvKw: 8, LoadKw: 9, GridLimitKw: guards.Unknown()}); got != 0 {
		t.Fatalf("Clamp: %v, want 0", got)
	}
}

// A measurement older than 30 s gives 0, even with sun on the last reading.
func TestNetzladenSperreStaleReadingStopsCharging(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	no := false

	now := time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = sperrePlan(now, 10, &no, plan.Slot{})
	a.mu.Unlock()
	sperreTelemetry(a, now, 25, 4, 0)
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got < 10 || got > 25-4-guards.NetzladenReserveKw {
		t.Fatalf("fresh: setpoint %v, want the plan's 10 up to the bound 20", got)
	}
	// The Deye stops answering: 31 s after the last reading the box writes 0.
	later := now.Add(31 * time.Second)
	a.applySetpoint(later)
	s := a.State.Get()
	if s.SetpointKw != 0 || s.NetzladenSperre == nil || !s.NetzladenSperre.Blind {
		t.Fatalf("stale: setpoint %v, block %+v, want 0 and blind", s.SetpointKw, s.NetzladenSperre)
	}
}

// EN-4 A: the NS-3 B hold yields at once on import where grid charging is not
// allowed. The slot holds its 20-kW charge against a base load of 5 kW; a
// consumer of 12 kW does NOT yield. FK3 alone kept the charge standing for
// the hold's dwell (60 s of import); the lock takes it back on the same tick.
func TestNetzladenSperreTheChargeHoldYieldsAtOnce(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	no := false
	base := 5.0
	slot := plan.Slot{ChargeFromSurplusOnly: true, ChargeHoldBaseLoadKw: &base}

	now := time.Date(2026, 10, 14, 13, 0, 5, 0, time.UTC)
	a.mu.Lock()
	a.currentPlan = sperrePlan(now, 20, &no, slot)
	a.mu.Unlock()
	// PV 26, base load 5: the planned 20 kW fit (26 - 5 - 1 = 20).
	sperreTelemetry(a, now, 26, 5, 0)
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got != 20 {
		t.Fatalf("before the consumer: setpoint %v, want 20", got)
	}
	// The consumer switches on: house 17 kW, the battery still at 20 kW - the
	// connection point imports 11 kW.
	now = now.Add(10 * time.Second)
	sperreTelemetry(a, now, 26, 17, 20)
	a.applySetpoint(now)
	s := a.State.Get()
	if max := 26 - 17 - guards.NetzladenReserveKw; s.SetpointKw > max || s.SetpointKw < max-0.2-1e-9 {
		t.Fatalf("consumer on: setpoint %v, want %v less the deadband on the same tick (hold %+v)", s.SetpointKw, max, s.ChargeHold)
	}
}

// The measured Deye at Herzogau 24.09.2026 17:15:35-17:27:35 (scout report
// vp-herzogau-laden-bei-bezug-h4, analyse/stream-tabelle.txt; the same window
// the damper's replay drives, testdata/herzogau-2026-09-24-deye.txt): the slot
// charges with charge_from_surplus_only + absorption under clouds. With the
// lock no write exceeds the bound the box itself measured, and less energy is
// bought into the battery than by the box as it ran.
func TestNetzladenSperreHerzogau2409Replay(t *testing.T) {
	s := loadHerzogauReplay(t)
	gesperrt := runDeyeReplayPosture(t, s, true, false, func(a *Agent, sp float64) {
		// Whenever the meter shows import, the write is within the bound of
		// the live reading - on that very tick.
		a.mu.Lock()
		r := a.lastReading
		grid := math.NaN()
		if a.lastGridKw != nil {
			grid = *a.lastGridKw
		}
		a.mu.Unlock()
		if sp > 0 && grid > guards.NetzladenBezugKw {
			if cap := math.Max(r.PvKw-r.LoadKw-guards.NetzladenReserveKw, 0); sp > cap+1e-9 {
				t.Fatalf("written %v kW while the meter imports %v kW, above the live bound %v", sp, grid, cap)
			}
		}
	})
	// The box as it ran on 24.09.: the same damper, no lock (in this window the
	// FK3 clamp never bites - the PV stood far above every command).
	wieGelaufen := runDeyeReplayPosture(t, s, true, true, nil)
	t.Logf("replay with the lock:   %s, %.0f s charging while importing", gesperrt, gesperrt.chargeImportSecs)
	t.Logf("replay as it ran:       %s, %.0f s charging while importing", wieGelaufen, wieGelaufen.chargeImportSecs)
	if gesperrt.boughtIntoBattKwh >= wieGelaufen.boughtIntoBattKwh {
		t.Errorf("bought into the battery: %.3f kWh with the lock, %.3f without", gesperrt.boughtIntoBattKwh, wieGelaufen.boughtIntoBattKwh)
	}
	if gesperrt.chargeImportSecs >= wieGelaufen.chargeImportSecs {
		t.Errorf("seconds charging while importing: %.0f with the lock, %.0f without", gesperrt.chargeImportSecs, wieGelaufen.chargeImportSecs)
	}
	if gesperrt.chargeAtImport >= wieGelaufen.chargeAtImport {
		t.Errorf("measurements charging while importing: %d with the lock, %d without", gesperrt.chargeAtImport, wieGelaufen.chargeAtImport)
	}
}

// The counter-test: a plant with grid charging allowed runs the whole 24.09.
// replay - charging under clouds, importing on most measurements - and the
// lock never engages: no netzladen_sperre block on any tick, and the run is
// tick for tick reproducible. (That the published setpoints are byte for byte
// those of the code before the lock is shown outside the suite by running the
// same replay on both trees; the stage itself returns the command unchanged
// when inactive, guards.TestNetzladenSperreIsANoOpWhereGridChargingIsAllowed.)
func TestNetzladenSperreMerchantReplayNeverEngages(t *testing.T) {
	s := loadHerzogauReplay(t)
	var erste []float64
	importiert := runDeyeReplayPosture(t, s, true, true, func(a *Agent, sp float64) {
		if a.State.Get().NetzladenSperre != nil {
			t.Fatalf("merchant plant carries a netzladen_sperre block at setpoint %v", sp)
		}
		erste = append(erste, sp)
	})
	if importiert.chargeAtImport == 0 {
		t.Fatalf("the merchant replay never charged while importing - it proves nothing: %s", importiert)
	}
	var zweite []float64
	_ = runDeyeReplayPosture(t, s, true, true, func(_ *Agent, sp float64) { zweite = append(zweite, sp) })
	if len(erste) == 0 || len(erste) != len(zweite) {
		t.Fatalf("replay lengths %d / %d", len(erste), len(zweite))
	}
	for i := range erste {
		if erste[i] != zweite[i] {
			t.Fatalf("tick %d: %v vs %v - the merchant replay is not reproducible", i, erste[i], zweite[i])
		}
	}
}

// The lock on top of the follower stays calm. It bounds every charge the
// reserve below the SETTLED surplus (the follower's control reading), so the
// echo of the box's own writes cannot cut it, and a deadband keeps the
// wandering derived house load from rewriting the device. Measured against
// the follower alone (grid charging allowed) on the same three disturbances:
// a load step, a cloud edge and the Herzogau window of 24.09.2026.
func TestNetzladenSperreStaysCalmOnTopOfTheFollower(t *testing.T) {
	cases := []struct {
		name        string
		s           replayScenario
		extraWrites int
		extraRev    int
	}{
		{"load step", syntheticScenario(600, 30, 24.5,
			[]exoPoint{{0, 30, 25}, {180, 30, 25}, {181, 30, 17}, {600, 30, 17}}), 6, 1},
		{"cloud edge", syntheticScenario(720, 30, 28.5,
			[]exoPoint{{0, 36, 29}, {120, 36, 29}, {125, 16, 9}, {300, 16, 9}, {305, 36, 29}, {720, 36, 29}}), 8, 2},
		{"Herzogau 24.09.", loadHerzogauReplay(t), 8, 4},
	}
	for _, c := range cases {
		allein := runDeyeReplayPosture(t, c.s, true, true, nil)
		gesperrt := runDeyeReplayPosture(t, c.s, true, false, nil)
		t.Logf("%s, follower alone: %s, %d reversals", c.name, allein, reversals(allein.setpoints))
		t.Logf("%s, with the lock:  %s, %d reversals", c.name, gesperrt, reversals(gesperrt.setpoints))
		if gesperrt.changes > allein.changes+c.extraWrites {
			t.Errorf("%s: %d writes with the lock, %d without - the lock rewrites the device", c.name, gesperrt.changes, allein.changes)
		}
		if reversals(gesperrt.setpoints) > reversals(allein.setpoints)+c.extraRev {
			t.Errorf("%s: %d reversals with the lock, %d without - the lock swings", c.name,
				reversals(gesperrt.setpoints), reversals(allein.setpoints))
		}
		if gesperrt.boughtIntoBattKwh > allein.boughtIntoBattKwh+1e-9 {
			t.Errorf("%s: %.3f kWh bought into the battery with the lock, %.3f without", c.name,
				gesperrt.boughtIntoBattKwh, allein.boughtIntoBattKwh)
		}
	}
}

// Negative price at an EEG plant: the plan charges 30 kW and curtails the PV
// to house + battery ("let nothing out of the site"); the box's live tracker
// keeps the cap there. The measured surplus is then exactly what the battery
// takes - a reserve bound on it would cut the charge by 1 kW per reading and
// the cap with it, down to 0. The lock knows the box's own cap and lets the
// meter judge: the charge stands, nothing is imported, nothing exported.
func TestNetzladenSperreUnderTheBoxsOwnCurtailment(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	no := false
	const avail, house = 45.0, 10.0
	slotCap := house + 30

	t0 := time.Date(2026, 10, 4, 11, 0, 5, 0, time.UTC)
	batt, pvCap := 30.0, slotCap
	for i := 0; i < 30; i++ {
		now := t0.Add(time.Duration(i) * 10 * time.Second)
		a.mu.Lock()
		a.currentPlan = sperrePlan(now, 30, &no, plan.Slot{PvLimitKw: &slotCap})
		a.mu.Unlock()
		pv := math.Min(avail, pvCap)
		sperreTelemetry(a, now, pv, house, batt)
		a.applySetpoint(now)
		s := a.State.Get()
		batt = s.SetpointKw
		a.mu.Lock()
		if a.sperrePvCap != nil {
			pvCap = *a.sperrePvCap
		}
		a.mu.Unlock()
		if i < 4 || i == 29 {
			t.Logf("tick %d: pv %.2f cap %.2f charge %.2f", i, pv, pvCap, batt)
		}
		if grid := house + batt - math.Min(avail, pvCap); grid > guards.NetzladenBezugKw {
			t.Fatalf("tick %d: the plant would import %.2f kW while charging %.2f", i, grid, batt)
		}
	}
	if batt < 30-1e-9 {
		t.Fatalf("after 5 min of curtailment the charge stands at %.2f kW, want the plan's 30 (no ratchet)", batt)
	}
}
