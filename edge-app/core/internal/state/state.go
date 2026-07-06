// Package state is the shared runtime state the local web app renders.
// Every subsystem reports into it; readers get a consistent snapshot.
package state

import (
	"sync"
	"time"
)

// Mode is the current control mode (what drives the battery setpoint).
type Mode string

const (
	ModeSchedule    Mode = "fahrplan"        // fresh cloud plan, active slot
	ModeSelfConsume Mode = "eigenverbrauch"  // self-consumption fallback
	ModeNoReading   Mode = "keine_messwerte" // no inverter reading -> no setpoint
)

// Snapshot is one consistent view of the agent for the UI / health endpoint.
type Snapshot struct {
	Ref          string `json:"ref"`
	PairingState string `json:"pairing_state"` // enroll.State + "verbunden" once cloud-linked
	DeviceID     string `json:"device_id,omitempty"`
	SiteID       string `json:"site_id,omitempty"`
	TenantID     string `json:"tenant_id,omitempty"`
	MqttHost     string `json:"mqtt_host,omitempty"`

	CloudConnected bool      `json:"cloud_connected"`
	LastTelemetry  time.Time `json:"last_telemetry,omitzero"`
	LastCloudPub   time.Time `json:"last_cloud_publish,omitzero"`
	BufferPending  int       `json:"buffer_pending"`
	// BufferDataLoss is true while a long outage is discarding the oldest
	// buffered telemetry (retention horizon overrun) - the UI warns the customer
	// instead of the pending count silently plateauing.
	BufferDataLoss bool `json:"buffer_data_loss"`

	Mode         Mode      `json:"mode"`
	SetpointKw   float64   `json:"setpoint_kw"`
	SlotStart    time.Time `json:"slot_start,omitzero"`
	PlanReceived time.Time `json:"plan_received,omitzero"`
	PlanSlots    int       `json:"plan_slots"`

	InverterLink     string    `json:"inverter_link"` // "up" | "down" | "" (unknown)
	InverterLinkSeen time.Time `json:"inverter_link_seen,omitzero"`

	// Inverter is the customer's inverter selection (brand/type/transport),
	// nil until one is chosen in the local web app.
	Inverter *InverterInfo `json:"inverter,omitempty"`

	// DataPurge tracks a data purge ("Datenaufzeichnungen löschen") triggered
	// on this device: nil when none is in flight or everything is confirmed.
	DataPurge *DataPurgeInfo `json:"data_purge,omitempty"`

	SocPct      float64 `json:"soc_pct"`
	PvKw        float64 `json:"pv_kw"`
	LoadKw      float64 `json:"load_kw"`
	GridLimitKw float64 `json:"grid_limit_kw"`

	StartedAt time.Time `json:"started_at"`
	Version   string    `json:"version"`
}

// DataPurgeInfo is the UI-facing state of a device-triggered data purge.
// The local wipe always happens immediately; CloudState tracks the cloud half:
//
//	"ausstehend"  - request not yet sent (device offline); re-sent on connect
//	"angefordert" - request published, waiting for the cloud's confirmation
//	"bestaetigt"  - the cloud's purge_data command arrived (then cleared soon after)
type DataPurgeInfo struct {
	RequestedAt time.Time `json:"requested_at"`
	CloudState  string    `json:"cloud_state"`
	ConfirmedAt time.Time `json:"confirmed_at,omitzero"`
}

// InverterInfo is the UI-facing summary of the selected inverter.
type InverterInfo struct {
	Brand         string `json:"brand"`
	Label         string `json:"label"`
	Model         string `json:"model,omitempty"`
	Family        string `json:"family"`
	Communication string `json:"communication"`
	Host          string `json:"host"`
	Configured    bool   `json:"configured"`
}

// Store is the concurrency-safe holder.
type Store struct {
	mu   sync.RWMutex
	snap Snapshot
}

func New(ref, version string) *Store {
	return &Store{snap: Snapshot{
		Ref:          ref,
		Version:      version,
		StartedAt:    time.Now().UTC(),
		Mode:         ModeNoReading,
		PairingState: "start",
	}}
}

// Update mutates the snapshot under the lock.
func (s *Store) Update(fn func(*Snapshot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.snap)
}

// Get returns a copy of the current snapshot.
func (s *Store) Get() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snap
}
