// Package plan2 consumes the v2 multi-entity dispatch plan
// (docs/contracts/v2/mqtt-schedule-2.0.md + .schema.json), retained on
// ems/{t}/{s}/{d}/v2/plan. It mirrors the verified v1 semantics from
// internal/plan - the 20-minute staleness window, the generated_at redelivery
// anchor, disk persistence for reboot-without-network - generalized to N
// entities. The 1.0 path (internal/plan) is untouched; a device sees this
// package act only when a v2 plan is actually published for it.
package plan2

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// SchemaVersion of the 2.0 plan payload.
const SchemaVersion = "2.0"

// StaleAfter mirrors the v1 window: a plan not refreshed for 20 minutes no
// longer drives any entity (x-failsafe; the constants are contract).
const StaleAfter = 20 * time.Minute

// redeliverySlack mirrors v1: a redelivered retained payload whose
// generated_at is older than StaleAfter+slack is anchored to its generation
// time and can never look fresh again.
const redeliverySlack = 5 * time.Minute

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Slot is one entity's dispatch slot.
type Slot struct {
	Start    time.Time
	Commands entities.Commands
}

// Entity is one entity's dispatch series plus its storage postures.
type Entity struct {
	ID string
	// Kind is informative only - permissions always come from the registry.
	Kind string
	// ChargeFromGridAllowed: D-8 - absent or false = NOT allowed (solar-only
	// clamp binds); only an explicit true releases.
	ChargeFromGridAllowed bool
	// ReserveSocPct is the per-entity peak reserve (survives staleness).
	ReserveSocPct *float64
	Slots         []Slot
}

// Plan is a parsed, validated 2.0 plan.
type Plan struct {
	PlanID      string
	DeviceID    string
	GeneratedAt time.Time
	ReceivedAt  time.Time
	SlotMinutes int
	// GridImportLimitKw is the site-level PS-1 peak target (survives
	// staleness, restrict-only; nil = none / cleared).
	GridImportLimitKw *float64
	Entities          []Entity
}

// Parse validates a …/v2/plan payload. receivedAt anchors freshness; the
// generated_at redelivery rule is applied exactly like v1 plan.Parse.
// Unknown top-level fields are ignored (the 1.0 tolerance rule); a payload
// that is not a 2.0 plan is an error.
func Parse(payload []byte, receivedAt time.Time) (*Plan, error) {
	var msg struct {
		SchemaVersion     string   `json:"schema_version"`
		DeviceID          string   `json:"device_id"`
		PlanID            string   `json:"plan_id"`
		GeneratedAt       string   `json:"generated_at"`
		SlotMinutes       int      `json:"slot_minutes"`
		GridImportLimitKw *float64 `json:"grid_import_limit_kw"`
		Entities          []struct {
			EntityID              string   `json:"entity_id"`
			Kind                  string   `json:"kind"`
			ChargeFromGridAllowed *bool    `json:"charge_from_grid_allowed"`
			ReserveSocPct         *float64 `json:"reserve_soc_pct"`
			Slots                 []struct {
				Start    string `json:"start"`
				Commands struct {
					SetpointKw *float64 `json:"setpoint_kw"`
					LimitKw    *float64 `json:"limit_kw"`
					LimitPct   *float64 `json:"limit_pct"`
					OnOff      *bool    `json:"on_off"`
					Mode       string   `json:"mode"`
				} `json:"commands"`
			} `json:"slots"`
		} `json:"entities"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return nil, fmt.Errorf("plan payload unreadable: %w", err)
	}
	if msg.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("unsupported plan schema_version %q", msg.SchemaVersion)
	}
	if msg.SlotMinutes < 1 {
		return nil, fmt.Errorf("slot_minutes %d invalid", msg.SlotMinutes)
	}
	if len(msg.Entities) == 0 {
		return nil, errors.New("plan carries no entities")
	}
	p := &Plan{
		PlanID:      msg.PlanID,
		DeviceID:    msg.DeviceID,
		SlotMinutes: msg.SlotMinutes,
		ReceivedAt:  receivedAt.UTC(),
	}
	if msg.GridImportLimitKw != nil {
		v := *msg.GridImportLimitKw
		if !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 {
			p.GridImportLimitKw = &v
		}
	}
	if msg.GeneratedAt != "" {
		if t, err := time.Parse(time.RFC3339Nano, msg.GeneratedAt); err == nil {
			p.GeneratedAt = t.UTC()
		}
	}
	// The v1 redelivery anchor, verbatim semantics: an old retained payload is
	// anchored to its generation time so it can never look fresh again.
	if !p.GeneratedAt.IsZero() && receivedAt.Sub(p.GeneratedAt) > StaleAfter+redeliverySlack {
		p.ReceivedAt = p.GeneratedAt.Add(redeliverySlack)
	}

	seen := map[string]bool{}
	for _, e := range msg.Entities {
		if !idPattern.MatchString(e.EntityID) || seen[e.EntityID] {
			// Logged-and-skipped territory for the CALLER; structurally we
			// just drop it (the schedule contract: unknown/invalid entity
			// entries are never fatal).
			continue
		}
		seen[e.EntityID] = true
		ent := Entity{ID: e.EntityID, Kind: e.Kind,
			ChargeFromGridAllowed: e.ChargeFromGridAllowed != nil && *e.ChargeFromGridAllowed}
		if e.ReserveSocPct != nil && *e.ReserveSocPct >= 0 && *e.ReserveSocPct <= 100 {
			v := *e.ReserveSocPct
			ent.ReserveSocPct = &v
		}
		for _, s := range e.Slots {
			start, err := time.Parse(time.RFC3339Nano, s.Start)
			if err != nil {
				continue
			}
			cmds := entities.Commands{
				SetpointKw: cleanNum(s.Commands.SetpointKw),
				LimitKw:    cleanNum(s.Commands.LimitKw),
				LimitPct:   cleanNum(s.Commands.LimitPct),
				OnOff:      s.Commands.OnOff,
				Mode:       s.Commands.Mode,
			}
			if cmds.Empty() {
				continue
			}
			ent.Slots = append(ent.Slots, Slot{Start: start.UTC(), Commands: cmds})
		}
		sort.Slice(ent.Slots, func(i, j int) bool { return ent.Slots[i].Start.Before(ent.Slots[j].Start) })
		if len(ent.Slots) > 0 {
			p.Entities = append(p.Entities, ent)
		}
	}
	if len(p.Entities) == 0 {
		return nil, errors.New("plan carries no usable entity slots")
	}
	return p, nil
}

func cleanNum(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	out := *v
	return &out
}

// Fresh mirrors the v1 rule: within StaleAfter of (anchored) receipt.
func (p *Plan) Fresh(now time.Time) bool {
	return p != nil && now.Sub(p.ReceivedAt) <= StaleAfter
}

// Entity returns the plan entry for one entity id, nil when the plan does not
// command it (the caller releases such entities).
func (p *Plan) Entity(id string) *Entity {
	if p == nil {
		return nil
	}
	for i := range p.Entities {
		if p.Entities[i].ID == id {
			return &p.Entities[i]
		}
	}
	return nil
}

// ActiveCommands returns the entity's slot whose [start, start+slot_minutes)
// contains now, ok=false when no slot covers now (or the plan is stale - the
// caller withdraws then).
func (p *Plan) ActiveCommands(entityID string, now time.Time) (entities.Commands, time.Time, bool) {
	if !p.Fresh(now) {
		return entities.Commands{}, time.Time{}, false
	}
	e := p.Entity(entityID)
	if e == nil {
		return entities.Commands{}, time.Time{}, false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range e.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.Commands, s.Start, true
		}
	}
	return entities.Commands{}, time.Time{}, false
}

// EntityIDs lists the entities this plan commands.
func (p *Plan) EntityIDs() []string {
	if p == nil {
		return nil
	}
	ids := make([]string, 0, len(p.Entities))
	for _, e := range p.Entities {
		ids = append(ids, e.ID)
	}
	return ids
}

// --- persistence (the v1 plan.Store pattern) --------------------------------

// Store persists the last received v2 plan (reboot-without-network).
type Store struct{ path string }

// NewStore stores under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "plan2.json")}, nil
}

type storedPlan struct {
	ReceivedAt time.Time       `json:"received_at"`
	Payload    json.RawMessage `json:"payload"`
}

// Save persists the raw payload with its receipt time; Load re-parses through
// Parse so the staleness anchoring stays the single source of truth.
func (s *Store) Save(payload []byte, receivedAt time.Time) error {
	raw, err := json.Marshal(storedPlan{ReceivedAt: receivedAt.UTC(), Payload: payload})
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted plan, nil when none exists.
func (s *Store) Load() (*Plan, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var stored storedPlan
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("gespeicherter v2-Plan beschädigt: %w", err)
	}
	return Parse(stored.Payload, stored.ReceivedAt)
}

// Clear removes the persisted plan (retained-clear received).
func (s *Store) Clear() error {
	err := os.Remove(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
