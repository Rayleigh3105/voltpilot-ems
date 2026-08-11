package agent

// Modbus-Datenspiegel wiring (internal/mirror): the read-only Modbus-TCP
// slave the customer's building automation (Loxone) reads INSTEAD of the
// single-client Solarman logger. The agent's only duties here are push-
// feeding the mirror's caches from the local bus (raw register blocks,
// control readbacks, the gated composite telemetry), publishing the
// auto-learned want set retained for the Node-RED poll to pick up, and the
// enable/disable + settings surface (GET/POST /api/mirror). The mirror never
// initiates I/O of its own - see internal/mirror's package doc for the
// invariant.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"
)

// initMirror builds the mirror server from the persisted settings (called
// from New, before Start). A corrupt mirror.json falls back to the safe
// defaults (mirror OFF) - it must never stop the agent booting.
func (a *Agent) initMirror() {
	cfg := mirror.DefaultSettings()
	if loaded, ok, err := a.mirStore.Load(); err == nil && ok {
		cfg = loaded
	} else if err != nil {
		slog.Warn("stored mirror settings unreadable; using defaults (mirror off)", "err", err)
	}
	a.mirMu.Lock()
	a.mirSettings = cfg
	a.mirMu.Unlock()
	a.mir = mirror.NewServer(time.Duration(cfg.StaleAfterS)*time.Second, cfg.LearnedBlocks, a.onMirrorWant)
	a.applyMirrorNativeUnit()
}

// applyMirrorNativeUnit points the mirror's native pass-through area at the
// selected inverter's mb_slave_id (default 1). Called on load + selection
// change; a raw-block message's own unit stays authoritative over this.
func (a *Agent) applyMirrorNativeUnit() {
	if a.mir == nil {
		return
	}
	a.invMu.Lock()
	sel := a.inv
	a.invMu.Unlock()
	unit := 1
	if sel != nil && sel.Connection.MbSlaveID > 0 {
		unit = sel.Connection.MbSlaveID
	}
	a.mir.SetNativeUnit(unit)
}

// startMirror subscribes the raw-block topic, republishes the current want
// set retained (so Node-RED keeps polling learned blocks across a core
// restart) and brings the listener up when enabled. A failed listen is
// surfaced on the status ("Fehler"), never a crashed boot.
func (a *Agent) startMirror() error {
	if err := a.Bus.Subscribe(localbus.TopicRegistersRaw, 11, a.onRegistersRaw); err != nil {
		return err
	}
	a.mirMu.Lock()
	cfg := a.mirSettings
	a.mirMu.Unlock()
	a.publishMirrorWant(cfg.Enabled)
	if cfg.Enabled {
		if err := a.mir.Start(fmt.Sprintf(":%d", cfg.Port)); err != nil {
			slog.Error("modbus mirror listener failed to start", "port", cfg.Port, "err", err)
		}
	}
	return nil
}

// onRegistersRaw ingests one retained edge/registers/raw message: the poll's
// raw register blocks, byte-faithful. The payload ts (the POLL time) drives
// the staleness guard, so a stale retained message after a restart re-serves
// nothing as fresh.
func (a *Agent) onRegistersRaw(_ string, payload []byte) {
	if len(payload) == 0 {
		return // cleared retained topic
	}
	var m struct {
		Ts     string            `json:"ts"`
		Unit   int               `json:"unit"`
		Blocks []mirror.RawBlock `json:"blocks"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		slog.Warn("edge/registers/raw malformed; skipped", "err", err)
		return
	}
	if len(m.Blocks) == 0 {
		return
	}
	ts := time.Now().UTC()
	if m.Ts != "" {
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			ts = t.UTC()
		}
	}
	a.mir.UpdateRaw(ts, m.Unit, m.Blocks)
}

// onMirrorWant persists + republishes a changed learned want set. Runs on
// the mirror's request path (outside its lock); keep it cheap and
// non-blocking for consumers - a failed persist only logs.
func (a *Agent) onMirrorWant(blocks []mirror.Block) {
	a.mirMu.Lock()
	a.mirSettings.LearnedBlocks = blocks
	cfg := a.mirSettings
	a.mirMu.Unlock()
	if err := a.mirStore.Save(cfg); err != nil {
		slog.Warn("mirror learned blocks not persisted", "err", err)
	}
	a.publishMirrorWant(cfg.Enabled)
}

// publishMirrorWant publishes the learned want set retained on the local
// bus. A DISABLED mirror publishes an empty set, so the Node-RED poll never
// carries learned blocks for a switched-off mirror (inert when disabled).
func (a *Agent) publishMirrorWant(enabled bool) {
	if a.Bus == nil || a.mir == nil {
		return
	}
	blocks := []mirror.Block{}
	if enabled {
		blocks = a.mir.Wants()
	}
	raw, err := json.Marshal(map[string]any{"blocks": blocks})
	if err != nil {
		return
	}
	if err := a.Bus.Publish(localbus.TopicRegistersWant, raw, true); err != nil {
		slog.Warn("mirror want publish failed", "err", err)
	}
}

// feedMirrorTelemetry pushes the gated composite site reading into the VP
// standard map (called at the onLocalTelemetry choke point, AFTER the
// gates - the mirror serves the same numbers the dashboard and cloud see).
func (a *Agent) feedMirrorTelemetry(ts time.Time, c mirror.Composite) {
	if a.mir != nil {
		a.mir.UpdateComposite(ts, c)
	}
}

// feedMirrorControl pushes a control readback's ACTUAL register values for
// the Deye remote-mode window 1100-1121 into the mirror, so consumers can
// READ the control registers without those ever entering a poll. addr/value
// pairs outside the window are dropped by the mirror.
func (a *Agent) feedMirrorControl(ts time.Time, regs map[uint16]uint16) {
	if a.mir != nil && len(regs) > 0 {
		a.mir.UpdateControl(ts, regs)
	}
}

// --- web controller (GET/POST /api/mirror) ----------------------------------

// GetMirror returns the operator-facing mirror status.
func (a *Agent) GetMirror() mirror.Status {
	a.mirMu.Lock()
	cfg := a.mirSettings
	a.mirMu.Unlock()
	st := mirror.Status{
		Enabled:       cfg.Enabled,
		ListenPort:    cfg.Port,
		AdvertisePort: a.Cfg.MirrorAdvertisePort,
		StaleAfterS:   cfg.StaleAfterS,
	}
	if a.mir != nil {
		st.Running = a.mir.Running()
		st.Error = a.mir.ListenError()
		a.mir.StatusInto(&st)
	}
	return st
}

// SetMirror applies + persists new mirror settings and starts/stops the
// listener accordingly. Validation failures return a German message (400).
func (a *Agent) SetMirror(req mirror.SettingsRequest) (mirror.Status, error) {
	a.mirMu.Lock()
	cfg := a.mirSettings
	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}
	if req.StaleAfterS != nil {
		cfg.StaleAfterS = *req.StaleAfterS
	}
	norm, err := cfg.Normalize()
	if err != nil {
		a.mirMu.Unlock()
		return a.GetMirror(), err
	}
	a.mirSettings = norm
	a.mirMu.Unlock()

	if err := a.mirStore.Save(norm); err != nil {
		return a.GetMirror(), fmt.Errorf("Einstellungen konnten nicht gespeichert werden: %w", err)
	}
	a.mir.SetStaleAfter(time.Duration(norm.StaleAfterS) * time.Second)
	if norm.Enabled {
		if err := a.mir.Start(fmt.Sprintf(":%d", norm.Port)); err != nil {
			slog.Error("modbus mirror listener failed to start", "port", norm.Port, "err", err)
		}
	} else {
		a.mir.Stop()
	}
	// Keep the retained want set in lockstep with the toggle: enabled ->
	// republish the learned blocks; disabled -> clear so the poll goes back to
	// primary-only.
	a.publishMirrorWant(norm.Enabled)
	slog.Info("mirror settings updated", "enabled", norm.Enabled, "stale_after_s", norm.StaleAfterS)
	return a.GetMirror(), nil
}
