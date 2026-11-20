package messwerte

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// The JSON points (go-e /api/status, Shelly RPC and REST, Fronius Solar API,
// KACO) are decoded from the device's answer the way the JS driver sees it
// after JSON.parse: an object keeps its keys in Object.keys order (integer
// keys ascending first, then the rest in order of appearance), and an object
// value is passed on as its JSON.stringify text. Objekt is that view.

// Objekt is a parsed JSON object with JavaScript key order.
type Objekt struct {
	keys []string
	vals map[string]any
}

// Get is o[key] for an own key.
func (o *Objekt) Get(key string) (any, bool) {
	v, ok := o.vals[key]
	return v, ok
}

// Keys is Object.keys(o).
func (o *Objekt) Keys() []string { return o.keys }

// arrayIndex reports whether key is a canonical array index ("0", "17", not
// "01" or "-1") - the keys JavaScript orders first, ascending.
func arrayIndex(key string) (uint32, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 32)
	if err != nil || n == 4294967295 {
		return 0, false
	}
	return uint32(n), true
}

func (o *Objekt) set(key string, v any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v // a repeated key: the last value, at the first position
}

func (o *Objekt) ordne() {
	var idx, rest []string
	for _, k := range o.keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := arrayIndex(idx[i])
		b, _ := arrayIndex(idx[j])
		return a < b
	})
	o.keys = append(idx, rest...)
}

// ParseJSON is JSON.parse: numbers as float64, objects as *Objekt.
func ParseJSON(b []byte) (any, error) { return parse(b, false) }

// ParseGeraeteJSON is how the Docker box parses a device's answer
// (vp-palette/lib/lossless-json.js): like JSON.parse, but an integer token
// outside Number's exact range stays its decimal text - a uint64 energy
// counter is never rounded into a plausible wrong value.
func ParseGeraeteJSON(b []byte) (any, error) { return parse(b, true) }

var ganzzahlRe = regexp.MustCompile(`^-?(?:0|[1-9]\d*)$`)

func parse(b []byte, lossless bool) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := parseWert(dec, lossless)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("messwerte: Daten nach dem JSON-Wert")
	}
	return v, nil
}

func parseWert(dec *json.Decoder, lossless bool) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := &Objekt{vals: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := parseWert(dec, lossless)
				if err != nil {
					return nil, err
				}
				o.set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			o.ordne()
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseWert(dec, lossless)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("messwerte: unerwartetes %v", x)
	case json.Number:
		if lossless && ganzzahlRe.MatchString(string(x)) {
			if i, ok := new(big.Int).SetString(string(x), 10); ok && (i.Cmp(maxSafe) > 0 || i.Cmp(minSafe) < 0) {
				return string(x), nil
			}
		}
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil {
			// A literal beyond float64 is Infinity in JavaScript.
			var ne *strconv.NumError
			if errors.As(err, &ne) && errors.Is(ne.Err, strconv.ErrRange) {
				return f, nil
			}
			return nil, err
		}
		return f, nil
	}
	return t, nil // string, bool, nil
}

var (
	maxSafe = big.NewInt(9007199254740991)
	minSafe = big.NewInt(-9007199254740991)
)

// Stringify is JSON.stringify for parsed values.
func Stringify(v any) string {
	var b strings.Builder
	stringify(&b, v)
	return b.String()
}

func stringify(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		if x != x || x > 1.7976931348623157e308 || x < -1.7976931348623157e308 {
			b.WriteString("null")
		} else {
			b.WriteString(jsNumberString(x))
		}
	case string:
		jsQuote(b, x)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			stringify(b, e)
		}
		b.WriteByte(']')
	case *Objekt:
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			jsQuote(b, k)
			b.WriteByte(':')
			stringify(b, x.vals[k])
		}
		b.WriteByte('}')
	}
}

// jsQuote is JSON.stringify of a string: ", \ and the control characters
// escaped, nothing else (no HTML escaping).
func jsQuote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// --- the JSON decode of the driver -----------------------------------------

var (
	indexRe      = regexp.MustCompile(`\[(\d+)]`)
	tokenIndexRe = regexp.MustCompile(`\[(\d+|\*)]`)
	pfadTrennRe  = regexp.MustCompile(`[./]`)
	idSternRe    = regexp.MustCompile(`\?id=\*`)
)

type treffer struct {
	value    any
	present  bool
	captures []string
}

// eigenschaft is value[token] for a parsed value: an own key of an object,
// an index or length of an array or a string; anything else is undefined.
func eigenschaft(v any, token string) (any, bool) {
	switch x := v.(type) {
	case *Objekt:
		return x.Get(token)
	case []any:
		if token == "length" {
			return float64(len(x)), true
		}
		if i, ok := arrayIndex(token); ok && int(i) < len(x) {
			return x[i], true
		}
	case string:
		units := utf16.Encode([]rune(x))
		if token == "length" {
			return float64(len(units)), true
		}
		if i, ok := arrayIndex(token); ok && int(i) < len(units) {
			return string(utf16.Decode(units[i : i+1])), true
		}
	}
	return nil, false
}

// expandPath walks selector tokens; a `*` fans out over Object.keys.
func expandPath(root any, selector string) []treffer {
	s := selector
	if strings.HasPrefix(s, "$") {
		s = strings.TrimPrefix(s[1:], ".") // /^\$\.?/
	}
	s = tokenIndexRe.ReplaceAllString(s, ".$1")
	var tokens []string
	for _, t := range pfadTrennRe.Split(s, -1) {
		if t != "" {
			tokens = append(tokens, t)
		}
	}
	var out []treffer
	var walk func(v any, present bool, at int, captures []string)
	walk = func(v any, present bool, at int, captures []string) {
		if at == len(tokens) {
			out = append(out, treffer{value: v, present: present, captures: captures})
			return
		}
		t := tokens[at]
		if t == "*" {
			switch x := v.(type) {
			case *Objekt:
				for _, k := range x.keys {
					walk(x.vals[k], true, at+1, append(append([]string(nil), captures...), k))
				}
			case []any:
				for i, e := range x {
					walk(e, true, at+1, append(append([]string(nil), captures...), strconv.Itoa(i)))
				}
			}
			return // a string or number does not fan out (typeof !== 'object')
		}
		if !present || v == nil {
			return
		}
		next, ok := eigenschaft(v, t)
		walk(next, ok, at+1, captures)
	}
	walk(root, true, 0, nil)
	return out
}

// concreteKey fills the template's [*] and .* with the captures, left to
// right; a template without captures takes 0.
func concreteKey(template string, captures []string) string {
	if !strings.Contains(template, "*") {
		return template
	}
	values := captures
	if len(values) == 0 {
		values = []string{"0"}
	}
	i := 0
	next := func() string {
		v := values[min(i, len(values)-1)]
		i++
		return v
	}
	out := strings.ReplaceAll(template, "[*]", "\x00")
	var b strings.Builder
	for _, r := range out {
		if r == 0 {
			b.WriteString("[" + next() + "]")
		} else {
			b.WriteRune(r)
		}
	}
	s := b.String()
	// .* followed by . or the end (the JS lookbehind/lookahead).
	var c strings.Builder
	for j := 0; j < len(s); j++ {
		if s[j] == '*' && j > 0 && s[j-1] == '.' && (j+1 == len(s) || s[j+1] == '.') {
			c.WriteString(next())
			continue
		}
		c.WriteByte(s[j])
	}
	return c.String()
}

// scalarSample is one value: a scalar raw and (scaled) decoded; an object or
// array raw only, as its JSON text. Absent, null or non-finite: no sample.
func scalarSample(p *Punkt, key string, v any, present bool) *Sample {
	if !present || v == nil {
		return nil
	}
	switch x := v.(type) {
	case float64:
		if x != x || x > 1.7976931348623157e308 || x < -1.7976931348623157e308 {
			return nil
		}
		d := x
		if p.Scale != nil && p.Scale.Kind == "factor" {
			d = x * jsNumber(p.Scale.Value)
		} else if p.Scale != nil && p.Scale.Kind == "divisor" {
			d = x / jsNumber(p.Scale.Value)
		}
		if d != d || d > 1.7976931348623157e308 || d < -1.7976931348623157e308 {
			return nil
		}
		return &Sample{PointKey: key, Raw: x, Decoded: d, HatDecoded: true, Quality: "good"}
	case string, bool:
		return &Sample{PointKey: key, Raw: x, Decoded: x, HatDecoded: true, Quality: "good"}
	case *Objekt, []any:
		return &Sample{PointKey: key, Raw: Stringify(x), Quality: "good"}
	}
	return nil
}

// DecodeJSONSamples is decodeJSONSamples(): every value the point's selector
// reaches in one parsed answer, the point key made concrete from the indices
// it came from (a Shelly component's id first).
func DecodeJSONSamples(p *Punkt, payload any) []Sample {
	selector := p.Selector
	if strings.Contains(selector, "?filter=") {
		selector = strings.SplitN(selector, "?filter=", 3)[1]
	} else if strings.Contains(selector, "#") {
		selector = strings.SplitN(selector, "#", 3)[1]
	}
	for _, m := range indexRe.FindAllStringSubmatch(p.PointKey, -1) {
		selector = strings.Replace(selector, "[*]", "["+m[1]+"]", 1)
	}
	var prefix []string
	if idSternRe.MatchString(p.Selector) {
		if o, ok := payload.(*Objekt); ok {
			if id, ok := o.vals["id"].(float64); ok && id == float64(int64(id)) {
				prefix = append(prefix, jsNumberString(id))
			}
		}
	}
	var out []Sample
	for _, t := range expandPath(payload, selector) {
		if s := scalarSample(p, concreteKey(p.PointKey, append(append([]string(nil), prefix...), t.captures...)), t.value, t.present); s != nil {
			out = append(out, *s)
		}
	}
	return out
}
