package agent

// Dynamische Einspeisebegrenzung, agent half: the plan-carried feed-in limit
// reaches the setpoint as a live plant cap, composes most-restrictive-wins with
// the plan's own curtailment, and says honestly whether it can reach a device at
// all. The control LOOP itself is proven in internal/guards/exportlimit_test.go;
// this file proves the WIRING - which is where a compliance feature dies
// silently if it is wrong.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// exportPlan is freshPlan plus a site feed-in limit at the connection point.
func exportPlan(now time.Time, kw float64, pvLimit *float64, exportLimit *float64) *plan.Plan {
	p := freshPlan(now, kw, pvLimit)
	p.GridExportLimitKw = exportLimit
	return p
}

// observe feeds the watchdog one connection-point measurement the way
// onLocalTelemetry does (gated composite grid + total plant PV).
func observe(a *Agent, ts time.Time, gridKw, pvKw float64) {
	a.export.Observe(ts, gridKw, pvKw)
	a.mu.Lock()
	a.lastReading = guards.Reading{
		SocPct: 50, PvKw: pvKw, LoadKw: pvKw + gridKw, GridLimitKw: guards.Unknown(),
	}
	a.mu.Unlock()
}

func setpointPvLimit(t *testing.T, sub *setpointSubscriber) (float64, bool) {
	t.Helper()
	m, ok := sub.latest()
	if !ok {
		t.Fatalf("no setpoint published")
	}
	v, has := m["pv_limit_kw"]
	if !has {
		return 0, false
	}
	f, isNum := v.(float64)
	if !isNum {
		t.Fatalf("pv_limit_kw is not a number: %T %v", v, v)
	}
	return f, true
}

// The whole point, end to end through applySetpoint: a plant that would exceed
// its 30 kW connection-point limit gets a plant cap on the setpoint, and the cap
// tracks the MEASURED connection point (so a wallbox is netted in without anyone
// modelling it).
func TestFeedInLimitReachesTheSetpointAsALivePlantCap(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)
	fr := addFronius(t, a, 1, 27)
	a.curtailMu.Lock()
	a.curtailCert[curtailUnitKey(fr.Connection)] = true
	a.curtailMu.Unlock()

	now := time.Now().UTC()
	limit := 30.0
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, nil, &limit)
	a.mu.Unlock()

	// A charging car: 40 kW of PV against a 15 kW house -> 25 kW exported, room
	// to spare. The cap is armed but does not hold the plant back.
	observe(a, now, -25, 40)
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "setpoint with a live plant cap", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, has := m["pv_limit_kw"]
		return has
	})
	roomy, _ := setpointPvLimit(t, sub)
	if roomy < 40 {
		t.Fatalf("with 5 kW of headroom the cap must not hold the plant back, got %.2f kW", roomy)
	}
	g := a.State.Get().ExportGuard
	if g == nil || g.State != string(guards.ExportWatching) || g.Reason == "" {
		t.Fatalf("expected a watching, reasoned guard state, got %+v", g)
	}
	if !g.Effective || g.Reach != "" {
		t.Fatalf("a released unit with the kill-switch on must be effective: %+v", g)
	}

	// The car is unplugged: the same 40 kW of PV now meets a 4 kW house, so
	// 36 kW leave the site. The cap must come down BELOW what the plant is
	// producing, and the state must say it is regulating.
	now = now.Add(10 * time.Second)
	observe(a, now, -36, 40)
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the tightened cap", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		v, has := m["pv_limit_kw"].(float64)
		return has && v != roomy
	})
	tight, ok := setpointPvLimit(t, sub)
	if !ok {
		t.Fatalf("the cap disappeared exactly when it was needed")
	}
	if tight >= 40 {
		t.Fatalf("the cap did not pull the producers back: %.2f kW", tight)
	}
	// Steady state after the cap lands: pv = cap, house 4 kW -> export must be
	// at or below the limit.
	if tight-4 > limit+1e-6 {
		t.Fatalf("cap %.2f kW with a 4 kW house still exports %.2f kW", tight, tight-4)
	}
	g = a.State.Get().ExportGuard
	if g == nil || g.State != string(guards.ExportLimiting) {
		t.Fatalf("expected the guard to report regulating, got %+v", g)
	}
	if g.CapKw == nil || *g.CapKw != tight {
		t.Fatalf("the reported cap must be the published one (%v vs %.3f)", g.CapKw, tight)
	}
}

// COMPOSITION: the watchdog and the plan's own curtailment (negative price /
// FK1) compose most-restrictive-wins. The watchdog may never release a planned
// curtailment.
func TestPlannedCurtailmentWinsWhenItIsStricterAndIsNeverWidened(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	limit := 30.0
	planned := 5.0 // the optimizer wants the plant down to 5 kW (negative price)
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, &planned, &limit)
	a.mu.Unlock()
	// Plenty of room at the connection point - the watchdog alone would allow
	// far more than 5 kW.
	observe(a, now, +2, 8)
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "setpoint", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, has := m["pv_limit_kw"]
		return has
	})
	got, _ := setpointPvLimit(t, sub)
	if got != planned {
		t.Fatalf("the stricter PLANNED curtailment must win, got %.3f kW", got)
	}

	// And the other way round: when the watchdog is stricter, IT wins.
	now = now.Add(10 * time.Second)
	loose := 40.0
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, &loose, &limit)
	a.mu.Unlock()
	observe(a, now, -38, 42)
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "the watchdog cap", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		v, has := m["pv_limit_kw"].(float64)
		return has && v != planned
	})
	got, _ = setpointPvLimit(t, sub)
	if got >= loose {
		t.Fatalf("the stricter WATCHDOG must win, got %.3f kW", got)
	}
}

// Without a configured limit nothing changes at all: no cap is invented, and a
// plan without the field publishes byte-for-byte what it did before.
func TestWithoutAConfiguredLimitNothingIsCappedAndNoGuardIsClaimed(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)

	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, nil, nil)
	a.mu.Unlock()
	observe(a, now, -38, 42) // wildly over any plausible limit
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "setpoint", func() bool {
		_, ok := sub.latest()
		return ok
	})
	if v, ok := setpointPvLimit(t, sub); ok {
		t.Fatalf("a site without a feed-in limit must carry no cap, got %.3f kW", v)
	}
	if g := a.State.Get().ExportGuard; g != nil {
		t.Fatalf("no limit must claim no guard state, got %+v", g)
	}
}

// ⚠ THE SAFETY-CRITICAL STATEMENT. The operator is preparing to disconnect the
// customer's own controller, so a watchdog that computes a cap and writes it
// NOWHERE must say so - it is not a protection.
func TestAWatchdogThatCannotReachADeviceSaysSoLoudly(t *testing.T) {
	now := time.Now().UTC()
	limit := 30.0

	check := func(t *testing.T, name string, setup func(*Agent), wantEffective bool, wantIn string) {
		t.Helper()
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		cfg.ControlEnabled = true
		a, _ := startBusOnlyAgent(t, cfg)
		setup(a)
		a.mu.Lock()
		a.currentPlan = exportPlan(now, 0, nil, &limit)
		a.mu.Unlock()
		observe(a, now, -20, 24)
		a.applySetpoint(now)
		g := a.State.Get().ExportGuard
		if g == nil {
			t.Fatalf("%s: expected a guard state", name)
		}
		if g.Effective != wantEffective {
			t.Fatalf("%s: effective=%v, want %v (reach %q)", name, g.Effective, wantEffective, g.Reach)
		}
		if wantIn != "" && !contains(g.Reach, wantIn) {
			t.Fatalf("%s: reach %q does not name %q", name, g.Reach, wantIn)
		}
		// The cap is computed either way - the honesty is in the statement, not
		// in withholding the number.
		if g.CapKw == nil {
			t.Fatalf("%s: the cap must still be computed", name)
		}
	}

	check(t, "no curtailable inverter", func(a *Agent) {}, false, "kein abregelbarer Wechselrichter")
	check(t, "no released unit", func(a *Agent) {
		addFronius(t, a, 1, 27)
	}, false, "Kein Wechselrichter ist für die Abregelung freigegeben")
	check(t, "kill-switch off", func(a *Agent) {
		fr := addFronius(t, a, 1, 27)
		a.curtailMu.Lock()
		a.curtailCert[curtailUnitKey(fr.Connection)] = true
		a.curtailMu.Unlock()
		a.Cfg.ControlEnabled = false
	}, false, "Not-Aus")
	// PARTIAL reach is effective, but it is still stated: an unreleased unit
	// cannot be pulled back and only counts as uncontrollable generation.
	check(t, "one of two released", func(a *Agent) {
		fr1 := addFronius(t, a, 1, 27)
		addFronius(t, a, 2, 27)
		a.curtailMu.Lock()
		a.curtailCert[curtailUnitKey(fr1.Connection)] = true
		a.curtailMu.Unlock()
	}, true, "1 von 2")
}

// The heartbeat carries the SAME verdict the device page shows - never a second
// derivation, so the two can not word one state differently.
func TestTheHeartbeatCarriesTheWatchdogVerdictVerbatim(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, _ := startBusOnlyAgent(t, cfg)
	fr := addFronius(t, a, 1, 27)
	a.curtailMu.Lock()
	a.curtailCert[curtailUnitKey(fr.Connection)] = true
	a.curtailMu.Unlock()

	now := time.Now().UTC()
	limit := 30.0
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, nil, &limit)
	a.mu.Unlock()
	observe(a, now, -36, 40)
	a.applySetpoint(now)

	sum := a.curtailmentSummary()
	if sum == nil || sum.ExportGuard == nil {
		t.Fatalf("expected an export_guard block in the curtailment heartbeat, got %+v", sum)
	}
	g := a.State.Get().ExportGuard
	eg := sum.ExportGuard
	if eg.State != g.State || eg.Reason != g.Reason || eg.LimitKw != g.LimitKw ||
		eg.Effective != g.Effective || eg.Reach != g.Reach {
		t.Fatalf("heartbeat and device page disagree:\n page %+v\n beat %+v", g, eg)
	}
	if eg.CapKw == nil || g.CapKw == nil || *eg.CapKw != *g.CapKw {
		t.Fatalf("cap mismatch: %v vs %v", eg.CapKw, g.CapKw)
	}
}

// A box that has never measured its connection point starts CAPPED, not free -
// the compliance inversion of the "never regulate blind" rule.
func TestABoxWithoutAnyReadingStillStatesTheSafeCap(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, _ := startBusOnlyAgent(t, cfg)
	addFronius(t, a, 1, 27)

	now := time.Now().UTC()
	limit := 30.0
	// A cached plan from before the reboot: STALE, so no slot executes - but its
	// feed-in limit survives staleness on purpose (a dead optimizer must never
	// hand a plant back its unlimited feed-in).
	stale := exportPlan(now, 0, nil, &limit)
	stale.ReceivedAt = now.Add(-2 * plan.StaleAfter)
	a.mu.Lock()
	a.currentPlan = stale
	// No reading at all - the branch that publishes nothing.
	a.lastReading = guards.Reading{
		SocPct: guards.Unknown(), PvKw: guards.Unknown(),
		LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown(),
	}
	a.mu.Unlock()
	a.applySetpoint(now)

	s := a.State.Get()
	if s.Mode != state.ModeNoReading {
		t.Fatalf("expected the no-reading branch, got mode %q", s.Mode)
	}
	g := s.ExportGuard
	if g == nil || g.State != string(guards.ExportSafeCap) {
		t.Fatalf("expected the safe cap without a measurement, got %+v", g)
	}
	if g.CapKw == nil || *g.CapKw != limit {
		t.Fatalf("expected the safe static cap %.1f, got %v", limit, g.CapKw)
	}
	if !g.Blind || g.Reason == "" {
		t.Fatalf("a blind verdict must be flagged and named: %+v", g)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
