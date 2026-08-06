package agent

// Agent-level wiring tests for the guided Neutral-Zeit-Test
// (docs/ota-autonomie.md §3, internal/neutralcal): the bounded write on
// edge/setpoint during the active phase, going COMPLETELY SILENT once the
// departure is confirmed, the interlock safety net, and the persisted
// per-family evidence file otaapply.NeutralTable.ForWithMeasured consults.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/calibration"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/neutralcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
)

// neutralReadback builds one "landed" control readback for the neutral-time
// test's departure command, exactly like the flow's executor would send it.
func neutralReadback(now time.Time, held bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"ts": now.Format(time.RFC3339), "family": "hybrid_3p", "source": "neutral_test",
		"mode": "normal", "all_match": held,
		"registers": []map[string]any{{"role": "battery_power", "match": held}},
	})
	return raw
}

func TestNeutralOverrideWritesTheDepartureThenGoesCompletelySilent(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a) // uncertified - the calibration-style bypass must still let it through
	sub := subscribeSetpoint(t, addr)

	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	start := time.Now().UTC()
	if _, err := a.NeutralStartTest(); err != nil {
		t.Fatalf("NeutralStartTest: %v", err)
	}

	a.applySetpoint(start.Add(time.Second))
	waitFor(t, 5*time.Second, "neutral-test active setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "neutral_test" && m["calibration"] == true
	})
	m, _ := sub.latest()
	if kw := m["battery_setpoint_kw"].(float64); kw != neutralcal.TestKw {
		t.Fatalf("commanded departure = %v, want %v", kw, neutralcal.TestKw)
	}
	if m["control_enabled"] != true {
		t.Fatal("the global kill-switch is on, so the bounded departure must still write")
	}
	if m["grid_charge_allowed"] != false {
		t.Fatal("a neutral-time test must never grid-charge")
	}

	// Confirm the write landed, then observe the departure (the tests's own
	// "away from neutral" measurement).
	a.onControlReadback("", neutralReadback(start.Add(2*time.Second), true))
	at := start.Add(3 * time.Second)
	for i := 0; i < neutralcal.DepartureSamples; i++ {
		at = at.Add(5 * time.Second)
		a.neutralObserve(neutralcal.TestKw, at)
	}

	before, ok := sub.latest()
	if !ok {
		t.Fatal("must have a retained message by now")
	}
	// SILENT phase: further setpoint ticks must publish NOTHING - the whole
	// mechanism. The subscriber's "latest" therefore stays exactly the same.
	a.applySetpoint(at.Add(5 * time.Second))
	a.applySetpoint(at.Add(10 * time.Second))
	time.Sleep(200 * time.Millisecond) // give any (unwanted) publish a chance to arrive
	after, _ := sub.latest()
	if !mapsEqualJSON(before, after) {
		t.Fatalf("the silent phase must publish NOTHING: before=%v after=%v", before, after)
	}
}

func mapsEqualJSON(a, b map[string]any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// A run that never confirms a departure (readings stay inside the neutral
// band) must conclude Unprovable and never certify anything.
func TestNeutralTestNeverDepartingIsUnprovableAndNeverRecordable(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	start := time.Now().UTC()
	if _, err := a.NeutralStartTest(); err != nil {
		t.Fatal(err)
	}
	a.onControlReadback("", neutralReadback(start, true))
	a.neutralObserve(0.01, start.Add(5*time.Second)) // stays inside the neutral band

	end := start.Add(neutralcal.DepartureTimeout + 2*time.Second)
	a.neutralMu.Lock()
	ev := a.neutralCal.EvidenceFor("hybrid_3p", end)
	a.neutralMu.Unlock()
	if ev == nil || ev.Verdict != neutralcal.VerdictUnprovable {
		t.Fatalf("expected VerdictUnprovable, got %+v", ev)
	}
	if _, err := a.NeutralRecord(); err == nil {
		t.Fatal("an unprovable run must never be recordable")
	}
	if recs := otaapply.LoadNeutralEvidence(cfg.DataDir); recs != nil {
		t.Fatalf("nothing may have been written to disk: %+v", recs)
	}
}

// A full pass can be recorded, and the persisted evidence is exactly what
// otaapply.NeutralTable.ForWithMeasured (and the heartbeat) will read back.
func TestNeutralTestPassIsRecordableAndFeedsTheHeartbeat(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	start := time.Now().UTC()
	if _, err := a.NeutralStartTest(); err != nil {
		t.Fatal(err)
	}
	a.onControlReadback("", neutralReadback(start, true))
	at := start
	for i := 0; i < neutralcal.DepartureSamples; i++ {
		at = at.Add(5 * time.Second)
		a.neutralObserve(neutralcal.TestKw, at)
	}
	// One AWAY reading well into silence (the conservative anchor), then a
	// confirmed settle streak.
	lastAway := at.Add(20 * time.Second)
	a.neutralObserve(neutralcal.TestKw, lastAway)
	settleAt := lastAway
	for i := 0; i < neutralcal.SettleSamples; i++ {
		settleAt = settleAt.Add(5 * time.Second)
		a.neutralObserve(0.0, settleAt)
	}

	view, err := a.NeutralRecord()
	if err != nil {
		t.Fatalf("NeutralRecord: %v", err)
	}
	if view.Recorded == nil || view.Recorded.Seconds <= 0 {
		t.Fatalf("the view must echo the persisted record: %+v", view)
	}

	recs := otaapply.LoadNeutralEvidence(cfg.DataDir)
	rec, ok := recs["hybrid_3p"]
	if !ok {
		t.Fatalf("the record must be persisted for hybrid_3p: %+v", recs)
	}
	if rec.Seconds != view.Recorded.Seconds {
		t.Fatalf("persisted seconds (%d) must match the view (%d)", rec.Seconds, view.Recorded.Seconds)
	}

	sum := a.neutralVerifiedSummary()
	if sum == nil || sum.Family != "hybrid_3p" || sum.Seconds != rec.Seconds {
		t.Fatalf("the heartbeat summary must echo the persisted record: %+v", sum)
	}

	// otaapply.NeutralTable.ForWithMeasured must now open the gate for this
	// family (no env entry configured).
	empty, err := otaapply.ParseNeutralTable("")
	if err != nil {
		t.Fatal(err)
	}
	nt := empty.ForWithMeasured("hybrid_3p", otaapply.LoadNeutralEvidence(cfg.DataDir))
	if !nt.Verified {
		t.Fatalf("the measured record must open the sidecar's gate: %+v", nt)
	}
}

// NeutralAbort must invalidate the evidence AND stop the write immediately -
// the very next tick must fall through to the normal control path.
func TestNeutralAbortStopsTheWriteAndInvalidatesEvidence(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	sub := subscribeSetpoint(t, addr)

	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown()}
	a.mu.Unlock()

	if _, err := a.NeutralStartTest(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, "neutral-test active setpoint", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == "neutral_test"
	})

	view := a.NeutralAbort()
	if view.Evidence != nil {
		t.Fatalf("an aborted test's evidence must be absent, got %+v", view.Evidence)
	}
	waitFor(t, 5*time.Second, "normal path resumes after abort", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] != "neutral_test"
	})
}

// The interlock: a pending OTA urgent neutral-park request must never
// starve behind a running Neutral-Zeit-Test - the test aborts and the tick
// falls through.
func TestNeutralTestAbortsWhenAnUrgentOtaNeutralRequestIsPending(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	start := time.Now().UTC()
	if _, err := a.NeutralStartTest(); err != nil {
		t.Fatal(err)
	}
	a.otaMu.Lock()
	a.otaNeutralReq = start
	a.otaMu.Unlock()

	handled := a.neutralTestOverride(start.Add(time.Second), guards.Reading{
		SocPct: 60, PvKw: 2, LoadKw: 3, GridLimitKw: guards.Unknown(),
	}, guards.Limits{MaxChargeKw: 5, MaxDischargeKw: 5, SocMinPct: 5, SocMaxPct: 95})
	if handled {
		t.Fatal("the neutral-time test must yield to a pending urgent OTA neutral request")
	}
	a.neutralMu.Lock()
	active := a.neutralCal.Active(start.Add(time.Second))
	a.neutralMu.Unlock()
	if active {
		t.Fatal("the test must have been aborted by the interlock")
	}
}

// Two First-Light tests can never run at once: starting a Neutral-Zeit-Test
// while a calibration test is engaged must be refused.
func TestNeutralStartRefusesWhileCalibrationIsEngaged(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	a.cal.Arm()
	if err := a.cal.StartTest(calibration.Discharge, 0.5, calibration.Reading{BatteryKw: fptr(0)}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	if _, err := a.NeutralStartTest(); err == nil {
		t.Fatal("must refuse while a calibration test is engaged")
	}
}
