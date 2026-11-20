package steuerplan

import (
	"context"
	"errors"
	"testing"
)

type modbusReplay struct {
	t    *testing.T
	what string
	ops  []any
	i    int
}

var errModbusTot = errors.New("Socket beendet")

func (r *modbusReplay) next(kind string, want map[string]float64) (Obj, error) {
	r.t.Helper()
	if r.i >= len(r.ops) {
		r.t.Errorf("%s: Go fuehrt Operation %d (%s %v) aus, JS nicht mehr", r.what, r.i+1, kind, want)
		return nil, errModbusTot
	}
	op := m(r.ops[r.i])
	r.i++
	if get(op, "op") != kind {
		r.t.Errorf("%s: Operation %d: Go %s %v, JS %v", r.what, r.i, kind, want, op)
		return nil, errModbusTot
	}
	for k, v := range want {
		if num(get(op, k)) != v {
			r.t.Errorf("%s: Operation %d: Go %s %v, JS %v", r.what, r.i, kind, want, op)
			return nil, errModbusTot
		}
	}
	if isTrue(op["fail"]) {
		return nil, errModbusTot
	}
	if e, ok := op["error"].(string); ok {
		return nil, errors.New(e)
	}
	return op, nil
}

func (r *modbusReplay) Lies(_ context.Context, addr int) (int, error) {
	op, err := r.next("read", map[string]float64{"addr": float64(addr)})
	if err != nil {
		return 0, err
	}
	return int(num(op["value"])), nil
}

func (r *modbusReplay) Schreibe(_ context.Context, addr, value int) error {
	_, err := r.next("write", map[string]float64{"addr": float64(addr), "value": float64(value)})
	return err
}

func TestVektorenModbus(t *testing.T) {
	loc := berlin(t)
	for _, c := range list(get(m(vectorFile(t, "steuerplan-modbus-vectors.json")), "kette")) {
		o := m(c)
		catalog := catalogFor(t, str(o["catalog"]))
		sel := m(o["sel"])
		var z PlanZustand
		for i, tk := range list(o["ticks"]) {
			to := m(tk)
			what := str(o["name"]) + "/" + str(o["catalog"]) + " Takt " + itoa(i+1)
			now := at(loc, to["now"])
			spt := m(to["setpoint"])
			out, nz := Planen(PlanEingabe{Setpoint: spt, Selection: sel, Catalog: catalog, Now: now}, z)
			z = nz
			var control any
			if out.Control != nil {
				control = out.Control
			}
			same(t, what+": control", nil, control, to["control"])
			var caps any
			if out.NativeCapabilities != nil {
				caps = out.NativeCapabilities
			}
			same(t, what+": nativeCapabilities", nil, caps, to["native_capabilities"])
			same(t, what+": nativeRefusal", nil, out.NativeRefusal, to["native_refusal"])
			ctx := m(to["ctx"])
			same(t, what+": was_controlling", nil, z.WasControlling, ctx["was_controlling"])
			same(t, what+": native_written", nil, z.NativeWritten != "", ctx["native_written"])
			ops := list(to["ops"])
			rep := &modbusReplay{t: t, what: what, ops: ops}
			var payload Obj
			if out.Control != nil && out.Control.Adapter == CommModbus {
				payload = AusfuehrenModbus(context.Background(), AusfuehrEingabe{Control: out.Control, Setpoint: spt,
					NativeCapabilities: out.NativeCapabilities, Now: now}, func(context.Context) (ModbusSpur, error) {
					if _, err := rep.next("connect", map[string]float64{}); err != nil {
						return nil, err
					}
					return rep, nil
				})
			}
			if rep.i != len(ops) {
				t.Errorf("%s: Go fuehrte %d von %d Operationen aus", what, rep.i, len(ops))
			}
			var gp, gs any
			if payload != nil {
				gp, gs = payload, Form(payload, isoMillis(now))
			}
			exakt(t, what+": Rueckmeldung", gp, to["payload"])
			exakt(t, what+": vp-control-readback", gs, to["shaped"])
		}
	}
}
