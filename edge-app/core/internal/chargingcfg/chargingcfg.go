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

// MaxChargePoints mirrors the contract's cap on the allowlist.
const MaxChargePoints = 64

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
	// SurplusPolicy / StoragePriority are the Stufe-4 SOURCE choice of the
	// customer. nil = the portal says nothing and the box keeps its own.
	//
	// ⚠ ABSENT is NOT `schnell`. „Schnell laden" is a customer's own statement
	// ("keine Quellen-Politik"); absent means "das Portal äußert sich nicht" —
	// collapsing the two would let an older cloud silently drop a customer's
	// „Nur Sonnenstrom".
	SurplusPolicy   *string
	StoragePriority *string

	// ChargePoints are the station identifiers the portal wants ADMITTED.
	//
	// ⚠ nil and an EMPTY list mean the same thing here, and that is deliberate:
	// this list only ever ADDS. LEAVING AN ID OUT IS NOT A REMOVAL - a removal
	// is said explicitly, in RemovedChargePoints below.
	ChargePoints []ChargePoint

	// RemovedChargePoints are the identifiers the portal wants taken OUT of the
	// allowlist (Captain-Order 24.08.2026: "Ebenso will ich die moeglichkeit
	// haben eingebene kennungen zu loeschen").
	//
	// ⚠ It is a SEPARATE list, not a flag inside ChargePoints, and that is what
	// keeps an OLDER box honest: it does not know this field, overreads it and
	// KEEPS the station - the previous state, never a wrong action. A `removed`
	// flag inside a ChargePoint entry would have made an older box ADMIT the
	// very id the customer just deleted.
	//
	// ⚠ It is a TOMBSTONE list and travels in EVERY following document, not
	// once: the retained payload is replaced wholesale, so a removal named a
	// single time would never reach a box that happened to be offline.
	//
	// An id the box does not (or no longer) know is a silent no-op. An id in
	// BOTH lists is a contradiction the document should never carry; if it does,
	// the REMOVAL wins - the direction that admits less.
	RemovedChargePoints []string
}

// ChargePoint is one entry of the allowlist. Only `ID` is required; the rest is
// what the operator happens to know when they add it in the portal.
type ChargePoint struct {
	ID         string
	Label      string
	Priority   bool
	RatedKw    float64
	Connectors int
}

// wire is the on-the-wire shape. Pointers where absence differs from a value.
type wire struct {
	SchemaVersion   string    `json:"schema_version"`
	TenantID        string    `json:"tenant_id"`
	SiteID          string    `json:"site_id"`
	DeviceID        string    `json:"device_id"`
	GridLimitKw     *float64  `json:"grid_limit_kw"`
	Priorities      *[]string `json:"priority_charge_point_ids"`
	SurplusPolicy   *string   `json:"surplus_policy"`
	StoragePriority *string   `json:"storage_priority"`
	ChargePoints    []wireCP  `json:"charge_points"`
	Removed         []string  `json:"removed_charge_point_ids"`
	PublishedAt     string    `json:"published_at"`
}

type wireCP struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Priority   bool    `json:"priority"`
	RatedKw    float64 `json:"rated_kw"`
	Connectors int     `json:"connectors"`
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
	// ⚠ An unknown WORD is refused, not normalized: the box's own read path
	// tolerates a corrupt file (never strand a fleet), but a document from the
	// portal is a deliberate statement - silently turning it into something
	// else would leave a customer believing they set what they did not.
	if w.SurplusPolicy != nil {
		v := strings.TrimSpace(*w.SurplusPolicy)
		if !validPolicy(v) {
			return Config{}, fmt.Errorf("unbekannte Überschuss-Priorität %q - das Dokument wird verworfen", v)
		}
		cfg.SurplusPolicy = &v
	}
	if w.StoragePriority != nil {
		v := strings.TrimSpace(*w.StoragePriority)
		if !validStorage(v) {
			return Config{}, fmt.Errorf("unbekannte Speicher-Priorität %q - das Dokument wird verworfen", v)
		}
		cfg.StoragePriority = &v
	}
	if len(w.ChargePoints) > MaxChargePoints {
		return Config{}, fmt.Errorf("das Dokument nennt %d Ladesäulen - höchstens %d sind erlaubt",
			len(w.ChargePoints), MaxChargePoints)
	}
	for _, cp := range w.ChargePoints {
		id := strings.TrimSpace(cp.ID)
		// ⚠ Eine unbrauchbare Kennung wird ÜBERSPRUNGEN, nicht zum Abbruch: die
		// Liste fügt nur hinzu, ein Eintrag mehr oder weniger nimmt der Box
		// nichts. Das GANZE Dokument daran scheitern zu lassen kostete die
		// Anschlussgrenze mit - und die ist die Größe, ohne die nichts lädt.
		if id == "" || alreadyListed(cfg.ChargePoints, id) {
			continue
		}
		cfg.ChargePoints = append(cfg.ChargePoints, ChargePoint{
			ID: id, Label: strings.TrimSpace(cp.Label), Priority: cp.Priority,
			RatedKw: cp.RatedKw, Connectors: cp.Connectors,
		})
	}
	if len(w.Removed) > MaxChargePoints {
		return Config{}, fmt.Errorf("das Dokument nennt %d zu entfernende Ladesäulen - höchstens %d sind erlaubt",
			len(w.Removed), MaxChargePoints)
	}
	for _, raw := range w.Removed {
		// Dieselbe Nachsicht wie oben: eine unbrauchbare Zeile wird
		// ÜBERSPRUNGEN, nicht zum Abbruch - das ganze Dokument daran scheitern
		// zu lassen kostete die Anschlussgrenze mit.
		id := strings.TrimSpace(raw)
		if id == "" || contains(cfg.RemovedChargePoints, id) {
			continue
		}
		cfg.RemovedChargePoints = append(cfg.RemovedChargePoints, id)
	}
	// ⚠ Der Widerspruch wird HIER aufgelöst, nicht beim Anwender: eine Kennung,
	// die zugleich zugelassen und entfernt werden soll, fällt aus der
	// Zulassungs-Liste. Die Löschung gewinnt - die Richtung, die weniger
	// zulässt. Das Portal sendet den Fall nie; ein Dokument aus einer anderen
	// Quelle darf ihn nicht in eine Zulassung drehen.
	if len(cfg.RemovedChargePoints) > 0 && len(cfg.ChargePoints) > 0 {
		kept := cfg.ChargePoints[:0]
		for _, cp := range cfg.ChargePoints {
			if contains(cfg.RemovedChargePoints, cp.ID) {
				continue
			}
			kept = append(kept, cp)
		}
		cfg.ChargePoints = kept
	}
	return cfg, nil
}

func alreadyListed(list []ChargePoint, id string) bool {
	for _, c := range list {
		if c.ID == id {
			return true
		}
	}
	return false
}

// The two vocabularies of the contract. They are repeated here rather than
// imported from internal/lastmgmt so this package stays what it is: a PARSER
// of a document, with no opinion about what a setting means.
func validPolicy(v string) bool {
	return v == "nur_sonne" || v == "sonne_zuerst" || v == "schnell"
}

func validStorage(v string) bool {
	return v == "speicher_vor_auto" || v == "auto_vor_speicher"
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
