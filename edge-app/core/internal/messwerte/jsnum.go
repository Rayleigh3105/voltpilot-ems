package messwerte

import (
	"math"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/jsnum"
)

// The few JavaScript semantics the JS runtime leans on, for values decoded
// from JSON (float64, string, bool, nil, []any, map[string]any). nil stands
// for both null and undefined; where the two differ the callers check
// presence themselves.

// jsNumber is Number(v).
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		return jsStringToNumber(x)
	case []any:
		// Number([]) is 0, Number([x]) is Number(String(x)), more is NaN.
		switch len(x) {
		case 0:
			return 0
		case 1:
			return jsStringToNumber(jsString(x[0]))
		}
	}
	return math.NaN()
}

// jsStringToNumber is ToNumber of a string.
func jsStringToNumber(s string) float64 { return jsnum.StringToNumber(s) }

// jsString is String(v) for scalars.
func jsString(v any) string {
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
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// jsNumberString is Number.prototype.toString(): shortest round-trip digits,
// exponent form below 1e-6 and from 1e21 on.
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
		return mant + "e" + exp[:1] + strings.TrimLeft(exp[1:], "0")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsTruthy is Boolean(v).
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// jsStrictEqual is f === v for a number f.
func jsStrictEqual(f float64, v any) bool {
	g, ok := v.(float64)
	return ok && f == g
}

// jsStrictEqual2 is a === b for scalars.
func jsStrictEqual2(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

// jsLess is a < b (the abstract relational comparison for scalars and arrays).
func jsLess(a, b any) bool {
	as, aStr := jsPrimitive(a).(string)
	bs, bStr := jsPrimitive(b).(string)
	if aStr && bStr {
		return as < bs
	}
	x, y := jsNumber(jsPrimitive(a)), jsNumber(jsPrimitive(b))
	return x < y // NaN compares false
}

// jsGreater is a > b.
func jsGreater(a, b any) bool { return jsLess(b, a) }

// jsPrimitive is ToPrimitive: an array becomes its String.
func jsPrimitive(v any) any {
	if arr, ok := v.([]any); ok {
		return jsString(arr)
	}
	return v
}

// jsToInt32 is ToInt32 (the operand conversion of the bit operators).
func jsToInt32(f float64) int32 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	t := math.Trunc(f)
	m := math.Mod(t, 4294967296)
	if m < 0 {
		m += 4294967296
	}
	return int32(uint32(m))
}
