package steuerplan

import "math"

// The CHARGE side of the Deye remote tier (K5): the Go twin of
// edge-app/nodered/deye-charge-side.js - two hand-over candidates, grid_zero
// ("netzseitig Ziel 0") and own_config ("Eigenkonfiguration"), each released
// only by its own certificate entry or run by the core's armed pilot window,
// and the decision table that reads the device's own configuration (E5 A:
// read, never write).

var chargeIntents = map[string]bool{"surplus_charge": true, "self_consumption": true}

var chargeCandidates = map[string]bool{"grid_zero": true, "own_config": true}

// gridZeroPvMaxPermille is 1115 in grid mode (never 1000 or above).
const gridZeroPvMaxPermille = 999

// ownConfigBlockSpec is ONE FC3 read Energy Pattern .. Program 6 Charging.
func ownConfigBlockSpec(reg DeyeControlReg) ReadOp {
	return ReadOp{Role: "own_config", FC: 3, Addr: reg.EnergyPattern, Count: reg.ProgChargeBase + 6 - reg.EnergyPattern}
}

// programOneReads are the three single reads of the E-down hand-over.
func programOneReads(reg DeyeControlReg) []ReadOp {
	return []ReadOp{
		{Role: "tou_enable", FC: 3, Addr: reg.TouEnable},
		{Role: "program_target_soc", FC: 3, Addr: reg.ProgSocBase + DeyeControlSlot},
		{Role: "grid_charge_enable", FC: 3, Addr: reg.ProgChargeBase + DeyeControlSlot},
	}
}

// coverLoadPreconditions are the reads before the E-down hand-over.
func coverLoadPreconditions(reg DeyeControlReg) []ReadOp {
	return append(programOneReads(reg), ownConfigBlockSpec(reg))
}

// PrecondOpts is what the executor read and the core said, for the runtime
// refusal: the device's own configuration record (deye_native_cfg), the
// platform's reserve floor and the site's EEG posture.
type PrecondOpts struct {
	OwnConfig Obj
	FloorPct  any
	SolarOnly bool
}

// chargeCandidate is one hand-over candidate.
type chargeCandidate struct {
	planned         []WriteOp
	readbacks       []ReadOp
	preconditions   []ReadOp
	precondition    func(o PrecondOpts, intent string) string
	heartbeat       bool
	curtailsOwnPv   bool
	windowSupported bool
}

// deyeChargeSideCandidates are the two candidates' plans for one selection.
func deyeChargeSideCandidates(reg DeyeControlReg, writeFc, watchdogS int) map[string]*chargeCandidate {
	legacyPre := programOneReads(reg)
	ram := func(w WriteOp) WriteOp { w.Always, w.BenchPending = true, true; return w }
	ramCfg := func(w WriteOp) WriteOp { w.ReassertS, w.BenchPending = deyeRemoteCfgReassertS, true; return w }
	gridPlanned := []WriteOp{
		ram(WriteOp{Role: "remote_watchdog", FC: writeFc, Addr: DeyeRegWatchdog, Value: watchdogS & 0xffff,
			Encode: map[string]any{"kind": "remote_watchdog_s", "seconds": float64(watchdogS)}}),
		ram(WriteOp{Role: "grid_power", FC: writeFc, Addr: DeyeRegConstantPower, Value: 0,
			Encode: map[string]any{"kind": "grid_power_permille", "kw": 0.0, "neutral_before_side_switch": true}}),
		ramCfg(WriteOp{Role: "power_control_mode", FC: writeFc, Addr: DeyeRegPowerControlMode, Value: deyePowerControlGridSide,
			Encode: map[string]any{"kind": "remote_power_control_mode", "enum": "grid_side"}}),
		ramCfg(WriteOp{Role: "pv_max_permille", FC: writeFc, Addr: DeyeRegPvMaxPower, Value: gridZeroPvMaxPermille,
			Encode: map[string]any{"kind": "pv_max_permille", "permille": float64(gridZeroPvMaxPermille)}}),
		ram(WriteOp{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOn,
			Encode: map[string]any{"kind": "remote_mode", "enum": "on", "native": true}}),
	}
	gridReadbacks := make([]ReadOp, len(gridPlanned))
	for i, w := range gridPlanned {
		tol := 0.0
		if w.Role == "grid_power" {
			tol = 1
		}
		gridReadbacks[i] = readback(w.Role, w.Addr, w.Value&0xffff, tol)
	}
	return map[string]*chargeCandidate{
		"grid_zero": {
			planned:       gridPlanned,
			readbacks:     gridReadbacks,
			preconditions: legacyPre,
			precondition: func(o PrecondOpts, _ string) string {
				return deyeGridZeroPrecondition(o.OwnConfig, o.FloorPct, o.SolarOnly)
			},
			heartbeat:     true,
			curtailsOwnPv: true,
		},
		"own_config": {
			planned: []WriteOp{{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOff,
				Encode: map[string]any{"kind": "remote_mode", "enum": "off", "native": true}, BenchPending: true}},
			readbacks:     []ReadOp{readback("remote_mode", DeyeRegRemoteMode, deyeRemoteModeOff, 0)},
			preconditions: append(append([]ReadOp{}, legacyPre...), ownConfigBlockSpec(reg)),
			precondition: func(o PrecondOpts, intent string) string {
				return deyeOwnConfigPrecondition(intent, o.OwnConfig, o.FloorPct, o.SolarOnly, &reg)
			},
		},
	}
}

// regVal is a register value or NaN.
func regVal(v any) float64 {
	if isFiniteNum(v) {
		return num(v)
	}
	return math.NaN()
}

const ownConfigUnknown = "Die eigene Konfiguration des Wechselrichters ist nicht bekannt - es wird nicht umgeschaltet"

// deyeGridZeroPrecondition: what must hold before the grid-side candidate.
func deyeGridZeroPrecondition(cfg Obj, floorPct any, solarOnly bool) string {
	if cfg == nil {
		return ownConfigUnknown
	}
	if !finite(regVal(floorPct)) {
		return "Die Reserve-Untergrenze der Anlage ist nicht bekannt - im netzseitigen Modus achtet der " +
			"Wechselrichter nicht auf seine eigenen Ladegrenzen, es wird nicht umgeschaltet"
	}
	if solarOnly {
		charge := regVal(get(cfg, "grid_charge_enable"))
		if !finite(charge) || charge != deyeProgChargeDisabled {
			return "EEG-Anlage: das Zeitfenster-Programm des Wechselrichters erlaubt das Laden aus dem Netz " +
				"- es wird nicht umgeschaltet"
		}
	}
	return ""
}

// hhmm is minutes since midnight of a decimal HHMM start time, NaN when it
// cannot be a time of day.
func hhmm(v float64) float64 {
	if !finite(v) || v < 0 {
		return math.NaN()
	}
	h := math.Floor(v / 100)
	m := math.Mod(v, 100)
	if h > 23 || m > 59 {
		return math.NaN()
	}
	return h*60 + m
}

// DeyeActiveProgram is the ToU program that governs at nowMin: the latest
// start <= now (ties -> the later program), else the day wraps to the latest
// start. -1 = the times cannot be read.
func DeyeActiveProgram(times []float64, nowMin float64) int {
	if len(times) != 6 || !finite(nowMin) {
		return -1
	}
	mins := make([]float64, 6)
	for i, t := range times {
		mins[i] = hhmm(t)
		if !finite(mins[i]) {
			return -1
		}
	}
	best := -1
	for i := 0; i < 6; i++ {
		if mins[i] <= nowMin && (best < 0 || mins[i] >= mins[best]) {
			best = i
		}
	}
	if best >= 0 {
		return best
	}
	for i := 0; i < 6; i++ {
		if best < 0 || mins[i] >= mins[best] {
			best = i
		}
	}
	return best
}

// deyeOwnConfigPrecondition is the decision table of the own_config candidate
// and of E-down (cover_load): "" when the device may be let go for intent.
func deyeOwnConfigPrecondition(intent string, cfg Obj, floorPct any, solarOnly bool, reg *DeyeControlReg) string {
	if !chargeIntents[intent] && intent != "cover_load" {
		return "Unbekannte Absicht für die Wechselrichter-Automatik"
	}
	if cfg == nil {
		return ownConfigUnknown
	}
	block, _ := get(cfg, "own_config").([]any)
	var spec ReadOp
	if reg != nil {
		spec = ownConfigBlockSpec(*reg)
	}
	if reg == nil || block == nil || len(block) < spec.Count {
		return "Die eigene Konfiguration des Wechselrichters (Arbeitsmodus, Energiemuster, Zeitfenster-Programm) " +
			"konnte nicht gelesen werden - es wird nicht umgeschaltet"
	}
	at := func(addr int) float64 {
		i := addr - spec.Addr
		if i < 0 || i >= len(block) {
			return math.NaN()
		}
		return regVal(block[i])
	}
	workMode := at(reg.WorkMode)
	pattern := at(reg.EnergyPattern)
	solarSell := at(reg.SolarSell)
	tou := at(reg.TouEnable)
	if workMode == deyeWorkModeZeroExportToLoad {
		return "Arbeitsmodus „Zero Export To Load“: der Wechselrichter regelt nur seinen Lastausgang, " +
			"nicht den Netzanschluss - das ist kein Eigenverbrauch am Netzpunkt"
	}
	if workMode != deyeWorkModeExportFirst && workMode != deyeWorkModeZeroExportToCT {
		return "Der Arbeitsmodus des Wechselrichters (" + jsNumberString(workMode) + ") ist unbekannt - es wird nicht umgeschaltet"
	}
	if pattern == deyeEnergyPatternBatteryFirst {
		return "Energiemuster „Battery First“: der Wechselrichter lädt den Speicher vor dem Hausverbrauch - " +
			"das Haus bezöge dabei Strom aus dem Netz"
	}
	if pattern != deyeEnergyPatternLoadFirst {
		return "Das Energiemuster des Wechselrichters (" + jsNumberString(pattern) + ") ist unbekannt - es wird nicht umgeschaltet"
	}
	if workMode == deyeWorkModeZeroExportToCT && solarSell != deyeSolarSellOn {
		return "Nulleinspeisung ohne „Solar Sell“: bei vollem Speicher würde der Wechselrichter seine PV " +
			"abregeln statt einzuspeisen"
	}
	if !finite(tou) {
		return "Das Zeitfenster-Programm des Wechselrichters konnte nicht gelesen werden - es wird nicht umgeschaltet"
	}
	touOn := int64(toInt32(tou))&deyeTouEnableBit != 0
	prog := -1
	if touOn {
		times := make([]float64, 6)
		for i := range times {
			times[i] = at(reg.ProgTimeBase + i)
		}
		prog = DeyeActiveProgram(times, regVal(get(cfg, "now_min")))
		if prog < 0 {
			return "Welches Zeitfenster-Programm gerade gilt, konnte nicht gelesen werden - es wird nicht umgeschaltet"
		}
	}
	progName := "Programm " + itoa(prog+1)
	power, targetSoc, charge := math.NaN(), math.NaN(), math.NaN()
	if touOn {
		power = at(reg.ProgPowerBase + prog)
		targetSoc = at(reg.ProgSocBase + prog)
		charge = at(reg.ProgChargeBase + prog)
	}
	if touOn && solarOnly && charge != deyeProgChargeDisabled {
		return "EEG-Anlage: das gerade gültige Zeitfenster-" + progName + " erlaubt das Laden aus dem Netz " +
			"- es wird nicht umgeschaltet"
	}
	if intent == "surplus_charge" {
		if !touOn {
			return ""
		}
		if !finite(power) {
			return "Die Leistung des Zeitfenster-" + progName + " konnte nicht gelesen werden - es wird nicht umgeschaltet"
		}
		if power > 0 {
			return "Das gerade gültige Zeitfenster-" + progName + " erlaubt dem Wechselrichter zu entladen - " +
				"„nur Überschuss laden“ wäre so nicht gewahrt"
		}
		return ""
	}
	if !touOn {
		return "Das Zeitfenster-Programm (Time of Use) des Wechselrichters ist nicht aktiv - " +
			"ohne es deckt er laut Handbuch nicht den Hausverbrauch aus der Batterie"
	}
	if workMode == deyeWorkModeExportFirst {
		tail := "das ist kein Eigenverbrauch"
		if intent == "cover_load" {
			tail = "„nur Verbrauch decken“ wäre so nicht gewahrt"
		}
		return "Arbeitsmodus „Selling First“ mit aktivem Zeitfenster-Programm: der Wechselrichter darf laut " +
			"Handbuch auch Speicherenergie ins Netz verkaufen - " + tail
	}
	if !finite(power) || !(power > 0) {
		return "Das gerade gültige Zeitfenster-" + progName + " hat keine Entladeleistung - " +
			"der Wechselrichter würde den Hausverbrauch nicht aus der Batterie decken"
	}
	if !finite(targetSoc) || targetSoc < 0 || targetSoc > 100 {
		return "Das Ziel-Ladeniveau des Zeitfenster-" + progName + " konnte nicht gelesen werden - es wird nicht umgeschaltet"
	}
	floor := regVal(floorPct)
	if !finite(floor) {
		return "Die Reserve-Untergrenze der Anlage ist nicht bekannt - es wird nicht umgeschaltet"
	}
	if targetSoc > floor {
		return "Das Ziel-Ladeniveau des Zeitfenster-" + progName + " (" + jsNumberString(targetSoc) + " %) liegt über der " +
			"Reserve-Untergrenze der Anlage (" + jsNumberString(floor) + " %) - der Wechselrichter würde die Deckung zu früh beenden"
	}
	return ""
}

// deyeCoverLoadPrecondition is E-down's runtime refusal: the E row.
func deyeCoverLoadPrecondition(cfg Obj, floorPct any, solarOnly bool, reg *DeyeControlReg) string {
	return deyeOwnConfigPrecondition("cover_load", cfg, floorPct, solarOnly, reg)
}

// nativePilot is the armed pilot window (native_pilot on edge/setpoint).
type nativePilot struct{ candidate, intent, run string }

func parseNativePilot(v any) *nativePilot {
	o := obj(v)
	if o == nil {
		return nil
	}
	c, i := str(get(o, "candidate")), str(get(o, "intent"))
	if !chargeCandidates[c] || !chargeIntents[i] {
		return nil
	}
	return &nativePilot{candidate: c, intent: i, run: str(get(o, "run"))}
}

// chargePick is Box ②'s answer: a candidate (and its entry) or a refusal.
type chargePick struct {
	name    string
	cand    *chargeCandidate
	entry   *NativeCapability
	refusal string
}

// selectDeyeChargeSide: with a pilot exactly its candidate without a
// certificate; else the certified entries for the intent in catalog order.
func selectDeyeChargeSide(catalog []NativeCapability, key NativeKey, intent string, cands map[string]*chargeCandidate,
	windowNarrower bool, pilot *nativePilot, pre PrecondOpts) chargePick {
	try := func(name string, entry *NativeCapability) chargePick {
		cand := cands[name]
		if cand == nil {
			return chargePick{refusal: "Unbekannter Übergabe-Kandidat für die Deye-Ladeseite"}
		}
		if entry != nil && !CertificateMatchesPlan(entry, cand.planned, cand.readbacks) {
			return chargePick{refusal: "Prüfstand-Freigabe und Schreibplan stimmen nicht überein - Freigabe erneuern"}
		}
		if windowNarrower && !(entry != nil && entry.WindowLimits && cand.windowSupported) {
			return chargePick{refusal: "Das Fenster ist enger als der Eigenmodus des Wechselrichters - für Grenzen im Eigenmodus gibt es keine Freigabe"}
		}
		if r := cand.precondition(pre, intent); r != "" {
			return chargePick{refusal: r}
		}
		return chargePick{name: name, cand: cand, entry: entry}
	}
	if pilot != nil {
		if pilot.intent != intent {
			return chargePick{refusal: "Pilotfenster: die Absicht des Sollwerts passt nicht zum gewählten Test"}
		}
		return try(pilot.candidate, nil)
	}
	var entries []*NativeCapability
	for _, e := range ExactCapabilities(key, catalog, CapabilityForIntent(intent)) {
		if e.Candidate != "" {
			entries = append(entries, e)
		}
	}
	if len(entries) == 0 {
		return chargePick{refusal: "Wechselrichter-Automatik für dieses Modell noch nicht am Prüfstand freigegeben"}
	}
	var first *chargePick
	for _, e := range entries {
		r := try(e.Candidate, e)
		if r.refusal == "" {
			return r
		}
		if first == nil {
			first = &r
		}
	}
	return *first
}

// deyeChargeSidePreconditions is the union of the reads the candidates in play
// need, deduplicated by role.
func deyeChargeSidePreconditions(cands map[string]*chargeCandidate, names []string) []ReadOp {
	out := []ReadOp{}
	seen := map[string]bool{}
	for _, n := range names {
		c := cands[n]
		if c == nil {
			continue
		}
		for _, p := range c.preconditions {
			if seen[p.Role] {
				continue
			}
			seen[p.Role] = true
			out = append(out, p)
		}
	}
	return out
}
