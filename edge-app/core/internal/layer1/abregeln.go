package layer1

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/steuerplan"
)

// The PV curtailment of the Fronius SunSpec Erzeuger sources (Steuern in Go,
// Teil 2): the Go twin of the curtailment row of the "Energiequellen
// (automatisch)" tab - edge/setpoint -> "PV-Abregelung / Schreibplan"
// (steuerplan.AbregelPlanen) -> "Fronius WMaxLimPct schreiben +
// zuruecklesen" (steuerplan.AbregelAusfuehren) -> edge/control/readback
// (curtail:true). It runs in its own goroutine beside the Deye path, like the
// flow's own tab: a gateway cycle may take its whole 25-s budget.
//
// The Edge Light release (freigabe.go, path "abregelung") sits in front of the
// core's gates (the curtail block's kill switch, the unit's First-Light grant
// or bounded test): without it the units are discovered and read, never
// written.

// PfadAbregelung is the release path of the curtailment.
const PfadAbregelung = "abregelung"

// abregelWarte is how long a writing cycle waits for a running source read
// of the same gateway (the flow sits a read out for up to 9 s).
const abregelWarte = 9 * time.Second

type abregelung struct {
	mu      sync.Mutex
	pending steuerplan.Obj
	kick    chan struct{}
	// last is the flow's src_last:<id> - written by the source poll.
	last map[string]steuerplan.Obj
	// flow is the volatile flow context of the two nodes (control goroutine).
	flow steuerplan.Obj
}

func newAbregelung() abregelung {
	return abregelung{kick: make(chan struct{}, 1), last: map[string]steuerplan.Obj{}, flow: steuerplan.Obj{}}
}

// merkeQuelle is the flow's src_last stash: what a source read delivered, for
// the uncontrolled share and the effect check.
func (r *Runtime) merkeQuelle(id string, values map[string]any) {
	pick := func(k string) any {
		if v, ok := values[k].(float64); ok {
			return v
		}
		return nil
	}
	rec := steuerplan.Obj{"pv_kw": pick("pv_power_kw"), "power_kw": pick("power_kw"), "load_kw": pick("load_kw"),
		"at": float64(r.opts.Now().UnixMilli())}
	if rec["pv_kw"] == nil && rec["power_kw"] == nil && rec["load_kw"] == nil {
		return
	}
	r.ab.mu.Lock()
	r.ab.last[id] = rec
	r.ab.mu.Unlock()
}

func (r *Runtime) abregelSollwert(sp steuerplan.Obj) {
	r.ab.mu.Lock()
	r.ab.pending = sp
	r.ab.mu.Unlock()
	select {
	case r.ab.kick <- struct{}{}:
	default:
	}
}

func (r *Runtime) runAbregeln(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.ab.kick:
		}
		r.ab.mu.Lock()
		sp := r.ab.pending
		r.ab.pending = nil
		for id, rec := range r.ab.last {
			r.ab.flow["src_last:"+id] = rec
		}
		r.ab.mu.Unlock()
		if sp != nil {
			r.abregelTakt(ctx, sp)
		}
	}
}

// abregelPlaene are the flow's source_plans of the SunSpec sources (adapter
// sunspec_live) with the comm of each source.
func (r *Runtime) abregelPlaene() ([]steuerplan.Obj, map[string]string) {
	r.srcMu.Lock()
	defer r.srcMu.Unlock()
	var out []steuerplan.Obj
	comm := map[string]string{}
	for _, p := range r.srcPlans {
		if p.Sunspec == nil || !isSunSpecComm(p.Comm) {
			continue
		}
		c := p.Conn
		ip, _ := c["ip"].(string)
		mt := "auto"
		if v, _ := c["model_type"].(string); v == "float" || v == "int_sf" {
			mt = v
		}
		inv, _ := c["invert_grid_sign"].(bool)
		out = append(out, steuerplan.Obj{"id": p.ID, "role": p.Role, "adapter": "sunspec_live",
			"conn": steuerplan.Obj{"ip": strings.TrimSpace(ip), "port": num(c["port"], 502), "unit_id": num(c["unit_id"], 1),
				"invert_grid_sign": inv, "model_type": mt, "curtail_write_fc": num(c["curtail_write_fc"], 0)}})
		comm[p.ID] = p.Comm
	}
	return out, comm
}

// abregelTor closes the unit grants of every source whose family Edge Light
// may not curtail yet; it returns the ids it closed.
func abregelTor(sp steuerplan.Obj, comm map[string]string) (steuerplan.Obj, map[string]bool) {
	cur, _ := sp["curtail"].(map[string]any)
	list, _ := cur["sources"].([]any)
	if len(list) == 0 {
		return sp, nil
	}
	gesperrt := map[string]bool{}
	neu := make([]any, len(list))
	for i, e := range list {
		neu[i] = e
		o, _ := e.(map[string]any)
		id, _ := o["id"].(string)
		if o == nil || steuernFreigegeben(comm[id], PfadAbregelung) || (o["certified"] != true && o["test"] == nil) {
			continue
		}
		c := make(map[string]any, len(o))
		for k, v := range o {
			if k != "test" {
				c[k] = v
			}
		}
		c["certified"] = false
		neu[i] = c
		gesperrt[id] = true
	}
	if len(gesperrt) == 0 {
		return sp, nil
	}
	cc := make(map[string]any, len(cur))
	for k, v := range cur {
		cc[k] = v
	}
	cc["sources"] = neu
	out := make(steuerplan.Obj, len(sp))
	for k, v := range sp {
		out[k] = v
	}
	out["curtail"] = cc
	return out, gesperrt
}

func (r *Runtime) abregelTakt(ctx context.Context, sp steuerplan.Obj) {
	plans, comm := r.abregelPlaene()
	sp, gesperrt := abregelTor(sp, comm)
	fleet := steuerplan.AbregelPlanen(sp, plans, r.ab.flow, r.opts.Now())
	if fleet == nil {
		return
	}
	if units, _ := fleet["units"].([]any); len(gesperrt) > 0 {
		for _, x := range units {
			u, _ := x.(map[string]any)
			id, _ := u["sourceId"].(string)
			if gesperrt[id] && u["writeAllowed"] != true {
				if plan, _ := u["plan"].(map[string]any); plan["ok"] == true {
					u["reason"] = "Edge Light: Abregelung für " + comm[id] + " noch nicht am Prüfstand freigegeben - es wird nur gelesen"
				}
			}
		}
	}
	payloads := steuerplan.AbregelAusfuehren(ctx, fleet, r.ab.flow, r.opts.Now, r.abregelVerbinde)
	for _, p := range payloads {
		shaped := steuerplan.Form(p, isoMillis(r.opts.Now()))
		if shaped == nil {
			continue
		}
		if reason, _ := shaped["reason"].(string); shaped["blocked"] == true && reason != "" {
			r.steuerWarnung("PV-Abregelung (" + str(shaped["unit_key"]) + "): " + reason)
		}
		raw, _ := json.Marshal(shaped)
		if err := r.bus.Publish(localbus.TopicControlReadback, raw, false); err != nil {
			r.log.Warn("Abregel-Rueckmeldung nicht gesendet", "err", err)
		}
	}
}

func str(v any) string { s, _ := v.(string); return s }

// abregelVerbinde opens one gateway on its lane: an observation is put off
// while a source read holds the lane, a writing cycle waits it out.
func (r *Runtime) abregelVerbinde(ctx context.Context, ip string, port int, observe bool) (steuerplan.AbregelGeraet, bool, error) {
	addr := netJoin(ip, port)
	var release func()
	var ok bool
	if observe {
		release, ok = r.lanes.tryAcquire(addr)
		if !ok {
			return nil, false, nil
		}
	} else if release, ok = r.lanes.acquire(ctx, addr, abregelWarte); !ok {
		return nil, false, errors.New("Gateway belegt")
	}
	c, err := modbustcp.Dial(ctx, r.dialTCP, addr, 1, r.opts.ConnectTimeout, r.opts.ReadTimeout)
	if err != nil {
		release()
		return nil, false, err
	}
	return &abregelModbus{c: c, release: release}, true, nil
}

// abregelModbus is one gateway session; its errors carry the sentences of the
// flow's openSock (they reach the readback reason).
type abregelModbus struct {
	c       *modbustcp.Client
	release func()
}

func (g *abregelModbus) on(unit int, timeout time.Duration) {
	g.c.SetUnit(byte(unit))
	g.c.SetTimeout(timeout)
}

func abregelFehler(err error) error {
	var ex *modbustcp.ExceptionError
	if errors.As(err, &ex) {
		return errors.New("Modbus-Ausnahme 0x" + strconv.FormatInt(int64(ex.Code), 16))
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return errors.New("Timeout")
	}
	if strings.Contains(err.Error(), "foreign transaction") {
		return errors.New("Transaktions-ID")
	}
	return err
}

func (g *abregelModbus) Lies(_ context.Context, unit, addr, count int, timeout time.Duration) ([]int, error) {
	g.on(unit, timeout)
	regs, err := g.c.ReadHolding(uint16(addr), uint16(count))
	if err != nil {
		return nil, abregelFehler(err)
	}
	out := make([]int, len(regs))
	for i, v := range regs {
		out[i] = int(v)
	}
	return out, nil
}

func (g *abregelModbus) Schreibe6(_ context.Context, unit, addr, value int, timeout time.Duration) error {
	g.on(unit, timeout)
	if err := g.c.WriteSingleRegister(uint16(addr), uint16(value)); err != nil {
		return abregelFehler(err)
	}
	return nil
}

func (g *abregelModbus) Schreibe16(_ context.Context, unit, addr int, values []int, timeout time.Duration) error {
	g.on(unit, timeout)
	vs := make([]uint16, len(values))
	for i, v := range values {
		vs[i] = uint16(v)
	}
	if err := g.c.WriteRegisters(uint16(addr), vs); err != nil {
		return abregelFehler(err)
	}
	return nil
}

func (g *abregelModbus) Close() {
	_ = g.c.Close()
	g.release()
}
