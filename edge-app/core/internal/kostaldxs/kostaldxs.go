// Package kostaldxs is the Go twin of edge-app/nodered/kostal/kostal-dxs-decode.js:
// the classic KOSTAL PIKO line (3.0-20 / 10-20, web UI from UI 06) over its
// local HTTP-JSON API `/api/dxs.json` (port 80, no authentication for
// measurement values). Scout report:
// firstmate data/vp-kostal-piko20-anbindung/report.md §2.4, §3.1.
//
// String device, no battery - the AC output IS the generation (the same
// FamKacoHTTP lesson). PIKO BA (battery) and pre-UI-06 devices (HTML
// index.fhtml, login pvserver) are deliberately NOT read here - see the
// JS module's header for why.
//
// Node-RED stays the source of truth. Both sides are bound by the shared
// vectors nodered/kostal/kostal-dxs-vectors.json, GENERATED from the JS
// module (kostal-dxs-vectors.gen.js); this package's test reads that file by
// path.
//
// Read only: /api/dxs.json has no documented write path.
package kostaldxs

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Family is the one decode family this package reads.
const Family = "kostal_piko"

// Known reports whether family is a family this decoder reads.
func Known(family string) bool { return family == Family }

// DefaultPort is the local HTTP port of the PIKO's own web server.
const DefaultPort = 80

// DxsPath is the fixed endpoint path.
const DxsPath = "/api/dxs.json"

// dxs ids (report §3.1). Named like the JS module's DXS object.
const (
	DxsACPowerW      = 67109120
	DxsDCPowerTotalW = 33556736

	DxsDC1A = 33555201
	DxsDC1V = 33555202
	DxsDC1W = 33555203
	DxsDC2A = 33555457
	DxsDC2V = 33555458
	DxsDC2W = 33555459
	DxsDC3A = 33555713
	DxsDC3V = 33555714
	DxsDC3W = 33555715

	DxsL1A = 67109377
	DxsL1V = 67109378
	DxsL1W = 67109379
	DxsL2A = 67109633
	DxsL2V = 67109634
	DxsL2W = 67109635
	DxsL3A = 67109889
	DxsL3V = 67109890
	DxsL3W = 67109891

	DxsFreqHz        = 67110400
	DxsCosPhi        = 67110656
	DxsLimitationPct = 67110144
	DxsStatus        = 16780032

	DxsEnergyTotalKwh  = 251658753
	DxsEnergyTodayWh   = 251658754
	DxsOperatingHoursH = 251658496

	DxsType       = 16780544
	DxsSerial     = 16777728
	DxsName       = 16777984
	DxsFwVersion  = 16779265
	DxsHwVersion  = 16779266
	DxsUiVersion  = 16779267
	DxsParVersion = 16779268
)

// StatusLabels names the operating state (dxs 16780032, Betriebsanleitung
// [HB10-20] S. 62).
var StatusLabels = map[int]string{
	0: "Aus",
	1: "Leerlauf",
	2: "Anfahren",
	3: "Einspeisen (MPP)",
	4: "Einspeisen abgeregelt",
}

// FastIDs - the fast tick: powers, strings, phases, status, limitation
// (report §4.6 "etwa 22 Kennungen").
var FastIDs = []int{
	DxsACPowerW, DxsDCPowerTotalW,
	DxsDC1A, DxsDC1V, DxsDC1W,
	DxsDC2A, DxsDC2V, DxsDC2W,
	DxsDC3A, DxsDC3V, DxsDC3W,
	DxsL1A, DxsL1V, DxsL1W,
	DxsL2A, DxsL2V, DxsL2W,
	DxsL3A, DxsL3V, DxsL3W,
	DxsFreqHz, DxsCosPhi, DxsLimitationPct, DxsStatus,
}

// SlowIDs - the energy counters (report §4.6 "einmal je Stunde").
var SlowIDs = []int{DxsEnergyTotalKwh, DxsEnergyTodayWh, DxsOperatingHoursH}

// IdentityIDs - type/serial/versions, read only by the connection test.
var IdentityIDs = []int{DxsType, DxsSerial, DxsName, DxsFwVersion, DxsHwVersion, DxsUiVersion, DxsParVersion}

// PollIDs - FastIDs + SlowIDs, the regular tick's bundle.
var PollIDs = append(append([]int{}, FastIDs...), SlowIDs...)

// AllIDs - PollIDs + IdentityIDs, the connection test's bundle.
var AllIDs = append(append([]int{}, PollIDs...), IdentityIDs...)

// Channel is one DC string or AC phase reading.
type Channel struct {
	VoltageV *float64
	CurrentA *float64
	PowerW   *float64
}

// Meta is decode's diagnostic detail - NOT published to the telemetry bus
// (only Result.Reading is), the same split as kacoserial.Result/huaweidecode.
// Every field is nil when its dxs id was absent or of the wrong type - never
// a fabricated 0 or empty text.
type Meta struct {
	AcKw, DcKw                                      *float64
	DC1, DC2, DC3                                   Channel
	L1, L2, L3                                      Channel
	FreqHz, CosPhi, LimitationPct                   *float64
	Status                                          *float64
	StatusText                                      string
	EnergyTotalKwh, EnergyTodayKwh, OperatingHoursH *float64
	Type, Serial, Name                              string
	FwVersion, HwVersion, UiVersion, ParVersion     string
}

// Result is decode's { reading, meta }.
type Result struct {
	Reading map[string]float64
	Meta    Meta
}

type rawEntry struct {
	DxsID float64     `json:"dxsId"`
	Value interface{} `json:"value"`
}

type rawResponse struct {
	DxsEntries []rawEntry `json:"dxsEntries"`
}

// entriesByID reads every entry's RAW value under its dxsId - NEVER by
// position (the field bug of the customer's legacy system, report §2.2). A
// repeated dxsId lets the LAST entry win, same as a JSON object literal
// would.
func entriesByID(obj rawResponse) map[int]interface{} {
	out := make(map[int]interface{}, len(obj.DxsEntries))
	for _, e := range obj.DxsEntries {
		out[int(e.DxsID)] = e.Value
	}
	return out
}

func numAt(byID map[int]interface{}, id int) (float64, bool) {
	v, ok := byID[id].(float64)
	return v, ok
}

func strAt(byID map[int]interface{}, id int) (string, bool) {
	v, ok := byID[id].(string)
	if !ok {
		return "", false
	}
	t := strings.TrimSpace(v)
	return t, t != ""
}

// round3/round1 - Math.round(x*n)/n. The explicit float64(...) conversion
// breaks the compiler from fusing the multiply into the following rounding
// addition (FMA on arm64 rounds a half-way value differently than plain
// IEEE754 multiply-then-add, the same trap documented at kacoserial.round3 -
// "Rundung: -0,5 W").
func round3(x float64) float64 {
	v := roundHalfUp(float64(x*1000)) / 1000
	if v == 0 {
		return 0
	}
	return v
}

func round1(x float64) float64 {
	v := roundHalfUp(float64(x*10)) / 10
	if v == 0 {
		return 0
	}
	return v
}

// roundHalfUp is JavaScript's Math.round (half towards +Infinity).
func roundHalfUp(x float64) float64 { return math.Floor(x + 0.5) }

func fp(v float64) *float64 { return &v }

func channelAt(byID map[int]interface{}, vID, aID, wID int) Channel {
	var ch Channel
	if v, ok := numAt(byID, vID); ok {
		ch.VoltageV = fp(round1(v))
	}
	if a, ok := numAt(byID, aID); ok {
		ch.CurrentA = fp(round3(a))
	}
	if w, ok := numAt(byID, wID); ok {
		ch.PowerW = fp(round1(w))
	}
	return ch
}

func channelSet(ch Channel) bool { return ch.VoltageV != nil || ch.CurrentA != nil || ch.PowerW != nil }

// Decode brings a raw /api/dxs.json response into the VoltPilot bus form,
// the Go twin of kostal-dxs-decode.js decode(). nil when kaputt JSON or when
// not a single channel was readable.
func Decode(raw []byte) *Result {
	var obj rawResponse
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil
	}
	byID := entriesByID(obj)

	reading := map[string]float64{}
	var meta Meta

	if ac, ok := numAt(byID, DxsACPowerW); ok {
		pv := ac
		if pv < 0 {
			pv = 0
		}
		reading["pv_power_kw"] = round3(pv / 1000)
		meta.AcKw = fp(round3(ac / 1000))
	}
	if dc, ok := numAt(byID, DxsDCPowerTotalW); ok {
		meta.DcKw = fp(round3(dc / 1000))
	}

	meta.DC1 = channelAt(byID, DxsDC1V, DxsDC1A, DxsDC1W)
	meta.DC2 = channelAt(byID, DxsDC2V, DxsDC2A, DxsDC2W)
	meta.DC3 = channelAt(byID, DxsDC3V, DxsDC3A, DxsDC3W)
	meta.L1 = channelAt(byID, DxsL1V, DxsL1A, DxsL1W)
	meta.L2 = channelAt(byID, DxsL2V, DxsL2A, DxsL2W)
	meta.L3 = channelAt(byID, DxsL3V, DxsL3A, DxsL3W)

	if f, ok := numAt(byID, DxsFreqHz); ok {
		meta.FreqHz = fp(round3(f))
	}
	if c, ok := numAt(byID, DxsCosPhi); ok {
		meta.CosPhi = fp(round3(c))
	}
	if l, ok := numAt(byID, DxsLimitationPct); ok {
		meta.LimitationPct = fp(round1(l))
	}
	if s, ok := numAt(byID, DxsStatus); ok {
		meta.Status = fp(s)
		if label, known := StatusLabels[int(s)]; known {
			meta.StatusText = label
		} else {
			meta.StatusText = unknownStatusText(s)
		}
	}
	if e, ok := numAt(byID, DxsEnergyTotalKwh); ok {
		meta.EnergyTotalKwh = fp(round1(e))
	}
	if e, ok := numAt(byID, DxsEnergyTodayWh); ok {
		meta.EnergyTodayKwh = fp(round3(e / 1000))
	}
	if h, ok := numAt(byID, DxsOperatingHoursH); ok {
		meta.OperatingHoursH = fp(h)
	}
	if s, ok := strAt(byID, DxsType); ok {
		meta.Type = s
	}
	if s, ok := strAt(byID, DxsSerial); ok {
		meta.Serial = s
	}
	if s, ok := strAt(byID, DxsName); ok {
		meta.Name = s
	}
	if s, ok := strAt(byID, DxsFwVersion); ok {
		meta.FwVersion = s
	}
	if s, ok := strAt(byID, DxsHwVersion); ok {
		meta.HwVersion = s
	}
	if s, ok := strAt(byID, DxsUiVersion); ok {
		meta.UiVersion = s
	}
	if s, ok := strAt(byID, DxsParVersion); ok {
		meta.ParVersion = s
	}

	if len(reading) == 0 && !metaHasAnyField(meta) {
		return nil
	}
	return &Result{Reading: reading, Meta: meta}
}

func metaHasAnyField(m Meta) bool {
	return m.AcKw != nil || m.DcKw != nil || channelSet(m.DC1) || channelSet(m.DC2) || channelSet(m.DC3) ||
		channelSet(m.L1) || channelSet(m.L2) || channelSet(m.L3) || m.FreqHz != nil || m.CosPhi != nil ||
		m.LimitationPct != nil || m.Status != nil || m.EnergyTotalKwh != nil || m.EnergyTodayKwh != nil ||
		m.OperatingHoursH != nil || m.Type != "" || m.Serial != "" || m.Name != "" || m.FwVersion != "" ||
		m.HwVersion != "" || m.UiVersion != "" || m.ParVersion != ""
}

func unknownStatusText(code float64) string {
	if code == float64(int64(code)) {
		return "unbekannt (" + strconv.FormatInt(int64(code), 10) + ")"
	}
	return "unbekannt (" + strconv.FormatFloat(code, 'g', -1, 64) + ")"
}

// DxsURL builds the GET URL exactly like kostal-dxs-decode.js dxsUrl: a
// repeated `dxsEntries` parameter, in request order.
func DxsURL(scheme, host string, port int, ids []int) string {
	if scheme == "" {
		scheme = "http"
	}
	if port <= 0 {
		port = DefaultPort
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = "dxsEntries=" + strconv.Itoa(id)
	}
	return scheme + "://" + host + ":" + strconv.Itoa(port) + DxsPath + "?" + strings.Join(parts, "&")
}
