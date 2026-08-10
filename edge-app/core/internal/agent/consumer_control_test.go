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

// fakeGoeServer is a minimal in-process go-e: /api/set applies frc/amp/psm,
// /api/status echoes the state (nrg[11] = charging power; pnp follows psm
// while charging).
type fakeGoeServer struct {
	mu       sync.Mutex
	frc, amp int
	psm      int
	setCalls int
}

func (f *fakeGoeServer) phases() int {
	if f.psm == 1 {
		return 1
	}
	return 3
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
				case "psm":
					f.psm = n
				}
				out[k] = true
			}
			_ = json.NewEncoder(w).Encode(out)
		case "/api/status":
			charging := f.frc == 2
			power, car, pnp := 0, 4, 0
			if charging {
				power, car, pnp = f.amp*f.phases()*230, 2, f.phases()
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"frc": f.frc, "amp": f.amp, "psm": f.psm, "pnp": pnp,
				"car": car, "alw": true, "acu": 16,
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

func (f *fakeGoeServer) phaseSnapshot() (psm, frc, amp int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.psm, f.frc, f.amp
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
	cfg.ConsumerControlEnabled = true // Inkrement 5: consumer control is now flag-gated (default OFF)
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, Bus: bus,
		goeDoer: goeHTTPDoer{c: srv.Client()}}

	// One deterministic pass.
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())

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
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())

	if _, _, calls := fake.snapshot(); calls != 0 {
		t.Fatalf("kill-switch off must issue ZERO HTTP to the wallbox, got %d set calls", calls)
	}
}

func TestGoeConsumerControlSkipsNonGoeEntities(t *testing.T) {
	// A wallbox with a NON-go-e driver (or none) is not touched by this executor.
	cfg := config.Defaults()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true // arm the pass so the skip is proven, not vacuous
	reg := entities.Registry{Revision: "r", Entities: []entities.Entity{{
		ID: "batt", Type: entities.TypeBatteryHybrid,
	}, {
		ID: "wb", Type: entities.TypeWallbox,
		Driver: json.RawMessage(`{"communication":"fronius_solar_api","connection":{"ip":"1.2.3.4"}}`),
	}}}
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: minimalArbiter(reg),
		goeDoer: failDoer{t}}
	// Must not call the doer for any entity (no go-e-backed entity).
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())
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

// --- D4 phase switching: the full driver chain on a synthetic clock ----------

// phaseWallboxRegistry: a phase-switching go-e wallbox (11 kW band, short
// pacing so the scenario runs on a synthetic clock).
func phaseWallboxRegistry(ip string, port int) (entities.Registry, string) {
	id := "wallbox-goe-ps"
	maxKw := 11.04
	driver := json.RawMessage(fmt.Sprintf(
		`{"brand":"go-e","communication":"goe_http_api","connection":{"ip":%q,"port":%d,"voltage":230,"phase_switching":true,"phase_switch_pause_s":300,"phase_switch_dwell_s":60}}`,
		ip, port))
	e := entities.Entity{
		ID: id, Type: entities.TypeWallbox, Label: "Wallbox",
		Capabilities: entities.Capabilities{
			Measure: []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}},
			Actuate: []entities.ActuateCap{
				{Command: entities.CmdSetpointKw, Min: ptr(0), Max: ptr(11.04)},
				{Command: entities.CmdOnOff},
			},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
		Driver: driver,
	}
	return entities.Registry{Revision: "rev-goe-ps", Entities: []entities.Entity{e}}, id
}

// submitWish replaces the current flow wish for the entity.
func submitWish(arb *desired.Arbiter, id string, kw float64, req string) {
	arb.SubmitInternal(&desired.Desired{
		EntityID: id, RequestID: req,
		Source:        desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority:      desired.ClassFlow,
		TTL:           time.Hour,
		IssuedAt:      time.Now().UTC(),
		Commands:      entities.Commands{SetpointKw: ptr(kw)},
		RequestedType: entities.CmdSetpointKw,
	})
	arb.Tick()
}

// TestGoePhaseSwitchScenario drives the WHOLE D4 chain deterministically:
// unknown position -> readback fills it -> a 3p wish on a 1p box is held
// restrict-only through the dwell ("wartet - Phasenumschaltpause", 1p max,
// never a value between the ranges) -> the dwell elapses -> psm Force_3 +
// the 3p current land at the charger -> a small wish wants 1p again but the
// minimum switch pause holds it at Off -> after the pause psm Force_1 lands.
func TestGoePhaseSwitchScenario(t *testing.T) {
	fake := &fakeGoeServer{psm: 1, amp: 6} // the box sits in forced 1-phase
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg, wid := phaseWallboxRegistry(host, port)
	arb := minimalArbiter(reg)

	cfg := config.Defaults()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, goeDoer: goeHTTPDoer{c: srv.Client()}}

	lastFP := map[string]string{}
	lastAssert := map[string]time.Time{}
	switchers := map[string]*goe.PhaseSwitcher{}
	t0 := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	pass := func(sec int) {
		a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, t0.Add(time.Duration(sec)*time.Second))
	}

	// An 11 kW wish. Pass 1: position UNKNOWN -> restrict-safe 3p conversion,
	// NO psm write; the readback teaches the switcher the box is 1p.
	submitWish(arb, wid, 11.04, "r1")
	pass(0)
	if psm, _, _ := fake.phaseSnapshot(); psm != 1 {
		t.Fatalf("pass 1 must never write psm blind, got psm=%d", psm)
	}
	if switchers[wid].Active() != 1 {
		t.Fatalf("the readback must teach the switcher the 1p position, got %d", switchers[wid].Active())
	}

	// Pass 2 (t=5s): position known, 3p desired -> the dwell holds; the box
	// charges at its 1p maximum (16 A = 3.68 kW), the hold is named.
	pass(5)
	if psm, frc, amp := fake.phaseSnapshot(); psm != 1 || frc != 2 || amp != 16 {
		t.Fatalf("held switch must charge 1p@16A, got psm=%d frc=%d amp=%d", psm, frc, amp)
	}
	if a.goeHoldFor(wid) != goe.HoldCodePhaseSwitch {
		t.Fatalf("the hold must be named, got %q", a.goeHoldFor(wid))
	}

	// Pass 3 (t=70s): the 60 s dwell elapsed, no pause owed -> psm Force_3 +
	// the 3p current (11.04 kW -> 16 A) land in ONE set.
	pass(70)
	if psm, frc, amp := fake.phaseSnapshot(); psm != 2 || frc != 2 || amp != 16 {
		t.Fatalf("the switch must land psm=2 frc=2 amp=16, got psm=%d frc=%d amp=%d", psm, frc, amp)
	}
	if a.goeHoldFor(wid) != "" {
		t.Fatalf("no hold after the executed switch, got %q", a.goeHoldFor(wid))
	}

	// A 2 kW wish: 1p territory. The minimum switch pause (300 s since t=70)
	// holds - and 3p cannot serve 2 kW without overshooting, so the honest
	// restriction is OFF, named as the phase hold.
	submitWish(arb, wid, 2, "r2")
	pass(140)
	if psm, frc, _ := fake.phaseSnapshot(); psm != 2 || frc != 1 {
		t.Fatalf("paced down-switch must hold at Off on 3p, got psm=%d frc=%d", psm, frc)
	}
	if a.goeHoldFor(wid) != goe.HoldCodePhaseSwitch {
		t.Fatalf("the down-hold must be named, got %q", a.goeHoldFor(wid))
	}

	// After the pause (70+300=370; dwell since 140 long elapsed): psm Force_1
	// + the 1p current for 2 kW (floor(2000/230) = 8 A).
	pass(380)
	if psm, frc, amp := fake.phaseSnapshot(); psm != 1 || frc != 2 || amp != 8 {
		t.Fatalf("down-switch must land psm=1 frc=2 amp=8, got psm=%d frc=%d amp=%d", psm, frc, amp)
	}
}

// TestGoeGapWishNeverReachesTheDevice: a wish in the gap between the ranges
// (3.68 < w < 4.14) snaps DOWN to the 1p maximum - the charger only ever sees
// currents of the ACTIVE range, never an in-between value.
func TestGoeGapWishNeverReachesTheDevice(t *testing.T) {
	fake := &fakeGoeServer{psm: 1, amp: 6}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg, wid := phaseWallboxRegistry(host, port)
	arb := minimalArbiter(reg)
	cfg := config.Defaults()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, goeDoer: goeHTTPDoer{c: srv.Client()}}
	lastFP, lastAssert, switchers := map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}
	t0 := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)

	submitWish(arb, wid, 4.0, "r1") // in the gap
	a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, t0)
	a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, t0.Add(5*time.Second))
	psm, frc, amp := fake.phaseSnapshot()
	if psm != 1 || frc != 2 || amp != 16 {
		t.Fatalf("a gap wish must charge 1p@16A (3.68 kW, snapped DOWN), got psm=%d frc=%d amp=%d", psm, frc, amp)
	}
	if a.goeHoldFor(wid) != "" {
		t.Fatalf("the gap snap is the RANGE decision, not a pacing hold, got %q", a.goeHoldFor(wid))
	}
}

// TestGoeCycleGuardComposesWithTheDriver: the arbiter's cycle guard (min-off)
// holds a re-start UPSTREAM; the driver then writes Off - the two guards
// compose, the go-e never sees the held wish.
func TestGoeCycleGuardComposesWithTheDriver(t *testing.T) {
	fake := &fakeGoeServer{}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	id := "wallbox-goe-cycle"
	maxKw := 11.0
	minOff := 600.0
	driver := json.RawMessage(fmt.Sprintf(
		`{"brand":"go-e","communication":"goe_http_api","connection":{"ip":%q,"port":%d,"phases":3,"voltage":230}}`, host, port))
	reg := entities.Registry{Revision: "rev-cycle", Entities: []entities.Entity{{
		ID: id, Type: entities.TypeWallbox,
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: entities.CmdSetpointKw, Min: ptr(0), Max: ptr(11)}},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw, MinOffSeconds: &minOff},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
		Driver: driver,
	}}}
	arb := minimalArbiter(reg)
	cfg := config.Defaults()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, goeDoer: goeHTTPDoer{c: srv.Client()}}
	lastFP, lastAssert, switchers := map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}

	// Run: the wallbox charges.
	submitWish(arb, id, 11, "r1")
	a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, time.Now())
	if _, frc, _ := fake.phaseSnapshot(); frc != 2 {
		t.Fatalf("expected charging, got frc=%d", frc)
	}

	// Stop, then an immediate re-start wish: the CYCLE GUARD (min-off 600 s)
	// holds it - the granted command stays off and the driver writes Off.
	submitWish(arb, id, 0, "r2")
	a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, time.Now())
	submitWish(arb, id, 11, "r3")
	dec, ok := arb.DecisionFor(id)
	if !ok || dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOff {
		t.Fatalf("expected the arbiter's min-off hold, got %+v ok=%v", dec.Cycle, ok)
	}
	a.runGoeControlPass(context.Background(), a.goeDoer, lastFP, lastAssert, switchers, time.Now())
	if _, frc, _ := fake.phaseSnapshot(); frc != 1 {
		t.Fatalf("the held re-start must keep the go-e OFF, got frc=%d", frc)
	}
}

// TestGoeFailsafeReleasesToNeutral: no arbiter decision (stale/nothing
// commands the wallbox) -> frc=Neutral hands the box back to its own logic
// (the §4.2 release failsafe), and the readback payload says so.
func TestGoeFailsafeReleasesToNeutral(t *testing.T) {
	fake := &fakeGoeServer{frc: 2, amp: 16} // charging under an old command
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg, wid := wallboxRegistry(t, host, port)
	arb := minimalArbiter(reg) // NO desire submitted -> no decision -> stale

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	sub := pahoClient(t, addr, "goe-neutral-watch")
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
	cfg.ConsumerControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, Bus: bus, goeDoer: goeHTTPDoer{c: srv.Client()}}
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())

	if _, frc, _ := fake.phaseSnapshot(); frc != 0 {
		t.Fatalf("failsafe must RELEASE (frc=Neutral), got frc=%d", frc)
	}
	waitFor(t, 3*time.Second, "neutral readback", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(readbacks) > 0
	})
	mu.Lock()
	rb := readbacks[len(readbacks)-1]
	mu.Unlock()
	if rb["mode"] != "neutral" {
		t.Fatalf("the readback must name the release, got %v", rb)
	}
}

// TestGoeWriteErrorIsAnHonestStatus: the charger rejecting a key surfaces as
// error_code in the published readback - never a silent success, and never a
// claimed match.
func TestGoeWriteErrorIsAnHonestStatus(t *testing.T) {
	// A fake that answers /api/set with an error string for amp.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/set":
			out := map[string]interface{}{}
			for k := range r.URL.Query() {
				if k == "amp" {
					out[k] = "error: not allowed"
				} else {
					out[k] = true
				}
			}
			_ = json.NewEncoder(w).Encode(out)
		case "/api/status":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"frc": 0, "amp": 6, "car": 1, "alw": false})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	reg, wid := wallboxRegistry(t, host, port)
	arb := minimalArbiter(reg)
	submitWish(arb, wid, 11, "r1")

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	sub := pahoClient(t, addr, "goe-err-watch")
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
	cfg.ConsumerControlEnabled = true
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, Bus: bus, goeDoer: goeHTTPDoer{c: srv.Client()}}
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())

	waitFor(t, 3*time.Second, "error readback", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(readbacks) > 0
	})
	mu.Lock()
	rb := readbacks[len(readbacks)-1]
	mu.Unlock()
	if rb["error_code"] != "invalid_response" {
		t.Fatalf("the write error must be named, got %v", rb)
	}
	if v, has := rb["all_match"]; has && v != nil {
		t.Fatalf("a failed write must never claim a match, got %v", v)
	}
}

// TestGoeConsumerFlagOffIsByteIdentical: with VP_CONSUMER_CONTROL_ENABLED off
// (the default) the pass issues ZERO HTTP even for a phase-switching wallbox -
// the whole driver incl. D4 is inert.
func TestGoeConsumerFlagOffIsByteIdentical(t *testing.T) {
	reg, wid := phaseWallboxRegistry("127.0.0.1", 1)
	arb := minimalArbiter(reg)
	submitWish(arb, wid, 11, "r1")
	cfg := config.Defaults()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = false // the Inkrement-5 master switch stays OFF
	a := &Agent{Cfg: cfg, entRegistry: reg, arb: arb, goeDoer: failDoer{t}}
	a.runGoeControlPass(context.Background(), a.goeDoer, map[string]string{}, map[string]time.Time{}, map[string]*goe.PhaseSwitcher{}, time.Now())
	if a.goeHoldFor(wid) != "" {
		t.Fatalf("flag off must leave no driver state behind")
	}
}
