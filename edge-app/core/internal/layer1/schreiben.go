package layer1

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/einmalschreiben"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// The one-shot register writes of the register write channel (portal) and the
// :8484 installer action on Edge Light - the executors the Docker box runs in
// Node-RED, behind the same local-bus pairs:
//
//   - edge/register-write/request -> /result: the plain Modbus TCP lane (a
//     component of the plant or a free LAN address; vp-register-write,
//     internal/einmalschreiben)
//   - edge/installer-write/request -> /result: the Solarman lane, the PRIMARY
//     Deye over its logger (the flow's "Installateur-Register lesen/schreiben")
//
// The core admitted the order (identity, expiry, replay, lane, private target,
// rate limit, the expert policy) before it reached the bus; these executors
// decide nothing about policy. Each takes the lane of its device, so a write
// never runs next to the poll of the very device the customer is watching, and
// each answers exactly once - also when the order is unusable.
//
// The time chain (bus-arbitration.js): waiting for the lane plus working must
// stay under the core's wait (installerWriteTimeout, 30 s), else the cloud
// reports timeout while the write is still running.
const (
	defaultWriteLaneWait = 15 * time.Second // ONESHOT_ACQUIRE_MS
	writeSessionBudget   = 12 * time.Second // ONESHOT_SOCKET_MS
)

func (r *Runtime) writeLaneWait() time.Duration {
	if r.opts.WriteLaneWait > 0 {
		return r.opts.WriteLaneWait
	}
	return defaultWriteLaneWait
}

func (r *Runtime) writeSettle() time.Duration {
	if r.opts.WriteSettle > 0 {
		return r.opts.WriteSettle
	}
	return einmalschreiben.Settle
}

// schreibAntwort is one answer on edge/register-write/result or
// edge/installer-write/result.
type schreibAntwort struct {
	RequestID string `json:"request_id"`
	einmalschreiben.Ergebnis
}

func (r *Runtime) antworteSchreiben(topic, id string, e einmalschreiben.Ergebnis) {
	raw, _ := json.Marshal(schreibAntwort{RequestID: id, Ergebnis: e})
	// Non-retained: a write order that reappeared on the next reconnect would
	// spend another EEPROM write cycle on a customer's device.
	if err := r.bus.Publish(topic, raw, false); err != nil {
		r.log.Warn("Schreibergebnis nicht auf den lokalen Bus", "topic", topic, "err", err)
	}
	if !e.OK {
		r.log.Warn("Registerauftrag fehlgeschlagen", "request_id", id, "code", e.ErrorCode, "grund", e.Message)
	}
}

// --- the plain Modbus TCP lane ------------------------------------------------

// onRegisterWrite runs one order of edge/register-write/request.
func (r *Runtime) onRegisterWrite(ctx context.Context, payload []byte) {
	var req map[string]any
	if json.Unmarshal(payload, &req) != nil || req == nil {
		r.log.Warn("Registerauftrag unlesbar; verworfen")
		return
	}
	id, _ := req["request_id"].(string)
	if id == "" {
		r.log.Warn("Registerauftrag ohne request_id; verworfen")
		return
	}
	p, ok := einmalschreiben.PlanAus(req)
	if !ok {
		r.antworteSchreiben(localbus.TopicRegisterWriteResult, id, einmalschreiben.Ungueltig())
		return
	}
	g := &modbusSchreiber{r: r, addr: netJoin(p.Host, p.Port), unit: byte(p.UnitID)}
	defer g.close()
	release, frei := r.lanes.acquire(ctx, g.addr, r.writeLaneWait())
	if !frei {
		r.antworteSchreiben(localbus.TopicRegisterWriteResult, id, einmalschreiben.Ergebnis{ErrorCode: modbusprofil.ErrTimeout,
			Message: "Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen. (" +
				modbusprofil.MeldungWarteschlange + " für " + g.addr + " belegt)"})
		return
	}
	defer release()
	sctx, cancel := context.WithTimeout(ctx, writeSessionBudget)
	defer cancel()
	what := "lese"
	if p.Apply {
		what = "schreibe"
	}
	r.log.Info("Registerauftrag", "request_id", id, "auftrag", what, "ziel", g.addr, "register", p.Addr, "art", p.Kind)
	r.antworteSchreiben(localbus.TopicRegisterWriteResult, id, einmalschreiben.Ausfuehren(sctx, p, g))
}

// modbusSchreiber is the device access of one order: ONE Modbus TCP session,
// opened on first use, failures named in the palette's words.
type modbusSchreiber struct {
	r    *Runtime
	addr string
	unit byte
	c    *modbustcp.Client
}

func (g *modbusSchreiber) client(ctx context.Context) (*modbustcp.Client, string) {
	if g.c != nil {
		return g.c, ""
	}
	c, err := modbustcp.Dial(ctx, g.r.dialTCP, g.addr, g.unit, g.r.opts.ConnectTimeout, g.r.opts.ReadTimeout)
	if err != nil {
		if isTimeout(err) {
			return nil, modbusprofil.MeldungAufbauTimeout + " (" + millis(g.r.opts.ConnectTimeout) + ")"
		}
		return nil, modbusprofil.MeldungAufbau + err.Error()
	}
	g.c = c
	return c, ""
}

func (g *modbusSchreiber) close() {
	if g.c != nil {
		_ = g.c.Close()
	}
}

func (g *modbusSchreiber) LiesRegister(ctx context.Context, p einmalschreiben.Plan) ([]uint16, string) {
	c, m := g.client(ctx)
	if m != "" {
		return nil, m
	}
	w, err := c.ReadHolding(uint16(p.Addr), 1)
	if err != nil {
		return nil, modbusMeldung(err, g.r.opts.ReadTimeout)
	}
	return w, ""
}

func (g *modbusSchreiber) LiesSpulen(ctx context.Context, p einmalschreiben.Plan) ([]bool, string) {
	c, m := g.client(ctx)
	if m != "" {
		return nil, m
	}
	b, err := c.ReadCoils(uint16(p.Addr), 1)
	if err != nil {
		return nil, modbusMeldung(err, g.r.opts.ReadTimeout)
	}
	return b, ""
}

func (g *modbusSchreiber) Schreibe(ctx context.Context, p einmalschreiben.Plan) string {
	c, m := g.client(ctx)
	if m != "" {
		return m
	}
	var err error
	switch p.FC {
	case einmalschreiben.FcWriteCoil:
		err = c.WriteSingleCoil(uint16(p.Addr), *p.Value == 1)
	case einmalschreiben.FcWriteSingle:
		err = c.WriteSingleRegister(uint16(p.Addr), uint16(*p.Value))
	default:
		err = c.WriteRegisters(uint16(p.Addr), []uint16{uint16(*p.Value)})
	}
	if err != nil {
		return modbusMeldung(err, g.r.opts.ReadTimeout)
	}
	return ""
}

func (g *modbusSchreiber) Warte(ctx context.Context, _ time.Duration) {
	t := time.NewTimer(g.r.writeSettle())
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// --- the Solarman lane: the primary Deye ----------------------------------

// installerAuftrag is edge/installer-write/request.
type installerAuftrag struct {
	RequestID      string `json:"request_id"`
	Mode           string `json:"mode"`
	Addr           int    `json:"addr"`
	Value          int    `json:"value"`
	ExpectedBefore *int   `json:"expected_before"`
}

// parseInstallerAuftrag is vp-installer-write-request parse(): the shared
// STRUCTURE (mode, a register address, a register word for apply, an optional
// expected_before that is a register word); "" when usable, else the reason.
func parseInstallerAuftrag(payload []byte) (installerAuftrag, string) {
	var raw map[string]any
	if json.Unmarshal(payload, &raw) != nil || raw == nil {
		return installerAuftrag{}, "unlesbar"
	}
	a := installerAuftrag{}
	a.RequestID, _ = raw["request_id"].(string)
	if a.RequestID == "" {
		return a, "ohne request_id"
	}
	wort := func(v any) (int, bool) {
		f, ok := v.(float64)
		if !ok || f != math.Trunc(f) || f < 0 || f > 0xffff {
			return 0, false
		}
		return int(f), true
	}
	a.Mode, _ = raw["mode"].(string)
	if a.Mode != "dry_run" && a.Mode != "apply" {
		return a, "unbekannter Modus"
	}
	var ok bool
	if a.Addr, ok = wort(raw["addr"]); !ok {
		return a, "Die Adresse ist kein Register (0 bis 65535)."
	}
	if k, da := raw["kind"]; da && k != "" && k != "holding" {
		return a, "Über den Solarman-Logger lassen sich nur Holding-Register beschreiben."
	}
	if v, da := raw["value"]; a.Mode == "apply" || (da && v != nil) {
		if a.Value, ok = wort(v); !ok {
			return a, "Der Wert ist kein Registerwort (0 bis 65535)."
		}
	}
	if e, da := raw["expected_before"]; da && e != nil {
		v, ok := wort(e)
		if !ok {
			return a, "Die Vorbedingung ist kein Registerwort."
		}
		a.ExpectedBefore = &v
	}
	return a, ""
}

// onInstallerWrite runs one order of edge/installer-write/request against the
// primary Deye: ONE logger session under the lane of the logger (the poll and
// every other one-shot wait), read, compare expected_before, write EXACTLY
// ONCE, settle, read back. No retry - the register may live in EEPROM.
func (r *Runtime) onInstallerWrite(ctx context.Context, payload []byte) {
	a, why := parseInstallerAuftrag(payload)
	if a.RequestID == "" {
		r.log.Warn("Installateur-Schreibpfad: Auftrag " + why + "; verworfen")
		return
	}
	antworte := func(e einmalschreiben.Ergebnis) {
		r.antworteSchreiben(localbus.TopicInstallerWriteResult, a.RequestID, e)
	}
	if why != "" {
		antworte(einmalschreiben.Ergebnis{ErrorCode: einmalschreiben.ErrInvalidRequest, Message: why})
		return
	}
	r.mu.Lock()
	sel := r.sel
	r.mu.Unlock()
	p, fc, why := installerZiel(sel)
	if why != "" {
		r.log.Warn("Installateur-Schreibpfad abgelehnt: " + why)
		antworte(einmalschreiben.Ergebnis{ErrorCode: einmalschreiben.ErrInvalidRequest, Message: why})
		return
	}
	release, frei := r.lanes.acquire(ctx, p.Addr, r.writeLaneWait())
	if !frei {
		r.log.Warn("Installateur-Schreibpfad: Logger belegt - Anfrage nicht ausgefuehrt", "ziel", p.Addr)
		antworte(einmalschreiben.Ergebnis{ErrorCode: "busy",
			Message: "Der Wechselrichter-Logger war belegt. Bitte in einem Moment erneut versuchen - es wurde NICHTS geschrieben."})
		return
	}
	defer release()
	sctx, cancel := context.WithTimeout(ctx, writeSessionBudget)
	defer cancel()
	antworte(r.installerAusfuehren(sctx, p, fc, a))
}

// installerZiel is the flow's installerWriteRoute for the transport: only a
// primary inverter read over the Solarman logger is written this way; the
// connection is the poll's own (the order names none). fc is the write form:
// fn 0x06 only when the connection says control_write_fc 6, else fn 0x10.
func installerZiel(sel *selection) (*solarmanPlan, byte, string) {
	if sel == nil {
		return nil, 0, "Es ist kein Wechselrichter eingerichtet."
	}
	if sel.Communication != CommSolarmanV5 {
		return nil, 0, "Dieser Wechselrichter wird nicht über den Solarman-Logger gelesen; der Fernschreibpfad steht nur dort zur Verfügung."
	}
	p, why := planSolarman(sel)
	if p == nil {
		return nil, 0, "Der Wechselrichter ist nicht vollständig eingerichtet: " + why
	}
	fc := byte(0x10)
	if v := sel.Connection["control_write_fc"]; v == 6.0 || v == "6" {
		fc = 0x06
	}
	return p, fc, ""
}

func (r *Runtime) installerAusfuehren(ctx context.Context, p *solarmanPlan, fc byte, a installerAuftrag) einmalschreiben.Ergebnis {
	r.mu.Lock()
	seq := r.seq
	r.mu.Unlock()
	var before, after *int
	wrote := false
	fehler := func(err error) einmalschreiben.Ergebnis {
		e := einmalschreiben.Ergebnis{Wrote: wrote, Before: before, After: after}
		if wrote {
			e.ErrorCode, e.Message = einmalschreiben.ErrWriteUnconfirmed, "Der Schreibbefehl ging hinaus, das Ergebnis ist aber unbestätigt: "+err.Error()
		} else {
			e.ErrorCode, e.Message = "unreachable", "Der Wechselrichter war nicht erreichbar: "+err.Error()
		}
		return e
	}
	sess, err := solarmanv5.Dial(ctx, r.opts.Dialer, p.Addr, p.Serial, p.Slave, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		return fehler(err)
	}
	defer func() {
		_ = sess.Close()
		r.mu.Lock()
		r.seq = sess.Sequence()
		r.mu.Unlock()
	}()
	sess.SetSequence(seq)
	lies := func() (*int, error) {
		w, err := sess.ReadHolding(ctx, uint16(a.Addr), 1)
		if err != nil {
			return nil, err
		}
		v := int(w[0])
		return &v, nil
	}
	if before, err = lies(); err != nil {
		return fehler(err)
	}
	if a.Mode != "apply" {
		return einmalschreiben.Ergebnis{OK: true, Before: before}
	}
	// A stale decision must not overwrite a newer one: if the register moved
	// since the caller read it, NOTHING is written.
	if a.ExpectedBefore != nil && (before == nil || *before != *a.ExpectedBefore) {
		ist := "einem nicht lesbaren Wert"
		if before != nil {
			ist = strconv.Itoa(*before)
		}
		return einmalschreiben.Ergebnis{Before: before, ErrorCode: einmalschreiben.ErrPrecondition,
			Message: "Das Register steht inzwischen auf " + ist + ", erwartet wurde " + strconv.Itoa(*a.ExpectedBefore) +
				". Es wurde NICHTS geschrieben."}
	}
	// From here on the write may have landed even if the answer is lost.
	wrote = true
	if err := sess.WriteRegister(ctx, fc, uint16(a.Addr), uint16(a.Value)); err != nil {
		return fehler(err)
	}
	t := time.NewTimer(r.writeSettle())
	select {
	case <-ctx.Done():
	case <-t.C:
	}
	t.Stop()
	if after, err = lies(); err != nil {
		return fehler(err)
	}
	r.log.Info("Installateur-Register geschrieben", "ziel", p.Addr, "register", "0x"+strings.ToLower(strconv.FormatInt(int64(a.Addr), 16)),
		"vorher", *before, "nachher", *after)
	return einmalschreiben.Ergebnis{OK: true, Wrote: true, Before: before, After: after}
}
