// Package jsnum holds the JavaScript number semantics the Go twins of
// Node-RED modules share: ToNumber of a string (Number(v.trim())) and
// JSON.parse, whose numbers beyond float64 are ±Infinity instead of an error.
package jsnum

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// jsWhitespace is what String.prototype.trim and ToNumber strip: WhiteSpace
// (incl. U+FEFF and the Unicode space separators) and LineTerminator.
const jsWhitespace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.Trim(s, jsWhitespace) }

// StringToNumber is ToNumber of a string: trimmed, "" is 0, decimal or
// 0x/0o/0b integers, [+-]Infinity; anything else NaN.
func StringToNumber(s string) float64 {
	t := Trim(s)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			return integer(t[2:], base)
		}
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	for _, c := range t {
		if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// integer is a 0x/0o/0b literal's digits; beyond 64 bits JS still yields the
// (rounded) number, never NaN.
func integer(digits string, base int) float64 {
	if digits == "" {
		return math.NaN()
	}
	v := 0.0
	for _, c := range digits {
		d := strings.IndexRune("0123456789abcdefABCDEF", c)
		if d >= 16 {
			d -= 6
		}
		if d < 0 || d >= base {
			return math.NaN()
		}
		v = v*float64(base) + float64(d)
	}
	return v
}

// ParseJSON is JSON.parse: one JSON value (surrounding whitespace allowed),
// numbers as float64, a number beyond float64 as ±Infinity.
func ParseJSON(body []byte) (any, bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err == nil {
		return nil, false // trailing data: JSON.parse refuses
	}
	return numbers(v), true
}

func numbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil && !math.IsInf(f, 0) {
			return math.NaN()
		}
		return f
	case map[string]any:
		for k, e := range x {
			x[k] = numbers(e)
		}
	case []any:
		for i, e := range x {
			x[i] = numbers(e)
		}
	}
	return v
}
