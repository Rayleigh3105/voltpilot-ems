package agent

// AP-15 IP-19, agent half: the held share reaches the Bezugswaechter on the
// setpoint path (above the arbitration, after every clamp) and its stage the
// heartbeat. The guard itself is proven in lastmgmt/bezuganteil_test.go and
// guards/bezuganteil_test.go.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// V3 on the published setpoint: the plan charges the battery with 50 kW and
// allows the grid for it; Box Halle 1 holds a share and knows no connection
// limit (no charge park), so it charges only from its own 12 kW of PV - never
// from the grid. The same plan
// without a document is published untouched, and the heartbeat carries the
// stage only with the document.
func TestV3FuehrendeBoxLaedtOhneBekannteGrenzeNichtAusDemNetz(t *testing.T) {
	run := func(cfg config.Config) (float64, *Agent) {
		a, addr := startBusOnlyAgent(t, cfg)
		sub := subscribeSetpoint(t, addr)
		now := time.Now().UTC()
		a.mu.Lock()
		p := exportPlan(now, 50, nil, nil)
		netz := true // the plan allows charging from the grid (no EEG clamp)
		p.GridChargeAllowed = &netz
		a.currentPlan = p
		a.lastReading = guards.Reading{SocPct: 50, PvKw: 12, LoadKw: 30, GridLimitKw: guards.Unknown()}
		a.lastReadingAt = now
		a.mu.Unlock()
		a.applySetpoint(now)
		waitFor(t, 5*time.Second, "setpoint", func() bool { _, ok := sub.latest(); return ok })
		// once more, so a start-up tick of the agent's own loop (no plan yet)
		// cannot be the last word on the stage
		a.applySetpoint(now)
		m, _ := sub.latest()
		return m["battery_setpoint_kw"].(float64), a
	}
	kw, a := run(halle1Cfg(t, "fuehrt"))
	if kw != 12 {
		t.Fatalf("with the share: charge only the own PV of 12 kW, got %.3f", kw)
	}
	if b := a.gemeinsameSteuerung(); b == nil || b.Waechter == nil || b.Waechter.Bezug != string(guards.ExportSafeCap) {
		t.Fatalf("heartbeat: want waechter.bezug sicherheitskappe, got %+v", b)
	}

	ohne := config.Defaults()
	ohne.DataDir = t.TempDir()
	ohne.ControlEnabled = true
	ohne.MaxChargeKw, ohne.MaxDischargeKw = 100, 100
	kw, a = run(ohne)
	if kw != 50 {
		t.Fatalf("without a document the plan's charge is untouched: got %.3f", kw)
	}
	if a.bezugStufe() != "" {
		t.Fatal("without a document there is no Bezug stage")
	}
}

// The role is optional in the document. Without it the box holds its share
// like steuert_mit - the safe side, as IP-18 decided it.
func TestOhneRolleHaeltDieBoxIhrenBezugsanteilWieMitsteuernd(t *testing.T) {
	for rolle, fuehrt := range map[string]bool{"fuehrt": true, "steuert_mit": false, "": false} {
		a := anteilAgent(t, t.TempDir())
		quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 1, "40.0", "60.0", rolle), time.Now()), true, "", 1)
		an := a.bezugAnteil()
		if an == nil || an.AnteilKw != 77 || an.Fuehrt != fuehrt {
			t.Fatalf("rolle %q: %+v", rolle, an)
		}
		// no stage is invented before the guard decided anything - the
		// restarted heartbeat of IP-17 stays exactly what it was
		if a.bezugStufe() != "" {
			t.Fatalf("rolle %q: stage %q before any decision, want none", rolle, a.bezugStufe())
		}
		lade := guards.ExportLimiting
		a.setBezugStufe(&lade, nil)
		if a.bezugStufe() != string(guards.ExportLimiting) {
			t.Fatalf("rolle %q: stage %q after a decision", rolle, a.bezugStufe())
		}
	}
	if (&Agent{State: state.New("", "")}).bezugAnteil() != nil {
		t.Fatal("without a document there is no share - today's budget")
	}
}
