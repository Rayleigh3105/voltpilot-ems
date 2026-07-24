package agent

// Integration test for the go-e consumer-control executor: a wallbox entity is
// commanded by the E2 arbiter (clamped through its consumer band), and the
// consumer-control pass drives a physical go-e set + readback against an
// in-process fake go-e, publishing the per-entity readback on the local bus.
// Proves the full edge chain end to end WITHOUT a real wallbox:
//   desired 22 kW -> arbiter clamps to the 11 kW band -> go-e set frc=On/amp
//   -> /api/status readback -> edge/entities/{id}/readback all_match.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// fakeGoeServer is a minimal in-process go-e: /api/set applies frc/amp,
// /api/status echoes the state (nrg[11] = charging power).
type fakeGoeServer struct {
	mu       sync.Mutex
	frc, amp int
	setCalls int
}

func (f *fakeGoeServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/api/set":
			f.setCalls++
			out := map[string]bool{}
			for k, vs := range r.URL.Query() {
				n, _ := strconv.Atoi(vs[0])
				switch k {
				case "frc":
					f.frc = n
				case "amp":
					f.amp = n
				}
				out[k] = true
			}
			_ = json.NewEncoder(w).Encode(out)
		case "/api/status":
			charging := f.frc == 2
			power, car := 0, 4
			if charging {
				power, car = f.amp*3*230, 2
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"frc": f.frc, "amp": f.amp, "car": car, "alw": true, "acu": 16,
				"nrg": []int{230, 230, 230, 0, f.amp, f.amp, f.amp, 0, 0, 0, 0, power, 0, 0, 0, 0},
			})
		default:
			w.WriteHeader(404)
		}
	})
}

func (f *fakeGoeServer) snapshot() (frc, amp, calls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frc, f.amp, f.setCalls
}

// wallboxRegistry builds a one-entity registry: a go-e-backed wallbox with an
// 11 kW consumer band and a driver pointing at the fake go-e (3-phase @ 230 V).
func wallboxRegistry(t *testing.T, ip string, port int) (entities.Registry, string) {
	t.Helper()
	id := "wallbox-goe-1"
	maxKw := 11.0
	driver := json.RawMessage(fmt.Sprintf(
		`{"brand":"go-e","communication":"goe_http_api","connection":{"ip":%q,"port":%d,"phases":3,"voltage":230}}`,
		ip, port))
	e := entities.Entity{
		ID: id, Type: entities.TypeWallbox, Label: "Wallbox",
		Capabilities: entities.Capabilities{
			Measure: []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}},
			Actuate: []entities.ActuateCap{
				{Command: entities.CmdSetpointKw, Min: ptr(0), Max: ptr(11)},
				{Command: entities.CmdOnOff},
			},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
		Driver: driver,
	}
	return entities.Registry{Revision: "rev-goe", Entities: []entities.Entity{e}}, id
}

func ptr(f float64) *float64 { return &f }

// minimalArbiter builds an arbiter with just the deps the consumer clamp needs.
func minimalArbiter(reg entities.Registry) *desired.Arbiter {
	a := desired.New(desired.Deps{
		Now:            func() time.Time { return time.Now().UTC() },
		Reading:        func(string) guards.Reading { return guards.Reading{} },
		ControlEnabled: func() bool { return true },
		PublishCommand: func(string, []byte) {},
		PublishEvent:   func(string, []byte) {},
	})
	a.SetEntities(reg)
	return a
}

func TestGoeConsumerControlExecutesArbitratedCommand(t *testing.T) {
	fake := &fakeGoeServer{amp: 6}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	reg, wid := wallboxRegistry(t, host, port)

	// The arbiter grants a CLAMPED command: a 22 kW flow wish is clamped to the
	// entity's 11 kW consumer band.
	arb := minimalArbiter(reg)
	arb.SubmitInternal(&desired.Desired{
		EntityID: wid, RequestID: "req-1",
		Source:        desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority:      desired.ClassFlow,
		TTL:           time.Hour,
		IssuedAt:      time.Now().UTC(),
		Commands:      entities.Commands{SetpointKw: ptr(22)},
		RequestedType: entities.CmdSetpointKw,
	})
	arb.Tick()
	dec, ok := arb.DecisionFor(wid)
	if !ok || dec.Granted.SetpointKw == nil || *dec.Granted.SetpointKw != 11 {
		t.Fatalf("expected arbiter to clamp 22->11, got %+v ok=%v", dec.Granted, ok)
	}

	// A real local bus + a paho observer of the entity readback.
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	sub := pahoClient(t, addr, "goe-watch")
	var mu sync.Mutex
	var readbacks []map[string]interface{}
	if tok := sub.Subscribe(entities.ReadbackTopic(wid), 1, func(_ pahomqtt.Client, m pahomqtt.Message) {
		var rb map[string]interface{}
		if json.Unmarshal(m.Payload(), &rb) == nil {
			mu.Lock()
			readbacks = append(readbacks, rb)
			mu.Unlock()
		}
	}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}

	cfg := config.Defaults()
	cfg.ControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, Bus: bus,
		goeDoer: goeHTTPDoer{c: srv.Client()}}

	// One deterministic pass.
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	// The fake go-e must have received the clamped charge command: 11 kW @ 3x230
	// = floor(11000/690) = 15 A, frc = On (2).
	frc, amp, calls := fake.snapshot()
	if calls != 1 || frc != goe.FrcOn || amp != 15 {
		t.Fatalf("expected 1 set frc=2 amp=15 (11kW/3ph/230V floored), got calls=%d frc=%d amp=%d", calls, frc, amp)
	}

	// The readback landed on the entity readback topic with all_match true.
	waitFor(t, 3*time.Second, "readback published", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(readbacks) > 0
	})
	mu.Lock()
	rb := readbacks[len(readbacks)-1]
	mu.Unlock()
	if rb["all_match"] != true || rb["adapter"] != "goe_http_api" || rb["charging"] != true {
		t.Fatalf("unexpected readback: %v", rb)
	}
}

func TestGoeConsumerControlKillSwitchOffDoesNoHTTP(t *testing.T) {
	fake := &fakeGoeServer{amp: 6}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg, wid := wallboxRegistry(t, host, port)
	arb := minimalArbiter(reg)
	arb.SubmitInternal(&desired.Desired{
		EntityID: wid, RequestID: "r", Source: desired.Source{Kind: desired.SourceFlow, FlowID: "f", NodeID: "n"},
		Priority: desired.ClassFlow, TTL: time.Hour, IssuedAt: time.Now().UTC(),
		Commands: entities.Commands{SetpointKw: ptr(11)}, RequestedType: entities.CmdSetpointKw,
	})
	arb.Tick()

	cfg := config.Defaults()
	cfg.ControlEnabled = false // explicit kill-switch OFF (control is ON by default now)
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, goeDoer: goeHTTPDoer{c: srv.Client()}}
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, time.Now())

	if _, _, calls := fake.snapshot(); calls != 0 {
		t.Fatalf("kill-switch off must issue ZERO HTTP to the wallbox, got %d set calls", calls)
	}
}

func TestGoeConsumerControlSkipsNonGoeEntities(t *testing.T) {
	// A wallbox with a NON-go-e driver (or none) is not touched by this executor.
	cfg := config.Defaults()
	cfg.ControlEnabled = true
	reg := entities.Registry{Revision: "r", Entities: []entities.Entity{{
		ID: "batt", Type: entities.TypeBatteryHybrid,
	}, {
		ID: "wb", Type: entities.TypeWallbox,
		Driver: json.RawMessage(`{"communication":"fronius_solar_api","connection":{"ip":"1.2.3.4"}}`),
	}}}
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: minimalArbiter(reg),
		goeDoer: failDoer{t}}
	// Must not call the doer for any entity (no go-e-backed entity).
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, time.Now())
}

// failDoer fails the test if the executor ever calls it.
type failDoer struct{ t *testing.T }

func (d failDoer) Get(context.Context, string) (int, []byte, error) {
	d.t.Fatal("no HTTP expected: no go-e-backed entity")
	return 0, nil, nil
}

func splitHostPort(t *testing.T, url string) (string, int) {
	t.Helper()
	u := url[len("http://"):]
	for i := 0; i < len(u); i++ {
		if u[i] == ':' {
			p, _ := strconv.Atoi(u[i+1:])
			return u[:i], p
		}
	}
	t.Fatalf("bad url %q", url)
	return "", 0
}
