package flowdeploy

// RFC 8785 (JCS) JSON canonicalization - the integrity basis of the flow
// artifact contract: content_hash = sha256 over the canonical serialization
// of the bundle object (flow-artifact.md §1). The COMPILER (JS,
// edge-app/nodered/flowc/canonicalize.js) and this Go consumer MUST produce
// byte-identical output; the shared vector file
// edge-app/nodered/flowc/jcs-vectors.json is pinned by BOTH test suites (the
// refCheckChar lockstep precedent).

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonicalize returns the RFC 8785 canonical form of a JSON document.
func Canonicalize(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("jcs: %w", err)
	}
	// Refuse trailing garbage (a concatenated second document would silently
	// change the hash basis).
	if dec.More() {
		return nil, fmt.Errorf("jcs: trailing data after JSON document")
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ContentHash returns the contract's "sha256:<hex>" over the canonical form.
func ContentHash(raw []byte) (string, error) {
	c, err := Canonicalize(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		writeString(buf, t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return fmt.Errorf("jcs: number %q: %w", t, err)
		}
		s, err := es6Number(f)
		if err != nil {
			return err
		}
		buf.WriteString(s)
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		// RFC 8785 §3.2.3: sort keys by their UTF-16 code units.
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, k)
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("jcs: unsupported value %T", v)
	}
	return nil
}

// utf16Less compares two strings by their UTF-16 code units (the JS default
// string order - supplementary characters encode as surrogate pairs).
func utf16Less(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// writeString emits a JSON string with the RFC 8785 escape set (the
// JSON.stringify escapes: \" \\ , \b \t \n \f \r, other control chars as
// lowercase \u00xx, everything else literal UTF-8).
func writeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\t':
			buf.WriteString(`\t`)
		case '\n':
			buf.WriteString(`\n`)
		case '\f':
			buf.WriteString(`\f`)
		case '\r':
			buf.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else if r == utf8.RuneError {
				// Invalid UTF-8 input byte: JSON cannot carry it faithfully;
				// emit the replacement char (matches Go's json behavior).
				buf.WriteRune(r)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
}

// es6Number renders a float64 exactly like ES6 Number::toString (the RFC 8785
// number rule): shortest round-trip digits, decimal notation for exponents
// -7 < n <= 21, exponential otherwise.
func es6Number(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", fmt.Errorf("jcs: non-finite number")
	}
	if f == 0 {
		return "0", nil // incl. -0 (ES6: (-0).toString() == "0")
	}
	neg := math.Signbit(f)
	if neg {
		f = -f
	}
	// Shortest round-trip digits + decimal exponent.
	mant := strconv.FormatFloat(f, 'e', -1, 64) // "d[.ddd]e±XX"
	eIdx := strings.IndexByte(mant, 'e')
	exp10, _ := strconv.Atoi(mant[eIdx+1:])
	digits := strings.Replace(mant[:eIdx], ".", "", 1)
	k := len(digits)
	n := exp10 + 1 // value = 0.digits * 10^n

	var out string
	switch {
	case n >= 1 && n <= 21 && k <= n:
		out = digits + strings.Repeat("0", n-k)
	case n >= 1 && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case n <= 0 && n > -6:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		mantissa := digits[:1]
		if k > 1 {
			mantissa += "." + digits[1:]
		}
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		out = mantissa + "e" + sign + strconv.Itoa(e)
	}
	if neg {
		out = "-" + out
	}
	return out, nil
}
