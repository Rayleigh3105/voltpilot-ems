package shelly

// Transport tests against in-process stubs of BOTH generation dialects, with
// and without metering - detection, capability probe, read, write, auth
// refusal, error classification.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// httpDoer adapts a plain http.Client to the Doer seam.
type httpDoer struct{ c *http.Client }

func (d httpDoer) Get(ctx context.Context, u string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := d.c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 4096)
	for {
		n, e := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if e != nil || len(buf) > 1<<20 {
			break
		}
	}
	return resp.StatusCode, buf, nil
}

// fakeGen2 is a minimal in-process Gen2+ RPC Shelly (Plus 1 / Plus 1PM class).
type fakeGen2 struct {
	mu       sync.Mutex
	metering bool
	on       bool
	apowerW  float64 // reported while on (metering models)
	authEn   bool
	setCalls int
	// lastToggleAfter records the dead-man window of the last ON write (0 =
	// none seen).
	lastToggleAfter int
	shellyCalls     int
}

func (f *fakeGen2) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/shelly":
			f.shellyCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "shellyplus1pm-a8032ab12345", "model": "SNSW-001P16EU",
				"gen": 2, "app": "Plus1PM", "auth_en": f.authEn,
			})
		case "/rpc/Switch.GetStatus":
			if f.authEn {
				w.WriteHeader(401)
				return
			}
			if r.URL.Query().Get("id") != "0" {
				_ = json.NewEncoder(w).Encode(map[string]any{"code": -105, "message": "unknown id"})
				return
			}
			st := map[string]any{"id": 0, "source": "init", "output": f.on}
			if f.metering {
				p := 0.0
				if f.on {
					p = f.apowerW
				}
				st["apower"] = p
				st["voltage"] = 231.2
				st["aenergy"] = map[string]any{"total": 1234.5}
			}
			_ = json.NewEncoder(w).Encode(st)
		case "/rpc/Switch.Set":
			if f.authEn {
				w.WriteHeader(401)
				return
			}
			f.setCalls++
			was := f.on
			f.on = r.URL.Query().Get("on") == "true"
			if f.on {
				f.lastToggleAfter, _ = strconv.Atoi(r.URL.Query().Get("toggle_after"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"was_on": was})
		default:
			w.WriteHeader(404)
		}
	})
}

// fakeGen1 is a minimal in-process Gen1 Shelly (Shelly 1 / 1PM class).
type fakeGen1 struct {
	mu        sync.Mutex
	metering  bool
	on        bool
	powerW    float64
	auth      bool
	setCalls  int
	lastTimer int
}

func (f *fakeGen1) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/shelly":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "SHSW-PM", "mac": "AABBCC", "auth": f.auth, "fw": "20230913-x",
			})
		case r.URL.Path == "/status":
			if f.auth {
				w.WriteHeader(401)
				return
			}
			st := map[string]any{
				"relays": []map[string]any{{"ison": f.on, "has_timer": f.lastTimer > 0}},
			}
			if f.metering {
				p := 0.0
				if f.on {
					p = f.powerW
				}
				st["meters"] = []map[string]any{{"power": p, "is_valid": true, "total": 4567}}
			} else {
				st["meters"] = []map[string]any{{"power": 0.0, "is_valid": false}}
			}
			_ = json.NewEncoder(w).Encode(st)
		case strings.HasPrefix(r.URL.Path, "/relay/"):
			if f.auth {
				w.WriteHeader(401)
				return
			}
			f.setCalls++
			f.on = r.URL.Query().Get("turn") == "on"
			if f.on {
				f.lastTimer, _ = strconv.Atoi(r.URL.Query().Get("timer"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ison": f.on, "has_timer": f.lastTimer > 0})
		default:
			w.WriteHeader(404)
		}
	})
}

func cfgFor(t *testing.T, srv *httptest.Server) Config {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	return Config{IP: u.Hostname(), Port: port}
}

func TestDetectGen2MeteringAndNot(t *testing.T) {
	for _, metering := range []bool{true, false} {
		f := &fakeGen2{metering: metering, apowerW: 2980}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		id, err := Detect(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
		if err != nil {
			t.Fatalf("metering=%v: %v", metering, err)
		}
		if id.Gen != Gen2 || id.Model != "SNSW-001P16EU" || id.App != "Plus1PM" {
			t.Fatalf("identity wrong: %+v", id)
		}
		if id.HasMetering != metering {
			t.Fatalf("metering detection wrong: got %v want %v", id.HasMetering, metering)
		}
	}
}

func TestDetectGen1MeteringAndNot(t *testing.T) {
	for _, metering := range []bool{true, false} {
		f := &fakeGen1{metering: metering, powerW: 2980}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		id, err := Detect(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
		if err != nil {
			t.Fatalf("metering=%v: %v", metering, err)
		}
		if id.Gen != Gen1 || id.Model != "SHSW-PM" {
			t.Fatalf("identity wrong: %+v", id)
		}
		if id.HasMetering != metering {
			t.Fatalf("metering detection wrong: got %v want %v", id.HasMetering, metering)
		}
	}
}

func TestDetectRefusesAuthProtectedDevices(t *testing.T) {
	g2 := &fakeGen2{authEn: true}
	srv2 := httptest.NewServer(g2.handler())
	defer srv2.Close()
	if _, err := Detect(context.Background(), httpDoer{srv2.Client()}, cfgFor(t, srv2)); err == nil ||
		!strings.Contains(err.Error(), "passwortgeschützt") {
		t.Fatalf("gen2 auth must refuse honestly, got %v", err)
	}
	g1 := &fakeGen1{auth: true}
	srv1 := httptest.NewServer(g1.handler())
	defer srv1.Close()
	if _, err := Detect(context.Background(), httpDoer{srv1.Client()}, cfgFor(t, srv1)); err == nil ||
		!strings.Contains(err.Error(), "passwortgeschützt") {
		t.Fatalf("gen1 auth must refuse honestly, got %v", err)
	}
}

func TestDetectClassifiesGarbageAndUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html>not a shelly</html>")
	}))
	defer srv.Close()
	_, err := Detect(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
	de, _ := err.(*DriverError)
	if de == nil || de.Code != ErrInvalidResponse {
		t.Fatalf("garbage must be invalid_response, got %v", err)
	}
	cfg := cfgFor(t, srv)
	srv.Close()
	_, err = Detect(context.Background(), httpDoer{&http.Client{}}, cfg)
	de, _ = err.(*DriverError)
	if de == nil || de.Code != ErrUnreachable {
		t.Fatalf("dead server must be unreachable, got %v", err)
	}
}

func TestReadStateNeverFabricatesPower(t *testing.T) {
	// Non-metering gen2: no power, whatever the relay does.
	f := &fakeGen2{metering: false, on: true}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := cfgFor(t, srv)
	st, de := ReadState(context.Background(), httpDoer{srv.Client()}, cfg, Identity{Gen: Gen2, HasMetering: false})
	if de != nil || st.On == nil || !*st.On || st.PowerKw != nil {
		t.Fatalf("non-metering read wrong: %+v %v", st, de)
	}
	// Metering gen1: real values incl. the honest 0.0 while off.
	g1 := &fakeGen1{metering: true, powerW: 2980, on: false}
	srv1 := httptest.NewServer(g1.handler())
	defer srv1.Close()
	st, de = ReadState(context.Background(), httpDoer{srv1.Client()}, cfgFor(t, srv1), Identity{Gen: Gen1, HasMetering: true})
	if de != nil || st.On == nil || *st.On || st.PowerKw == nil || *st.PowerKw != 0.0 {
		t.Fatalf("metering off read wrong: %+v %v", st, de)
	}
	g1.mu.Lock()
	g1.on = true
	g1.mu.Unlock()
	st, _ = ReadState(context.Background(), httpDoer{srv1.Client()}, cfgFor(t, srv1), Identity{Gen: Gen1, HasMetering: true})
	if st.PowerKw == nil || *st.PowerKw != 2.98 {
		t.Fatalf("metering on read wrong: %+v", st)
	}
	_ = cfg
}

func TestExecuteWritesTimerAndReadsBack(t *testing.T) {
	f := &fakeGen2{metering: true, apowerW: 2980}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := cfgFor(t, srv)
	on := true
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfg,
		Identity{Gen: Gen2, HasMetering: true},
		Command{OnOff: &on, ControlEnabled: true})
	if !res.OK || !res.Wrote || res.Verdict.AllMatch == nil || !*res.Verdict.AllMatch {
		t.Fatalf("execute failed: %+v", res)
	}
	if res.Verdict.PowerKw == nil || *res.Verdict.PowerKw != 2.98 {
		t.Fatalf("measured power missing: %+v", res.Verdict)
	}
	f.mu.Lock()
	toggle := f.lastToggleAfter
	f.mu.Unlock()
	if toggle != DefaultOnTimerS {
		t.Fatalf("ON write must arm the dead-man timer, got %d", toggle)
	}
}

func TestExecuteKillSwitchIsReadbackOnly(t *testing.T) {
	f := &fakeGen1{metering: false, on: true}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	on := false
	res := Execute(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv),
		Identity{Gen: Gen1}, Command{OnOff: &on, ControlEnabled: false})
	if !res.OK || res.Wrote || res.Verdict.AllMatch != nil {
		t.Fatalf("kill-switch execute wrong: %+v", res)
	}
	f.mu.Lock()
	calls := f.setCalls
	stillOn := f.on
	f.mu.Unlock()
	if calls != 0 || !stillOn {
		t.Fatalf("kill-switch off must never write (calls=%d on=%v)", calls, stillOn)
	}
	if res.Verdict.On == nil || !*res.Verdict.On {
		t.Fatalf("readback-only must still see the actual state: %+v", res.Verdict)
	}
}
