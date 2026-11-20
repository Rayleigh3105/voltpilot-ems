package steuerplan

import (
	"context"
	"math"
	"time"
)

// The generic SunSpec / Modbus write path (Steuern in Go, Teil 3): the
// compact register block of the SunSpec simulator profile (family `sunspec`,
// communication modbus_tcp; edge/sim/sunspec-sim.js) - setpoint 40, enable
// 41, PV limit 42, the native window limits 43/44. The Go twin of
// sunspecControl, the modbus branch of controlRelease, the flow's
// nativePlanGeneric / nativeCapabilitiesGeneric and the executor
// "SunSpec/Modbus schreiben + zuruecklesen" (controlExecFunc).

const (
	sunspecRegSetpoint  = 40
	sunspecRegEnable    = 41
	sunspecRegPvLimit   = 42
	sunspecRegChargeLim = 43
	sunspecRegDischLim  = 44
	sunspecNoLimit      = 0xffff

	// CommModbus is the generic Modbus TCP transport.
	CommModbus = "modbus_tcp"
)

// SimulatorNativeCapabilities certify a piece of SOFTWARE (the simulator's
// compact block), never a device - the flow's simulator tab passes them; the
// production catalog never contains them (unplanned-load-native.js).
var SimulatorNativeCapabilities = func() []NativeCapability {
	entry := func(word string) NativeCapability {
		return NativeCapability{SimulatorOnly: true, Brand: "generic_modbus", Model: "sunspec-sim", Firmware: "sim",
			Capability: word, Certified: true, Readback: true, Watchdog: true, WindowLimits: true,
			ChargeBlockWrites:     []AddrValue{{41, 0}, {40, 0}},
			ReadbackChecks:        []AddrExpect{{41, 0}, {40, 0}},
			ReleaseWrites:         []AddrValue{{41, 1}},
			ReleaseReadbackChecks: []AddrExpect{{41, 1}},
			WatchdogSpec:          &struct{ TimeoutS int }{0},
			BenchRecord:           "software-only: edge-app/nodered/native-selfregulation.e2e.test.js"}
	}
	return []NativeCapability{entry("native_charge_block_discharge_auto"), entry("native_surplus_charge"), entry("native_self_consumption")}
}()

func s16raw(kw float64) int { return int(toInt32(round(kw*100)) & 0xffff) }

func sunspecConn(conn Obj, ip string) (Obj, float64) {
	port := portOr(conn, "port", 502)
	return Obj{"ip": ip, "port": port, "unit_id": portOr(conn, "unit_id", 1)}, port
}

// sunspecControl is the certified simulator profile's setpoint plan.
func sunspecControl(conn Obj, ip, family string, certified, controlEnabled, calibration bool, kw float64, pvLimitKw *float64) Plan {
	c, port := sunspecConn(conn, ip)
	batt := kw
	if isTrue(get(conn, "invert_control_sign")) {
		batt = -kw
	}
	battRaw := s16raw(batt)
	pvRaw := sunspecNoLimit
	var pvKw any
	if pvLimitKw != nil {
		pvRaw = u16(math.Max(0, round(*pvLimitKw*100)))
		pvKw = *pvLimitKw
	}
	planned := []WriteOp{
		{Role: "battery_power", FC: 6, Addr: sunspecRegSetpoint, Value: battRaw, Encode: map[string]any{"kind": "kw_x100_s16", "scale": 100.0, "kw": batt}},
		{Role: "control_enable", FC: 6, Addr: sunspecRegEnable, Value: 1, Encode: map[string]any{"kind": "flag"}},
		{Role: "pv_limit", FC: 6, Addr: sunspecRegPvLimit, Value: pvRaw, Encode: map[string]any{"kind": "pv_limit_x100_u16", "scale": 100.0, "sentinel": float64(sunspecNoLimit), "kw": pvKw}},
	}
	readbacks := []ReadOp{
		readback("battery_power", sunspecRegSetpoint, battRaw, 1),
		readback("control_enable", sunspecRegEnable, 1, 0),
		readback("pv_limit", sunspecRegPvLimit, pvRaw, 1),
	}
	writeAllowed := controlEnabled && (certified || calibration)
	out := Plan{Adapter: CommModbus, Family: family, Profile: family, Target: ip + ":" + jsNumberString(port), Connection: c,
		Certified: certified, ControlEnabled: controlEnabled, Calibration: ptr(calibration),
		Writes: []WriteOp{}, Readbacks: readbacks, Planned: planned}
	if writeAllowed {
		out.Writes = planned
	} else if certified {
		out.Reason = "Steuerung deaktiviert (Not-Aus)"
	} else {
		out.Reason = "Modell noch nicht freigegeben"
	}
	return out
}

// sunspecRelease hands the simulator profile back to self-consumption.
func sunspecRelease(conn Obj, ip, family string, tier int, certified, controlEnabled, calibration, releaseAllowed bool) Plan {
	c, port := sunspecConn(conn, ip)
	planned := []WriteOp{
		{Role: "control_enable", FC: 6, Addr: sunspecRegEnable, Value: 0, Encode: map[string]any{"kind": "flag"}},
		{Role: "battery_power", FC: 6, Addr: sunspecRegSetpoint, Value: 0, Encode: map[string]any{"kind": "kw_x100_s16", "scale": 100.0, "kw": 0.0}},
		{Role: "pv_limit", FC: 6, Addr: sunspecRegPvLimit, Value: sunspecNoLimit, Encode: map[string]any{"kind": "pv_limit_x100_u16", "scale": 100.0, "sentinel": float64(sunspecNoLimit), "kw": nil}},
	}
	rbs := []ReadOp{readback("control_enable", sunspecRegEnable, 0, 0), readback("battery_power", sunspecRegSetpoint, 0, 1),
		readback("pv_limit", sunspecRegPvLimit, sunspecNoLimit, 1)}
	out := Plan{Adapter: CommModbus, Family: family, Tier: ptr(tier), Certified: certified, ControlEnabled: controlEnabled,
		Calibration: ptr(calibration), Mode: "release", Profile: family, Target: ip + ":" + jsNumberString(port), Connection: c,
		Writes: []WriteOp{}, Readbacks: []ReadOp{}, Planned: planned}
	if releaseAllowed {
		out.Writes, out.Readbacks = planned, rbs
	} else {
		out.Reason = "Modell noch nicht freigegeben"
	}
	return out
}

var nativeGenericPlanned = []WriteOp{
	{Role: "control_enable", FC: 6, Addr: sunspecRegEnable, Value: 0, Encode: map[string]any{"kind": "flag", "native": true}},
	{Role: "battery_power", FC: 6, Addr: sunspecRegSetpoint, Value: 0, Encode: map[string]any{"kind": "kw_x100_s16", "scale": 100.0, "kw": 0.0}},
}

var nativeGenericProofs = []ReadOp{readback("control_enable", sunspecRegEnable, 0, 0), readback("battery_power", sunspecRegSetpoint, 0, 1)}

func nativeWindowOpsGeneric(mode, intent string, minKw, maxKw any) ([]WriteOp, []ReadOp) {
	raw := func(kw float64) int { return int(math.Min(0xfffe, math.Max(0, round(kw*100)))) }
	ch, dis := sunspecNoLimit, sunspecNoLimit
	if mode == "native_window" && isFiniteNum(minKw) && isFiniteNum(maxKw) {
		ch, dis = raw(math.Max(num(maxKw), 0)), raw(math.Max(-num(minKw), 0))
		if intent == "cover_load" {
			ch = 0
		}
		if intent == "surplus_charge" {
			dis = 0
		}
	}
	op := func(role string, addr, v int) WriteOp {
		var kw any
		if v != sunspecNoLimit {
			kw = float64(v) / 100
		}
		return WriteOp{Role: role, FC: 6, Addr: addr, Value: v, Encode: map[string]any{"kind": "native_limit_x100_u16", "scale": 100.0, "sentinel": float64(sunspecNoLimit), "kw": kw}}
	}
	return []WriteOp{op("native_charge_limit", sunspecRegChargeLim, ch), op("native_discharge_limit", sunspecRegDischLim, dis)},
		[]ReadOp{readback("native_charge_limit", sunspecRegChargeLim, ch, 0), readback("native_discharge_limit", sunspecRegDischLim, dis, 0)}
}

func genericKey(sel, conn Obj) NativeKey {
	fw := get(conn, "firmware")
	if !truthy(fw) {
		fw = get(sel, "firmware")
	}
	return NativeKey{Brand: str(get(sel, "brand")), Model: str(get(sel, "model")), Firmware: str(fw)}
}

// NativePlanGeneric is the flow's nativePlanGeneric (nil = not modbus_tcp).
func NativePlanGeneric(sel, sp Obj, catalog []NativeCapability, ohneFlotte bool) *Plan {
	if sel == nil || get(sel, "communication") != CommModbus {
		return nil
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return nil
	}
	c, port := sunspecConn(conn, ip)
	family := trimmed(get(sel, "family"))
	certified := (family == "sunspec" && !ohneFlotte) || isTrue(get(sp, "device_certified"))
	controlEnabled := isTrue(get(sp, "control_enabled"))
	mode := "native"
	if get(sp, "battery_mode") == "native_window" {
		mode = "native_window"
	}
	intent := "cover_load"
	if mode == "native_window" {
		intent = jsString(get(sp, "battery_native_intent"))
	}
	planned := execCopy(nativeGenericPlanned)
	var pvKw any
	pvRaw := sunspecNoLimit
	if v := get(sp, "pv_limit_kw"); isFiniteNum(v) && num(v) >= 0 {
		pvKw = num(v)
		pvRaw = u16(math.Max(0, round(num(v)*100)))
	}
	pvOp := WriteOp{Role: "pv_limit", FC: 6, Addr: sunspecRegPvLimit, Value: pvRaw,
		Encode: map[string]any{"kind": "pv_limit_x100_u16", "scale": 100.0, "sentinel": float64(sunspecNoLimit), "kw": pvKw}}
	proofs := copyReads(nativeGenericProofs)
	winW, winR := nativeWindowOpsGeneric(mode, intent, get(sp, "battery_window_min_kw"), get(sp, "battery_window_max_kw"))
	out := &Plan{Adapter: CommModbus, Family: family, Profile: family, Mode: "native", Supported: ptr(true),
		Certified: certified, ControlEnabled: controlEnabled, Target: ip + ":" + jsNumberString(port), Connection: c,
		Writes: []WriteOp{}, Readbacks: []ReadOp{}, Observations: []ReadOp{}, Planned: planned, PlannedReadbacks: proofs,
		ProofKind: "register", NativeIntent: ptr(intent)}
	switch {
	case !isTrue(get(sp, "grid_charge_allowed")):
		out.Reason = "EEG-Anlage: dieser Wechselrichter kann nicht belegen, dass er nicht aus dem Netz laedt"
		return out
	case !controlEnabled && certified:
		out.Reason = "Steuerung deaktiviert (Not-Aus)"
		return out
	case !controlEnabled || !certified:
		out.Reason = "Modell noch nicht freigegeben"
		return out
	}
	word := CapabilityForIntent(intent)
	if word == "" {
		out.Reason = "Unbekannte Absicht für die Wechselrichter-Automatik"
		return out
	}
	wc := nativeWindowCheckInline(mode, intent, get(sp, "battery_window_min_kw"), get(sp, "battery_window_max_kw"), sel,
		get(sp, "battery_window_natural_min_kw"), get(sp, "battery_window_natural_max_kw"))
	if wc.refusal != "" {
		out.Reason = wc.refusal
		return out
	}
	entry := ExactCapability(genericKey(sel, conn), catalog, word)
	if entry == nil {
		out.Reason = "Wechselrichter-Automatik fuer dieses Modell noch nicht am Pruefstand freigegeben"
		return out
	}
	if !CertificateMatchesPlan(entry, planned, proofs) {
		out.Reason = "Pruefstand-Freigabe und Schreibplan stimmen nicht ueberein - Freigabe erneuern"
		return out
	}
	if wc.narrower && !entry.WindowLimits {
		out.Reason = "Das Fenster ist enger als der Eigenmodus des Wechselrichters - für Grenzen im Eigenmodus gibt es keine Freigabe"
		return out
	}
	out.Writes = append(append(winW, execCopy(planned)...), pvOp)
	out.Readbacks = append(append(winR, copyReads(proofs)...), readback("pv_limit", sunspecRegPvLimit, pvRaw, 1))
	out.Certificate = certificateObj(entry)
	return out
}

// NativeCapabilitiesGeneric is the flow's nativeCapabilitiesGeneric.
func NativeCapabilitiesGeneric(sel, sp Obj, catalog []NativeCapability, ohneFlotte bool) *NativeLevers {
	if sel == nil || get(sel, "communication") != CommModbus {
		return nil
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return nil
	}
	family := trimmed(get(sel, "family"))
	certified := (family == "sunspec" && !ohneFlotte) || isTrue(get(sp, "device_certified"))
	if !certified || !isTrue(get(sp, "grid_charge_allowed")) {
		return &NativeLevers{Intents: []string{}}
	}
	return nativeLeversFor(genericKey(sel, conn), catalog, func(string, *NativeCapability) ([]WriteOp, []ReadOp, bool) {
		return nativeGenericPlanned, nativeGenericProofs, true
	})
}

// ModbusSpur is one open Modbus TCP session to the unit of the plan; errors
// carry the codec's sentence (they end the tick).
type ModbusSpur interface {
	Lies(ctx context.Context, addr int) (int, error)
	Schreibe(ctx context.Context, addr, value int) error
}

// AusfuehrenModbus is the generic executor: every write (FC6), then every
// register read back; a failure anywhere ends the tick without a payload.
func AusfuehrenModbus(ctx context.Context, in AusfuehrEingabe, verbinde func(context.Context) (ModbusSpur, error)) Obj {
	ctrl := in.Control
	if ctrl == nil || ctrl.Adapter != CommModbus || len(ctrl.Readbacks) == 0 {
		return nil
	}
	spur, err := verbinde(ctx)
	if err != nil {
		return nil
	}
	for _, w := range ctrl.Writes {
		if err := spur.Schreibe(ctx, w.Addr, w.Value); err != nil {
			return nil
		}
	}
	registers := []any{}
	for _, rb := range ctrl.Readbacks {
		v, err := spur.Lies(ctx, rb.Addr)
		if err != nil {
			return nil
		}
		actual := v & 0xffff
		expect := 0
		if rb.Expect != nil {
			expect = *rb.Expect
		}
		d := actual - expect&0xffff
		if d < 0 {
			d = -d
		}
		e := Obj{"role": rb.Role, "fc": 3.0, "addr": float64(rb.Addr), "commanded_raw": float64(expect & 0xffff),
			"actual_raw": float64(actual), "match": float64(d) <= tolOf(&rb)}
		switch rb.Role {
		case "battery_power":
			e["commanded_kw"] = float64(s16(expect)) / 100
			e["actual_kw"] = float64(s16(actual)) / 100
		case "pv_limit":
			e["commanded_kw"], e["actual_kw"] = nil, nil
			if expect&0xffff != 0xffff {
				e["commanded_kw"] = float64(expect) / 100
			}
			if actual != 0xffff {
				e["actual_kw"] = float64(actual) / 100
			}
		}
		registers = append(registers, e)
	}
	sp := in.Setpoint
	mode := "normal"
	if ctrl.Mode == "release" || ctrl.Mode == "native" {
		mode = ctrl.Mode
	}
	p := Obj{"ts": isoMillis(in.Now), "family": ctrl.Family, "source": sourceOf(sp), "control_enabled": ctrl.ControlEnabled,
		"certified": ctrl.Certified, "mode": mode, "registers": registers}
	if v := get(sp, "slot_start"); !isUndef(v) {
		p["slot_start"] = v
	}
	if mode == "native" && ctrl.GridChargeProof != nil {
		g := ctrl.GridChargeProof
		if v, err := spur.Lies(ctx, g.Addr); err == nil {
			p["native"] = Obj{"grid_charge_blocked": float64(RegDistanceAbs(v&0xffff, *g.Expect&0xffff)) <= tolOf(g)}
		}
	}
	if mode == "native" && ctrl.NativeIntent != nil && *ctrl.NativeIntent != "" {
		n := Obj{}
		if old := obj(p["native"]); old != nil {
			for k, v := range old {
				n[k] = v
			}
		}
		n["intent"] = *ctrl.NativeIntent
		p["native"] = n
	}
	if c := in.NativeCapabilities; c != nil {
		p["native_capabilities"] = Obj{"intents": stringsAny(c.Intents), "window": c.Window, "persistent": c.Persistent}
	}
	return p
}

var _ = time.Second
