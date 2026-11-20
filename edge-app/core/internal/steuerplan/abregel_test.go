package steuerplan

import (
	"context"
	"errors"
	"testing"
	"time"
)

func abregelVektoren(t *testing.T) Obj { return m(vectorFile(t, "steuerplan-abregelung-vectors.json")) }

func TestAbregelModul(t *testing.T) {
	v := m(get(abregelVektoren(t), "modul"))
	for _, c := range list(get(v, "split")) {
		o := m(c)
		var us []curtailUnitRated
		for _, x := range list(get(o, "units")) {
			u := m(x)
			if isFiniteNum(u["ratedKw"]) && num(u["ratedKw"]) > 0 {
				us = append(us, curtailUnitRated{str(u["id"]), num(u["ratedKw"])})
			}
		}
		plant := num(get(o, "plantCapKw"))
		if !finite(plant) {
			plant = 0
		}
		unc := 0.0
		if x := get(o, "uncontrolledKw"); isFiniteNum(x) {
			unc = num(x)
			if unc < 0 {
				unc = 0
			}
		}
		budget, caps := splitPlantCap(plant, unc, us)
		capsO := Obj{}
		for k, x := range caps {
			capsO[k] = x
		}
		exakt(t, "splitPlantCap", Obj{"budgetKw": budget, "caps": capsO}, get(o, "out"))
	}
	for _, c := range list(get(v, "enforcement")) {
		a := m(get(m(c), "args"))
		exakt(t, "evaluateEnforcement", curtailEnforcement(get(a, "capKw"), get(a, "measuredKw"), get(a, "measuredAtMs"),
			get(a, "activeSinceMs"), num(get(a, "nowMs"))), get(m(c), "out"))
	}
	for _, c := range list(get(v, "readback")) {
		exakt(t, "evaluateReadback", curtailEvaluateReadback(list(get(m(c), "registers"))), get(m(c), "out"))
	}
	t0 := num(get(abregelVektoren(t), "t0"))
	for _, c := range list(get(v, "decision")) {
		o := m(c)
		u, st := m(get(o, "unit")), m(get(o, "state"))
		d := curtailWriteDecision(u, st, t0, -1)
		same(t, "writeDecision", o, d, get(o, "decision"))
		sig, ok := curtailCommandSignature(u)
		var sv any
		if ok {
			sv = sig
		}
		same(t, "commandSignature", o, sv, get(o, "signature"))
		same(t, "noteWrite", o, curtailNoteWrite(st, d, t0), get(o, "noteWrite"))
		same(t, "noteVerdict held", o, curtailNoteVerdict(st, Obj{"held": true}, t0), get(o, "heldVerdict"))
		same(t, "noteVerdict deviating", o, curtailNoteVerdict(st, Obj{"held": false}, t0), get(o, "badVerdict"))
	}
	for _, c := range list(get(v, "lease")) {
		o := m(c)
		same(t, "discoveryState", o, curtailDiscoveryState(m(get(o, "cached")), t0), get(o, "state"))
	}
	for _, c := range list(get(v, "observe")) {
		o := m(c)
		same(t, "observeDue", o, curtailObserveDue(get(o, "at"), t0), get(o, "due"))
	}
}

// abregelReplay plays one tick's recorded Modbus operations.
type abregelReplay struct {
	t    *testing.T
	what string
	ops  []any
	i    int
}

var errAbregelTot = errors.New("Socket beendet")

func (r *abregelReplay) next(kind string, want map[string]float64) (Obj, error) {
	r.t.Helper()
	if r.i >= len(r.ops) {
		r.t.Errorf("%s: Go fuehrt Operation %d (%s %v) aus, JS nicht mehr", r.what, r.i+1, kind, want)
		return nil, errAbregelTot
	}
	op := m(r.ops[r.i])
	r.i++
	if get(op, "op") == "dead" {
		return nil, errors.New(str(op["error"]))
	}
	if get(op, "op") != kind {
		r.t.Errorf("%s: Operation %d: Go %s %v, JS %v", r.what, r.i, kind, want, op)
		return nil, errAbregelTot
	}
	for k, v := range want {
		if num(get(op, k)) != v {
			r.t.Errorf("%s: Operation %d: Go %s %v, JS %v", r.what, r.i, kind, want, op)
			return nil, errAbregelTot
		}
	}
	if e, ok := op["error"].(string); ok {
		return nil, errors.New(e)
	}
	return op, nil
}

func (r *abregelReplay) Lies(_ context.Context, unit, addr, count int, _ time.Duration) ([]int, error) {
	op, err := r.next("read", map[string]float64{"unit": float64(unit), "addr": float64(addr), "count": float64(count)})
	if err != nil {
		return nil, err
	}
	var regs []int
	for _, x := range list(op["regs"]) {
		regs = append(regs, int(num(x)))
	}
	return regs, nil
}

func (r *abregelReplay) Schreibe6(_ context.Context, unit, addr, value int, _ time.Duration) error {
	_, err := r.next("write6", map[string]float64{"unit": float64(unit), "addr": float64(addr), "value": float64(value)})
	return err
}

func (r *abregelReplay) Schreibe16(_ context.Context, unit, addr int, values []int, _ time.Duration) error {
	op, err := r.next("write16", map[string]float64{"unit": float64(unit), "addr": float64(addr)})
	if op != nil {
		exakt(r.t, r.what+": FC16-Werte", values, op["values"])
	}
	return err
}

func (r *abregelReplay) Close() {}

func TestAbregelKette(t *testing.T) {
	loc := berlin(t)
	for _, c := range list(get(abregelVektoren(t), "kette")) {
		o := m(c)
		flow := clone(get(o, "flow")).(map[string]any)
		for i, tk := range list(get(o, "ticks")) {
			to := m(tk)
			what := str(o["name"]) + " Takt " + itoa(i+1)
			now := at(loc, get(to, "now"))
			for k, v := range m(get(to, "flow_delta")) {
				flow[k] = clone(v)
			}
			var plans []Obj
			for _, p := range list(flow["source_plans"]) {
				plans = append(plans, m(p))
			}
			fleet := AbregelPlanen(m(get(to, "setpoint")), plans, flow, now)
			var gotFleet any
			if fleet != nil {
				gotFleet = fleet
			}
			same(t, what+": Flottenplan", nil, gotFleet, get(to, "fleet"))
			ops := list(get(to, "ops"))
			rep := &abregelReplay{t: t, what: what, ops: ops}
			var payloads []Obj
			if fleet != nil {
				payloads = AbregelAusfuehren(context.Background(), fleet, flow, func() time.Time { return now },
					func(_ context.Context, ip string, port int, _ bool) (AbregelGeraet, bool, error) {
						op, err := rep.next("connect", map[string]float64{"port": float64(port)})
						if err != nil {
							return nil, false, err
						}
						if isTrue(op["fail"]) {
							return nil, false, errAbregelTot
						}
						return rep, true, nil
					})
			}
			if rep.i != len(ops) {
				t.Errorf("%s: Go fuehrte %d von %d Operationen aus", what, rep.i, len(ops))
			}
			got := make([]any, len(payloads))
			shaped := make([]any, len(payloads))
			for k, p := range payloads {
				got[k] = p
				shaped[k] = Form(p, isoMillis(now))
			}
			exakt(t, what+": Rueckmeldungen", got, get(to, "payloads"))
			exakt(t, what+": vp-control-readback", shaped, get(to, "shaped"))
			view := Obj{}
			for k, v := range flow {
				if len(k) > 8 && k[:8] == "curtail_" && (hasPrefix(k, "curtail_disc:") || hasPrefix(k, "curtail_cmd:") ||
					hasPrefix(k, "curtail_was:") || hasPrefix(k, "curtail_enf:") || hasPrefix(k, "curtail_obs:")) {
					view[k] = v
				}
			}
			same(t, what+": Flow-Kontext", nil, view, get(to, "flow_after"))
		}
	}
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }
