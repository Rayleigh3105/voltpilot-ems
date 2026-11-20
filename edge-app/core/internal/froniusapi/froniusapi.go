// Package froniusapi is the Go twin of edge-app/nodered/fronius/solar-api.js:
// a Fronius over its local Solar API v1, ONE GET on
// GetPowerFlowRealtimeData.fcgi that carries PV, grid, load and battery SoC
// together (the way Home Assistant reads Fronius). Solar API v1 only - a
// Datamanager 1.0 (v0) has no PowerFlow endpoint and yields no reading.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/fronius/solar-api-vectors.json, GENERATED from the JS module
// (solar-api-vectors.gen.js); this package's test reads that file by path.
//
// Read only: nothing in the Fronius path controls the inverter.
package froniusapi

import (
	"math"
	"strconv"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/jsnum"
)

// Family is the one family of this transport (the Solar API describes itself).
const Family = "fronius_solar_api"

// Known reports whether family is the family this decoder reads.
func Known(family string) bool { return family == Family }

// DefaultPort is the Solar API's HTTP port.
const DefaultPort = 80

// PowerFlowPath is the Solar API v1 PowerFlow endpoint.
const PowerFlowPath = "/solar_api/v1/GetPowerFlowRealtimeData.fcgi"

// PowerFlowURL is powerFlowUrl: https only when asked for (the GEN24 firmware
// that redirects to HTTPS with a self-signed certificate), else http.
func PowerFlowURL(scheme, host string, port int) string {
	s := "http"
	if scheme == "https" {
		s = "https"
	}
	return s + "://" + host + ":" + strconv.Itoa(port) + PowerFlowPath
}

// Result is decodePowerFlow's answer: the flat reading (power_kw +import /
// -export, pv_power_kw, load_kw >= 0, soc_pct) and the battery power the
// Solar API reports, which is calibration only and NEVER published.
type Result struct {
	Reading map[string]float64
	BattKw  *float64
}

// Options mirrors decodePowerFlow's opts.
type Options struct {
	InvertGridSign bool
}

// DecodeBody is the flow's JSON.parse(body) followed by decodePowerFlow: a
// body that is no JSON, or no usable PowerFlow answer, is nil - never a
// fabricated 0.
func DecodeBody(body []byte, o Options) *Result {
	v, ok := jsnum.ParseJSON(body)
	if !ok {
		return nil
	}
	return Decode(v, o)
}

// Decode is decodePowerFlow over a parsed JSON value (numbers as float64,
// ±Inf for a number beyond float64 like JSON.parse).
func Decode(v any, o Options) *Result {
	root, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	data := object(object(root["Body"])["Data"])
	if data == nil {
		return nil
	}
	if head := object(root["Head"]); head != nil {
		if status := object(head["Status"]); status != nil {
			if code, ok := status["Code"].(float64); ok && code != 0 {
				return nil // BadStatus
			}
		}
	}
	site := object(data["Site"])
	if site == nil {
		return nil
	}
	reading := map[string]float64{}
	if g, ok := num(site["P_Grid"]); ok {
		sign := 1.0
		if o.InvertGridSign {
			sign = -1
		}
		reading["power_kw"] = round3(sign * g / 1000)
	}
	if pv, ok := num(site["P_PV"]); ok {
		reading["pv_power_kw"] = round3(math.Max(0, pv) / 1000)
	}
	if load, ok := num(site["P_Load"]); ok {
		reading["load_kw"] = round3(math.Max(0, -load) / 1000)
	}
	if inv := object(data["Inverters"]); inv != nil {
		if first := object(inv["1"]); first != nil {
			if soc, ok := num(first["SOC"]); ok && soc > 0 && soc <= 100 {
				reading["soc_pct"] = round1(soc)
			}
		}
	}
	if len(reading) == 0 {
		return nil
	}
	res := &Result{Reading: reading}
	if akku, ok := num(site["P_Akku"]); ok {
		b := round3(akku / 1000)
		res.BattKw = &b
	}
	return res
}

// object is a JS object for property access: a JSON object, or an array (an
// object without these keys); anything else is nil.
func object(v any) map[string]any {
	switch x := v.(type) {
	case map[string]any:
		return x
	case []any:
		return map[string]any{}
	}
	return nil
}

// num is the module's num(): a finite number, else absent.
func num(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
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
