// Package chargingcfg parses the RETAINED load-management configuration the
// portal sends to this box (contract
// docs/contracts/mqtt-charging-config.schema.json, Lastmanagement Stufe 3).
//
// It is the PURE half - no I/O, no clock of its own, no MQTT import - so every
// rule below is provable without a broker (the internal/probe / internal/otaapply
// discipline of the house).
//
// ⚠ THE DOCUMENT IS A WISH, NOT A DISTRIBUTION. It carries the two numbers the
// customer owns - the connection limit at their grid connection point and which
// stations get priority - and nothing else. The allocation itself is computed
// and enforced HERE, in internal/lastmgmt: the connection limit is a PHYSICAL
// limit, so its watchdog must not hang off the WAN (concept E1).
//
// ⚠ PATCH SEMANTICS, and they are load-bearing: an ABSENT field KEEPS what the
// box has. The portal owns the connection limit and the priority choice today;
// the safety margin, the minimum power and the highest known building load stay
// settings of this box (:8484). A document that silently reset them would be a
// data loss nobody asked for.
package chargingcfg

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// SchemaVersion is the only contract version this box understands. A document
// carrying anything else is DISCARDED (fail-closed) and the box keeps its own
// settings - the same rule as the control-certification document.
const SchemaVersion = "1.0"

// MaxGridLimitKw mirrors the contract's plausibility ceiling. It is deliberately
// generous (a DC charging park hangs off a medium-voltage connection) and only
// catches the typo that turns 277 kW into 277000.
const MaxGridLimitKw = 100000

// MaxPriorities mirrors the contract's cap on the priority list.
const MaxPriorities = 64

// ErrEmpty is the withdrawal: an empty retained payload takes the document
// back, and afterwards only what is maintained on the box applies.
var ErrEmpty = errors.New("das Konfigurations-Dokument wurde zurückgenommen")

// Config is the parsed document. Both fields are OPTIONAL by contract, and the
// difference between "absent" and "empty" is the whole PATCH semantics:
//
//	GridLimitKw == nil  -> the portal says nothing; keep the box's own number.
//	Priorities  == nil  -> the portal says nothing; keep the box's own choice.
//	Priorities  == []   -> an ASSERTION ("no station has priority") and applied.
type Config struct {
	TenantID    string
	SiteID      string
	DeviceID    string
	GridLimitKw *float64
	Priorities  []string
}

// wire is the on-the-wire shape. Pointers where absence differs from a value.
type wire struct {
	SchemaVersion string    `json:"schema_version"`
	TenantID      string    `json:"tenant_id"`
	SiteID        string    `json:"site_id"`
	DeviceID      string    `json:"device_id"`
	GridLimitKw   *float64  `json:"grid_limit_kw"`
	Priorities    *[]string `json:"priority_charge_point_ids"`
	PublishedAt   string    `json:"published_at"`
}

// Parse reads one retained payload. An EMPTY payload returns ErrEmpty (the
// withdrawal); anything malformed returns a German error and the caller keeps
// its own settings - a document we cannot read must never become a setting.
func Parse(payload []byte) (Config, error) {
	if len(strings.TrimSpace(string(payload))) == 0 {
		return Config{}, ErrEmpty
	}
	var w wire
	if err := json.Unmarshal(payload, &w); err != nil {
		return Config{}, fmt.Errorf("Konfigurations-Dokument ist unlesbar: %w", err)
	}
	if w.SchemaVersion != SchemaVersion {
		return Config{}, fmt.Errorf("unbekannte Vertragsversion %q - das Dokument wird verworfen",
			w.SchemaVersion)
	}
	if w.TenantID == "" || w.SiteID == "" || w.DeviceID == "" {
		return Config{}, errors.New("das Konfigurations-Dokument nennt keine vollständige Identität")
	}
	cfg := Config{TenantID: w.TenantID, SiteID: w.SiteID, DeviceID: w.DeviceID}
	if w.GridLimitKw != nil {
		v := *w.GridLimitKw
		// ⚠ Eine 0 oder ein unsinniger Wert wird ABGELEHNT, nicht angewandt:
		// ohne Grenze ist das Budget 0 und es lädt nichts - das wäre eine
		// Aussage, die niemand treffen wollte, und sie käme aus einem Tippfehler.
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v > MaxGridLimitKw {
			return Config{}, fmt.Errorf("die Anschlussgrenze %g kW ist nicht plausibel", v)
		}
		cfg.GridLimitKw = &v
	}
	if w.Priorities != nil {
		list := *w.Priorities
		if len(list) > MaxPriorities {
			return Config{}, fmt.Errorf("das Dokument nennt %d Vorrang-Säulen - höchstens %d sind erlaubt",
				len(list), MaxPriorities)
		}
		out := make([]string, 0, len(list))
		for _, id := range list {
			v := strings.TrimSpace(id)
			if v == "" || contains(out, v) {
				continue
			}
			out = append(out, v)
		}
		cfg.Priorities = out
	}
	return cfg, nil
}

// MatchesIdentity reports whether the document addresses THIS device. The rule
// of every downlink here (telemetry / purge_data / assignment / apply): the
// topic identity must equal the payload identity, and a mismatch is dropped -
// answering a wrongly addressed sender would confirm this device exists.
func (c Config) MatchesIdentity(tenantID, siteID, deviceID string) bool {
	return c.TenantID == tenantID && c.SiteID == siteID && c.DeviceID == deviceID
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
