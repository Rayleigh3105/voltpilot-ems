// Guided switch test (Einheitsmodell Stufe 4) - the ONLY writing path of the
// probe channel, and the reason the release assistant can prove a customer's
// own wiring before anything is released.
//
// THE ORDER IS THE SAFETY: the auto-off is ARMED BEFORE the write goes out, not
// after it succeeds. A watchdog that only a successful write winds up is
// missing in exactly the situation it exists for - the write landed but the
// answer did not, so the device is on and nobody knows. Arming first means the
// worst case is a redundant off-write to a device that was never switched on,
// which costs nothing. It is the `calWatchdog` pattern (agent/calibration.go)
// applied to a foreign register.
//
// THE CORE STILL OPENS NO SOCKET. The write travels the local bus to
// vp-modbus-switch-test, which uses the SAME per-target connection manager as
// every read (edge-app/nodered/vp-palette/lib/modbus-conn.js): one in-flight
// operation per (host, port) across the whole runtime. A test that opened its
// own connection would not be "one more operation" - on a single-session
// gateway it would displace the running poll of the very device the customer is
// watching.
package agent

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// switchExchangeTimeout bounds ONE local-bus write round trip. Wider than the
// read exchange because a write plus its readback are two device operations
// that may queue behind a running poll.
var switchExchangeTimeout = 20 * time.Second

// switchBusOp is one write handed to the palette node. It carries the function
// code and the ONE value - never a range, never an alternative - so the node
// has nothing left to decide.
type switchBusOp struct {
	ID              string `json:"id"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	UnitID          int    `json:"unit_id"`
	FC              int    `json:"fc"`
	Address         int    `json:"address"`
	Value           int    `json:"value"`
	ReadbackAddress *int   `json:"readback_address,omitempty"`
}

type switchBusRequest struct {
	RequestID string        `json:"request_id"`
	Ops       []switchBusOp `json:"ops"`
}

type switchBusResult struct {
	ID        string `json:"id"`
	OK        bool   `json:"ok"`
	Readback  *int   `json:"readback,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
}

type switchBusResponse struct {
	RequestID string            `json:"request_id"`
	Results   []switchBusResult `json:"results"`
}

// switchTarget identifies the ONE register a watchdog belongs to. A test on
// another register of the same device is a different pending auto-off.
func switchTarget(op probe.Op) string {
	return fmt.Sprintf("%s:%d:%d:%s:%d", strings.TrimSpace(op.Host), op.EffectivePort(),
		op.EffectiveUnit(), op.RegisterKind, op.EffectiveAddress())
}

// runSwitchOp executes ONE admitted switch op. Sequential by construction: the
// caller loops, because two writes to one device must never race and the
// watchdog bookkeeping has to stay in step with what was really sent.
func (a *Agent) runSwitchOp(op probe.Op) probe.OpResult {
	key := switchTarget(op)
	value := *op.OffValue
	var offAfter *int

	if op.Op == probe.OpSwitchTest {
		value = *op.OnValue
		ttl := op.EffectiveTTL()
		// ARM FIRST - see the package comment. The watchdog owns the revert from
		// this moment on, whatever happens to the write below.
		a.armSwitchWatchdog(key, op, time.Duration(ttl)*time.Second)
		t := ttl
		offAfter = &t
	} else {
		// A cancel takes the revert away from the watchdog and performs it now.
		a.cancelSwitchWatchdog(key)
	}

	res := a.switchExchange(op, value)
	if res == nil {
		return probe.Failed(op.ID, probe.ErrTimeout,
			"Der Schaltbefehl hat nicht rechtzeitig geantwortet.")
	}
	if !res.OK {
		code, msg := res.ErrorCode, res.Message
		if code == "" {
			code, msg = probe.ErrInvalidResponse, "Die Antwort des Geräts war nicht lesbar."
		}
		// ⚠ A FAILED test write deliberately KEEPS its armed watchdog: the write
		// may well have landed and only its answer got lost, and an unarmed
		// device that is on is the one outcome this whole design exists to
		// prevent. The redundant off-write it may cause is harmless.
		return probe.Failed(op.ID, code, msg)
	}
	return probe.SucceededSwitch(op.ID, value, offAfter, res.Readback)
}

// armSwitchWatchdog (re)starts the auto-off for one target. A second test on
// the same register replaces the first timer - there is only ever one pending
// revert per register, so two overlapping tests cannot leave one behind.
func (a *Agent) armSwitchWatchdog(key string, op probe.Op, d time.Duration) {
	a.switchMu.Lock()
	if a.switchTimers == nil {
		a.switchTimers = map[string]*time.Timer{}
	}
	if t := a.switchTimers[key]; t != nil {
		t.Stop()
	}
	revert := op
	revert.Op = probe.OpSwitchCancel
	a.switchTimers[key] = time.AfterFunc(d, func() {
		a.switchMu.Lock()
		delete(a.switchTimers, key)
		a.switchMu.Unlock()
		slog.Info("Schalt-Test: automatisches Aus", "target", key, "wert", *op.OffValue)
		if res := a.switchExchange(revert, *op.OffValue); res == nil || !res.OK {
			// LOUD, because this is the one failure a customer must hear about:
			// the device may still be switched on and only the operator at the
			// device can put it back.
			slog.Error("Schalt-Test: automatisches Aus FEHLGESCHLAGEN - Gerät prüfen",
				"target", key, "wert", *op.OffValue)
		}
	})
	a.switchMu.Unlock()
}

// cancelSwitchWatchdog stops a pending auto-off. It never writes - the caller
// performs the off-write itself, so the register is off before this returns.
func (a *Agent) cancelSwitchWatchdog(key string) {
	a.switchMu.Lock()
	if t := a.switchTimers[key]; t != nil {
		t.Stop()
		delete(a.switchTimers, key)
	}
	a.switchMu.Unlock()
}

// switchExchange runs ONE correlated write round trip over the local bus. Same
// discipline as probeExchange: buffered channel, no retry (a write is repeated
// by a deliberate second click, never by the box).
func (a *Agent) switchExchange(op probe.Op, value int) *switchBusResult {
	if op.Transport == probe.TransportEbyte {
		// The I/O module is CORE-owned: its outputs are written by the core
		// driver, never by the Node-RED switch node (one socket owner). The
		// auto-off below reaches this same branch, so it cannot miss.
		return a.ebyteSwitchExchange(op, value)
	}
	if a.Bus == nil {
		return nil
	}
	// The correlation id is per EXCHANGE, not per cloud request: the auto-off
	// runs long after the cloud request is answered and still needs its own.
	id := fmt.Sprintf("sw%d", time.Now().UnixNano())
	ch := make(chan []switchBusResult, 1)
	a.switchMu.Lock()
	if a.switchWaiters == nil {
		a.switchWaiters = map[string]chan []switchBusResult{}
	}
	a.switchWaiters[id] = ch
	a.switchMu.Unlock()
	defer func() {
		a.switchMu.Lock()
		delete(a.switchWaiters, id)
		a.switchMu.Unlock()
	}()

	raw, err := json.Marshal(switchBusRequest{RequestID: id, Ops: []switchBusOp{{
		ID:              op.ID,
		Host:            strings.TrimSpace(op.Host),
		Port:            op.EffectivePort(),
		UnitID:          op.EffectiveUnit(),
		FC:              op.EffectiveWriteFC(),
		Address:         op.EffectiveAddress(),
		Value:           value,
		ReadbackAddress: op.ReadbackAddress,
	}}})
	if err != nil {
		return nil
	}
	if err := a.Bus.Publish(localbus.TopicSwitchRequest, raw, false); err != nil {
		slog.Error("Schalt-Test: Anfrage konnte nicht veroeffentlicht werden", "err", err)
		return nil
	}
	select {
	case results := <-ch:
		for _, r := range results {
			if r.ID == op.ID {
				out := r
				return &out
			}
		}
		return nil
	case <-time.After(switchExchangeTimeout):
		return nil
	}
}

// onSwitchBusResult routes an answer back to the waiting exchange.
func (a *Agent) onSwitchBusResult(_ string, payload []byte) {
	var res switchBusResponse
	if err := json.Unmarshal(payload, &res); err != nil || res.RequestID == "" {
		return
	}
	a.switchMu.Lock()
	ch := a.switchWaiters[res.RequestID]
	a.switchMu.Unlock()
	if ch == nil {
		return // already timed out - the late answer is dropped, never applied
	}
	select {
	case ch <- res.Results:
	default:
	}
}

// controlGate is the retained plant-wide gate a Node-RED executor reads instead
// of the box's env. It is published at boot and whenever the flags could have
// changed; a runtime without it writes NOTHING (fail-closed).
type controlGate struct {
	SchemaVersion          string `json:"schema_version"`
	Ts                     string `json:"ts"`
	ControlEnabled         bool   `json:"control_enabled"`
	ConsumerControlEnabled bool   `json:"consumer_control_enabled"`
}

// publishControlGate publishes the retained gate. Best-effort and never fatal -
// a missing gate makes an executor refuse to write, which is the safe direction.
func (a *Agent) publishControlGate() {
	if a.Bus == nil {
		return
	}
	raw, err := json.Marshal(controlGate{
		SchemaVersion:          "1.0",
		Ts:                     time.Now().UTC().Format(time.RFC3339),
		ControlEnabled:         a.Cfg.ControlEnabled,
		ConsumerControlEnabled: a.Cfg.ConsumerControlEnabled,
	})
	if err != nil {
		return
	}
	if err := a.Bus.Publish(localbus.TopicControlGate, raw, true); err != nil {
		slog.Warn("Steuerungs-Tor konnte nicht veroeffentlicht werden", "err", err)
	}
}
