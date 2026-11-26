package layer1

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/huaweidecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/steuerplan"
)

// The Huawei control path of Edge Light and Edge Industrie (both box programs
// run this Layer 1 through internal/kernmain): steuerplan.HuaweiPlanen and
// steuerplan.HuaweiAusfuehren over the device's ONE Modbus TCP session, shared
// with the poll through the lane of its address and opened with the dongle's
// connect pause. The discharge limit 47077 only (captain, 26.11.2026, option
// C: H and E_laden block discharging, E_decken frees it); the charge limit and
// grid charging are not part of it.
//
// The device's own values (Ausgang) are stored in the durable control store
// before the first write; every handback - Not-Aus, a stale setpoint, a
// missing release or certificate, the day budget, the restart - writes them
// back and drops them only once they read back.

// PfadHuawei is the release path of the Huawei window path.
const PfadHuawei = "huawei"

// huaweiSteuerBudget bounds one control tick on the dongle: the connect pause
// and up to ten exchanges.
const huaweiSteuerBudget = 25 * time.Second

func huaweiBudgetKey(ziel string) string { return "huawei:" + ziel }

// huaweiVerbindung is the selection's address as the read plan takes it
// (planHuawei): ip, port (502), unit (0 unless the form says otherwise).
func huaweiVerbindung(sel steuerplan.Obj) (ip string, port, unit int) {
	conn, _ := sel["connection"].(map[string]any)
	ip, _ = conn["ip"].(string)
	ip = strings.TrimSpace(ip)
	port = int(num(conn["port"], huaweidecode.DefaultPort))
	if port <= 0 || port > 65535 {
		port = huaweidecode.DefaultPort
	}
	u := num(conn["unit_id"], huaweidecode.DefaultUnitID)
	if u < 0 || u > 255 || u != float64(int(u)) {
		u = huaweidecode.DefaultUnitID
	}
	return ip, port, int(u)
}

// steuerTaktHuawei is one setpoint tick for a Huawei.
func (r *Runtime) steuerTaktHuawei(ctx context.Context, sel, sp steuerplan.Obj) {
	now := r.opts.Now()
	ip, port, unit := huaweiVerbindung(sel)
	familie, _ := sel["family"].(string)
	modell, _ := sel["model"].(string)
	familie, modell = strings.TrimSpace(familie), strings.TrimSpace(modell)
	ziel := netJoin(ip, port)
	ausgang := steuerplan.HuaweiAusgangAus(r.st.ablage.Huawei[ziel])
	e := steuerplan.HuaweiPlanen(steuerplan.HuaweiEingabe{Selection: sel, Setpoint: sp,
		Freigegeben: steuernFreigegebenModell(familie, PfadHuawei, modell), MitAusgang: ausgang != nil, Now: now})
	if e.Folge == "" {
		if e.Gesperrt && ip != "" {
			r.steuerWarnung("Steuerung (" + ziel + "): " + e.Grund)
		}
		r.steuerRueckmelden(steuerplan.HuaweiGesperrtPayload(e, familie, sp, now), now)
		return
	}
	r.huaweiFahren(ctx, ziel, ip, port, unit, familie, sp, e, ausgang)
}

// huaweiFahren runs one executor tick over the lane of the device.
func (r *Runtime) huaweiFahren(ctx context.Context, ziel, ip string, port, unit int, familie string,
	sp steuerplan.Obj, e steuerplan.HuaweiEntscheid, ausgang map[int]int) {
	now := r.opts.Now()
	a := r.st.ablage
	key := huaweiBudgetKey(ziel)
	budget := steuerplan.TouBudgetToday(a.Budget[key], now)
	limit := steuerplan.TouBudgetLimit(sp["persistent_write_budget"])

	release, ok := r.lanes.acquire(ctx, ziel, steuerLaneWait)
	if !ok {
		r.steuerWarnung("Steuerung (" + ziel + "): Wechselrichter belegt - Schreiben auf den naechsten Takt verschoben")
		return
	}
	defer release()
	sctx, cancel := context.WithTimeout(ctx, huaweiSteuerBudget)
	defer cancel()
	c, err := modbustcp.Dial(sctx, r.dialTCP, ziel, byte(unit), r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		r.steuerWarnung("Steuerung (" + ziel + "): Huawei nicht erreichbar: " + err.Error())
		return
	}
	defer c.Close()
	if err := pauseAfterConnect(sctx, r.opts.HuaweiConnectPause); err != nil {
		return
	}
	res := steuerplan.HuaweiAusfuehren(sctx, steuerplan.HuaweiLauf{Entscheid: e, Family: familie, Setpoint: sp,
		Ausgang: ausgang, Budget: budget, Limit: limit, Now: now,
		Sichern: func(m map[int]int) error {
			a.Huawei[ziel] = steuerplan.HuaweiAusgangObj(m, ip, port, unit, now)
			if err := r.steuerSpeichernErr(); err != nil {
				delete(a.Huawei, ziel)
				return err
			}
			return nil
		}}, huaweiSpur{c: c, timeout: r.opts.ReadTimeout})
	geaendert := false
	if res.Ausgang == nil && a.Huawei[ziel] != nil {
		delete(a.Huawei, ziel)
		geaendert = true
	}
	if res.Budget != budget {
		a.Budget[key] = steuerplan.HuaweiBudgetObj(res.Budget)
		geaendert = true
	}
	if geaendert {
		r.steuerSpeichern()
	}
	if res.Warnung != "" {
		r.steuerWarnung("Steuerung (" + ziel + "): " + res.Warnung)
	}
	r.steuerRueckmelden(res.Payload, now)
}

// huaweiAbsturz hands back, once at start, every device the box had written
// to before it stopped (its Ausgang is still in the store).
func (r *Runtime) huaweiAbsturz(ctx context.Context) {
	for ziel, o := range r.st.ablage.Huawei {
		ausgang := steuerplan.HuaweiAusgangAus(o)
		ip, _ := o["ip"].(string)
		if ausgang == nil || ip == "" {
			r.log.Warn("Huawei-Ausgangswerte in der Steuer-Ablage unvollstaendig - verworfen", "ziel", ziel)
			delete(r.st.ablage.Huawei, ziel)
			continue
		}
		port, _ := o["port"].(float64)
		unit, _ := o["unit_id"].(float64)
		r.log.Warn("Huawei: Steuerung lief beim letzten Stopp - Rueckgabe an den Wechselrichter", "ziel", ziel)
		e := steuerplan.HuaweiEntscheid{Folge: steuerplan.FolgeRueckgabe, Schritte: steuerplan.HuaweiRueckgabe(),
			Gesperrt: true, Grund: "Neustart der Box: Rückgabe an den Wechselrichter"}
		r.huaweiFahren(ctx, ziel, ip, int(port), int(unit), steuerplan.CommHuawei,
			steuerplan.Obj{"source": "crash_recovery"}, e, ausgang)
	}
}

// steuerRueckmelden shapes a readback payload and publishes it.
func (r *Runtime) steuerRueckmelden(payload steuerplan.Obj, now time.Time) {
	shaped := steuerplan.Form(payload, isoMillis(now))
	if shaped == nil {
		return
	}
	raw, _ := json.Marshal(shaped)
	if err := r.bus.Publish(localbus.TopicControlReadback, raw, false); err != nil {
		r.log.Warn("Steuer-Rueckmeldung nicht gesendet", "err", err)
	}
}

// huaweiSpur is the executor's view of the Modbus TCP session: U16 by FC6,
// U32 (high word first) by FC16; every exchange bounded by the tick.
type huaweiSpur struct {
	c       *modbustcp.Client
	timeout time.Duration
}

func (h huaweiSpur) frist(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t := h.timeout
	if d, ok := ctx.Deadline(); ok && time.Until(d) < t {
		t = time.Until(d)
	}
	h.c.SetTimeout(t)
	return nil
}

func (h huaweiSpur) Lies(ctx context.Context, addr, worte int) (int, error) {
	if err := h.frist(ctx); err != nil {
		return 0, err
	}
	regs, err := h.c.ReadHolding(uint16(addr), uint16(worte))
	if err != nil {
		return 0, err
	}
	if worte == 2 {
		return int(uint32(regs[0])<<16 | uint32(regs[1])), nil
	}
	return int(regs[0]), nil
}

func (h huaweiSpur) Schreibe(ctx context.Context, addr, worte, wert int) error {
	if err := h.frist(ctx); err != nil {
		return err
	}
	if worte == 2 {
		return h.c.WriteRegisters(uint16(addr), []uint16{uint16(uint32(wert) >> 16), uint16(uint32(wert))})
	}
	return h.c.WriteSingleRegister(uint16(addr), uint16(wert))
}
