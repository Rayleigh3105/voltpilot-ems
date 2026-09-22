package agent

// The import mirror of TestA7lRampePlanRueckkehrHaelt. The park belongs to
// Halle 1 here: the original matrix puts it at the co-controlling box and
// cannot exercise a leading box's import ramp beside its discharging battery.
import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

func zbPlan(now time.Time) *plan.Plan {
	p := zaPlan(-100, nil)(now)
	for i := range p.Slots {
		if !p.Slots[i].Start.Before(zaRueckkehr) {
			p.Slots[i].BatterySetpointKw = 100
		}
	}
	return p
}

func zbFahre(t *testing.T, vor time.Duration) *zaMessung {
	t.Helper()
	m := neueAnlage(zaAnlauf)
	m.grundlast = func(time.Time) float64 { return zaVorbehalt }
	m.sonneK1 = func(time.Time) float64 { return 0 }
	m.sonneK12 = func(time.Time) float64 { return 0 }
	m.autos = func(time.Time) float64 { return 22 }
	e1 := zaStarteBox(t, "Halle 1 mit Ladepark", vaE1, zaDok(vaE1, 1, "ziel", 40, 60, 77, 0), zbPlan)
	e4 := zaStarteBox(t, "Verwaltung ohne Ladepark", vaE4, zaDok(vaE4, 1, "ziel", 40, 60, 77, 0), zaPlan(0, nil))
	e1.modell, e4.modell = m, m
	e4.rt = nil
	set := lastmgmt.Settings{GridLimitKw: zaBezugsgrenze}.WithDefaults()
	srv, err := csms.New(csms.Options{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e1.rt = &ocppRuntime{srv: srv, wake: make(chan struct{}, 1), budget: lastmgmt.NewBudgetTracker(), settings: set}
	e1.a.ocpp = e1.rt
	ausfall := zaRueckkehr.Add(-vor)
	bez := &zaMessung{grenzeKw: zaBezugsgrenze, richtung: 1}
	for m.now.Before(zaStart.Add(30 * time.Minute)) {
		m.schritt()
		// The park is behind Halle 1 in this layout; Verwaltung has no load.
		m.abgangE4 = 0
		s := int(m.now.Sub(zaAnlauf) / time.Second)
		if s == 1 || (m.now.Second() == 0 && m.now.Minute()%15 == 0) {
			e1.planZustellen(m)
			e4.planZustellen(m)
		}
		if s%10 == 0 {
			e1.zaehlerFehlt = vor >= 0 && !m.now.Before(ausfall)
			e1.a.ocpp = nil // CSMS measurements are fed explicitly below, as in the matrix.
			rt := e1.rt
			e1.rt = nil
			e1.messen(m)
			e1.rt = rt
			e1.a.ocpp = e1.rt
			if !e1.zaehlerFehlt {
				e1.rt.budget.ObserveM(m.now, lastmgmt.Measurement{GridKw: m.netz, ChargingKw: m.ladenK13, Complete: true,
					BatteryChargeKw: math.Max(m.battK2, 0), HaveBattery: true, BatteryPowerKw: &m.battK2})
			}
			e1.a.applySetpoint(m.now)
			if e1.sp != nil && e1.sp["control_enabled"] == true {
				if v, ok := e1.sp["battery_setpoint_kw"].(float64); ok {
					m.k2.befehl(m.now, v)
				}
			}
			v, reserved := e1.a.ocppBudget(m.now, set, csms.Snapshot{}, lastmgmt.SafeDefault{})
			alloc := math.Min(132, ocppAllocatable(v, reserved))
			e1.rt.setPlanAuf(&lastmgmt.Plan{BudgetKw: v.Kw, AllocatedKw: alloc}, e1.rt.budget.Stichprobe())
			for _, g := range m.k13 {
				g.befehl(m.now, alloc/6)
			}
		}
		if s%10 == 5 {
			e4.messen(m)
			e4.regeln(m)
		}
		if !m.now.Before(zaStart.Add(time.Second)) {
			bez.nimm(m.now, m.netz)
		}
	}
	bez.schluss()
	return bez
}

func TestA7bBezugsrampePlanRueckkehrHaelt(t *testing.T) {
	ref := zbFahre(t, -1)
	t.Logf("Referenz: M-1 %.3f kW, M-2 +%.3f kW / %d s", ref.hoechstesViertel().mittel, ref.groessteUeberKw, ref.laengsteUeber)
	for _, s := range []int{20, 30, 35, 40, 45, 50} {
		r := zbFahre(t, time.Duration(s)*time.Second)
		t.Logf("Rückkehr %d s: M-1 %.3f kW, M-2 +%.3f kW / %d s, gesamt %d s", s, r.hoechstesViertel().mittel, r.groessteUeberKw, r.laengsteUeber, r.sekundenUeber)
		if r.hoechstesViertel().mittel > zaBezugsgrenze+zaEps || r.groessteUeberKw > ref.groessteUeberKw+zaEps || r.laengsteUeber > 10 {
			t.Errorf("Rückkehr %d s: Bezugsrampe lässt wegfallende Entladung durch: +%.3f kW / %d s", s, r.groessteUeberKw, r.laengsteUeber)
		}
	}
}
