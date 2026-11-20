package steuerplan

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// steuerplan-vectors.gen.js writes them from the modules and the real plan
// node of flows.json; steuerplan-vectors.test.js keeps them current.
func vectorFile(t *testing.T, name string) any {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", name))
	if err != nil {
		t.Fatalf("Vektoren nicht lesbar: %v", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("Vektoren unlesbar: %v", err)
	}
	return special(v)
}

// special decodes the {"$num": "NaN"} markers of the generator.
func special(v any) any {
	switch x := v.(type) {
	case map[string]any:
		if s, ok := x["$num"].(string); ok && len(x) == 1 {
			switch s {
			case "NaN":
				return math.NaN()
			case "Infinity":
				return math.Inf(1)
			case "-Infinity":
				return math.Inf(-1)
			}
		}
		for k, e := range x {
			x[k] = special(e)
		}
	case []any:
		for i, e := range x {
			x[i] = special(e)
		}
	}
	return v
}

// norm is the comparison form: JSON round trip, null and [] equal to absent
// (the executor reads every such field with `|| []`).
func norm(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return strip(out)
}

func strip(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if e == nil {
				delete(x, k)
				continue
			}
			if a, ok := e.([]any); ok && len(a) == 0 {
				delete(x, k)
				continue
			}
			x[k] = strip(e)
		}
	case []any:
		for i, e := range x {
			x[i] = strip(e)
		}
	}
	return v
}

func same(t *testing.T, what string, input any, got, want any) {
	t.Helper()
	g, w := norm(map[string]any{"v": got}), norm(map[string]any{"v": want})
	if !reflect.DeepEqual(g, w) {
		gj, _ := json.Marshal(g)
		wj, _ := json.Marshal(w)
		ij, _ := json.Marshal(input)
		t.Errorf("%s\n  Eingabe: %s\n  Go: %s\n  JS: %s", what, ij, gj, wj)
	}
}

func m(v any) Obj      { return obj(v) }
func list(v any) []any { a, _ := v.([]any); return a }

func berlin(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func at(loc *time.Location, ms any) time.Time { return time.UnixMilli(int64(num(ms))).In(loc) }

func modul(t *testing.T) Obj { return m(vectorFile(t, "steuerplan-vectors.json")) }

func TestVektorenRueckmeldung(t *testing.T) {
	cases := list(get(modul(t), "rueckmeldung"))
	if len(cases) == 0 {
		t.Fatal("keine Faelle")
	}
	for _, c := range cases {
		var es []RueckEintrag
		for _, e := range list(get(m(c), "entries")) {
			o := m(e)
			var actual *int
			if a := get(o, "actual"); !isUndef(a) && a != nil {
				actual = ptr(u16(num(a)))
			}
			es = append(es, RueckEintrag{Role: str(get(o, "role")), Expect: u16(num(get(o, "expect"))), Actual: actual,
				Tolerance: num(get(o, "tolerance")), Rule: str(get(o, "rule")), Error: str(get(o, "error"))})
		}
		same(t, "verifyCycle", c, VerifyCycle(es), get(m(c), "out"))
	}
}

func TestVektorenBudget(t *testing.T) {
	loc := berlin(t)
	b := m(get(modul(t), "budget"))
	for _, c := range list(get(b, "today")) {
		o := m(c)
		same(t, "touBudgetToday", c, TouBudgetToday(jsv(get(o, "record")), at(loc, get(o, "now"))), get(o, "out"))
	}
	for _, c := range list(get(b, "limits")) {
		o := m(c)
		same(t, "touBudgetLimit", c, TouBudgetLimit(get(o, "stated")), get(o, "out"))
	}
	for _, c := range list(get(b, "ops")) {
		o := m(c)
		bo := m(get(o, "budget"))
		bud := TouBudget{Day: str(get(bo, "day")), Changes: int(num(get(bo, "changes"))), Held: isTrue(get(bo, "held"))}
		limit := int(num(get(o, "limit")))
		same(t, "touBudgetAdmits", c, TouBudgetAdmits(bud, limit), get(o, "admits"))
		same(t, "touBudgetCounted", c, TouBudgetCounted(bud), get(o, "counted"))
		same(t, "touBudgetHeld", c, TouBudgetHeld(bud), get(o, "held"))
		same(t, "touBudgetReason", c, TouBudgetReason(bud, limit), get(o, "reason"))
		same(t, "touBudgetReport", c, bud.Report(limit), get(o, "report"))
	}
}

func probeOf(o Obj) DeyeProbe {
	p := DeyeProbe{Error: str(get(o, "error"))}
	if !truthy(get(o, "error")) {
		p.Error = ""
	}
	if d := get(o, "deviceType"); !isUndef(d) {
		v := int(num(d))
		if d == nil {
			v = 0
		}
		p.DeviceType = &v
	}
	if b := list(get(o, "remoteBlock")); b != nil {
		p.RemoteBlock = make([]int, len(b))
		for i, x := range b {
			p.RemoteBlock[i] = int(num(x))
		}
	}
	if d, ok := get(o, "definitive").(bool); ok {
		p.Definitive = &d
	}
	return p
}

func TestVektorenFaehigkeit(t *testing.T) {
	for _, c := range list(get(modul(t), "faehigkeit")) {
		o := m(c)
		same(t, "classifyDeyeCapability", c, ClassifyDeyeCapability(probeOf(m(get(o, "probe")))), get(o, "out"))
	}
}

func TestVektorenEntscheid(t *testing.T) {
	e := m(get(modul(t), "entscheid"))
	for _, c := range list(get(e, "update")) {
		o := m(c)
		same(t, "deyeUpdateSticky", c, DeyeUpdateSticky(m(get(o, "prev")), m(get(o, "verdict")), num(get(o, "now"))), get(o, "out"))
	}
	for _, c := range list(get(e, "effective")) {
		o := m(c)
		same(t, "deyeEffectiveCap", c, DeyeEffectiveCap(m(get(o, "cap")), m(get(o, "sticky"))), get(o, "out"))
	}
	for _, c := range list(get(e, "seed")) {
		o := m(c)
		same(t, "deyeSeedStickyFromGrant", c, DeyeSeedStickyFromGrant(m(get(o, "setpoint")), num(get(o, "now"))), get(o, "out"))
	}
}

func TestVektorenEinzeln(t *testing.T) {
	e := m(get(modul(t), "einzeln"))
	for _, c := range list(get(e, "probeErrors")) {
		o := m(c)
		same(t, "deyeProbeErrorDefinitive", c, DeyeProbeErrorDefinitive(str(get(o, "message"))), get(o, "out"))
	}
	for _, c := range list(get(e, "watchdog")) {
		o := m(c)
		conn := Obj{}
		if v := get(o, "value"); !isUndef(v) {
			conn["remote_watchdog_s"] = v
		}
		same(t, "resolveDeyeRemoteWatchdog", c, ResolveDeyeRemoteWatchdog(conn), get(o, "out"))
	}
	for _, c := range list(get(e, "units")) {
		o := m(c)
		u := DeyeRemoteSetpointUnits(num(get(o, "kw")), num(get(o, "rated")))
		same(t, "deyeRemoteSetpointUnits", c, Obj{"units": float64(u.Units), "raw": float64(u.Raw), "clamped": u.Clamped, "ok": u.OK}, get(o, "remote"))
	}
	for _, c := range list(get(e, "displaced")) {
		o := m(c)
		same(t, "deyeProgram1Displaced", c, DeyeProgram1Displaced(list(get(o, "times")), num(get(o, "now_min"))), get(o, "out"))
	}
	for _, c := range list(get(e, "active")) {
		o := m(c)
		var times []float64
		for _, x := range list(get(o, "times")) {
			times = append(times, regVal(x))
		}
		same(t, "deyeActiveProgram", c, DeyeActiveProgram(times, regVal(get(o, "now_min"))), get(o, "out"))
	}
	for _, c := range list(get(e, "tier")) {
		o := m(c)
		same(t, "resolveControlTier", c, ResolveControlTier(m(get(o, "selection"))), get(o, "out"))
	}
	for _, c := range list(get(e, "writeFc")) {
		o := m(c)
		conn := Obj{}
		if v := get(o, "value"); !isUndef(v) {
			conn["control_write_fc"] = v
		}
		same(t, "resolveDeyeWriteFc", c, ResolveDeyeWriteFc(conn), get(o, "out"))
	}
}

func TestVektorenRueckgabe(t *testing.T) {
	cases := list(get(modul(t), "rueckgabe"))
	for _, c := range cases {
		o := m(c)
		op := m(get(o, "opts"))
		ro := ReleaseOpts{Calibration: isTrue(get(op, "calibration")), ControlEnabled: isTrue(get(op, "controlEnabled")),
			DeviceCertified: isTrue(get(op, "deviceCertified")), Snapshot: m(get(op, "snapshot")),
			Deye: m(get(op, "deye")), DeyeSticky: m(get(op, "deyeSticky"))}
		same(t, "controlRelease", c, ControlRelease(m(get(o, "selection")), ro), get(o, "out"))
	}
}

func TestVektorenVorbedingung(t *testing.T) {
	reg := deyeControlReg["hybrid_3p"]
	for _, c := range list(get(modul(t), "vorbedingung")) {
		o := m(c)
		intent := str(get(o, "intent"))
		cfg := m(get(o, "cfg"))
		floor := get(o, "floor_pct")
		solar := isTrue(get(o, "solar_only"))
		same(t, "deyeOwnConfigPrecondition", c, deyeOwnConfigPrecondition(intent, cfg, floor, solar, &reg), str(get(o, "own_config")))
		same(t, "deyeGridZeroPrecondition", c, deyeGridZeroPrecondition(cfg, floor, solar), str(get(o, "grid_zero")))
	}
}

func TestVektorenAbsturz(t *testing.T) {
	for _, c := range list(get(modul(t), "absturz")) {
		o := m(c)
		plan, warn := Absturz(m(get(o, "snapshot")))
		var got any
		if plan != nil {
			got = plan
		}
		same(t, "Absturz-Wiederherstellung", c, got, get(o, "control"))
		var warns []string
		if warn != "" {
			warns = []string{warn}
		}
		same(t, "Absturz-Warnung", c, warns, get(o, "warns"))
	}
}

// catalogFor builds the generator's named native catalogs.
func catalogFor(t *testing.T, name string) []NativeCapability {
	t.Helper()
	rel := func(c, i string) NativeCapability {
		e, ok := ReleaseDeyeChargeSide(c, i, "Vektor-Nachweis")
		if !ok {
			t.Fatalf("Freigabe %s/%s", c, i)
		}
		return e
	}
	prod := CertifiedNativeCapabilities
	switch name {
	case "produktion":
		return prod
	case "ladeseite_netz":
		return append(append([]NativeCapability{}, prod...), rel("grid_zero", "self_consumption"), rel("grid_zero", "surplus_charge"))
	case "ladeseite_eigen":
		return append(append([]NativeCapability{}, prod...), rel("own_config", "self_consumption"), rel("own_config", "surplus_charge"))
	case "ladeseite_beide":
		return append(append([]NativeCapability{}, prod...), rel("own_config", "self_consumption"), rel("grid_zero", "self_consumption"))
	case "leer":
		return nil
	case "simulator":
		return SimulatorNativeCapabilities
	}
	t.Fatalf("unbekannter Katalog %q", name)
	return nil
}

func TestVektorenPlanKnoten(t *testing.T) {
	loc := berlin(t)
	for _, file := range []string{"steuerplan-knoten-vectors.json", "steuerplan-automatik-vectors.json"} {
		cases := list(get(m(vectorFile(t, file)), "plan"))
		if len(cases) == 0 {
			t.Fatalf("%s: keine Faelle", file)
		}
		planFaelle(t, loc, cases)
	}
}

func planFaelle(t *testing.T, loc *time.Location, cases []any) {
	t.Helper()
	for _, c := range cases {
		o := m(c)
		catalog := catalogFor(t, str(get(o, "catalog")))
		flow := clone(get(o, "flow")).(map[string]any)
		store := func(name string) Obj {
			s := obj(flow[name])
			if s == nil {
				s = Obj{}
				flow[name] = s
			}
			return s
		}
		var z PlanZustand
		for i, st := range list(get(o, "steps")) {
			so := m(st)
			if d := m(get(so, "flow_delta")); d != nil {
				for s, kv := range d {
					for k, v := range m(kv) {
						store(s)[k] = clone(v)
					}
				}
			}
			mem, file := store("memory"), store("file")
			sel := m(mem["inverter_config"])
			in := PlanEingabe{Setpoint: m(get(so, "setpoint")), Selection: sel, Snapshot: m(file["deye_ctrl_snapshot"]),
				Catalog: catalog, Now: at(loc, get(so, "now"))}
			if ziel := Ziel(sel); ziel != "" {
				in.Cap = m(mem["deye_cap:"+ziel])
				in.Sticky = m(file["deye_path:"+ziel])
				in.NativeCfg = m(mem["deye_native_cfg:"+ziel])
			}
			in.TouBudget = func(ip string, port float64) any { return file["deye_tou_budget:"+ip+":"+jsNumberString(port)] }
			out, next := Planen(in, z)
			z = next
			label := str(get(o, "name")) + " Takt " + itoa(i+1)
			var control any
			if out.Control != nil {
				control = out.Control
			}
			same(t, label+": control", st, control, get(so, "control"))
			var caps any
			if out.NativeCapabilities != nil {
				caps = out.NativeCapabilities
			}
			same(t, label+": nativeCapabilities", st, caps, get(so, "native_capabilities"))
			same(t, label+": nativeRefusal", st, out.NativeRefusal, get(so, "native_refusal"))
			var warns []string
			if out.Warn != "" {
				warns = []string{out.Warn}
			}
			same(t, label+": warns", st, warns, get(so, "warns"))
			ctx := m(get(so, "ctx"))
			same(t, label+": was_controlling", st, z.WasControlling, get(ctx, "was_controlling"))
			same(t, label+": native_written", st, z.NativeWritten != "", get(ctx, "native_written"))
			same(t, label+": native_refusal (Kontext)", st, z.NativeRefusal, get(ctx, "native_refusal"))
		}
	}
}
