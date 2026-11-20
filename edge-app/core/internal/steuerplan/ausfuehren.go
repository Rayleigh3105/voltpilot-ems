package steuerplan

import (
	"context"
	"errors"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"time"
)

// The Deye executor ("Deye Solarman-V5 schreiben + zuruecklesen", the flow's
// controlExecSolarmanFunc): one control tick over the ONE logger socket -
// capability probe, path interlock, the installer snapshot before the first
// ToU write, the native precondition reads, the writes (write-on-change for
// EEPROM, `always` for the RAM heartbeat), the readback judged by
// readback-verify, and the readback payload for the core. The transport is
// the caller's (Layer 1 over solarmanv5); everything that decides is here.

// Spur is one open session to the logger. A *Protokollfehler is a refused or
// malformed answer (the flow catches it where it catches a parse error);
// every other error ends the tick like a dead socket.
type Spur interface {
	Lies(ctx context.Context, addr, count int) ([]int, error)
	Schreibe(ctx context.Context, fc, addr, value int) error
}

// Protokollfehler is an answer the logger gave but that is no value: a Modbus
// exception, a short or garbled frame. Msg is the codec's sentence.
type Protokollfehler struct{ Msg string }

func (e *Protokollfehler) Error() string { return e.Msg }

// Geschrieben is the last value written to a register and when (sv5_ctrl_last).
type Geschrieben struct {
	V int     `json:"v"`
	T float64 `json:"t"`
}

// Ablage is everything the plan node and the executor keep between ticks:
// the flow context ('memory' volatile, 'file' durable) and both node contexts.
type Ablage struct {
	// durable ('file')
	Snapshot Obj            // deye_ctrl_snapshot
	Pfad     map[string]Obj // deye_path:<ziel>
	Budget   map[string]any // deye_tou_budget:<ziel>
	// volatile ('memory')
	Faehigkeit    map[string]Obj // deye_cap:<ziel>
	Geraetekonfig map[string]Obj // deye_native_cfg:<ziel>
	// node contexts
	Letzte map[string]Geschrieben // the executor's sv5_ctrl_last
	Plan   PlanZustand
}

// NeueAblage is an empty store.
func NeueAblage() *Ablage {
	return &Ablage{Pfad: map[string]Obj{}, Budget: map[string]any{}, Faehigkeit: map[string]Obj{},
		Geraetekonfig: map[string]Obj{}, Letzte: map[string]Geschrieben{}}
}

// AusfuehrEingabe is one message to the executor: the plan node's output
// with the setpoint that triggered it.
type AusfuehrEingabe struct {
	Control            *Plan
	Setpoint           Obj
	NativeCapabilities *NativeLevers
	NativeRefusal      string
	Now                time.Time
}

// AusfuehrErgebnis is the outcome of one tick.
type AusfuehrErgebnis struct {
	// Payload is the executor's readback (nil = nothing published).
	Payload Obj
	// Dauerhaft says the durable part of the store changed.
	Dauerhaft bool
	// Warnungen are the operator-relevant log lines of the tick.
	Warnungen []string
}

const (
	capTTL   = 6 * 3600 * 1000 // ms: a definitive capability is re-checked every 6 h
	capRetry = 60 * 1000       // ms: a failed probe re-checks after 60 s
)

var definitivRegex = regexp.MustCompile(`(?i)Modbus-Ausnahme 0x0[123]\b`)

func samePtr(a, b Obj) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return reflect.ValueOf(a).UnsafePointer() == reflect.ValueOf(b).UnsafePointer()
}

func protokoll(err error) (string, bool) {
	var p *Protokollfehler
	if errors.As(err, &p) {
		return p.Msg, true
	}
	return "", false
}

// Ausfuehren runs one executor tick. verbinde opens the session once the tick
// needs the logger (it is the lane and the socket of the caller); an error
// there ends the tick without a payload, like a lost socket.
func Ausfuehren(ctx context.Context, in AusfuehrEingabe, a *Ablage, verbinde func(context.Context) (Spur, error)) AusfuehrErgebnis {
	var out AusfuehrErgebnis
	ctrl := in.Control
	if ctrl == nil || ctrl.Adapter != "solarman_v5" {
		return out
	}
	sp := in.Setpoint
	if sp == nil {
		sp = Obj{}
	}
	conn := ctrl.Connection
	host := str(get(conn, "ip"))
	cport := num(get(conn, "port"))
	if !truthy(get(conn, "port")) {
		cport = 8899
	}
	target := host + ":" + jsNumberString(cport)
	nowMs := float64(in.Now.UnixMilli())
	isRelease := ctrl.Mode == "release"
	snap := a.Snapshot
	stickyRec := a.Pfad[target]
	cachedCap := a.Faehigkeit[target]
	capTtl := float64(capTTL)
	switch {
	case cachedCap != nil && isFalse(get(cachedCap, "definitive")):
		capTtl = capRetry
	case stickyRec != nil && num(get(stickyRec, "contrary")) > 0:
		capTtl = 0
	}
	capFresh := cachedCap != nil && truthy(get(cachedCap, "at")) && nowMs-num(get(cachedCap, "at")) < capTtl
	probe := ctrl.CapabilityProbe
	probeDue := probe != nil && !capFresh

	toWrite := []WriteOp{}
	for _, w := range ctrl.Writes {
		prev, ok := a.Letzte[strconv.Itoa(w.Addr)]
		if !isRelease && !w.Always && ok {
			reassertMs := float64(w.ReassertS) * 1000
			due := reassertMs > 0 && nowMs-prev.T >= reassertMs
			if !due {
				if nowMs-prev.T < float64(w.DwellS)*1000 {
					continue
				}
				delta := w.Value&0xffff - prev.V&0xffff
				if delta < 0 {
					delta = -delta
				}
				threshold := 1
				if w.MinChange > 0 {
					threshold = w.MinChange
				}
				if delta < threshold {
					continue
				}
			}
		}
		toWrite = append(toWrite, w)
	}

	blockiert := func(extra Obj) Obj {
		p := Obj{"ts": isoMillis(in.Now), "family": ctrl.Family, "source": sourceOf(sp),
			"control_enabled": ctrl.ControlEnabled, "certified": ctrl.Certified, "control_path": ctrl.ControlPath,
			"blocked": true, "reason": ctrl.Reason, "registers": []any{}}
		if v := get(sp, "slot_start"); !isUndef(v) {
			p["slot_start"] = v
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	if len(ctrl.Readbacks) == 0 && !probeDue {
		if ctrl.Blocked {
			out.Warnungen = append(out.Warnungen, "Deye-Steuerung angehalten ("+target+"): "+orStr(ctrl.Reason, "Schreibplan zurueckgehalten"))
			out.Payload = blockiert(nil)
		}
		return out
	}
	isCal := get(sp, "source") == "calibration" || (ctrl.Calibration != nil && *ctrl.Calibration)
	var budget *TouBudget
	limit := TouBudgetLimit(get(sp, "persistent_write_budget"))
	if ctrl.ControlPath == DeyePathTou {
		b := TouBudgetToday(a.Budget[target], in.Now)
		budget = &b
	}
	if budget != nil && !isRelease && !isCal && len(toWrite) > 0 && !TouBudgetAdmits(*budget, limit) {
		held := TouBudgetHeld(*budget)
		a.Budget[target] = budgetObj(held)
		out.Dauerhaft = true
		why := TouBudgetReason(held, limit)
		out.Warnungen = append(out.Warnungen, "Deye-Zeitfenster-Steuerung ("+target+"): "+why)
		p := blockiert(Obj{"control_path": DeyePathTou, "reason": why, "tou_budget": reportObj(held.Report(limit)), "wrote": false})
		out.Payload = p
		return out
	}

	spur, err := verbinde(ctx)
	if err != nil {
		out.Warnungen = append(out.Warnungen, "Deye-Steuerung fehlgeschlagen ("+target+"): "+err.Error())
		return out
	}
	fatal := func(err error) AusfuehrErgebnis {
		out.Payload = nil
		out.Warnungen = append(out.Warnungen, "Deye-Steuerung fehlgeschlagen ("+target+"): "+err.Error())
		return out
	}
	var capability Obj
	if capFresh {
		capability = cachedCap
	}
	stickyNow := stickyRec
	if stickyNow == nil {
		stickyNow = DeyeSeedStickyFromGrant(sp, nowMs)
	}
	if probeDue {
		var dt *int
		var block []int
		probeErr := ""
		definitive := true
		for _, rd := range probe.Reads {
			regs, err := spur.Lies(ctx, rd.Addr, rd.Count)
			if err != nil {
				msg, ok := protokoll(err)
				if !ok {
					return fatal(err)
				}
				probeErr = msg
				definitive = definitivRegex.MatchString(msg)
				break
			}
			switch rd.Role {
			case "device_type":
				v := 0
				if len(regs) > 0 {
					v = regs[0] & 0xffff
				}
				dt = &v
			case "remote_block":
				block = regs
				if block == nil {
					block = []int{}
				}
			}
		}
		capability = ClassifyDeyeCapability(DeyeProbe{DeviceType: dt, RemoteBlock: block, Error: probeErr, Definitive: &definitive})
		capability["at"] = nowMs
		a.Faehigkeit[target] = capability
		next := DeyeUpdateSticky(stickyNow, capability, nowMs)
		stickyNow = next
		if stickyNow != nil && !samePtr(stickyNow, stickyRec) {
			a.Pfad[target] = stickyNow
			out.Dauerhaft = true
		}
	}
	remoteForced := remoteForcedOff(conn)
	decided := DeyeControlPath(capability)
	if p := stickyPath(stickyNow); p != "" {
		decided = p
	}
	if remoteForced {
		decided = DeyePathTou
	}
	if probe != nil && ctrl.ControlPath != "" && ctrl.ControlPath != decided {
		return out
	}
	if len(ctrl.Readbacks) == 0 {
		return out
	}
	snapshotCaptured, activeSlotConflict := false, false
	if !isRelease && snap == nil && ctrl.SnapshotPlan != nil && len(toWrite) > 0 {
		var addrs []int
		seen := map[int]bool{}
		for _, s := range ctrl.SnapshotPlan.Registers {
			if !seen[s.Addr] {
				seen[s.Addr] = true
				addrs = append(addrs, s.Addr)
			}
		}
		for _, x := range ctrl.SnapshotPlan.ProgramTimes {
			if !seen[x] {
				seen[x] = true
				addrs = append(addrs, x)
			}
		}
		val := map[int]int{}
		for _, x := range addrs {
			regs, err := spur.Lies(ctx, x, 1)
			if err != nil {
				return fatal(err)
			}
			v := 0
			if len(regs) > 0 {
				v = regs[0] & 0xffff
			}
			val[x] = v
		}
		regs := Obj{}
		for _, s := range ctrl.SnapshotPlan.Registers {
			regs[strconv.Itoa(s.Addr)] = float64(val[s.Addr])
		}
		times := make([]any, len(ctrl.SnapshotPlan.ProgramTimes))
		for i, x := range ctrl.SnapshotPlan.ProgramTimes {
			times[i] = float64(val[x])
		}
		fc := 16.0
		if toWrite[0].FC == 6 {
			fc = 6
		}
		snapConn := Obj{"ip": host, "port": cport, "mb_slave_id": slaveOf(conn), "control_write_fc": fc}
		if s := get(conn, "serial"); !isUndef(s) {
			snapConn["serial"] = s
		}
		snap = Obj{"family": ctrl.Family, "connection": snapConn, "regs": regs, "programTimes": times, "capturedAt": nowMs}
		a.Snapshot = snap
		out.Dauerhaft = true
		snapshotCaptured = true
		nowMin := float64(in.Now.Hour()*60 + in.Now.Minute())
		activeSlotConflict = DeyeProgram1Displaced(times, nowMin)
		if activeSlotConflict {
			out.Warnungen = append(out.Warnungen, "Deye-Steuerung N2 ("+target+"): ein spaeteres ToU-Programm ist aktiv - Programm 1 wird ignoriert. Startzeiten der Programme 2-6 pruefen (DEYE.md).")
		}
	}
	if !isRelease && ctrl.PowerScaleConfirmed != nil && !*ctrl.PowerScaleConfirmed {
		out.Warnungen = append(out.Warnungen, "Deye-Steuerung N1 ("+target+"): Leistungsskalierung HV/LV unbestaetigt - der Schreibplan wurde ZURUECKGEHALTEN.")
	}
	var preGridCharge *bool
	if len(ctrl.NativePreconditions) > 0 {
		ncfg := Obj{"at": nowMs, "now_min": float64(in.Now.Hour()*60 + in.Now.Minute())}
		g := ctrl.NativeGridChargeProof
		for _, pc := range ctrl.NativePreconditions {
			count := 1
			if pc.Count > 1 {
				count = pc.Count
			}
			regs, err := spur.Lies(ctx, pc.Addr, count)
			if err != nil {
				if _, ok := protokoll(err); !ok {
					return fatal(err)
				}
				continue
			}
			if count > 1 {
				if len(regs) >= count {
					vals := make([]any, count)
					for i := 0; i < count; i++ {
						vals[i] = float64(regs[i] & 0xffff)
					}
					ncfg[pc.Role] = vals
				}
				continue
			}
			if len(regs) > 0 {
				v := regs[0] & 0xffff
				ncfg[pc.Role] = float64(v)
				if g != nil && pc.Addr == g.Addr {
					b := float64(RegDistanceAbs(v, *g.Expect&0xffff)) <= tolOf(g)
					preGridCharge = &b
				}
			}
		}
		a.Geraetekonfig[target] = ncfg
	}
	for _, w := range toWrite {
		if err := spur.Schreibe(ctx, w.FC, w.Addr, w.Value); err != nil {
			return fatal(err)
		}
		a.Letzte[strconv.Itoa(w.Addr)] = Geschrieben{V: w.Value & 0xffff, T: nowMs}
	}
	type rueck struct {
		e      RueckEintrag
		addr   int
		decode map[string]any
	}
	var entries []rueck
	for _, rb := range ctrl.Readbacks {
		var actual *int
		errText := "Verbindung zum Logger geschlossen"
		for attempt := 0; attempt < 2; attempt++ {
			regs, err := spur.Lies(ctx, rb.Addr, 1)
			if err != nil {
				msg, ok := protokoll(err)
				if !ok {
					return fatal(err)
				}
				actual, errText = nil, msg
				continue
			}
			if len(regs) == 0 {
				actual, errText = nil, "Logger lieferte keinen Registerwert"
				continue
			}
			v := regs[0] & 0xffff
			actual, errText = &v, ""
			break
		}
		expect := 0
		if rb.Expect != nil {
			expect = *rb.Expect & 0xffff
		}
		entries = append(entries, rueck{e: RueckEintrag{Role: rb.Role, Expect: expect, Actual: actual, Tolerance: tolOf(&rb), Error: errText},
			addr: rb.Addr, decode: rb.Decode})
	}
	es := make([]RueckEintrag, len(entries))
	for i, e := range entries {
		es[i] = e.e
	}
	verdict := VerifyCycle(es)
	registers := make([]any, len(entries))
	for i, e := range entries {
		v := verdict.Registers[i]
		var actualRaw any
		if v.Verdict != VerdictUnread && e.e.Actual != nil {
			actualRaw = float64(*e.e.Actual)
		}
		r := Obj{"role": e.e.Role, "fc": 3.0, "addr": float64(e.addr), "commanded_raw": float64(e.e.Expect),
			"actual_raw": actualRaw, "match": v.Verdict == VerdictHeld, "verdict": v.Verdict}
		if v.Note != "" {
			r["note"] = v.Note
		}
		dsgn := 0.0
		if e.decode != nil && num(get(e.decode, "rated_kw")) > 0 {
			switch get(e.decode, "kind") {
			case "remote_power_permille":
				dsgn = -1
			case "grid_power_permille", "ac_power_permille":
				dsgn = 1
			}
		}
		if dsgn != 0 {
			rk := num(get(e.decode, "rated_kw"))
			kw := func(raw int) float64 {
				return round(float64(float64(float64(dsgn*float64(float64(s16(raw))/1000))*rk)*1000)) / 1000
			}
			r["commanded_kw"] = kw(e.e.Expect)
			if actualRaw != nil {
				r["actual_kw"] = kw(*e.e.Actual)
			}
		}
		registers[i] = r
		if v.Verdict == VerdictMismatch {
			delete(a.Letzte, strconv.Itoa(e.addr))
		}
	}
	var remoteStatus any
	for _, ob := range ctrl.Observations {
		regs, err := spur.Lies(ctx, ob.Addr, 1)
		if err != nil {
			if _, ok := protokoll(err); !ok {
				return fatal(err)
			}
			continue
		}
		if ob.Role == "remote_status" && len(regs) > 0 {
			remoteStatus = float64(regs[0] & 0xffff)
		}
	}
	all := verdict.AllMatch != nil && *verdict.AllMatch
	unconfirmed := verdict.AllMatch == nil
	if unconfirmed {
		out.Warnungen = append(out.Warnungen, "Deye-Steuerung ohne Rueckmeldung ("+target+"): "+verdict.Reason)
	}
	wrote := len(toWrite) > 0
	if budget != nil && wrote {
		b := TouBudgetCounted(*budget)
		budget = &b
		a.Budget[target] = budgetObj(b)
		out.Dauerhaft = true
	}
	relMode := ctrl.Mode == "release"
	if !relMode && wrote && all && len(registers) > 0 && ctrl.ControlPath == DeyePathRemote {
		old := a.Pfad[target]
		if old == nil || get(old, "path") != DeyePathRemote || !isTrue(get(old, "everRemote")) {
			var verdictRec any
			if old != nil && truthy(get(old, "verdict")) {
				verdictRec = get(old, "verdict")
			} else if capability != nil && !isFalse(get(capability, "definitive")) {
				verdictRec = capability
			}
			var verdictAt any
			if old != nil && truthy(get(old, "verdictAt")) {
				verdictAt = get(old, "verdictAt")
			}
			a.Pfad[target] = Obj{"path": DeyePathRemote, "since": nowMs, "contrary": 0.0, "everRemote": true,
				"verdict": verdictRec, "verdictAt": verdictAt, "provenBy": "landed_write"}
			out.Dauerhaft = true
		}
	}
	if relMode && all {
		a.Snapshot = nil
		out.Dauerhaft = true
	}
	nativeClaimed := !relMode && ctrl.Mode == "native" && all
	cycleMode := "normal"
	switch {
	case relMode:
		cycleMode = "release"
	case nativeClaimed:
		cycleMode = "native"
	case ctrl.Mode != "" && ctrl.Mode != "native":
		cycleMode = ctrl.Mode
	}
	var nativeBlock Obj
	if nativeClaimed && ctrl.GridChargeProof != nil {
		g := ctrl.GridChargeProof
		regs, err := spur.Lies(ctx, g.Addr, 1)
		if err != nil {
			if _, ok := protokoll(err); !ok {
				return fatal(err)
			}
		} else if len(regs) > 0 {
			nativeBlock = Obj{"grid_charge_blocked": float64(RegDistanceAbs(regs[0]&0xffff, *g.Expect&0xffff)) <= tolOf(g)}
		}
	}
	p := Obj{"ts": isoMillis(in.Now), "family": ctrl.Family, "source": sourceOf(sp),
		"control_enabled": ctrl.ControlEnabled, "certified": ctrl.Certified, "mode": cycleMode, "wrote": wrote,
		"skipped_dwell": float64(len(ctrl.Writes) - len(toWrite)), "snapshot_captured": snapshotCaptured,
		"active_slot_conflict":  activeSlotConflict,
		"power_scale_confirmed": ctrl.PowerScaleConfirmed == nil || *ctrl.PowerScaleConfirmed,
		"control_path":          ctrl.ControlPath, "remote_status_raw": remoteStatus,
		"verify": verdict.Cycle, "verify_reason": verdict.Reason, "registers": registers}
	if v := get(sp, "slot_start"); !isUndef(v) {
		p["slot_start"] = v
	}
	if nativeBlock != nil {
		p["native"] = nativeBlock
	}
	if budget != nil {
		p["tou_budget"] = reportObj(budget.Report(limit))
	}
	if nativeClaimed && ctrl.NativeIntent != nil && *ctrl.NativeIntent != "" {
		n := Obj{}
		for k, v := range nativeBlock {
			n[k] = v
		}
		n["intent"] = *ctrl.NativeIntent
		if ctrl.CurtailsOwnPv != nil && *ctrl.CurtailsOwnPv {
			n["curtails_own_pv"] = true
		}
		if ctrl.Candidate != "" {
			n["candidate"] = ctrl.Candidate
		}
		p["native"] = n
	}
	if !nativeClaimed && preGridCharge != nil {
		p["native_precondition"] = Obj{"grid_charge_blocked": *preGridCharge}
	}
	if c := in.NativeCapabilities; c != nil {
		p["native_capabilities"] = Obj{"intents": stringsAny(c.Intents), "window": c.Window, "persistent": c.Persistent}
	}
	if !nativeClaimed && in.NativeRefusal != "" {
		p["native_refusal"] = in.NativeRefusal
	}
	out.Payload = p
	return out
}

// RegDistanceAbs is the plain |a - b| the flow's native proof uses (not the
// ring distance of the hold check).
func RegDistanceAbs(a, b int) int {
	if a > b {
		return a - b
	}
	return b - a
}

func tolOf(r *ReadOp) float64 {
	if r.Tolerance == nil || math.IsNaN(*r.Tolerance) {
		return 0
	}
	return *r.Tolerance
}

func slaveOf(conn Obj) any {
	if v := get(conn, "mb_slave_id"); truthy(v) {
		return v
	}
	return 1.0
}

func sourceOf(sp Obj) any {
	if v := get(sp, "source"); truthy(v) {
		return v
	}
	return ""
}

func orStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func stringsAny(s []string) []any {
	out := make([]any, len(s))
	for i, x := range s {
		out[i] = x
	}
	return out
}

func budgetObj(b TouBudget) Obj {
	return Obj{"day": b.Day, "changes": float64(b.Changes), "held": b.Held}
}

func reportObj(r TouBudgetReport) Obj {
	return Obj{"day": r.Day, "changes": float64(r.Changes), "limit": float64(r.Limit), "held": r.Held}
}

// isoMillis is JavaScript's Date.toISOString().
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
