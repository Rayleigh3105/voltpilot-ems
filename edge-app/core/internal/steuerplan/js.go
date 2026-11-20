package steuerplan

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/jsnum"
)

// Obj is a decoded JSON object as the Node-RED nodes see it: the selection on
// edge/inverter/config, the setpoint on edge/setpoint, the flow-context
// records. The planners read it with JavaScript semantics (absent is not
// null, Number("6") is 6), because that is what decides on the Docker box.
type Obj = map[string]any

// undef is JavaScript's undefined: a field that is ABSENT, as opposed to one
// that is present with null.
type undef struct{}

// get is obj.key: undef when the object or the key is absent.
func get(o Obj, key string) any {
	if o == nil {
		return undef{}
	}
	v, ok := o[key]
	if !ok {
		return undef{}
	}
	return v
}

// jsv turns undefined into null for a value stored in a JSON record (where
// both read as "not there").
func jsv(v any) any {
	if _, ok := v.(undef); ok {
		return nil
	}
	return v
}

// obj is `(v && typeof v === 'object') ? v : null` for a plain object.
func obj(v any) Obj {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return nil
}

// num is JavaScript's Number(v).
func num(v any) float64 {
	switch x := v.(type) {
	case undef:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case json.Number:
		return jsnum.StringToNumber(string(x))
	case string:
		return jsnum.StringToNumber(x)
	case []any:
		switch len(x) {
		case 0:
			return 0
		case 1:
			if s, ok := x[0].(string); ok {
				return jsnum.StringToNumber(s)
			}
			return num(x[0])
		}
	}
	return math.NaN()
}

// isNum is `typeof v === 'number'`.
func isNum(v any) bool {
	switch v.(type) {
	case float64, int:
		return true
	}
	return false
}

// isFiniteNum is `typeof v === 'number' && isFinite(v)`.
func isFiniteNum(v any) bool {
	if !isNum(v) {
		return false
	}
	f := num(v)
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// finite is isFinite(f) for a number already converted.
func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// isTrue is `v === true`.
func isTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// isFalse is `v === false`.
func isFalse(v any) bool {
	b, ok := v.(bool)
	return ok && !b
}

// str is `typeof v === 'string' ? v : ”`.
func str(v any) string {
	s, _ := v.(string)
	return s
}

// isStr is `typeof v === 'string'`.
func isStr(v any) bool {
	_, ok := v.(string)
	return ok
}

// trimmed is `typeof v === 'string' ? v.trim() : ”`.
func trimmed(v any) string { return jsnum.Trim(str(v)) }

// round is Math.round: the nearest integer, halves up (towards +Infinity).
func round(f float64) float64 {
	if !finite(f) {
		return f
	}
	r := math.Floor(f)
	if f-r >= 0.5 {
		r++
	}
	return r
}

// toInt32 is the ToInt32 conversion of the bit operators.
func toInt32(f float64) int32 {
	if !finite(f) || f == 0 {
		return 0
	}
	t := math.Trunc(f)
	m := math.Mod(t, 4294967296)
	if m < 0 {
		m += 4294967296
	}
	return int32(uint32(m))
}

// u16 is `v & 0xffff` on a number.
func u16(f float64) int { return int(toInt32(f) & 0xffff) }

// clampPct is Math.max(0, Math.min(100, Math.round(v))).
func clampPct(v float64) float64 { return math.Max(0, math.Min(100, round(v))) }

// jsNumberString is String(f) for the numbers these modules print (integers
// and short decimals), JavaScript's shortest round-trip form.
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
		mant, exp, _ := strings.Cut(s, "e")
		if exp[0] == '+' {
			return mant + "e+" + strings.TrimLeft(exp[1:], "0")
		}
		return mant + "e-" + strings.TrimLeft(exp[1:], "0")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func itoa(i int) string { return strconv.Itoa(i) }

// clone copies a decoded JSON value deeply (the JS `{ ...w }` and
// `Object.assign({}, r)` copies the planners hand out).
func clone(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = clone(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = clone(e)
		}
		return out
	}
	return v
}
