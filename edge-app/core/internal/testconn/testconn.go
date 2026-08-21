// Package testconn holds the DTOs for the "Verbindung testen" confirmation
// check: the local web app POSTs an UNSAVED connection form, the core runs a
// bounded, non-retained local-bus round-trip (edge/test-read/request ->
// Node-RED reads the device once with the existing route()+decode ->
// edge/test-read/result), and returns the decoded values or a classified
// error. It NEVER blocks Speichern - a device may legitimately not be wired yet;
// this is a confidence check, not a gate.
//
// The types live in this leaf package so both web (which declares the
// controller interface) and agent (which implements it) can reference them
// without an import cycle, mirroring how inverter/sources/guards own their
// controller DTOs.
package testconn

// Request is the not-yet-saved connection form the web app sends to
// POST /api/test-connection. It mirrors the shared brand/model/connection shape
// of both the inverter selection and an additional source, so ONE endpoint
// serves both forms. Role is optional (only a source carries one) and does not
// change how the device is read - it only steers which reading fields the UI
// shows back.
type Request struct {
	Role       string     `json:"role,omitempty"`
	Brand      string     `json:"brand"`
	Model      string     `json:"model"`
	Family     string     `json:"family,omitempty"`
	Connection Connection `json:"connection"`
	// ControlTest asks for the ADDITIONAL non-disruptive control short-test
	// (D11): go-e - the core re-writes the charger's CURRENT requested
	// current and reads it back (a charging car keeps charging); shelly - a
	// value-identical off-write ONLY while the relay is already off (a
	// running heat cycle is never interrupted; then read-only + honest note).
	// Only honored on an explicit request from the wizard's test button.
	ControlTest bool `json:"control_test,omitempty"`
}

// Connection is the transport connection block. It is a superset of the fields
// the three transports use; unused fields stay zero. It is JSON-compatible with
// inverter.Connection so the agent can map one onto the other.
type Connection map[string]any

// Result is what POST /api/test-connection returns. OK=true carries the decoded
// Reading (only the fields that family/role actually has). OK=false carries an
// ErrorCode the UI maps to one of the honest German failure strings.
type Result struct {
	OK        bool   `json:"ok"`
	ErrorCode string `json:"error_code,omitempty"`
	// Message is an optional, specific German hint for the invalid_request case
	// (e.g. "Datenlogger-Seriennummer fehlt"), so the UI can show exactly which
	// field is wrong instead of a generic string. Other error codes map to fixed
	// copy in the UI.
	Message string `json:"message,omitempty"`
	// Reading is what the device REALLY answered. It normally rides a success -
	// but since 21.08.2026 it also rides an `implausible` refusal whose Finding
	// names a single violating channel: the other channels decoded fine, and
	// showing them is what turns a dead end into a diagnosis (live case
	// Muehlfeldweg 2). It never carries the violating channel itself.
	Reading *Reading `json:"reading,omitempty"`
	// Finding names WHICH channel violated WHICH plausibility rule, machine
	// readable, so no surface has to search a German sentence for keywords (the
	// house rule "target_verdict NEXT TO state"). Only set alongside
	// ErrorCode "implausible".
	Finding *Finding `json:"finding,omitempty"`
	// FoundUnits is set only by the multi-inverter unit-ID probe (POST
	// /api/probe-units, fronius_sunspec only): every Modbus unit id at the
	// probed address that presented a SunSpec device (a Fronius Datamanager
	// exposes one unit id per inverter; convention: inverter number = unit id).
	// Empty/absent on the plain test-connection round trip.
	FoundUnits []int `json:"found_units,omitempty"`
	// ControlCheck is the D11 write short-test verdict (go-e, only when the
	// request asked for it AND the read succeeded). A failed check never flips
	// OK - the READ succeeded; the check reports its own honest outcome.
	ControlCheck *ControlCheck `json:"control_check,omitempty"`
}

// Finding is the plausibility verdict about ONE channel of an otherwise
// successful read (contract mqtt-probe.schema.json op_result.finding).
//
// Rule is the WHY, and the three cases are deliberately not one word:
// "missing" (a demonstrably LIVE register block whose channel reads exactly 0 -
// a battery whose BMS is not coupled to the inverter) is the only one an
// operator may knowingly run a plant with; "no_answer" (the logger's all-zero
// empty answer) and "out_of_range" (a broken/shifted frame) are evidence that
// the READ is untrustworthy and may never be waved through.
type Finding struct {
	Channel string   `json:"channel"`
	Rule    string   `json:"rule"`
	Raw     *float64 `json:"raw,omitempty"`
	Value   *float64 `json:"value,omitempty"`
}

// The Finding rule vocabulary. Closed on purpose: a word we do not understand
// must not become a sentence in front of a customer.
const (
	FindingRuleMissing    = "missing"
	FindingRuleOutOfRange = "out_of_range"
	FindingRuleNoAnswer   = "no_answer"
)

// ControlCheck is the non-disruptive write short-test verdict: a
// value-identical write was executed and read back (go-e: the current amp
// value; shelly: off-while-off). Message is the German sentence the wizard
// shows ("Verbindung geprüft" / the honest failure).
type ControlCheck struct {
	OK bool `json:"ok"`
	// Skipped: the check was deliberately NOT run (shelly: the relay is ON
	// and a running heat cycle is never interrupted). An honest state, not a
	// failure - ErrorCode stays empty and Message names why.
	Skipped   bool   `json:"skipped,omitempty"`
	Key       string `json:"key,omitempty"`
	Value     int    `json:"value,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
	// PhaseSwitchMode/PhasesInUse: the phase position the charger reported
	// during the check (absent = not reported; the wizard's D4 capability hint).
	PhaseSwitchMode *int `json:"phase_switch_mode,omitempty"`
	PhasesInUse     *int `json:"phases_in_use,omitempty"`
	// The shelly capability facts (D3): the detected generation dialect,
	// model and whether the device measures power. Metering steers the
	// wizard's honest Bestätigungsstufe hint (Stufe 2 kW-Telemetrie vs
	// Stufe 3 Laufzeit bestätigt / Energie angenommen). Absent on go-e.
	Gen         int    `json:"gen,omitempty"`
	DeviceModel string `json:"device_model,omitempty"`
	Metering    *bool  `json:"metering,omitempty"`
}

// Error codes (kept in sync with the Node-RED test-read classification and the
// portal's message map). A nil/absent field in Reading means "this device does
// not report it" (never a fabricated 0).
const (
	// ErrInvalidRequest - the form itself is not a valid selection (bad
	// brand/model/family/connection); rejected before any device I/O.
	ErrInvalidRequest = "invalid_request"
	// ErrUnreachable - TCP connect failed / timed out.
	ErrUnreachable = "unreachable"
	// ErrNoAnswer - connected, but no valid protocol answer in time (wrong
	// serial / slave-id / unit-id).
	ErrNoAnswer = "no_answer"
	// ErrInvalidResponse - a frame came back but is malformed / wrong family.
	ErrInvalidResponse = "invalid_response"
	// ErrImplausible - decoded, but the values make no sense (e.g. SoC fails the
	// plausibility gate).
	ErrImplausible = "implausible"
	// ErrFroniusAPI - Fronius Solar API did not answer / TLS problem.
	ErrFroniusAPI = "fronius_api"
	// ErrTimeout - the whole round-trip produced no result in the window (the
	// read flow is not running, or the device never answered at all).
	ErrTimeout = "timeout"
)

// Reading is the decoded snapshot. Every field is optional so the UI shows only
// what the family/role actually reports (string/micro PV only; a hybrid gets
// PV/Last/Netzbezug/SoC; a grid meter only Netzbezug).
type Reading struct {
	PvKw   *float64 `json:"pv_kw,omitempty"`
	LoadKw *float64 `json:"load_kw,omitempty"`
	GridKw *float64 `json:"grid_kw,omitempty"`
	SocPct *float64 `json:"soc_pct,omitempty"`
}
