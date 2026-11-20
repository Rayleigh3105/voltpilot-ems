package steuerplan

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// exakt compares without the null/[]/absent equivalence of the plan
// comparison: what the core receives must match field for field.
func exakt(t *testing.T, what string, got, want any) {
	t.Helper()
	g, w := roundTrip(got), roundTrip(want)
	if !reflect.DeepEqual(g, w) {
		gj, _ := json.Marshal(g)
		wj, _ := json.Marshal(w)
		t.Errorf("%s\n  Go: %s\n  JS: %s", what, gj, wj)
	}
}

func roundTrip(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// replaySpur plays the recorded operations of one tick: every call must be
// the next recorded op, and gets the answer the flow's executor got.
type replaySpur struct {
	t    *testing.T
	what string
	ops  []any
	i    int
}

var errTot = errors.New("Socket beendet")

func (s *replaySpur) next(kind string, want map[string]float64) (Obj, error) {
	s.t.Helper()
	if s.i >= len(s.ops) {
		s.t.Errorf("%s: Go fuehrt Operation %d (%s %v) aus, JS nicht mehr", s.what, s.i+1, kind, want)
		return nil, errTot
	}
	op := m(s.ops[s.i])
	s.i++
	if get(op, "op") != kind {
		s.t.Errorf("%s: Operation %d: Go %s %v, JS %v", s.what, s.i, kind, want, op)
		return nil, errTot
	}
	for k, v := range want {
		if num(get(op, k)) != v {
			s.t.Errorf("%s: Operation %d: Go %s %v, JS %v", s.what, s.i, kind, want, op)
			return nil, errTot
		}
	}
	if isTrue(get(op, "fatal")) {
		return nil, errTot
	}
	if e := get(op, "error"); isStr(e) {
		return nil, &Protokollfehler{Msg: e.(string)}
	}
	return op, nil
}

func (s *replaySpur) Lies(_ context.Context, addr, count int) ([]int, error) {
	op, err := s.next("read", map[string]float64{"addr": float64(addr), "count": float64(count)})
	if err != nil {
		return nil, err
	}
	var regs []int
	for _, x := range list(get(op, "regs")) {
		regs = append(regs, int(num(x)))
	}
	return regs, nil
}

func (s *replaySpur) Schreibe(_ context.Context, fc, addr, value int) error {
	_, err := s.next("write", map[string]float64{"fc": float64(fc), "addr": float64(addr), "value": float64(value)})
	return err
}

func ablageAus(flow Obj) (*Ablage, Obj) {
	a := NeueAblage()
	mem, file := m(get(flow, "memory")), m(get(flow, "file"))
	for k, v := range mem {
		switch {
		case strings.HasPrefix(k, "deye_cap:"):
			a.Faehigkeit[strings.TrimPrefix(k, "deye_cap:")] = clone(v).(map[string]any)
		case strings.HasPrefix(k, "deye_native_cfg:"):
			a.Geraetekonfig[strings.TrimPrefix(k, "deye_native_cfg:")] = clone(v).(map[string]any)
		}
	}
	for k, v := range file {
		switch {
		case k == "deye_ctrl_snapshot":
			a.Snapshot = m(clone(v))
		case strings.HasPrefix(k, "deye_path:"):
			a.Pfad[strings.TrimPrefix(k, "deye_path:")] = m(clone(v))
		case strings.HasPrefix(k, "deye_tou_budget:"):
			a.Budget[strings.TrimPrefix(k, "deye_tou_budget:")] = clone(v)
		}
	}
	return a, m(get(mem, "inverter_config"))
}

func ablageBild(a *Ablage) Obj {
	mem, file := Obj{}, Obj{}
	for k, v := range a.Faehigkeit {
		mem["deye_cap:"+k] = v
	}
	for k, v := range a.Geraetekonfig {
		mem["deye_native_cfg:"+k] = v
	}
	if a.Snapshot != nil {
		file["deye_ctrl_snapshot"] = a.Snapshot
	}
	for k, v := range a.Pfad {
		file["deye_path:"+k] = v
	}
	for k, v := range a.Budget {
		file["deye_tou_budget:"+k] = v
	}
	last := Obj{}
	for k, v := range a.Letzte {
		last[k] = v
	}
	return Obj{"memory": mem, "file": file, "sv5_ctrl_last": last}
}

func TestVektorenKette(t *testing.T) {
	loc := berlin(t)
	cases := list(get(m(vectorFile(t, "steuerplan-kette-vectors.json")), "kette"))
	if len(cases) == 0 {
		t.Fatal("keine Faelle")
	}
	for _, c := range cases {
		o := m(c)
		catalog := catalogFor(t, str(get(o, "catalog")))
		a, sel := ablageAus(m(get(o, "flow")))
		for i, tk := range list(get(o, "ticks")) {
			to := m(tk)
			what := str(get(o, "name")) + " Takt " + itoa(i+1)
			now := at(loc, get(to, "now"))
			var in *AusfuehrEingabe
			if isTrue(get(to, "recover")) {
				if plan, _ := Absturz(a.Snapshot); plan != nil {
					in = &AusfuehrEingabe{Control: plan, Setpoint: Obj{"source": "crash_recovery"}, Now: now}
				}
			} else {
				spt := m(get(to, "setpoint"))
				pe := PlanEingabe{Setpoint: spt, Selection: sel, Snapshot: a.Snapshot, Catalog: catalog, Now: now}
				if z := Ziel(sel); z != "" {
					pe.Cap, pe.Sticky, pe.NativeCfg = a.Faehigkeit[z], a.Pfad[z], a.Geraetekonfig[z]
				}
				pe.TouBudget = func(ip string, port float64) any { return a.Budget[ip+":"+jsNumberString(port)] }
				out, z := Planen(pe, a.Plan)
				a.Plan = z
				if out.Control != nil {
					in = &AusfuehrEingabe{Control: out.Control, Setpoint: spt, NativeCapabilities: out.NativeCapabilities,
						NativeRefusal: out.NativeRefusal, Now: now}
				}
			}
			ops := list(get(to, "ops"))
			var payload Obj
			if in != nil {
				spur := &replaySpur{t: t, what: what, ops: ops}
				res := Ausfuehren(context.Background(), *in, a, func(context.Context) (Spur, error) {
					if len(ops) > 0 && get(m(ops[0]), "op") == "connect" {
						spur.i = 1
						return nil, errTot
					}
					return spur, nil
				})
				payload = res.Payload
				if spur.i != len(ops) {
					t.Errorf("%s: Go fuehrte %d von %d Operationen aus", what, spur.i, len(ops))
				}
			} else if len(ops) > 0 {
				t.Errorf("%s: Go fuehrt nicht aus, JS schon", what)
			}
			var gotPayload, gotShaped any
			if payload != nil {
				gotPayload = payload
				gotShaped = Form(payload, isoMillis(now))
			}
			exakt(t, what+": Rueckmeldung", gotPayload, get(to, "payload"))
			exakt(t, what+": vp-control-readback", gotShaped, get(to, "shaped"))
			same(t, what+": Ablage", nil, ablageBild(a), get(to, "ablage"))
		}
	}
}

var _ = time.Second
