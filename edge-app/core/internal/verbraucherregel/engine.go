// Package verbraucherregel is Edge Light's Go twin of the generated reactive
// consumer-rule node of the Docker box (Node-RED vp-consumer-policy,
// Verbrauchssteuerung Inkrement 4, contract decision D-19).
//
// The cloud compiles ONE consumer policy with a local signal into a flow
// artifact (ConsumerPolicyCompiler + flowc). On the Docker box the palette
// runs it (lib/reactive-eval.js + lib/consumer-policy-runtime.js); on Edge
// Light, which has no Node-RED, this package runs the SAME artifact behind the
// SAME local-bus topics: edge/telemetry and edge/entities/<id>/telemetry in,
// edge/entities/<id>/desired out. The core's arbitration, guards, override cap
// and cycle guard decide what reaches the device - exactly as on the Docker
// box. Both are held to docs/contracts/v2/verbraucherregel-vectors.json.
//
// This file is the pure engine (reactive-eval.js): Kleene three-state logic
// (unknown never starts a consumer), per-signal freshness, hysteresis via
// reset_value, precompiled UTC windows (after the last one = unknown), the
// off-delay that only ever delays an ENDING, and the merge of active
// requirements into one target. Spec values are decoded JSON (any) and read
// with JavaScript's rules, so a value the reference would accept or refuse is
// accepted or refused here too.
package verbraucherregel

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// Three-state verdicts.
const (
	True    = "true"
	False   = "false"
	Unknown = "unknown"
)

func kleeneNot(v string) string {
	switch v {
	case True:
		return False
	case False:
		return True
	}
	return Unknown
}

func kleeneAll(list []string) string {
	unknown := false
	for _, v := range list {
		if v == False {
			return False
		}
		if v == Unknown {
			unknown = true
		}
	}
	if unknown {
		return Unknown
	}
	return True
}

func kleeneAny(list []string) string {
	unknown := false
	for _, v := range list {
		if v == True {
			return True
		}
		if v == Unknown {
			unknown = true
		}
	}
	if unknown {
		return Unknown
	}
	return False
}

func compare(op string, v, threshold float64) bool {
	switch op {
	case "lt":
		return v < threshold
	case "lte":
		return v <= threshold
	case "gt":
		return v > threshold
	case "gte":
		return v >= threshold
	case "eq":
		return v == threshold
	case "ne":
		return v != threshold
	}
	return false
}

// numeric is the reference's numeric(): booleans ride telemetry as 0/1, a
// finite number is itself, everything else is no number.
func numeric(v any) (float64, bool) {
	switch x := v.(type) {
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	}
	return 0, false
}

// jsNumber is JavaScript's Number(v) for a decoded JSON value; present=false
// is `undefined` (NaN).
func jsNumber(v any, present bool) float64 {
	if !present {
		return math.NaN()
	}
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
		return math.NaN()
	}
	return math.NaN()
}

// jsString is JavaScript's String(v) for the values a spec can carry.
func jsString(v any, present bool) string {
	if !present {
		return "undefined"
	}
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(x)
	}
	return "[object Object]"
}

// jsNumberString is Number.prototype.toString() (shortest round-trip digits,
// exponent form below 1e-6 and from 1e21 on).
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go writes e+21 / e-07; JavaScript writes e+21 / e-7.
		mant, exp, _ := strings.Cut(s, "e")
		sign := exp[:1]
		digits := strings.TrimLeft(exp[1:], "0")
		return mant + "e" + sign + digits
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// parseISO is Date.parse for the ISO-8601 instants the compiler writes, in ms.
func parseISO(v any) (int64, bool) {
	s, ok := v.(string)
	if !ok {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// evalWindows evaluates the precompiled window list at nowMs: chronological
// [from, to) pairs; after the LAST window the cloud's answer has run out and
// the condition is unknown (never "false and safe to invert", §13.5).
func evalWindows(windows any, nowMs int64) string {
	list, ok := windows.([]any)
	if !ok || len(list) == 0 {
		return Unknown
	}
	lastEnd := int64(math.MinInt64)
	for _, w := range list {
		pair, ok := w.([]any)
		if !ok || len(pair) < 2 {
			return Unknown
		}
		from, ok1 := parseISO(pair[0])
		to, ok2 := parseISO(pair[1])
		if !ok1 || !ok2 {
			return Unknown
		}
		if nowMs >= from && nowMs < to {
			return True
		}
		if to > lastEnd {
			lastEnd = to
		}
	}
	if nowMs >= lastEnd {
		return Unknown
	}
	return False
}

// sample is one received signal value with its receive time.
type sample struct {
	value any
	atMs  int64
}

// sticky is a leaf's hysteresis memory: set=false is `undefined`.
type sticky struct {
	set bool
	on  bool
}

// evalLeaf evaluates one local signal leaf (reactive-eval.js evalLeaf).
func evalLeaf(leaf map[string]any, s *sample, prev sticky, nowMs int64) (string, sticky) {
	if s == nil {
		return Unknown, prev
	}
	maxRaw, has := leaf["max_age_s"]
	maxAge := jsNumber(maxRaw, has)
	if !(maxAge >= 1) || float64(nowMs-s.atMs) > maxAge*1000 {
		// Stale: unknown, and the hysteresis memory is DROPPED - a signal
		// that went dark must re-prove its state.
		return Unknown, sticky{}
	}
	v, okV := numeric(s.value)
	threshold, okT := numeric(leaf["value"])
	if !okV || !okT {
		return Unknown, prev
	}
	op, _ := leaf["op"].(string)
	resetRaw, hasReset := leaf["reset_value"]
	reset, okR := numeric(resetRaw)
	if !okR || !hasReset || (op != "lt" && op != "lte" && op != "gt" && op != "gte") {
		if compare(op, v, threshold) {
			return True, sticky{}
		}
		return False, sticky{}
	}
	engaged := compare(op, v, threshold)
	var released bool
	if op == "gt" || op == "gte" {
		released = v < reset
	} else {
		released = v > reset
	}
	var on bool
	switch {
	case engaged:
		on = true
	case released:
		on = false
	default:
		on = prev.set && prev.on
	}
	if on {
		return True, sticky{set: true, on: true}
	}
	return False, sticky{set: true, on: false}
}

// Spec is the vp.consumer.reactive parameter object.
type Spec struct {
	Command      string
	OffDelayS    float64
	Requirements []any
}

// Result is one evaluation (the reference's {active, held, anyUnknown,
// mustRun, value, requirementIds}). Value is nil for `undefined`.
type Result struct {
	Active         bool
	Held           bool
	AnyUnknown     bool
	MustRun        bool
	Value          any
	HasValue       bool
	RequirementIDs []any
}

type target struct {
	mustRun  bool
	value    any
	hasValue bool
	ids      []any
}

// Engine is the stateful evaluator of one generated rule.
type Engine struct {
	spec      Spec
	signals   map[string]sample
	sticky    map[string]sticky
	held      *target
	heldSince *int64
}

// NewEngine builds an engine for spec.
func NewEngine(spec Spec) *Engine {
	return &Engine{spec: spec, signals: map[string]sample{}, sticky: map[string]sticky{}}
}

// UpdateSignal records a received signal value.
func (e *Engine) UpdateSignal(source, channel string, value any, atMs int64) {
	e.signals[source+":"+channel] = sample{value: value, atMs: atMs}
}

func (e *Engine) evalTree(condRaw any, keyPrefix string, nowMs int64) string {
	cond, ok := condRaw.(map[string]any)
	if !ok {
		return Unknown
	}
	if list, ok := cond["all"].([]any); ok {
		out := make([]string, len(list))
		for i, c := range list {
			out[i] = e.evalTree(c, keyPrefix+".all"+strconv.Itoa(i), nowMs)
		}
		return kleeneAll(out)
	}
	if list, ok := cond["any"].([]any); ok {
		out := make([]string, len(list))
		for i, c := range list {
			out[i] = e.evalTree(c, keyPrefix+".any"+strconv.Itoa(i), nowMs)
		}
		return kleeneAny(out)
	}
	if not, ok := cond["not"]; ok {
		return kleeneNot(e.evalTree(not, keyPrefix+".not", nowMs))
	}
	if windows, ok := cond["windows"]; ok {
		return evalWindows(windows, nowMs)
	}
	if _, ok := cond["signal"].(string); ok {
		src, hasSrc := cond["source"]
		ch, hasCh := cond["channel"]
		key := jsString(src, hasSrc) + ":" + jsString(ch, hasCh)
		var s *sample
		if got, ok := e.signals[key]; ok {
			s = &got
		}
		state, next := evalLeaf(cond, s, e.sticky[keyPrefix], nowMs)
		e.sticky[keyPrefix] = next
		return state
	}
	return Unknown
}

// Evaluate evaluates every requirement at nowMs.
func (e *Engine) Evaluate(nowMs int64) Result {
	var active []map[string]any
	anyUnknown := false
	for _, raw := range e.spec.Requirements {
		req, _ := raw.(map[string]any)
		cond, _ := req["condition"]
		id, hasID := req["id"]
		state := e.evalTree(cond, jsString(id, hasID), nowMs)
		if state == True {
			active = append(active, req)
		} else if state == Unknown {
			anyUnknown = true
		}
	}
	if len(active) > 0 {
		t := &target{}
		for _, r := range active {
			if b, ok := r["must_run"].(bool); ok && b {
				t.mustRun = true
			}
			t.ids = append(t.ids, r["id"])
		}
		t.value, t.hasValue = e.mergeValue(active)
		e.held = t
		e.heldSince = nil
		return Result{Active: true, AnyUnknown: anyUnknown, MustRun: t.mustRun,
			Value: t.value, HasValue: t.hasValue, RequirementIDs: t.ids}
	}
	offDelay := e.spec.OffDelayS
	if math.IsNaN(offDelay) || offDelay < 0 {
		offDelay = 0
	}
	offDelayMs := offDelay * 1000
	if e.held != nil && offDelayMs > 0 {
		if e.heldSince == nil {
			at := nowMs
			e.heldSince = &at
		}
		if float64(nowMs-*e.heldSince) < offDelayMs {
			h := e.held
			return Result{Active: true, Held: true, AnyUnknown: anyUnknown, MustRun: h.mustRun,
				Value: h.value, HasValue: h.hasValue, RequirementIDs: h.ids}
		}
	}
	e.held = nil
	e.heldSince = nil
	return Result{AnyUnknown: anyUnknown}
}

// mergeValue merges the active requirements into ONE target (§7).
func (e *Engine) mergeValue(active []map[string]any) (any, bool) {
	switch e.spec.Command {
	case "on_off":
		return true, true
	case "setpoint_kw":
		var max *float64
		for _, r := range active {
			if v, ok := numeric(r["value"]); ok && (max == nil || v > *max) {
				vv := v
				max = &vv
			}
		}
		if max == nil {
			return nil, true // null
		}
		return *max, true
	}
	// mode (and anything else): document order decides.
	v, ok := active[0]["value"]
	return v, ok
}
