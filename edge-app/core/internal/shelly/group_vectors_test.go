package shelly

// The stage path against the SHARED contract vectors
// (docs/contracts/v2/heizstab-stufen-vectors.json): validation, stage choice
// with rotation and the HZ-4 B recount, readback with the confirmed stage.
// The API reads the same file for the driver block and the ledger.

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

const stufenVectorsPath = "../../../../docs/contracts/v2/heizstab-stufen-vectors.json"

type stufenDoc struct {
	Validate []struct {
		Name   string `json:"name"`
		Config Config `json:"config"`
		Error  string `json:"error"`
	} `json:"validate"`
	Plan []struct {
		Name    string `json:"name"`
		Config  Config `json:"config"`
		Command struct {
			OnOff          *bool    `json:"on_off"`
			SetpointKw     *float64 `json:"setpoint_kw"`
			Stale          bool     `json:"stale"`
			ControlEnabled bool     `json:"control_enabled"`
		} `json:"command"`
		Day  int `json:"day"`
		Prev *struct {
			Commanded []bool  `json:"commanded"`
			Read      []*bool `json:"read"`
		} `json:"prev"`
		Expect struct {
			Mode    string  `json:"mode"`
			Stage   int     `json:"stage"`
			StageKw float64 `json:"stage_kw"`
			Targets []bool  `json:"targets"`
			Counted []bool  `json:"counted"`
			Write   bool    `json:"write"`
			TimerS  *int    `json:"timer_s"`
			Reason  *string `json:"reason"`
		} `json:"expect"`
	} `json:"plan"`
	Readback []struct {
		Name    string  `json:"name"`
		Config  Config  `json:"config"`
		Write   bool    `json:"write"`
		Targets []bool  `json:"targets"`
		Read    []*bool `json:"read"`
		Expect  struct {
			AllMatch    *bool    `json:"all_match"`
			Confirmed   *int     `json:"confirmed"`
			ConfirmedKw *float64 `json:"confirmed_kw"`
			Match       []bool   `json:"match"`
		} `json:"expect"`
	} `json:"readback"`
}

func loadStufen(t *testing.T) stufenDoc {
	t.Helper()
	raw, err := os.ReadFile(stufenVectorsPath)
	if err != nil {
		t.Fatalf("vectors: %v", err)
	}
	var doc stufenDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("vectors parse: %v", err)
	}
	if len(doc.Validate) == 0 || len(doc.Plan) == 0 || len(doc.Readback) == 0 {
		t.Fatal("vectors: empty section")
	}
	return doc
}

func TestStufenVectorsValidate(t *testing.T) {
	for _, v := range loadStufen(t).Validate {
		if got := v.Config.GroupError(); got != v.Error {
			t.Errorf("%s: GroupError = %q, want %q", v.Name, got, v.Error)
		}
	}
}

func TestStufenVectorsPlan(t *testing.T) {
	for _, v := range loadStufen(t).Plan {
		cmd := Command{OnOff: v.Command.OnOff, SetpointKw: v.Command.SetpointKw,
			Stale: v.Command.Stale, ControlEnabled: v.Command.ControlEnabled}
		var prev GroupPrev
		if v.Prev != nil {
			prev = GroupPrev{Commanded: v.Prev.Commanded, Read: v.Prev.Read}
		}
		p := PlanGroupFor(v.Config, cmd, prev, v.Day)
		e := v.Expect
		if p.Mode != e.Mode || p.Stage != e.Stage || math.Abs(p.StageKw-e.StageKw) > 1e-9 || p.Write != e.Write {
			t.Errorf("%s: mode=%s stage=%d kw=%v write=%v, want %s/%d/%v/%v",
				v.Name, p.Mode, p.Stage, p.StageKw, p.Write, e.Mode, e.Stage, e.StageKw, e.Write)
		}
		if e.Targets != nil && !reflect.DeepEqual(p.Targets, e.Targets) {
			t.Errorf("%s: targets=%v, want %v", v.Name, p.Targets, e.Targets)
		}
		if e.Counted != nil && !reflect.DeepEqual(p.Counted, e.Counted) {
			t.Errorf("%s: counted=%v, want %v", v.Name, p.Counted, e.Counted)
		}
		if e.TimerS != nil && p.TimerS != *e.TimerS {
			t.Errorf("%s: timer_s=%d, want %d", v.Name, p.TimerS, *e.TimerS)
		}
		if e.Reason != nil && p.Reason != *e.Reason {
			t.Errorf("%s: reason=%q, want %q", v.Name, p.Reason, *e.Reason)
		}
	}
}

func TestStufenVectorsReadback(t *testing.T) {
	for _, v := range loadStufen(t).Readback {
		p := GroupPlan{Write: v.Write, Targets: v.Targets, Channels: v.Config.Channels}
		got := p.EvalGroupReadback(v.Config, Identity{Gen: Gen2}, GroupState{Outputs: v.Read})
		e := v.Expect
		if !reflect.DeepEqual(got.AllMatch, e.AllMatch) {
			t.Errorf("%s: all_match=%v, want %v", v.Name, deref(got.AllMatch), deref(e.AllMatch))
		}
		if !reflect.DeepEqual(got.ConfirmedStage, e.Confirmed) || !reflect.DeepEqual(got.ConfirmedKw, e.ConfirmedKw) {
			t.Errorf("%s: confirmed=%v/%v, want %v/%v", v.Name,
				derefInt(got.ConfirmedStage), derefF(got.ConfirmedKw), derefInt(e.Confirmed), derefF(e.ConfirmedKw))
		}
		match := []bool{}
		for i, r := range got.Registers {
			match = append(match, r.Match)
			if r.Channel == nil || *r.Channel != v.Config.Channels[i] || r.Role != "relay" || r.Key != "output" {
				t.Errorf("%s: register %d = %+v", v.Name, i, r)
			}
		}
		if !reflect.DeepEqual(match, e.Match) {
			t.Errorf("%s: match=%v, want %v", v.Name, match, e.Match)
		}
	}
}

func deref(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

func derefInt(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}

func derefF(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}
