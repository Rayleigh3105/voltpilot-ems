package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The shared contract vectors of the grid-side throttling slot
// (docs/contracts/v2/grid-target-vectors.json), wiring half: the WORDS this
// box puts on the local bus and on the heartbeat are the ones the api and the
// portal read. The rule half is guards/gridtarget_vectors_test.go.
type gridTargetWireVectors struct {
	Woerter    map[string]string `json:"woerter"`
	Herzschlag struct {
		Faelle []struct {
			Name      string         `json:"name"`
			Execution map[string]any `json:"execution"`
			PerUnit   map[string]any `json:"per_unit"`
		} `json:"faelle"`
	} `json:"herzschlag"`
}

func loadGridTargetWireVectors(t *testing.T) gridTargetWireVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2", "grid-target-vectors.json"))
	if err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	var v gridTargetWireVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	if len(v.Herzschlag.Faelle) == 0 || len(v.Woerter) == 0 {
		t.Fatal("the contract vectors carry no cases")
	}
	return v
}

func asJSONMap(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestGridTargetWireWordsMatchTheContract(t *testing.T) {
	v := loadGridTargetWireVectors(t)
	w := v.Woerter
	for name, got := range map[string]string{
		"battery_mode":                  batteryModeGridTarget,
		"hebel":                         guards.GridTargetLever,
		"execution_mode":                execModeGridTarget,
		"per_unit_mode":                 execModeGridTarget,
		"per_unit_quelle_des_primaeren": primarySourceID,
		"rueckmeldung_rolle_regelseite": rolePowerControlMode,
		"rueckmeldung_rolle_ziel":       roleGridPower,
	} {
		if w[name] != got {
			t.Errorf("woerter.%s = %q, the box uses %q", name, w[name], got)
		}
	}

	// The setpoint fields, on the real bus.
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	gtReadback(a, now, true, false)
	m := gtTick(t, a, sub, now)
	if m["battery_mode"] != w["battery_mode"] {
		t.Fatalf("battery_mode on the bus: %v", m["battery_mode"])
	}
	if _, ok := m[w["setpoint_ziel"]]; !ok {
		t.Fatalf("the target travels as %q: %v", w["setpoint_ziel"], m)
	}
	if m[w["setpoint_neutralschritt"]] != true {
		t.Fatalf("the neutral step travels as %q: %v", w["setpoint_neutralschritt"], m)
	}
}

// The heartbeat blocks are compared as JSON objects - exactly the keys and
// values the vector names, nothing else on the wire.
func TestGridTargetHeartbeatMatchesTheContractVectors(t *testing.T) {
	v := loadGridTargetWireVectors(t)
	floor := 20.0
	yes, no := true, false
	lever := &state.ControlInfo{NativeCapabilities: &state.NativeCapabilities{Intents: []string{"cover_load", guards.GridTargetLever}}}
	snaps := map[string]state.Snapshot{
		"belegt_auf_dem_ziel": {
			Mode: state.ModeSchedule, ControlCertified: true, Control: lever, EffectiveFloorSocPct: &floor,
			GridTarget: &state.GridTargetInfo{Active: true, Proven: true, TargetKw: 0, ReferenceKw: 5, Following: &yes},
		},
		"belegt_netz_nicht_auf_dem_ziel": {
			Mode: state.ModeSchedule, ControlCertified: true, Control: lever, EffectiveFloorSocPct: &floor,
			GridTarget: &state.GridTargetInfo{Active: true, Proven: true, TargetKw: 0, ReferenceKw: 5, Following: &no},
		},
		"absicht_noch_nicht_belegt": {
			Mode: state.ModeSchedule, ControlCertified: true, Control: lever, EffectiveFloorSocPct: &floor,
			GridTarget: &state.GridTargetInfo{Active: true, Proven: false, TargetKw: 0, ReferenceKw: 5},
		},
		"ausserhalb_des_slots": {
			Mode: state.ModeSchedule, ControlCertified: true, Control: lever, EffectiveFloorSocPct: &floor,
		},
	}
	for _, c := range v.Herzschlag.Faelle {
		snap, ok := snaps[c.Name]
		if !ok {
			t.Fatalf("no snapshot for vector case %q - a new case needs its state here", c.Name)
		}
		if got := asJSONMap(t, executionSummary(snap)); !reflect.DeepEqual(got, c.Execution) {
			t.Errorf("%s: execution\n  box %v\n want %v", c.Name, got, c.Execution)
		}
		if got := asJSONMap(t, gridTargetUnit(snap)); !reflect.DeepEqual(got, c.PerUnit) {
			t.Errorf("%s: per_unit\n  box %v\n want %v", c.Name, got, c.PerUnit)
		}
	}
	// Without a reported lever the primary has no entry at all.
	if u := gridTargetUnit(state.Snapshot{ControlCertified: true}); u != nil {
		t.Fatalf("no lever, no entry: %+v", u)
	}
}
