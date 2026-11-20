package steuerplan

import (
	"context"
	"math"
	"sort"
	"time"
)

// The two nodes of the Fronius curtailment path of the "Energiequellen
// (automatisch)" tab: "PV-Abregelung / Schreibplan" (AbregelPlanen) and
// "Fronius WMaxLimPct schreiben + zuruecklesen" (AbregelAusfuehren). The
// store is the flow context the nodes share (curtail_disc:, curtail_cmd:,
// curtail_was:, curtail_enf:, curtail_obs:, src_last:), all volatile.

// AbregelPlanen is the plan node: the fleet plan from the setpoint, the source
// plans, the cached discoveries and the last readings. nil = nothing to do.
func AbregelPlanen(sp Obj, plans []Obj, flow Obj, now time.Time) Obj {
	if sp == nil {
		return nil
	}
	nowMs := float64(now.UnixMilli())
	discoveries := map[string]Obj{}
	readings := map[string]Obj{}
	for _, p := range plans {
		if p == nil || p["adapter"] != "sunspec_live" || p["role"] != "pv-generation" {
			continue
		}
		key := CurtailUnitKey(obj(p["conn"]))
		if d := obj(flow["curtail_disc:"+key]); d != nil && truthy(d["disc"]) && nowMs-orZero(num(get(d, "at"))) < curtailDiscCacheMs {
			discoveries[key] = obj(d["disc"])
		}
		if id, ok := p["id"].(string); ok {
			if r := obj(flow["src_last:"+id]); r != nil {
				readings[id] = Obj{"pv_kw": jsv(get(r, "pv_kw")), "at": jsv(get(r, "at"))}
			}
		}
	}
	fleet := PlanFleetCurtailment(sp, plans, discoveries, readings, nowMs)
	if !isTrue(fleet["active"]) {
		return nil
	}
	return fleet
}

// AbregelGeraet is one open Modbus TCP session to a gateway; unit is the
// Modbus unit id of the inverter behind it. Every error is the reason the
// executor names (its text is the codec's sentence).
type AbregelGeraet interface {
	Lies(ctx context.Context, unit, addr, count int, timeout time.Duration) ([]int, error)
	Schreibe6(ctx context.Context, unit, addr, value int, timeout time.Duration) error
	Schreibe16(ctx context.Context, unit, addr int, values []int, timeout time.Duration) error
	Close()
}

// AbregelVerbindung opens the session of one gateway (ip, port); observe says
// the tick only reads (it may be put off while a source read runs: ok=false).
type AbregelVerbindung func(ctx context.Context, ip string, port int, observe bool) (dev AbregelGeraet, ok bool, err error)

// AbregelAusfuehren runs the executor over a fleet plan and returns the
// readback payloads (one per unit that has something to say), in the order
// the node sends them.
func AbregelAusfuehren(ctx context.Context, fleet Obj, flow Obj, now func() time.Time, verbinde AbregelVerbindung) []Obj {
	if fleet == nil || !isTrue(fleet["active"]) {
		return nil
	}
	units, _ := fleet["units"].([]any)
	if len(units) == 0 {
		return nil
	}
	ms := func() float64 { return float64(now().UnixMilli()) }
	var out []Obj
	publish := func(u Obj, extra Obj) {
		conn := obj(u["conn"])
		label := str(u["label"])
		p := Obj{"ts": isoMillis(now()), "curtail": true, "source_id": u["sourceId"], "unit_key": u["unitKey"],
			"label": label, "family": "fronius_sunspec",
			"target":          jsStr(conn["ip"]) + ":" + jsStr(conn["port"]) + " (Unit " + jsStr(conn["unit_id"]) + ")",
			"control_enabled": fleet["controlEnabled"], "certified": u["certified"], "calibration": u["test"] != nil,
			"mode": u["mode"], "cap_kw": u["capKw"], "rated_kw": u["ratedKw"]}
		for k, v := range extra {
			if _, isU := v.(undef); isU {
				delete(p, k)
				continue
			}
			p[k] = v
		}
		out = append(out, p)
	}
	var order []string
	groups := map[string][]Obj{}
	for _, x := range units {
		u := obj(x)
		conn := obj(u["conn"])
		k := jsStr(conn["ip"]) + ":" + jsStr(conn["port"])
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], u)
	}
	type job struct {
		u                    Obj
		dkey, cmdKey, dstate string
		effWrites            []any
		cmdState, dec        Obj
	}
	for _, ipKey := range order {
		group := groups[ipKey]
		nowT := ms()
		var jobs []*job
		for _, u := range group {
			key := str(u["unitKey"])
			j := &job{u: u, dkey: "curtail_disc:" + key, cmdKey: "curtail_cmd:" + key}
			j.dstate = curtailDiscoveryState(obj(flow[j.dkey]), nowT)
			plan := obj(u["plan"])
			j.effWrites = []any{}
			if isTrue(plan["ok"]) {
				j.effWrites, _ = plan["writes"].([]any)
			}
			if u["mode"] == "release" && !truthy(flow["curtail_was:"+key]) {
				j.effWrites = []any{}
			}
			j.cmdState = obj(flow[j.cmdKey])
			if j.cmdState == nil {
				j.cmdState = Obj{}
			}
			eff := Obj{"mode": u["mode"], "calibration": truthy(u["calibration"]), "planned": u["planned"],
				"plan": Obj{"ok": plan["ok"], "writes": j.effWrites}}
			j.dec = curtailWriteDecision(eff, j.cmdState, nowT, -1)
			jobs = append(jobs, j)
		}
		prio := func(j *job) int {
			switch {
			case isTrue(j.dec["write"]) && truthy(j.u["calibration"]):
				return 3
			case isTrue(j.dec["write"]):
				return 2
			case j.dstate == "due":
				return 1
			}
			return 0
		}
		sort.SliceStable(jobs, func(a, b int) bool { return prio(jobs[a]) > prio(jobs[b]) })
		needsWalk, willWrite := false, false
		for _, j := range jobs {
			if j.dstate == "due" {
				needsWalk = true
			}
			if isTrue(j.dec["write"]) && len(j.effWrites) > 0 {
				willWrite = true
			}
		}
		blockedSince := func(j *job) float64 { return orZero(num(get(j.cmdState, "blockedSince"))) }
		planOK := func(j *job) bool { return isTrue(obj(j.u["plan"])["ok"]) }
		publishIdle := func(j *job) bool {
			switch {
			case j.dstate == "failed_backoff":
				reason := str(get(obj(flow[j.dkey]), "reason"))
				if reason == "" {
					reason = "SunSpec-Modelle nicht lesbar"
				}
				publish(j.u, Obj{"blocked": true, "reason": reason, "registers": []any{}})
				return true
			case blockedSince(j) > 0:
				publish(j.u, Obj{"blocked": true, "reason": CurtailRejectedReason, "registers": []any{}})
				return true
			case j.dstate == "fresh" && !planOK(j):
				reason := str(j.u["reason"])
				if reason == "" {
					reason = str(obj(j.u["plan"])["reason"])
				}
				if reason == "" {
					reason = "kein Schreibplan"
				}
				publish(j.u, Obj{"blocked": true, "reason": reason, "registers": []any{}})
				return true
			}
			return false
		}
		unreachable := func(js []*job) {
			for _, j := range js {
				publish(j.u, Obj{"blocked": true, "reason": "Gateway nicht erreichbar", "registers": []any{}})
			}
		}
		if !willWrite && !needsWalk {
			for _, j := range jobs {
				publishIdle(j)
			}
			var obs []*job
			for _, j := range jobs {
				rbs, _ := obj(j.u["plan"])["readbacks"].([]any)
				if j.dstate == "fresh" && planOK(j) && len(rbs) > 0 && !(blockedSince(j) > 0) {
					obs = append(obs, j)
				}
			}
			if len(obs) == 0 || !curtailObserveDue(flow["curtail_obs:"+ipKey], nowT) {
				continue
			}
			conn := obj(obs[0].u["conn"])
			dev, ok, err := verbinde(ctx, str(conn["ip"]), int(num(conn["port"])), true)
			if !ok && err == nil {
				continue // a source read runs: the observation is put off
			}
			if err != nil {
				unreachable(obs)
				continue
			}
			deadline := now().Add(CurtailExecDeadlineMs * time.Millisecond)
			for _, j := range obs {
				regs, rerr := curtailReadbacks(ctx, dev, j.u, deadline, now)
				if rerr != "" {
					publish(j.u, Obj{"blocked": true, "reason": "Ruecklesen fehlgeschlagen: " + rerr, "registers": regs})
					continue
				}
				delete(flow, "curtail_enf:"+str(j.u["unitKey"]))
				vo := curtailEvaluateReadback(regs)
				hadCmd := truthy(get(j.cmdState, "sig"))
				if hadCmd {
					flow[j.cmdKey] = curtailNoteVerdict(j.cmdState, vo, ms())
				}
				rej := hadCmd && blockedSince(j) > 0
				var allMatch any
				mismatch := any([]any{})
				if hadCmd {
					allMatch, mismatch = vo["held"], vo["mismatchRoles"]
				}
				reason := get(j.u, "reason")
				if rej {
					reason = CurtailRejectedReason
				}
				publish(j.u, Obj{"applied": false, "all_match": allMatch, "mismatch_roles": mismatch,
					"quirk_roles": vo["quirkRoles"], "quirk_note": vo["quirkNote"], "registers": regs,
					"enforcement": nil, "blocked": rej, "reason": reason})
			}
			flow["curtail_obs:"+ipKey] = ms()
			dev.Close()
			continue
		}
		conn := obj(group[0]["conn"])
		dev, ok, err := verbinde(ctx, str(conn["ip"]), int(num(conn["port"])), false)
		if err != nil || !ok {
			var all []*job
			for _, u := range group {
				all = append(all, &job{u: u})
			}
			unreachable(all)
			continue
		}
		deadline := now().Add(CurtailExecDeadlineMs * time.Millisecond)
		for _, j := range jobs {
			u := j.u
			key := str(u["unitKey"])
			unit := int(num(obj(u["conn"])["unit_id"]))
			if now().After(deadline) {
				publish(u, Obj{"blocked": true, "reason": "Zeitbudget erschoepft (Verbindung haengt?)", "registers": []any{}})
				continue
			}
			if j.dstate == "failed_backoff" || (j.dstate == "fresh" && !planOK(j)) {
				publishIdle(j)
				continue
			}
			if j.dstate == "due" {
				img, base, walked := curtailWalk(ctx, dev, unit, deadline, now)
				unitTxt := " (Unit " + jsStr(obj(u["conn"])["unit_id"]) + ")"
				if !walked {
					reason := "SunSpec-Modelle nicht lesbar" + unitTxt
					flow[j.dkey] = Obj{"at": ms(), "failed": true, "reason": reason}
					publish(u, Obj{"blocked": true, "reason": reason, "registers": []any{}})
					continue
				}
				disc := SunspecDiscover(func(addr, count int) ([]int, bool) {
					var o []int
					for i := 0; i < count; i++ {
						w, ok := img[addr+i]
						if !ok {
							break
						}
						o = append(o, w)
					}
					return o, true
				}, []int{base})
				if !isTrue(disc["ok"]) {
					reason := "SunSpec-Modelle nicht auswertbar" + unitTxt
					flow[j.dkey] = Obj{"at": ms(), "failed": true, "reason": reason}
					publish(u, Obj{"blocked": true, "reason": reason, "registers": []any{}})
					continue
				}
				flow[j.dkey] = Obj{"at": ms(), "disc": disc}
				if c := obj(disc["controls"]); c == nil || !isTrue(c["present"]) {
					publish(u, Obj{"blocked": true, "reason": "Modell 123 (Immediate Controls) fehlt - Abregelung auf dieser Firmware nicht moeglich", "registers": []any{}})
					continue
				}
				publish(u, Obj{"blocked": true, "reason": "SunSpec-Modelle erkannt - der naechste Takt plant", "registers": []any{}})
				continue
			}
			wasKey := "curtail_was:" + key
			writes := j.effWrites
			cmdState := j.cmdState
			didWrite := false
			if isTrue(j.dec["write"]) && len(writes) > 0 {
				if werr := curtailApply(ctx, dev, unit, writes, deadline, now); werr != "" {
					flow[j.cmdKey] = cmdState
					publish(u, Obj{"blocked": true, "reason": "Schreiben fehlgeschlagen: " + werr, "registers": []any{}})
					continue
				}
				didWrite = true
				cmdState = curtailNoteWrite(cmdState, j.dec, ms())
			}
			regs, rerr := curtailReadbacks(ctx, dev, u, deadline, now)
			if rerr != "" {
				flow[j.cmdKey] = cmdState
				publish(u, Obj{"blocked": true, "reason": "Ruecklesen fehlgeschlagen: " + rerr, "registers": regs})
				continue
			}
			if didWrite {
				if u["mode"] == "release" {
					flow[wasKey] = 0.0
				} else {
					flow[wasKey] = 1.0
				}
			}
			verdict := curtailEvaluateReadback(regs)
			hasCommand := didWrite || truthy(get(cmdState, "sig"))
			if hasCommand {
				cmdState = curtailNoteVerdict(cmdState, verdict, ms())
				if !isTrue(verdict["held"]) && didWrite {
					again := curtailWriteDecision(Obj{"mode": u["mode"], "calibration": truthy(u["calibration"]), "planned": u["planned"],
						"plan": Obj{"ok": obj(u["plan"])["ok"], "writes": writes}}, cmdState, ms(), -1)
					if isTrue(again["write"]) && now().Before(deadline) {
						if curtailApply(ctx, dev, unit, writes, deadline, now) == "" {
							cmdState = curtailNoteWrite(cmdState, again, ms())
							if r2, e2 := curtailReadbacks(ctx, dev, u, deadline, now); e2 == "" {
								regs = r2
								verdict = curtailEvaluateReadback(r2)
								cmdState = curtailNoteVerdict(cmdState, verdict, ms())
							}
						}
					}
				}
			}
			flow[j.cmdKey] = cmdState
			var allMatch any
			mismatch := any([]any{})
			if hasCommand {
				allMatch, mismatch = verdict["held"], verdict["mismatchRoles"]
			}
			rejected := orZero(num(get(cmdState, "blockedSince"))) > 0
			var enforcement any
			enfKey := "curtail_enf:" + key
			if hasCommand && u["mode"] == "apply" {
				st := obj(flow[enfKey])
				if st == nil {
					st = Obj{}
				}
				if !truthy(st["activeSince"]) {
					st["activeSince"] = ms()
				}
				if isNum(st["capKw"]) && num(u["capKw"]) < num(st["capKw"])-0.25 {
					st["activeSince"] = ms()
				}
				st["capKw"] = jsv(u["capKw"])
				flow[enfKey] = st
				meas := obj(flow["src_last:"+str(u["sourceId"])])
				var mKw, mAt any = nil, nil
				if meas != nil {
					mKw, mAt = jsv(get(meas, "pv_kw")), jsv(get(meas, "at"))
				}
				ev := curtailEnforcement(u["capKw"], mKw, mAt, st["activeSince"], ms())
				var measured any
				if meas != nil && isNum(meas["pv_kw"]) {
					measured = meas["pv_kw"]
				}
				enforcement = Obj{"status": ev["status"], "possible_override": ev["possibleOverride"], "reason": ev["reason"], "measured_kw": measured}
			} else {
				delete(flow, enfKey)
			}
			reason := get(u, "reason")
			if rejected {
				reason = CurtailRejectedReason
			}
			publish(u, Obj{"applied": didWrite, "all_match": allMatch, "mismatch_roles": mismatch,
				"quirk_roles": verdict["quirkRoles"], "quirk_note": verdict["quirkNote"], "registers": regs,
				"enforcement": enforcement, "blocked": rejected, "reason": reason})
		}
		flow["curtail_obs:"+ipKey] = ms()
		dev.Close()
	}
	return out
}

// curtailReadbacks reads the unit's readback registers (a register without
// an answer stays null, never a fabricated 0). err = the first failure.
func curtailReadbacks(ctx context.Context, dev AbregelGeraet, u Obj, deadline time.Time, now func() time.Time) ([]any, string) {
	registers := []any{}
	plan := obj(u["plan"])
	unit := int(num(obj(u["conn"])["unit_id"]))
	rbs, _ := plan["readbacks"].([]any)
	for _, x := range rbs {
		rb := obj(x)
		if now().After(deadline) {
			return registers, "Zeitbudget erschoepft (Verbindung haengt?)"
		}
		regs, err := dev.Lies(ctx, unit, int(num(rb["addr"])), 1, CurtailOpTimeout(deadline, now()))
		if err != nil {
			return registers, err.Error()
		}
		expect := u16(num(rb["expect"]))
		var actual any
		match := false
		if len(regs) > 0 {
			a := regs[0] & 0xffff
			actual = float64(a)
			d := a - expect
			if d < 0 {
				d = -d
			}
			match = float64(d) <= orZero(num(rb["tolerance"]))
		}
		e := Obj{"role": rb["role"], "fc": 3.0, "addr": rb["addr"], "commanded_raw": float64(expect), "actual_raw": actual, "match": match}
		if rb["role"] == "pv_limit_pct" && truthy(u["ratedKw"]) {
			var w0 Obj
			if ws, _ := plan["writes"].([]any); len(ws) > 0 {
				w0 = obj(ws[0])
			} else if ps, _ := u["planned"].([]any); len(ps) > 0 {
				w0 = obj(ps[0])
			}
			sf := -2.0
			if enc := obj(get(w0, "encode")); enc != nil && isNum(enc["sf"]) {
				sf = num(enc["sf"])
			}
			e["commanded_kw"] = jsv(u["capKw"])
			if actual == nil {
				e["actual_kw"] = nil
			} else {
				rk := num(u["ratedKw"])
				e["actual_kw"] = round(float64(float64(float64(rk*float64(actual.(float64)*math.Pow(10, sf)))/100)*1000)) / 1000
			}
		}
		registers = append(registers, e)
	}
	return registers, ""
}

// curtailApply writes the command once: the FC16 block, or the legacy FC6
// registers. err = the failure.
func curtailApply(ctx context.Context, dev AbregelGeraet, unit int, writes []any, deadline time.Time, now func() time.Time) string {
	for _, x := range writes {
		w := obj(x)
		if now().After(deadline) {
			return "Zeitbudget erschoepft (Verbindung haengt?)"
		}
		to := CurtailOpTimeout(deadline, now())
		var err error
		if vals, ok := w["values"].([]any); ok && num(w["fc"]) == 16 {
			vs := make([]int, len(vals))
			for i, v := range vals {
				vs[i] = u16(num(v))
			}
			err = dev.Schreibe16(ctx, unit, int(num(w["addr"])), vs, to)
		} else {
			err = dev.Schreibe6(ctx, unit, int(num(w["addr"])), u16(num(w["value"])), to)
		}
		if err != nil {
			return err.Error()
		}
	}
	return ""
}

// curtailWalk is the executor's SunSpec walk of one unit into a register
// image: SID at 40000, 50000, 0; model headers; bodies in chunks of 120.
func curtailWalk(ctx context.Context, dev AbregelGeraet, unit int, deadline time.Time, now func() time.Time) (map[int]int, int, bool) {
	for _, base := range []int{40000, 50000, 0} {
		if now().After(deadline) {
			return nil, 0, false
		}
		sid, err := dev.Lies(ctx, unit, base, 2, CurtailOpTimeout(deadline, now()))
		if err != nil || len(sid) < 2 || uint32(sid[0]&0xffff)*0x10000+uint32(sid[1]&0xffff) != sunspecSID {
			continue
		}
		img := map[int]int{base: sid[0], base + 1: sid[1]}
		addr := base + 2
		for i := 0; i < 256; i++ {
			if now().After(deadline) {
				return nil, 0, false
			}
			hdr, err := dev.Lies(ctx, unit, addr, 2, CurtailOpTimeout(deadline, now()))
			if err != nil || len(hdr) < 2 {
				// The flow reads hdr[0]/hdr[1] of a short answer as undefined and
				// stops at the next comparison; an error ends the walk.
				if err == nil && len(hdr) > 0 {
					img[addr] = hdr[0]
				}
				break
			}
			id, n := hdr[0], hdr[1]
			img[addr], img[addr+1] = id, n
			if id == 0xffff || n > 8192 {
				break
			}
			if n > 0 {
				a2, rem, ok := addr+2, n, true
				for rem > 0 {
					if now().After(deadline) {
						return nil, 0, false
					}
					k := rem
					if k > 120 {
						k = 120
					}
					part, err := dev.Lies(ctx, unit, a2, k, CurtailOpTimeout(deadline, now()))
					if err != nil {
						ok = false
						break
					}
					for x := 0; x < k && x < len(part); x++ {
						img[a2+x] = part[x]
					}
					a2 += k
					rem -= k
				}
				if !ok {
					break
				}
			}
			addr += 2 + n
		}
		return img, base, true
	}
	return nil, 0, false
}
