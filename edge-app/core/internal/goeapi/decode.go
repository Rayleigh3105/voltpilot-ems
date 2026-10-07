// Package goeapi is the Go twin of edge-app/nodered/goe/goe-api.js: the
// READ-ONLY decode of the go-e Charger local HTTP API v2 (/api/status) onto
// the consumer reading Edge Light publishes for a go-e source.
//
// Node-RED stays the source of truth: both sides are bound to the shared
// vectors edge-app/nodered/goe/goe-api-vectors.json, generated FROM the JS
// module (goe-api-vectors.gen.js). The arithmetic is JavaScript-faithful -
// the same operation order and Math.round ("half towards +Infinity") - and
// the JSON is read the way JSON.parse reads it: a number outside float64
// becomes ±Infinity (and is then not a finite value) instead of failing the
// whole answer.
//
// The control side (writing amp/frc) is a different package (internal/goe)
// and is NOT used here: reading never writes.
package goeapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
)

// The endpoint and the keys the read asks for (goe-api.js STATUS_PATH /
// STATUS_FILTER). amp and wh are requested like in Node-RED but not decoded.
const (
	StatusPath   = "/api/status"
	StatusFilter = "nrg,car,alw,amp,wh"
	// NrgTotalPowerIdx is the TOTAL charging power in the nrg array, in W
	// (API v2; v1 used 0.01 kW). Pinned, never guessed.
	NrgTotalPowerIdx = 11
	// Family is the only register-map family of this transport (the HTTP API
	// is self-describing).
	Family = "goe_http_api"
)

// CarStates maps the go-e carState codes onto the honest labels; every other
// value (null, 6 = Initializing on firmware 60.x, 2.5, a string) is "unknown".
var CarStates = map[int]string{
	0: "unknown", // Unknown/Error
	1: "idle",    // no car connected
	2: "charging",
	3: "waiting",  // WaitCar
	4: "complete", // finished, car still connected
	5: "error",
}

// Result is decodeStatus's { reading, carState, charging, allowed }.
type Result struct {
	// LoadKw is the charging power in kW, clamped >= 0. nil = nrg[11] absent
	// or not a finite number: OMITTED, never fabricated to 0. A real 0 is kept.
	LoadKw   *float64
	CarState string
	Charging bool
	// Allowed is alw ("may the car charge at all now?"), nil when not a bool.
	Allowed *bool
}

// ErrNotJSON is what JSON.parse throwing becomes: the flow drops the answer.
var ErrNotJSON = errors.New("go-e: Antwort ist kein JSON")

// StatusURL is goe-api.js statusUrl: plain http (go-e is a LAN HTTP device),
// the port only when set.
func StatusURL(host string, port int) string {
	portPart := ""
	if port != 0 {
		portPart = ":" + strconv.Itoa(port)
	}
	return "http://" + host + portPart + StatusPath + "?filter=" + StatusFilter
}

// Decode parses a raw /api/status body like JSON.parse and decodes it like
// decodeStatus. ErrNotJSON when the body is not JSON; (nil, nil) when it is
// JSON but not an object (decodeStatus returns null).
func Decode(body []byte) (*Result, error) {
	v, err := parseJS(body)
	if err != nil {
		return nil, ErrNotJSON
	}
	return DecodeValue(v), nil
}

// DecodeValue is decodeStatus on an already parsed value (numbers as
// json.Number, see parseJS).
func DecodeValue(v any) *Result {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	res := &Result{}
	if nrg, ok := obj["nrg"].([]any); ok && len(nrg) > NrgTotalPowerIdx {
		if w, ok := num(nrg[NrgTotalPowerIdx]); ok {
			// W -> kW, clamped >= 0, then round3 - in the JS operation order:
			// round3(Math.max(0, w) / 1000).
			kw := round3(math.Max(0, w) / 1000)
			res.LoadKw = &kw
		}
	}
	res.CarState = CarState(obj["car"])
	res.Charging = res.CarState == "charging"
	if b, ok := obj["alw"].(bool); ok {
		res.Allowed = &b
	}
	return res
}

// CarState is goe-api.js carState: a finite number that is exactly one of
// the known codes, else "unknown".
func CarState(v any) string {
	c, ok := num(v)
	if !ok || c != math.Trunc(c) {
		return "unknown"
	}
	if c < 0 || c > 5 {
		return "unknown"
	}
	return CarStates[int(c)]
}

// num is goe-api.js num(): a finite number, else not ok. Strings, booleans,
// null, arrays and objects are NOT numbers (no coercion).
func num(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(n), 64)
	// Out of range: JSON.parse yields ±Infinity, which is not finite either.
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

// parseJS reads one JSON value the way JSON.parse does for the shapes that
// matter here: numbers stay json.Number (so 1e400 is not a parse error but a
// non-finite number), duplicate keys keep the last value, and anything after
// the value except whitespace is an error.
func parseJS(body []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

// jsRound is Math.round: half towards +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func round3(x float64) float64 { return jsRound(x*1000) / 1000 }
