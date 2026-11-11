package shelly

// The stage path's I/O against a Shelly Pro 3 stub. The /shelly body and the
// per-switch status objects are the device's own answers (read at the
// VoltPilotGATE, 31.10.2026 - SPSW-003XE16EU, fw 1.4.4, no metering); the
// Shelly.GetStatus/GetConfig envelopes around them follow the Gen2 docs
// (every `switch:N` object is the body Switch.GetStatus returns).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const pro3ShellyBody = `{"name":null,"id":"shellypro3-34987a484124","mac":"34987A484124",` +
	`"slot":1,"model":"SPSW-003XE16EU","gen":2,"fw_id":"20241011-114451/1.4.4-g6d2a586",` +
	`"ver":"1.4.4","app":"Pro3","auth_en":false,"auth_domain":null}`

// pro3 is a stateful Pro 3: three relays, an optional relay that ignores ON
// (a dead contact) or OFF (a welded one), and a request log.
type pro3 struct {
	mu        sync.Mutex
	on        [3]bool
	initial   [3]string
	ignoreOn  map[int]bool
	ignoreOff map[int]bool
	failOff   map[int]bool
	log       []string
}

func newPro3() *pro3 {
	return &pro3{initial: [3]string{"match_input", "restore_last", "off"},
		ignoreOn: map[int]bool{}, ignoreOff: map[int]bool{}, failOff: map[int]bool{}}
}

func (d *pro3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.log = append(d.log, r.URL.Path+"?"+r.URL.RawQuery)
	q := r.URL.Query()
	switch r.URL.Path {
	case "/shelly":
		_, _ = w.Write([]byte(pro3ShellyBody))
	case "/rpc/Shelly.GetStatus":
		parts := []string{`"ble":{}`, `"cloud":{"connected":false}`}
		for i := 0; i < 3; i++ {
			parts = append(parts, `"input:`+strconv.Itoa(i)+`":{"id":`+strconv.Itoa(i)+`,"state":false}`)
			parts = append(parts, `"switch:`+strconv.Itoa(i)+`":{"id":`+strconv.Itoa(i)+`, "source":"init", "output":`+
				strconv.FormatBool(d.on[i])+`,"temperature":{"tC":33.6, "tF":92.4}}`)
		}
		parts = append(parts, `"sys":{"mac":"34987A484124","restart_required":false}`, `"ws":{"connected":false}`)
		_, _ = w.Write([]byte("{" + strings.Join(parts, ",") + "}"))
	case "/rpc/Shelly.GetConfig":
		parts := []string{}
		for i := 0; i < 3; i++ {
			parts = append(parts, `"switch:`+strconv.Itoa(i)+`":{"id":`+strconv.Itoa(i)+`,"name":null,"in_mode":"follow",`+
				`"initial_state":"`+d.initial[i]+`","auto_on":false,"auto_on_delay":60.00,"auto_off":false,"auto_off_delay":60.00}`)
		}
		_, _ = w.Write([]byte("{" + strings.Join(parts, ",") + "}"))
	case "/rpc/Switch.Set":
		id, err := strconv.Atoi(q.Get("id"))
		if err != nil || id < 0 || id > 2 {
			_, _ = w.Write([]byte(`{"code":-105,"message":"Argument 'id' not found!"}`))
			return
		}
		on := q.Get("on") == "true"
		if !on && d.failOff[id] {
			w.WriteHeader(500)
			return
		}
		was := d.on[id]
		if !(on && d.ignoreOn[id]) && !(!on && d.ignoreOff[id]) {
			d.on[id] = on
		}
		_, _ = w.Write([]byte(`{"was_on":` + strconv.FormatBool(was) + `}`))
	case "/rpc/Switch.SetConfig":
		id, _ := strconv.Atoi(q.Get("id"))
		var c struct {
			InitialState string `json:"initial_state"`
		}
		_ = json.Unmarshal([]byte(q.Get("config")), &c)
		d.initial[id] = c.InitialState
		_, _ = w.Write([]byte(`{"restart_required":false}`))
	default:
		w.WriteHeader(404)
	}
}

func (d *pro3) requests() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := append([]string(nil), d.log...)
	d.log = nil
	return out
}

func pro3Config(t *testing.T, srv *httptest.Server, stages ...int) Config {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return Config{IP: u.Hostname(), Port: port, Channels: []int{0, 1, 2},
		OutputKw: []float64{2.0, 2.0, 2.0}, Stages: stages}
}

type srvDoer struct{ c *http.Client }

func (d srvDoer) Get(ctx context.Context, u string) (int, []byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	resp, err := d.c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 4096)
	for {
		n, e := resp.Body.Read(buf)
		b.Write(buf[:n])
		if e != nil {
			break
		}
	}
	return resp.StatusCode, []byte(b.String()), nil
}

func on() *bool  { b := true; return &b }
func off() *bool { b := false; return &b }

func TestDetectGroupReadsAllOutputsInTwoRequests(t *testing.T) {
	dev := newPro3()
	dev.on[2] = true
	srv := httptest.NewServer(dev)
	defer srv.Close()
	ident, st, err := DetectGroup(context.Background(), srvDoer{srv.Client()}, pro3Config(t, srv, 1, 2, 3))
	if err != nil {
		t.Fatal(err)
	}
	if ident.Gen != Gen2 || ident.Model != "SPSW-003XE16EU" || ident.HasMetering || st.PowerKw != nil {
		t.Fatalf("ident=%+v power=%v", ident, st.PowerKw)
	}
	if *st.Outputs[0] || *st.Outputs[1] || !*st.Outputs[2] {
		t.Fatalf("outputs = %v %v %v", *st.Outputs[0], *st.Outputs[1], *st.Outputs[2])
	}
	if got := dev.requests(); len(got) != 2 || got[1] != "/rpc/Shelly.GetStatus?" {
		t.Fatalf("requests = %v", got)
	}
}

func TestDetectGroupNamesAnOutputTheDeviceLacks(t *testing.T) {
	srv := httptest.NewServer(newPro3())
	defer srv.Close()
	cfg := pro3Config(t, srv)
	cfg.Channels, cfg.OutputKw = []int{0, 3}, []float64{2, 2}
	_, _, err := DetectGroup(context.Background(), srvDoer{srv.Client()}, cfg)
	de, _ := err.(*DriverError)
	if de == nil || de.Code != ErrInvalidResponse || de.Message != "Ausgang 3 kennt das Gerät nicht (Ausgänge prüfen)." {
		t.Fatalf("err = %v", err)
	}
}

func TestExecuteGroupAllThreePhasesConfirmed(t *testing.T) {
	dev := newPro3()
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv, 1, 2, 3)
	ident := Identity{Gen: Gen2, Model: "SPSW-003XE16EU"}
	yes := true
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, ident,
		Command{OnOff: &yes, ControlEnabled: true}, GroupPrev{}, 0)
	if !res.OK || res.ErrorCode != "" || res.Corrected {
		t.Fatalf("res = %+v", res)
	}
	if *res.Verdict.AllMatch != true || *res.Verdict.ConfirmedStage != 3 || *res.Verdict.ConfirmedKw != 6.0 {
		t.Fatalf("verdict = %+v", res.Verdict)
	}
	got := dev.requests()
	want := []string{
		"/rpc/Switch.Set?id=0&on=true&toggle_after=180",
		"/rpc/Switch.Set?id=1&on=true&toggle_after=180",
		"/rpc/Switch.Set?id=2&on=true&toggle_after=180",
		"/rpc/Shelly.GetStatus?",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests = %v", got)
	}
}

// One output disagreeing (a dead contact on L2): the confirmed stage is two
// phases, the mismatch is named on that output, nothing is locked (HZ-4 B).
func TestExecuteGroupOneOutputDisagreeing(t *testing.T) {
	dev := newPro3()
	dev.ignoreOn[1] = true
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv, 1, 2, 3)
	yes := true
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, Identity{Gen: Gen2},
		Command{OnOff: &yes, ControlEnabled: true}, GroupPrev{}, 0)
	if !res.OK || *res.Verdict.AllMatch || *res.Verdict.ConfirmedStage != 2 || *res.Verdict.ConfirmedKw != 4.0 {
		t.Fatalf("res = %+v verdict=%+v", res, res.Verdict)
	}
	r := res.Verdict.Registers[1]
	if *r.Channel != 1 || r.Commanded != 1 || *r.Actual != 0 || r.Match {
		t.Fatalf("register L2 = %+v", r)
	}
	// The next re-assert writes the same output again (no lock, no other phase).
	next := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, Identity{Gen: Gen2},
		Command{OnOff: &yes, ControlEnabled: true},
		GroupPrev{Commanded: res.Plan.Targets, Read: res.Verdict.Outputs}, 0)
	if !next.Plan.Targets[1] || next.Plan.Stage != 3 {
		t.Fatalf("retry plan = %+v", next.Plan)
	}
	payload := GroupReadbackPayload("e1", "2026-10-31T12:00:00Z", res,
		[]time.Time{{}, time.Date(2026, 10, 31, 11, 59, 0, 0, time.UTC), {}})
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatal(err)
	}
	stage := m["stage"].(map[string]any)
	if stage["commanded"] != 3.0 || stage["confirmed"] != 2.0 || stage["confirmed_kw"] != 4.0 ||
		stage["commanded_kw"] != 6.0 || m["on"] != true || m["all_match"] != false {
		t.Fatalf("payload = %s", payload)
	}
	regs := m["registers"].([]any)
	if regs[1].(map[string]any)["mismatch_since"] != "2026-10-31T11:59:00Z" ||
		regs[0].(map[string]any)["mismatch_since"] != nil || regs[1].(map[string]any)["channel"] != 1.0 {
		t.Fatalf("registers = %v", regs)
	}
}

// A phase change writes OFF before ON: two phases are never on together
// where one is commanded.
func TestExecuteGroupWritesOffBeforeOn(t *testing.T) {
	dev := newPro3()
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv, 1, 3)
	sp := 2.0
	// Day 1 starts stage 1 on L2.
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, Identity{Gen: Gen2},
		Command{SetpointKw: &sp, ControlEnabled: true}, GroupPrev{}, 1)
	if !res.OK || !*res.Verdict.AllMatch || *res.Verdict.ConfirmedStage != 1 {
		t.Fatalf("res = %+v", res)
	}
	got := dev.requests()
	want := []string{
		"/rpc/Switch.Set?id=0&on=false",
		"/rpc/Switch.Set?id=2&on=false",
		"/rpc/Switch.Set?id=1&on=true&toggle_after=180",
		"/rpc/Shelly.GetStatus?",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("requests = %v", got)
	}
}

// An output on although it should be off (switched in the Shelly app, or
// welded): it gets OFF at once within the same pass and counts toward the
// stage, so the one commanded phase is not added on top (HZ-4 B).
func TestExecuteGroupStuckOutputCountsAndGetsOffAtOnce(t *testing.T) {
	dev := newPro3()
	dev.on[0], dev.on[1] = true, true // L1 ours, L2 switched on in the app
	dev.ignoreOff[1] = true           // ... and it does not obey
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv, 1, 2, 3)
	sp := 2.0
	prev := GroupPrev{Commanded: []bool{true, false, false}, Read: []*bool{on(), off(), off()}}
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, Identity{Gen: Gen2},
		Command{SetpointKw: &sp, ControlEnabled: true}, prev, 0)
	if !res.OK || !res.Corrected {
		t.Fatalf("res = %+v", res)
	}
	if dev.on[0] || !dev.on[1] || dev.on[2] {
		t.Fatalf("device = %v - more than the one commanded phase runs", dev.on)
	}
	if *res.Verdict.ConfirmedStage != 1 || res.Plan.Stage != 1 || res.Plan.StageKw != 2.0 || !res.Plan.Counted[1] {
		t.Fatalf("plan=%+v verdict=%+v", res.Plan, res.Verdict)
	}
	if *res.Verdict.AllMatch {
		t.Fatal("the stuck output must stay a named mismatch")
	}
	if res.Plan.Reason != reasonStuckCounted {
		t.Fatalf("reason = %q", res.Plan.Reason)
	}
}

// An OFF that fails stops every ON of the pass: an output that may still be
// on never gets company the command did not grant.
func TestExecuteGroupFailedOffWritesNoOn(t *testing.T) {
	dev := newPro3()
	dev.failOff[2] = true
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv, 1, 3)
	sp := 2.0
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, cfg, Identity{Gen: Gen2},
		Command{SetpointKw: &sp, ControlEnabled: true}, GroupPrev{}, 0)
	for _, r := range dev.requests() {
		if strings.Contains(r, "on=true") {
			t.Fatalf("an ON went out after a failed OFF: %s", r)
		}
	}
	if !res.OK || res.ErrorCode != ErrInvalidResponse ||
		!strings.HasPrefix(res.Message, "Ausgang 2 ließ sich nicht ausschalten - es wurde nichts eingeschaltet") {
		t.Fatalf("res = %+v", res)
	}
}

func TestExecuteGroupKillSwitchReadsOnly(t *testing.T) {
	dev := newPro3()
	srv := httptest.NewServer(dev)
	defer srv.Close()
	yes := true
	res := ExecuteGroup(context.Background(), srvDoer{srv.Client()}, pro3Config(t, srv), Identity{Gen: Gen2},
		Command{OnOff: &yes, ControlEnabled: false}, GroupPrev{}, 0)
	if !res.OK || res.Wrote || res.Verdict.AllMatch != nil || *res.Verdict.ConfirmedStage != 0 {
		t.Fatalf("res = %+v", res)
	}
	if got := dev.requests(); len(got) != 1 || got[0] != "/rpc/Shelly.GetStatus?" {
		t.Fatalf("requests = %v", got)
	}
}

func TestInitialStatesReadAndSwitchedOff(t *testing.T) {
	dev := newPro3()
	srv := httptest.NewServer(dev)
	defer srv.Close()
	cfg := pro3Config(t, srv)
	doer := srvDoer{srv.Client()}
	got, de := ReadInitialStates(context.Background(), doer, cfg, Identity{Gen: Gen2})
	if de != nil || strings.Join(got, ",") != "match_input,restore_last,off" {
		t.Fatalf("initial = %v %v", got, de)
	}
	dev.requests()
	if de := SetInitialOff(context.Background(), doer, cfg, Identity{Gen: Gen2}); de != nil {
		t.Fatal(de)
	}
	reqs := dev.requests()
	if len(reqs) != 3 || reqs[0] != "/rpc/Switch.SetConfig?config=%7B%22initial_state%22%3A%22off%22%7D&id=0" {
		t.Fatalf("requests = %v", reqs)
	}
	if dev.initial != [3]string{"off", "off", "off"} {
		t.Fatalf("initial after = %v", dev.initial)
	}
	for _, r := range reqs {
		if strings.Contains(r, "Switch.Set?") {
			t.Fatalf("a switching command went out: %s", r)
		}
	}
}

func TestGroupControlCheckNeverInterruptsAHeatingRun(t *testing.T) {
	dev := newPro3()
	dev.on[1] = true
	srv := httptest.NewServer(dev)
	defer srv.Close()
	out := GroupControlCheck(context.Background(), srvDoer{srv.Client()}, pro3Config(t, srv))
	if out.OK || !out.Skipped || out.ErrorCode != "" || !strings.HasPrefix(out.Message, "Ausgang 1 ist gerade eingeschaltet") {
		t.Fatalf("out = %+v", out)
	}
	for _, r := range dev.requests() {
		if strings.Contains(r, "Switch.Set") {
			t.Fatalf("wrote while heating: %s", r)
		}
	}
	dev.on[1] = false
	out = GroupControlCheck(context.Background(), srvDoer{srv.Client()}, pro3Config(t, srv))
	if !out.OK || out.Skipped {
		t.Fatalf("out = %+v", out)
	}
	if dev.on != [3]bool{} {
		t.Fatalf("device = %v", dev.on)
	}
}

// Gen1 (Shelly 2.5): one /status read for both relays; metering only when
// every relay's meter is valid, the power is the sum.
func TestGroupGen1TwoRelaysWithMetering(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"type":"SHSW-25","auth":false,"num_outputs":2}`))
		case "/status":
			_, _ = w.Write([]byte(`{"relays":[{"ison":true},{"ison":false}],` +
				`"meters":[{"power":1203.4,"is_valid":true},{"power":0,"is_valid":true}]}`))
		case "/settings":
			_, _ = w.Write([]byte(`{"relays":[{"default_state":"last"},{"default_state":"switch"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	cfg := Config{IP: u.Hostname(), Port: port, Channels: []int{0, 1}, OutputKw: []float64{1.5, 1.5}, Stages: []int{1, 2}}
	ident, st, err := DetectGroup(context.Background(), srvDoer{srv.Client()}, cfg)
	if err != nil || ident.Gen != Gen1 || !ident.HasMetering || st.PowerKw == nil || *st.PowerKw != 1.203 {
		t.Fatalf("ident=%+v st=%+v err=%v", ident, st, err)
	}
	got, de := ReadInitialStates(context.Background(), srvDoer{srv.Client()}, cfg, ident)
	if de != nil || strings.Join(got, ",") != "restore_last,match_input" {
		t.Fatalf("initial = %v %v", got, de)
	}
}

func TestGroupKeyNeverSharesASingleOutputIdentity(t *testing.T) {
	single := Config{IP: "192.168.178.43", Channel: 0}
	group := Config{IP: "192.168.178.43", Channels: []int{0, 1, 2}}
	if single.Key() != "192.168.178.43:80/0" || group.Key() != "192.168.178.43:80/0,1,2" {
		t.Fatalf("keys = %q %q", single.Key(), group.Key())
	}
}
