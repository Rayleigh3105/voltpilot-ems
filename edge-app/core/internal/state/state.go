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
	ModeDesired     Mode = "wunsch"          // a v2 desired (flow/override) holds the battery entity
	ModeCalibration Mode = "kalibrierung"    // a First-Light calibration test is driving the battery
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
	// BufferPaused is true while the device is in the geraet_entfernt state
	// (removed/unclaimed in the cloud): the store-and-forward buffer is NOT
	// grown - there is no claimed identity to deliver it to - and the UI says so
	// honestly instead of silently piling up data that can never be sent. The
	// local dashboard/history keeps running; buffering resumes on re-claim.
	BufferPaused bool `json:"buffer_paused"`

	Mode         Mode      `json:"mode"`
	SetpointKw   float64   `json:"setpoint_kw"`
	SlotStart    time.Time `json:"slot_start,omitzero"`
	PlanReceived time.Time `json:"plan_received,omitzero"`
	PlanSlots    int       `json:"plan_slots"`

	// Peak guard (PS-3 "Spitzen-Wache") - the :8484 "Betrieb" card. All nil/
	// false while the site's peak-shaving module is off (the plan never carried
	// grid_import_limit_kw). PeakTargetKw/PeakReserveSocPct echo the LAST
	// plan-carried values (they survive a stale plan - the guard keeps defending
	// the last known target on a dead cloud link); PeakGuardActive is true only
	// while the guard can actually regulate (target known AND a fresh grid
	// measurement feeds the quarter tracker); PeakQuarterMeanKw is the running
	// wall-clock quarter hour's mean grid import so far.
	PeakTargetKw      *float64 `json:"peak_target_kw,omitempty"`
	PeakReserveSocPct *float64 `json:"peak_reserve_soc_pct,omitempty"`
	PeakGuardActive   bool     `json:"peak_guard_active"`
	PeakQuarterMeanKw *float64 `json:"peak_quarter_mean_kw,omitempty"`

	InverterLink     string    `json:"inverter_link"` // "up" | "down" | "" (unknown)
	InverterLinkSeen time.Time `json:"inverter_link_seen,omitzero"`

	// Inverter is the customer's inverter selection (brand/type/transport),
	// nil until one is chosen in the local web app.
	Inverter *InverterInfo `json:"inverter,omitempty"`

	// ControlEnabled is the global inverter-control kill-switch (VP_CONTROL_ENABLED,
	// default false). ControlCertified reflects whether the selected model's
	// register-map family is on the bench-certification allowlist. Together they
	// gate whether ANY setpoint is written to the inverter.
	ControlEnabled   bool `json:"control_enabled"`
	ControlCertified bool `json:"control_certified"`
	// Control is the latest per-register control readback (commanded vs actual),
	// nil until the first readback arrives. Read-only proof for the :8484
	// "Steuerung & Bestätigung" card + the cloud status heartbeat.
	Control *ControlInfo `json:"control,omitempty"`

	// CurtailUnits is the latest per-unit PV-curtailment readback state of the
	// fronius_sunspec Erzeuger sources (Fahrplan "Abregeln" executed on the
	// Fronius units): commanded-vs-actual registers, the applied cap, and the
	// EFFECT verdict (possible override - Modbus is the LOWEST Fronius control
	// priority, so a confirmed register alone proves nothing). Empty until the
	// first curtailment readback arrives; read-only display + heartbeat proof.
	CurtailUnits []CurtailUnit `json:"curtail_units,omitempty"`

	// DataPurge tracks a data purge ("Datenaufzeichnungen löschen") triggered
	// on this device: nil when none is in flight or everything is confirmed.
	DataPurge *DataPurgeInfo `json:"data_purge,omitempty"`

	SocPct      float64 `json:"soc_pct"`
	PvKw        float64 `json:"pv_kw"`
	LoadKw      float64 `json:"load_kw"`
	GridLimitKw float64 `json:"grid_limit_kw"`

	// LastReading is the PRIMARY inverter's most recent accepted reading, per
	// channel (pv_power_kw / load_kw / power_kw / soc_pct / grid_limit_kw),
	// captured BEFORE the multi-source aggregation so the setup page's
	// "Zuletzt gelesen" line shows the device's OWN values, not the composite
	// site reading (with additional Erzeuger/Netz sources the composite would
	// misattribute their share to the primary). A channel the device never
	// delivered is absent - never a fabricated 0; a gated (despiked/envelope)
	// channel holds its last accepted value like every other display path.
	// Timestamp = LastTelemetry. Display-only; nothing consumes it downstream.
	LastReading map[string]float64 `json:"last_reading,omitempty"`

	// DespikedDropped is the running count of transient garbage samples the
	// despike gate has rejected (drop-don't-fabricate). Exposed for field
	// diagnosis - a steadily climbing count points at a flaky Layer-1 read.
	DespikedDropped int `json:"despiked_dropped"`

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

// ControlInfo is the UI-facing per-register control readback: what the schedule
// commanded vs. what the inverter reads back, with an accept/mismatch verdict.
// Fed by edge/control/readback (report §5). Read-only proof - it controls
// nothing.
type ControlInfo struct {
	CheckedAt      time.Time         `json:"checked_at"`
	Family         string            `json:"family,omitempty"`
	Source         string            `json:"source,omitempty"` // "schedule" | "default"
	SlotStart      string            `json:"slot_start,omitempty"`
	ControlEnabled bool              `json:"control_enabled"`
	Certified      bool              `json:"certified"`
	AllMatch       bool              `json:"all_match"`
	MismatchRoles  []string          `json:"mismatch_roles,omitempty"`
	Registers      []ControlRegister `json:"registers"`
	// ControlPath names WHICH surface drove the write on a Deye: "remote" = the
	// Tier-2 register block 1100-1121 (a true signed watt setpoint, armed behind the
	// inverter's own watchdog, touching no installer setting), "tou" = the legacy
	// Time-of-Use synthesis. Empty for other adapters / older Layer-1 builds. The
	// operator must always be able to see which surface is steering the inverter.
	ControlPath string `json:"control_path,omitempty"`
	// RemoteStatusRaw is the Deye remote-control STATUS register (1121) - a
	// read-only OBSERVATION, never part of the commanded-vs-actual comparison.
	RemoteStatusRaw *int `json:"remote_status_raw,omitempty"`
	// PossibleConflict is the dual-controller "only-controller" awareness (report
	// §9 #6): while actively controlling, a commanded register that does not hold
	// its value means a second controller (the inverter's own smart-control or
	// another EMS) may be steering it. Surfaced, never silently fought.
	PossibleConflict bool   `json:"possible_conflict,omitempty"`
	ConflictReason   string `json:"conflict_reason,omitempty"`
	// Blocked marks that the control plan was EMPTY because something is WRONG (an
	// unknown nameplate / power scale) rather than a real readback. Reason carries
	// the operator-facing cause. The :8484 card renders this instead of an eternal
	// "warte auf Rückmeldung"; a blocked info deliberately has no Registers and is
	// NOT folded into the status heartbeat (see controlSummary). Fed by a blocked
	// edge/control/readback (Defect 2).
	Blocked bool   `json:"blocked,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// ControlRegister is one control register's commanded-vs-actual readback.
type ControlRegister struct {
	Role         string   `json:"role"`
	Fc           int      `json:"fc,omitempty"`
	Addr         int      `json:"addr"`
	CommandedRaw int      `json:"commanded_raw"`
	CommandedKw  *float64 `json:"commanded_kw,omitempty"`
	ActualRaw    int      `json:"actual_raw"`
	ActualKw     *float64 `json:"actual_kw,omitempty"`
	Match        bool     `json:"match"`
}

// CurtailUnit is the latest curtailment readback of ONE Fronius
// (fronius_sunspec) Erzeuger unit: what was commanded, what the registers
// actually hold, and whether the cap is ENFORCED (override detection by
// effect). Applied=false with registers = observed-only (uncertified /
// kill-switch off - the write gate held, the state is still shown honestly).
type CurtailUnit struct {
	SourceID       string    `json:"source_id"`
	UnitKey        string    `json:"unit_key"`
	Label          string    `json:"label,omitempty"`
	Target         string    `json:"target,omitempty"`
	CheckedAt      time.Time `json:"checked_at"`
	ControlEnabled bool      `json:"control_enabled"`
	Certified      bool      `json:"certified"`
	// Calibration marks a bounded First-Light curtailment test write.
	Calibration bool `json:"calibration,omitempty"`
	// Mode is "apply" (a cap is commanded) or "release" (limit lifted).
	Mode    string `json:"mode,omitempty"`
	Applied bool   `json:"applied"`
	// CapKw is this unit's share of the plant-level pv_limit_kw (nil on release).
	CapKw   *float64 `json:"cap_kw,omitempty"`
	RatedKw *float64 `json:"rated_kw,omitempty"`
	// AllMatch is nil for an observed-only readback (nothing was commanded).
	AllMatch      *bool             `json:"all_match,omitempty"`
	MismatchRoles []string          `json:"mismatch_roles,omitempty"`
	Registers     []ControlRegister `json:"registers,omitempty"`
	// EnforcementStatus: inactive|unknown|settling|ok|possible_override - the
	// EFFECT verdict comparing measured AC power against the commanded cap.
	EnforcementStatus string   `json:"enforcement_status,omitempty"`
	PossibleOverride  bool     `json:"possible_override,omitempty"`
	OverrideReason    string   `json:"override_reason,omitempty"`
	MeasuredKw        *float64 `json:"measured_kw,omitempty"`
	// Blocked: the executor could not act (gateway unreachable, no discovery,
	// no plan) - Reason carries the operator-facing cause, never silent.
	Blocked bool   `json:"blocked,omitempty"`
	Reason  string `json:"reason,omitempty"`
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
