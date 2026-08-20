// Package csms is VoltPilot's OCPP 1.6J Central System — the piece that makes
// the BOX the thing charge points talk to (Konzept `vp-ocpp-lastmgmt-konzept-w4`
// §3.2/E1: the connection limit is a PHYSICAL limit, so its watchdog must not
// hang off the WAN). It wraps `github.com/lorenzodonini/ocpp-go` (MIT) behind a
// narrow, plain-typed surface — the DayAheadPriceSource/PlantRegistryClient
// discipline of the house: the library appears in exactly two files of this
// package (csms.go, ocppmap.go) and NOWHERE else in the repo, so a version
// bump or a 2.0.1 adapter is a change inside this package.
//
// ⚠ HERSTELLERNEUTRAL, and it is a construction property, not a promise
// (Konzept §0, VERBINDLICH): a charge point's identity is its OCPP
// ChargePointId and nothing else. Vendor / model / firmware / serial are
// RECORDED as facts the station reported about itself and are only ever
// DISPLAYED — no code in this package or above it branches on them. Vendor
// quirks, if a real bench session ever finds one, belong in a catalog entry
// keyed by type, never in this mechanism.
//
// SCOPE ZAUN (Konzept E4): Lastmanagement pur. No billing, no calibration law
// (Eichrecht), no OCPI, no RFID user management — Authorize accepts, sessions
// are OPERATING data. DataTransfer is answered UnknownVendorId on purpose: we
// implement no vendor extension.
//
// This file is the PURE half: the plant view in plain Go types, with no
// ocpp-go import at all, so the allocator (internal/lastmgmt) and the web
// layer never see the library.
package csms

import (
	"sort"
	"time"
)

// SchemaVersion of the persisted charger list (chargers.json).
const SchemaVersion = "1.0"

// OCPP 1.6 connector status vocabulary, verbatim. A status word OUTSIDE this
// set is DROPPED rather than stored (the house rule: a word we do not
// understand must not become a sentence) — the connector then keeps its last
// known status, which is honest, instead of gaining an invented one.
const (
	StatusAvailable     = "Available"
	StatusPreparing     = "Preparing"
	StatusCharging      = "Charging"
	StatusSuspendedEVSE = "SuspendedEVSE"
	StatusSuspendedEV   = "SuspendedEV"
	StatusFinishing     = "Finishing"
	StatusReserved      = "Reserved"
	StatusUnavailable   = "Unavailable"
	StatusFaulted       = "Faulted"
)

// KnownStatus reports whether s is part of the OCPP 1.6 status vocabulary.
func KnownStatus(s string) bool {
	switch s {
	case StatusAvailable, StatusPreparing, StatusCharging, StatusSuspendedEVSE,
		StatusSuspendedEV, StatusFinishing, StatusReserved, StatusUnavailable, StatusFaulted:
		return true
	}
	return false
}

// ChargingStatus reports whether a connector in status s is drawing (or is
// about to draw) power for a vehicle — i.e. whether it is a claimant on the
// site budget. SuspendedEV/SuspendedEVSE count: the session is live and the
// vehicle may resume within a second, so its allocation must not be handed
// away and taken back (a flapping allocation is worse than a held one).
func ChargingStatus(s string) bool {
	switch s {
	case StatusCharging, StatusSuspendedEV, StatusSuspendedEVSE:
		return true
	}
	return false
}

// Charger is the PERSISTED half of a charge point: what the operator declared
// before the station ever connected. The ID is the OCPP ChargePointId the
// station is configured with — it is the identity, and the allowlist key.
type Charger struct {
	// ID is the OCPP ChargePointId (URL path segment the station dials).
	ID string `json:"id"`
	// Label is the operator-given name ("Säule Hof Nord"). Display only.
	Label string `json:"label,omitempty"`
	// Priority marks a Vorrang-Säule (Captain decision, mockups §2b): it is
	// served to its full demand FIRST, the rest share what remains fairly.
	// It is a rank, never a bypass — every limit still binds.
	Priority bool      `json:"priority,omitempty"`
	AddedAt  time.Time `json:"added_at"`
}

// Session is one running transaction on one connector.
type Session struct {
	TransactionID int       `json:"transaction_id"`
	IDTag         string    `json:"id_tag,omitempty"`
	StartedAt     time.Time `json:"started_at"`
	// MeterStartWh is the connector's energy register at StartTransaction, so
	// the session's own delivered energy is derivable without a second reading.
	MeterStartWh int `json:"meter_start_wh"`
}

// Connector is one plug ("Stecker") of a charge point. One connector = one
// vehicle = one claimant on the budget (Konzept §3.5).
type Connector struct {
	ID     int    `json:"id"`
	Status string `json:"status,omitempty"`
	// ErrorCode is the OCPP error code the station reported alongside its
	// status ("NoError" in the normal case). Verbatim, display only.
	ErrorCode string   `json:"error_code,omitempty"`
	Session   *Session `json:"session,omitempty"`

	// Measured values from MeterValues. Absent (nil) means the station has not
	// reported that measurand — NEVER a fabricated 0 (the house rule that a
	// missing channel is not a zero one).
	PowerKw   *float64  `json:"power_kw,omitempty"`
	EnergyKwh *float64  `json:"energy_kwh,omitempty"`
	SocPct    *float64  `json:"soc_pct,omitempty"`
	MeteredAt time.Time `json:"metered_at,omitzero"`
}

// ChargerState is the LIVE view of one charge point: its declared identity
// plus whatever it has told us about itself since it connected.
type ChargerState struct {
	Charger
	Connected   bool      `json:"connected"`
	ConnectedAt time.Time `json:"connected_at,omitzero"`
	// LastSeen is the wall clock of the most recent message of ANY kind from
	// this station (boot, heartbeat, status, meter values). It is the
	// liveness anchor; the connection flag alone can lie across a half-open
	// TCP socket.
	LastSeen time.Time `json:"last_seen,omitzero"`
	// BootedAt is when the station last sent its BootNotification.
	BootedAt time.Time `json:"booted_at,omitzero"`

	// Self-reported identity. DISPLAY ONLY — see the package doc: no
	// mechanism in this repo may branch on any of these four strings.
	Vendor   string `json:"vendor,omitempty"`
	Model    string `json:"model,omitempty"`
	Firmware string `json:"firmware,omitempty"`
	Serial   string `json:"serial,omitempty"`

	// Status is the STATION-level status: OCPP reserves connectorId 0 for
	// "the charge point as a whole", so that notification is kept here rather
	// than being minted as a phantom connector 0 in the list below.
	Status string `json:"status,omitempty"`

	Connectors []Connector `json:"connectors,omitempty"`
}

// ConnectorByID returns the connector with the given id, or nil.
func (c ChargerState) ConnectorByID(id int) *Connector {
	for i := range c.Connectors {
		if c.Connectors[i].ID == id {
			return &c.Connectors[i]
		}
	}
	return nil
}

// Snapshot is the whole plant as the CSMS knows it: what the box offers and
// which stations are on it. Plain types only.
type Snapshot struct {
	// Enabled mirrors VP_OCPP_ENABLED. False = the server never started, and
	// every field below is the empty, honest "nothing to say".
	Enabled bool `json:"enabled"`
	// Listening is true once the websocket server actually accepted its
	// listening socket. Enabled && !Listening is a real fault (port in use)
	// and Error names it — never a silent nothing.
	Listening bool   `json:"listening"`
	Error     string `json:"error,omitempty"`
	// URLPath is the path the stations dial ("/ocpp"); the full endpoint is
	// ws://<box>:<port><URLPath>/<chargePointId>.
	URLPath string `json:"url_path,omitempty"`
	Port    int    `json:"port,omitempty"`

	Chargers []ChargerState `json:"chargers"`
}

// ChargerByID returns the state of one charge point, or false.
func (s Snapshot) ChargerByID(id string) (ChargerState, bool) {
	for _, c := range s.Chargers {
		if c.ID == id {
			return c, true
		}
	}
	return ChargerState{}, false
}

// sortChargers orders the list deterministically (by id), so every surface
// and every test sees the same order regardless of connection order.
func sortChargers(list []ChargerState) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}

// sortConnectors orders connectors ascending by id.
func sortConnectors(list []Connector) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}
