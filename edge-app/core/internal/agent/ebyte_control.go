package agent

// Ebyte M31 I/O module: source poll, per-channel consumer executor and the
// in-process connection test (internal/ebyte owns transport + mapping). The
// CORE is the single owner of the module's Modbus socket - Node-RED has no
// reader for it (sources.BusConfig excludes core-owned transports) and every
// exchange runs under the driver's per-address lock.
//
// Data model (one device, N channels):
//
//   - the MODULE is one device entity (entity type io-module) whose driver
//     carries the connection; componentapply turns it into one local source.
//     The source poll reads every input and output and publishes them as
//     source telemetry (inputs/outputs) and as device-entity telemetry
//     (di_1..di_N, do_1..do_N as 0/1),
//   - every relay output that switches a load is an ordinary CONSUMER entity
//     whose driver names the module entity and the channel
//     ({communication, io_entity_id, channel}). The executor below turns the
//     arbiter's clamped grant into exactly that one relay write + readback.
//
// SAFETY: gated on VP_CONTROL_ENABLED AND VP_CONSUMER_CONTROL_ENABLED (both
// default OFF - zero Modbus from the executor); no fresh decision = OFF; an ON
// is only written while the device's own watchdog (offline fault output = all
// outputs OFF) is armed, so a dead edge lets every relay fall off. Arming needs
// a device restart and is therefore done only while every output is off.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// ebyteSourcePollTick is the read cadence of the module poll: input states
// should reach the surfaces within seconds, and every read also keeps the
// device watchdog alive (any request does).
const ebyteSourcePollTick = 10 * time.Second

// ebyteArmRetry paces watchdog arming attempts per module (a restart per
// attempt; never a loop).
const ebyteArmRetry = 5 * time.Minute

// ebyteEntityHeartbeat is how often the unchanged device-entity telemetry is
// repeated: states travel on CHANGE, plus this heartbeat so the cloud can tell
// "unchanged" from "no longer reported" (2*N channels per 10-s read would
// otherwise fill telemetry_v2 with identical rows).
const ebyteEntityHeartbeat = 60 * time.Second

// ebyteState is the executor's per-module memory.
type ebyteState struct {
	mu        sync.Mutex
	lastWrite map[string]time.Time // entity id -> last ON/OFF write
	lastArm   map[string]time.Time // module key -> last arming attempt
	// switchedOn remembers every output THIS executor switched on. A Shelly
	// falls off by its own timer once nobody re-asserts; the M31 watchdog
	// does not, because the source poll keeps it alive. So when the consumer
	// disappears from the registry or control is switched off, the executor
	// actively writes OFF for exactly these outputs - and only these.
	switchedOn map[string]ebyteOutput
	// lastTelemetry is the last published device-entity state per entity
	// (fingerprint + time) for the change-or-heartbeat rule.
	lastTelemetry map[string]ebyteTelemetryMark
}

type ebyteTelemetryMark struct {
	fp string
	at time.Time
}

// ebyteOutput is one output the executor switched on.
type ebyteOutput struct {
	cfg     ebyte.Config
	channel int
}

func (a *Agent) ebyteClientRef() ebyte.Client { return ebyte.Client{Dial: a.ebyteDial} }

// ebyteStoreRef lazily opens the identity pin store (nil only when the data
// dir is unusable - then nothing is pinned and nothing is switched).
func (a *Agent) ebyteStoreRef() *ebyte.Store {
	a.ebyteStoreMu.Lock()
	defer a.ebyteStoreMu.Unlock()
	if a.ebyteStore == nil {
		s, err := ebyte.NewStore(a.Cfg.DataDir)
		if err != nil {
			slog.Warn("ebyte identity store unavailable; switching refused", "err", err)
			return nil
		}
		a.ebyteStore = s
	}
	return a.ebyteStore
}

func (a *Agent) ebyteStateRef() *ebyteState {
	a.ebyteStoreMu.Lock()
	defer a.ebyteStoreMu.Unlock()
	if a.ebyteRun == nil {
		a.ebyteRun = &ebyteState{lastWrite: map[string]time.Time{}, lastArm: map[string]time.Time{},
			switchedOn: map[string]ebyteOutput{}, lastTelemetry: map[string]ebyteTelemetryMark{}}
	}
	return a.ebyteRun
}

// ebyteConfigOf maps a stored source connection onto the driver config.
func ebyteConfigOf(c inverter.Connection) ebyte.Config {
	return ebyte.Config{IP: c.IP, Port: c.Port, UnitID: c.UnitID, MAC: c.MAC}
}

// --- Source poll: the READ half (independent of the control flags) ----------

func (a *Agent) startEbyteSourcePoll(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(ebyteSourcePollTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.runEbyteSourcePass(ctx, time.Now())
		}
	}()
}

// runEbyteSourcePass reads every configured module once and publishes its
// input/output states. A foreign device behind the address is reported and
// never attributed to the source.
func (a *Agent) runEbyteSourcePass(ctx context.Context, now time.Time) {
	cl := a.ebyteClientRef()
	for _, s := range a.ListSources() {
		if s.Communication != inverter.CommEbyteModbusTCP {
			continue
		}
		cfg := ebyteConfigOf(s.Connection)
		pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		id, st, de := cl.Read(pctx, cfg)
		cancel()
		if de == nil {
			if store := a.ebyteStoreRef(); store != nil {
				de = store.Verify(cfg, id)
			}
		}
		if de != nil {
			slog.Warn("ebyte source read failed", "source", s.ID, "target", cfg.Address(),
				"error_code", de.Code, "msg", de.Message)
			continue
		}
		raw, _ := json.Marshal(map[string]any{"inputs": st.Inputs, "outputs": st.Outputs})
		if a.Bus == nil {
			continue
		}
		if err := a.Bus.Publish(sources.TopicPrefix+s.ID+"/telemetry", raw, false); err != nil {
			slog.Warn("ebyte source publish failed", "source", s.ID, "err", err)
		}
		if ent := a.ebyteDeviceEntityFor(s, cfg); ent != "" {
			a.publishEbyteDeviceTelemetry(ent, st, now)
		}
	}
}

// ebyteDeviceEntityFor finds the registry entity of a module source: the
// adoption pin first, else the device entity whose driver names the same
// module address.
func (a *Agent) ebyteDeviceEntityFor(s sources.Source, cfg ebyte.Config) string {
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	for _, e := range reg.Entities {
		if e.EdgeSourceID != "" && e.EdgeSourceID == s.ID {
			return e.ID
		}
	}
	for _, e := range reg.Entities {
		if dc, ok := ebyte.ParseDeviceDriver(e.Driver); ok && dc.Key() == cfg.Key() {
			return e.ID
		}
	}
	return ""
}

// publishEbyteDeviceTelemetry publishes the module's states as per-entity
// telemetry (di_k / do_k as 0/1 - the flat numeric channel map of the entity
// contract), so the normal E1b chain carries them to the portal.
func (a *Agent) publishEbyteDeviceTelemetry(entityID string, st ebyte.State, now time.Time) {
	fp := fmt.Sprint(st.Inputs, st.Outputs)
	run := a.ebyteStateRef()
	run.mu.Lock()
	last := run.lastTelemetry[entityID]
	if last.fp == fp && now.Sub(last.at) < ebyteEntityHeartbeat {
		run.mu.Unlock()
		return
	}
	run.lastTelemetry[entityID] = ebyteTelemetryMark{fp: fp, at: now}
	run.mu.Unlock()
	ch := make(map[string]float64, len(st.Inputs)+len(st.Outputs))
	for i, v := range st.Inputs {
		ch[ebyte.InputKey(i+1)] = b01(v)
	}
	for i, v := range st.Outputs {
		ch[ebyte.OutputKey(i+1)] = b01(v)
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": entities.SchemaVersion,
		"entity_id":      entityID,
		"ts":             now.UTC().Format(time.RFC3339),
		"channels":       ch,
	})
	if err := a.Bus.Publish(entities.TelemetryTopic(entityID), raw, false); err != nil {
		slog.Error("ebyte entity telemetry publish failed", "entity", entityID, "err", err)
	}
}

func b01(v bool) float64 {
	if v {
		return 1
	}
	return 0
}

// --- Control pass: one read per module, writes only where needed --------------

type ebyteChannel struct {
	entityID string
	drv      ebyte.ChannelDriver
}

// runEbyteControlPass executes one pass over every channel-bound consumer
// entity, grouped per module: ONE read of the module, then a write for every
// channel whose actual state differs from its plan or whose re-assert is due,
// then the per-entity readback.
func (a *Agent) runEbyteControlPass(ctx context.Context, now time.Time) {
	if !a.Cfg.ControlEnabled || !a.Cfg.ConsumerControlEnabled {
		// Not-Aus: release only what this executor switched on, then stay
		// silent (zero Modbus from the executor while control is off).
		a.releaseEbyteOutputs(ctx, nil)
		return
	}
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	groups := map[string][]ebyteChannel{}
	present := map[string]bool{}
	for _, e := range reg.Entities {
		if d, ok := ebyte.ParseChannelDriver(e.Driver); ok {
			groups[d.IOEntityID] = append(groups[d.IOEntityID], ebyteChannel{entityID: e.ID, drv: d})
			present[e.ID] = true
		}
	}
	// A consumer that left the registry (deleted, rebound) no longer owns its
	// output: switch it off once instead of leaving the load running.
	a.releaseEbyteOutputs(ctx, present)
	if len(groups) == 0 {
		return
	}
	ids := make([]string, 0, len(groups))
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, moduleID := range ids {
		chans := groups[moduleID]
		dev := reg.Find(moduleID)
		var cfg ebyte.Config
		ok := false
		if dev != nil {
			cfg, ok = ebyte.ParseDeviceDriver(dev.Driver)
		}
		if !ok {
			for _, c := range chans {
				a.publishEbyteReadback(c.entityID, ebyte.Result{
					Plan:      ebyte.PlanFor(c.drv.Channel, c.drv.RatedPowerKw, a.ebyteCommandFor(c.entityID)),
					ErrorCode: ebyte.ErrInvalidRequest,
					Message:   "Das zugeordnete I/O-Modul ist auf dieser Box nicht eingerichtet",
				}, now)
			}
			continue
		}
		a.runEbyteModule(ctx, cfg, chans, now)
	}
}

func (a *Agent) ebyteCommandFor(entityID string) ebyte.Command {
	cmd := ebyte.Command{ControlEnabled: a.Cfg.ControlEnabled && a.Cfg.ConsumerControlEnabled}
	if a.arb == nil {
		cmd.Stale = true
		return cmd
	}
	dec, ok := a.arb.DecisionFor(entityID)
	if !ok {
		cmd.Stale = true
		return cmd
	}
	if dec.Granted.SetpointKw != nil {
		v := *dec.Granted.SetpointKw
		cmd.SetpointKw = &v
	}
	if dec.Granted.OnOff != nil {
		v := *dec.Granted.OnOff
		cmd.OnOff = &v
	}
	return cmd
}

func (a *Agent) runEbyteModule(ctx context.Context, cfg ebyte.Config, chans []ebyteChannel, now time.Time) {
	cl := a.ebyteClientRef()
	run := a.ebyteStateRef()
	fail := func(code, msg string) {
		for _, c := range chans {
			a.publishEbyteReadback(c.entityID, ebyte.Result{
				Plan:      ebyte.PlanFor(c.drv.Channel, c.drv.RatedPowerKw, a.ebyteCommandFor(c.entityID)),
				ErrorCode: code, Message: msg,
			}, now)
		}
	}
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	id, st, de := cl.Read(pctx, cfg)
	if de == nil {
		store := a.ebyteStoreRef()
		if store == nil {
			de = &ebyte.DriverError{Code: ebyte.ErrInvalidRequest, Message: "Geräte-Identität kann nicht gespeichert werden; es wird nichts geschaltet"}
		} else {
			de = store.Verify(cfg, id)
		}
	}
	if de != nil {
		slog.Warn("ebyte control read failed", "target", cfg.Address(), "error_code", de.Code, "msg", de.Message)
		fail(de.Code, de.Message)
		return
	}

	type step struct {
		c    ebyteChannel
		plan ebyte.Plan
	}
	steps := make([]step, 0, len(chans))
	wantOn := false
	for _, c := range chans {
		p := ebyte.PlanFor(c.drv.Channel, c.drv.RatedPowerKw, a.ebyteCommandFor(c.entityID))
		steps = append(steps, step{c, p})
		wantOn = wantOn || (p.Write && p.On)
	}

	// An ON needs the device watchdog. Arm it only while EVERY output is off
	// (the arming restart drops all relays) and at most once per retry window.
	if wantOn && !st.Watchdog.Armed() {
		allOff := true
		for _, on := range st.Outputs {
			allOff = allOff && !on
		}
		run.mu.Lock()
		due := now.Sub(run.lastArm[cfg.Key()]) >= ebyteArmRetry
		if allOff && due {
			run.lastArm[cfg.Key()] = now
		}
		run.mu.Unlock()
		if allOff && due {
			if _, ade := cl.ArmWatchdog(pctx, cfg, ebyte.WatchdogSetup{}); ade != nil {
				slog.Warn("ebyte watchdog arming failed", "target", cfg.Address(), "error_code", ade.Code, "msg", ade.Message)
			} else {
				slog.Info("ebyte watchdog armed; module restarts", "target", cfg.Address())
			}
		}
	}

	for _, s := range steps {
		p := s.plan
		res := ebyte.Result{Plan: p, OK: true}
		idx := p.Channel - 1
		if idx < 0 || idx >= len(st.Outputs) {
			res.OK, res.ErrorCode = false, ebyte.ErrChannelUnknown
			res.Message = "Diesen Ausgang gibt es am I/O-Modul nicht"
			a.publishEbyteReadback(s.c.entityID, res, now)
			continue
		}
		if p.On && !st.Watchdog.Armed() {
			// Never ON without the device dead-man; the channel is driven OFF.
			p.On, p.Mode, p.Reason = false, "off", ebyte.ReasonNoWatchdog
			res.Plan = p
		}
		actual := st.Outputs[idx]
		run.mu.Lock()
		due := now.Sub(run.lastWrite[s.c.entityID]) >= goeReassertInterval
		run.mu.Unlock()
		if p.Write && (actual != p.On || due) {
			_, after, wde := cl.SetOutput(pctx, cfg, p.Channel, p.On)
			if wde != nil {
				res.OK, res.ErrorCode, res.Message = false, wde.Code, wde.Message
				a.publishEbyteReadback(s.c.entityID, res, now)
				continue
			}
			res.Wrote = true
			st = after
			actual = st.Outputs[idx]
			run.mu.Lock()
			run.lastWrite[s.c.entityID] = now
			run.mu.Unlock()
		}
		// Ownership follows the executor's own ON plan (also across a restart
		// of the edge, when the relay is still on from before).
		run.mu.Lock()
		if p.Write && p.On && actual {
			run.switchedOn[s.c.entityID] = ebyteOutput{cfg: cfg, channel: p.Channel}
		} else if !actual {
			delete(run.switchedOn, s.c.entityID)
		}
		run.mu.Unlock()
		res.Actual = &actual
		a.publishEbyteReadback(s.c.entityID, res, now)
	}
}

// releaseEbyteOutputs writes OFF for every output this executor switched on
// whose consumer is not in keep (nil = release all). A failed write stays
// remembered and is retried on the next pass.
func (a *Agent) releaseEbyteOutputs(ctx context.Context, keep map[string]bool) {
	run := a.ebyteStateRef()
	run.mu.Lock()
	var todo []string
	for id := range run.switchedOn {
		if keep == nil || !keep[id] {
			todo = append(todo, id)
		}
	}
	run.mu.Unlock()
	sort.Strings(todo)
	cl := a.ebyteClientRef()
	for _, id := range todo {
		run.mu.Lock()
		out := run.switchedOn[id]
		run.mu.Unlock()
		pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		_, _, de := cl.SetOutput(pctx, out.cfg, out.channel, false)
		cancel()
		if de != nil {
			slog.Warn("ebyte output release failed; retrying next pass", "entity", id,
				"target", out.cfg.Address(), "channel", out.channel, "error_code", de.Code, "msg", de.Message)
			continue
		}
		slog.Info("ebyte output released", "entity", id, "target", out.cfg.Address(), "channel", out.channel)
		run.mu.Lock()
		delete(run.switchedOn, id)
		delete(run.lastWrite, id)
		run.mu.Unlock()
	}
}

func (a *Agent) publishEbyteReadback(entityID string, res ebyte.Result, now time.Time) {
	if a.Bus == nil {
		return
	}
	payload := ebyte.ReadbackPayload(entityID, now.UTC().Format(time.RFC3339), res)
	if err := a.Bus.Publish(entities.ReadbackTopic(entityID), payload, false); err != nil {
		slog.Error("ebyte readback publish failed", "entity", entityID, "err", err)
	}
}

// --- "Verbindung testen" (core-side one-shot) ---------------------------------

// ebyteTest identifies the module behind the UNSAVED form, reads every input
// and output once and - on success - (re-)pins that device for its address:
// the test is the operator's confirmation after a device swap or a module
// change. It never switches a relay, control_test included.
func (a *Agent) ebyteTest(req testconn.Request) testconn.Result {
	raw, _ := json.Marshal(req.Connection)
	var cfg ebyte.Config
	_ = json.Unmarshal(raw, &cfg)
	cfg.Channel = 0
	ctx, cancel := context.WithTimeout(context.Background(), testReadTimeout)
	defer cancel()
	id, st, de := a.ebyteClientRef().Read(ctx, cfg)
	if de != nil {
		return ebyteTestFailure(de)
	}
	if store := a.ebyteStoreRef(); store != nil {
		if err := store.Put(cfg.Key(), ebyte.PinOf(id)); err != nil {
			slog.Warn("ebyte identity not pinned", "target", cfg.Address(), "err", err)
		}
	}
	res := testconn.Result{OK: true, Reading: &testconn.Reading{}, States: ebyteTestStates(st)}
	if req.ControlTest {
		msg := "Geräte-Watchdog nicht eingerichtet - er wird vor dem ersten Einschalten automatisch gesetzt (nur wenn alle Ausgänge aus sind)."
		if st.Watchdog.Armed() {
			msg = "Geräte-Watchdog aktiv: ohne Verbindung fallen alle Ausgänge ab."
		}
		res.ControlCheck = &testconn.ControlCheck{OK: true, Skipped: true,
			DeviceModel: id.Label(), Message: msg}
	}
	return res
}

// ebyteTestStates lists the channels a test read, outputs first (what the
// customer will assign next), then inputs - balanced so a stack larger than the
// contract's 16 sample rows still shows both kinds.
func ebyteTestStates(st ebyte.State) []testconn.ChannelState {
	half := probe.MaxSamples / 2
	nOut, nIn := len(st.Outputs), len(st.Inputs)
	if nOut > half && nIn > half {
		nOut, nIn = half, half
	} else if nOut > half {
		nOut = min(nOut, probe.MaxSamples-nIn)
	} else if nIn > half {
		nIn = min(nIn, probe.MaxSamples-nOut)
	}
	out := make([]testconn.ChannelState, 0, nOut+nIn)
	for i := 0; i < nOut; i++ {
		out = append(out, testconn.ChannelState{Channel: ebyte.OutputKey(i + 1), Value: b01(st.Outputs[i])})
	}
	for i := 0; i < nIn; i++ {
		out = append(out, testconn.ChannelState{Channel: ebyte.InputKey(i + 1), Value: b01(st.Inputs[i])})
	}
	return out
}

func ebyteTestFailure(de *ebyte.DriverError) testconn.Result {
	code := testconn.ErrInvalidResponse
	switch de.Code {
	case ebyte.ErrUnreachable:
		code = testconn.ErrUnreachable
	case ebyte.ErrInvalidRequest:
		code = testconn.ErrInvalidRequest
	}
	return testconn.Result{OK: false, ErrorCode: code, Message: de.Message}
}
