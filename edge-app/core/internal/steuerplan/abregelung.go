package steuerplan

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FLEET feed-in curtailment of the Fronius SunSpec Erzeuger sources: the Go
// twin of edge-app/nodered/sunspec/curtail.js and sunspec/curtail-lease.js.
// The plant cap pv_limit_kw is split across the writable units (Model 123
// WMaxLimPct), the uncontrollable PV share is subtracted, an active cap is
// refreshed inside the inverter's own 60-s revert timer, a discarded command
// is re-written on a bounded ladder, and the cap is verified by EFFECT
// (Modbus has the lowest priority on Fronius). Two gates per unit, both on
// the setpoint's curtail block: the kill switch and the unit's First-Light
// grant (or a bounded test).

const (
	CurtailRefreshMs        = 20000
	CurtailRewriteMax       = 3
	CurtailRewriteCooldown  = 60000
	curtailSettleMs         = 90000
	curtailOverrideTolFrac  = 0.1
	curtailOverrideTolMinKw = 0.5
	curtailReadingFreshMs   = 60000
	curtailStaleMs          = 20 * 60 * 1000

	// the lease of curtail-lease.js
	CurtailExecDeadlineMs  = 25000
	curtailDiscCacheMs     = 3600000
	CurtailDiscFailBackoff = 120000
	CurtailObserveMinMs    = 60000
	curtailOpTimeoutMaxMs  = 8000
	curtailOpTimeoutMinMs  = 250
)

// CurtailRejectedReason names the likeliest cause of a command the device
// keeps discarding.
var CurtailRejectedReason = "Der Wechselrichter verwirft die Begrenzung: der befohlene Wert wurde " +
	strconv.Itoa(CurtailRewriteMax) + "× geschrieben und jedes Mal wieder überschrieben. Vermutlich regelt " +
	"eine Fronius-INTERNE Steuerung vor (EVU-Editor / IO-Regel \"100 %\", Solar.web, ein Smart Meter) - " +
	"Modbus hat auf Fronius die NIEDRIGSTE Priorität. Bitte im Fronius-Weboberflächen-EVU-Editor die " +
	"100-%-Regel deaktivieren."

const curtailEnaQuirkNote = "Die Freigabe-Kennung (WMaxLim_Ena) meldet dauerhaft 1 - ein bekanntes " +
	"Verhalten dieser Datamanager-Firmware. Maßgeblich ist der Begrenzungswert (WMaxLimPct); " +
	"er wurde bestätigt."

func r3(x float64) float64 { return round(float64(x*1000)) / 1000 }

// CurtailUnitKey is the physical identity ip:port#unit_id (the core's
// curtailUnitKey).
func CurtailUnitKey(conn Obj) string {
	port := portOr(conn, "port", 502)
	unit := portOr(conn, "unit_id", 1)
	return trimmed(get(conn, "ip")) + ":" + jsNumberString(port) + "#" + jsNumberString(unit)
}

func curtailSetpointStale(ts any, nowMs float64) bool {
	s, ok := ts.(string)
	if !ok || s == "" {
		return false
	}
	t, ok := parseJSDate(s)
	if !ok {
		return false
	}
	return nowMs-float64(t) > curtailStaleMs
}

type curtailUnitRated struct {
	id      string
	ratedKw float64
}

// splitPlantCap distributes the budget proportional to rating with a
// waterfall at each unit's nameplate.
func splitPlantCap(plantCapKw float64, uncontrolled float64, units []curtailUnitRated) (float64, map[string]float64) {
	budget := math.Max(0, plantCapKw-uncontrolled)
	caps := map[string]float64{}
	if len(units) == 0 {
		return r3(budget), caps
	}
	remaining := budget
	open := append([]curtailUnitRated{}, units...)
	for len(open) > 0 {
		ratedSum := 0.0
		for _, u := range open {
			ratedSum += u.ratedKw
		}
		var clamped []string
		consumed := 0.0
		for _, u := range open {
			share := float64(remaining * float64(u.ratedKw/ratedSum))
			if share >= u.ratedKw {
				caps[u.id] = u.ratedKw
				consumed += u.ratedKw
				clamped = append(clamped, u.id)
			} else {
				caps[u.id] = share
			}
		}
		if len(clamped) == 0 {
			break
		}
		remaining -= consumed
		var rest []curtailUnitRated
		for _, u := range open {
			hit := false
			for _, c := range clamped {
				if c == u.id {
					hit = true
				}
			}
			if !hit {
				rest = append(rest, u)
			}
		}
		open = rest
		if remaining <= 0 {
			for _, u := range open {
				caps[u.id] = 0
			}
			break
		}
	}
	for id, v := range caps {
		caps[id] = r3(v)
	}
	return r3(budget), caps
}

// PlanFleetCurtailment is the per-tick plan of every curtailable source
// (planFleetCurtailment). plans are the source plans (adapter, role, id,
// conn), discoveries keyed by unit key, readings by source id {pv_kw, at}.
func PlanFleetCurtailment(sp Obj, plans []Obj, discoveries map[string]Obj, readings map[string]Obj, nowMs float64) Obj {
	if sp == nil {
		sp = Obj{}
	}
	out := Obj{"active": false, "mode": "idle", "reason": "", "controlEnabled": false,
		"budgetKw": nil, "uncontrolledKw": 0.0, "units": []any{}}
	cur := obj(get(sp, "curtail"))
	if cur == nil {
		out["reason"] = "keine Abregelungs-Konfiguration am Sollwert (aelterer Core oder keine Fronius-Quellen)"
		return out
	}
	byID := map[string]Obj{}
	if list, ok := get(cur, "sources").([]any); ok {
		for _, e := range list {
			if o := obj(e); o != nil && isStr(o["id"]) {
				byID[o["id"].(string)] = o
			}
		}
	}
	var unitPlans []Obj
	for _, p := range plans {
		if p != nil && p["adapter"] == "sunspec_live" && p["role"] == "pv-generation" && isStr(p["id"]) && byID[p["id"].(string)] != nil {
			unitPlans = append(unitPlans, p)
		}
	}
	if len(unitPlans) == 0 {
		out["reason"] = "keine Fronius-SunSpec-Erzeuger als Quelle konfiguriert"
		return out
	}
	out["active"] = true
	controlEnabled := isTrue(get(cur, "control_enabled"))
	out["controlEnabled"] = controlEnabled
	stale := curtailSetpointStale(get(sp, "ts"), nowMs)
	var plantCap *float64
	if v := get(sp, "pv_limit_kw"); isFiniteNum(v) && num(v) >= 0 {
		plantCap = ptr(num(v))
	}
	var coreUncontrolled *float64
	if v := get(cur, "pv_uncontrolled_kw"); isFiniteNum(v) {
		coreUncontrolled = ptr(math.Max(0, num(v)))
	}
	freshPv := func(id string) *float64 {
		r := readings[id]
		if r == nil || !isFiniteNum(r["pv_kw"]) {
			return nil
		}
		if !isFiniteNum(r["at"]) || nowMs-num(r["at"]) > curtailReadingFreshMs {
			return nil
		}
		return ptr(math.Max(0, num(r["pv_kw"])))
	}
	type row struct {
		p, entry    Obj
		key         string
		discovery   Obj
		ratedKw     *float64
		certified   bool
		test        Obj
		hasControls bool
		writable    bool
	}
	var rows []*row
	for _, p := range unitPlans {
		entry := byID[p["id"].(string)]
		conn := obj(p["conn"])
		key := CurtailUnitKey(conn)
		d := discoveries[key]
		var rated *float64
		if d != nil && isFiniteNum(d["nameplateKw"]) && num(d["nameplateKw"]) > 0 {
			rated = ptr(num(d["nameplateKw"]))
		} else if v := get(entry, "capacity_kwp"); isFiniteNum(v) && num(v) > 0 {
			rated = ptr(num(v))
		}
		var test Obj
		if t := obj(get(entry, "test")); t != nil && isFiniteNum(t["cap_kw"]) {
			test = Obj{"cap_kw": math.Max(0, num(t["cap_kw"]))}
		}
		hc := false
		if d != nil && isTrue(d["ok"]) {
			if c := obj(d["controls"]); c != nil && isTrue(c["present"]) {
				hc = true
			}
		}
		rows = append(rows, &row{p: p, entry: entry, key: key, discovery: d, ratedKw: rated,
			certified: isTrue(get(entry, "certified")), test: test, hasControls: hc})
	}
	for _, r := range rows {
		r.writable = controlEnabled && (r.certified || r.test != nil) && r.hasControls && r.ratedKw != nil
	}
	uncontrolled := 0.0
	if coreUncontrolled != nil {
		uncontrolled = *coreUncontrolled
	}
	out["uncontrolledUnknown"] = coreUncontrolled == nil
	for _, r := range rows {
		if r.writable && r.test == nil {
			continue
		}
		if pv := freshPv(r.p["id"].(string)); pv != nil {
			uncontrolled += *pv
		}
	}
	out["uncontrolledKw"] = r3(uncontrolled)
	mode := "apply"
	if stale || plantCap == nil {
		mode = "release"
	}
	out["mode"] = mode
	if stale {
		out["reason"] = "Sollwert veraltet (Core still) - Begrenzungen werden freigegeben"
	}
	caps := map[string]float64{}
	if mode == "apply" {
		var us []curtailUnitRated
		for _, r := range rows {
			if r.writable && r.test == nil {
				us = append(us, curtailUnitRated{r.p["id"].(string), *r.ratedKw})
			}
		}
		budget, c := splitPlantCap(*plantCap, uncontrolled, us)
		out["budgetKw"] = budget
		caps = c
	}
	units := []any{}
	for _, r := range rows {
		var capKw *float64
		if r.test != nil && !stale {
			capKw = ptr(num(r.test["cap_kw"]))
		} else if mode == "apply" {
			if v, ok := caps[r.p["id"].(string)]; ok {
				capKw = ptr(v)
			}
		}
		release := capKw == nil
		conn := obj(r.p["conn"])
		plan := planCurtailment(r.discovery, capKw, r.ratedKw, curtailRvrtTms, get(conn, "curtail_write_fc"))
		ok := isTrue(plan["ok"])
		writeAllowed := controlEnabled && (r.certified || r.test != nil) && ok
		planned := []any{}
		if ok {
			for _, w := range plan["writes"].([]any) {
				c := clone(w).(map[string]any)
				if !r.certified {
					c["bench_pending"] = true
				}
				planned = append(planned, c)
			}
		}
		var testV any
		if r.test != nil {
			testV = r.test
		}
		var rated, capV any
		if r.ratedKw != nil {
			rated = *r.ratedKw
		}
		if capKw != nil {
			capV = r3(*capKw)
		}
		umode := "apply"
		if release {
			umode = "release"
		}
		writes := []any{}
		if writeAllowed {
			writes = plan["writes"].([]any)
		}
		readbacks := []any{}
		if ok {
			readbacks = plan["readbacks"].([]any)
		}
		u := Obj{
			"sourceId": r.p["id"], "unitKey": r.key, "label": str(get(r.entry, "label")),
			"conn":      Obj{"ip": get(conn, "ip"), "port": portOr(conn, "port", 502), "unit_id": portOr(conn, "unit_id", 1)},
			"certified": r.certified, "test": testV, "calibration": r.test != nil,
			"ratedKw": rated, "capKw": capV, "mode": umode, "writeAllowed": writeAllowed,
			"plan":    Obj{"ok": ok, "reason": plan["reason"], "writes": writes, "readbacks": readbacks},
			"planned": planned,
		}
		switch {
		case !ok:
			u["reason"] = plan["reason"]
		case !writeAllowed && !controlEnabled:
			u["reason"] = "Steuerung deaktiviert (Not-Aus)"
		case !writeAllowed:
			u["reason"] = "Abregelung für diesen Wechselrichter noch nicht freigegeben"
		}
		units = append(units, u)
	}
	out["units"] = units
	return out
}

// curtailEnforcement is the override detection by effect
// (evaluateEnforcement).
func curtailEnforcement(capKw, measuredKw, measuredAt, activeSince any, nowMs float64) Obj {
	out := Obj{"status": "inactive", "possibleOverride": false, "reason": ""}
	if !isFiniteNum(capKw) || !isFiniteNum(activeSince) {
		return out
	}
	if !isFiniteNum(measuredKw) || !isFiniteNum(measuredAt) || nowMs-num(measuredAt) > curtailReadingFreshMs {
		out["status"] = "unknown"
		out["reason"] = "kein aktueller Messwert - Wirkung der Begrenzung nicht pruefbar"
		return out
	}
	if nowMs-num(activeSince) < curtailSettleMs {
		out["status"] = "settling"
		return out
	}
	c, m := num(capKw), num(measuredKw)
	tol := math.Max(curtailOverrideTolMinKw, float64(curtailOverrideTolFrac*c))
	if m > c+tol {
		out["status"] = "possible_override"
		out["possibleOverride"] = true
		out["reason"] = "Der Wechselrichter liefert " + jsNumberString(r3(m)) + " kW trotz Begrenzung auf " +
			jsNumberString(r3(c)) + " kW. Möglicher Konflikt: eine lokale Einstellung, Solar.web oder ein " +
			"Smart Meter übersteuert die Modbus-Begrenzung (Modbus hat auf Fronius die NIEDRIGSTE " +
			"Priorität) - VoltPilot muss der einzige Controller sein."
		return out
	}
	out["status"] = "ok"
	return out
}

// curtailCommandSignature is the stable identity of a unit's command
// (commandSignature); "" = nothing to command.
func curtailCommandSignature(unit Obj) (string, bool) {
	plan := obj(get(unit, "plan"))
	if plan == nil || !isTrue(plan["ok"]) {
		return "", false
	}
	ops, _ := plan["writes"].([]any)
	if len(ops) == 0 {
		ops, _ = get(unit, "planned").([]any)
	}
	if len(ops) == 0 {
		return "", false
	}
	word := func(v any) string {
		f := num(v)
		if math.IsNaN(f) {
			f = 0
		}
		return strconv.Itoa(u16(f))
	}
	parts := make([]string, len(ops))
	for i, o := range ops {
		w := obj(o)
		sig := ""
		if vals, ok := w["values"].([]any); ok {
			ws := make([]string, len(vals))
			for j, v := range vals {
				ws[j] = word(v)
			}
			sig = strings.Join(ws, ".")
		} else {
			sig = word(w["value"])
		}
		parts[i] = jsStr(w["role"]) + "=" + sig
	}
	return jsStr(get(unit, "mode")) + "|" + strings.Join(parts, ","), true
}

func jsStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case undef:
		return "undefined"
	case nil:
		return "null"
	}
	return jsString(v)
}

// curtailEvaluateReadback is what the FC3 readback of one unit MEANS
// (evaluateReadback): the Ena quirk tolerated one-sided, WMaxLimPct binding.
func curtailEvaluateReadback(registers []any) Obj {
	out := Obj{"held": false, "allMatch": false, "mismatchRoles": []any{}, "quirkRoles": []any{},
		"unreadRoles": []any{}, "quirkNote": ""}
	if len(registers) == 0 {
		return out
	}
	var mismatch, quirk, unread []any
	sawPct := false
	for _, x := range registers {
		r := obj(x)
		if r == nil || !isStr(r["role"]) {
			continue
		}
		role := r["role"].(string)
		if a := get(r, "actual_raw"); a == nil || isUndef(a) {
			unread = append(unread, role)
			continue
		}
		if role == "pv_limit_pct" {
			sawPct = true
		}
		if truthy(r["match"]) {
			continue
		}
		cmd := u16(orZero(num(r["commanded_raw"])))
		act := u16(orZero(num(r["actual_raw"])))
		if role == "pv_limit_enable" && cmd == 0 && act != 0 {
			quirk = append(quirk, role)
			continue
		}
		mismatch = append(mismatch, role)
	}
	held := sawPct && len(mismatch) == 0 && len(unread) == 0
	out["held"], out["allMatch"] = held, held
	if mismatch != nil {
		out["mismatchRoles"] = mismatch
	}
	if quirk != nil {
		out["quirkRoles"] = quirk
		out["quirkNote"] = curtailEnaQuirkNote
	}
	if unread != nil {
		out["unreadRoles"] = unread
	}
	return out
}

func orZero(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// curtailWriteDecision: does this tick write the unit's command, and why
// (writeDecision). refreshMs < 0 = the production interval.
func curtailWriteDecision(unit Obj, st Obj, nowMs float64, refreshMs float64) Obj {
	sig, has := curtailCommandSignature(unit)
	var sigV any
	if has {
		sigV = sig
	}
	plan := obj(get(unit, "plan"))
	writes, _ := get(plan, "writes").([]any)
	canWrite := plan != nil && isTrue(plan["ok"]) && len(writes) > 0
	dec := func(write bool, kind, reason string) Obj {
		return Obj{"write": write, "kind": kind, "sig": sigV, "reason": reason}
	}
	if !canWrite || !has {
		return dec(false, "none", "")
	}
	if !(num(get(st, "wroteAt")) > 0) {
		return dec(true, "first", "")
	}
	if get(st, "sig") != sig {
		return dec(true, "changed", "")
	}
	blocked := orZero(num(get(st, "blockedSince")))
	if blocked > 0 {
		if nowMs-blocked < CurtailRewriteCooldown {
			return dec(false, "cooldown", CurtailRejectedReason)
		}
		return dec(true, "changed", "")
	}
	if truthy(get(st, "deviating")) {
		if orZero(num(get(st, "attempts"))) < CurtailRewriteMax {
			return dec(true, "retry", "")
		}
		return dec(false, "exhausted", CurtailRejectedReason)
	}
	refresh := float64(CurtailRefreshMs)
	if truthy(get(unit, "calibration")) {
		refresh = 0
	} else if refreshMs >= 0 {
		refresh = refreshMs
	}
	if nowMs-num(get(st, "wroteAt")) >= refresh {
		return dec(true, "refresh", "")
	}
	return dec(false, "verify", "")
}

// curtailNoteWrite folds a performed write into the command state.
func curtailNoteWrite(st, d Obj, nowMs float64) Obj {
	fresh := d["kind"] == "first" || d["kind"] == "changed"
	same := get(st, "sig") == get(d, "sig")
	attempts, deviating, blocked := 1.0, false, 0.0
	if !(fresh || !same) {
		attempts = orZero(num(get(st, "attempts"))) + 1
		deviating = truthy(get(st, "deviating"))
		blocked = orZero(num(get(st, "blockedSince")))
	}
	verified := 0.0
	if same {
		verified = orZero(num(get(st, "verifiedAt")))
	}
	return Obj{"sig": jsv(get(d, "sig")), "wroteAt": nowMs, "attempts": attempts, "deviating": deviating,
		"blockedSince": blocked, "verifiedAt": verified}
}

// curtailNoteVerdict folds a readback verdict into the command state.
func curtailNoteVerdict(st Obj, verdict Obj, nowMs float64) Obj {
	if isTrue(get(verdict, "held")) {
		return Obj{"sig": jsv(get(st, "sig")), "wroteAt": orZero(num(get(st, "wroteAt"))), "attempts": 0.0,
			"deviating": false, "blockedSince": 0.0, "verifiedAt": nowMs}
	}
	attempts := orZero(num(get(st, "attempts")))
	blocked := orZero(num(get(st, "blockedSince")))
	if blocked == 0 && attempts >= CurtailRewriteMax {
		blocked = nowMs
	}
	return Obj{"sig": jsv(get(st, "sig")), "wroteAt": orZero(num(get(st, "wroteAt"))), "attempts": attempts,
		"deviating": true, "blockedSince": blocked, "verifiedAt": orZero(num(get(st, "verifiedAt")))}
}

// curtailDiscoveryState is the cached walk's state (discoveryState).
func curtailDiscoveryState(cached Obj, nowMs float64) string {
	at := orZero(num(get(cached, "at")))
	if cached != nil && truthy(cached["disc"]) && nowMs-at < curtailDiscCacheMs {
		return "fresh"
	}
	if cached != nil && truthy(cached["failed"]) && nowMs-at < CurtailDiscFailBackoff {
		return "failed_backoff"
	}
	return "due"
}

// curtailObserveDue throttles a pure observation per gateway.
func curtailObserveDue(lastAt any, nowMs float64) bool {
	return nowMs-orZero(num(lastAt)) >= CurtailObserveMinMs
}

// CurtailOpTimeout caps one operation on the remaining cycle budget.
func CurtailOpTimeout(deadline, now time.Time) time.Duration {
	rem := deadline.Sub(now)
	if rem > curtailOpTimeoutMaxMs*time.Millisecond {
		return curtailOpTimeoutMaxMs * time.Millisecond
	}
	if rem < curtailOpTimeoutMinMs*time.Millisecond {
		return curtailOpTimeoutMinMs * time.Millisecond
	}
	return rem
}

var _ = sort.Strings
