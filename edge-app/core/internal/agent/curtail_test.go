package agent

// PV-curtailment (Fronius Increment 3) core tests: the setpoint's additive
// `curtail` block (kill-switch, uncontrollable share, per-unit grants/tests),
// the curtail readback routing into per-unit snapshot state + the heartbeat
// capability block, and the per-unit First-Light certification journey with
// its evidence gate + persistence.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// addFronius adds one fronius_sunspec Erzeuger unit behind the shared
// Pilsting-style gateway IP.
func addFronius(t *testing.T, a *Agent, unitID int, capacityKwp float64) sources.Source {
	t.Helper()
	src, err := a.AddSource(sources.Request{
		Role:        sources.RoleErzeuger,
		Brand:       inverter.BrandFroniusSunSpec,
		Model:       "fronius-eco-25-3-s",
		Connection:  inverter.Connection{IP: "192.168.210.40", UnitID: unitID},
		CapacityKwp: capacityKwp,
	})
	if err != nil {
		t.Fatalf("AddSource(fronius unit %d): %v", unitID, err)
	}
	return src
}

func setSiteReading(a *Agent, pvKw float64) {
	a.mu.Lock()
	a.lastReading = guards.Reading{
		SocPct: guards.Unknown(), PvKw: pvKw,
		LoadKw: 5, GridLimitKw: guards.Unknown(),
	}
	a.mu.Unlock()
}

func TestSetpointCarriesTheCurtailBlockWithUncontrolledShareAndPerUnitGrants(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)

	fr1 := addFronius(t, a, 1, 25)
	fr2 := addFronius(t, a, 2, 30)

	// The two Fronius deliver 10 + 15 kW; the composite site PV is 37 kW, so
	// the uncontrollable share (the Deye hybrid) is 12 kW.
	feedSource(a, fr1.ID, 10)
	feedSource(a, fr2.ID, 15)
	setSiteReading(a, 37)

	sub := subscribeSetpoint(t, addr)
	pv := 30.0
	a.mu.Lock()
	a.currentPlan = freshPlan(time.Now().UTC(), 0, &pv)
	a.mu.Unlock()
	a.applySetpoint(time.Now().UTC())

	waitFor(t, 5*time.Second, "setpoint with curtail block", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, has := m["curtail"]
		return has
	})
	m, _ := sub.latest()
	cur := m["curtail"].(map[string]any)
	if cur["control_enabled"] != true {
		t.Fatalf("curtail.control_enabled must be the RAW kill-switch: %v", cur)
	}
	if got := cur["pv_uncontrolled_kw"].(float64); got != 12 {
		t.Fatalf("pv_uncontrolled = site 37 - fronius (10+15) = 12, got %v", got)
	}
	srcs := cur["sources"].([]any)
	if len(srcs) != 2 {
		t.Fatalf("both units listed, got %v", srcs)
	}
	for _, e := range srcs {
		entry := e.(map[string]any)
		if entry["certified"] != false {
			t.Fatalf("no unit is certified yet: %v", entry)
		}
		if _, hasTest := entry["test"]; hasTest {
			t.Fatalf("no test armed: %v", entry)
		}
	}

	// The primary inverter's certification gate must NOT leak into the curtail
	// block: the top-level control_enabled may be false (uncertified primary)
	// while curtail.control_enabled stays the raw kill-switch.
	if m["control_enabled"] != true { // no inverter selected -> certified -> true
		t.Fatalf("precondition: %v", m["control_enabled"])
	}

	// A site without curtailment-capable sources gets NO curtail block.
	cfg2 := config.Defaults()
	cfg2.DataDir = t.TempDir()
	b, err := New(cfg2)
	if err != nil {
		t.Fatal(err)
	}
	if extras := b.curtailSetpointExtras(time.Now().UTC()); extras != nil {
		t.Fatalf("no fronius sources -> no curtail block, got %v", extras)
	}
}

func TestCurtailReadbackRoutesToPerUnitStateAndHeartbeatCapability(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	fr1 := addFronius(t, a, 1, 25)
	fr2 := addFronius(t, a, 2, 30)

	cap1, cap2 := 8.2, 9.8
	match := true
	mk := func(src sources.Source, unit int, capKw float64, override bool) []byte {
		payload := map[string]any{
			"ts": time.Now().UTC().Format(time.RFC3339Nano), "curtail": true,
			"source_id": src.ID, "unit_key": "192.168.210.40:502#" + map[int]string{1: "1", 2: "2"}[unit],
			"label": src.Label, "target": "192.168.210.40:502 (Unit 1)", "family": "fronius_sunspec",
			"control_enabled": true, "certified": true, "mode": "apply", "applied": true,
			"cap_kw": capKw, "rated_kw": 25.0, "all_match": match, "mismatch_roles": []string{},
			"registers": []map[string]any{{
				"role": "pv_limit_pct", "fc": 3, "addr": 40241, "commanded_raw": 3273,
				"actual_raw": 3273, "match": true, "commanded_kw": capKw, "actual_kw": capKw,
			}},
		}
		if override {
			payload["enforcement"] = map[string]any{
				"status": "possible_override", "possible_override": true,
				"reason": "Der Wechselrichter liefert 20 kW trotz Begrenzung", "measured_kw": 20.0,
			}
		} else {
			payload["enforcement"] = map[string]any{"status": "ok", "possible_override": false, "measured_kw": capKw - 1}
		}
		raw, _ := json.Marshal(payload)
		return raw
	}

	// Routed off the SHARED control-readback topic by the curtail discriminator.
	a.onControlReadback("", mk(fr1, 1, cap1, false))
	a.onControlReadback("", mk(fr2, 2, cap2, true))

	snap := a.State.Get()
	if snap.Control != nil {
		t.Fatalf("a curtail readback must NEVER clobber the primary control state")
	}
	if len(snap.CurtailUnits) != 2 {
		t.Fatalf("two units expected, got %+v", snap.CurtailUnits)
	}
	u2 := snap.CurtailUnits[1]
	if !u2.PossibleOverride || u2.EnforcementStatus != "possible_override" {
		t.Fatalf("override must surface: %+v", u2)
	}
	if u2.AllMatch == nil || !*u2.AllMatch || !u2.Applied {
		t.Fatalf("applied + matched expected: %+v", u2)
	}

	// The heartbeat capability block: gates from the CORE (units, certified
	// counts, kill-switch), observations from the readbacks.
	sum := a.curtailmentSummary()
	if sum == nil || sum.Units != 2 || sum.CertifiedUnits != 0 {
		t.Fatalf("capability counts from the core: %+v", sum)
	}
	if !sum.Active || sum.AllMatch == nil || !*sum.AllMatch || !sum.PossibleOverride {
		t.Fatalf("observations from the readbacks: %+v", sum)
	}
	if sum.AppliedCapKw == nil || *sum.AppliedCapKw != 18 {
		t.Fatalf("applied cap = 8.2 + 9.8 = 18, got %+v", sum.AppliedCapKw)
	}

	// A site with no units yields NO block (an older portal sees nothing new).
	b, _ := New(config.Config{DataDir: t.TempDir(), LocalMQTTAddr: "127.0.0.1:0"})
	if b.curtailmentSummary() != nil {
		t.Fatal("no units -> nil curtailment block")
	}
}

func TestCurtailFirstLightJourneyEvidenceGatePersistenceAndRevocation(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)
	fr1 := addFronius(t, a, 1, 25)
	key := "192.168.210.40:502#1"

	// Kill-switch off refuses the test outright.
	a.Cfg.ControlEnabled = false
	if _, err := a.CurtailStartTest(fr1.ID); err == nil {
		t.Fatal("kill-switch off must refuse the curtailment test")
	}
	a.Cfg.ControlEnabled = true

	// No fresh reading -> refused.
	if _, err := a.CurtailStartTest(fr1.ID); err == nil {
		t.Fatal("no fresh reading must refuse the test")
	}

	// Unit delivers 21.4 kW -> test cap 17.1 (80 %), and the test rides the
	// retained setpoint so the flow executes it.
	feedSource(a, fr1.ID, 21.4)
	setSiteReading(a, 21.4)
	sub := subscribeSetpoint(t, addr)
	v, err := a.CurtailStartTest(fr1.ID)
	if err != nil {
		t.Fatalf("start test: %v", err)
	}
	if v.Units[0].Test == nil || v.Units[0].Test.CapKw != 17.1 {
		t.Fatalf("test cap 80%% of 21.4 = 17.1: %+v", v.Units[0].Test)
	}
	waitFor(t, 5*time.Second, "setpoint carries the armed test", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		cur, ok := m["curtail"].(map[string]any)
		if !ok {
			return false
		}
		srcs := cur["sources"].([]any)
		if len(srcs) == 0 {
			return false
		}
		test, ok := srcs[0].(map[string]any)["test"].(map[string]any)
		return ok && test["cap_kw"] == 17.1
	})

	// Certification is refused before ANY evidence.
	if _, err := a.CurtailCertify(fr1.ID); err == nil {
		t.Fatal("no evidence -> certify must refuse")
	}

	// The register half: an applied, fully matched CALIBRATION readback.
	match := true
	raw, _ := json.Marshal(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339Nano), "curtail": true,
		"source_id": fr1.ID, "unit_key": key, "calibration": true,
		"control_enabled": true, "certified": false, "mode": "apply", "applied": true,
		"cap_kw": 17.1, "all_match": match,
		"registers": []map[string]any{{"role": "pv_limit_pct", "addr": 40241, "commanded_raw": 100, "actual_raw": 100, "match": true}},
	})
	a.onControlReadback("", raw)

	// Register alone is NOT enough (Fronius may silently override): still refused.
	if _, err := a.CurtailCertify(fr1.ID); err == nil {
		t.Fatal("register-only evidence must not certify (no observed drop)")
	}

	// The enforcement half: the measured output drops to the cap.
	feedSource(a, fr1.ID, 16.9)
	v2, err := a.CurtailCertify(fr1.ID)
	if err != nil {
		t.Fatalf("evidence complete -> certify: %v", err)
	}
	if !v2.Units[0].Certified {
		t.Fatalf("unit must be certified: %+v", v2.Units[0])
	}
	if !a.curtailCertified(key) {
		t.Fatal("grant must be recorded under the PHYSICAL unit key")
	}

	// Persisted: a fresh agent over the same data dir restores the grant.
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !b.curtailCertified(key) {
		t.Fatal("grant must survive a restart (curtail-certified.json)")
	}

	// The setpoint now carries certified:true for the unit.
	a.nudgeSetpoint()
	waitFor(t, 5*time.Second, "setpoint carries the grant", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		cur, ok := m["curtail"].(map[string]any)
		if !ok {
			return false
		}
		srcs := cur["sources"].([]any)
		return len(srcs) > 0 && srcs[0].(map[string]any)["certified"] == true
	})

	// Revocation persists too.
	if _, err := a.CurtailDecertify(fr1.ID); err != nil {
		t.Fatalf("decertify: %v", err)
	}
	if a.curtailCertified(key) {
		t.Fatal("grant must be revoked")
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if c.curtailCertified(key) {
		t.Fatal("revocation must survive a restart")
	}
}
