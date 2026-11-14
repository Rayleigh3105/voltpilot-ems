package agent

// Self-built Modbus devices with write values (Steuerlogik K3, docs/contracts/
// v2/modbus-geraet.md): an air conditioner, a heat pump or a cold-room
// controller the installer described register by register. The CORE owns such a
// device end to end on both box kinds - one connection, every read and every
// write serialized on it (the one-socket rule: many of these devices serve
// exactly one Modbus client). Node-RED has no flow for it.
//
//   - the poll reads the channels at their interval and the read-back of the
//     write values, publishes the channels as entity telemetry (the same
//     envelope vp.modbus.read publishes) and keeps them for the Steuerlogik
//     (<entity>.<signal>) and the fault rule,
//   - the executor turns the arbiter's granted command (setpoint_c, mode,
//     on_off - band, step, change interval and cycle guard already applied)
//     into register writes; without a wish, and while the device reports a
//     fault, every write value gets its rest value; with the plant's control
//     gate shut or without the cloud's release nothing is written,
//   - the guided switch test of the release assistant writes through the same
//     connection (switchExchange routes here).

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusgeraet"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

const (
	// mbPollTick is the poll's beat; each channel is read at its own interval.
	mbPollTick = time.Second
	// mbDefaultReadInterval is a channel's interval without its own (the
	// Baukasten default).
	mbDefaultReadInterval = 10 * time.Second
	// mbReadbackInterval paces the read-back of the write values.
	mbReadbackInterval = 5 * time.Second
	// mbReassert re-writes an unchanged plan (a device restart loses it).
	mbReassert = 60 * time.Second
	// mbStale: a value older than this is not fresh (logic inputs, fault rule).
	mbStale          = 60 * time.Second
	mbConnectTimeout = 3 * time.Second
	mbIOTimeout      = 3 * time.Second
)

// mbGeraet is one device the core owns.
type mbGeraet struct {
	mu       sync.Mutex // serializes every exchange on the one connection
	entityID string
	def      modbusgeraet.Definition
	quelle   string // the raw driver.connection: a changed definition starts over
	client   *modbustcp.Client

	werte   map[string]logikMesswert // channel slug -> value
	gelesen map[string]time.Time     // channel slug -> last read attempt
	ist     modbusgeraet.Ist
	istAt   time.Time
	istLese time.Time

	planFP     string
	planAt     time.Time
	grund      string
	letzteSchr []modbusgeraet.Write
	fehler     string
	// zu: the device left the registry or its definition changed - this
	// instance never opens a connection again (a stale pointer held by the
	// other loop must not leave a second socket behind).
	zu bool
}

// mbDefinition reads the self-built definition of an entity when it is a
// device with write values; ok=false for every other entity (and for a
// definition the box's own rules refuse - the cloud is believed nothing).
func mbDefinition(e entities.Entity) (modbusgeraet.Definition, string, bool) {
	def, quelle, _, ok := mbDefinitionMitFehlern(e)
	return def, quelle, ok
}

// mbDefinitionMitFehlern is mbDefinition plus the refusals of a definition the
// box's rules refuse (quelle is set then, ok false).
func mbDefinitionMitFehlern(e entities.Entity) (modbusgeraet.Definition, string, []modbusgeraet.Fehler, bool) {
	if len(e.Driver) == 0 {
		return modbusgeraet.Definition{}, "", nil, false
	}
	var drv struct {
		Communication string          `json:"communication"`
		Connection    json.RawMessage `json:"connection"`
	}
	if json.Unmarshal(e.Driver, &drv) != nil || drv.Communication != modbusgeraet.Communication || len(drv.Connection) == 0 {
		return modbusgeraet.Definition{}, "", nil, false
	}
	def, fehler := modbusgeraet.Lies(drv.Connection)
	if def.Controls == nil {
		return modbusgeraet.Definition{}, "", nil, false
	}
	if len(fehler) > 0 {
		return modbusgeraet.Definition{}, string(drv.Connection), fehler, false
	}
	return def, string(drv.Connection), nil, true
}

// syncModbusGeraete follows the registry: new devices start, changed ones start
// over, removed ones close their connection.
func (a *Agent) syncModbusGeraete() []*mbGeraet {
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	a.mbMu.Lock()
	defer a.mbMu.Unlock()
	if a.mbGeraete == nil {
		a.mbGeraete = map[string]*mbGeraet{}
	}
	if a.mbAbgelehnt == nil {
		a.mbAbgelehnt = map[string]string{}
	}
	da := map[string]bool{}
	for _, e := range reg.Entities {
		def, quelle, fehler, ok := mbDefinitionMitFehlern(e)
		if !ok {
			if len(fehler) > 0 && a.mbAbgelehnt[e.ID] != quelle {
				// Once per definition, not every second.
				a.mbAbgelehnt[e.ID] = quelle
				slog.Warn("Modbus-Gerät: Definition verletzt die Regeln - nichts wird gelesen oder geschrieben",
					"entity", e.ID, "fehler", fmt.Sprint(fehler))
			}
			continue
		}
		delete(a.mbAbgelehnt, e.ID)
		da[e.ID] = true
		if g := a.mbGeraete[e.ID]; g != nil && g.quelle == quelle {
			continue
		}
		if g := a.mbGeraete[e.ID]; g != nil {
			g.schliesse()
		}
		a.mbGeraete[e.ID] = &mbGeraet{entityID: e.ID, def: def, quelle: quelle,
			werte: map[string]logikMesswert{}, gelesen: map[string]time.Time{}}
		slog.Info("Modbus-Gerät: vom Core gelesen und geschrieben", "entity", e.ID,
			"ziel", net.JoinHostPort(def.Transport.Host, strconv.Itoa(def.Port())),
			"freigegeben", def.Released())
	}
	for id, g := range a.mbGeraete {
		if !da[id] {
			g.schliesse()
			delete(a.mbGeraete, id)
		}
	}
	out := make([]*mbGeraet, 0, len(a.mbGeraete))
	for _, g := range a.mbGeraete {
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].entityID < out[j].entityID })
	return out
}

// mbGeraetFuer returns the running device of an entity, or nil.
func (a *Agent) mbGeraetFuer(entityID string) *mbGeraet {
	a.mbMu.Lock()
	defer a.mbMu.Unlock()
	return a.mbGeraete[entityID]
}

func (g *mbGeraet) schliesse() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.zu = true
	if g.client != nil {
		_ = g.client.Close()
		g.client = nil
	}
}

// verbinde opens the connection on demand; caller holds g.mu. The LAN rule is
// re-checked here, at the one place that opens the socket.
func (a *Agent) verbinde(ctx context.Context, g *mbGeraet) (*modbustcp.Client, error) {
	if g.client != nil {
		return g.client, nil
	}
	if g.zu {
		return nil, fmt.Errorf("Gerät nicht mehr in der Registry")
	}
	if !probe.IsPrivateHost(g.def.Transport.Host) {
		return nil, fmt.Errorf("Ziel %q liegt nicht im lokalen Netz", g.def.Transport.Host)
	}
	dial := a.mbDial
	if dial == nil {
		dial = modbustcp.DefaultDialer
	}
	c, err := modbustcp.Dial(ctx, dial, net.JoinHostPort(strings.TrimSpace(g.def.Transport.Host),
		strconv.Itoa(g.def.Port())), byte(g.def.Unit()), mbConnectTimeout, mbIOTimeout)
	if err != nil {
		return nil, err
	}
	g.client = c
	return c, nil
}

// lese reads one register (or bit) through the open connection; caller holds
// g.mu. A failed exchange closes the connection so the next one starts clean.
func (g *mbGeraet) lese(c *modbustcp.Client, r modbusgeraet.Register) ([]uint16, []bool, error) {
	var regs []uint16
	var bits []bool
	var err error
	addr := uint16(r.Address)
	switch r.Kind {
	case "holding":
		regs, err = c.ReadHolding(addr, uint16(r.Count()))
	case "input":
		regs, err = c.ReadInput(addr, uint16(r.Count()))
	case "coil":
		bits, err = c.ReadCoils(addr, 1)
	case "discrete":
		bits, err = c.ReadDiscreteInputs(addr, 1)
	default:
		err = fmt.Errorf("Registerart %q", r.Kind)
	}
	if err != nil {
		_ = c.Close()
		g.client = nil
	}
	return regs, bits, err
}

// schreibe writes one raw word (or coil) with the control's function code.
func (g *mbGeraet) schreibe(c *modbustcp.Client, fc, address int, raw uint16) error {
	var err error
	switch fc {
	case modbusgeraet.FcCoil:
		err = c.WriteSingleCoil(uint16(address), raw != 0)
	case modbusgeraet.FcSingle:
		err = c.WriteSingleRegister(uint16(address), raw)
	default:
		err = c.WriteRegisters(uint16(address), []uint16{raw})
	}
	if err != nil {
		_ = c.Close()
		g.client = nil
	}
	return err
}

// startModbusGeraetPoll runs the read half; it idles without such a device.
func (a *Agent) startModbusGeraetPoll(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		t := time.NewTicker(mbPollTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				a.mbMu.Lock()
				for _, g := range a.mbGeraete {
					g.schliesse()
				}
				a.mbMu.Unlock()
				return
			case now := <-t.C:
				a.runModbusGeraetPoll(ctx, now)
			}
		}
	}()
}

// runModbusGeraetPoll reads every due channel and read-back of every device
// once and publishes what it read as entity telemetry.
func (a *Agent) runModbusGeraetPoll(ctx context.Context, now time.Time) {
	for _, g := range a.syncModbusGeraete() {
		a.leseGeraet(ctx, g, now)
	}
}

func (a *Agent) leseGeraet(ctx context.Context, g *mbGeraet, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	kanaele := map[string]float64{}
	var fehler error
	for _, ch := range g.def.Channels {
		iv := mbDefaultReadInterval
		if ch.MinReadInterval > 0 {
			iv = time.Duration(ch.MinReadInterval) * time.Second
		}
		if now.Sub(g.gelesen[ch.Slug]) < iv {
			continue
		}
		g.gelesen[ch.Slug] = now
		c, err := a.verbinde(ctx, g)
		if err != nil {
			fehler = err
			break
		}
		regs, bits, err := g.lese(c, ch.Register)
		if err != nil {
			fehler = err
			break
		}
		scale, offset := ch.ChannelScale()
		if v, ok := modbusgeraet.Decode(ch.Register, regs, bits, scale, offset); ok {
			g.werte[ch.Slug] = logikMesswert{v: v, at: now}
			kanaele[ch.Slug] = v
		}
	}
	if fehler == nil && g.def.Controls != nil && now.Sub(g.istLese) >= mbReadbackInterval {
		g.istLese = now
		var ist modbusgeraet.Ist
		for _, c := range g.def.Controls.Values {
			cl, err := a.verbinde(ctx, g)
			if err != nil {
				fehler = err
				break
			}
			regs, bits, err := g.lese(cl, c.ReadbackRegister())
			if err != nil {
				fehler = err
				break
			}
			c.Interpret(regs, bits, &ist)
		}
		if fehler == nil {
			g.ist, g.istAt = ist, now
		}
	}
	a.notiereFehler(g, fehler)
	if len(kanaele) > 0 && a.Bus != nil {
		raw, _ := json.Marshal(map[string]any{
			"schema_version": entities.SchemaVersion,
			"entity_id":      g.entityID,
			"ts":             now.UTC().Format(time.RFC3339),
			"channels":       kanaele,
		})
		if err := a.Bus.Publish(entities.TelemetryTopic(g.entityID), raw, false); err != nil {
			slog.Warn("Modbus-Gerät: Messwerte nicht veröffentlicht", "entity", g.entityID, "err", err)
		}
	}
}

// notiereFehler logs a changed error once (never silent, never a flood);
// caller holds g.mu.
func (a *Agent) notiereFehler(g *mbGeraet, err error) {
	text := ""
	if err != nil {
		text = err.Error()
	}
	if text == g.fehler {
		return
	}
	if text == "" {
		slog.Info("Modbus-Gerät: wieder erreichbar", "entity", g.entityID)
	} else {
		slog.Warn("Modbus-Gerät: Lesen oder Schreiben fehlgeschlagen", "entity", g.entityID, "err", text)
	}
	g.fehler = text
}

// stoerung says whether the device reports a fault: its fault channel is on,
// or the device declares one and it has no fresh value (unknown is no "no
// fault"). A device without a fault channel never reports one.
func (g *mbGeraet) stoerung(now time.Time) bool {
	ch := g.def.ChannelForSignal("fault")
	if ch == nil {
		return false
	}
	w, ok := g.werte[ch.Slug]
	if !ok || now.Sub(w.at) > mbStale {
		return true
	}
	return w.v != 0
}

// runModbusGeraetControlPass is the executor's pass (consumerControlLoop).
func (a *Agent) runModbusGeraetControlPass(ctx context.Context, now time.Time) {
	gate := a.Cfg.ControlEnabled && a.Cfg.ConsumerControlEnabled
	for _, g := range a.syncModbusGeraete() {
		var granted entities.Commands
		if a.arb != nil {
			if d, ok := a.arb.DecisionFor(g.entityID); ok {
				granted = d.Granted
			}
		}
		a.steuereGeraet(ctx, g, granted, gate, now)
	}
}

func (a *Agent) steuereGeraet(ctx context.Context, g *mbGeraet, granted entities.Commands, gate bool, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	writes, grund := modbusgeraet.Plan(g.def, granted, modbusgeraet.Lage{Gate: gate, Fault: g.stoerung(now)})
	if grund != g.grund {
		slog.Info("Modbus-Gerät: Lage der Steuerung", "entity", g.entityID, "grund", grund)
		g.grund = grund
	}
	if len(writes) == 0 {
		g.planFP = ""
		return
	}
	raw, _ := json.Marshal(writes)
	fp := string(raw)
	if fp == g.planFP && now.Sub(g.planAt) < mbReassert {
		a.schreibeWatchdog(ctx, g)
		return
	}
	var fehler error
	for _, w := range writes {
		c, err := a.verbinde(ctx, g)
		if err != nil {
			fehler = err
			break
		}
		if err := g.schreibe(c, w.FC, w.Address, w.Raw); err != nil {
			fehler = err
			break
		}
	}
	a.notiereFehler(g, fehler)
	if fehler != nil {
		g.planFP = "" // try again on the next pass
		return
	}
	if fp != g.planFP {
		slog.Info("Modbus-Gerät: geschrieben", "entity", g.entityID, "werte", schreibText(writes))
	}
	g.planFP, g.planAt, g.letzteSchr = fp, now, writes
	g.istLese = time.Time{} // read the effect back on the next poll
	a.schreibeWatchdog(ctx, g)
}

// schreibeWatchdog keeps the device's own dead-man alive (only while the box
// writes; a box that stops lets the device fall back by itself). Caller holds
// g.mu.
func (a *Agent) schreibeWatchdog(ctx context.Context, g *mbGeraet) {
	cs := g.def.Controls
	if cs == nil || cs.WatchdogAddress == nil {
		return
	}
	v := 0
	if cs.WatchdogValue != nil {
		v = *cs.WatchdogValue
	}
	c, err := a.verbinde(ctx, g)
	if err == nil {
		err = g.schreibe(c, modbusgeraet.FcMultiple, *cs.WatchdogAddress, uint16(v))
	}
	a.notiereFehler(g, err)
}

func schreibText(ws []modbusgeraet.Write) string {
	var teile []string
	for _, w := range ws {
		t := fmt.Sprintf("%s=%v", w.Slug, w.Value)
		if w.Rest {
			t += " (Ruhewert)"
		}
		teile = append(teile, t)
	}
	return strings.Join(teile, ", ")
}

// --- Steuerlogik: inputs and read-back -------------------------------------------

// mbQuelle reads <entity>.<signal> of a device the core owns; ok=false when
// the source is not such a device's signal.
func (a *Agent) mbQuelle(entityID, signal string, now time.Time) (logik.EinWert, bool) {
	g := a.mbGeraetFuer(entityID)
	if g == nil {
		return logik.EinWert{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	ch := g.def.ChannelForSignal(signal)
	if ch == nil {
		return logik.EinWert{}, false
	}
	w, ok := g.werte[ch.Slug]
	if !ok {
		return logik.EinWert{}, true
	}
	alter := now.Sub(w.at).Seconds()
	if alter < 0 {
		alter = 0
	}
	if modbusgeraet.BoolSignals[signal] {
		b := w.v != 0
		return logik.EinWert{Bool: &b, Alter: alter}, true
	}
	v := w.v
	return logik.EinWert{Zahl: &v, Alter: alter}, true
}

// mbIst is the fresh read-back of a device's write values.
func (a *Agent) mbIst(entityID string, now time.Time) (modbusgeraet.Ist, bool) {
	g := a.mbGeraetFuer(entityID)
	if g == nil {
		return modbusgeraet.Ist{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.istAt.IsZero() || now.Sub(g.istAt) > mbStale {
		return modbusgeraet.Ist{}, true
	}
	return g.ist, true
}

// --- switch test through the device's own connection -----------------------------

// mbSwitchExchange runs one test write of the release assistant on a device the
// core owns - through ITS connection, never a second socket. nil when no such
// device answers at the op's address (the caller then uses the bus path).
func (a *Agent) mbSwitchExchange(op probe.Op, value int) *switchBusResult {
	a.syncModbusGeraete()
	var g *mbGeraet
	a.mbMu.Lock()
	for _, x := range a.mbGeraete {
		if strings.EqualFold(strings.TrimSpace(x.def.Transport.Host), strings.TrimSpace(op.Host)) &&
			x.def.Port() == op.EffectivePort() && x.def.Unit() == op.EffectiveUnit() {
			g = x
		}
	}
	a.mbMu.Unlock()
	if g == nil {
		return nil
	}
	fail := func(code, msg string) *switchBusResult {
		return &switchBusResult{ID: op.ID, OK: false, ErrorCode: code, Message: msg}
	}
	ctx, cancel := context.WithTimeout(context.Background(), switchExchangeTimeout)
	defer cancel()
	g.mu.Lock()
	defer g.mu.Unlock()
	c, err := a.verbinde(ctx, g)
	if err != nil {
		return fail(probe.ErrUnreachable, "Das Gerät ist nicht erreichbar: "+err.Error())
	}
	if err := g.schreibe(c, op.EffectiveWriteFC(), op.EffectiveAddress(), uint16(value)); err != nil {
		return fail(probe.ErrInvalidResponse, "Das Gerät hat den Schreibvorgang nicht angenommen: "+err.Error())
	}
	// The executor's plan is NOT reset: a released device returns to it with the
	// test's auto-off and the next re-assert, so the customer sees the test.
	res := &switchBusResult{ID: op.ID, OK: true}
	if op.ReadbackAddress != nil {
		kind := "holding"
		if op.RegisterKind == probe.RegisterKindCoil {
			kind = "coil"
		}
		regs, bits, err := g.lese(c, modbusgeraet.Register{Kind: kind, Address: *op.ReadbackAddress})
		if err == nil {
			rb := 0
			switch {
			case len(bits) > 0 && bits[0]:
				rb = 1
			case len(regs) > 0:
				rb = int(regs[0])
			}
			res.Readback = &rb
		}
	}
	slog.Info("Modbus-Gerät: Test-Schreiben", "entity", g.entityID, "adresse", op.EffectiveAddress(), "wert", value)
	return res
}
