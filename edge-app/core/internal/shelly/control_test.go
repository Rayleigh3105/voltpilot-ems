package shelly

// The golden-vector suite pins the pure control mapping (PlanFor / SetURL /
// EvalReadback) to testdata/shelly-control-vectors.json - the ONE file a
// future JS twin must read too (the goe-control-vectors discipline).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectorsDoc struct {
	Plan []struct {
		Name    string `json:"name"`
		Config  Config `json:"config"`
		Command struct {
			SetpointKw     *float64 `json:"setpoint_kw"`
			OnOff          *bool    `json:"on_off"`
			ControlEnabled bool     `json:"control_enabled"`
			Stale          bool     `json:"stale"`
		} `json:"command"`
		Expect struct {
			Mode   string `json:"mode"`
			On     bool   `json:"on"`
			TimerS int    `json:"timer_s"`
			Write  bool   `json:"write"`
			Reason string `json:"reason"`
		} `json:"expect"`
	} `json:"plan"`
	SetURL []struct {
		Name     string   `json:"name"`
		Config   Config   `json:"config"`
		Identity Identity `json:"identity"`
		On       bool     `json:"on"`
		Expect   string   `json:"expect"`
	} `json:"set_url"`
	Readback []struct {
		Name     string   `json:"name"`
		Identity Identity `json:"identity"`
		Plan     struct {
			OnOff           bool `json:"on_off"`
			ControlDisabled bool `json:"control_disabled"`
		} `json:"plan"`
		State struct {
			On      *bool    `json:"on"`
			PowerKw *float64 `json:"power_kw"`
		} `json:"state"`
		Expect struct {
			AllMatch  *bool  `json:"all_match"`
			Key       string `json:"key"`
			Commanded int    `json:"commanded"`
			Actual    *int   `json:"actual"`
			Match     bool   `json:"match"`
		} `json:"expect"`
	} `json:"readback"`
}

func loadVectors(t *testing.T) vectorsDoc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "shelly-control-vectors.json"))
	if err != nil {
		t.Fatalf("vectors: %v", err)
	}
	var doc vectorsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("vectors parse: %v", err)
	}
	if len(doc.Plan) == 0 || len(doc.SetURL) == 0 || len(doc.Readback) == 0 {
		t.Fatal("vectors: empty section")
	}
	return doc
}

func TestSharedVectorsPlan(t *testing.T) {
	for _, tc := range loadVectors(t).Plan {
		cmd := Command{SetpointKw: tc.Command.SetpointKw, OnOff: tc.Command.OnOff,
			ControlEnabled: tc.Command.ControlEnabled, Stale: tc.Command.Stale}
		p := PlanFor(tc.Config, cmd)
		if p.Mode != tc.Expect.Mode || p.On != tc.Expect.On || p.TimerS != tc.Expect.TimerS ||
			p.Write != tc.Expect.Write {
			t.Errorf("%s: got mode=%s on=%v timer=%d write=%v, want %+v",
				tc.Name, p.Mode, p.On, p.TimerS, p.Write, tc.Expect)
		}
		if tc.Expect.Reason != "" && p.Reason != tc.Expect.Reason {
			t.Errorf("%s: reason %q, want %q", tc.Name, p.Reason, tc.Expect.Reason)
		}
	}
}

func TestSharedVectorsSetURL(t *testing.T) {
	for _, tc := range loadVectors(t).SetURL {
		got := SetURL(tc.Config, tc.Identity, tc.On)
		if got != tc.Expect {
			t.Errorf("%s: got %q, want %q", tc.Name, got, tc.Expect)
		}
	}
}

func TestSharedVectorsReadback(t *testing.T) {
	for _, tc := range loadVectors(t).Readback {
		on := tc.Plan.OnOff
		p := PlanFor(Config{IP: "192.168.0.60"}, Command{OnOff: &on,
			ControlEnabled: !tc.Plan.ControlDisabled})
		v := p.EvalReadback(tc.Identity, State{On: tc.State.On, PowerKw: tc.State.PowerKw})
		if tc.Expect.Key == "" {
			if v.AllMatch != nil || len(v.Registers) != 0 {
				t.Errorf("%s: expected no verdict, got %+v", tc.Name, v)
			}
			continue
		}
		if v.AllMatch == nil || tc.Expect.AllMatch == nil || *v.AllMatch != *tc.Expect.AllMatch {
			t.Errorf("%s: all_match %v, want %v", tc.Name, v.AllMatch, tc.Expect.AllMatch)
			continue
		}
		r := v.Registers[0]
		if r.Key != tc.Expect.Key || r.Commanded != tc.Expect.Commanded || r.Match != tc.Expect.Match {
			t.Errorf("%s: register %+v, want %+v", tc.Name, r, tc.Expect)
		}
		switch {
		case tc.Expect.Actual == nil && r.Actual != nil:
			t.Errorf("%s: actual %v, want absent", tc.Name, *r.Actual)
		case tc.Expect.Actual != nil && (r.Actual == nil || *r.Actual != *tc.Expect.Actual):
			t.Errorf("%s: actual %v, want %v", tc.Name, r.Actual, *tc.Expect.Actual)
		}
	}
}

func TestParseDriver(t *testing.T) {
	cfg, ok := ParseDriver([]byte(`{"communication":"shelly_http","connection":{"ip":"192.168.0.60","channel":1,"rated_power_kw":3.0}}`))
	if !ok || cfg.IP != "192.168.0.60" || cfg.Channel != 1 || cfg.RatedPowerKw != 3.0 {
		t.Fatalf("shelly driver not parsed: %+v ok=%v", cfg, ok)
	}
	for name, raw := range map[string]string{
		"empty":       ``,
		"foreign":     `{"communication":"goe_http_api","connection":{"ip":"x"}}`,
		"no ip":       `{"communication":"shelly_http","connection":{}}`,
		"garbage":     `nope`,
		"no conn":     `{"communication":"shelly_http"}`,
		"conn broken": `{"communication":"shelly_http","connection":"x"}`,
	} {
		if _, ok := ParseDriver([]byte(raw)); ok {
			t.Errorf("%s driver must not parse", name)
		}
	}
}

func TestReadbackPayloadCarriesHonestFailure(t *testing.T) {
	res := Result{OK: false, ErrorCode: ErrUnreachable, Message: "weg",
		Plan: Plan{Mode: "on", ControlEnabled: true}, Identity: Identity{Gen: Gen2, HasMetering: true}}
	var got map[string]any
	if err := json.Unmarshal(ReadbackPayload("ent-1", "2026-08-10T12:00:00Z", res), &got); err != nil {
		t.Fatal(err)
	}
	if got["error_code"] != "unreachable" || got["entity_id"] != "ent-1" ||
		got["adapter"] != Communication {
		t.Fatalf("failure payload wrong: %v", got)
	}
	if _, has := got["all_match"]; has && got["all_match"] != nil {
		t.Fatalf("a failed execute must keep all_match absent/null, got %v", got["all_match"])
	}
	if got["metering"] != true || got["gen"] != float64(2) {
		t.Fatalf("identity facts missing: %v", got)
	}
}
