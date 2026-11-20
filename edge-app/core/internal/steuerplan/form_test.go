package steuerplan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The contract's readback vectors (docs/contracts/v2/control-readback-vectors.json,
// written by deye-control.e2e.test.js): Form(roh) is exactly what the palette
// node vp-control-readback publishes.
func TestFormVertragsvektoren(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "contracts", "v2", "control-readback-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Faelle []struct {
			Name    string `json:"name"`
			Roh     Obj    `json:"roh"`
			Geformt Obj    `json:"geformt"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &d); err != nil || len(d.Faelle) == 0 {
		t.Fatalf("Vertragsvektoren: %v", err)
	}
	for _, f := range d.Faelle {
		exakt(t, f.Name, Form(f.Roh, "nie benutzt"), f.Geformt)
	}
}

// What the palette refuses or fills in on its own (vp-control-readback.js shape).
func TestFormRaender(t *testing.T) {
	if Form(nil, "x") != nil || Form(Obj{}, "x") != nil {
		t.Fatal("ohne registers keine Rueckmeldung")
	}
	if Form(Obj{"registers": []any{Obj{"role": "a"}}}, "x") != nil {
		t.Fatal("ein Register ohne match macht die Rueckmeldung unbrauchbar")
	}
	if Form(Obj{"registers": []any{Obj{"match": true}}}, "x") != nil {
		t.Fatal("ein Register ohne Rolle macht die Rueckmeldung unbrauchbar")
	}
	got := Form(Obj{"certified": true, "control_enabled": true, "mode": "quer",
		"registers":           []any{Obj{"role": "a", "match": true}, Obj{"role": "b", "match": false}},
		"native_capabilities": Obj{"intents": []any{"cover_load"}, "window": true},
		"native":              Obj{"foo": 1.0}}, "2026-11-20T10:00:00.000Z")
	exakt(t, "Altform ohne verdict", got, Obj{
		"ts": "2026-11-20T10:00:00.000Z", "family": "", "source": "", "control_enabled": true, "certified": true,
		"mode": "normal", "control_path": "", "remote_status_raw": nil,
		"registers": []any{Obj{"role": "a", "match": true}, Obj{"role": "b", "match": false}},
		"all_match": false, "verify": "mismatch", "mismatch_roles": []any{"b"}, "unread_roles": []any{},
		"verify_reason": "", "blocked": false, "reason": "",
		"dual_controller": Obj{"only_controller_required": true, "possible_conflict": true, "detector": "readback_mismatch",
			"reason": "Der Wechselrichter hält den geschriebenen Sollwert nicht (b). Möglicher Konflikt: die eigene Smart-Steuerung des Wechselrichters oder ein zweites EMS könnte gegensteuern - VoltPilot muss der einzige Controller sein."},
	})
}
