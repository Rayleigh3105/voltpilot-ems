package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// „Sonne + Speicher" on a box whose Layer 1 only READS the battery - Edge
// Light today (edge-light/docs/paritaet.md, C: Deye-Steuerung offen). The Go
// Layer 1 publishes edge/telemetry but never edge/control/readback, so the
// battery executor never sees a held readback. Same site, same plan, same
// measurements as on a Docker box whose Layer 1 confirms the readback; the
// readiness comes from the REAL applySetpoint, not from a hand-set note.
func TestSonneSpeicherReleasesNothingWithoutAHeldReadback(t *testing.T) {
	cases := map[string]struct {
		heldReadback bool
		wantMode     lastmgmt.ReleaseMode
		wantKw       float64
	}{
		"Docker-Box: Schicht 1 bestätigt die Rücklesung": {true, lastmgmt.ReleaseActive, 8},
		"Edge Light: Schicht 1 liest nur":                {false, lastmgmt.ReleaseBatteryPath, 3},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a, _ := releaseCoverAgent(t)
			releaseHome(t, a, lastmgmt.StorageBeforeCars)
			s1 := releaseStation(t, a, "GOE-1")
			floor := 30.0
			for i := 0; i < 4; i++ {
				now := time.Now().UTC()
				a.mu.Lock()
				a.currentPlan = releasePlan(now, &floor)
				// SoC 80 % against a 30-% floor; PV 4 kW, house 1 kW.
				a.lastReading = guards.Reading{SocPct: 80, PvKw: 4, LoadKw: 1, GridLimitKw: guards.Unknown()}
				a.lastReadingAt = now
				a.mu.Unlock()
				if c.heldReadback {
					a.State.Update(func(s *state.Snapshot) {
						s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
					})
				}
				a.applySetpoint(now)
				batt := 0.0
				if drawOf(s1, 1)() > 3.5 {
					batt = -(drawOf(s1, 1)() - 3)
				}
				measureSurplus(t, a, 1, 4, batt, s1)
				a.ocppStep(context.Background())
			}
			nearKwSoon(t, "what the car may draw", drawOf(s1, 1), c.wantKw)
			v, _ := a.ocpp.release.Last()
			if v.Mode != c.wantMode {
				t.Fatalf("mode %q (%s), want %q", v.Mode, v.Reason, c.wantMode)
			}
			if !c.heldReadback && !strings.Contains(v.Reason, "ohne bestätigte Rückmeldung") {
				t.Fatalf("the reason names the missing readback: %q", v.Reason)
			}
		})
	}
}
