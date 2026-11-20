package messwerte

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Sample is one decoded value as edge/measurements/samples carries it. Raw is
// what the wire said (a word, a hex string, an address=word list, a JSON
// scalar); Decoded is present only when the decode is evidenced.
type Sample struct {
	PointKey      string `json:"point_key"`
	Raw           any    `json:"raw"`
	Decoded       any    `json:"decoded,omitempty"`
	HatDecoded    bool   `json:"-"`
	Quality       string `json:"quality"`
	InvalidateAll bool   `json:"invalidate_all,omitempty"`
	EntityID      string `json:"entity_id,omitempty"`
	// SignedData of an OCPP value in format SignedData (the raw signature).
	SignedData       string `json:"signed_data,omitempty"`
	SignedDataFormat string `json:"signed_data_format,omitempty"`
}

// DecodeOptionen are the facts a decode reads besides the words: the
// configured or detected byte order, the variant register, and the decoder
// state the runtime keeps across reads (decoded values by source key for
// lookups, previous values for the deviation check).
type DecodeOptionen struct {
	ByteOrder      string
	ByteOrderWord  *uint16
	VariantWord    *uint16
	PreviousValues map[string]any
	DecodedValues  map[string]any
}

// wordsRaw is the raw of contiguous words: one word as its number, more as
// one hex string.
func wordsRaw(words []uint16) any {
	if len(words) == 1 {
		return float64(words[0])
	}
	var b strings.Builder
	for _, w := range words {
		fmt.Fprintf(&b, "%04x", w)
	}
	return b.String()
}

// DecodeRegisters is decodeRegisters(): decode once at the edge. nil = no
// sample (wrong word count, or the catalog's one "invalid" value of the type).
// An unknown or conditional scale omits decoded; a value the type cannot
// represent is quality invalid. err mirrors a throw of the JS module.
func DecodeRegisters(p *Punkt, words []uint16, addresses []int, o DecodeOptionen) (*Sample, error) {
	if p.Address == nil || p.Address.WidthWords == 0 || len(words) != p.Address.WidthWords {
		return nil, nil
	}
	contiguous := len(addresses) < 2
	if !contiguous {
		contiguous = true
		for i := 1; i < len(addresses); i++ {
			if addresses[i] != addresses[i-1]+1 {
				contiguous = false
				break
			}
		}
	}
	var raw any
	if contiguous {
		raw = wordsRaw(words)
	} else {
		parts := make([]string, len(addresses))
		for i, a := range addresses {
			parts[i] = fmt.Sprintf("%04x=%04x", a, words[i])
		}
		raw = strings.Join(parts, ",")
	}
	d := p.Decoder
	if d != nil && d.Rule >= 1 && d.Rule <= 4 && !d.hatSensors() {
		return deyeRule12(p, words, raw, o)
	}
	decoded, err := baseNumber(p, words, o)
	if err != nil {
		return nil, err
	}
	if decoded == nil {
		return &Sample{PointKey: p.PointKey, Raw: raw, Quality: "invalid"}, nil
	}
	if f, ok := decoded.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0)) {
		return &Sample{PointKey: p.PointKey, Raw: raw, Quality: "invalid"}, nil
	}
	if f, ok := decoded.(float64); ok && p.Range != nil && p.Range.Invalid != nil && f == *p.Range.Invalid {
		return nil, nil // "invalid" is not zero: no sample at all
	}
	kind := "none"
	if p.Scale != nil {
		kind = p.Scale.Kind
	}
	hat := true
	f, isNum := decoded.(float64)
	switch {
	case kind == "factor" && isNum:
		decoded = f * jsNumber(p.Scale.Value)
	case kind == "divisor" && isNum:
		decoded = f / jsNumber(p.Scale.Value)
	case kind == "sunssf":
		// The scale factor is never known to the runtime (the Docker box sets
		// none either): the sample carries raw only.
		hat = false
	case kind != "none" && kind != "protocol_value":
		// conditional/unknown scales - and a factor or divisor on a text value.
		hat = false
	}
	s := &Sample{PointKey: p.PointKey, Raw: raw, Quality: "good"}
	if hat {
		s.Decoded, s.HatDecoded = decoded, true
	}
	return s, nil
}

func (d *Decoder) hatSensors() bool {
	if d.raw == nil {
		return len(d.Sensors) > 0
	}
	_, ok := d.raw["sensors"].([]any)
	return ok
}

func (d *Decoder) has(key string) bool {
	if d == nil || d.raw == nil {
		return false
	}
	_, ok := d.raw[key]
	return ok
}

// effectiveEndian: a decoder with a byte-order register follows the configured
// order, else the detected one (the big value means big endian).
func effectiveEndian(p *Punkt, o DecodeOptionen) string {
	if p.Decoder == nil || p.Decoder.ByteOrder == nil {
		return p.Endian
	}
	switch o.ByteOrder {
	case "big":
		return "big"
	case "little", "word_little_byte_big":
		return "word_little_byte_big"
	}
	if o.ByteOrderWord != nil && jsStrictEqual(float64(*o.ByteOrderWord), p.Decoder.ByteOrder.BigValue) {
		return "big"
	}
	return "word_little_byte_big"
}

func bytesOf(words []uint16) []byte {
	b := make([]byte, 2*len(words))
	for i, w := range words {
		binary.BigEndian.PutUint16(b[2*i:], w)
	}
	return b
}

var errBereich = fmt.Errorf("RangeError: Attempt to access memory outside buffer bounds")

// baseNumber is the value of the words per value type: float64 or string; nil
// for a type it does not know. An access past the buffer is an error, like
// Node's RangeError.
func baseNumber(p *Punkt, words []uint16, o DecodeOptionen) (any, error) {
	b := bytesOf(words)
	ordered := words
	if effectiveEndian(p, o) == "word_little_byte_big" && len(words) > 1 {
		ordered = make([]uint16, len(words))
		for i, w := range words {
			ordered[len(words)-1-i] = w
		}
	}
	n := bytesOf(ordered)
	need := func(buf []byte, k int) error {
		if len(buf) < k {
			return errBereich
		}
		return nil
	}
	switch p.ValueType {
	case "int16", "sunssf":
		if err := need(b, 2); err != nil {
			return nil, err
		}
		return float64(int16(binary.BigEndian.Uint16(b))), nil
	case "uint16", "enum16", "bitfield16", "count":
		if err := need(b, 2); err != nil {
			return nil, err
		}
		return float64(binary.BigEndian.Uint16(b)), nil
	case "int32":
		if err := need(n, 4); err != nil {
			return nil, err
		}
		return float64(int32(binary.BigEndian.Uint32(n))), nil
	case "uint32", "acc32", "bitfield32":
		if err := need(n, 4); err != nil {
			return nil, err
		}
		return float64(binary.BigEndian.Uint32(n)), nil
	case "float32":
		if err := need(n, 4); err != nil {
			return nil, err
		}
		return float64(math.Float32frombits(binary.BigEndian.Uint32(n))), nil
	case "float64":
		if err := need(n, 8); err != nil {
			return nil, err
		}
		return math.Float64frombits(binary.BigEndian.Uint64(n)), nil
	case "string", "ascii_string":
		return asciiString(b), nil
	case "bitfield64":
		v := new(big.Int).SetBytes(n)
		return v.String(), nil
	case "datetime":
		return decodeDateTime(words), nil
	case "time":
		return decodeTime(p, words), nil
	case "version":
		return decodeVersion(p, words), nil
	}
	return nil, nil
}

// asciiString is Buffer.toString('ascii') (the high bit cleared), trailing
// NUL/0xFF removed, then String.trim(). After the high bit is cleared no 0xFF
// is left, so only NULs go - exactly like Node.
func asciiString(b []byte) string {
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = c & 0x7f
	}
	s := strings.TrimRight(string(out), "\x00")
	return strings.Trim(s, " \t\n\v\f\r")
}

func pad(v int, n int) string {
	s := strconv.Itoa(v)
	for len(s) < n {
		s = "0" + s
	}
	return s
}

func decodeDateTime(words []uint16) any {
	if len(words) >= 6 {
		y, mo, d, h, mi, s := int(words[0]), int(words[1]), int(words[2]), int(words[3]), int(words[4]), int(words[5])
		if y >= 1970 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59 {
			return pad(y, 4) + "-" + pad(mo, 2) + "-" + pad(d, 2) + "T" + pad(h, 2) + ":" + pad(mi, 2) + ":" + pad(s, 2)
		}
	}
	b := bytesOf(words)
	if len(b) >= 6 {
		yy, mo, d, h, mi, s := int(b[0]), int(b[1]), int(b[2]), int(b[3]), int(b[4]), int(b[5])
		if mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59 {
			return "20" + pad(yy, 2) + "-" + pad(mo, 2) + "-" + pad(d, 2) + "T" + pad(h, 2) + ":" + pad(mi, 2) + ":" + pad(s, 2)
		}
	}
	return nil
}

func decodeTime(p *Punkt, words []uint16) any {
	divisor := 100.0
	if p.Decoder != nil {
		if jsTruthy(p.Decoder.Hex) {
			divisor = jsNumber(p.Decoder.Hex)
		} else if jsTruthy(p.Decoder.Dec) {
			divisor = jsNumber(p.Decoder.Dec)
		}
	}
	var hour, minute float64
	second := math.NaN()
	hatSekunde := false
	if len(words) == 1 {
		v := float64(words[0])
		hour, minute = math.Floor(v/divisor), math.Mod(v, divisor)
	} else {
		hour, minute = float64(words[0]), float64(words[1])
		if len(words) > 2 {
			second, hatSekunde = float64(words[2]), true
		}
	}
	if !(hour <= 23 && minute <= 59 && (!hatSekunde || second <= 59)) {
		return nil
	}
	out := jsPad2(hour) + ":" + jsPad2(minute)
	if hatSekunde {
		out += ":" + jsPad2(second)
	}
	return out
}

func jsPad2(f float64) string {
	s := jsNumberString(f)
	for len(s) < 2 {
		s = "0" + s
	}
	return s
}

func decodeVersion(p *Punkt, words []uint16) any {
	d := p.Decoder
	digitDelimiter, registerDelimiter := ".", "-"
	within := "."
	if d != nil {
		switch v := d.Delimiter.(type) {
		case string:
			digitDelimiter, within = v, v
		case map[string]any:
			registerDelimiter = "-"
			if r, ok := v["register"]; ok && r != nil {
				registerDelimiter = jsString(r)
			}
			within = "."
			if r, ok := v["digit"]; ok && r != nil {
				within = jsString(r)
			}
		}
	}
	_ = digitDelimiter
	radix := 10
	if d.has("hex") {
		radix = 16
	}
	parts := make([]string, len(words))
	for i, w := range words {
		nib := make([]string, 4)
		for j, shift := range []uint{12, 8, 4, 0} {
			nib[j] = strconv.FormatInt(int64((w>>shift)&15), radix)
		}
		parts[i] = strings.Join(nib, within)
	}
	value := strings.ToUpper(strings.Join(parts, registerDelimiter))
	if d != nil && d.Remove != nil {
		value = strings.ReplaceAll(value, jsString(d.Remove), "")
	}
	return value
}

// --- the Deye rules 1-4 -------------------------------------------------------

func variantIndex(d *Decoder, o DecodeOptionen) int {
	if d.Variant == nil {
		return 0
	}
	if o.VariantWord != nil {
		for _, v := range d.Variant.Index1Values {
			if jsStrictEqual(float64(*o.VariantWord), v) {
				return 1
			}
		}
	}
	n := jsNumber(d.Variant.DefaultIndex)
	if math.IsNaN(n) || n == 0 {
		return 0
	}
	return int(n)
}

// bound is variantValue(): a per-variant array yields the variant's entry.
func bound(v any, d *Decoder, o DecodeOptionen) any {
	arr, ok := v.([]any)
	if !ok {
		return v
	}
	i := variantIndex(d, o)
	if i > len(arr)-1 {
		i = len(arr) - 1
	}
	if i < 0 {
		return nil
	}
	return arr[i]
}

func deyeLookup(value any, dict []LookupEntry) any {
	if len(dict) == 0 {
		return value
	}
	fallback := dict[0].Value
	for _, e := range dict {
		var key any
		if _, hatBit := e.raw["bit"]; hatBit {
			switch b := e.Bit.(type) {
			case []any:
				sum := 0.0
				for _, x := range b {
					sum += math.Pow(2, jsNumber(x))
				}
				key = sum
			default:
				key = math.Pow(2, jsNumber(b))
			}
		} else {
			key = e.Key
		}
		// (value & key) === key: the int32 AND compared with the key itself, so
		// only a key that is an int32 can ever match.
		if kf, ok := key.(float64); ok && e.Mode == "|" && float64(jsToInt32(jsNumber(value))&jsToInt32(kf)) == kf {
			key = value
		}
		if e.Default != nil || key == "default" {
			fallback = e.Value
		}
		if arr, ok := key.([]any); ok {
			for _, k := range arr {
				if jsStrictEqual2(k, value) {
					return e.Value
				}
			}
		} else if jsStrictEqual2(key, value) {
			return e.Value
		}
	}
	return fallback
}

type ungueltig struct {
	invalid       int
	invalidateAll bool
}

func deyeInvalid(d *Decoder, value any, o DecodeOptionen) ungueltig {
	v := d.Validation
	if v == nil {
		return ungueltig{}
	}
	invalid := 0
	min, max := bound(v.Min, d, o), bound(v.Max, d, o)
	if v.Lookup != "" {
		if ref, ok := o.DecodedValues[v.Lookup].(float64); ok && !math.IsNaN(ref) && !math.IsInf(ref, 0) && ref != 0 {
			if min == nil {
				min = -math.Abs(ref)
			}
			if max == nil {
				max = math.Abs(ref)
			}
		}
	}
	if s := bound(v.Scale, d, o); s != nil {
		if min != nil {
			min = jsNumber(min) * jsNumber(s)
		}
		if max != nil {
			max = jsNumber(max) * jsNumber(s)
		}
	}
	if (min != nil && jsGreater(min, value)) || (max != nil && jsLess(max, value)) {
		invalid |= 1
	}
	dev := bound(v.Dev, d, o)
	prior, hatPrior := o.PreviousValues[d.SourceKey]
	if jsTruthy(dev) && jsTruthy(value) && o.PreviousValues != nil && hatPrior && prior != nil &&
		math.Abs(jsNumber(value)-jsNumber(prior)) > jsNumber(dev) {
		invalid |= 2
	} else if invalid == 0 && o.PreviousValues != nil {
		o.PreviousValues[d.SourceKey] = value
	}
	mask, hatMask := v.raw["invalidate_all"]
	return ungueltig{invalid: invalid, invalidateAll: invalid > 0 && hatMask &&
		(mask == nil || jsToInt32(float64(invalid))&jsToInt32(jsNumber(mask)) != 0)}
}

func deyeRule12(p *Punkt, words []uint16, raw any, o DecodeOptionen) (*Sample, error) {
	d := p.Decoder
	value := new(big.Int)
	for i, w := range words {
		value.Add(value, new(big.Int).Lsh(big.NewInt(int64(w)), uint(16*i)))
	}
	if d.Rule == 2 || d.Rule == 4 {
		bits := uint(len(words) * 16)
		sign := new(big.Int).Lsh(big.NewInt(1), bits-1)
		if value.Cmp(sign) >= 0 {
			if d.Magnitude {
				value.And(value, new(big.Int).Sub(sign, big.NewInt(1)))
				value.Neg(value)
			} else {
				value.Sub(value, new(big.Int).Lsh(big.NewInt(1), bits))
			}
		}
	}
	var decoded any
	f, _ := new(big.Float).SetInt(value).Float64()
	decoded = f
	if r := d.Range; r != nil {
		min, max := bound(r.Min, d, o), bound(r.Max, d, o)
		if (min != nil && jsLess(decoded, min)) || (max != nil && jsGreater(decoded, max)) {
			decoded = bound(r.Default, d, o)
			if decoded == nil {
				return &Sample{PointKey: p.PointKey, Raw: raw, Quality: "invalid"}, nil
			}
		}
	}
	if d.Mask != nil {
		decoded = bigToFloat(new(big.Int).And(truncBig(jsNumber(decoded)), truncBig(jsNumber(d.Mask))))
	}
	if d.Bit != nil {
		x := new(big.Int).Rsh(truncBig(jsNumber(decoded)), uint(jsNumber(d.Bit)))
		decoded = bigToFloat(x.And(x, big.NewInt(1)))
	}
	if d.Bitmask != nil {
		m := truncBig(jsNumber(d.Bitmask))
		x := new(big.Int).And(truncBig(jsNumber(decoded)), m)
		decoded = bigToFloat(x.Quo(x, m))
	}
	if d.raw["lookup"] != nil {
		// An empty lookup is truthy in JavaScript: it skips the arithmetic too.
		decoded = deyeLookup(decoded, d.Lookup)
	} else {
		offset, scale, divide := bound(d.Offset, d, o), bound(d.Scale, d, o), bound(d.Divide, d, o)
		if offset != nil {
			decoded = jsNumber(decoded) - jsNumber(offset)
		}
		if scale != nil {
			decoded = jsNumber(decoded) * jsNumber(scale)
		}
		if divide != nil {
			decoded = math.Floor(jsNumber(decoded) / jsNumber(divide))
		}
	}
	if (d.Rule == 2 || d.Rule == 4) && d.Inverted {
		decoded = -jsNumber(decoded)
	}
	checked := deyeInvalid(d, decoded, o)
	if checked.invalid != 0 {
		fallback := bound(d.Validation.Default, d, o)
		if fallback == nil {
			return &Sample{PointKey: p.PointKey, Raw: raw, Quality: "invalid", InvalidateAll: checked.invalidateAll}, nil
		}
		decoded = fallback
	}
	if num, ok := decoded.(float64); ok {
		digits := jsNumber(d.Digits)
		if digits == math.Trunc(digits) && digits >= 0 && !math.IsInf(digits, 0) {
			decoded = toFixed(num, int(digits))
		}
	}
	if o.DecodedValues != nil && d.SourceKey != "" {
		o.DecodedValues[d.SourceKey] = decoded
	}
	return &Sample{PointKey: p.PointKey, Raw: raw, Decoded: decoded, HatDecoded: true, Quality: "good"}, nil
}

func truncBig(f float64) *big.Int {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		// BigInt(NaN) throws in JS; the catalog never gets there.
		return new(big.Int)
	}
	i, _ := new(big.Float).SetFloat64(math.Trunc(f)).Int(nil)
	return i
}

func bigToFloat(i *big.Int) float64 {
	f, _ := new(big.Float).SetInt(i).Float64()
	return f
}

// toFixed is Number(x.toFixed(digits)): the exact decimal value of x rounded
// half away from zero, read back as a number.
func toFixed(x float64, digits int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) >= 1e21 || digits > 100 {
		return x
	}
	neg := x < 0
	exact := new(big.Float).SetPrec(2000).SetFloat64(math.Abs(x)).Text('f', 1100)
	intPart, frac, _ := strings.Cut(exact, ".")
	for len(frac) < digits+1 {
		frac += "0"
	}
	keep := intPart + frac[:digits]
	n, _ := new(big.Int).SetString(keep, 10)
	if frac[digits] >= '5' {
		n.Add(n, big.NewInt(1))
	}
	s := n.String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	f, _ := strconv.ParseFloat(s, 64)
	if neg && f != 0 {
		f = -f // Number("-0.00") is -0, which JSON writes as 0
	}
	return f
}

// --- derived values (a vendor rule over several registers) ---------------

var derivedRe = regexp.MustCompile(`(?i)^holding:0x([0-9a-f]+)$`)

// DerivedAddresses are the registers a derived point reads, ascending.
func DerivedAddresses(p *Punkt) []int {
	seen := map[int]bool{}
	var out []int
	for _, s := range p.DerivedFrom {
		m := derivedRe.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		v, err := strconv.ParseInt(m[1], 16, 64)
		if err != nil || seen[int(v)] {
			continue
		}
		seen[int(v)] = true
		out = append(out, int(v))
	}
	sort.Ints(out)
	return out
}

// DecodeDerived is decodeDerived(): only a rule-1 sum of single registers
// (optionally multiplied) is decoded; every other vendor rule stays raw.
func DecodeDerived(p *Punkt, words map[int]uint16) *Sample {
	addresses := DerivedAddresses(p)
	if len(addresses) == 0 {
		return nil
	}
	parts := make([]string, len(addresses))
	for i, a := range addresses {
		w, ok := words[a]
		if !ok {
			return nil
		}
		parts[i] = fmt.Sprintf("%04x=%04x", a, w)
	}
	out := &Sample{PointKey: p.PointKey, Raw: strings.Join(parts, ","), Quality: "good"}
	d := p.Decoder
	if d == nil {
		return out
	}
	if d.Rule != 1 || !d.hatSensors() {
		return out
	}
	for _, s := range d.Sensors {
		if jsTruthy(s.EnabledLook) || jsTruthy(s.MPPT) || !s.hatRegisters || !alleGanz(s.Registers) {
			return out
		}
	}
	total := 0.0
	for _, s := range d.Sensors {
		var value float64
		switch {
		case s.Multiply != nil && s.Multiply.Registers != nil && len(s.Registers) == 1 && len(s.Multiply.Registers) == 1:
			value = wortOderNaN(words, s.Registers[0]) * wortOderNaN(words, s.Multiply.Registers[0])
		case len(s.Registers) == 1:
			value = wortOderNaN(words, s.Registers[0])
		default:
			return out
		}
		if s.Operator == "subtract" {
			total -= value
		} else {
			total += value
		}
	}
	kind := "none"
	if p.Scale != nil {
		kind = p.Scale.Kind
	}
	switch kind {
	case "factor":
		total *= jsNumber(p.Scale.Value)
	case "divisor":
		total /= jsNumber(p.Scale.Value)
	case "none":
	default:
		return out
	}
	v := d.Validation
	if v != nil && ((v.Min != nil && jsLess(total, v.Min)) || (v.Max != nil && jsGreater(total, v.Max))) {
		out.Quality = "invalid"
	} else if !math.IsNaN(total) && !math.IsInf(total, 0) {
		out.Decoded, out.HatDecoded = total, true
	}
	return out
}

// wortOderNaN is Map.get(r) of the words: a register given as an array is a
// miss (an object key), like a register that was not read.
func wortOderNaN(words map[int]uint16, r any) float64 {
	f, isNum := r.(float64)
	if !isNum {
		return math.NaN()
	}
	w, ok := words[int(f)]
	if !ok {
		return math.NaN()
	}
	return float64(w)
}

// alleGanz: every entry (also nested) is an integer.
func alleGanz(v []any) bool {
	for _, x := range v {
		switch y := x.(type) {
		case []any:
			if !alleGanz(y) {
				return false
			}
		case float64:
			if y != math.Trunc(y) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// MarshalJSON writes the sample like the JS object: decoded only when the
// decode set one, invalidate_all and entity_id only when true or named.
func (s Sample) MarshalJSON() ([]byte, error) {
	type aus struct {
		PointKey      string `json:"point_key,omitempty"`
		Raw           any    `json:"raw"`
		Decoded       any    `json:"decoded,omitempty"`
		Quality       string `json:"quality"`
		InvalidateAll bool   `json:"invalidate_all,omitempty"`
		EntityID      string `json:"entity_id,omitempty"`
		SignedData    string `json:"signed_data,omitempty"`
		SignedFormat  string `json:"signed_data_format,omitempty"`
	}
	a := aus{PointKey: s.PointKey, Raw: s.Raw, Quality: s.Quality, InvalidateAll: s.InvalidateAll, EntityID: s.EntityID,
		SignedData: s.SignedData, SignedFormat: s.SignedDataFormat}
	if s.HatDecoded {
		a.Decoded = s.Decoded
	}
	return json.Marshal(a)
}

// ohneSchluessel is the sample without its point key (the vectors' form).
func (s *Sample) ohneSchluessel() Sample {
	c := *s
	c.PointKey = ""
	return c
}
