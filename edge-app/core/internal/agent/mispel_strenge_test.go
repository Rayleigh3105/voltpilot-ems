package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// TestSetpointStrictExclusivityClamp (MiSpeL MP-45, Kasten W1 = D): an EEG
// plan carrying strict_exclusivity=true clamps the commanded charge to the
// MEASURED surplus pv - load before the setpoint is published - no charging
// while the site imports (Festlegung MiSpeL, Anlage 1 S. 11). The same EEG
// plan WITHOUT the field keeps FK3: charge up to the full measured PV while
// the house imports in parallel, exactly as before.
func TestSetpointStrictExclusivityClamp(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.GridChargeAllowed = true
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	eegFalse := false
	strictTrue := true
	apply := func(strict bool, tolKwh *float64, pv, load, want float64, what string) {
		t.Helper()
		p := freshPlan(now, 20, nil)
		p.GridChargeAllowed = &eegFalse
		if strict {
			p.StrictExclusivity = &strictTrue
			p.StrictExclusivityToleranceKwh = tolKwh
		}
		a.mu.Lock()
		a.currentPlan = p
		a.lastReading = guards.Reading{SocPct: 60, PvKw: pv, LoadKw: load, GridLimitKw: guards.Unknown()}
		a.mu.Unlock()
		a.applySetpoint(now)
		waitFor(t, 5*time.Second, what, func() bool {
			m, ok := sub.latest()
			return ok && m["battery_setpoint_kw"] == want
		})
		if a.State.Get().SetpointKw != want {
			t.Fatalf("%s: snapshot setpoint %v, want %v", what, a.State.Get().SetpointKw, want)
		}
	}

	// FK3 (no field): pv 5 / load 4 -> the full 5 kW production.
	apply(false, nil, 5, 4, 5, "FK3 charges the measured PV")
	// Strict: the same reading -> only the 1 kW surplus.
	apply(true, nil, 5, 4, 1, "strict charges the surplus only")
	// Strict, cloudy (pv 3 < load 4): no charge at all - FK3 would charge 3.
	apply(true, nil, 3, 4, 0, "strict: no charge while importing")
	// Strict with tolerance 0.25 kWh per quarter hour (= 1 kW): pv 3, load 3.5.
	tol := 0.25
	apply(true, &tol, 3, 3.5, 0.5, "strict within the tolerance")
	// Back to FK3 once the field is gone again: the switch is the plan's.
	apply(false, nil, 3, 4, 3, "FK3 again without the field")
}
