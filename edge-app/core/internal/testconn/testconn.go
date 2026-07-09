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
	Message string   `json:"message,omitempty"`
	Reading *Reading `json:"reading,omitempty"`
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
