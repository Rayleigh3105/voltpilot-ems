package goe

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// --- shared golden vectors (pinned against the JS module, goe-control.js) ----

type vectorFile struct {
	Cases []struct {
		Name    string `json:"name"`
		Config  Config `json:"config"`
		Command struct {
			SetpointKw     *float64 `json:"setpoint_kw"`
			OnOff          *bool    `json:"on_off"`
			ControlEnabled bool     `json:"control_enabled"`
			Stale          bool     `json:"stale"`
		} `json:"command"`
		Expect struct {
			Mode           string `json:"mode"`
			Frc            int    `json:"frc"`
			Amp            *int   `json:"amp"`
			ControlEnabled bool   `json:"control_enabled"`
			WritesLen      int    `json:"writes_len"`
		} `json:"expect"`
	} `json:"cases"`
}

// TestSharedVectors runs the SAME golden vectors goe-control.test.js runs, so
// the Go executor twin and the canonical JS module can never drift.
func TestSharedVectors(t *testing.T) {
	// The vectors live next to the JS module in the nodered tree.
	path := filepath.Join("..", "..", "..", "nodered", "goe", "goe-control-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(vf.Cases) == 0 {
		t.Fatal("no vector cases")
	}
	for _, c := range vf.Cases {
		p := PlanFor(c.Config, Command{
			SetpointKw: c.Command.SetpointKw, OnOff: c.Command.OnOff,
			ControlEnabled: c.Command.ControlEnabled, Stale: c.Command.Stale,
		})
		if p.Mode != c.Expect.Mode {
			t.Errorf("%s: mode %q want %q", c.Name, p.Mode, c.Expect.Mode)
		}
		if p.Frc != c.Expect.Frc {
			t.Errorf("%s: frc %d want %d", c.Name, p.Frc, c.Expect.Frc)
		}
		if (p.Amp == nil) != (c.Expect.Amp == nil) || (p.Amp != nil && c.Expect.Amp != nil && *p.Amp != *c.Expect.Amp) {
			t.Errorf("%s: amp %v want %v", c.Name, p.Amp, c.Expect.Amp)
		}
		if p.ControlEnabled != c.Expect.ControlEnabled {
			t.Errorf("%s: controlEnabled %v want %v", c.Name, p.ControlEnabled, c.Expect.ControlEnabled)
		}
		if len(p.Writes) != c.Expect.WritesLen {
			t.Errorf("%s: writes %d want %d", c.Name, len(p.Writes), c.Expect.WritesLen)
		}
	}
}

func TestCurrentForPowerFloors(t *testing.T) {
	if got := CurrentForPower(11.04, 3, 230); got != 16 {
		t.Errorf("11.04kW 3x230 -> %d want 16", got)
	}
	if got := CurrentForPower(11.0, 3, 230); got != 15 {
		t.Errorf("11.0kW must FLOOR to 15, got %d (never widen the setpoint)", got)
	}
	if got := CurrentForPower(0, 3, 230); got != 0 {
		t.Errorf("0kW -> %d want 0", got)
	}
	if got := CurrentForPower(-5, 3, 230); got != 0 {
		t.Errorf("negative -> %d want 0", got)
	}
}

func TestNrgIndexIsElevenLikeTheReadDriver(t *testing.T) {
	if nrgTotalPowerIdx != 11 {
		t.Fatalf("nrg total-power index drifted from goe-api's 11: %d", nrgTotalPowerIdx)
	}
}

// --- fake in-process go-e (httptest) ----------------------------------------

type fakeGoe struct {
	frc, amp  int
	ignoreSet bool
	rejectKey string
	http500   bool
}

func (f *fakeGoe) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.http500 {
			w.WriteHeader(500)
			return
		}
		switch r.URL.Path {
		case "/api/set":
			out := map[string]interface{}{}
			for k, vs := range r.URL.Query() {
				if k == f.rejectKey {
					out[k] = "error: rejected"
					continue
				}
				if !f.ignoreSet {
					switch k {
					case "frc":
						f.frc = atoiSafe(vs[0])
					case "amp":
						f.amp = atoiSafe(vs[0])
					}
				}
				out[k] = true
			}
			writeJSON(w, out)
		case "/api/status":
			charging := f.frc == 2
			power := 0
			if charging {
				power = f.amp * 3 * 230
			}
			car := 4
			if charging {
				car = 2
			}
			writeJSON(w, map[string]interface{}{
				"frc": f.frc, "amp": f.amp, "car": car, "alw": true, "acu": 16,
				"nrg": []int{230, 230, 230, 0, f.amp, f.amp, f.amp, 0, 0, 0, 0, power, 0, 0, 0, 0},
			})
		default:
			w.WriteHeader(404)
		}
	})
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("content-type", "application/json")
	b, _ := json.Marshal(v)
	_, _ = w.Write(b)
}

// httpDoer adapts an *http.Client to the Doer interface.
type httpDoer struct{ c *http.Client }

func (d httpDoer) Get(ctx context.Context, url string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := d.c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, body, err
}

func ptrF(f float64) *float64 { return &f }

func serverConfig(t *testing.T, srv *httptest.Server, cfg Config) Config {
	t.Helper()
	// httptest gives http://127.0.0.1:PORT - split into ip:port for Config.
	u := srv.URL[len("http://"):]
	host, port := u, 0
	for i := 0; i < len(u); i++ {
		if u[i] == ':' {
			host = u[:i]
			port = atoiSafe(u[i+1:])
			break
		}
	}
	cfg.IP = host
	cfg.Port = port
	return cfg
}

func TestExecuteChargeSetsAndReadsBackMatch(t *testing.T) {
	f := &fakeGoe{amp: 6}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := serverConfig(t, srv, Config{Phases: 3, Voltage: 230})
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: true})
	if !res.OK || !res.Wrote {
		t.Fatalf("expected ok+wrote, got %+v", res)
	}
	if res.Verdict.AllMatch == nil || !*res.Verdict.AllMatch {
		t.Fatalf("expected all_match true, got %+v", res.Verdict)
	}
	if !res.Verdict.Charging || res.Verdict.PowerKw == nil || *res.Verdict.PowerKw != 11.04 {
		t.Fatalf("expected charging @ 11.04kW, got %+v", res.Verdict)
	}
}

func TestExecuteOffStopsCharging(t *testing.T) {
	f := &fakeGoe{frc: 2, amp: 16}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := serverConfig(t, srv, Config{})
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg, Command{SetpointKw: ptrF(0), ControlEnabled: true})
	if !res.OK || res.Plan.Mode != "off" {
		t.Fatalf("expected off, got %+v", res)
	}
	if res.Verdict.AllMatch == nil || !*res.Verdict.AllMatch || res.Verdict.Charging {
		t.Fatalf("expected match+not charging, got %+v", res.Verdict)
	}
}

func TestExecuteReadbackMismatchWhenIgnored(t *testing.T) {
	f := &fakeGoe{ignoreSet: true, amp: 6}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := serverConfig(t, srv, Config{Phases: 3, Voltage: 230})
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: true})
	if !res.OK {
		t.Fatalf("expected ok, got %+v", res)
	}
	if res.Verdict.AllMatch == nil || *res.Verdict.AllMatch {
		t.Fatalf("expected all_match false (charger ignored the set), got %+v", res.Verdict)
	}
}

func TestExecuteSetErrorIsInvalidResponse(t *testing.T) {
	f := &fakeGoe{rejectKey: "amp"}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := serverConfig(t, srv, Config{Phases: 3, Voltage: 230})
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: true})
	if res.OK || res.ErrorCode != ErrInvalidResponse {
		t.Fatalf("expected invalid_response, got %+v", res)
	}
}

func TestExecuteKillSwitchReadbackOnly(t *testing.T) {
	f := &fakeGoe{amp: 6}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := serverConfig(t, srv, Config{})
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: false})
	if !res.OK || res.Wrote {
		t.Fatalf("kill-switch must readback-only (no write), got %+v", res)
	}
	if res.Verdict.AllMatch != nil {
		t.Fatalf("readback-only -> all_match nil, got %+v", res.Verdict.AllMatch)
	}
	if res.Verdict.Charging {
		t.Fatalf("charger never set -> not charging, got %+v", res.Verdict)
	}
}

func TestExecuteUnreachable(t *testing.T) {
	cfg := Config{IP: "127.0.0.1", Port: 1}
	res := Execute(context.Background(), httpDoer{http.DefaultClient}, cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: true})
	if res.OK || res.ErrorCode != ErrUnreachable {
		t.Fatalf("expected unreachable, got %+v", res)
	}
}

func TestExecuteIdleNoIP(t *testing.T) {
	res := Execute(context.Background(), httpDoer{http.DefaultClient}, Config{}, Command{SetpointKw: ptrF(11), ControlEnabled: true})
	if res.OK || res.ErrorCode != ErrInvalidRequest {
		t.Fatalf("expected invalid_request, got %+v", res)
	}
}

func TestParseDriver(t *testing.T) {
	// A go-e driver with an ip -> ok.
	cfg, ok := ParseDriver([]byte(`{"brand":"go-e","communication":"goe_http_api","connection":{"ip":"192.168.1.42","phases":1}}`))
	if !ok || cfg.IP != "192.168.1.42" || cfg.Phases != 1 {
		t.Fatalf("expected parsed go-e cfg, got %v ok=%v", cfg, ok)
	}
	// A non-go-e driver -> skipped.
	if _, ok := ParseDriver([]byte(`{"communication":"fronius_solar_api","connection":{"ip":"1.2.3.4"}}`)); ok {
		t.Fatal("non-go-e driver must be skipped")
	}
	// go-e driver without an ip -> skipped.
	if _, ok := ParseDriver([]byte(`{"communication":"goe_http_api","connection":{}}`)); ok {
		t.Fatal("go-e driver without ip must be skipped")
	}
	// absent / malformed driver -> skipped.
	if _, ok := ParseDriver(nil); ok {
		t.Fatal("absent driver must be skipped")
	}
	if _, ok := ParseDriver([]byte(`not json`)); ok {
		t.Fatal("malformed driver must be skipped")
	}
}

func TestReadbackPayloadShape(t *testing.T) {
	cfg := Config{IP: "1.2.3.4", Phases: 3, Voltage: 230}
	plan := PlanFor(cfg, Command{SetpointKw: ptrF(11.04), ControlEnabled: true})
	tru := true
	res := Result{OK: true, Wrote: true, Plan: plan, Verdict: Verdict{AllMatch: &tru, Car: "charging", Charging: true}}
	b := ReadbackPayload("wallbox-1", "2026-07-20T10:00:00Z", res)
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("payload not json: %v", err)
	}
	if m["schema_version"] != "1.0" || m["entity_id"] != "wallbox-1" || m["all_match"] != true || m["adapter"] != "goe_http_api" {
		t.Fatalf("unexpected payload: %v", m)
	}
}
