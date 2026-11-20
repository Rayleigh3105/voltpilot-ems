package steuerplan

// The native self-regulation ("Wechselrichter-Automatik") of the Deye remote
// tier as the control plan node runs it: the Go twin of the flow's
// nativePlanDeye / nativeCapabilitiesDeye / nativeWindowCheckInline
// (edge-app/nodered/build-flows.js nativeDeyeSource, nativeGenericSource).
// The hand-over is 1100 <- 0 (E-down, the pilot's certified entry) or one of
// the two charge-side candidates; the certificate attests the bytes, and the
// device's own configuration is the last gate.

const (
	nativeNoRemote = "Deye ohne Fernsteuer-Firmware: die Zeitfenster-Steuerung bleibt bei der 10-Sekunden-Nachführung"
	nativeNotBench = "Wechselrichter-Automatik für dieses Modell noch nicht am Prüfstand freigegeben"
	// nativeWindowFullToleranceKw is guards/intent.go's WindowPointToleranceKw / 2.
	nativeWindowFullToleranceKw = 0.05
)

// nativeTier is deyeNativeTier: is this selection the Deye remote tier with the
// PR-978 layout? nil = not a Deye transport.
type nativeTier struct {
	ok         bool
	family     string
	reg        DeyeControlReg
	hasReg     bool
	writeFc    int
	candidates map[string]*chargeCandidate
}

// flowEffectiveCap is the plan node's inline twin of deyeEffectiveCap (it
// synthesizes the record without scaleClass and reason - only path and layout
// matter on this side).
func flowEffectiveCap(rawCap, sticky Obj) Obj {
	c := rawCap
	path := stickyPath(sticky)
	if path == "" {
		return c
	}
	if c != nil && !isFalse(get(c, "definitive")) && DeyeControlPath(c) == path {
		return c
	}
	if v := obj(get(sticky, "verdict")); v != nil && DeyeControlPath(v) == path {
		return v
	}
	if path == DeyePathRemote {
		layout := any(DeyeRemoteLayoutPR978)
		if v := obj(get(sticky, "verdict")); v != nil && truthy(get(v, "layout")) {
			layout = get(v, "layout")
		}
		return Obj{"present": true, "supported": true, "path": DeyePathRemote, "layout": layout, "definitive": true, "sticky": true}
	}
	return Obj{"present": false, "supported": false, "path": DeyePathTou, "layout": nil, "definitive": true, "sticky": true}
}

func flowWriteFc(conn Obj) int {
	v := get(conn, "control_write_fc")
	if (isNum(v) && num(v) == 6) || v == "6" {
		return 6
	}
	return 16
}

func deyeNativeTier(sel, rawCap, sticky Obj) *nativeTier {
	if sel == nil || get(sel, "communication") != CommSolarman {
		return nil
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return nil
	}
	family := trimmed(get(sel, "family"))
	reg, hasReg := DeyeFamilyControlReg(family)
	cap := flowEffectiveCap(rawCap, sticky)
	pr978 := cap != nil && get(cap, "layout") == DeyeRemoteLayoutPR978
	ok := !(remoteForcedOff(conn) || !hasReg || DeyeControlPath(cap) != DeyePathRemote || !pr978)
	t := &nativeTier{ok: ok, family: family, reg: reg, hasReg: hasReg, writeFc: flowWriteFc(conn)}
	if ok {
		t.candidates = deyeChargeSideCandidates(reg, t.writeFc, ResolveDeyeRemoteWatchdog(conn))
	}
	return t
}

// deyeCoverLoadPlan is the E-down pilot's bytes (1100 <- 0) and its proof.
func deyeCoverLoadPlan(writeFc int) ([]WriteOp, []ReadOp) {
	return []WriteOp{{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOff,
			Encode: map[string]any{"kind": "remote_mode", "enum": "off", "native": true}, BenchPending: true}},
		[]ReadOp{readback("remote_mode", DeyeRegRemoteMode, deyeRemoteModeOff, 0)}
}

func selKey(sel Obj) NativeKey {
	return NativeKey{Brand: str(get(sel, "brand")), Model: str(get(sel, "model")), Firmware: DeyeRemotePR978Firmware}
}

// NativeCapabilitiesDeye is the native_capabilities report of the Deye remote
// tier (nil = no primitive on this transport).
func NativeCapabilitiesDeye(sel, sp Obj, catalog []NativeCapability, rawCap, sticky Obj) *NativeLevers {
	t := deyeNativeTier(sel, rawCap, sticky)
	if t == nil || !t.ok {
		return nil
	}
	if !(certifiedFamily(t.family) || isTrue(get(sp, "device_certified"))) {
		return &NativeLevers{Intents: []string{}}
	}
	coverP, coverR := deyeCoverLoadPlan(t.writeFc)
	levers := nativeLeversFor(selKey(sel), catalog, func(intent string, entry *NativeCapability) ([]WriteOp, []ReadOp, bool) {
		if intent == "cover_load" {
			return coverP, coverR, true
		}
		if entry == nil || entry.Candidate == "" {
			return nil, nil, false
		}
		c := t.candidates[entry.Candidate]
		if c == nil {
			return nil, nil, false
		}
		return c.planned, c.readbacks, true
	})
	return withGridTargetLever(levers, GridTargetReleaseFor(sel, DeyeRemoteLayoutPR978) != nil)
}

type windowCheck struct {
	refusal  string
	narrower bool
}

// nativeWindowCheckInline: is the window valid, and narrower than the
// intent's natural window (then the lever needs window limits)?
func nativeWindowCheckInline(mode, intent string, minKw, maxKw any, sel Obj, natMin, natMax any) windowCheck {
	if mode != "native_window" {
		return windowCheck{}
	}
	if !isFiniteNum(minKw) || !isFiniteNum(maxKw) || num(minKw) > 0 || num(maxKw) < 0 {
		return windowCheck{refusal: "Das Fenster der Absicht ist ungültig oder erzwingt einen Fluss - es bleibt bei der 10-Sekunden-Nachführung"}
	}
	mn, mx := num(minKw), num(maxKw)
	var rated *float64
	if v := get(sel, "rated_kw"); isFiniteNum(v) && num(v) > 0 {
		rated = ptr(num(v))
	}
	type refT struct{ kw, tol float64 }
	ref := func(v any) *refT {
		if isFiniteNum(v) && num(v) > 0 {
			return &refT{num(v), nativeWindowFullToleranceKw}
		}
		if rated != nil {
			return &refT{*rated, 1e-9}
		}
		return nil
	}
	refCharge := ref(natMax)
	var dis any = undef{}
	if isFiniteNum(natMin) {
		dis = -num(natMin)
	}
	refDischarge := ref(dis)
	reaches := func(kw float64, r *refT) bool { return r != nil && kw >= r.kw-r.tol }
	chargeOpen := intent != "cover_load"
	dischargeOpen := intent != "surplus_charge"
	return windowCheck{narrower: (chargeOpen && !reaches(mx, refCharge)) || (dischargeOpen && !reaches(-mn, refDischarge))}
}

// NativePlanDeye is the plan node's native hand-over plan for a Deye (nil =
// not this transport). cfg is the device's own configuration record the
// executor read (already freshness-checked by the caller).
func NativePlanDeye(sel, sp Obj, catalog []NativeCapability, rawCap, sticky, cfg Obj) *Plan {
	if sel == nil || get(sel, "communication") != CommSolarman {
		return nil
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return nil
	}
	family := trimmed(get(sel, "family"))
	certified := certifiedFamily(family) || isTrue(get(sp, "device_certified"))
	controlEnabled := isTrue(get(sp, "control_enabled"))
	solarOnly := !isTrue(get(sp, "grid_charge_allowed"))
	reg, hasReg := DeyeFamilyControlReg(family)
	cap := flowEffectiveCap(rawCap, sticky)
	pr978 := cap != nil && get(cap, "layout") == DeyeRemoteLayoutPR978
	if remoteForcedOff(conn) || !hasReg || DeyeControlPath(cap) != DeyePathRemote || !pr978 {
		return &Plan{Adapter: "solarman_v5", Family: family, Mode: "native", Supported: ptr(false),
			ControlEnabled: controlEnabled, Writes: []WriteOp{}, Readbacks: []ReadOp{}, Observations: []ReadOp{},
			Planned: []WriteOp{}, PlannedReadbacks: []ReadOp{}, Preconditions: []ReadOp{}, Reason: nativeNoRemote}
	}
	port := portOr(conn, "port", 8899)
	writeFc := flowWriteFc(conn)
	planned, proofs := deyeCoverLoadPlan(writeFc)
	pre := coverLoadPreconditions(reg)
	out := &Plan{Adapter: "solarman_v5", Family: family, Mode: "native", Supported: ptr(true),
		Certified: certified, ControlEnabled: controlEnabled, ControlPath: DeyePathRemote,
		CapabilityProbe: &ProbeSpec{Reads: []ReadOp{
			{Role: "device_type", Addr: 0, Count: 1},
			{Role: "remote_block", Addr: deyeRemoteProbeAddr, Count: deyeRemoteProbeCount}}},
		Target:     ip + ":" + jsNumberString(port),
		Connection: connObj(ip, port, conn, portOr(conn, "mb_slave_id", 1), "auto"),
		Writes:     []WriteOp{}, Readbacks: []ReadOp{},
		Observations: []ReadOp{{Role: "remote_status", FC: 3, Addr: DeyeRegRemoteStatus}},
		Planned:      planned, PlannedReadbacks: proofs, Preconditions: pre,
		GridChargeProof: ptr(readback("grid_charge_enable", reg.ProgChargeBase+DeyeControlSlot, deyeProgChargeDisabled, 0)),
		ProofKind:       "register",
	}
	if !controlEnabled {
		out.Reason = "Modell noch nicht freigegeben"
		if certified {
			out.Reason = "Steuerung deaktiviert (Not-Aus)"
		}
		return out
	}
	if !certified {
		out.Reason = "Modell noch nicht freigegeben"
		return out
	}
	nmode := "native"
	if get(sp, "battery_mode") == "native_window" {
		nmode = "native_window"
	}
	nintent := "cover_load"
	if nmode == "native_window" {
		nintent = jsString(get(sp, "battery_native_intent"))
	}
	out.NativeIntent = ptr(nintent)
	precond := PrecondOpts{OwnConfig: cfg, FloorPct: get(sp, "effective_floor_soc_pct"), SolarOnly: solarOnly}
	if nintent != "cover_load" {
		if CapabilityForIntent(nintent) == "" {
			out.Reason = "Unbekannte Absicht für die Wechselrichter-Automatik"
			return out
		}
		wc := nativeWindowCheckInline(nmode, nintent, get(sp, "battery_window_min_kw"), get(sp, "battery_window_max_kw"), sel,
			get(sp, "battery_window_natural_min_kw"), get(sp, "battery_window_natural_max_kw"))
		if wc.refusal != "" {
			out.Reason = wc.refusal
			return out
		}
		t := deyeNativeTier(sel, rawCap, sticky)
		if t == nil || t.candidates == nil {
			out.Reason = nativeNoRemote
			return out
		}
		key := selKey(sel)
		pilot := parseNativePilot(get(sp, "native_pilot"))
		var names []string
		if pilot != nil {
			names = []string{pilot.candidate}
		} else {
			for _, e := range ExactCapabilities(key, catalog, CapabilityForIntent(nintent)) {
				if e.Candidate != "" {
					names = append(names, e.Candidate)
				}
			}
		}
		if cpre := deyeChargeSidePreconditions(t.candidates, names); len(cpre) > 0 {
			out.Preconditions = cpre
		}
		out.Planned, out.PlannedReadbacks = []WriteOp{}, []ReadOp{}
		if pilot != nil {
			out.Pilot = Obj{"candidate": pilot.candidate, "intent": pilot.intent, "run": pilot.run}
		}
		pick := selectDeyeChargeSide(catalog, key, nintent, t.candidates, wc.narrower, pilot, precond)
		if pick.refusal != "" {
			out.Reason = pick.refusal
			return out
		}
		out.Candidate = pick.name
		out.Heartbeat = ptr(pick.cand.heartbeat)
		out.CurtailsOwnPv = ptr(pick.cand.curtailsOwnPv)
		out.Planned, out.PlannedReadbacks = pick.cand.planned, pick.cand.readbacks
		out.Writes = execCopy(pick.cand.planned)
		out.Readbacks = copyReads(pick.cand.readbacks)
		if pick.entry != nil {
			out.Certificate = certificateObj(pick.entry)
		}
		return out
	}
	entry := ExactCapability(selKey(sel), catalog, CapabilityForIntent("cover_load"))
	if entry == nil {
		out.Reason = nativeNotBench
		return out
	}
	if !CertificateMatchesPlan(entry, planned, proofs) {
		out.Reason = "Prüfstand-Freigabe und Schreibplan stimmen nicht überein - Freigabe erneuern"
		return out
	}
	if r := deyeCoverLoadPrecondition(cfg, get(sp, "effective_floor_soc_pct"), solarOnly, &reg); r != "" {
		out.Reason = r
		return out
	}
	out.Writes = execCopy(planned)
	out.Readbacks = copyReads(proofs)
	out.Certificate = certificateObj(entry)
	return out
}

// jsString is String(v || ”) for the intent word.
func jsString(v any) string {
	if !truthy(v) {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return "true"
	case float64:
		return jsNumberString(x)
	case int:
		return itoa(x)
	}
	return "[object Object]"
}
