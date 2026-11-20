package steuerplan

import "strings"

// Form is the primary-family shape() of the palette node vp-control-readback
// (edge-app/nodered/vp-palette/nodes/vp-control-readback.js): the FIXED field
// list the core parses from edge/control/readback, the cycle verdict derived
// once from the per-register verdicts, and the only-controller awareness.
// nil = not a usable readback (the node publishes nothing). The curtail
// family (the Fronius curtailment, curtail:true) passes through verbatim.
func Form(payload Obj, now string) Obj {
	if payload == nil {
		return nil
	}
	regsIn, ok := get(payload, "registers").([]any)
	if !ok {
		return nil
	}
	registers := make([]any, 0, len(regsIn))
	for _, r := range regsIn {
		o := obj(r)
		if o == nil || !isStr(get(o, "role")) {
			return nil
		}
		if _, ok := get(o, "match").(bool); !ok {
			return nil
		}
		registers = append(registers, o)
	}
	if isTrue(get(payload, "curtail")) {
		// The per-unit curtailment family rides through verbatim: its identity
		// and verdict are what the core's onCurtailReadback needs.
		if s, _ := get(payload, "source_id").(string); s == "" {
			return nil
		}
		if s, _ := get(payload, "unit_key").(string); s == "" {
			return nil
		}
		out := make(Obj, len(payload)+1)
		for k, v := range payload {
			out[k] = v
		}
		if _, ok := get(payload, "ts").(string); !ok {
			out["ts"] = now
		}
		out["registers"] = registers
		return out
	}
	controlEnabled := isTrue(get(payload, "control_enabled"))
	certified := isTrue(get(payload, "certified"))
	verdictOf := func(r Obj) string {
		switch v := str(get(r, "verdict")); v {
		case VerdictHeld, VerdictMismatch, VerdictUnread:
			return v
		}
		if isTrue(get(r, "match")) {
			return VerdictHeld
		}
		return VerdictMismatch
	}
	mismatch, unread := []any{}, []any{}
	var mismatchS []string
	for _, r := range registers {
		o := r.(Obj)
		switch verdictOf(o) {
		case VerdictMismatch:
			mismatch = append(mismatch, get(o, "role"))
			mismatchS = append(mismatchS, str(get(o, "role")))
		case VerdictUnread:
			unread = append(unread, get(o, "role"))
		}
	}
	var allMatch any
	verify := CycleUnconfirmed
	switch {
	case len(mismatch) > 0:
		allMatch, verify = false, CycleMismatch
	case len(registers) > 0 && len(unread) == 0:
		allMatch, verify = true, CycleHeld
	}
	ts := now
	if s, ok := get(payload, "ts").(string); ok {
		ts = s
	}
	mode := "normal"
	if m := get(payload, "mode"); m == "release" || m == "native" {
		mode = m.(string)
	}
	var remoteStatus any
	if v := get(payload, "remote_status_raw"); isFiniteNum(v) {
		remoteStatus = v
	}
	out := Obj{
		"ts": ts, "family": str(get(payload, "family")), "source": str(get(payload, "source")),
		"control_enabled": controlEnabled, "certified": certified, "mode": mode,
		"control_path": str(get(payload, "control_path")), "remote_status_raw": remoteStatus,
		"registers": registers, "all_match": allMatch, "verify": verify,
		"mismatch_roles": mismatch, "unread_roles": unread,
		"verify_reason":   str(get(payload, "verify_reason")),
		"blocked":         isTrue(get(payload, "blocked")),
		"reason":          str(get(payload, "reason")),
		"dual_controller": dualController(certified, controlEnabled, len(registers), allMatch, mismatchS),
	}
	if s, ok := get(payload, "slot_start").(string); ok {
		out["slot_start"] = s
	}
	if w, ok := get(payload, "wrote").(bool); ok {
		out["wrote"] = w
	}
	if n := nativeBlockOf(get(payload, "native")); n != nil {
		out["native"] = n
	}
	if p := obj(get(payload, "native_precondition")); p != nil {
		if b, ok := get(p, "grid_charge_blocked").(bool); ok {
			out["native_precondition"] = Obj{"grid_charge_blocked": b}
		}
	}
	if s, ok := get(payload, "native_refusal").(string); ok {
		out["native_refusal"] = s
	}
	if c := nativeCapsOf(get(payload, "native_capabilities")); c != nil {
		out["native_capabilities"] = c
	}
	return out
}

func dualController(certified, controlEnabled bool, n int, allMatch any, mismatch []string) Obj {
	if !(certified && controlEnabled && n > 0) {
		return Obj{"only_controller_required": false, "possible_conflict": false, "detector": "none", "reason": ""}
	}
	out := Obj{"only_controller_required": true, "possible_conflict": false, "detector": "readback_mismatch", "reason": ""}
	if allMatch == false {
		roles := strings.Join(mismatch, ", ")
		if roles == "" {
			roles = "Register weicht ab"
		}
		out["possible_conflict"] = true
		out["reason"] = "Der Wechselrichter hält den geschriebenen Sollwert nicht (" + roles +
			"). Möglicher Konflikt: die eigene Smart-Steuerung des Wechselrichters oder ein " +
			"zweites EMS könnte gegensteuern - VoltPilot muss der einzige Controller sein."
	}
	return out
}

func nativeBlockOf(v any) Obj {
	o := obj(v)
	if o == nil {
		return nil
	}
	out := Obj{}
	if b, ok := get(o, "grid_charge_blocked").(bool); ok {
		out["grid_charge_blocked"] = b
	}
	if s, ok := get(o, "intent").(string); ok {
		out["intent"] = s
	}
	if b, ok := get(o, "curtails_own_pv").(bool); ok {
		out["curtails_own_pv"] = b
	}
	if s, ok := get(o, "candidate").(string); ok {
		out["candidate"] = s
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func nativeCapsOf(v any) Obj {
	o := obj(v)
	if o == nil {
		return nil
	}
	intents, ok := get(o, "intents").([]any)
	if !ok {
		return nil
	}
	for _, i := range intents {
		if !isStr(i) {
			return nil
		}
	}
	w, ok1 := get(o, "window").(bool)
	p, ok2 := get(o, "persistent").(bool)
	if !ok1 || !ok2 {
		return nil
	}
	return Obj{"intents": append([]any{}, intents...), "window": w, "persistent": p}
}
