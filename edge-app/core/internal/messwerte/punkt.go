// Package messwerte is the measurement library of Edge Light: the Go twin of
// the Docker box's catalog runtime (edge-app/nodered/measurements/
// measurement-driver.js, measurement-planner.js, measurement-runtime.js - the
// source of truth). It reads the catalog points a portal measurement plan
// selects ("Zusatzmesswerte nach Katalog") from the devices the box knows and
// hands real raw values with an evidenced decode to the core.
//
// The catalog is the box view the packaging tool writes for both box types
// (catalog/measurement-points/tools/package_edge_runtime.py); Edge Light embeds
// it gzip-compressed and decodes only the points a plan needs, so the Mango
// never holds two megabytes of JSON.
//
// Pure: the device access is the caller's (internal/layer1). Both sides are held
// to edge-app/nodered/measurements/measurement-driver-vectors.json.
package messwerte

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

//go:embed katalog.json.gz
var katalogGz []byte

// Punkt is one catalog point as the box reads it (EDGE_FIELDS of the
// packaging tool; fields the runtime never reads are not decoded).
type Punkt struct {
	PointKey    string   `json:"point_key"`
	Family      string   `json:"family"`
	SourceKind  string   `json:"source_kind"`
	Readable    bool     `json:"readable"`
	Address     *Adresse `json:"address"`
	Selector    string   `json:"selector"`
	ValueType   string   `json:"value_type"`
	Endian      string   `json:"endian"`
	Scale       *Skala   `json:"scale"`
	PollGroup   string   `json:"poll_group"`
	MinCadenceS float64  `json:"min_cadence_s"`
	Decoder     *Decoder `json:"decoder"`
	DerivedFrom []string `json:"derived_from"`
	Range       *Bereich `json:"range"`
}

// Adresse is where a point lives: modbus_holding/modbus_input (registers),
// sunspec_relative (model base + offset) or registerbild_relative.
type Adresse struct {
	Kind       string `json:"kind"`
	Registers  []int  `json:"registers"`
	WidthWords int    `json:"width_words"`
	ModelID    int    `json:"model_id"`
	// OffsetWords is an integer or the instance expression
	// "base+index*stride+offset" of a repeated block.
	OffsetWords any `json:"offset_words"`
}

// Skala is the catalog scale: none, factor, divisor, sunssf (needs a scale
// factor the runtime never has, so no decode), protocol_value, and kinds the
// box does not apply (conditional_factor, unknown).
type Skala struct {
	Kind  string `json:"kind"`
	Value any    `json:"value"`
	Point string `json:"point"`
}

// Bereich is a catalog range; Invalid names the ONE value of the data type
// that means "no reading" (WAGO 750-495: the type's largest).
type Bereich struct {
	Invalid *float64 `json:"invalid"`
}

// Decoder is a vendor decode rule (Deye rules 1-4 from ha-solarman). Values
// that may be a number OR a per-variant array stay `any`.
type Decoder struct {
	Rule       int            `json:"rule"`
	SourceKey  string         `json:"source_key"`
	Digits     any            `json:"digits"`
	Scale      any            `json:"scale"`
	Offset     any            `json:"offset"`
	Divide     any            `json:"divide"`
	Range      *DecoderRange  `json:"range"`
	Validation *Validation    `json:"validation"`
	Lookup     []LookupEntry  `json:"lookup"`
	Mask       any            `json:"mask"`
	Bit        any            `json:"bit"`
	Bitmask    any            `json:"bitmask"`
	Inverted   bool           `json:"inverted"`
	Magnitude  bool           `json:"magnitude"`
	Variant    *Variante      `json:"variant"`
	ByteOrder  *ByteOrder     `json:"byte_order"`
	Sensors    []Sensor       `json:"sensors"`
	Hex        any            `json:"hex"`
	Dec        any            `json:"dec"`
	Delimiter  any            `json:"delimiter"`
	Remove     any            `json:"remove"`
	raw        map[string]any // presence checks (Object.hasOwn)
}

// UnmarshalJSON keeps the raw object next to the typed fields: a few rules
// depend on whether a key is PRESENT, not on its value.
func (d *Decoder) UnmarshalJSON(b []byte) error {
	type plain Decoder
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*d = Decoder(p)
	return json.Unmarshal(b, &d.raw)
}

// DecoderRange is a rule's range with its replacement value.
type DecoderRange struct {
	Min     any `json:"min"`
	Max     any `json:"max"`
	Default any `json:"default"`
}

// Validation is a rule's plausibility check.
type Validation struct {
	Min     any    `json:"min"`
	Max     any    `json:"max"`
	Lookup  string `json:"lookup"`
	Scale   any    `json:"scale"`
	Dev     any    `json:"dev"`
	Default any    `json:"default"`
	raw     map[string]any
}

// UnmarshalJSON keeps presence of invalidate_all (null means "every bit").
func (v *Validation) UnmarshalJSON(b []byte) error {
	type plain Validation
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*v = Validation(p)
	return json.Unmarshal(b, &v.raw)
}

// LookupEntry maps a decoded number (or bit) to a value.
type LookupEntry struct {
	Key     any    `json:"key"`
	Bit     any    `json:"bit"`
	Value   any    `json:"value"`
	Mode    string `json:"mode"`
	Default any    `json:"default"`
	raw     map[string]any
}

// UnmarshalJSON keeps presence of bit (a key of 0 differs from no key).
func (l *LookupEntry) UnmarshalJSON(b []byte) error {
	type plain LookupEntry
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*l = LookupEntry(p)
	return json.Unmarshal(b, &l.raw)
}

// Variante selects index 1 of a per-variant value when the variant register
// reads one of Index1Values.
type Variante struct {
	Register     *int  `json:"register"`
	Index1Values []any `json:"index_1_values"`
	DefaultIndex any   `json:"default_index"`
}

// ByteOrder detects the word order from a register (BigValue = big endian).
type ByteOrder struct {
	Register *int `json:"register"`
	BigValue any  `json:"big_value"`
}

// Sensor is one summand of a derived (multi-register) vendor value.
type Sensor struct {
	Registers    []any   `json:"registers"`
	Multiply     *Faktor `json:"multiply"`
	Operator     string  `json:"operator"`
	EnabledLook  any     `json:"enabled_lookup"`
	MPPT         any     `json:"mppt"`
	hatRegisters bool
}

// UnmarshalJSON notes whether registers is an array at all.
func (s *Sensor) UnmarshalJSON(b []byte) error {
	type plain Sensor
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Sensor(p)
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	s.hatRegisters = len(raw["registers"]) > 0 && raw["registers"][0] == '['
	return nil
}

// Faktor is a sensor's multiplying register.
type Faktor struct {
	Registers []any `json:"registers"`
}

// Katalog is the part of the box catalog one plan needs.
type Katalog struct {
	Version string
	punkte  map[string]*Punkt
	// prereq: family + "\x00" + decoder source_key -> the point with an address.
	prereq map[string]*Punkt
}

// Punkt is the catalog entry of key, nil when absent.
func (k *Katalog) Punkt(key string) *Punkt {
	if k == nil {
		return nil
	}
	return k.punkte[key]
}

// streamKatalog decodes the embedded catalog point by point and hands each one
// to keep; the version comes back too.
func streamKatalog(keep func(*Punkt)) (string, error) {
	zr, err := gzip.NewReader(bytes.NewReader(katalogGz))
	if err != nil {
		return "", err
	}
	defer zr.Close()
	dec := json.NewDecoder(zr)
	version := ""
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return "", errors.New("messwerte: Katalog ist kein Objekt")
	}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t {
		case "catalog_version":
			if err := dec.Decode(&version); err != nil {
				return "", err
			}
		case "points":
			if t, err := dec.Token(); err != nil || t != json.Delim('[') {
				return "", errors.New("messwerte: points ist keine Liste")
			}
			for dec.More() {
				var p Punkt
				if err := dec.Decode(&p); err != nil {
					return "", err
				}
				keep(&p)
			}
			if _, err := dec.Token(); err != nil {
				return "", err
			}
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return "", err
			}
		}
	}
	return version, nil
}

var katalogVersion string

// KatalogVersion is the runtime version of the embedded catalog - a plan for
// another version is refused as unsupported_catalog, like on the Docker box.
func KatalogVersion() string {
	if katalogVersion == "" {
		v, err := streamKatalog(func(*Punkt) {})
		if err != nil {
			panic(fmt.Sprintf("messwerte: eingebetteter Katalog unlesbar: %v", err))
		}
		katalogVersion = v
	}
	return katalogVersion
}

// LadeKatalog reads the points of keys (a concrete key also loads its
// template) and, in a second pass when one of them validates against another
// value, the points that carry those values.
func LadeKatalog(keys []string) (*Katalog, error) {
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
		want[TemplateKey(k)] = true
	}
	k := &Katalog{punkte: map[string]*Punkt{}, prereq: map[string]*Punkt{}}
	lookups := map[string]bool{}
	v, err := streamKatalog(func(p *Punkt) {
		if want[p.PointKey] {
			k.punkte[p.PointKey] = p
			if p.Decoder != nil && p.Decoder.Validation != nil && p.Decoder.Validation.Lookup != "" {
				lookups[p.Family+"\x00"+p.Decoder.Validation.Lookup] = true
			}
		}
	})
	if err != nil {
		return nil, err
	}
	k.Version = v
	if len(lookups) > 0 {
		if _, err := streamKatalog(func(p *Punkt) {
			if p.Decoder == nil || p.Address == nil {
				return
			}
			key := p.Family + "\x00" + p.Decoder.SourceKey
			if lookups[key] && k.prereq[key] == nil {
				k.prereq[key] = p
			}
		}); err != nil {
			return nil, err
		}
	}
	return k, nil
}

// LadeAlles reads the whole catalog (tests and tools only - never on a box).
func LadeAlles() (*Katalog, error) {
	k := &Katalog{punkte: map[string]*Punkt{}, prereq: map[string]*Punkt{}}
	v, err := streamKatalog(func(p *Punkt) {
		k.punkte[p.PointKey] = p
		if p.Decoder != nil && p.Address != nil {
			key := p.Family + "\x00" + p.Decoder.SourceKey
			if k.prereq[key] == nil {
				k.prereq[key] = p
			}
		}
	})
	k.Version = v
	return k, err
}

var bracketRe = regexp.MustCompile(`\[[^\]]+\]`)

// TemplateKey replaces every index with [*].
func TemplateKey(key string) string { return bracketRe.ReplaceAllString(key, "[*]") }

// Discovery is what a SunSpec model walk found on one target.
type Discovery struct {
	Models map[int]Modell `json:"models"`
}

// Modell is one discovered SunSpec model.
type Modell struct {
	Base        int `json:"base"`
	ModuleCount int `json:"moduleCount"`
}

// Definition is a custom (self-built) point of a selection.
type Definition map[string]any

func defFeld(d Definition, camel, snake string) any {
	if v, ok := d[camel]; ok && v != nil && v != "" && v != false && v != 0.0 {
		return v
	}
	return d[snake]
}

// customPoint is customPoint(): a free register of a selection (custom.*).
func customPoint(key string, d Definition) *Punkt {
	if !strings.HasPrefix(key, "custom.") || d == nil {
		return nil
	}
	source, _ := defFeld(d, "sourceKind", "source_kind").(string)
	address := jsNumber(d["address"])
	widthWords := jsNumber(defFeld(d, "widthBits", "width_bits")) / 16
	if (source != "modbus_holding" && source != "modbus_input") || address != float64(int64(address)) ||
		address < 0 || address > 65535 || (widthWords != 1 && widthWords != 2 && widthWords != 4) ||
		address+widthWords > 65536 {
		return nil
	}
	a, w := int(address), int(widthWords)
	regs := make([]int, w)
	for i := range regs {
		regs[i] = a + i
	}
	valueType, _ := defFeld(d, "valueType", "value_type").(string)
	endian, _ := d["endian"].(string)
	return &Punkt{PointKey: key, Family: "custom", SourceKind: source, Readable: true,
		Address:   &Adresse{Kind: source, Registers: regs, WidthWords: w},
		ValueType: valueType, Endian: endian,
		Scale:     &Skala{Kind: "factor", Value: jsNumber(d["scale"])},
		PollGroup: "custom:" + source + ":" + strconv.Itoa(a), MinCadenceS: 1}
}

var (
	moduleRe  = regexp.MustCompile(`^sunspec\.model_160\.module\[(\d+)]\.`)
	kartenRe  = regexp.MustCompile(`^wago\.pm49[45]\.karte\[(\d+)]\.`)
	einheitRe = regexp.MustCompile(`^erzeuger\.te\[(\d+)]\.`)
	offsetRe  = regexp.MustCompile(`^(\d+)\+index\*(\d+)\+(\d+)$`)
)

// ResolvePoint is resolvePoint(): a custom point, the catalog entry of key or
// of its template; a repeated block (SunSpec model 160 modules within the
// discovered module count, WAGO cards, Erzeuger units) gets its instance
// offset. nil = no such point. An instance expression that does not parse is
// an error, like the JS module's throw.
func (k *Katalog) ResolvePoint(key string, discovery *Discovery, definition Definition) (*Punkt, error) {
	if c := customPoint(key, definition); c != nil {
		return c, nil
	}
	p := k.Punkt(key)
	if p == nil {
		p = k.Punkt(TemplateKey(key))
	}
	if p == nil {
		return nil, nil
	}
	instanz := func(m []string) (*Punkt, error) {
		i, _ := strconv.Atoi(m[1])
		off, err := evalDynamicOffset(p.Address.OffsetWords, i)
		if err != nil {
			return nil, err
		}
		a := *p.Address
		a.OffsetWords = float64(off)
		q := *p
		q.PointKey, q.Address = key, &a
		return &q, nil
	}
	if m := moduleRe.FindStringSubmatch(key); m != nil {
		n := -1
		if discovery != nil {
			if mod, ok := discovery.Models[160]; ok {
				n = mod.ModuleCount
			}
		}
		i, _ := strconv.Atoi(m[1])
		if n < 0 || i >= n {
			return nil, nil
		}
		return instanz(m)
	}
	if m := kartenRe.FindStringSubmatch(key); m != nil && p.Address != nil && p.Address.Kind == "registerbild_relative" {
		return instanz(m)
	}
	if m := einheitRe.FindStringSubmatch(key); m != nil && p.Address != nil && p.Address.Kind == "registerbild_relative" {
		return instanz(m)
	}
	return p, nil
}

// evalDynamicOffset is `base+index*stride+offset` - one instance of a block.
func evalDynamicOffset(expr any, index int) (int, error) {
	switch v := expr.(type) {
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int(i), nil
		}
	case float64:
		if v == float64(int(v)) {
			return int(v), nil
		}
	case string:
		if m := offsetRe.FindStringSubmatch(v); m != nil {
			b, _ := strconv.Atoi(m[1])
			s, _ := strconv.Atoi(m[2])
			o, _ := strconv.Atoi(m[3])
			return b + index*s + o, nil
		}
	}
	return 0, errors.New("invalid dynamic instance offset")
}

// offsetInt is an integer offset_words, ok=false for an expression or none.
func offsetInt(a *Adresse) (int, bool) {
	switch v := a.OffsetWords.(type) {
	case json.Number:
		i, err := v.Int64()
		return int(i), err == nil
	case float64:
		return int(v), v == float64(int(v))
	}
	return 0, false
}
