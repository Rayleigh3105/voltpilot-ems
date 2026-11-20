package steuerplan

import (
	"encoding/json"
	"time"
)

// The control plan node ("Steuerung / Schreibplan", the flow's
// controlPlanFunc): one tick per setpoint. It builds the module's plan, owns
// the controller-side failsafe (a kill-off or a silent core after we held
// control hands control BACK), runs the native hand-over write-once, and
// holds the ToU day budget.

// SetpointStaleAfter: a setpoint older than this means the core went silent
// (plan.StaleAfter).
const SetpointStaleAfter = 20 * time.Minute

// nativeCfgFreshFor: a device configuration the executor has not refreshed
// recently belongs to a past episode.
const nativeCfgFreshFor = 300000 // ms

// SetpointStale is the flow's setpointStale: a missing or unparseable ts is
// NOT stale.
func SetpointStale(ts any, now time.Time) bool {
	s, ok := ts.(string)
	if !ok || s == "" {
		return false
	}
	t, ok := parseJSDate(s)
	if !ok {
		return false
	}
	return now.UnixMilli()-t > SetpointStaleAfter.Milliseconds()
}

// parseJSDate is Date.parse for the ISO timestamps the core writes.
func parseJSDate(s string) (int64, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04:05Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// Ziel is the logger endpoint "ip:port" the per-device records are keyed on
// (the plan node's dTarget), "" for a selection that is not a Deye logger.
func Ziel(sel Obj) string {
	if sel == nil || get(sel, "communication") != CommSolarman {
		return ""
	}
	conn := obj(get(sel, "connection"))
	if conn == nil || !isStr(get(conn, "ip")) {
		return ""
	}
	return trimmed(get(conn, "ip")) + ":" + jsNumberString(portOr(conn, "port", 8899))
}

// PlanEingabe is everything one tick reads: the setpoint and the flow
// context's records as the executor left them.
type PlanEingabe struct {
	Setpoint  Obj // msg.setpoint
	Selection Obj // inverter_config
	Snapshot  Obj // deye_ctrl_snapshot (durable)
	Cap       Obj // deye_cap:<ziel> (volatile)
	Sticky    Obj // deye_path:<ziel> (durable)
	NativeCfg Obj // deye_native_cfg:<ziel> (volatile)
	// TouBudget is deye_tou_budget:<ip>:<port> (durable), read only when the
	// plan is a ToU plan.
	TouBudget func(ip string, port float64) any
	Catalog   []NativeCapability
	Now       time.Time
	// Gesperrt: the Edge Light release is closed for this device - the plan
	// comes out as for a device without any grant (no device grant, no
	// calibration bypass, no fleet-wide family certification).
	Gesperrt bool
}

// PlanZustand is the node context that outlives a tick.
type PlanZustand struct {
	WasControlling bool
	// NativeWritten is the signature of the native plan written once.
	NativeWritten string
	// NativeRefusal is the cause last said in the log.
	NativeRefusal string
}

// PlanAusgabe is one tick's answer. Control nil = the node returns nothing.
type PlanAusgabe struct {
	Control            *Plan
	NativeCapabilities *NativeLevers
	// NativeRefusal rides beside the plan to the executor ("" = none).
	NativeRefusal string
	// Warn is the one log line of a NEW refusal cause ("" = none).
	Warn string
}

// Planen runs one tick of the plan node and returns the next node context.
func Planen(in PlanEingabe, z PlanZustand) (PlanAusgabe, PlanZustand) {
	var out PlanAusgabe
	sp := in.Setpoint
	if sp == nil {
		return out, z
	}
	if in.Gesperrt {
		g := make(Obj, len(sp))
		for k, v := range sp {
			g[k] = v
		}
		g["device_certified"], g["calibration"] = false, false
		sp = g
	}
	sel := in.Selection
	var snapRegs Obj
	if in.Snapshot != nil {
		snapRegs = obj(get(in.Snapshot, "regs"))
	}
	nowMs := float64(in.Now.UnixMilli())
	var cap, sticky, nativeCfg Obj
	if Ziel(sel) != "" {
		cap, sticky = in.Cap, in.Sticky
		if c := in.NativeCfg; c != nil && isFiniteNum(get(c, "at")) && nowMs-num(get(c, "at")) <= nativeCfgFreshFor {
			nativeCfg = c
		}
		if sticky == nil {
			sticky = DeyeSeedStickyFromGrant(sp, nowMs)
		}
	}
	var rated any = undef{}
	if v := get(sel, "rated_kw"); isFiniteNum(v) && num(v) > 0 {
		rated = num(v)
	}
	plan := ControlRoute(sel, sp, RouteOpts{Snapshot: snapRegs, RatedKw: rated, Deye: cap, DeyeSticky: sticky, OhneFlotte: in.Gesperrt})
	if plan.Adapter == "idle" {
		return out, z
	}
	hadWrites := len(plan.Writes) > 0
	failsafe := !isTrue(get(sp, "control_enabled")) || SetpointStale(get(sp, "ts"), in.Now)
	wasControlling := z.WasControlling
	nativeWanted := get(sp, "battery_mode") == "native" || get(sp, "battery_mode") == "native_window"
	out.NativeCapabilities = NativeCapabilitiesGeneric(sel, sp, in.Catalog, in.Gesperrt)
	if out.NativeCapabilities == nil {
		out.NativeCapabilities = NativeCapabilitiesDeye(sel, sp, in.Catalog, cap, sticky)
	}
	nativeRefusal := ""
	if nativeWanted && !failsafe {
		nat := NativePlanGeneric(sel, sp, in.Catalog, in.Gesperrt)
		if nat == nil {
			nat = NativePlanDeye(sel, sp, in.Catalog, cap, sticky, nativeCfg)
		}
		var natPre []ReadOp
		if nat != nil && nat.Supported != nil && *nat.Supported && len(nat.Preconditions) > 0 {
			natPre = nat.Preconditions
		}
		var natProof *ReadOp
		if natPre != nil && nat.GridChargeProof != nil {
			natProof = nat.GridChargeProof
		}
		if nat != nil && len(nat.Writes) > 0 {
			raw, _ := json.Marshal(nat.Writes)
			sig := string(raw)
			if !(nat.Heartbeat != nil && *nat.Heartbeat) && z.NativeWritten == sig {
				nat.Writes = []WriteOp{}
			} else {
				z.NativeWritten = sig
			}
			if natPre != nil {
				nat.NativePreconditions, nat.NativeGridChargeProof = natPre, natProof
			}
			z.WasControlling = false
			z.NativeRefusal = ""
			out.Control = nat
			return out, z
		}
		z.NativeWritten = ""
		if natPre != nil {
			plan.NativePreconditions, plan.NativeGridChargeProof = natPre, natProof
		}
		switch {
		case nat != nil && nat.Reason != "":
			nativeRefusal = nat.Reason
		case get(sp, "battery_mode") == "native_window":
			nativeRefusal = "Wechselrichter-Automatik für diese Absicht noch nicht am Prüfstand freigegeben"
		default:
			nativeRefusal = "dieser Adapter hat keine native Selbstregelung"
		}
		out.NativeRefusal = nativeRefusal
		if z.NativeRefusal != nativeRefusal {
			z.NativeRefusal = nativeRefusal
			out.Warn = "Wechselrichter-Automatik nicht moeglich: " + nativeRefusal + " - es bleibt bei der 10-Sekunden-Nachfuehrung"
		}
	} else {
		z.NativeWritten = ""
		z.NativeRefusal = ""
	}

	var touBudget *TouBudget
	if plan.Adapter == "solarman_v5" && plan.ControlPath == DeyePathTou && plan.Connection != nil && isStr(get(plan.Connection, "ip")) {
		port := num(get(plan.Connection, "port"))
		if !truthy(get(plan.Connection, "port")) {
			port = 8899
		}
		var rec any
		if in.TouBudget != nil {
			rec = in.TouBudget(str(get(plan.Connection, "ip")), port)
		}
		b := TouBudgetToday(rec, in.Now)
		touBudget = &b
	}
	release := func(calibration, controlEnabled bool) Plan {
		return ControlRelease(sel, ReleaseOpts{OhneFlotte: in.Gesperrt, Calibration: calibration, ControlEnabled: controlEnabled,
			DeviceCertified: isTrue(get(sp, "device_certified")), Snapshot: snapRegs, Deye: cap, DeyeSticky: sticky})
	}
	switch {
	case touBudget != nil && touBudget.Held && !failsafe && !isTrue(get(sp, "calibration")):
		why := TouBudgetReason(*touBudget, TouBudgetLimit(get(sp, "persistent_write_budget")))
		z.WasControlling = false
		if wasControlling {
			if rel := release(false, true); len(rel.Writes) > 0 {
				out.Control = &rel
				break
			}
		}
		held := plan
		held.Writes, held.Readbacks = []WriteOp{}, []ReadOp{}
		held.Blocked, held.TouBudgetHold, held.Reason = true, true, why
		out.Control = &held
	case hadWrites && !failsafe:
		z.WasControlling = true
		out.Control = &plan
	case failsafe && wasControlling:
		rel := release(isTrue(get(sp, "calibration")), isTrue(get(sp, "control_enabled")))
		if len(rel.Writes) > 0 {
			z.WasControlling = false
			out.Control = &rel
		} else {
			out.Control = &plan
		}
	default:
		out.Control = &plan
	}
	return out, z
}

// Steuerpfad is the Deye control path the plan node will take for this
// selection: "remote" (block 1100-1121) or "tou" - the same dispatch as
// ControlRoute, with the First-Light seed the plan node applies. Layer 1 keys
// its Edge Light release on it.
func Steuerpfad(sel, sp, cap, sticky Obj, now time.Time) string {
	if sticky == nil {
		sticky = DeyeSeedStickyFromGrant(sp, float64(now.UnixMilli()))
	}
	conn, _ := selConn(sel)
	_, hasReg := DeyeFamilyControlReg(trimmed(get(sel, "family")))
	if hasReg && !remoteForcedOff(conn) && DeyeControlPath(DeyeEffectiveCap(cap, sticky)) == DeyePathRemote {
		return DeyePathRemote
	}
	return DeyePathTou
}
