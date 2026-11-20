package steuerplan

import (
	"math"
	"regexp"
	"strconv"
)

// The Deye register facts and the capability decision of
// inverter-control-routing.js. Every number is the original's; the comments
// there carry the evidence (ha-solarman maps, the live probes of the pilot).

// DeyeControlReg is one battery-hybrid family's ToU control map.
type DeyeControlReg struct {
	EnergyPattern       int
	WorkMode            int
	MaxSellPower        int
	SolarSell           int
	TouEnable           int
	ProgTimeBase        int
	ProgPowerBase       int
	ProgSocBase         int
	ProgChargeBase      int
	MaxChargeCurrent    int
	MaxDischargeCurrent int
	ExportLimit         int
	ExportLimitScale    int
}

// deyeControlReg is DEYE_CONTROL_REG.
var deyeControlReg = map[string]DeyeControlReg{
	"hybrid_3p": {
		EnergyPattern: 0x008d, WorkMode: 0x008e, MaxSellPower: 0x008f, SolarSell: 0x0091,
		TouEnable: 0x0092, ProgTimeBase: 0x0094, ProgPowerBase: 0x009a, ProgSocBase: 0x00a6,
		ProgChargeBase: 0x00ac, MaxChargeCurrent: 0x006c, MaxDischargeCurrent: 0x006d,
		ExportLimit: 0x00e7, ExportLimitScale: 10,
	},
	"hybrid_1p": {
		EnergyPattern: 0x00f3, WorkMode: 0x00f4, MaxSellPower: 0x00f5, SolarSell: 0x00f7,
		TouEnable: 0x00f8, ProgTimeBase: 0x00fa, ProgPowerBase: 0x0100, ProgSocBase: 0x010c,
		ProgChargeBase: 0x0112, MaxChargeCurrent: 0x00d2, MaxDischargeCurrent: 0x00d3,
		ExportLimit: 0x00f5, ExportLimitScale: 1,
	},
}

// DeyeFamilyControlReg is the family's control map (ok=false: string/micro).
func DeyeFamilyControlReg(family string) (DeyeControlReg, bool) {
	r, ok := deyeControlReg[family]
	return r, ok
}

// The enum values the ToU path writes (ha-solarman definitions).
const (
	deyeWorkModeExportFirst      = 0
	deyeWorkModeZeroExportToLoad = 1
	deyeWorkModeZeroExportToCT   = 2

	deyeEnergyPatternBatteryFirst = 0
	deyeEnergyPatternLoadFirst    = 1

	deyeSolarSellOn = 1

	deyeTouEnabledAllWeek = 0x00ff
	deyeTouEnableBit      = 0x0001

	deyeProgChargeDisabled = 0
	deyeProgChargeGrid     = 1

	// DeyeControlSlot is the ONE live ToU program (Program 1).
	DeyeControlSlot = 0
	// deyeProgramTimeBaseHHMM: Program 1 starts at 00:00, the day's base window.
	deyeProgramTimeBaseHHMM = 0
)

// The Deye REMOTE block 1100-1121 (PR #978 layout) - the Tier-2 interface.
const (
	DeyeRegRemoteMode       = 0x044c // 1100
	DeyeRegWatchdog         = 0x044d // 1101
	DeyeRegPowerControlMode = 0x0450 // 1104
	DeyeRegBatteryStrategy  = 0x0451 // 1105
	DeyeRegConstantSoc      = 0x0454 // 1108
	DeyeRegConstantPower    = 0x0455 // 1109
	DeyeRegPvMaxPower       = 0x045b // 1115
	DeyeRegRemoteStatus     = 0x0461 // 1121

	deyeRemoteProbeAddr  = 0x044c
	deyeRemoteProbeCount = 22
	deyeDeviceReg        = 0x0000

	deyeRemoteModeOff = 0
	deyeRemoteModeOn  = 1

	// DeyeRemoteLayoutPR978 is the only layout the adapter writes.
	DeyeRemoteLayoutPR978 = "pr978"

	deyePowerControlAcSide      = 0
	deyePowerControlBatterySide = 1
	deyePowerControlGridSide    = 2

	deyePvMaxPermilleLimit = 999

	deyeStrategyPower    = 2
	deyeStrategyPowerSoc = 5

	deyeRemoteUnitsPerRated = 1000
	deyeRemoteSetpointLimit = 1200

	deyeRemoteWatchdogDefaultS = 60
	deyeRemoteWatchdogMinS     = 10
	deyeRemoteWatchdogMaxS     = 18000

	// deyeRemoteCfgReassertS re-asserts the remote configuration registers.
	deyeRemoteCfgReassertS = 300

	// The two Deye control paths.
	DeyePathRemote = "remote"
	DeyePathTou    = "tou"

	// deyePathContraryN definitive contrary verdicts flip a decided path.
	deyePathContraryN = 3

	deyeWriteFC16 = 16
	deyeWriteFC6  = 6
)

var (
	deyeDeviceTypesLV = []int{0x0005, 0x0500}
	deyeDeviceTypesHV = []int{0x0006, 0x0007, 0x0600, 0x0008, 0x0601}
)

// deyeGridTestSide is the grid-setpoint test's side vocabulary.
var deyeGridTestSide = map[string]int{
	"battery": deyePowerControlBatterySide,
	"grid":    deyePowerControlGridSide,
	"ac":      deyePowerControlAcSide,
}

// deyeGridTestSteps are the steps the core may command.
var deyeGridTestSteps = map[string]bool{
	"neutral": true, "halten": true, "pv_kappe": true, "schritt": true,
	"null_export": true, "ac_probe": true, "rueckkehr": true,
}

// ResolveDeyeWriteFc is FC16 unless the connection flips back to FC6.
func ResolveDeyeWriteFc(conn Obj) int {
	v := get(conn, "control_write_fc")
	if (isNum(v) && num(v) == 6) || v == "6" {
		return deyeWriteFC6
	}
	return deyeWriteFC16
}

// controlTier: the battery-control primitive (READ_ONLY 0, SUNSPEC 1,
// VENDOR_EMS 2, TOU 3).
const (
	TierReadOnly  = 0
	TierSunspec   = 1
	TierVendorEMS = 2
	TierTou       = 3
)

func inferTierFromCommunication(comm any) int {
	switch comm {
	case CommSolarman:
		return TierTou
	case "modbus_tcp", "fronius_solar_api":
		return TierSunspec
	case "kostal_modbus", "huawei_modbus":
		return TierVendorEMS
	}
	return TierReadOnly
}

// ResolveControlTier prefers the selection's control_tier, else infers it.
func ResolveControlTier(sel Obj) int {
	t := get(sel, "control_tier")
	if isNum(t) {
		f := num(t)
		if finite(f) && f >= 0 && f <= 3 {
			return int(math.Floor(f))
		}
	}
	if sel == nil {
		return inferTierFromCommunication("")
	}
	return inferTierFromCommunication(get(sel, "communication"))
}

// CommSolarman is the Deye logger transport.
const CommSolarman = "solarman_v5"

// resolveDeyePowerScale: explicit power_scale, else the device-detected class,
// else 1 unconfirmed.
func resolveDeyePowerScale(conn, cap Obj) (scale int, confirmed bool, source string) {
	if v := num(get(conn, "power_scale")); v == 1 || v == 10 {
		return int(v), true, "config"
	}
	if d := num(get(cap, "scaleClass")); d == 1 || d == 10 {
		return int(d), true, "device"
	}
	return 1, false, "fallback"
}

// DeyeCapabilityProbeSpec is the capability probe of a battery-hybrid family
// (nil for string/micro).
func DeyeCapabilityProbeSpec(family string) *ProbeSpec {
	if _, ok := DeyeFamilyControlReg(family); !ok {
		return nil
	}
	return &ProbeSpec{Reads: []ReadOp{
		{Role: "device_type", Addr: deyeDeviceReg, Count: 1},
		{Role: "remote_block", Addr: deyeRemoteProbeAddr, Count: deyeRemoteProbeCount},
	}}
}

func inRangeI(v, lo, hi int) bool { return v >= lo && v <= hi }

func plausibleWatchdog(v int) bool {
	return v == WatchdogOff || inRangeI(v, deyeRemoteWatchdogMinS, deyeRemoteWatchdogMaxS)
}

func s16(raw int) int {
	v := raw & 0xffff
	if v > 0x7fff {
		return v - 0x10000
	}
	return v
}

// DeyeProbe is one capability probe result.
type DeyeProbe struct {
	DeviceType  *int
	RemoteBlock []int
	Error       string
	// Definitive is p.definitive: nil = absent.
	Definitive *bool
}

func containsInt(list []int, v float64) bool {
	for _, x := range list {
		if float64(x) == v {
			return true
		}
	}
	return false
}

// ClassifyDeyeCapability is the pure classifier of a probe (report §8.1). The
// result is an Obj because it travels as the flow context's JSON record.
func ClassifyDeyeCapability(p DeyeProbe) Obj {
	dev := math.NaN()
	if p.DeviceType != nil {
		dev = float64(*p.DeviceType)
	}
	var scaleClass any
	if containsInt(deyeDeviceTypesHV, dev) {
		scaleClass = 10.0
	} else if containsInt(deyeDeviceTypesLV, dev) {
		scaleClass = 1.0
	}
	definitive := p.Definitive == nil || *p.Definitive
	out := Obj{
		"present": false, "layout": nil, "supported": false, "path": DeyePathTou,
		"scaleClass": scaleClass, "watchdogRaw": nil, "statusRaw": nil,
		"reason": "", "definitive": definitive,
	}
	block := p.RemoteBlock
	if block == nil || len(block) < 22 {
		if p.Error != "" {
			out["reason"] = "Remote-Mode-Register nicht lesbar: " + p.Error
			out["definitive"] = p.Definitive != nil && *p.Definitive
		} else {
			out["reason"] = "Remote-Mode-Register nicht lesbar (Firmware ohne Fernsteuerung) - Zeitfenster-Steuerung (ToU)"
		}
		return out
	}
	allZero := true
	for i := 0; i < 22; i++ {
		if block[i]&0xffff != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		out["definitive"] = false
		out["reason"] = "Wechselrichter über den Logger gerade nicht erreichbar (Null-Antwort auf die " +
			"Fähigkeitsprüfung) - erneuter Versuch folgt"
		return out
	}
	at := func(reg int) int { return block[reg-1100] & 0xffff }
	mode := at(1100)
	wd := at(1101)
	out["watchdogRaw"] = float64(wd)
	out["statusRaw"] = float64(at(1121))
	modeOk := inRangeI(mode, 0, 3)
	wdOk := plausibleWatchdog(wd)
	if modeOk && wdOk && inRangeI(at(1104), 0, 2) && inRangeI(at(1105), 0, 5) {
		out["present"], out["layout"], out["supported"], out["path"] = true, DeyeRemoteLayoutPR978, true, DeyePathRemote
		out["reason"] = "Fernsteuerung (Remote Mode) verfügbar"
		return out
	}
	if modeOk && wdOk && inRangeI(at(1106), 0, 1) && inRangeI(s16(at(1111)), -deyeRemoteSetpointLimit, deyeRemoteSetpointLimit) {
		out["present"], out["layout"], out["supported"] = true, "v105_1", false
		out["reason"] = "Fernsteuerung in der älteren V105.1-Registerlage (AC-seitiger Sollwert 1111) - " +
			"diese Variante steuert nicht batterieseitig und wird nicht geschrieben; Zeitfenster-Steuerung (ToU)"
		return out
	}
	out["reason"] = "Fernsteuerung auf dieser Firmware nicht vorhanden - Zeitfenster-Steuerung (ToU)"
	return out
}

// DeyeControlPath is the path a (possibly absent) capability selects.
func DeyeControlPath(cap Obj) string {
	if cap != nil && isTrue(get(cap, "present")) && isTrue(get(cap, "supported")) {
		return DeyePathRemote
	}
	return DeyePathTou
}

func stickyPath(s Obj) string {
	p := str(get(s, "path"))
	if p == DeyePathRemote || p == DeyePathTou {
		return p
	}
	return ""
}

// DeyeUpdateSticky is the pure decision update from a fresh verdict. It
// returns prev itself when nothing changed (a transient verdict is no
// evidence), so callers can compare before persisting.
func DeyeUpdateSticky(prev Obj, verdict Obj, nowMs float64) Obj {
	p := prev
	if verdict == nil || isFalse(get(verdict, "definitive")) {
		return p
	}
	vPath := DeyeControlPath(verdict)
	everRemote := (p != nil && isTrue(get(p, "everRemote"))) || vPath == DeyePathRemote
	if p == nil || stickyPath(p) == "" {
		return Obj{"path": vPath, "since": nowMs, "contrary": 0.0, "everRemote": everRemote, "verdict": verdict, "verdictAt": nowMs}
	}
	if vPath == stickyPath(p) {
		return Obj{"path": stickyPath(p), "since": jsv(get(p, "since")), "contrary": 0.0, "everRemote": everRemote, "verdict": verdict, "verdictAt": nowMs}
	}
	c := num(get(p, "contrary"))
	if math.IsNaN(c) {
		c = 0
	}
	contrary := c + 1
	if contrary >= deyePathContraryN {
		return Obj{"path": vPath, "since": nowMs, "contrary": 0.0, "everRemote": everRemote, "verdict": verdict, "verdictAt": nowMs}
	}
	return Obj{"path": stickyPath(p), "since": jsv(get(p, "since")), "contrary": contrary, "everRemote": everRemote, "verdict": verdict, "verdictAt": nowMs}
}

// DeyeSeedStickyFromGrant seeds the decision from a remote-proven First-Light
// grant (nil when the grant carries no remote path).
func DeyeSeedStickyFromGrant(setpoint Obj, nowMs float64) Obj {
	if isTrue(get(setpoint, "device_certified")) && get(setpoint, "device_certified_path") == DeyePathRemote {
		return Obj{"path": DeyePathRemote, "since": nowMs, "contrary": 0.0, "everRemote": true, "seededFromGrant": true}
	}
	return nil
}

func scaleClassOf(c Obj) any {
	v := get(c, "scaleClass")
	if isNum(v) && (num(v) == 1 || num(v) == 10) {
		return num(v)
	}
	return nil
}

// DeyeEffectiveCap is the capability the adapters plan by: a decided sticky
// path wins over a raw verdict; without one the raw cap passes through.
func DeyeEffectiveCap(cap, sticky Obj) Obj {
	path := stickyPath(sticky)
	if path == "" {
		return cap
	}
	if cap != nil && !isFalse(get(cap, "definitive")) && DeyeControlPath(cap) == path {
		return cap
	}
	if v := obj(get(sticky, "verdict")); v != nil && DeyeControlPath(v) == path {
		return v
	}
	var scaleClass any
	if sc := scaleClassOf(cap); sc != nil {
		scaleClass = sc
	} else if v := obj(get(sticky, "verdict")); v != nil {
		scaleClass = scaleClassOf(v)
	}
	if path == DeyePathRemote {
		layout := any(DeyeRemoteLayoutPR978)
		if v := obj(get(sticky, "verdict")); v != nil && truthy(get(v, "layout")) {
			layout = get(v, "layout")
		}
		return Obj{
			"present": true, "supported": true, "path": DeyePathRemote,
			"layout": layout, "scaleClass": scaleClass,
			"definitive": true, "sticky": true,
			"reason": "Fernsteuerung (Remote Mode) - nachgewiesener Steuerpfad dieses Geräts",
		}
	}
	return Obj{
		"present": false, "supported": false, "path": DeyePathTou, "layout": nil, "scaleClass": scaleClass,
		"definitive": true, "sticky": true,
		"reason": "Zeitfenster-Steuerung (ToU) - entschiedener Steuerpfad dieses Geräts",
	}
}

// truthy is JavaScript truthiness.
func truthy(v any) bool {
	switch x := v.(type) {
	case undef, nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

var probeErrorDefinitive = regexp.MustCompile(`(?i)Modbus-Ausnahme 0x0[123]\b`)

// DeyeProbeErrorDefinitive: only the exceptions that indict the REQUEST
// (0x01/0x02/0x03) are a definitive "block not implemented".
func DeyeProbeErrorDefinitive(message string) bool {
	return probeErrorDefinitive.MatchString(message)
}

// ResolveDeyeRemoteWatchdog is the dead-man's timeout for 1101 (10..18000 s,
// else 60 s; never "off" from config).
func ResolveDeyeRemoteWatchdog(conn Obj) int {
	v := num(get(conn, "remote_watchdog_s"))
	if finite(v) && v >= deyeRemoteWatchdogMinS && v <= deyeRemoteWatchdogMaxS {
		return int(round(v))
	}
	return deyeRemoteWatchdogDefaultS
}

func resolveDeyeRemoteStrategy(conn Obj) int {
	if num(get(conn, "remote_battery_strategy")) == deyeStrategyPowerSoc {
		return deyeStrategyPowerSoc
	}
	return deyeStrategyPower
}

// SetpointUnits is a converted 1109 value.
type SetpointUnits struct {
	Units   int
	Raw     int
	Clamped bool
	OK      bool
}

func setpointUnits(exact float64) SetpointUnits {
	units := int(round(exact))
	clamped := units > deyeRemoteSetpointLimit || units < -deyeRemoteSetpointLimit
	if units > deyeRemoteSetpointLimit {
		units = deyeRemoteSetpointLimit
	}
	if units < -deyeRemoteSetpointLimit {
		units = -deyeRemoteSetpointLimit
	}
	return SetpointUnits{Units: units, Raw: units & 0xffff, Clamped: clamped, OK: true}
}

// DeyeRemoteSetpointUnits: register 1109 is the NEGATED per-mille of rated
// (Deye - = charge, our contract + = charge).
func DeyeRemoteSetpointUnits(kw, ratedKw float64) SetpointUnits {
	if !finite(kw) || !(ratedKw > 0) {
		return SetpointUnits{}
	}
	return setpointUnits(float64(-(kw / ratedKw)) * deyeRemoteUnitsPerRated)
}

// DeyeGridSetpointUnits: the grid/AC-side setpoint is NOT negated.
func DeyeGridSetpointUnits(kw, ratedKw float64) SetpointUnits {
	if !finite(kw) || !(ratedKw > 0) {
		return SetpointUnits{}
	}
	return setpointUnits(float64(kw/ratedKw) * deyeRemoteUnitsPerRated)
}

// gridTest is the parsed grid-setpoint test instruction.
type gridTest struct {
	step, side    string
	targetKw      float64
	neutralize    bool
	pvCapPermille *int
}

func parseGridTest(v any) *gridTest {
	o := obj(v)
	if o == nil {
		return nil
	}
	step, side := str(get(o, "step")), str(get(o, "side"))
	if !deyeGridTestSteps[step] {
		return nil
	}
	if _, ok := deyeGridTestSide[side]; !ok {
		return nil
	}
	if !isFiniteNum(get(o, "target_kw")) {
		return nil
	}
	out := &gridTest{step: step, side: side, targetKw: num(get(o, "target_kw")), neutralize: isTrue(get(o, "neutralize"))}
	capV := num(get(o, "pv_cap_permille"))
	if finite(capV) && capV >= 1 && capV <= deyePvMaxPermilleLimit {
		out.pvCapPermille = ptr(int(round(capV)))
	}
	return out
}

// DeyeSnapshotSpec is the ordered set of ToU control registers the executor
// captures before its first write; touEnable is LAST.
func DeyeSnapshotSpec(reg DeyeControlReg, slot int) []SnapshotReg {
	spec := []SnapshotReg{
		{"energy_pattern", reg.EnergyPattern},
		{"work_mode", reg.WorkMode},
		{"max_sell_power", reg.MaxSellPower},
		{"solar_sell", reg.SolarSell},
		{"program_time", reg.ProgTimeBase + slot},
		{"battery_power", reg.ProgPowerBase + slot},
		{"battery_target_soc", reg.ProgSocBase + slot},
		{"grid_charge_enable", reg.ProgChargeBase + slot},
	}
	if reg.ExportLimit != reg.MaxSellPower {
		spec = append(spec, SnapshotReg{"export_limit", reg.ExportLimit})
	}
	return append(spec, SnapshotReg{"tou_enable", reg.TouEnable})
}

// DeyeProgramTimeAddrs are the six ToU program start-time registers.
func DeyeProgramTimeAddrs(reg DeyeControlReg) []int {
	out := make([]int, 6)
	for i := range out {
		out[i] = reg.ProgTimeBase + i
	}
	return out
}

// DeyeHhmmToMinutes decodes a ToU start time (decimal HHMM).
func DeyeHhmmToMinutes(hhmm any) float64 {
	v := num(hhmm)
	if !finite(v) || v == 0 {
		v = 0
	}
	return math.Floor(v/100)*60 + math.Mod(v, 100)
}

// DeyeProgram1Displaced (N2): a later program has already started, so
// Program 1 does not govern now.
func DeyeProgram1Displaced(times []any, nowMinutes float64) bool {
	if len(times) < 2 {
		return false
	}
	p1 := DeyeHhmmToMinutes(times[0])
	for _, t := range times[1:] {
		s := DeyeHhmmToMinutes(t)
		if s > p1 && s <= nowMinutes {
			return true
		}
	}
	return false
}

// snapshotValue reads snapshot[addr] (undefined -> ok=false).
func snapshotValue(snapshot Obj, addr int) (int, bool) {
	if snapshot == nil {
		return 0, false
	}
	v, ok := snapshot[strconv.Itoa(addr)]
	if !ok {
		return 0, false
	}
	return u16(num(v)), true
}

func portOr(conn Obj, key string, def float64) float64 {
	if n := num(get(conn, key)); n > 0 {
		return n
	}
	return def
}
