package messwerte

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"sync"
	"testing"
)

// The shared driver vectors live next to the JS source of truth and are read
// BY PATH: measurement-driver-vectors.gen.js writes them from
// measurement-driver.js and catalog.json.
func treiberVektorenPfad(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "measurements", "measurement-driver-vectors.json")
}

type treiberVektoren struct {
	CatalogVersion string `json:"catalog_version"`
	Register       []struct {
		PointKey string   `json:"point_key"`
		Words    []uint16 `json:"words"`
		Options  struct {
			ByteOrder      string         `json:"byteOrder"`
			ByteOrderWord  *uint16        `json:"byteOrderWord"`
			VariantWord    *uint16        `json:"variantWord"`
			DecodedValues  map[string]any `json:"decodedValues"`
			PreviousValues map[string]any `json:"previousValues"`
		} `json:"options"`
		Sample         map[string]any `json:"sample"`
		DecodedValues  map[string]any `json:"decoded_values"`
		PreviousValues map[string]any `json:"previous_values"`
		Error          bool           `json:"error"`
	} `json:"register"`
	Abgeleitet []struct {
		PointKey string            `json:"point_key"`
		Words    map[string]uint16 `json:"words"`
		Sample   map[string]any    `json:"sample"`
	} `json:"abgeleitet"`
	JSON []struct {
		PointKey string          `json:"point_key"`
		Payload  json.RawMessage `json:"payload"`
		Samples  []any           `json:"samples"`
	} `json:"json"`
	Aufloesen []struct {
		Key        string         `json:"key"`
		Discovery  *Discovery     `json:"discovery"`
		Definition Definition     `json:"definition"`
		Point      map[string]any `json:"point"`
	} `json:"aufloesen"`
}

var (
	ganzerKatalog     *Katalog
	ganzerKatalogOnce sync.Once
)

func katalogFuerTests(t *testing.T) *Katalog {
	t.Helper()
	ganzerKatalogOnce.Do(func() {
		k, err := LadeAlles()
		if err != nil {
			t.Fatalf("Katalog: %v", err)
		}
		ganzerKatalog = k
	})
	return ganzerKatalog
}

func ladeTreiberVektoren(t *testing.T) treiberVektoren {
	t.Helper()
	raw, err := os.ReadFile(treiberVektorenPfad(t))
	if err != nil {
		t.Fatalf("Vektoren nicht lesbar: %v", err)
	}
	var v treiberVektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren unlesbar: %v", err)
	}
	if len(v.Register) == 0 || len(v.Abgeleitet) == 0 || len(v.Aufloesen) == 0 {
		t.Fatal("Vektoren leer")
	}
	return v
}

// alsJSON turns a value into its JSON form so Go and JS compare alike (one
// number type, maps for objects).
func alsJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("JSON: %v (%#v)", err, v)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTheEmbeddedCatalogIsTheOneOfTheVectors(t *testing.T) {
	v := ladeTreiberVektoren(t)
	if KatalogVersion() != v.CatalogVersion {
		t.Fatalf("eingebetteter Katalog %s, Vektoren %s - package_edge_runtime.py ausfuehren", KatalogVersion(), v.CatalogVersion)
	}
	if n := len(katalogFuerTests(t).punkte); n < 2000 {
		t.Fatalf("nur %d Punkte im eingebetteten Katalog", n)
	}
}

func vektorAdressen(p *Punkt) []int {
	if p.Address.Registers != nil {
		return p.Address.Registers
	}
	off, _ := offsetInt(p.Address)
	out := make([]int, p.Address.WidthWords)
	for i := range out {
		out[i] = 40000 + off + i
	}
	return out
}

func TestDecodeRegistersVectors(t *testing.T) {
	k := katalogFuerTests(t)
	fehler := 0
	for i, c := range ladeTreiberVektoren(t).Register {
		p := k.Punkt(c.PointKey)
		if p == nil {
			t.Fatalf("%s fehlt im eingebetteten Katalog", c.PointKey)
		}
		o := DecodeOptionen{ByteOrder: c.Options.ByteOrder, ByteOrderWord: c.Options.ByteOrderWord,
			VariantWord: c.Options.VariantWord, DecodedValues: map[string]any{}, PreviousValues: map[string]any{}}
		for k, v := range c.Options.DecodedValues {
			o.DecodedValues[k] = v
		}
		for k, v := range c.Options.PreviousValues {
			o.PreviousValues[k] = v
		}
		got, err := DecodeRegisters(p, c.Words, vektorAdressen(p), o)
		name := c.PointKey + " #" + strconv.Itoa(i)
		switch {
		case c.Error && err == nil:
			t.Errorf("%s: JS wirft, Go nicht (%+v)", name, got)
		case !c.Error && err != nil:
			t.Errorf("%s: Go wirft: %v", name, err)
		}
		if c.Error || err != nil {
			continue
		}
		var want any
		if c.Sample != nil {
			want = alsJSON(t, c.Sample)
		}
		var g any
		if got != nil {
			m := alsJSON(t, got.ohneSchluessel()).(map[string]any)
			g = m
		}
		if !gleich(g, want) {
			fehler++
			if fehler <= 25 {
				t.Errorf("%s (%s, %s) Woerter %v Optionen %+v:\n Go %v\n JS %v", name, p.ValueType, p.Endian, c.Words, c.Options, g, want)
			}
		}
		if c.DecodedValues != nil && !gleich(alsJSON(t, o.DecodedValues), alsJSON(t, c.DecodedValues)) {
			t.Errorf("%s: decodedValues Go %v, JS %v", name, o.DecodedValues, c.DecodedValues)
		}
		if c.PreviousValues != nil && !gleich(alsJSON(t, o.PreviousValues), alsJSON(t, c.PreviousValues)) {
			t.Errorf("%s: previousValues Go %v, JS %v", name, o.PreviousValues, c.PreviousValues)
		}
	}
	if fehler > 25 {
		t.Errorf("... insgesamt %d abweichende Faelle", fehler)
	}
}

func TestDecodeDerivedVectors(t *testing.T) {
	k := katalogFuerTests(t)
	for _, c := range ladeTreiberVektoren(t).Abgeleitet {
		p := k.Punkt(c.PointKey)
		words := map[int]uint16{}
		for a, w := range c.Words {
			n, _ := strconv.Atoi(a)
			words[n] = w
		}
		var g, want any
		if s := DecodeDerived(p, words); s != nil {
			g = alsJSON(t, s)
		}
		if c.Sample != nil {
			want = alsJSON(t, c.Sample)
		}
		if !gleich(g, want) {
			t.Errorf("%s %v:\n Go %v\n JS %v", c.PointKey, c.Words, g, want)
		}
	}
}

func TestResolvePointVectors(t *testing.T) {
	k := katalogFuerTests(t)
	for _, c := range ladeTreiberVektoren(t).Aufloesen {
		got, err := k.ResolvePoint(c.Key, c.Discovery, c.Definition)
		if _, wirft := c.Point["error"]; wirft {
			if err == nil {
				t.Errorf("%s: JS wirft, Go nicht", c.Key)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: Go wirft: %v", c.Key, err)
			continue
		}
		if (got == nil) != (c.Point == nil) {
			t.Errorf("%s: Go %+v, JS %v", c.Key, got, c.Point)
			continue
		}
		if got == nil {
			continue
		}
		if got.PointKey != c.Point["point_key"] || got.SourceKind != c.Point["source_kind"] ||
			got.Family != c.Point["family"] {
			t.Errorf("%s: Punkt Go %s/%s/%s, JS %v", c.Key, got.PointKey, got.SourceKind, got.Family, c.Point)
		}
		if want, ok := c.Point["address"].(map[string]any); ok {
			if got.Address == nil {
				t.Errorf("%s: Adresse fehlt", c.Key)
				continue
			}
			if off, ok := want["offset_words"]; ok {
				g, _ := offsetInt(got.Address)
				if float64(g) != off {
					t.Errorf("%s: offset_words Go %d, JS %v", c.Key, g, off)
				}
			}
			if regs, ok := want["registers"].([]any); ok && !gleich(alsJSON(t, got.Address.Registers), regs) {
				t.Errorf("%s: Register Go %v, JS %v", c.Key, got.Address.Registers, regs)
			}
		}
	}
}

// gleich compares two JSON values; numbers alike when equal (-0 is 0).
func gleich(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && (x == y || math.IsNaN(x) && math.IsNaN(y))
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !gleich(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !gleich(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestDecodeJSONSamplesVectors(t *testing.T) {
	k := katalogFuerTests(t)
	v := ladeTreiberVektoren(t)
	if len(v.JSON) == 0 {
		t.Fatal("keine JSON-Faelle")
	}
	for _, c := range v.JSON {
		p, _ := k.ResolvePoint(c.PointKey, nil, nil)
		payload, err := ParseJSON(c.Payload)
		if err != nil {
			t.Fatalf("%s: Nutzlast %s: %v", c.PointKey, c.Payload, err)
		}
		got := DecodeJSONSamples(p, payload)
		g := alsJSON(t, got)
		if got == nil {
			g = []any{}
		}
		if !gleich(g, alsJSON(t, c.Samples)) {
			t.Errorf("%s %s:\n Go %v\n JS %v", c.PointKey, c.Payload, g, c.Samples)
		}
	}
}

// An answer whose keys are not in JavaScript order is reordered on parse, and
// an object value comes back as the text JSON.stringify writes.
func TestParseJSONKeepsTheJavaScriptKeyOrder(t *testing.T) {
	v, err := ParseJSON([]byte(`{"b":1,"10":"x","2":[1.0,2.5e0,1e21,1e-7],"a":{"z":"\u003c/\"","0":true},"b":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := Stringify(v), `{"2":[1,2.5,1e+21,1e-7],"10":"x","b":3,"a":{"0":true,"z":"</\""}}`; got != want {
		t.Fatalf("Stringify\n Go   %s\n soll %s", got, want)
	}
}

// The device-answer parser keeps unsafe integers as text, like lossless-json.js
// (checked against it: {"a":"12345678901234567890","b":1,"c":0.1,"d":"9007199254740993"}).
func TestParseGeraeteJSONKeepsUnsafeIntegersAsText(t *testing.T) {
	v, err := ParseGeraeteJSON([]byte(`{"a":12345678901234567890,"b":1.0,"c":0.1,"d":9007199254740993,"e":9007199254740991,"f":-9007199254740992}`))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := Stringify(v), `{"a":"12345678901234567890","b":1,"c":0.1,"d":"9007199254740993","e":9007199254740991,"f":"-9007199254740992"}`; got != want {
		t.Fatalf("\n Go   %s\n soll %s", got, want)
	}
}
