package agent

// Consumer-control executor: the go-e Charger CONTROL path (the write/execution
// counterpart to the read-only go-e source driver). A go-e wallbox is a CONSUMER
// entity; the E2 arbiter (agent/arbitration.go) clamps its desired setpoint
// through the per-entity guard band and grants a command. This loop reads that
// clamped granted command for each go-e-backed entity and drives its physical
// set + readback via internal/goe (the executor twin of nodered/goe/
// goe-control.js, pinned to the same golden vectors).
//
// SAFETY (the control model, root AGENTS.md "Inverter control"):
//   - OFF BY DEFAULT: the whole loop is gated on VP_CONTROL_ENABLED. With the
//     kill-switch off (the default, and the two live read-only sites) this loop
//     issues ZERO HTTP - a customer wallbox is never touched.
//   - GUARD-AUTHORITATIVE: the setpoint is already clamped by the arbiter's
//     per-entity consumer band; internal/goe FLOORS the current so the actual
//     charge power never exceeds it, and clamps to the go-e current band.
//   - FAIL-SAFE NEUTRAL: no fresh arbiter decision (no flow/plan commands the
//     wallbox) -> the command is marked stale -> frc=Neutral hands control back
//     to the wallbox's own logic, never a stuck forced current.
//   - READBACK PUBLISHED: after each set the executor reads /api/status back and
//     publishes edge/entities/{id}/readback (the v1 all_match shape), which the
//     arbitration layer's onEntityReadback already consumes into the heartbeat.
//
// go-e is a CERTIFIED control family: its HTTP API v2 is documented + deterministic
// and the whole write->readback loop is software-provable (no guessed registers,
// unlike Deye/Fronius which stay bench_pending). VERIFY-on-device on the first
// real wallbox (frc/amp + phase behaviour) stays the honest final step.

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goe"
)

const (
	// consumerControlTick is how often the loop re-evaluates the granted
	// commands (a wallbox setpoint need not be sub-second).
	consumerControlTick = 5 * time.Second
	// goeReassertInterval re-writes an unchanged command periodically, so a
	// rebooted wallbox re-adopts the current command without waiting for a
	// decision change.
	goeReassertInterval = 60 * time.Second
	// goeHTTPTimeout bounds one go-e HTTP call.
	goeHTTPTimeout = 8 * time.Second
)

// goeHTTPDoer adapts an *http.Client to goe.Doer.
type goeHTTPDoer struct{ c *http.Client }

func (d goeHTTPDoer) Get(ctx context.Context, url string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
		if len(buf) > 262144 {
			break
		}
		if e != nil {
			break
		}
	}
	return resp.StatusCode, buf, nil
}

// startConsumerControl launches the go-e consumer-control loop. It is a no-op
// while the kill-switch is off (the default), so a read-only deployment never
// pays for it. Called from Start after the arbitration layer is wired.
func (a *Agent) startConsumerControl(ctx context.Context) {
	if a.goeDoer == nil {
		a.goeDoer = goeHTTPDoer{c: &http.Client{Timeout: goeHTTPTimeout}}
	}
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.consumerControlLoop(ctx)
	}()
}

// consumerControlLoop drives one control pass per DRIVER per tick (go-e, then
// shelly; both re-assert a stable command every goeReassertInterval - for
// shelly the re-assert additionally re-arms the on-device dead-man timer).
// Loop-local state (last executed plan fingerprint + last assert time + phase
// switcher per entity) lives here.
func (a *Agent) consumerControlLoop(ctx context.Context) {
	t := time.NewTicker(consumerControlTick)
	defer t.Stop()
	lastFP := map[string]string{}
	lastAssert := map[string]time.Time{}
	switchers := map[string]*goe.PhaseSwitcher{}
	shellyFP := map[string]string{}
	shellyAssert := map[string]time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		a.runGoeControlPass(ctx, a.goeDoer, lastFP, lastAssert, switchers, time.Now())
		a.runShellyControlPass(ctx, a.shellyDoerRef(), shellyFP, shellyAssert, time.Now())
	}
}

// runGoeControlPass executes one pass over every go-e-backed consumer entity:
// compute its plan from the arbiter's granted command and, when the plan changed
// (or a periodic re-assert is due), run the set+readback and publish the
// per-entity readback. Gated on the kill-switch: zero HTTP while control is off.
// Exported-to-the-package (unexported method) so the integration test drives one
// deterministic pass without the loop's timing.
//
// Phase switching (D4): a phase_switching driver gets a stateful
// goe.PhaseSwitcher (dwell + minimum switch pause, Fahrzeug-Elektronik-
// Schonung). The switcher's verdict feeds the pure plan; a paced switch is a
// restrict-only hold whose reason code lands in a.goeHolds so the heartbeat's
// consumers block names it ("wartet - Phasenumschaltpause").
func (a *Agent) runGoeControlPass(ctx context.Context, doer goe.Doer,
	lastFP map[string]string, lastAssert map[string]time.Time,
	switchers map[string]*goe.PhaseSwitcher, now time.Time) {
	// Gated on BOTH the global inverter kill-switch AND the consumer master
	// switch (§19 Inkrement 5): a plant with the consumer flags off never issues
	// a consumer command, byte-for-byte as before the feature.
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
		cfg, ok := goe.ParseDriver(e.Driver)
		if !ok {
			continue // not a go-e-backed entity
		}
		seen[e.ID] = true
		cmd := a.goeCommandFor(e.ID)
		if cfg.PhaseSwitching {
			sw := switchers[e.ID]
			if sw == nil {
				sw = goe.NewPhaseSwitcher(cfg)
				switchers[e.ID] = sw
			}
			ph := sw.Observe(now, goe.DesiredPhaseMode(cfg, cmd))
			cmd.Phase = &ph
		}
		plan := goe.PlanFor(cfg, cmd)
		a.noteGoeHold(e.ID, plan.HoldCode)
		fp := goePlanFingerprint(plan)
		due := now.Sub(lastAssert[e.ID]) >= goeReassertInterval
		if fp == lastFP[e.ID] && !due {
			continue
		}
		res := goe.Execute(ctx, doer, cfg, cmd)
		if !res.OK {
			slog.Warn("go-e control execute failed", "entity", e.ID, "error_code", res.ErrorCode, "msg", res.Message)
		}
		if sw := switchers[e.ID]; sw != nil && res.OK {
			// Feed the CONFIRMED phase position back; record an executed switch
			// so the pause budget starts (only after a transport-error-free
			// set - a failed write never burns the pause).
			if res.Wrote && plan.Psm != nil {
				sw.NoteSwitchExecuted(now, plan.PhasesUsed)
			}
			sw.NoteReadback(res.Verdict.PhaseSwitchMode, res.Verdict.PhasesInUse)
		}
		a.publishGoeReadback(e.ID, res, now)
		lastFP[e.ID] = fp
		lastAssert[e.ID] = now
	}
	// Forget entities no longer present.
	for id := range lastFP {
		if !seen[id] {
			delete(lastFP, id)
			delete(lastAssert, id)
			delete(switchers, id)
			a.noteGoeHold(id, "")
		}
	}
}

// noteGoeHold records the driver-level hold reason of one go-e entity (empty =
// none) for the heartbeat's consumers block. Kept in its own map under goeMu -
// the consumers summary reads it without touching the loop's local state.
func (a *Agent) noteGoeHold(entityID, code string) {
	a.goeMu.Lock()
	defer a.goeMu.Unlock()
	if code == "" {
		delete(a.goeHolds, entityID)
		return
	}
	if a.goeHolds == nil {
		a.goeHolds = map[string]string{}
	}
	a.goeHolds[entityID] = code
}

// goeHoldFor returns the driver-level hold reason code ("" = none).
func (a *Agent) goeHoldFor(entityID string) string {
	a.goeMu.Lock()
	defer a.goeMu.Unlock()
	return a.goeHolds[entityID]
}

// goeCommandFor builds the go-e command from the arbiter's CLAMPED granted
// command for one entity. No decision -> Stale (fail-safe neutral). The granted
// pointers are copied so the executor never aliases the arbiter's state.
func (a *Agent) goeCommandFor(entityID string) goe.Command {
	cmd := goe.Command{ControlEnabled: a.Cfg.ControlEnabled}
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
	// A decision that granted nothing actionable is treated as no-command
	// (neutral), which goe.PlanFor derives from the empty command.
	return cmd
}

// publishGoeReadback publishes the per-entity readback (NOT retained - a live
// event, the vp-control-readback discipline) so the heartbeat folds in all_match.
func (a *Agent) publishGoeReadback(entityID string, res goe.Result, now time.Time) {
	if a.Bus == nil {
		return
	}
	payload := goe.ReadbackPayload(entityID, now.UTC().Format(time.RFC3339), res)
	if err := a.Bus.Publish(entities.ReadbackTopic(entityID), payload, false); err != nil {
		slog.Error("go-e readback publish failed", "entity", entityID, "err", err)
	}
}

// goePlanFingerprint identifies a plan's write intent so an unchanged command is
// not re-written every tick (only on change or the periodic re-assert). psm and
// the hold code are part of it: a switch becoming due (hold -> psm write) must
// execute promptly, not wait for the next re-assert.
func goePlanFingerprint(p goe.Plan) string {
	amp := "-"
	if p.Amp != nil {
		amp = strconv.Itoa(*p.Amp)
	}
	psm := "-"
	if p.Psm != nil {
		psm = strconv.Itoa(*p.Psm)
	}
	return p.Mode + "/" + strconv.Itoa(p.Frc) + "/" + amp + "/" + psm + "/" + p.HoldCode + "/" + strconv.FormatBool(p.ControlEnabled)
}
