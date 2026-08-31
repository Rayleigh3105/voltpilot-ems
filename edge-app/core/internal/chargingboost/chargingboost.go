// Package chargingboost parses the NON-RETAINED one-shot override „Jetzt voll
// laden" the portal sends to this box (contract
// docs/contracts/mqtt-charging-boost.schema.json, OCPP-Lastmanagement Stufe 4).
//
// It is the PURE half - no I/O, no clock of its own (every time-dependent
// function takes its `now`), no MQTT import - so every rule below is provable
// without a broker (the internal/probe / internal/registerwrite discipline).
//
// ⚠ IT IS A SECOND TRIGGER, NEVER A SECOND MECHANISM. The parsed request goes
// into `Agent.OcppBoost` - the very method the `:8484` button calls - so there
// is no other way to override, and nothing here has to be secured a second
// time. What the override may and may not do lives in internal/lastmgmt.
//
// ⚠ THE OVERRIDE BEATS THE ECONOMY, NEVER THE PHYSICS. It exempts ONE running
// charge from the customer's SOURCE priority so it may draw grid power. The
// connection limit, the engineering margin, the §14a envelope, the minimum
// power, the Vorrang rank and the station's own failsafe profile bind it
// exactly like every other session - and the priority of every OTHER charge is
// untouched. That is the whole promise of its dialog.
//
// ⚠ NON-RETAINED IS ONLY HALF THE REPLAY DEFENCE. The box holds a durable
// session (cleanSession=false), so the broker may DELIVER LATE. The other half
// is `requested_at`: the window starts at THAT stamp, never at arrival, so a
// redelivered message is already expired when it lands and is DISCARDED rather
// than applied. A consent from three hours ago is not a consent for now.
package chargingboost

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SchemaVersion is the only contract version this box understands. Anything
// else is DISCARDED (fail-closed) and the customer's priority stands.
const SchemaVersion = "1.0"

// Window is how long a request stays valid, measured from `requested_at`. It
// is deliberately SHORT: this is a live decision about a vehicle a human is
// standing next to, not a standing instruction.
const Window = 2 * time.Minute

// MaxMinutes mirrors the contract cap (4 h). A longer wish is CLAMPED by the
// box, never refused - the cap is a promise, not a trap.
const MaxMinutes = 240

// The two DIRECTIONS of the one override (Verbrauchsmanagement v1 / P3b,
// Entscheid E5). They are siblings, not two mechanisms: same transport, same
// `requested_at` window, same binding to ONE transaction, same „Automatik
// fortsetzen" to take either back.
const (
	// ActionFull is „Jetzt voll laden": the session is freed from the SOURCE
	// lane and may draw grid power.
	ActionFull = "voll"
	// ActionPause is „Laden pausieren": the session is capped at 0 kW and
	// pauses with the reason „handeingriff". Every OTHER charge is untouched,
	// and the cap is RESTRICT-ONLY - it can never widen a limit.
	ActionPause = "pause"
)

// Request is one parsed override.
type Request struct {
	TenantID      string
	SiteID        string
	DeviceID      string
	ChargePointID string
	Connector     int
	// Action is which direction was granted (ActionFull / ActionPause).
	//
	// ⚠ An ABSENT field parses to ActionFull. That is the compatibility
	// promise of the whole Paket: a cloud that does not send it grants exactly
	// the boost of before.
	Action string
	// Minutes is the requested duration; 0 = the contract default (the cap).
	Minutes int
	// Cancel takes a running override back at once.
	Cancel bool
	// RequestedAt is when the CLOUD granted it - the anchor of the window.
	RequestedAt time.Time
	// Actor is who granted it (paper trail only; the box decides nothing on it).
	Actor string
}

type wire struct {
	SchemaVersion string `json:"schema_version"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	ChargePointID string `json:"charge_point_id"`
	Connector     int    `json:"connector_id"`
	Action        string `json:"action"`
	Minutes       int    `json:"minutes"`
	Cancel        bool   `json:"cancel"`
	RequestedAt   string `json:"requested_at"`
	Actor         string `json:"actor"`
}

// Parse reads one payload. Every refusal is a German error the caller logs -
// and, per the identity rule, never answers.
func Parse(payload []byte) (Request, error) {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return Request{}, errors.New("leere Übersteuerungs-Nachricht")
	}
	var w wire
	if err := json.Unmarshal(payload, &w); err != nil {
		return Request{}, fmt.Errorf("Übersteuerung ist unlesbar: %w", err)
	}
	if w.SchemaVersion != SchemaVersion {
		return Request{}, fmt.Errorf("unbekannte Vertragsversion %q - die Übersteuerung wird verworfen",
			w.SchemaVersion)
	}
	if w.TenantID == "" || w.SiteID == "" || w.DeviceID == "" {
		return Request{}, errors.New("die Übersteuerung nennt keine vollständige Identität")
	}
	id := strings.TrimSpace(w.ChargePointID)
	if id == "" {
		return Request{}, errors.New("die Übersteuerung nennt keine Ladesäule")
	}
	if w.Connector < 1 || w.Connector > 64 {
		return Request{}, fmt.Errorf("Stecker %d gibt es nicht - ein Stecker wird ab 1 gezählt", w.Connector)
	}
	action := strings.TrimSpace(w.Action)
	switch action {
	case "":
		// ⚠ ABSENT is „voll", never a refusal: the two fixtures written before
		// P3b carry no `action`, and so does every cloud that has not deployed
		// it yet.
		action = ActionFull
	case ActionFull, ActionPause:
	default:
		// A word we do not understand must not become a handling - and the
		// safe direction here is NOT „pause" either (that would stop a charge
		// nobody asked to stop), so the whole message is discarded.
		return Request{}, fmt.Errorf("unbekannte Übersteuerungs-Art %q - die Nachricht wird verworfen",
			w.Action)
	}
	if w.Minutes < 0 || w.Minutes > MaxMinutes {
		return Request{}, fmt.Errorf("die Dauer %d Minuten liegt außerhalb von 0..%d", w.Minutes, MaxMinutes)
	}
	ts, err := time.Parse(time.RFC3339, w.RequestedAt)
	if err != nil {
		// ⚠ An unreadable stamp is NOT treated as "now": the whole replay
		// defence hangs off it, so a request we cannot date does not count.
		return Request{}, fmt.Errorf("die Übersteuerung trägt keinen lesbaren Zeitstempel: %w", err)
	}
	return Request{
		TenantID: w.TenantID, SiteID: w.SiteID, DeviceID: w.DeviceID,
		ChargePointID: id, Connector: w.Connector, Action: action, Minutes: w.Minutes,
		Cancel: w.Cancel, RequestedAt: ts.UTC(), Actor: strings.TrimSpace(w.Actor),
	}, nil
}

// Pause reports whether this request is the „Laden pausieren" direction.
func (r Request) Pause() bool { return r.Action == ActionPause }

// MatchesIdentity reports whether the request addresses THIS device. The rule
// of every downlink here: the topic identity must equal the payload identity,
// and a mismatch is dropped STUMM - answering a wrongly addressed sender would
// confirm this device exists.
func (r Request) MatchesIdentity(tenantID, siteID, deviceID string) bool {
	return r.TenantID == tenantID && r.SiteID == siteID && r.DeviceID == deviceID
}

// Expired reports whether the window has passed. A stamp from the FUTURE is
// tolerated (clock skew between cloud and box is not the customer's fault and
// only ever shortens nothing) - only age expires a request.
func (r Request) Expired(now time.Time) bool {
	return now.Sub(r.RequestedAt) > Window
}

// ExpiredMessage names BOTH clocks, because the one cause a cloud cannot see
// from the outside is two clocks that drifted apart.
func (r Request) ExpiredMessage(now time.Time) string {
	return fmt.Sprintf("die Übersteuerung ist abgelaufen (erteilt %s, hier ist es %s) - "+
		"sie wird nicht ausgeführt",
		r.RequestedAt.Format(time.RFC3339), now.UTC().Format(time.RFC3339))
}
