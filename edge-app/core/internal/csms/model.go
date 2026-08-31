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
	Priority bool `json:"priority,omitempty"`
	// RatedKw is the station's rated power PER CONNECTOR, as declared by the
	// operator. 0 = unknown, and then the site budget is the only ceiling —
	// an honest "we do not know" rather than a guessed nameplate.
	RatedKw float64 `json:"rated_kw,omitempty"`
	// MinKw is this station's own minimum useful charging power. 0 = use the
	// site-wide Mindestleistung. It exists because a DC park's 30 kW figure
	// must not make an AC box on the same site unservable.
	MinKw float64 `json:"min_kw,omitempty"`
	// Connectors is the operator-declared plug count. 0 = learn it from the
	// station's own StatusNotifications. It matters BEFORE the first one
	// arrives, because the emergency default is divided by the plug count of
	// the WHOLE site — and a count that is too low makes that default too big.
	Connectors int `json:"connectors,omitempty"`
	// Connection is WHERE this station hangs (Cockpit Phase 1 / C1, Captain
	// decision E5): ConnectionHaus (behind the house connection - the normal
	// case) or ConnectionEigen (its own grid connection / meter).
	//
	// ⚠ EMPTY means Haus. It is the PATCH semantics of the retained document
	// and the SAFE reading in one: an older cloud sends no such field, and
	// reading that as "eigen" would take a real charging load out of the box's
	// own balance. Ask through ConnectionOrHaus()/OwnConnection(), never
	// compare the raw string.
	Connection string `json:"connection,omitempty"`
	// Source is THIS station's own source lane (Verbrauchsmanagement v1 / P5,
	// `charge_points[].source` of the charging-config contract):
	// "nur_sonne" | "sonne_zuerst" | "schnell". EMPTY = the customer said
	// nothing for this station and the SITE-wide surplus policy applies -
	// byte-for-byte the behaviour before P5.
	//
	// ⚠ It is the customer's ECONOMY, never a limit: the connection limit, the
	// engineering margin, §14a and the failsafe bind a station regardless of
	// what it says here. Ask through SourceOrSite(), never compare the raw
	// string against a policy word.
	Source string `json:"source,omitempty"`
	// Rank is THIS station's POSITION in the customer's Rangliste
	// (Verbrauchsmanagement v1 / P6, `charge_points[].rank`). 0 = the customer
	// never ordered one, and then `Priority` decides alone - the behaviour
	// before P6.
	//
	// ⚠ EQUAL RANKS ARE EQUALS: the cloud gives stations the customer left side
	// by side the SAME number, and the allocator keeps rotating between them.
	// Like `connection`/`source` it is applied to a station the box ALREADY
	// knows - there is no :8484 surface for it, so there is nothing to protect.
	Rank    int       `json:"rank,omitempty"`
	AddedAt time.Time `json:"added_at"`
}

// KnownSource reports whether s is part of the source vocabulary. Empty is NOT
// a member - it is the ABSENCE of a statement, which the readers resolve to
// the site-wide policy.
func KnownSource(s string) bool {
	return s == "nur_sonne" || s == "sonne_zuerst" || s == "schnell"
}

// SourceOrSite resolves this station's lane: its own choice, or the site's.
func (c Charger) SourceOrSite(site string) string {
	if c.Source != "" {
		return c.Source
	}
	return site
}

// The two places a charge point can hang (contract mqtt-charging-config).
const (
	ConnectionHaus  = "haus"
	ConnectionEigen = "eigen"
)

// KnownConnection reports whether s is part of the connection vocabulary.
// Empty is NOT a member - it is the ABSENCE of a statement, which the readers
// resolve to Haus.
func KnownConnection(s string) bool {
	return s == ConnectionHaus || s == ConnectionEigen
}

// ConnectionOrHaus resolves the stored value: absent = behind the house.
func (c Charger) ConnectionOrHaus() string {
	if c.Connection == ConnectionEigen {
		return ConnectionEigen
	}
	return ConnectionHaus
}

// OwnConnection reports whether this station hangs on its OWN grid connection,
// so its power is NOT inside the site's grid measurement.
func (c Charger) OwnConnection() bool { return c.Connection == ConnectionEigen }

// Session is one running transaction on one connector.
type Session struct {
	TransactionID int       `json:"transaction_id"`
	IDTag         string    `json:"id_tag,omitempty"`
	StartedAt     time.Time `json:"started_at"`
	// MeterStartWh is the connector's energy register at StartTransaction, so
	// the session's own delivered energy is derivable without a second reading.
	MeterStartWh int `json:"meter_start_wh"`
	// TagRef is the PSEUDONYM of IDTag - `tagref_` + HMAC-SHA256 with this
	// box's own privacy key, exactly the value the journal writes to disk
	// (Verbrauchsmanagement v1 / P7, Fahrzeug-Profile).
	//
	// ⚠ It is computed ONCE, here, by the one component that holds the key,
	// and everything downstream reads it instead of the plaintext: the
	// heartbeat reports it, and the per-session source lane is looked up with
	// it. A second place that hashed an idTag would be a second answer to the
	// same question, and the first time the two drifted a customer's vehicle
	// profile would silently stop matching.
	//
	// ⚠ It is NOT the reference the cloud stores for OCPP transactions: the
	// cloud re-HMACs everything it ingests with its own pepper, so the two
	// pseudonym spaces are deliberately different values for the same card.
	TagRef string `json:"tag_ref,omitempty"`
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

	// --- the live allocation, as commanded and as read back ---

	// CommandedKw is the limit the CSMS last told this connector to hold.
	// nil = nothing was ever commanded, which is NOT a limit of 0.
	CommandedKw *float64 `json:"commanded_kw,omitempty"`
	// CommandStatus is the station's own answer to the last SetChargingProfile
	// ("Accepted"/"Rejected"/"NotSupported"), or a German reason when the
	// request never got an answer. Never empty after a command: silence is a
	// state, not an absence (the PR-280 lesson).
	CommandStatus string    `json:"command_status,omitempty"`
	CommandedAt   time.Time `json:"commanded_at,omitzero"`
	// Readback / ReadbackKw / ReadbackNote carry the GetCompositeSchedule
	// verdict: ok | abweichend | unbekannt (see CompareReadback). An accepted
	// command whose readback says something else is NOT in force, and the
	// difference must be visible rather than assumed away.
	Readback     string    `json:"readback,omitempty"`
	ReadbackKw   *float64  `json:"readback_kw,omitempty"`
	ReadbackNote string    `json:"readback_note,omitempty"`
	ReadbackAt   time.Time `json:"readback_at,omitzero"`
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

	// --- Smart-Charging setup (see profiles.go) ---

	// Capabilities is what the station reported about its Smart-Charging
	// support. Capabilities.Read false = it has not answered yet, which is
	// different from "it cannot".
	Capabilities Capabilities `json:"capabilities"`
	// MaxKw / DefaultKw are the two PERMANENT profiles currently installed:
	// the whole-station cap and the safe per-connector default a station falls
	// back to when the box goes silent. nil = not installed (yet).
	MaxKw     *float64 `json:"max_kw,omitempty"`
	DefaultKw *float64 `json:"default_kw,omitempty"`
	// CommissionedAt is when the two permanent profiles were last installed
	// successfully; CommissionError names the failure when they were not.
	// One of the two is always meaningful — a station that is neither set up
	// nor explained is the state this field exists to prevent.
	CommissionedAt  time.Time `json:"commissioned_at,omitzero"`
	CommissionError string    `json:"commission_error,omitempty"`
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

// ConnectorCount is how many plugs the site has, as best it is known: the
// operator's declaration or the station's own reports, whichever is LARGER.
//
// ⚠ The max is deliberate and it is a safety choice: the emergency default is
// the free power DIVIDED by this number, so under-counting makes every
// station's fallback too big. Over-counting only makes it smaller.
func (s Snapshot) ConnectorCount() int {
	total := 0
	for _, c := range s.Chargers {
		n := len(c.Connectors)
		if c.Connectors2Declared() > n {
			n = c.Connectors2Declared()
		}
		total += n
	}
	return total
}

// Connectors2Declared is the operator-declared plug count (0 = not declared).
// The odd name keeps it apart from the Connectors slice of live state.
func (c ChargerState) Connectors2Declared() int { return c.Charger.Connectors }

// ActiveConnectors returns the connectors of one station that currently claim
// budget: a live transaction in a charging-ish status (see ChargingStatus).
func (c ChargerState) ActiveConnectors() []Connector {
	var out []Connector
	for _, con := range c.Connectors {
		if con.Session == nil {
			continue
		}
		// A session whose connector reports a NON-charging status (Finishing,
		// Available after a lost StopTransaction, Faulted) is not drawing and
		// must not hold an allocation. An EMPTY status is treated as active:
		// a station that never sent a StatusNotification but did open a
		// transaction IS charging, and starving it over a missing message
		// would be our bug, not its.
		if con.Status != "" && !ChargingStatus(con.Status) {
			continue
		}
		out = append(out, con)
	}
	return out
}

// ChargingTotal is the power the site's charge points are MEASURED drawing
// right now, plus whether that number is COMPLETE.
//
// It exists for the Stufe-2 dynamic budget, whose control law subtracts exactly
// this from the measured grid power (internal/lastmgmt/budget.go). Two rules,
// and both of them are load-bearing there:
//
//   - Only CONNECTED stations count. A station we cannot reach is holding its
//     own safe default and its cars may be taking it — but that draw is already
//     inside the measured grid power, and NOT adding it back is what makes it
//     count as building load. Conservative, and stable.
//   - A connector that claims budget but reports no FRESH measurement makes the
//     whole number INCOMPLETE. Guessing its draw (or calling it zero) is what
//     turns the budget loop into an oscillator; the caller's staged fallback is
//     stable and honest instead.
//   - A station on its OWN grid connection is SKIPPED entirely (C1): its power
//     never entered the site's grid measurement, so adding it back would
//     inflate the budget. Absent/"haus" - i.e. every plant before C1 - counts
//     exactly as before.
//
// A negative measured power is clamped to 0 — a charge point does not export,
// and letting a bogus negative INFLATE the add-back would loosen the budget.
func (s Snapshot) ChargingTotal(now time.Time, maxAge time.Duration) (kw float64, complete bool) {
	complete = true
	for _, c := range s.Chargers {
		if !c.Connected {
			continue
		}
		// ⚠ Cockpit Phase 1 / C1: a station on its OWN grid connection is NOT
		// inside this site's grid measurement, so it must not be added back.
		// The caller's law is `rest = grid - charging`; counting it here would
		// make the remainder too SMALL, the budget too LARGE, and the HOUSE
		// connection could be exceeded by exactly this station's power. It also
		// cannot make the number incomplete - there is nothing of it to miss.
		if c.OwnConnection() {
			continue
		}
		for _, con := range c.ActiveConnectors() {
			if con.PowerKw == nil || con.MeteredAt.IsZero() || now.Sub(con.MeteredAt) > maxAge {
				complete = false
				continue
			}
			if p := *con.PowerKw; p > 0 {
				kw += p
			}
		}
	}
	return kw, complete
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
