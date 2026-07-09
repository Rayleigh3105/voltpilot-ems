// Package sources models the ADDITIONAL, read-only measurement points a site
// can have beyond its ONE battery-hybrid inverter (the inverter package's
// Selection). Phase 1 of the multi-source Anlage: a customer with a
// battery-hybrid inverter PLUS a separate AC-coupled PV inverter adds the
// second PV as an "Erzeuger" (generation) source here; the core reads it
// through the one claimed edge and SUMS its PV into the composite site reading
// (agent.onLocalTelemetry), so the existing single edge/telemetry contract
// stays byte-for-byte unchanged downstream.
//
// A source is READ-ONLY BY CONSTRUCTION: it never carries control state and the
// core never wires a setpoint path for it. Control (battery setpoint /
// curtailment) targets the battery-hybrid inverter (inverter.Selection) ONLY.
//
// Design: report data/vp-multisource-edge-design/report.md §3.1/§3.2 (the
// role-tagged measurement-point tree; Phase 1 ships the Erzeuger role only).
// Config is reused from the inverter Catalog (brand -> model -> family ->
// connection), so a source needs no separate catalog and new brands are
// additive. The list is persisted (data-dir/sources.json) and re-published
// retained on the local bus (edge/sources/config) for the Node-RED read
// fan-out, mirroring inverter.Store + edge/inverter/config.
package sources

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// SchemaVersion of the edge/sources/config payload shape.
const SchemaVersion = "1.0"

// Roles. Phase 1 shipped the Erzeuger (generation) role; Increment 1 adds the
// Netz (grid meter) role at the point of common coupling, which makes site_grid
// an authoritative measurement instead of the primary hybrid inverter's CT. The
// rest of the Luxone role vocabulary (Verbraucher / Wallbox) is later work. A
// source is always read-only, so there is no control role here by design.
const (
	RoleErzeuger = "pv-generation"
	RoleNetz     = "grid-meter"
)

// isKnownRole reports whether role is one of the read-only source roles the edge
// can configure today. A meter (RoleNetz) carries no capacity_kwp; an Erzeuger
// (RoleErzeuger) may.
func isKnownRole(role string) bool {
	return role == RoleErzeuger || role == RoleNetz
}

// Read-cadence defaults + bounds (seconds). The primary inverter polls every 5 s
// in the dev flow; an additional PV source reuses that cadence by default.
const (
	defaultIntervalS = 5
	minIntervalS     = 1
	maxIntervalS     = 3600
)

// maxCapacityKwp is a sanity ceiling on a single source's nameplate (kWp) so a
// typo cannot make the physical-plausibility envelope uselessly wide.
const maxCapacityKwp = 10000

// ErrNotFound is returned when a source id does not exist (the web layer maps it
// to HTTP 404). Defined here so both the agent and the web layer reference it
// without an import cycle.
var ErrNotFound = errors.New("Energiequelle nicht gefunden")

// ValidationError carries a customer-facing German message; the web layer maps
// it to HTTP 400. It mirrors inverter.ValidationError so the two normalise
// paths surface the same way.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// Source is one additional read-only measurement point (Phase 1: an Erzeuger).
// It reuses the inverter Catalog's transport/connection model; the core reads
// it and sums its PV into the site reading. CapacityKwp feeds both the
// aggregate site kWp (portal side) and the widened physical envelope (guards).
type Source struct {
	ID             string              `json:"id"`
	Role           string              `json:"role"`
	Label          string              `json:"label"`
	Brand          string              `json:"brand"`
	Model          string              `json:"model,omitempty"`
	Family         string              `json:"family"`
	Communication  string              `json:"communication"`
	Connection     inverter.Connection `json:"connection"`
	IntervalS      int                 `json:"interval_s"`
	CapacityKwp    float64             `json:"capacity_kwp,omitempty"`
	RegistryUnitID string              `json:"registry_unit_id,omitempty"`
	CreatedAt      time.Time           `json:"created_at"`
}

// Request is what POST /api/sources accepts (the local web form). Role defaults
// to Erzeuger; communication/family/label are DERIVED from the catalog, so a
// client can never send an inconsistent transport (same guarantee as the
// inverter selection).
type Request struct {
	Role           string              `json:"role"`
	Label          string              `json:"label"`
	Brand          string              `json:"brand"`
	Model          string              `json:"model"`
	Family         string              `json:"family,omitempty"`
	Connection     inverter.Connection `json:"connection"`
	IntervalS      int                 `json:"interval_s,omitempty"`
	CapacityKwp    float64             `json:"capacity_kwp,omitempty"`
	RegistryUnitID string              `json:"registry_unit_id,omitempty"`
}

// Normalize validates a request against the inverter catalog and returns a
// normalized Source (transport + label derived, defaults filled). The returned
// Source has NO id yet - the caller assigns one via NewID (kept separate so the
// idempotent re-validation of an existing source keeps its id). A validation
// failure is a *ValidationError with a German message.
func Normalize(cat inverter.Catalog, req Request, now time.Time) (Source, error) {
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = RoleErzeuger
	}
	if !isKnownRole(role) {
		return Source{}, invalid("Diese Art von Energiequelle wird nicht unterstützt (nur zusätzliche PV-Anlagen oder ein Netz-Zähler).")
	}

	// Reuse the exact inverter validation (brand/model/family + connection). The
	// same transport rules apply to a read-only source.
	sel, err := cat.Normalize(inverter.SelectionRequest{
		Brand:      req.Brand,
		Model:      req.Model,
		Family:     req.Family,
		Connection: req.Connection,
	}, now)
	if err != nil {
		// Surface the inverter validation message as a sources ValidationError so
		// callers deal with one error type.
		var ve *inverter.ValidationError
		if errors.As(err, &ve) {
			return Source{}, &ValidationError{Msg: ve.Msg}
		}
		return Source{}, err
	}

	interval := req.IntervalS
	if interval == 0 {
		interval = defaultIntervalS
	}
	if interval < minIntervalS || interval > maxIntervalS {
		return Source{}, invalid("Das Mess-Intervall muss zwischen %d und %d Sekunden liegen.", minIntervalS, maxIntervalS)
	}

	cap := req.CapacityKwp
	if cap < 0 || cap > maxCapacityKwp {
		return Source{}, invalid("Die Anlagenleistung (kWp) ist ungültig.")
	}

	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = sel.Label
	}

	src := Source{
		Role:           role,
		Label:          label,
		Brand:          sel.Brand,
		Model:          sel.Model,
		Family:         sel.Family,
		Communication:  sel.Communication,
		Connection:     sel.Connection,
		IntervalS:      interval,
		CapacityKwp:    cap,
		RegistryUnitID: strings.TrimSpace(req.RegistryUnitID),
		CreatedAt:      now.UTC(),
	}
	return src, nil
}

// idAlphabet has no 0/O/1/l/i lookalikes (same rationale as the device ref).
const idAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// NewID returns a short, stable, local source id.
func NewID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return "src-" + string(b)
}

// TopicPrefix is the local-bus namespace additional sources publish their
// readings under: edge/sources/{id}/telemetry.
const TopicPrefix = "edge/sources/"

// TopicWildcard subscribes to every source's telemetry.
const TopicWildcard = TopicPrefix + "+/telemetry"

// TopicConfig is the retained selection array the core publishes for Node-RED
// (sibling of edge/inverter/config).
const TopicConfig = "edge/sources/config"

// IDFromTopic extracts the source id from edge/sources/{id}/telemetry, or ""
// when the topic does not match that shape.
func IDFromTopic(topic string) string {
	if !strings.HasPrefix(topic, TopicPrefix) || !strings.HasSuffix(topic, "/telemetry") {
		return ""
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(topic, TopicPrefix), "/telemetry")
	if mid == "" || strings.Contains(mid, "/") {
		return ""
	}
	return mid
}

// busEntry renders one source into the retained-config object Node-RED reads to
// self-wire the read adapter: only the connection fields the chosen transport
// uses (mirrors inverter.Selection.BusPayload).
func (s Source) busEntry() map[string]any {
	conn := map[string]any{
		"ip":   s.Connection.IP,
		"port": s.Connection.Port,
	}
	switch s.Communication {
	case inverter.CommSolarmanV5:
		conn["serial"] = s.Connection.Serial
		conn["mb_slave_id"] = s.Connection.MbSlaveID
		conn["invert_grid_sign"] = s.Connection.InvertGridSign
		conn["power_scale"] = s.Connection.PowerScale
	case inverter.CommModbusTCP:
		conn["unit_id"] = s.Connection.UnitID
		conn["profile"] = s.Connection.Profile
	}
	return map[string]any{
		"id":            s.ID,
		"role":          s.Role,
		"brand":         s.Brand,
		"model":         s.Model,
		"family":        s.Family,
		"communication": s.Communication,
		"connection":    conn,
		"interval_s":    s.IntervalS,
		"capacity_kwp":  s.CapacityKwp,
	}
}

// BusConfig builds the retained edge/sources/config payload: the schema version
// plus the array of sources (each carrying only its transport's connection
// fields). An empty list yields an empty array, which CLEARS the retained
// config for Node-RED.
func BusConfig(list []Source) []byte {
	entries := make([]map[string]any, 0, len(list))
	for _, s := range list {
		entries = append(entries, s.busEntry())
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": SchemaVersion,
		"sources":        entries,
	})
	return raw
}

// --- Store: persist the source list across restarts (data-dir/sources.json),
// mirroring inverter.Store's atomic write. ---

// Store persists the additional-source list.
type Store struct{ path string }

// NewStore stores the list under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "sources.json")}, nil
}

// Save writes the list atomically.
func (s *Store) Save(list []Source) error {
	if list == nil {
		list = []Source{}
	}
	raw, err := json.Marshal(list)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted list, ok=false if none exists yet.
func (s *Store) Load() ([]Source, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var list []Source
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, false, fmt.Errorf("gespeicherte Energiequellen beschädigt: %w", err)
	}
	return list, true, nil
}
