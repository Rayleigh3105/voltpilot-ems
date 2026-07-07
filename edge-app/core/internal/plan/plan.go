// Package plan caches the cloud battery-dispatch schedule and selects the
// setpoint for "now".
//
// Contract: docs/contracts/mqtt-schedule.schema.json (FROZEN). The plan is
// received retained on ems/{t}/{s}/{d}/schedule, persisted to disk (so a
// reboot without network still has it) and considered STALE when no fresh
// schedule has been received for 20 minutes - the contract's x-failsafe
// Default-Watchdog window. Stale/missing plan, or "now" outside every slot,
// hands control to the self-consumption fallback (guards.SelfConsumption).
package plan

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

// StaleAfter is the contract's Default-Watchdog window: a schedule not
// refreshed within this window no longer drives the battery.
const StaleAfter = 20 * time.Minute

// Slot is one dispatch slot. Positive setpoint = charge, negative = discharge.
type Slot struct {
	Start             time.Time `json:"start"`
	BatterySetpointKw float64   `json:"battery_setpoint_kw"`
	// PvLimitKw is the OPTIONAL planned PV feed-in cap (curtailment) for the
	// slot, kW, >= 0. nil = no limit (the contract's default). The edge does not
	// EXECUTE this field (see docs/contracts/mqtt-schedule.schema.json), but it is
	// retained so the local Fahrplan view can show the planned curtailment.
	PvLimitKw *float64 `json:"pv_limit_kw,omitempty"`
}

// Plan is the parsed, validated schedule payload.
type Plan struct {
	PlanID      string    `json:"plan_id"`
	GeneratedAt time.Time `json:"generated_at"`
	SlotMinutes int       `json:"slot_minutes"`
	Slots       []Slot    `json:"slots"`
	// ReceivedAt anchors the staleness window; persisted with the plan.
	ReceivedAt time.Time `json:"received_at"`
}

// wire mirrors the contract JSON (RFC 3339 strings).
type wire struct {
	SchemaVersion string `json:"schema_version"`
	PlanID        string `json:"plan_id"`
	GeneratedAt   string `json:"generated_at"`
	SlotMinutes   int    `json:"slot_minutes"`
	Slots         []struct {
		Start             string   `json:"start"`
		BatterySetpointKw float64  `json:"battery_setpoint_kw"`
		PvLimitKw         *float64 `json:"pv_limit_kw"`
	} `json:"slots"`
}

// Parse validates a schedule payload against the frozen contract shape and
// stamps receivedAt. Unknown fields (plan metadata) are ignored, as the
// contract allows the edge to.
func Parse(payload []byte, receivedAt time.Time) (*Plan, error) {
	var w wire
	if err := json.Unmarshal(payload, &w); err != nil {
		return nil, fmt.Errorf("schedule payload: %w", err)
	}
	if w.SchemaVersion != "1.0" {
		return nil, fmt.Errorf("schedule schema_version %q not supported", w.SchemaVersion)
	}
	if w.SlotMinutes < 1 {
		return nil, errors.New("schedule slot_minutes missing")
	}
	if len(w.Slots) == 0 {
		return nil, errors.New("schedule has no slots")
	}
	p := &Plan{
		PlanID:      w.PlanID,
		SlotMinutes: w.SlotMinutes,
		ReceivedAt:  receivedAt,
	}
	if t, err := time.Parse(time.RFC3339, w.GeneratedAt); err == nil {
		p.GeneratedAt = t
	}
	for _, s := range w.Slots {
		start, err := time.Parse(time.RFC3339, s.Start)
		if err != nil {
			return nil, fmt.Errorf("slot start %q: %w", s.Start, err)
		}
		slot := Slot{Start: start, BatterySetpointKw: s.BatterySetpointKw}
		// Keep a valid, non-negative feed-in cap only; the contract guarantees
		// >= 0, and a bad value must never be shown as a real curtailment.
		if s.PvLimitKw != nil && !math.IsNaN(*s.PvLimitKw) && !math.IsInf(*s.PvLimitKw, 0) && *s.PvLimitKw >= 0 {
			v := *s.PvLimitKw
			slot.PvLimitKw = &v
		}
		p.Slots = append(p.Slots, slot)
	}
	return p, nil
}

// Fresh reports whether the plan may still drive the battery at "now".
func (p *Plan) Fresh(now time.Time) bool {
	return p != nil && now.Sub(p.ReceivedAt) <= StaleAfter
}

// ActiveSetpoint returns the setpoint of the slot whose
// [start, start+slot_minutes) contains now. ok=false when the plan is nil,
// stale, or now falls outside every slot - the caller then uses the
// self-consumption fallback.
func (p *Plan) ActiveSetpoint(now time.Time) (kw float64, slotStart time.Time, ok bool) {
	if !p.Fresh(now) {
		return 0, time.Time{}, false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.BatterySetpointKw, s.Start, true
		}
	}
	return 0, time.Time{}, false
}

// SlotView is one plan slot as the local Fahrplan view renders it.
type SlotView struct {
	Start             time.Time `json:"start"`
	BatterySetpointKw float64   `json:"battery_setpoint_kw"`
	// PvLimitKw echoes the slot's planned feed-in cap (nil = no limit).
	PvLimitKw *float64 `json:"pv_limit_kw,omitempty"`
	// Curtailed is true when the slot carries a PV feed-in cap (planned
	// curtailment) - the view draws a distinct marker for it.
	Curtailed bool `json:"curtailed"`
	// Active is true for the slot whose [start, start+slot_minutes) contains
	// "now", and only while the plan is fresh (matches ActiveSetpoint).
	Active bool `json:"active"`
}

// View is the cached plan projected for the local Fahrplan view at "now": the
// slots plus the derived freshness and which slot is executing. Read-only; it
// never influences execution.
type View struct {
	PlanID            string     `json:"plan_id"`
	GeneratedAt       time.Time  `json:"generated_at,omitzero"`
	ReceivedAt        time.Time  `json:"received_at"`
	SlotMinutes       int        `json:"slot_minutes"`
	StaleAfterSeconds int        `json:"stale_after_seconds"`
	Fresh             bool       `json:"fresh"`
	ActiveIndex       int        `json:"active_index"` // -1 when no slot is active
	Slots             []SlotView `json:"slots"`
}

// BuildView projects the plan for the local web app at "now": it marks the
// active slot (only when the plan is fresh, mirroring ActiveSetpoint), flags
// curtailed slots, and reports freshness against the contract's staleness
// window. Callers must not call it on a nil plan.
func (p *Plan) BuildView(now time.Time) View {
	fresh := p.Fresh(now)
	v := View{
		PlanID:            p.PlanID,
		GeneratedAt:       p.GeneratedAt,
		ReceivedAt:        p.ReceivedAt,
		SlotMinutes:       p.SlotMinutes,
		StaleAfterSeconds: int(StaleAfter / time.Second),
		Fresh:             fresh,
		ActiveIndex:       -1,
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	v.Slots = make([]SlotView, 0, len(p.Slots))
	for i, s := range p.Slots {
		active := fresh && !now.Before(s.Start) && now.Before(s.Start.Add(width))
		if active {
			v.ActiveIndex = i
		}
		v.Slots = append(v.Slots, SlotView{
			Start:             s.Start,
			BatterySetpointKw: s.BatterySetpointKw,
			PvLimitKw:         s.PvLimitKw,
			Curtailed:         s.PvLimitKw != nil,
			Active:            active,
		})
	}
	return v
}

// Store persists the last received plan across restarts.
type Store struct{ path string }

// NewStore stores the plan under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "plan.json")}, nil
}

// Save writes the plan atomically.
func (s *Store) Save(p *Plan) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted plan, or nil if none exists.
func (s *Store) Load() (*Plan, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p Plan
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("cached plan corrupt: %w", err)
	}
	return &p, nil
}
