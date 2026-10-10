package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The steering state in the heartbeat (`battery_control`, contract
// docs/contracts/speicher-steuerstand.md). The optimizer plans an observed
// battery as self-consumption instead of trading with it, so the word must
// mean exactly what the box does - these tests bind it to the shared vectors
// and to the SAME gate the „Sonne + Speicher" readiness reads.

type steuerstandVectors struct {
	States []string `json:"states"`
	Box    []struct {
		Name           string `json:"name"`
		Steuerschalter bool   `json:"steuerschalter"`
		Certified      bool   `json:"certified"`
		Wechselrichter bool   `json:"wechselrichter"`
		Block          *struct {
			State          string `json:"state"`
			ControlEnabled bool   `json:"control_enabled"`
			Certified      bool   `json:"certified"`
		} `json:"block"`
	} `json:"box"`
}

func loadSteuerstandVectors(t *testing.T) steuerstandVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts",
		"speicher-steuerstand-vectors.json"))
	if err != nil {
		t.Fatalf("shared vectors: %v", err)
	}
	var v steuerstandVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("shared vectors: %v", err)
	}
	if len(v.Box) == 0 {
		t.Fatal("shared vectors: no box cases")
	}
	return v
}

func TestTheBatteryControlWordsAreTheSharedVocabulary(t *testing.T) {
	v := loadSteuerstandVectors(t)
	want := []string{batteryControlCommanded, batteryControlObserved, batteryControlStopped}
	if strings.Join(v.States, ",") != strings.Join(want, ",") {
		t.Fatalf("states %v, the box speaks %v", v.States, want)
	}
}

// Every `box` case through the REAL agent: the inverter selection, the
// kill-switch and the env allowlist are set the way an operator sets them,
// and the block is what the heartbeat would carry.
func TestTheBatteryControlBlockFollowsTheSharedVectors(t *testing.T) {
	for _, c := range loadSteuerstandVectors(t).Box {
		t.Run(c.Name, func(t *testing.T) {
			cfg := config.Defaults()
			cfg.DataDir = t.TempDir()
			cfg.ControlEnabled = c.Steuerschalter
			a, _ := startBusOnlyAgent(t, cfg)
			if c.Wechselrichter {
				selectDeyeFamily(t, a, "sun-12k-sg04lp3")
				if c.Certified {
					a.Cfg.ControlCertifiedFamilies = append(a.Cfg.ControlCertifiedFamilies, a.currentFamily())
				}
				if got := a.controlCertified(a.currentFamily()); got != c.Certified {
					t.Fatalf("precondition: certified %v, want %v", got, c.Certified)
				}
			}
			got := a.batteryControlSummary()
			if c.Block == nil {
				if got != nil {
					t.Fatalf("no inverter selected must send NO block, got %+v", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("block missing")
			}
			if got.State != c.Block.State || got.ControlEnabled != c.Block.ControlEnabled ||
				got.Certified != c.Block.Certified {
				t.Fatalf("block %+v, want %+v", *got, *c.Block)
			}
			if pure := batteryControlState(c.Steuerschalter, c.Certified); pure != c.Block.State {
				t.Fatalf("batteryControlState = %q, want %q", pure, c.Block.State)
			}
		})
	}
}

// The heartbeat word and the „Sonne + Speicher" readiness read the SAME gate:
// a battery the heartbeat calls observed is the one the release path treats as
// observed, and the commanded one is the one that may become ready. Otherwise
// the optimizer would plan self-consumption for a battery the box commands
// with a trading plan in mind - or the other way round.
func TestTheHeartbeatWordAndTheReleasePathReadTheSameGate(t *testing.T) {
	cases := []struct {
		name         string
		certify      bool
		killSwitch   bool
		wantState    string
		wantReady    bool
		wantObserved bool
		wantNote     string
	}{
		{"freigegebener Deye, Rücklesung bestätigt", true, true, batteryControlCommanded, true, false, ""},
		{"Deye ohne Freigabe, Rücklesung vorhanden (wie Docker-Box)", false, true,
			batteryControlObserved, false, true, ""},
		{"Not-Aus", true, false, batteryControlStopped, false, false, "Not-Aus"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Cfg is fixed at start-up: the OCPP loop reads it without a lock
			// (ocppControlAllowed), so the kill-switch and the allowlist are set
			// before startOcpp - never on the running agent.
			a, _ := releaseCoverAgent(t, func(a *Agent) {
				a.Cfg.ControlEnabled = c.killSwitch
				selectDeyeFamily(t, a, "sun-12k-sg04lp3")
				if c.certify {
					a.Cfg.ControlCertifiedFamilies = append(a.Cfg.ControlCertifiedFamilies, a.currentFamily())
				}
			})
			now := time.Now().UTC()
			floor := 30.0
			a.mu.Lock()
			a.currentPlan = releasePlan(now, &floor)
			a.lastReading = guards.Reading{SocPct: 80, PvKw: 4, LoadKw: 1, GridLimitKw: guards.Unknown()}
			a.lastReadingAt = now
			a.mu.Unlock()
			a.State.Update(func(s *state.Snapshot) {
				s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
			})
			a.applySetpoint(now)
			ok, observed, note := a.releaseReady.get(now, a.releaseReadyWindow())
			if ok != c.wantReady || observed != c.wantObserved || !strings.Contains(note, c.wantNote) {
				t.Fatalf("release path: ready %v observed %v note %q", ok, observed, note)
			}
			got := a.batteryControlSummary()
			if got == nil || got.State != c.wantState {
				t.Fatalf("heartbeat word %+v, want %q", got, c.wantState)
			}
			// control_enabled is the value edge/setpoint carried on this very
			// tick - the two may never disagree.
			if snap := a.State.Get(); snap.ControlEnabled != got.ControlEnabled ||
				snap.ControlCertified != got.Certified {
				t.Fatalf("heartbeat %+v, setpoint gate enabled %v certified %v",
					*got, snap.ControlEnabled, snap.ControlCertified)
			}
		})
	}
}
