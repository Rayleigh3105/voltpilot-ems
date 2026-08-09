package desired

// Real-wall-clock reproduction of the rig's C3 sequence (small scale): a rod
// runs, its window ends (withdraw -> failsafe off), and after the Mindestpause
// a NEW plan wish must go through on a periodic Tick - no fake clock, the
// exact semantics the compose rig exercises.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

func TestRestartAfterFailsafeReleasesOnRealTimeTicks(t *testing.T) {
	if testing.Short() {
		t.Skip("real-time test")
	}
	rod := rodEntity()
	rod.Guards.Limits.MinOffSeconds = f64(2) // compressed Mindestpause
	rod.Guards.Limits.MinOnSeconds = nil

	var commands []published
	arb := New(Deps{
		Now:            time.Now,
		ControlEnabled: func() bool { return true },
		PublishCommand: func(id string, p []byte) { commands = append(commands, published{id, p}) },
	})
	arb.SetEntities(entities.Registry{Revision: "rt", Entities: []entities.Entity{rod}})

	on := true
	submit := func() {
		v := on
		arb.SubmitInternal(&Desired{
			EntityID:  "rod-1",
			RequestID: "plan:rt:" + time.Now().Format(time.RFC3339Nano),
			Source:    Source{Kind: SourcePlanExecutor},
			Priority:  ClassMarket,
			TTL:       time.Minute,
			IssuedAt:  time.Now(),
			Commands:  entities.Commands{OnOff: &v},
		})
	}

	lastOnOff := func() (bool, bool) {
		for i := len(commands) - 1; i >= 0; i-- {
			if commands[i].entity != "rod-1" || commands[i].payload == nil {
				continue
			}
			var m struct {
				Commands struct {
					OnOff *bool `json:"on_off"`
				} `json:"commands"`
			}
			if err := json.Unmarshal(commands[i].payload, &m); err != nil || m.Commands.OnOff == nil {
				continue
			}
			return *m.Commands.OnOff, true
		}
		return false, false
	}

	// 1. Run.
	submit()
	if v, ok := lastOnOff(); !ok || !v {
		t.Fatalf("initial run refused: %v %v", v, ok)
	}
	// 2. Window ends: withdraw -> failsafe off.
	arb.Withdraw("rod-1", Source{Kind: SourcePlanExecutor}.Key(), false)
	if v, ok := lastOnOff(); !ok || v {
		t.Fatalf("failsafe off missing: %v %v", v, ok)
	}
	// 3. Immediately wish ON again: held (Mindestpause).
	submit()
	if v, _ := lastOnOff(); v {
		t.Fatal("Mindestpause violated on the immediate restart")
	}
	// 4. Standing wish + periodic ticks (the arbitrationLoop cadence): after
	//    the pause the wish must go through.
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		submit() // the plan executor re-injects every tick
		arb.Tick()
		if v, _ := lastOnOff(); v {
			return // released - the rig expectation
		}
		time.Sleep(200 * time.Millisecond)
	}
	dec, ok := arb.DecisionFor("rod-1")
	t.Fatalf("restart never released after the pause; decision=%+v ok=%v", dec, ok)
}

