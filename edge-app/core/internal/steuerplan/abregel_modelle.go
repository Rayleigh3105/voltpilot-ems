package steuerplan

import (
	"math"
	"strconv"
)

// The SunSpec model walk and the Model 123 curtailment mapping the Fronius
// curtailment path plans with: the Go twin of discover/finalize/resolve* and
// planCurtailment of edge-app/nodered/sunspec/model-discovery.js. The result
// is an Obj because it travels as the flow context's record
// (curtail_disc:<unitKey>) and is planned from there.

const (
	sunspecSID       = 0x53756e53
	sunspecEndModel  = 0xffff
	sunspecMaxModels = 256
	sunspecMaxSpan   = 8192

	modelNameplate  = 120
	modelControls   = 123
	modelStorage    = 124
	m123LimitBlockN = 5

	defaultWMaxLimPctSf = -2
	curtailRvrtTms      = 60 // DEFAULT_RVRT_TMS of curtail.js and model-discovery.js
)

// LiesBlock reads count words at addr; ok=false when they are not all there.
type LiesBlock func(addr, count int) ([]int, bool)

func readWords(rb LiesBlock, addr, count int) []int {
	r, ok := rb(addr, count)
	if !ok || len(r) < count {
		return nil
	}
	out := make([]int, count)
	for i := 0; i < count; i++ {
		out[i] = r[i] & 0xffff
	}
	return out
}

func s16w(v int) int {
	v &= 0xffff
	if v > 0x7fff {
		return v - 0x10000
	}
	return v
}

// SunspecDiscoverAt walks the model list from one base (discoverAt).
func SunspecDiscoverAt(rb LiesBlock, base int) Obj {
	sid := readWords(rb, base, 2)
	if sid == nil {
		return Obj{"ok": false, "base": float64(base), "reason": "SID nicht lesbar", "models": []any{}}
	}
	if uint32(sid[0])*0x10000+uint32(sid[1]) != sunspecSID {
		return Obj{"ok": false, "base": float64(base), "reason": "kein SunS-Marker", "models": []any{}}
	}
	var models []Obj
	addr := base + 2
	truncated := false
	for i := 0; i < sunspecMaxModels; i++ {
		if addr-base > sunspecMaxSpan {
			truncated = true
			break
		}
		hdr := readWords(rb, addr, 2)
		if hdr == nil {
			truncated = true
			break
		}
		id, n := hdr[0], hdr[1]
		if id == sunspecEndModel {
			return sunspecFinalize(rb, base, models, false)
		}
		if n > sunspecMaxSpan {
			truncated = true
			break
		}
		models = append(models, Obj{"id": float64(id), "len": float64(n), "headerAddr": float64(addr), "bodyAddr": float64(addr + 2)})
		addr += 2 + n
	}
	return sunspecFinalize(rb, base, models, truncated)
}

// SunspecDiscover tries the bases in order (discover); the executor passes the
// one base its walk found.
func SunspecDiscover(rb LiesBlock, bases []int) Obj {
	var first Obj
	for _, b := range bases {
		r := SunspecDiscoverAt(rb, b)
		if isTrue(r["ok"]) {
			return r
		}
		if first == nil {
			first = r
		}
	}
	if first == nil {
		return Obj{"ok": false, "base": 40000.0, "reason": "keine Basis", "models": []any{}}
	}
	return first
}

func sunspecFinalize(rb LiesBlock, base int, models []Obj, truncated bool) Obj {
	byID := Obj{}
	var first = map[int]Obj{}
	ms := make([]any, len(models))
	for i, m := range models {
		ms[i] = m
		id := int(num(m["id"]))
		if _, ok := first[id]; !ok {
			first[id] = m
			byID[strconv.Itoa(id)] = m
		}
	}
	var inverter any
	for _, m := range models {
		id := int(num(m["id"]))
		if ph, ok := map[int]string{101: "single", 102: "split", 103: "three"}[id]; ok {
			inverter = Obj{"id": float64(id), "type": "int_sf", "phases": ph}
			break
		}
		if ph, ok := map[int]string{111: "single", 112: "split", 113: "three"}[id]; ok {
			inverter = Obj{"id": float64(id), "type": "float", "phases": ph}
			break
		}
	}
	controls := Obj{"present": false}
	if m := first[modelControls]; m != nil {
		b := num(m["bodyAddr"])
		controls = Obj{"present": true, "id": float64(modelControls), "bodyAddr": b,
			"wMaxLimPctAddr": b + 3, "wMaxLimPctWinTmsAddr": b + 4, "wMaxLimPctRvrtTmsAddr": b + 5,
			"wMaxLimPctRmpTmsAddr": b + 6, "wMaxLimEnaAddr": b + 7, "wMaxLimPctSfAddr": b + 21,
			"limitBlockAddr": b + 3, "limitBlockCount": float64(m123LimitBlockN)}
	}
	nameplate := Obj{"present": false}
	if m := first[modelNameplate]; m != nil {
		b := num(m["bodyAddr"])
		nameplate = Obj{"present": true, "id": float64(modelNameplate), "bodyAddr": b, "wRtgAddr": b + 1, "wRtgSfAddr": b + 2}
	}
	storage := Obj{"present": false}
	if m := first[modelStorage]; m != nil {
		b := num(m["bodyAddr"])
		storage = Obj{"present": true, "id": float64(modelStorage), "bodyAddr": b,
			"wChaMaxAddr": b, "wChaMaxSfAddr": b + 16, "storCtlModAddr": b + 3, "minRsvPctAddr": b + 5,
			"minRsvPctSfAddr": b + 19, "chaStateAddr": b + 6, "outWRteAddr": b + 10, "inWRteAddr": b + 11,
			"inOutWRteRvrtTmsAddr": b + 13, "inOutWRteSfAddr": b + 23, "chaGriSetAddr": b + 15}
	}
	out := Obj{"ok": true, "base": float64(base), "truncated": truncated, "models": ms, "byId": byID,
		"inverter": inverter, "controls": controls, "nameplate": nameplate, "storage": storage,
		"nameplateKw": nil, "wMaxLimPctSf": nil, "wChaMaxKw": nil, "inOutWRteSf": nil, "minRsvPctSf": nil}
	if isTrue(nameplate["present"]) {
		if w := readWords(rb, int(num(nameplate["wRtgAddr"])), 2); w != nil {
			out["nameplateKw"] = float64(w[0]) * math.Pow(10, float64(s16w(w[1]))) / 1000
		}
	}
	if isTrue(controls["present"]) {
		if sf := readWords(rb, int(num(controls["wMaxLimPctSfAddr"])), 1); sf != nil {
			out["wMaxLimPctSf"] = float64(s16w(sf[0]))
		}
	}
	if isTrue(storage["present"]) {
		w := readWords(rb, int(num(storage["wChaMaxAddr"])), 1)
		wsf := readWords(rb, int(num(storage["wChaMaxSfAddr"])), 1)
		if w != nil && wsf != nil {
			out["wChaMaxKw"] = float64(w[0]) * math.Pow(10, float64(s16w(wsf[0]))) / 1000
		}
		if io := readWords(rb, int(num(storage["inOutWRteSfAddr"])), 1); io != nil {
			out["inOutWRteSf"] = float64(s16w(io[0]))
		}
		if mr := readWords(rb, int(num(storage["minRsvPctSfAddr"])), 1); mr != nil {
			out["minRsvPctSf"] = float64(s16w(mr[0]))
		}
	}
	return out
}

// planCurtailment maps a feed-in cap onto the Model 123 limit (DISCOVERED
// addresses, one FC16 block by default): nil pvLimitKw = release (enable off,
// 100 %). nameplateKw nil = the discovered rating.
func planCurtailment(discovery Obj, pvLimitKw, nameplateKw *float64, rvrtTms int, writeFc any) Obj {
	idle := func(reason string) Obj {
		return Obj{"ok": false, "reason": reason, "writes": []any{}, "readbacks": []any{}}
	}
	if discovery == nil || !isTrue(discovery["ok"]) {
		return idle("SunSpec-Modelle nicht erkannt")
	}
	c := obj(discovery["controls"])
	if c == nil || !isTrue(c["present"]) {
		return idle("Modell 123 (Immediate Controls) fehlt")
	}
	np := num(get(discovery, "nameplateKw"))
	if nameplateKw != nil {
		np = *nameplateKw
	}
	if !(np > 0) {
		return idle("Nennleistung (Nameplate WRtg) unbekannt")
	}
	sf := float64(defaultWMaxLimPctSf)
	if v := get(discovery, "wMaxLimPctSf"); isFiniteNum(v) {
		sf = num(v)
	}
	curtail := pvLimitKw != nil && finite(*pvLimitKw) && *pvLimitKw >= 0
	pct := 100.0
	var kw any
	if curtail {
		pct = math.Max(0, math.Min(100, float64(*pvLimitKw/np)*100))
		kw = *pvLimitKw
	}
	pctRaw := u16(round(pct / math.Pow(10, sf)))
	ena := 0
	if curtail {
		ena = 1
	}
	rvrt := rvrtTms & 0xffff
	fc := 16
	if num(writeFc) == 6 {
		fc = 6
	}
	enc := func() Obj { return Obj{"kind": "wmax_lim_pct", "pct": pct, "sf": sf, "rated_kw": np, "kw": kw} }
	parts := []Obj{
		{"role": "pv_limit_pct", "addr": c["wMaxLimPctAddr"], "value": float64(pctRaw), "encode": enc()},
		{"role": "pv_limit_window_tms", "addr": c["wMaxLimPctWinTmsAddr"], "value": 0.0, "encode": Obj{"kind": "seconds"}},
		{"role": "pv_limit_revert_tms", "addr": c["wMaxLimPctRvrtTmsAddr"], "value": float64(rvrt), "encode": Obj{"kind": "seconds"}},
		{"role": "pv_limit_ramp_tms", "addr": c["wMaxLimPctRmpTmsAddr"], "value": 0.0, "encode": Obj{"kind": "seconds"}},
		{"role": "pv_limit_enable", "addr": c["wMaxLimEnaAddr"], "value": float64(ena),
			"encode": Obj{"kind": "enum", "enabled": 1.0, "disabled": 0.0, "curtailing": curtail}},
	}
	partsAny := make([]any, len(parts))
	values := make([]any, len(parts))
	for i, p := range parts {
		partsAny[i] = p
		values[i] = p["value"]
	}
	var writes []any
	if fc == 16 {
		writes = []any{Obj{"role": "pv_limit_block", "fc": 16.0, "addr": c["limitBlockAddr"], "values": values,
			"parts": partsAny, "encode": enc(), "dwell_s": 0.0, "min_change": 0.0}}
	} else {
		for _, p := range parts {
			switch p["role"] {
			case "pv_limit_pct", "pv_limit_revert_tms", "pv_limit_enable":
				writes = append(writes, Obj{"role": p["role"], "fc": 6.0, "addr": p["addr"], "value": p["value"],
					"encode": p["encode"], "dwell_s": 0.0, "min_change": 0.0})
			}
		}
	}
	readbacks := []any{
		Obj{"role": "pv_limit_pct", "fc": 3.0, "addr": c["wMaxLimPctAddr"], "expect": float64(pctRaw), "tolerance": 1.0},
		Obj{"role": "pv_limit_revert_tms", "fc": 3.0, "addr": c["wMaxLimPctRvrtTmsAddr"], "expect": float64(rvrt), "tolerance": 2.0},
		Obj{"role": "pv_limit_enable", "fc": 3.0, "addr": c["wMaxLimEnaAddr"], "expect": float64(ena), "tolerance": 0.0},
	}
	return Obj{"ok": true, "writes": writes, "readbacks": readbacks, "parts": partsAny, "writeFc": float64(fc),
		"pct": pct, "pctRaw": float64(pctRaw), "ena": float64(ena), "winTms": 0.0, "rmpTms": 0.0, "rvrtTms": float64(rvrt)}
}
