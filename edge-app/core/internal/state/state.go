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
	// ModeOtaNeutral: an URGENT autonomous update deliberately parks the plant
	// neutral for the seconds of the swap (OTA Stufe 3 escape hatch). It is its
	// OWN mode because the honest answer to "what drives the setpoint right
	// now" is neither the plan nor self-consumption - and a surface that shows
	// a cause must be able to name this one.
	ModeOtaNeutral Mode = "ota_neutral"
	// ModeNeutralTest: a guided Neutral-Zeit-Test (docs/ota-autonomie.md §3)
	// is measuring the inverter's Kommunikations-Verlust-Zeit T - during its
	// silent phase NOTHING is written at all, which is the entire mechanism,
	// so this mode names the reason a surface must not mistake for a stuck
	// setpoint.
	ModeNeutralTest Mode = "neutralzeit_test"
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
	PeakTargetKw         *float64 `json:"peak_target_kw,omitempty"`
	PeakReserveSocPct    *float64 `json:"peak_reserve_soc_pct,omitempty"`
	EffectiveFloorSocPct *float64 `json:"effective_floor_soc_pct,omitempty"`
	PeakGuardActive      bool     `json:"peak_guard_active"`
	PeakQuarterMeanKw    *float64 `json:"peak_quarter_mean_kw,omitempty"`

	// Trim is the price-aware in-slot limitation (2026-07-30), non-nil ONLY while
	// it is actually lowering the commanded charge. It exists so the card can name
	// a DELIBERATE limitation: without it the customer would see a confirmed
	// setpoint far below the Fahrplan and no reason for it.
	Trim *TrimInfo `json:"trim,omitempty"`

	// Follow is the in-slot load following (2026-07-30), non-nil ONLY while it is
	// actually deepening the commanded discharge. Same reason as Trim: without it
	// the customer would see a confirmed setpoint far BELOW the Fahrplan value
	// (more discharge) and no reason for it. The two are mutually exclusive by
	// construction - one acts on charge, the other on discharge.
	Follow *FollowInfo `json:"follow,omitempty"`

	// Absorb is the in-slot surplus absorption (2026-08-02), non-nil ONLY while
	// it is actually RAISING the commanded charge to the measured PV surplus.
	// Same reason as Trim and Follow: without it the customer would see a
	// confirmed setpoint far ABOVE the Fahrplan value and no reason for it. It is
	// disjoint from both by construction - it only ever raises a NON-NEGATIVE
	// command, and only up to the surplus.
	Absorb *AbsorbInfo `json:"absorb,omitempty"`

	// ExportGuard is the live feed-in watchdog at the grid connection point
	// (dynamische Einspeisebegrenzung), non-nil whenever the site HAS a feed-in
	// limit configured - including while it is only watching, because a
	// compliance limit that is being observed is itself the news. It carries its
	// own German sentence (written once in guards.ExportLimiter and rendered
	// verbatim here and in the cloud heartbeat) plus the honest statement of
	// whether it can actually reach a device.
	ExportGuard *ExportGuardInfo `json:"export_guard,omitempty"`

	// DeviceExportLimit is the feed-in limit the INVERTER ITSELF holds - a
	// foreign truth inside the customer's device that we READ (never write) from
	// its own register, at most once a day („Grenzen & Wächter" Stufe 0). nil =
	// not read: an older poll, a family whose register map has no trustworthy
	// feed-in cap, or simply not read yet. Never a fabricated 0, and never "the
	// device has no limit".
	DeviceExportLimit *DeviceExportLimitInfo `json:"device_export_limit,omitempty"`

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
	// ControlCertSource names WHICH source granted it: "env" (the fleet-wide
	// allowlist), "device" (this box's First-Light grant) or "platform" (the
	// cloud model register). Empty = not certified. Reported only.
	ControlCertSource string `json:"control_cert_source,omitempty"`
	// PlatformCert is what the PLATFORM register says about the selected model
	// (the cloud document on .../v2/control-certification). nil = no usable
	// document, which reads "unbekannt" and NEVER "nicht zertifiziert" - an
	// older cloud, a cleared retained slot and a genuinely uncertified model are
	// three different statements. It only ever ADDS a certification source next
	// to the env allowlist and the local First-Light grant.
	PlatformCert *PlatformCertInfo `json:"platform_cert,omitempty"`
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

	// Ocpp is the OCPP charge-point picture (nil while VP_OCPP_ENABLED is off,
	// which is the default - the box then behaves as it did before the
	// feature existed).
	Ocpp *OcppInfo `json:"ocpp,omitempty"`

	// CarsFirstCapKw is the „Auto vor Speicher"-Klemme currently limiting the
	// battery's CHARGE (OCPP-Lastmanagement Stufe 4): the customer decided
	// their vehicles get the PV surplus first, so the storage may only take
	// what is left of it. nil = the cap is not biting (no such choice, no
	// vehicle drawing, no fresh measurement, or the command was already below
	// it) - and then nothing on the control card claims one. A named
	// limitation is the whole point: an unnamed one reads as a defect.
	CarsFirstCapKw *float64 `json:"cars_first_cap_kw,omitempty"`

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

	// OtaState/OtaReason are the verdict of the last OTA release verification
	// (agent/ota.go, OTA Stufe 1) - the same two values the heartbeat's `update`
	// block carries. They live here so /health can answer "was das Release, das
	// ich abgelegt habe, in Ordnung?" WITHOUT a cloud link, which is exactly the
	// supervised on-box test. Verification only: nothing on the device applies
	// anything, so OtaState never leaves idle/verifying in this stage.
	OtaState  string `json:"ota_state,omitempty"`
	OtaReason string `json:"ota_reason,omitempty"`
}

// DataPurgeInfo is the UI-facing state of a device-triggered data purge.
// LocalState and CloudState expose the two independently retryable halves:
//
//	LocalState:
//	"ausstehend" - restart-safe intent exists; local cleanup must retry
//	"fehler"     - the latest local cleanup failed; intent remains durable
//	"bereinigt"  - local buffer/history/OCPP journal cleanup completed
//
//	CloudState:
//	"ausstehend"  - request not yet sent (device offline); re-sent on connect
//	"angefordert" - request published, waiting for the cloud's confirmation
//	"bestaetigt"  - the cloud's purge_data command arrived (then cleared soon after)
type DataPurgeInfo struct {
	RequestedAt time.Time `json:"requested_at"`
	LocalState  string    `json:"local_state,omitempty"`
	CloudState  string    `json:"cloud_state"`
	ConfirmedAt time.Time `json:"confirmed_at,omitzero"`
}

// TrimInfo is the UI-facing state of the price-aware in-slot trim: the cloud
// marked this slot's grid purchases uneconomic, so the commanded CHARGE is being
// held at the MEASURED surplus. Read-only display of a decision already taken -
// the limitation itself lives in guards.PriceTrimmer.
type TrimInfo struct {
	// Active is always true when the block exists (it is omitted otherwise).
	Active bool `json:"active"`
	// PlannedKw is the setpoint BEFORE the trim - what the Fahrplan/holder asked
	// for, so the card can say "der Fahrplan wollte X kW".
	PlannedKw float64 `json:"planned_kw"`
	// SurplusKw is the measured surplus the charge is held at; nil when unknown
	// (then the trim would be inactive anyway - never regulate blind).
	SurplusKw *float64 `json:"surplus_kw,omitempty"`
}

// FollowInfo is the UI-facing state of the in-slot load following: the cloud
// marked this slot worth covering from the battery, so the commanded DISCHARGE
// is being TRACKED to the MEASURED house deficit - raised where the forecast
// watt value falls short of it, limited where it exceeds it - instead of being
// executed rigidly. The discharge-side mirror of TrimInfo, and read-only display
// of a decision already taken - the correction itself lives in
// guards.LoadFollower.
type FollowInfo struct {
	// Active is always true when the block exists (it is omitted otherwise).
	Active bool `json:"active"`
	// Direction is guards.FollowDeepen ("deepen", the discharge was raised to
	// cover the house) or guards.FollowReduce ("reduce", it was limited to what
	// the house needs, at most down to zero). The card names it - an unnamed
	// correction reads as a defect.
	Direction string `json:"direction,omitempty"`
	// Path is "follow" for the established planned-discharge correction or
	// "idle_follow" when the additive idle-slot authorization started it.
	Path string `json:"path,omitempty"`
	// PlannedKw is the setpoint BEFORE the correction - what the Fahrplan/holder
	// asked for, so the card can say "der Fahrplan wollte X kW".
	PlannedKw float64 `json:"planned_kw"`
	// DeficitKw is the measured house deficit max(load - pv, 0) the discharge
	// follows; nil when unknown (then the correction would be inactive anyway -
	// never regulate blind).
	DeficitKw *float64 `json:"deficit_kw,omitempty"`
}

// AbsorbInfo is the UI-facing state of the in-slot surplus absorption: the cloud
// marked this slot's stored kWh worth more than the feed-in it would fetch, so
// the commanded CHARGE is being RAISED to the MEASURED PV surplus instead of
// leaving a surplus the forecast never saw to be exported. The charge-side
// counterpart of TrimInfo (which only ever lowers), and read-only display of a
// decision already taken - the correction itself lives in guards.SurplusCharger.
type AbsorbInfo struct {
	// Active is always true when the block exists (it is omitted otherwise).
	Active bool `json:"active"`
	// PlannedKw is the setpoint BEFORE the correction - what the Fahrplan/holder
	// asked for, so the card can say "der Fahrplan wollte X kW".
	PlannedKw float64 `json:"planned_kw"`
	// SurplusKw is the measured surplus the charge is raised to; nil when unknown
	// (then the correction would be inactive anyway - never regulate blind).
	SurplusKw *float64 `json:"surplus_kw,omitempty"`
}

// ExportGuardInfo is the UI-facing state of the dynamic feed-in limitation: the
// site has a feed-in limit at the grid connection point, and the device is
// regulating its CONTROLLABLE producers against the MEASURED connection point so
// the limit holds while the house (and its wallboxes) move. Read-only display of
// a decision already taken - the loop itself lives in guards.ExportLimiter.
//
// The two honesty rules it exists for:
//   - Reason is ALWAYS filled, in every state, including the blind fallbacks: a
//     limitation nobody names reads as a defect, and "the measurement went away"
//     must never look like "everything is fine".
//   - Effective says whether the computed cap can reach a device at all. A
//     watchdog nobody wrote to is not a protection, and an operator who is about
//     to disconnect their own controller must be able to see that.
type ExportGuardInfo struct {
	// LimitKw is the configured feed-in limit at the connection point.
	LimitKw float64 `json:"limit_kw"`
	// State is the machine-readable verdict (guards.ExportState): aus |
	// ueberwacht | regelt | haelt | zieht_zusammen | sicherheitskappe.
	State string `json:"state"`
	// Reason is the German sentence for exactly that state.
	Reason string `json:"reason"`
	// CapKw is the plant-level PV cap currently commanded; nil only when no
	// limit is configured (then this whole block is absent).
	CapKw *float64 `json:"cap_kw,omitempty"`
	// Limiting is true while the cap actually holds the producers back.
	Limiting bool `json:"limiting"`
	// Blind is true whenever the verdict was NOT formed from a fresh
	// connection-point measurement (hold / contract / safe cap).
	Blind bool `json:"blind"`
	// ExportKw / PvKw are the measurements behind the verdict; nil when blind.
	ExportKw *float64 `json:"export_kw,omitempty"`
	PvKw     *float64 `json:"pv_kw,omitempty"`
	// MeasurementAgeSeconds is how old the newest usable connection-point
	// measurement is; nil when there has never been one.
	MeasurementAgeSeconds *int `json:"measurement_age_seconds,omitempty"`
	// Units / CertifiedUnits are the curtailment-capable inverters and how many
	// carry a First-Light release.
	Units          int `json:"units"`
	CertifiedUnits int `json:"certified_units"`
	// Effective is false when the cap cannot reach ANY device (no curtailable
	// inverter, the control kill-switch off, or no released unit). Reach names
	// the gap in German whenever the reach is not complete - including the
	// PARTIAL case, where the watchdog works but cannot pull back every inverter.
	Effective bool   `json:"effective"`
	Reach     string `json:"reach,omitempty"`
}

// DeviceExportLimitInfo is the feed-in limit the INVERTER ITSELF holds, read
// from its own register and never written („Grenzen & Wächter" Stufe 0, Vierer
// #4). At Anlage Herzogau the Deye held an installer cap of 33,0 kW in 0x00E7
// while 70 kW were configured in the portal - a discrepancy that stayed
// invisible through two investigation rounds because nobody read the register.
//
// It has its OWN timestamp because it ages on a completely different clock than
// everything else on this snapshot: the register is read at most once a day (one
// socket, no extra poll cadence), so borrowing another block's freshness would
// claim a recency it does not have.
type DeviceExportLimitInfo struct {
	// LimitKw is the limit the device currently holds, in kW at the grid
	// connection point. A value of 0 is a VALUE ("may not feed in at all").
	LimitKw float64 `json:"limit_kw"`
	// Register is WHERE it came from ("0x00e7") - a number without its origin is
	// not evidence, and the later raw view renders it.
	Register string `json:"register"`
	// ReadAt is when the poll delivered this word.
	ReadAt time.Time `json:"read_at"`
}

// PlatformCertInfo is the platform register's verdict for the SELECTED inverter
// (contract docs/contracts/mqtt-control-certification.schema.json). Read-only
// proof for the :8484 card and the heartbeat - it never widens a guard.
type PlatformCertInfo struct {
	// Verdict is one of controlcert.Verdict: "granted" | "covered_not_activated"
	// | "not_covered" | "unknown". The three non-granted answers are DIFFERENT
	// sentences and must never be collapsed: "a bench run is needed", "one click
	// is needed", "we do not know".
	Verdict string `json:"verdict"`
	// Model is the register entry that matched, when one did.
	Model string `json:"model,omitempty"`
	// CertifiedAt is the bench date of the matching entry, verbatim.
	CertifiedAt string `json:"certified_at,omitempty"`
	// Reason is the plain-German refusal cause where a covered-looking model
	// still gets nothing (today: a contradicted write-sign convention).
	Reason string `json:"reason,omitempty"`
	// SeenAt is when this device last applied a cloud document.
	SeenAt time.Time `json:"seen_at,omitzero"`
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
	// --- the DEBOUNCED confirmation state (the flap fix, 2026-07-30) -----------
	// Verify is the RAW verdict of the NEWEST readback cycle as Layer 1 judged it
	// (readback-verify.js): "held" | "mismatch" | "unconfirmed". "unconfirmed" =
	// the inverter did not answer the readback, which is NOT evidence that it
	// refused the write. Empty for an older Layer-1 build (then derived from
	// AllMatch).
	Verify string `json:"verify,omitempty"`
	// UnreadRoles names the registers of the newest cycle that carried no value.
	UnreadRoles []string `json:"unread_roles,omitempty"`
	// Confirm is the OPERATOR-FACING state, and the ONLY thing a warning may key
	// on. One deviating cycle is a flicker, not a fault:
	//   "held"      - the last KNOWN cycle held (later unconfirmed cycles keep it)
	//   "checking"  - a deviation was seen but not yet confirmed N times
	//   "not_held"  - ControlMismatchAlarmCycles consecutive deviating cycles: the
	//                 inverter really is not holding what we command
	//   "no_answer" - ControlNoAnswerCycles consecutive cycles without an answer:
	//                 silence, honestly named - never dressed up as healthy
	//   "pending"   - no cycle has produced a verdict yet
	Confirm string `json:"confirm,omitempty"`
	// MismatchCycles / UnconfirmedCycles are the running consecutive counts behind
	// Confirm (0 after a held cycle). Shown as the technician's detail.
	MismatchCycles    int `json:"mismatch_cycles,omitempty"`
	UnconfirmedCycles int `json:"unconfirmed_cycles,omitempty"`
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
	// ActualRaw is NIL when the register carried no answer (an empty payload, a
	// read error, or the Solarman all-zero non-answer). Never a fabricated 0: that
	// zero would otherwise reach the card, the Modbus mirror and the First-Light
	// evidence as if the inverter had reported it.
	ActualRaw *int     `json:"actual_raw"`
	ActualKw  *float64 `json:"actual_kw,omitempty"`
	Match     bool     `json:"match"`
	// Verdict is the per-register semantics result: "held" | "mismatch" | "unread"
	// (readback-verify.js). Empty for an older Layer-1 build - then Match is the
	// only truth and "unread" cannot occur. Note carries the plain-German detail
	// (e.g. a watchdog counting down).
	Verdict string `json:"verdict,omitempty"`
	Note    string `json:"note,omitempty"`
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
	AllMatch      *bool    `json:"all_match,omitempty"`
	MismatchRoles []string `json:"mismatch_roles,omitempty"`
	// QuirkRoles/QuirkNote: register deviations recognised as a KNOWN, harmless
	// firmware behaviour (WMaxLim_Ena answering 1 to a commanded 0 on this
	// Datamanager). NOT mismatches, NOT a fault - naming them as one would send
	// an operator hunting a defect that does not exist.
	QuirkRoles []string          `json:"quirk_roles,omitempty"`
	QuirkNote  string            `json:"quirk_note,omitempty"`
	Registers  []ControlRegister `json:"registers,omitempty"`
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

// --- OCPP charge points (Ladepunkte) ---
//
// Plain mirror types, like CurtailUnit above: the state snapshot stays a
// dependency-light view every surface can render, and the agent maps the
// csms/lastmgmt facts into it.

// OcppInfo is the whole charge-point picture. nil on the snapshot = the
// feature flag is off and the box behaves as it did before it existed.
type OcppInfo struct {
	Enabled   bool   `json:"enabled"`
	Listening bool   `json:"listening"`
	Error     string `json:"error,omitempty"`
	// Endpoint is the BASE url an operator types into a station; the full one
	// carries the station's own ChargePointId after it.
	Endpoint string `json:"endpoint,omitempty"`
	// Port / URLPath are the two halves of that endpoint the CLOUD needs to
	// render it (it knows the box's LAN address since D5, but not what the box
	// serves on). Port is 0 while the server is not listening - then there is
	// nothing to dial, and a surface must say so rather than name a port
	// nobody answers on.
	Port    int    `json:"ocpp_port,omitempty"`
	URLPath string `json:"url_path,omitempty"`

	// ControlEnabled reports whether the LIVE allocation may be written.
	//
	// ⚠ It is a SEPARATE gate from Enabled: the protective profiles (the
	// station cap and the safe default) are installed whenever the server
	// runs, because they only ever REDUCE. The live allocation additionally
	// needs the plant's control switches. When it is off, ControlNote says so
	// - a refusal nobody can see is a riddle (the OTA canary-soak lesson).
	ControlEnabled bool   `json:"control_enabled"`
	ControlNote    string `json:"control_note,omitempty"`

	// The site's own numbers, so a surface can show the arithmetic rather than
	// a bare budget.
	GridLimitKw    float64 `json:"grid_limit_kw"`
	HouseReserveKw float64 `json:"house_reserve_kw"`
	MarginPct      float64 `json:"margin_pct"`
	MinPowerKw     float64 `json:"min_power_kw"`
	BudgetKw       float64 `json:"budget_kw"`
	// ReservedKw is held back for charge points the box cannot currently
	// reach: they are holding their own safe default, and their cars may be
	// taking it, so that power is not ours to hand out. 0 while every station
	// is reachable. The allocatable budget is BudgetKw - ReservedKw.
	ReservedKw  float64 `json:"reserved_kw,omitempty"`
	AllocatedKw float64 `json:"allocated_kw"`
	// MeasuredKw is the sum of what the stations REPORT drawing right now.
	// nil = not one connector reported a measurement - never a fabricated 0.
	MeasuredKw *float64 `json:"measured_kw,omitempty"`

	// SafeDefaultKw is the emergency per-connector limit currently derived,
	// with the terms it came from so the customer can be shown the sum.
	SafeDefaultKw    float64 `json:"safe_default_kw"`
	SafeDefaultNote  string  `json:"safe_default_note,omitempty"`
	SafeDefaultHolds bool    `json:"safe_default_holds"`
	SafeWorstCaseKw  float64 `json:"safe_worst_case_kw"`
	MaxHouseLoadKw   float64 `json:"max_house_load_kw"`
	ConnectorCount   int     `json:"connector_count"`

	// --- Stufe 2: where BudgetKw came from (internal/lastmgmt/budget.go) ---

	// StaticBudget echoes the operator's switch: true = the dynamic budget is
	// off for this site and the maintained numbers decide alone.
	StaticBudget bool `json:"static_budget,omitempty"`
	// BudgetMode is the machine-readable stage (statisch | gemessen | haelt |
	// zieht_zusammen | sicherheitsbudget) and BudgetNote its German sentence,
	// written ONCE in the tracker so the card and the cloud cannot word the
	// same verdict differently.
	BudgetMode string `json:"budget_mode,omitempty"`
	BudgetNote string `json:"budget_note,omitempty"`
	// BudgetBlind is true whenever the budget was NOT formed from a fresh
	// measurement (holding / contracting / safe).
	BudgetBlind bool `json:"budget_blind,omitempty"`
	// EffLimitKw is the connection limit actually in force: the maintained
	// Anschlussgrenze, or the observed §14a envelope when that is tighter.
	EffLimitKw float64 `json:"eff_limit_kw,omitempty"`
	// Grid14aKw is that observed envelope; nil = never reported, which is NOT
	// a limit of zero. Grid14aBinds says whether it is what caps the site.
	Grid14aKw    *float64 `json:"grid_14a_kw,omitempty"`
	Grid14aBinds bool     `json:"grid_14a_binds,omitempty"`
	// PlanLimitKw is what the FAHRPLAN leaves the vehicles in the running
	// quarter hour (the cloud's peak target, projected); nil = kein
	// Fahrplan-Deckel - kein Plan, ein veralteter Plan, kein Ziel oder keine
	// Messung, und dann gilt die lokale Logik unverändert (fail-open).
	// PlanLimitBinds says whether it is what caps the vehicles.
	PlanLimitKw    *float64 `json:"plan_limit_kw,omitempty"`
	PlanLimitBinds bool     `json:"plan_limit_binds,omitempty"`
	// SiteLoadKw is the rest of the site (everything but the charge points) the
	// budget was computed from; SiteGridKw the newest measured grid power
	// (+ import). Both nil while the budget is static or blind - never a
	// fabricated measurement.
	SiteLoadKw *float64 `json:"site_load_kw,omitempty"`
	SiteGridKw *float64 `json:"site_grid_kw,omitempty"`
	// MeasurementAgeS is how old the newest usable measurement is (seconds).
	MeasurementAgeS int `json:"measurement_age_s,omitempty"`

	// --- Stufe 4: the SOURCE lane (internal/lastmgmt/surplus.go) ---
	//
	// It is the customer's ECONOMIC choice ("woher kommt der Strom?"), and it
	// can only ever NARROW what the connection above already allows. The two
	// numbers are shown TOGETHER on purpose (Mockups §1a): a plant throttled
	// while its connection is free would otherwise read like a defect.

	// SurplusPolicy / StoragePriority echo the customer's own choice.
	SurplusPolicy   string `json:"surplus_policy,omitempty"`
	StoragePriority string `json:"storage_priority,omitempty"`
	// SurplusActive is false when there is NO source cap at all (either
	// „Schnell laden", or a lane that cannot be proven and fails open).
	SurplusActive bool `json:"surplus_active"`
	// SurplusKw is the source cap in force; nil while inactive - never a 0
	// that would read as "the sun offers nothing".
	SurplusKw *float64 `json:"surplus_kw,omitempty"`
	// SurplusMode / SurplusNote are the machine word and the German sentence,
	// written ONCE in the tracker.
	SurplusMode  string `json:"surplus_mode,omitempty"`
	SurplusNote  string `json:"surplus_note,omitempty"`
	SurplusBlind bool   `json:"surplus_blind,omitempty"`
	// SurplusTotalKw is the WHOLE measured surplus before anybody took it;
	// SurplusBatteryKw what the storage is measured taking. Both nil without a
	// fresh measurement.
	SurplusTotalKw   *float64 `json:"surplus_total_kw,omitempty"`
	SurplusBatteryKw *float64 `json:"surplus_battery_kw,omitempty"`
	// SourceAllocatedKw is how much of the allocation the source lane is
	// covering - a STANDORT statement, never a per-vehicle solar quota.
	SourceAllocatedKw float64 `json:"source_allocated_kw,omitempty"`

	Chargers []OcppCharger `json:"chargers"`
}

// HasReportedChargePoint reports whether at least one REGISTERED charge point
// has ever spoken to this box. It is the charge-point half of the
// commissioning gate (Lastmanagement Stufe 3, concept §5.1: a Ladepark box has
// no inverter, so the gate must ask "does SOME component deliver data").
//
// ⚠ It keys on "has ever been seen", not on the live socket: a station that
// flaps must not re-lock a commissioning step that was already passed, and a
// BootNotification IS the connection proof for a charge point. It lives HERE,
// on the snapshot, so the web gate and the heartbeat cannot drift into two
// answers to one question.
func (s Snapshot) HasReportedChargePoint() bool {
	if s.Ocpp == nil {
		return false
	}
	for _, c := range s.Ocpp.Chargers {
		if c.LastSeenMs > 0 || c.Connected {
			return true
		}
	}
	return false
}

// OcppCharger is one charge point for the surface.
type OcppCharger struct {
	ID        string `json:"id"`
	Label     string `json:"label,omitempty"`
	Priority  bool   `json:"priority,omitempty"`
	Connected bool   `json:"connected"`
	// Vendor/Model/Firmware are the station's own words. DISPLAY ONLY - no
	// mechanism anywhere branches on them (the herstellerneutral rule).
	Vendor   string `json:"vendor,omitempty"`
	Model    string `json:"model,omitempty"`
	Firmware string `json:"firmware,omitempty"`
	// Ready is true once the two permanent profiles are installed. Note names
	// the reason when it is not - never an unexplained "not ready".
	Ready      bool            `json:"ready"`
	Note       string          `json:"note,omitempty"`
	LastSeenMs int64           `json:"last_seen_ms,omitempty"`
	Connectors []OcppConnector `json:"connectors,omitempty"`
}

// OcppConnector is one plug.
type OcppConnector struct {
	ID     int    `json:"id"`
	Status string `json:"status,omitempty"`
	// Charging reports whether this plug claims budget right now.
	Charging bool `json:"charging"`
	// AllocatedKw is what the load management granted (0 while paused);
	// nil = this plug is not part of the current decision at all.
	AllocatedKw *float64 `json:"allocated_kw,omitempty"`
	// Reason / ReasonText are the allocator's machine word and its German
	// sentence (see lastmgmt.Text).
	Reason     string `json:"reason,omitempty"`
	ReasonText string `json:"reason_text,omitempty"`
	// NextTurnMs is when a waiting plug is estimated to get its turn (0 = not
	// computable, and then the surface must say nothing).
	NextTurnMs int64 `json:"next_turn_ms,omitempty"`
	// PowerKw / EnergyKwh / SocPct are what the station MEASURED. Absent =
	// not reported, never a fabricated 0.
	PowerKw   *float64 `json:"power_kw,omitempty"`
	EnergyKwh *float64 `json:"energy_kwh,omitempty"`
	SocPct    *float64 `json:"soc_pct,omitempty"`
	// CommandStatus / Readback carry the station's own answers: an accepted
	// command is not a command in force.
	CommandStatus string `json:"command_status,omitempty"`
	Readback      string `json:"readback,omitempty"`
	ReadbackNote  string `json:"readback_note,omitempty"`
	SessionSince  int64  `json:"session_since_ms,omitempty"`
	// Boost is true while this plug's „Jetzt voll laden" is running: the value
	// was formed WITHOUT the source cap and may contain grid power. The
	// surface SAYS so - a full charge nobody asked for would be a silent
	// break of the customer's own priority.
	Boost bool `json:"boost,omitempty"`
}
