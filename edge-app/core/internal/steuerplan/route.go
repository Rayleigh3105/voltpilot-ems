package steuerplan

import "math"

// RouteOpts are controlRoute's opts: the captured pre-control snapshot
// (addr -> raw), the model nameplate, the probed capability and the sticky
// path decision as the flow context holds them.
type RouteOpts struct {
	Snapshot   Obj
	RatedKw    any
	Deye       Obj
	DeyeSticky Obj
	// OhneFlotte drops the fleet-wide family certification (the simulator
	// profile `sunspec`): Layer 1's Edge Light release closes it like a
	// device grant.
	OhneFlotte bool
}

// idleNotPorted is the honest answer for a transport Edge Light does not
// steer yet (Fronius and generic SunSpec follow in their own stages; KOSTAL,
// Huawei and KACO are locked on the Docker box too).
const idleNotPorted = "Edge Light steuert diese Anbindung noch nicht"

func idlePlan(reason string) Plan {
	return Plan{Adapter: "idle", Writes: []WriteOp{}, Readbacks: []ReadOp{}, Reason: reason}
}

// selConn is `selection.connection || {}` and the trimmed ip.
func selConn(sel Obj) (Obj, string) {
	conn := obj(get(sel, "connection"))
	if conn == nil {
		conn = Obj{}
	}
	return conn, trimmed(get(conn, "ip"))
}

// connObj is the plan's connection block; an absent serial stays absent.
func connObj(ip string, port float64, conn Obj, slave float64, remoteMode string) Obj {
	c := Obj{"ip": ip, "port": port, "mb_slave_id": slave, "remote_mode": remoteMode}
	if s := get(conn, "serial"); !isUndef(s) {
		c["serial"] = s
	}
	return c
}

func isUndef(v any) bool { _, ok := v.(undef); return ok }

// ControlRoute maps a selection and a setpoint onto a write plan (Deye only;
// every other transport is honestly idle on Edge Light).
func ControlRoute(sel, sp Obj, opts RouteOpts) Plan {
	if sel == nil {
		return idlePlan("keine Auswahl")
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return idlePlan("keine IP-Adresse")
	}
	if sp == nil || !isFiniteNum(get(sp, "battery_setpoint_kw")) {
		return idlePlan("kein gueltiger Sollwert")
	}
	controlEnabled := isTrue(get(sp, "control_enabled"))
	calibration := isTrue(get(sp, "calibration"))
	family := trimmed(get(sel, "family"))
	certified := (certifiedFamily(family) && !opts.OhneFlotte) || isTrue(get(sp, "device_certified"))
	kw := num(get(sp, "battery_setpoint_kw"))
	var pvLimitKw *float64
	if v := get(sp, "pv_limit_kw"); isFiniteNum(v) && num(v) >= 0 {
		pvLimitKw = ptr(num(v))
	}
	tier := ResolveControlTier(sel)
	if tier == TierTou && get(sel, "communication") == CommSolarman {
		sticky := opts.DeyeSticky
		capEff := DeyeEffectiveCap(opts.Deye, sticky)
		a := deyeArgs{sel: sel, conn: conn, ip: ip, family: family, certified: certified, controlEnabled: controlEnabled,
			calibration: calibration, kw: kw, pvLimitKw: pvLimitKw, sp: sp, opts: opts, cap: capEff, sticky: sticky}
		// The flow's copy (what runs on the box) takes the remote path only for
		// a family with a control map; the module would also for string/micro.
		if _, hasReg := DeyeFamilyControlReg(family); hasReg && !remoteForcedOff(conn) && DeyeControlPath(capEff) == DeyePathRemote {
			return deyeRemoteControl(a)
		}
		return deyeControl(a)
	}
	if tier == TierSunspec && get(sel, "communication") == CommModbus {
		return sunspecControl(conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw)
	}
	if c := get(sel, "communication"); c == CommSolarman || c == CommModbus {
		// A transport of Edge Light under another tier: the original's dispatch.
		if tier == TierVendorEMS {
			return vendorEmsPlan(conn, ip, family, controlEnabled, nil)
		}
		return idlePlan("unbekannte Kommunikationsmethode")
	}
	return idlePlan(idleNotPorted)
}

// vendorEmsPlan is the Tier-2 extension point of the original: a catalogued
// tier-2 selection lands here and never writes (tier = the release's tier).
func vendorEmsPlan(conn Obj, ip, family string, controlEnabled bool, tier *int) Plan {
	port := portOr(conn, "port", 502)
	p := Plan{Adapter: "vendor_ems", Family: family, Tier: tier, Target: ip + ":" + jsNumberString(port),
		Connection: Obj{"ip": ip, "port": port}, ControlEnabled: controlEnabled,
		Writes: []WriteOp{}, Readbacks: []ReadOp{}, Planned: []WriteOp{},
		Reason: "Tier-2 Wechselrichtersteuerung (externes EMS) noch nicht implementiert"}
	if tier != nil {
		p.Mode = "release"
	}
	return p
}

// certifiedFamily is the FLEET-WIDE certification allowlist: only the
// simulator profile, never a Deye family.
func certifiedFamily(family string) bool { return family == "sunspec" }

func remoteForcedOff(conn Obj) bool {
	v := get(conn, "remote_mode")
	return v == "off" || isFalse(v)
}

type deyeArgs struct {
	sel, conn                              Obj
	ip, family                             string
	certified, controlEnabled, calibration bool
	kw                                     float64
	pvLimitKw                              *float64
	sp                                     Obj
	opts                                   RouteOpts
	cap, sticky                            Obj
}

func ratedOf(v any) float64 {
	if n := num(v); n > 0 {
		return n
	}
	return 0
}

// deyeRemoteControl is the Tier-2 REMOTE-MODE plan: failsafe first, enable
// last; RAM registers re-asserted every tick.
func deyeRemoteControl(a deyeArgs) Plan {
	port := portOr(a.conn, "port", 8899)
	slave := portOr(a.conn, "mb_slave_id", 1)
	writeFc := ResolveDeyeWriteFc(a.conn)
	battKw := a.kw
	if isTrue(get(a.conn, "invert_control_sign")) {
		battKw = -a.kw
	}
	ratedKw := ratedOf(a.opts.RatedKw)
	watchdogS := ResolveDeyeRemoteWatchdog(a.conn)
	writeAllowed := a.controlEnabled && (a.certified || a.calibration)

	layout := any(DeyeRemoteLayoutPR978)
	if a.cap != nil && truthy(get(a.cap, "layout")) {
		layout = get(a.cap, "layout")
	}
	out := Plan{
		Adapter: "solarman_v5", Family: a.family, ControlPath: DeyePathRemote,
		Target:     a.ip + ":" + jsNumberString(port),
		Connection: connObj(a.ip, port, a.conn, slave, "auto"),
		Certified:  a.certified, ControlEnabled: a.controlEnabled, Calibration: ptr(a.calibration),
		Remote: Obj{"layout": layout, "watchdog_s": float64(watchdogS), "rated_kw": ratedKw,
			"status_addr": float64(DeyeRegRemoteStatus)},
		PvLimitSupported: ptr(false),
		PvLimitKw:        a.pvLimitKw,
		CapabilityProbe:  DeyeCapabilityProbeSpec(a.family),
	}
	if !(ratedKw > 0) {
		out.Writes, out.Readbacks, out.Planned = []WriteOp{}, []ReadOp{}, []WriteOp{}
		out.Blocked = true
		out.Reason = "Fernsteuerung: Nennleistung des Modells unbekannt - bitte das genaue " +
			"Wechselrichter-Modell auswählen (der Sollwert ist 0,1 % der Nennleistung)."
		return out
	}
	sp := DeyeRemoteSetpointUnits(battKw, ratedKw)
	strategyPref := resolveDeyeRemoteStrategy(a.conn)
	charging := battKw > 0
	var socMin, socMax *float64
	if v := get(a.sp, "soc_min_pct"); isFiniteNum(v) {
		socMin = ptr(clampPct(num(v)))
	}
	if v := get(a.sp, "soc_max_pct"); isFiniteNum(v) {
		socMax = ptr(clampPct(num(v)))
	}
	beltValue := socMin
	if charging {
		beltValue = socMax
	}
	var belt *float64
	if strategyPref == deyeStrategyPowerSoc && beltValue != nil {
		belt = beltValue
	}
	strategy := deyeStrategyPower
	if belt != nil {
		strategy = deyeStrategyPowerSoc
	}
	ram := func(w WriteOp) WriteOp { w.Always, w.BenchPending = true, true; return w }
	ramCfg := func(w WriteOp) WriteOp { w.ReassertS, w.BenchPending = deyeRemoteCfgReassertS, true; return w }
	observations := []ReadOp{{Role: "remote_status", FC: 3, Addr: DeyeRegRemoteStatus}}

	if gt := parseGridTest(get(a.sp, "grid_test")); gt != nil {
		gSide := deyeGridTestSide[gt.side]
		gBattery := gSide == deyePowerControlBatterySide
		var gSp SetpointUnits
		gRole, gKind, gEnum := "ac_power", "ac_power_permille", "ac_side"
		switch {
		case gBattery:
			gSp = DeyeRemoteSetpointUnits(gt.targetKw, ratedKw)
			gRole, gKind, gEnum = "battery_power", "remote_power_permille", "battery_side"
		case gSide == deyePowerControlGridSide:
			gSp = DeyeGridSetpointUnits(gt.targetKw, ratedKw)
			gRole, gKind, gEnum = "grid_power", "grid_power_permille", "grid_side"
		default:
			gSp = DeyeGridSetpointUnits(gt.targetKw, ratedKw)
		}
		var gp []WriteOp
		gp = append(gp, ram(WriteOp{Role: "remote_watchdog", FC: writeFc, Addr: DeyeRegWatchdog, Value: watchdogS & 0xffff,
			Encode: map[string]any{"kind": "remote_watchdog_s", "seconds": float64(watchdogS)}}))
		if gt.neutralize {
			gp = append(gp, ram(WriteOp{Role: "grid_neutral", FC: writeFc, Addr: DeyeRegConstantPower, Value: 0,
				Encode: map[string]any{"kind": "remote_neutral"}}))
		}
		gp = append(gp, ram(WriteOp{Role: "power_control_mode", FC: writeFc, Addr: DeyeRegPowerControlMode, Value: gSide,
			Encode: map[string]any{"kind": "remote_power_control_mode", "enum": gEnum}}))
		if gt.pvCapPermille != nil {
			gp = append(gp, ramCfg(WriteOp{Role: "pv_max_permille", FC: writeFc, Addr: DeyeRegPvMaxPower, Value: *gt.pvCapPermille & 0xffff,
				Encode: map[string]any{"kind": "pv_max_permille", "rated_kw": ratedKw, "permille": float64(*gt.pvCapPermille)}}))
		}
		gp = append(gp, ram(WriteOp{Role: gRole, FC: writeFc, Addr: DeyeRegConstantPower, Value: gSp.Raw,
			Encode: map[string]any{"kind": gKind, "rated_kw": ratedKw, "kw": gt.targetKw,
				"units": float64(gSp.Units), "limit": float64(deyeRemoteSetpointLimit), "clamped": gSp.Clamped}}))
		gp = append(gp, ram(WriteOp{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOn,
			Encode: map[string]any{"kind": "remote_mode", "enum": "on"}}))
		var gRb []ReadOp
		for _, w := range gp {
			if w.Role == "grid_neutral" {
				continue
			}
			tol := 0.0
			if w.Role == gRole {
				tol = 1
			}
			rb := readback(w.Role, w.Addr, w.Value&0xffff, tol)
			if w.Role == gRole {
				rb.Decode = map[string]any{"kind": gKind, "rated_kw": ratedKw}
			}
			gRb = append(gRb, rb)
		}
		out.Writes, out.Readbacks = []WriteOp{}, []ReadOp{}
		if writeAllowed {
			out.Writes, out.Readbacks = execCopy(gp), gRb
		}
		out.Planned = gp
		out.Observations = observations
		out.SetpointUnits, out.SetpointClamped = ptr(gSp.Units), ptr(gSp.Clamped)
		var pvCap any
		if gt.pvCapPermille != nil {
			pvCap = float64(*gt.pvCapPermille)
		}
		out.GridTest = Obj{"step": gt.step, "side": gt.side, "target_kw": gt.targetKw,
			"neutralize": gt.neutralize, "pv_cap_permille": pvCap}
		switch {
		case !writeAllowed && a.certified:
			out.Reason = "Steuerung deaktiviert (Not-Aus)"
		case !writeAllowed:
			out.Reason = "Netz-Sollwert-Test: Steuerung für dieses Modell noch nicht freigegeben"
		default:
			out.Reason = "Netz-Sollwert-Test (" + gt.step + ", " + gt.side + ")"
		}
		return out
	}

	gridTargetNote := ""
	if target := parseGridTarget(a.sp); target != nil {
		var capLayout any
		if a.cap != nil {
			capLayout = get(a.cap, "layout")
		}
		if GridTargetReleaseFor(a.sel, capLayout) != nil {
			planned, rbs, units, clamped := deyeGridTargetPlan(target, writeFc, watchdogS, ratedKw)
			allowed := a.controlEnabled && a.certified
			out.Writes, out.Readbacks = []WriteOp{}, []ReadOp{}
			if allowed {
				out.Writes, out.Readbacks = execCopy(planned), rbs
			}
			out.Planned = planned
			out.Observations = observations
			out.SetpointUnits, out.SetpointClamped = ptr(units), ptr(clamped)
			out.GridTarget = Obj{"target_kw": target.targetKw, "neutralize": target.neutralize,
				"pv_cap_permille": float64(GridTargetPvMaxPermille)}
			switch {
			case allowed:
				out.Reason = "Netzseitiger Drossel-Slot: der Wechselrichter regelt den Netzanschluss selbst"
			case a.certified:
				out.Reason = "Steuerung deaktiviert (Not-Aus)"
			default:
				out.Reason = "Netzseitige Regelung: Steuerung für dieses Modell noch nicht freigegeben"
			}
			return out
		}
		gridTargetNote = "Netzseitige Regelung für dieses Wechselrichter-Modell nicht freigegeben - " +
			"es bleibt beim batterieseitigen Sollwert"
	}

	strategyEnum := "power"
	if strategy == deyeStrategyPowerSoc {
		strategyEnum = "power_soc"
	}
	planned := []WriteOp{
		ram(WriteOp{Role: "remote_watchdog", FC: writeFc, Addr: DeyeRegWatchdog, Value: watchdogS & 0xffff,
			Encode: map[string]any{"kind": "remote_watchdog_s", "seconds": float64(watchdogS)}}),
		ramCfg(WriteOp{Role: "power_control_mode", FC: writeFc, Addr: DeyeRegPowerControlMode, Value: deyePowerControlBatterySide,
			Encode: map[string]any{"kind": "remote_power_control_mode", "enum": "battery_side"}}),
		ramCfg(WriteOp{Role: "battery_strategy", FC: writeFc, Addr: DeyeRegBatteryStrategy, Value: strategy,
			Encode: map[string]any{"kind": "remote_battery_strategy", "enum": strategyEnum}}),
	}
	if belt != nil {
		dir := "discharge_floor"
		if charging {
			dir = "charge_ceiling"
		}
		planned = append(planned, ramCfg(WriteOp{Role: "battery_soc_belt", FC: writeFc, Addr: DeyeRegConstantSoc, Value: int(*belt),
			Encode: map[string]any{"kind": "pct", "direction": dir}}))
	}
	planned = append(planned,
		ram(WriteOp{Role: "battery_power", FC: writeFc, Addr: DeyeRegConstantPower, Value: sp.Raw,
			Encode: map[string]any{"kind": "remote_power_permille", "rated_kw": ratedKw, "kw": battKw,
				"units": float64(sp.Units), "limit": float64(deyeRemoteSetpointLimit), "clamped": sp.Clamped}}),
		ram(WriteOp{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOn,
			Encode: map[string]any{"kind": "remote_mode", "enum": "on"}}),
	)
	readbacks := make([]ReadOp, len(planned))
	for i, w := range planned {
		tol := 0.0
		if w.Role == "battery_power" {
			tol = 1
		}
		readbacks[i] = readback(w.Role, w.Addr, w.Value&0xffff, tol)
		if w.Role == "battery_power" {
			readbacks[i].Decode = map[string]any{"kind": "remote_power_permille", "rated_kw": ratedKw}
		}
	}
	out.Writes, out.Readbacks = []WriteOp{}, []ReadOp{}
	if writeAllowed {
		out.Writes, out.Readbacks = execCopy(planned), readbacks
	}
	out.Planned = planned
	out.Observations = observations
	out.SetpointUnits, out.SetpointClamped = ptr(sp.Units), ptr(sp.Clamped)
	if a.pvLimitKw != nil {
		out.PvLimitNote = "Fernsteuerung: PV-Begrenzung wird auf diesem Pfad nicht geschrieben " +
			"(sie wäre eine Installateur-Einstellung im EEPROM)."
	}
	out.GridTargetNote = gridTargetNote
	switch {
	case !writeAllowed && a.certified:
		out.Reason = "Steuerung deaktiviert (Not-Aus)"
	case !writeAllowed:
		out.Reason = "Fernsteuerung erkannt, Steuerung für dieses Modell noch nicht freigegeben"
	case out.PvLimitNote != "":
		out.Reason = out.PvLimitNote
	}
	return out
}

// deyePowerLimitReg is the string/micro active-power limit (deye-decode.js
// POWER_LIMIT_REG).
const deyePowerLimitReg = 0x0028

// deyeControl is the Time-of-Use translation of the battery setpoint (report
// §8): EEPROM levers first, Program 1, activation strictly LAST; refused
// outright with an unknown HV/LV scale.
func deyeControl(a deyeArgs) Plan {
	port := portOr(a.conn, "port", 8899)
	slave := portOr(a.conn, "mb_slave_id", 1)
	invert := isTrue(get(a.conn, "invert_control_sign"))
	socMin := 5.0
	if v := get(a.sp, "soc_min_pct"); isFiniteNum(v) {
		socMin = num(v)
	}
	powerScale, scaleConfirmed, scaleSource := resolveDeyePowerScale(a.conn, a.cap)
	writeFc := ResolveDeyeWriteFc(a.conn)
	snapshot := a.opts.Snapshot
	reg, hasReg := DeyeFamilyControlReg(a.family)
	remoteModeCfg := "auto"
	if remoteForcedOff(a.conn) {
		remoteModeCfg = "off"
	}
	writeAllowed := a.controlEnabled && (a.certified || a.calibration)
	rbTol := func(role string) float64 {
		if role == "battery_power" || role == "pv_limit" || role == "max_sell_power" {
			return 1
		}
		return 0
	}
	finalize := func(planned []WriteOp, extra func(*Plan)) Plan {
		readbacks := make([]ReadOp, len(planned))
		for i, w := range planned {
			readbacks[i] = readback(w.Role, w.Addr, w.Value&0xffff, rbTol(w.Role))
		}
		exec := execCopy(planned)
		if a.calibration {
			for i := range exec {
				exec[i].DwellS, exec[i].MinChange = 0, 0
			}
		}
		out := Plan{
			Adapter: "solarman_v5", Family: a.family, ControlPath: DeyePathTou,
			Target:     a.ip + ":" + jsNumberString(port),
			Connection: connObj(a.ip, port, a.conn, slave, remoteModeCfg),
			Certified:  a.certified, ControlEnabled: a.controlEnabled, Calibration: ptr(a.calibration),
			Writes: []WriteOp{}, Readbacks: []ReadOp{},
			Planned:         planned,
			CapabilityProbe: DeyeCapabilityProbeSpec(a.family),
		}
		if writeAllowed {
			out.Writes, out.Readbacks = exec, readbacks
		}
		if extra != nil {
			extra(&out)
		}
		if !writeAllowed && out.Reason == "" {
			out.Reason = "Steuerung für dieses Modell noch nicht freigegeben"
			if a.certified {
				out.Reason = "Steuerung deaktiviert (Not-Aus)"
			}
		}
		return out
	}

	if !hasReg {
		ratedKw := ratedOf(a.opts.RatedKw)
		planned := []WriteOp{}
		if a.pvLimitKw != nil && ratedKw > 0 {
			planned = append(planned, WriteOp{Role: "pv_limit", FC: writeFc, Addr: deyePowerLimitReg,
				Value:  int(clampPct(float64(*a.pvLimitKw/ratedKw) * 100)),
				Encode: map[string]any{"kind": "active_power_pct", "rated_kw": ratedKw, "kw": *a.pvLimitKw},
				DwellS: 900, MinChange: 1, BenchPending: true})
		}
		return finalize(planned, nil)
	}

	if writeAllowed && !a.calibration && remoteModeCfg != "off" {
		grantRemote := get(a.sp, "device_certified_path") == DeyePathRemote
		everRemote := grantRemote || (a.sticky != nil && isTrue(get(a.sticky, "everRemote")))
		definitiveTou := a.cap != nil && !isFalse(get(a.cap, "definitive")) && DeyeControlPath(a.cap) == DeyePathTou
		if everRemote {
			return finalize([]WriteOp{}, func(p *Plan) {
				p.Blocked, p.PathHold = true, "remote_proven"
				p.Reason = "Fernsteuerung (Remote Mode) ist für dieses Gerät nachgewiesen, wird aber gerade " +
					"nicht bestätigt. Die Zeitfenster-Steuerung (EEPROM) wird nicht automatisch aktiviert - " +
					"die Fähigkeitsprüfung läuft weiter und die Fernsteuerung wird wieder aufgenommen, " +
					"sobald sie antwortet. (Zeitfenster erzwingen: remote_mode auf \"off\" setzen oder neu kalibrieren.)"
			})
		}
		if !definitiveTou {
			return finalize([]WriteOp{}, func(p *Plan) {
				p.Blocked, p.PathHold = true, "unconfirmed"
				p.Reason = "Steuerpfad noch unbestätigt: die Fähigkeitsprüfung (Fernsteuerung vs. Zeitfenster) " +
					"hat noch keine eindeutige Antwort vom Wechselrichter. Es wird nichts geschrieben, " +
					"bis der Pfad feststeht."
			})
		}
	}

	if !scaleConfirmed {
		return finalize([]WriteOp{}, func(p *Plan) {
			p.PowerScaleConfirmed = ptr(false)
			p.PowerScaleSource = scaleSource
			p.PowerScaleSuppressed = true
			p.Blocked = true
			p.Reason = "Leistungsskalierung unbestätigt (HV/LV): Der Schreibplan wird zurückgehalten, " +
				"damit ein HV-Wechselrichter nicht 10-fach überschrieben wird. Bitte die " +
				"Leistungsskalierung am Wechselrichter setzen (HV = 10, LV = 1) oder das Gerät " +
				"erreichbar machen, damit sie automatisch erkannt wird."
		})
	}

	slot := DeyeControlSlot
	battKw := a.kw
	if invert {
		battKw = -a.kw
	}
	charging := battKw > 0
	discharging := battKw < 0
	watts := math.Abs(battKw) * 1000
	powerReg := u16(math.Max(0, round(watts/float64(powerScale))))
	targetSoc := 100.0
	if !charging {
		targetSoc = clampPct(socMin)
	}
	chargeEnum := deyeProgChargeDisabled
	if isTrue(get(a.sp, "grid_charge_allowed")) && charging {
		chargeEnum = deyeProgChargeGrid
	}
	maxSellScale := powerScale
	if reg.MaxSellPower == reg.ExportLimit {
		maxSellScale = reg.ExportLimitScale
	}
	cfg := func(w WriteOp) WriteOp { w.DwellS, w.BenchPending = 900, true; return w }
	planned := []WriteOp{}
	pattern, patternEnum := deyeEnergyPatternLoadFirst, "load_first"
	if charging {
		pattern, patternEnum = deyeEnergyPatternBatteryFirst, "battery_first"
	}
	planned = append(planned, cfg(WriteOp{Role: "energy_pattern", FC: writeFc, Addr: reg.EnergyPattern, Value: pattern,
		Encode: map[string]any{"kind": "energy_pattern", "enum": patternEnum}}))
	planned = append(planned, cfg(WriteOp{Role: "work_mode", FC: writeFc, Addr: reg.WorkMode, Value: deyeWorkModeExportFirst,
		Encode: map[string]any{"kind": "work_mode", "enum": "export_first"}}))
	if discharging {
		planned = append(planned, cfg(WriteOp{Role: "solar_sell", FC: writeFc, Addr: reg.SolarSell, Value: deyeSolarSellOn,
			Encode: map[string]any{"kind": "flag", "enum": "solar_sell_on"}}))
	}
	planned = append(planned, cfg(WriteOp{Role: "program_time", FC: writeFc, Addr: reg.ProgTimeBase + slot, Value: deyeProgramTimeBaseHHMM,
		Encode: map[string]any{"kind": "program_time_hhmm", "hhmm": float64(deyeProgramTimeBaseHHMM)}}))
	planned = append(planned, cfg(WriteOp{Role: "grid_charge_enable", FC: writeFc, Addr: reg.ProgChargeBase + slot, Value: chargeEnum,
		Encode: map[string]any{"kind": "charge_enum", "eeg_gated": true, "disabled": float64(deyeProgChargeDisabled), "grid": float64(deyeProgChargeGrid)}}))
	dir := "discharge"
	if charging {
		dir = "charge"
	}
	planned = append(planned, WriteOp{Role: "battery_target_soc", FC: writeFc, Addr: reg.ProgSocBase + slot, Value: int(targetSoc),
		Encode: map[string]any{"kind": "pct", "direction": dir}, DwellS: 900, MinChange: 1, BenchPending: true})
	if discharging {
		planned = append(planned, WriteOp{Role: "max_sell_power", FC: writeFc, Addr: reg.MaxSellPower,
			Value:  u16(math.Max(0, round(watts/float64(maxSellScale)))),
			Encode: map[string]any{"kind": "watt_scaled_u16", "scale": float64(maxSellScale), "kw": battKw, "lever": "force_discharge"},
			DwellS: 900, MinChange: 50, BenchPending: true})
	} else if v, ok := snapshotValue(snapshot, reg.MaxSellPower); ok {
		planned = append(planned, WriteOp{Role: "max_sell_power", FC: writeFc, Addr: reg.MaxSellPower, Value: v,
			Encode: map[string]any{"kind": "restore", "from": "snapshot"}, DwellS: 900, MinChange: 0, BenchPending: true})
	}
	planned = append(planned, WriteOp{Role: "battery_power", FC: writeFc, Addr: reg.ProgPowerBase + slot, Value: powerReg,
		Encode: map[string]any{"kind": "watt_scaled_u16", "scale": float64(powerScale), "kw": battKw}, DwellS: 900, MinChange: 50, BenchPending: true})
	if a.pvLimitKw != nil {
		capRaw := u16(round(math.Max(0, *a.pvLimitKw*1000) / float64(reg.ExportLimitScale)))
		clash := -1
		for i := range planned {
			if planned[i].Addr == reg.ExportLimit {
				clash = i
				break
			}
		}
		if clash >= 0 {
			c := &planned[clash]
			c.Value = u16(math.Min(float64(c.Value&0xffff), float64(capRaw)))
			c.Encode = cloneMap(c.Encode)
			c.Encode["feed_in_cap_kw"] = *a.pvLimitKw
		} else {
			planned = append(planned, WriteOp{Role: "pv_limit", FC: writeFc, Addr: reg.ExportLimit, Value: capRaw,
				Encode: map[string]any{"kind": "feed_in_cap_w", "scale": float64(reg.ExportLimitScale), "kw": *a.pvLimitKw},
				DwellS: 900, MinChange: 1, BenchPending: true})
		}
	}
	planned = append(planned, cfg(WriteOp{Role: "tou_enable", FC: writeFc, Addr: reg.TouEnable, Value: deyeTouEnabledAllWeek,
		Encode: map[string]any{"kind": "tou_mask", "all_week": true}}))
	return finalize(planned, func(p *Plan) {
		p.PowerScaleConfirmed = ptr(scaleConfirmed)
		p.SnapshotPlan = &SnapshotPlan{Registers: DeyeSnapshotSpec(reg, slot), ProgramTimes: DeyeProgramTimeAddrs(reg)}
	})
}

// ReleaseOpts are controlRelease's opts.
type ReleaseOpts struct {
	OhneFlotte      bool
	Calibration     bool
	ControlEnabled  bool
	DeviceCertified bool
	Snapshot        Obj
	Deye            Obj
	DeyeSticky      Obj
}

// ControlRelease is the controller-owned failsafe plan that hands control
// BACK (stale core, kill-off after we held control, crash recovery). Deye
// only; other transports are honestly idle on Edge Light.
func ControlRelease(sel Obj, o ReleaseOpts) Plan {
	idle := func(reason string) Plan {
		return Plan{Adapter: "idle", Tier: ptr(TierReadOnly), ControlEnabled: o.ControlEnabled, Mode: "release",
			Writes: []WriteOp{}, Readbacks: []ReadOp{}, Planned: []WriteOp{}, Reason: reason}
	}
	if sel == nil {
		return idle("keine Auswahl")
	}
	conn, ip := selConn(sel)
	if ip == "" {
		return idle("keine IP-Adresse")
	}
	family := trimmed(get(sel, "family"))
	certified := (certifiedFamily(family) && !o.OhneFlotte) || o.DeviceCertified
	releaseAllowed := certified || o.Calibration
	tier := ResolveControlTier(sel)
	if tier == TierSunspec && get(sel, "communication") == CommModbus {
		return sunspecRelease(conn, ip, family, tier, certified, o.ControlEnabled, o.Calibration, releaseAllowed)
	}
	if tier != TierTou || get(sel, "communication") != CommSolarman {
		if c := get(sel, "communication"); c == CommSolarman || c == CommModbus {
			if tier == TierVendorEMS {
				return vendorEmsPlan(conn, ip, family, o.ControlEnabled, ptr(tier))
			}
			return idle("unbekannte Kommunikationsmethode")
		}
		p := idle(idleNotPorted)
		p.Tier = ptr(tier)
		return p
	}
	port := portOr(conn, "port", 8899)
	slave := portOr(conn, "mb_slave_id", 1)
	writeFc := ResolveDeyeWriteFc(conn)
	reg, hasReg := DeyeFamilyControlReg(family)
	remoteCap := DeyeEffectiveCap(o.Deye, o.DeyeSticky)
	remoteOff := remoteForcedOff(conn)
	reason := ""
	if !releaseAllowed {
		reason = "Steuerung für dieses Modell noch nicht freigegeben"
	}
	base := Plan{
		Adapter: "solarman_v5", Family: family, Tier: ptr(tier), Certified: certified, ControlEnabled: o.ControlEnabled,
		Calibration: ptr(o.Calibration), Mode: "release",
		Target:          ip + ":" + jsNumberString(port),
		CapabilityProbe: DeyeCapabilityProbeSpec(family),
		Reason:          reason,
	}
	restoreDwell := 900
	if o.Calibration {
		restoreDwell = 0
	}
	finish := func(planned []WriteOp, path, remoteMode string) Plan {
		rbs := make([]ReadOp, len(planned))
		for i, w := range planned {
			rbs[i] = readback(w.Role, w.Addr, w.Value&0xffff, 0)
		}
		p := base
		p.ControlPath = path
		p.Connection = connObj(ip, port, conn, slave, remoteMode)
		p.Planned = planned
		p.Writes, p.Readbacks = []WriteOp{}, []ReadOp{}
		if releaseAllowed {
			p.Writes, p.Readbacks = planned, rbs
		}
		return p
	}
	if !remoteOff && hasReg && DeyeControlPath(remoteCap) == DeyePathRemote {
		planned := []WriteOp{{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOff,
			Encode: map[string]any{"kind": "remote_mode", "enum": "off", "release": true},
			Always: true, BenchPending: true}}
		if o.Snapshot != nil {
			for _, s := range DeyeSnapshotSpec(reg, DeyeControlSlot) {
				v, ok := snapshotValue(o.Snapshot, s.Addr)
				if !ok {
					continue
				}
				planned = append(planned, WriteOp{Role: s.Role, FC: writeFc, Addr: s.Addr, Value: v,
					Encode: map[string]any{"kind": "restore", "from": "snapshot"},
					DwellS: restoreDwell, Always: true, BenchPending: true})
			}
		}
		return finish(planned, DeyePathRemote, "auto")
	}
	planned := []WriteOp{}
	if hasReg && o.Snapshot != nil {
		for _, s := range DeyeSnapshotSpec(reg, DeyeControlSlot) {
			v, ok := snapshotValue(o.Snapshot, s.Addr)
			if !ok {
				continue
			}
			planned = append(planned, WriteOp{Role: s.Role, FC: writeFc, Addr: s.Addr, Value: v,
				Encode: map[string]any{"kind": "restore", "from": "snapshot"},
				DwellS: restoreDwell, BenchPending: true})
		}
	}
	if hasReg && len(planned) == 0 {
		planned = []WriteOp{{Role: "tou_enable", FC: writeFc, Addr: reg.TouEnable, Value: 0,
			Encode: map[string]any{"kind": "tou_mask", "all_week": false, "release": true},
			DwellS: restoreDwell, BenchPending: true}}
	}
	remoteMode := "auto"
	if remoteOff {
		remoteMode = "off"
	}
	return finish(planned, DeyePathTou, remoteMode)
}

// Absturz is the crash recovery of the flow ("Absturz-Wiederherstellung"):
// a durable snapshot at start means control was held and never handed back,
// so the installer's captured registers are restored - a calibration-flagged
// release, executable even for an uncertified family. nil = nothing to do.
func Absturz(snap Obj) (*Plan, string) {
	if snap == nil {
		return nil, ""
	}
	regs := obj(get(snap, "regs"))
	if regs == nil {
		if _, isArr := get(snap, "regs").([]any); !isArr {
			return nil, ""
		}
		regs = Obj{}
	}
	conn := obj(get(snap, "connection"))
	if conn == nil {
		conn = Obj{}
	}
	sel := Obj{"schema_version": "1.0", "brand": "deye", "family": jsv(get(snap, "family")),
		"communication": CommSolarman, "control_tier": 3.0, "connection": conn}
	rel := ControlRelease(sel, ReleaseOpts{Calibration: true, Snapshot: regs})
	if len(rel.Writes) == 0 {
		return nil, ""
	}
	return &rel, "Deye-Steuerung Absturz-Wiederherstellung: Snapshot gefunden (" + itoa(len(rel.Writes)) +
		" Register) - setze die Vor-Steuerungs-Werte des Installateurs zurueck."
}
