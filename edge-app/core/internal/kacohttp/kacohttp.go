// Package kacohttp is the Go twin of edge-app/nodered/kaco/kaco-http.js: the
// AISWEI/Solplanet platform KACO sells as blueplanet NX1/NX3 and hybrid NH3,
// read over the local HTTP-JSON API on port 8484 of its communication unit.
// That API runs PARALLEL to the KACO cloud (Modbus TCP on the stick would take
// the customer's app away), so it is the default way of this platform.
//
// Two families, because of the PV source: a string device's AC power IS the
// generation; a hybrid's AC power is PV + discharge - charge, so its PV comes
// from the DC strings (sum of vpv x ipv). The inverter serial is a required
// parameter of every measurement call and is NEVER guessed: without one the
// inventory names it.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kaco/kaco-http-vectors.json, GENERATED from the JS module
// (kaco-http-vectors.gen.js) - including whole read cycles against a scripted
// HTTP module; this package's test reads that file.
//
// Read only.
package kacohttp

import (
	"context"
	"math"
	"strconv"
	"strings"
	"sync"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/jsnum"
)

// Families of this transport.
const (
	FamilyString = "kaco_http"
	FamilyHybrid = "kaco_http_hybrid"
)

// Known reports whether family is one of the two families.
func Known(family string) bool { return family == FamilyString || family == FamilyHybrid }

// HasBattery is FAMILIES[family].hasBattery.
func HasBattery(family string) bool { return family == FamilyHybrid }

// DefaultPort is the API's port.
const DefaultPort = 8484

// Device numbers of the 8484 API.
const (
	DeviceInverter = 2
	DeviceMeter    = 3
	DeviceBattery  = 4
)

// InventoryURL is inventoryUrl (/getdev.cgi?device=2).
func InventoryURL(scheme, host string, port int) string {
	return scheme + "://" + host + ":" + strconv.Itoa(port) + "/getdev.cgi?device=" + strconv.Itoa(DeviceInverter)
}

// DevDataURL is devDataUrl: the measurements of ONE device of the inverter
// with this serial.
func DevDataURL(scheme, host string, port, device int, serial string) string {
	return scheme + "://" + host + ":" + strconv.Itoa(port) + "/getdevdata.cgi?device=" + strconv.Itoa(device) +
		"&sn=" + encodeURIComponent(serial)
}

// Inventory is one entry of parseInventory.
type Inventory struct {
	Serial  string   `json:"serial"`
	Address *float64 `json:"address"`
	RatedVa *float64 `json:"ratedVa"`
}

// ParseInventory is parseInventory: the inverters of /getdev.cgi?device=2;
// an unusable answer is an empty list, never an error.
func ParseInventory(body []byte) []Inventory {
	out := []Inventory{}
	if body == nil {
		return out
	}
	v, ok := jsnum.ParseJSON(body)
	if !ok {
		return out
	}
	obj := object(v)
	if obj == nil {
		return out
	}
	list, _ := obj["inv"].([]any)
	for _, e := range list {
		m := object(e)
		if m == nil {
			continue
		}
		s, _ := m["isn"].(string)
		s = jsnum.Trim(s)
		if s == "" {
			continue
		}
		out = append(out, Inventory{Serial: s, Address: ptr(num(m["add"])), RatedVa: ptr(num(m["rate"]))})
	}
	return out
}

// Options mirrors decode's opts.
type Options struct {
	Family         string
	InvertGridSign bool
	InvertBattSign bool
}

// Parts are the three raw answers of one cycle (nil = absent).
type Parts struct {
	Inverter, Meter, Battery []byte
}

// Result is decode's answer: the reading (pv_power_kw, power_kw, soc_pct),
// the battery power in VoltPilot's convention (local bus only), the meta
// facts and - from a read cycle - the serial used.
type Result struct {
	Reading map[string]float64
	BattKw  *float64
	Meta    map[string]any
	Serial  string
}

// Decode is decode(): the answers of one cycle as ONE measurement; a missing
// or unreadable answer leaves its channels absent. nil when nothing decoded.
func Decode(p Parts, o Options) *Result {
	reading := map[string]float64{}
	meta := map[string]any{}
	var battKw *float64
	if inv := asObject(p.Inverter); inv != nil {
		decodeInverter(inv, o, reading, meta)
	}
	if m := asObject(p.Meter); m != nil {
		if pac, ok := num(m["pac"]); ok {
			sign := 1.0
			if o.InvertGridSign {
				sign = -1
			}
			reading["power_kw"] = round3(sign * pac / 1000)
		}
	}
	if b := asObject(p.Battery); b != nil {
		battKw = decodeBattery(b, o, reading, meta)
	}
	if len(reading) == 0 && battKw == nil {
		return nil
	}
	return &Result{Reading: reading, BattKw: battKw, Meta: meta}
}

func decodeInverter(obj map[string]any, o Options, reading map[string]float64, meta map[string]any) {
	pac, hasPac := num(obj["pac"])
	if hasPac {
		meta["ac_kw"] = round3(pac / 1000)
	}
	if o.Family == FamilyHybrid {
		// The PV comes from the DC side; without readable strings nothing.
		if dc, ok := stringPowerW(obj); ok {
			reading["pv_power_kw"] = round3(dc / 1000)
			meta["pvSource"] = "dc"
		}
	} else if hasPac {
		reading["pv_power_kw"] = round3(math.Max(0, pac) / 1000)
		meta["pvSource"] = "ac"
	}
	if v, ok := num(obj["fac"]); ok {
		meta["hz"] = round3(v * 0.01)
	}
	if v, ok := num(obj["tmp"]); ok {
		meta["temp_c"] = round1(v * 0.1)
	}
	if v, ok := num(obj["eto"]); ok {
		meta["energy_total_kwh"] = round1(v * 0.1)
	}
	if v, ok := num(obj["etd"]); ok {
		meta["energy_today_kwh"] = round1(v * 0.1)
	}
	if v, ok := num(obj["err"]); ok {
		meta["err"] = v
	}
}

// stringPowerW is the DC input power: sum of vpv[i] x ipv[i] with the
// documented factors; a missing value or unequal lengths is no sum at all.
func stringPowerW(obj map[string]any) (float64, bool) {
	v, okV := obj["vpv"].([]any)
	i, okI := obj["ipv"].([]any)
	if !okV || !okI || len(v) == 0 || len(v) != len(i) {
		return 0, false
	}
	sum := 0.0
	for k := range v {
		vv, ok1 := num(v[k])
		ii, ok2 := num(i[k])
		if !ok1 || !ok2 {
			return 0, false
		}
		sum += float64(vv * 0.1 * ii * 0.01)
	}
	return sum, true
}

func decodeBattery(obj map[string]any, o Options, reading map[string]float64, meta map[string]any) *float64 {
	if soc, ok := num(obj["soc"]); ok && soc > 0 && soc <= 100 {
		reading["soc_pct"] = round1(soc)
	}
	var battKw *float64
	if pb, ok := num(obj["pb"]); ok {
		sign := -1.0 // default: negate (- charge / + discharge on the wire)
		if o.InvertBattSign {
			sign = 1
		}
		b := round3(sign * pb / 1000)
		battKw = &b
	}
	if v, ok := num(obj["vb"]); ok {
		meta["battery_v"] = round1(v * 0.01)
	}
	if v, ok := num(obj["cb"]); ok {
		meta["battery_a"] = round1(v * 0.1)
	}
	if v, ok := num(obj["soh"]); ok {
		meta["soh_pct"] = round1(v)
	}
	if v, ok := num(obj["cst"]); ok {
		meta["charge_state"] = v
	}
	if v, ok := num(obj["bst"]); ok {
		meta["battery_state"] = v
	}
	return battKw
}

// Getter is ONE GET: the body of a 200 answer, else nil (a failure of one
// call is never a failure of the cycle).
type Getter func(ctx context.Context, url string) []byte

// Target is makeKacoHttpReader's target.
type Target struct {
	IP             string
	Port           int
	Scheme         string
	InsecureTLS    bool
	Serial         string
	Family         string
	HasBattery     *bool
	InvertGridSign bool
	InvertBattSign bool
}

// Read is one read cycle (readKaco): without a serial the inventory first
// (never guessed), then inverter, meter and - for a battery family - battery
// in parallel, each isolated. nil when there is no serial or nothing decoded.
func Read(ctx context.Context, get Getter, t Target) *Result {
	ip := jsnum.Trim(t.IP)
	if ip == "" {
		return nil
	}
	port := t.Port
	if port <= 0 {
		port = DefaultPort
	}
	scheme := "http"
	if t.Scheme == "https" || t.InsecureTLS {
		scheme = "https"
	}
	family := t.Family
	if family == "" {
		family = FamilyString
	}
	hasBattery := HasBattery(family)
	if t.HasBattery != nil {
		hasBattery = *t.HasBattery
	}
	serial := jsnum.Trim(t.Serial)
	if serial == "" {
		inv := ParseInventory(get(ctx, InventoryURL(scheme, ip, port)))
		if len(inv) == 0 {
			return nil
		}
		serial = inv[0].Serial
	}
	var parts Parts
	var wg sync.WaitGroup
	fetch := func(dst *[]byte, device int) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			*dst = get(ctx, DevDataURL(scheme, ip, port, device, serial))
		}()
	}
	fetch(&parts.Inverter, DeviceInverter)
	fetch(&parts.Meter, DeviceMeter)
	if hasBattery {
		fetch(&parts.Battery, DeviceBattery)
	}
	wg.Wait()
	res := Decode(parts, Options{Family: family, InvertGridSign: t.InvertGridSign, InvertBattSign: t.InvertBattSign})
	if res == nil {
		return nil
	}
	res.Serial = serial
	return res
}

// asObject is the module's asObject: a JSON object, else nil (arrays too).
func asObject(body []byte) map[string]any {
	if body == nil {
		return nil
	}
	v, ok := jsnum.ParseJSON(body)
	if !ok {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

// object is a JS object for property access (arrays have none of these keys).
func object(v any) map[string]any {
	switch x := v.(type) {
	case map[string]any:
		return x
	case []any:
		return map[string]any{}
	}
	return nil
}

// num is the module's num(): a finite number, or a numeric string as
// Number(v.trim()) - "" is 0, like JS.
func num(v any) (float64, bool) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case string:
		f = jsnum.StringToNumber(x)
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func ptr(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &v
}

// encodeURIComponent escapes everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

// jsRound is Math.round (half up).
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func noNegZero(x float64) float64 {
	if x == 0 {
		return 0
	}
	return x
}

func round3(x float64) float64 { return noNegZero(jsRound(float64(x*1000)) / 1000) }
func round1(x float64) float64 { return noNegZero(jsRound(float64(x*10)) / 10) }
