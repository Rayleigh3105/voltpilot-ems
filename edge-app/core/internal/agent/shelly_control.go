package agent

// Shelly consumer-control executor + source poll (the SECOND real consumer
// control path after go-e; internal/shelly owns the transport/mapping). The
// CORE is the single owner of the whole Shelly HTTP socket:
//
//   - the CONTROL pass here (called from the shared consumerControlLoop next
//     to the go-e pass) turns the arbiter's clamped granted command into the
//     dialect relay write + readback and publishes edge/entities/{id}/readback,
//   - the SOURCE POLL reads every configured shelly consumer source and
//     publishes edge/sources/{id}/telemetry (Node-RED deliberately has NO
//     shelly reader; sources.BusConfig excludes these sources),
//   - the D11 connection test (agent.shellyTest) runs in-process.
//
// SAFETY mirrors the go-e executor: the control pass is gated on
// VP_CONTROL_ENABLED AND VP_CONSUMER_CONTROL_ENABLED (both default OFF - zero
// HTTP, byte-identical); the setpoint is the arbiter's CLAMPED grant (consumer
// band + cycle guard bind upstream); the driver-level failsafe is OFF (§4.2 -
// a heating rod without a fresh command must not keep heating) PLUS the
// on-device dead-man timer every ON write carries (shelly.SetURL), so even a
// dead edge lets the relay fall off within the timer window.
//
// The MEASURED power of a metering Shelly (1PM/Plug-S class) is published as
// per-entity telemetry (edge/entities/{id}/telemetry) from the executor's
// readback - the normal E1b chain then carries it: observed health, the
// heartbeat consumers block's actual_kw, the buffered v2 uplink into
// telemetry_v2, and with it the fulfilment ledger's Stufe-2 (INTEGRATED)
// energy evidence. A non-metering Shelly publishes NO power value, ever - the
// ledger then honestly derives Stufe 3 ("angenommen" = Nennleistung x Zeit).

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// shellySourcePollTick is the read cadence of the shelly source poll (a relay
// state + one power value need no sub-10s cadence; well inside the 60-s
// freshness floor).
const shellySourcePollTick = 30 * time.Second

// shellyDoerRef returns the injected doer or the default HTTP client-backed
// one (goeHTTPDoer implements the same structural Get interface).
func (a *Agent) shellyDoerRef() shelly.Doer {
	if a.shellyDoer != nil {
		return a.shellyDoer
	}
	return goeHTTPDoer{c: &http.Client{Timeout: goeHTTPTimeout}}
}

// shellyStoreRef lazily opens the persisted identity store (nil only when the
// data dir is unusable - then every pass detects fresh, honest but slower).
func (a *Agent) shellyStoreRef() *shelly.Store {
	a.shellyStoreMu.Lock()
	defer a.shellyStoreMu.Unlock()
	if a.shellyStore == nil {
		s, err := shelly.NewStore(a.Cfg.DataDir)
		if err != nil {
			slog.Warn("shelly identity store unavailable; detecting fresh each pass", "err", err)
			return nil
		}
		a.shellyStore = s
	}
	return a.shellyStore
}

// shellyIdentity resolves a device's dialect: persisted hit, else ONE fresh
// Detect that is persisted on success ("einmal erkannt, Dialekt persistiert").
func (a *Agent) shellyIdentity(ctx context.Context, doer shelly.Doer, cfg shelly.Config) (shelly.Identity, error) {
	store := a.shellyStoreRef()
	if store != nil {
		if id, ok := store.Get(cfg.Key()); ok {
			return id, nil
		}
	}
	id, err := shelly.Detect(ctx, doer, cfg)
	if err != nil {
		return shelly.Identity{}, err
	}
	if store != nil {
		if err := store.Put(cfg.Key(), id); err != nil {
			slog.Warn("shelly identity not persisted", "key", cfg.Key(), "err", err)
		}
	}
	return id, nil
}

// shellyForgetIdentity drops a cached dialect after a dialect-level
// invalid_response (firmware swap / replaced device behind the same IP), so
// the NEXT pass re-detects exactly once - self-healing, never a loop.
func (a *Agent) shellyForgetIdentity(cfg shelly.Config) {
	if store := a.shellyStoreRef(); store != nil {
		if err := store.Drop(cfg.Key()); err != nil {
			slog.Warn("shelly identity not dropped", "key", cfg.Key(), "err", err)
		}
	}
}

// shellyCommandFor builds the shelly command from the arbiter's CLAMPED
// granted command (the goeCommandFor twin). No decision -> Stale, which the
// driver maps to the §4.2 fail-safe OFF.
func (a *Agent) shellyCommandFor(entityID string) shelly.Command {
	cmd := shelly.Command{ControlEnabled: a.Cfg.ControlEnabled}
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

// runShellyControlPass executes one pass over every shelly-backed consumer
// entity: resolve the persisted dialect, compute the plan from the arbiter's
// granted command and, when the plan changed (or the periodic re-assert is
// due - which also re-arms the on-device dead-man timer), run the write +
// readback, publish the per-entity readback and, on metering models, the
// measured power as entity telemetry. Gated on the two kill-switches: zero
// HTTP while consumer control is off (byte-identical, the go-e discipline).
func (a *Agent) runShellyControlPass(ctx context.Context, doer shelly.Doer,
	lastFP map[string]string, lastAssert map[string]time.Time, now time.Time) {
	if !a.Cfg.ControlEnabled || !a.Cfg.ConsumerControlEnabled || doer == nil {
		return
	}
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	if len(reg.Entities) == 0 {
		return
	}
	seen := map[string]bool{}
	for _, e := range reg.Entities {
		cfg, ok := shelly.ParseDriver(e.Driver)
		if !ok {
			continue // not a shelly-backed entity
		}
		seen[e.ID] = true
		cmd := a.shellyCommandFor(e.ID)
		plan := shelly.PlanFor(cfg, cmd)
		fp := shellyPlanFingerprint(plan)
		due := now.Sub(lastAssert[e.ID]) >= goeReassertInterval
		if fp == lastFP[e.ID] && !due {
			continue
		}
		ident, err := a.shellyIdentity(ctx, doer, cfg)
		if err != nil {
			// Detection failed (device down / password gate): honest warn,
			// and lastAssert paces the retry so a dead device is probed once
			// per re-assert interval, never every 5-s tick.
			slog.Warn("shelly detect failed", "entity", e.ID, "target", cfg.HostPort(), "err", err)
			lastAssert[e.ID] = now
			continue
		}
		res := shelly.Execute(ctx, doer, cfg, ident, cmd)
		if !res.OK {
			slog.Warn("shelly control execute failed", "entity", e.ID,
				"error_code", res.ErrorCode, "msg", res.Message)
			if res.ErrorCode == shelly.ErrInvalidResponse {
				// A dialect-level surprise: forget the cached identity so the
				// next pass re-detects once (firmware swap self-heal).
				a.shellyForgetIdentity(cfg)
			}
		}
		a.publishShellyReadback(e.ID, res, now)
		a.publishShellyEntityTelemetry(e.ID, res, now)
		lastFP[e.ID] = fp
		lastAssert[e.ID] = now
	}
	for id := range lastFP {
		if !seen[id] {
			delete(lastFP, id)
			delete(lastAssert, id)
		}
	}
}

// publishShellyReadback publishes the per-entity readback (NOT retained - a
// live event; the arbitration layer's onEntityReadback folds all_match into
// the heartbeat's tri-state confirmed).
func (a *Agent) publishShellyReadback(entityID string, res shelly.Result, now time.Time) {
	if a.Bus == nil {
		return
	}
	payload := shelly.ReadbackPayload(entityID, now.UTC().Format(time.RFC3339), res)
	if err := a.Bus.Publish(entities.ReadbackTopic(entityID), payload, false); err != nil {
		slog.Error("shelly readback publish failed", "entity", entityID, "err", err)
	}
}

// publishShellyEntityTelemetry publishes the MEASURED power of a metering
// Shelly as normal per-entity telemetry - the E1b chain (observed health,
// consumers actual_kw, buffered v2 uplink -> telemetry_v2 -> the ledger's
// Stufe-2 energy evidence) consumes it like any other entity publisher. A
// non-metering readback carries no power and publishes NOTHING (the ledger
// then honestly stays at Stufe 3 "angenommen").
func (a *Agent) publishShellyEntityTelemetry(entityID string, res shelly.Result, now time.Time) {
	if a.Bus == nil || !res.OK || res.Verdict.PowerKw == nil {
		return
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": entities.SchemaVersion,
		"entity_id":      entityID,
		"ts":             now.UTC().Format(time.RFC3339),
		"channels":       map[string]float64{"power_kw": *res.Verdict.PowerKw},
	})
	if err := a.Bus.Publish(entities.TelemetryTopic(entityID), raw, false); err != nil {
		slog.Error("shelly entity telemetry publish failed", "entity", entityID, "err", err)
	}
}

// shellyPlanFingerprint identifies a plan's write intent so an unchanged
// command is not re-written every tick; the periodic re-assert still re-arms
// the dead-man timer.
func shellyPlanFingerprint(p shelly.Plan) string {
	return p.Mode + "/" + strconv.FormatBool(p.On) + "/" + strconv.Itoa(p.TimerS) + "/" +
		strconv.FormatBool(p.ControlEnabled)
}

// --- Source poll: the READ half (independent of the control flags, like the
// Node-RED source readers for every other transport) --------------------------

// startShellySourcePoll launches the poll loop. It idles cheaply while no
// shelly source is configured.
func (a *Agent) startShellySourcePoll(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(shellySourcePollTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			a.runShellySourcePass(ctx, a.shellyDoerRef())
		}
	}()
}

// runShellySourcePass reads every configured shelly source once and publishes
// its reading on edge/sources/{id}/telemetry: relay_on always (the real fact
// both device classes have - it carries the liveness of the non-metering
// class), load_kw ONLY on metering models (real values incl. an honest 0.0;
// never a fabricated load for a bare relay).
func (a *Agent) runShellySourcePass(ctx context.Context, doer shelly.Doer) {
	for _, s := range a.ListSources() {
		if s.Communication != inverter.CommShellyHTTP {
			continue
		}
		cfg := shelly.Config{IP: s.Connection.IP, Port: s.Connection.Port, Channel: s.Connection.Channel}
		counted := &sourceStatusDoer{inner: doer}
		ident, err := a.shellyIdentity(ctx, counted, cfg)
		if err != nil {
			a.observeShellySource(s, counted.requests, 0, err)
			slog.Warn("shelly source detect failed", "source", s.ID, "target", cfg.HostPort(), "err", err)
			continue
		}
		st, de := shelly.ReadState(ctx, counted, cfg, ident)
		if de != nil {
			a.observeShellySource(s, counted.requests, 0, de)
			slog.Warn("shelly source read failed", "source", s.ID, "target", cfg.HostPort(), "err", de)
			if de.Code == shelly.ErrInvalidResponse {
				a.shellyForgetIdentity(cfg)
			}
			continue
		}
		payload := map[string]any{}
		if st.On != nil {
			payload["relay_on"] = *st.On
		}
		if st.PowerKw != nil {
			payload["load_kw"] = *st.PowerKw
		}
		a.observeShellySource(s, counted.requests, len(payload), nil)
		if len(payload) == 0 {
			continue // nothing honest to publish
		}
		raw, _ := json.Marshal(payload)
		if a.Bus == nil {
			continue
		}
		if err := a.Bus.Publish(sources.TopicPrefix+s.ID+"/telemetry", raw, false); err != nil {
			slog.Warn("shelly source publish failed", "source", s.ID, "err", err)
		}
	}
}

// --- D11 "Verbindung testen" (core-side one-shot) ----------------------------

// shellyTest runs the in-process connection test against the UNSAVED form:
// detect the dialect + metering capability fresh, read the relay state, and -
// on the wizard's explicit control_test - the non-disruptive switch test
// (shelly.ControlCheck: a value-identical off-write ONLY while the relay is
// off; a running heat cycle is read-only + honestly named).
func (a *Agent) shellyTest(req testconn.Request) testconn.Result {
	raw, _ := json.Marshal(req.Connection)
	var cfg shelly.Config
	_ = json.Unmarshal(raw, &cfg)
	doer := a.shellyDoerRef()
	ctx, cancel := context.WithTimeout(context.Background(), testReadTimeout)
	defer cancel()

	ident, err := shelly.Detect(ctx, doer, cfg)
	if err != nil {
		return shellyTestFailure(err)
	}
	st, de := shelly.ReadState(ctx, doer, cfg, ident)
	if de != nil {
		return shellyTestFailure(de)
	}
	res := testconn.Result{OK: true, Reading: &testconn.Reading{}}
	if st.PowerKw != nil {
		res.Reading.LoadKw = st.PowerKw
	}
	if req.ControlTest {
		out := shelly.ControlCheck(ctx, doer, cfg)
		res.ControlCheck = &testconn.ControlCheck{
			OK: out.OK, Skipped: out.Skipped, Key: out.Key, Value: out.Value,
			ErrorCode: out.ErrorCode, Message: out.Message,
			Gen: out.Gen, DeviceModel: out.Model, Metering: out.Metering,
		}
	}
	return res
}

// shellyTestFailure maps a driver error onto the testconn vocabulary with the
// specific German message preserved.
func shellyTestFailure(err error) testconn.Result {
	de, _ := err.(*shelly.DriverError)
	if de == nil {
		return testconn.Result{OK: false, ErrorCode: testconn.ErrUnreachable}
	}
	code := testconn.ErrInvalidResponse
	switch de.Code {
	case shelly.ErrUnreachable:
		code = testconn.ErrUnreachable
	case shelly.ErrInvalidRequest:
		code = testconn.ErrInvalidRequest
	}
	return testconn.Result{OK: false, ErrorCode: code, Message: de.Message}
}
