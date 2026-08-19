// Package registerwrite holds the PURE half of the Register-Schreibkanal
// (Konzept vp-reg-schreib-konzept-p8 §2.2; contract
// docs/contracts/mqtt-register-write.schema.json): parsing the cloud's one-shot
// order, deciding whether it may be executed at all, and shaping the answer.
//
// It touches nothing - no socket, no bus, no clock: every time-dependent
// function takes `now`, exactly like internal/probe, internal/otaapply and
// internal/calibration. The split is the point: every rule that can REFUSE a
// portal write is provable without a single container or device.
//
// ⚠ IT IS THE SECOND TRIGGER, NOT A SECOND PATH. What it produces is an
// installerwrite.Request that goes through the SAME two layers the :8484
// maintenance endpoint uses - POLICY (installerwrite.Admit: the allowlist, the
// value ceiling, the confirm rule) and MECHANISM (Agent.WriteOnce). There is
// deliberately no way from here to a register nobody admitted; the portal-apply
// doctrine, word for word ("es gibt keinen zweiten Weg zum Anwenden, den man
// später getrennt absichern müsste").
//
// The refusals this package owns, and why each exists:
//
//   - IDENTITY - an order whose payload identity is not this box's own is
//     discarded SILENTLY. The broker ACL + the mTLS CN already make it
//     impossible for anyone else to publish here; this is the second half of
//     the same discipline telemetry, purge_data, the OTA assignment and the
//     apply approval all carry. Answering would confirm to a mis-addressed
//     sender that this device exists.
//   - EXPIRY - `requested_at` (NOT the arrival time) starts the window, and it
//     matters MORE here than anywhere else: the box holds a durable session, so
//     the broker may REDELIVER a QoS1 message after an outage - and a redelivered
//     WRITE order would spend another EEPROM write cycle on a customer's
//     inverter. Also silent: the portal route gave up long ago.
//   - REPLAY - the same request_id is executed AT MOST ONCE. Non-retained plus
//     the window stop a LATE redelivery; this stops a concurrent or immediate
//     one (the mqtt-ota-apply token pattern).
//   - LANE - Stufe 1 executes `primary` only. `entity` and `lan` are in the
//     contract and are ANSWERED with not_supported, never silently dropped: a
//     box in the field must be able to NAME a form it cannot run yet.
//   - SELF-CONFLICT - a register the RUNNING control loop currently commands is
//     refused. That is not a restriction of freedom but honesty about the
//     receipt: our own executor would overwrite the value within seconds, or
//     restore it from its snapshot when it hands the inverter back - an
//     "übernommen ✓" that quietly comes undone days later would be a lie.
//
// Plus one bound: a RATE LIMIT, tighter than the probe channel's, because every
// admitted order costs an EEPROM write cycle. A throttled order is ANSWERED, as
// on the probe channel - it is OUR decision, not the device's.
package registerwrite

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SchemaVersion is the only accepted contract version.
const SchemaVersion = "1.0"

// Message types on the two topics.
const (
	TypeRequest = "register_write_request"
	TypeResult  = "register_write_result"
)

// The two stages. They mirror installerwrite.ModeDry/ModeApply; the CONTRACT
// speaks German because it is the operator's vocabulary, the mechanism speaks
// its own - the mapping lives in exactly one place (Request.Apply).
const (
	ModeRead  = "lesen"
	ModeWrite = "schreiben"
)

// The three lanes of the contract. Stufe 1 executes LanePrimary only.
const (
	LanePrimary = "primary"
	LaneEntity  = "entity"
	LaneLAN     = "lan"
)

// Register kinds.
const (
	KindHolding = "holding"
	KindCoil    = "coil"
)

// The closed error vocabulary (contract $defs/error_code). The cloud DROPS a
// word outside this set rather than passing it on, so an invented code never
// reaches a customer - which means a code invented here would simply vanish.
const (
	ErrInvalidRequest        = "invalid_request"
	ErrUnreachable           = "unreachable"
	ErrNoAnswer              = "no_answer"
	ErrInvalidResponse       = "invalid_response"
	ErrTimeout               = "timeout"
	ErrNotSupported          = "not_supported"
	ErrRateLimited           = "rate_limited"
	ErrGateDisabled          = "gate_disabled"
	ErrRefusedPolicy         = "refused_policy"
	ErrRefusedControlOwned   = "refused_control_owned"
	ErrRefusedExpectedBefore = "refused_expected_before"
	ErrBusy                  = "busy"
)

// DefaultWindow is how long an order stays executable, counted from its OWN
// `requested_at`.
const DefaultWindow = 60 * time.Second

// The rate bound. Deliberately TIGHTER than the probe channel's twelve reads a
// minute: an admitted write costs an EEPROM cycle, and no legitimate operator
// flow needs more than a handful in a minute.
const (
	DefaultRateWindow = time.Minute
	DefaultRateBudget = 6
)

// The German sentences this package owns. They are constants because the same
// refusal must read identically in the box log and on the portal card.
const (
	MsgRateLimited = "Zu viele Schreib-Anfragen in kurzer Zeit. Bitte einen Moment warten " +
		"und erneut versuchen."
	MsgGateDisabled     = "Der Register-Schreibpfad ist auf diesem Gerät nicht freigeschaltet."
	MsgLaneNotSupported = "Diese Box kann derzeit nur den primären Wechselrichter beschreiben."
	MsgCoilNotSupported = "Diese Box beschreibt derzeit nur Holding-Register, keine Spulen."
	MsgBusy             = "Auf diesem Gerät läuft bereits ein Schreibvorgang. Bitte einen " +
		"Moment warten."
	MsgControlOwned = "Dieses Register gehört gerade der laufenden Steuerung; Ihr Wert würde " +
		"binnen Sekunden überschrieben bzw. beim Zurückgeben zurückgedreht."
	MsgReplayed = "Diese Anfrage wurde bereits ausgeführt."
)

// Request is one order as it arrives from the cloud.
type Request struct {
	SchemaVersion string `json:"schema_version"`
	Type          string `json:"type"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	RequestID     string `json:"request_id"`
	RequestedAt   string `json:"requested_at"`
	RequestedBy   string `json:"requested_by"`
	Mode          string `json:"mode"`
	Target        Target `json:"target"`
	Register      Reg    `json:"register"`
	WriteFC       *int   `json:"write_fc"`
	// Value/ExpectedBefore are POINTERS because 0 is a legitimate register word
	// - „not given" and „given as 0" are different facts.
	Value          *int   `json:"value"`
	ExpectedBefore *int   `json:"expected_before"`
	Confirm        string `json:"confirm"`
}

// Target is WHERE the order goes.
type Target struct {
	Kind     string `json:"kind"`
	EntityID string `json:"entity_id"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	UnitID   int    `json:"unit_id"`
}

// Reg is the addressed register.
type Reg struct {
	Kind    string `json:"kind"`
	Address int    `json:"address"`
}

// Identity is this box's own cloud identity.
type Identity struct {
	TenantID string
	SiteID   string
	DeviceID string
}

// Result is the answer that goes back on .../v2/register-write-result.
//
// BeforeRaw/AfterRaw are POINTERS on purpose: a 0 here is a VALUE („no feed-in
// allowed at all"), never an absence. Adopted is a pointer for the same reason
// in the other direction - „no statement" and „did not adopt" must not collapse.
type Result struct {
	SchemaVersion string `json:"schema_version"`
	Type          string `json:"type"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	RequestID     string `json:"request_id"`
	AnsweredAt    string `json:"answered_at"`
	Mode          string `json:"mode"`
	OK            bool   `json:"ok"`
	BeforeRaw     *int   `json:"before_raw,omitempty"`
	AfterRaw      *int   `json:"after_raw,omitempty"`
	Wrote         *bool  `json:"wrote,omitempty"`
	Adopted       *bool  `json:"adopted,omitempty"`
	TargetLabel   string `json:"target_label,omitempty"`
	ErrorCode     string `json:"error_code,omitempty"`
	Message       string `json:"message,omitempty"`
}

var reqIDChars = func() [256]bool {
	var t [256]bool
	for _, c := range "0123456789abcdef" {
		t[byte(c)] = true
	}
	return t
}()

// Parse turns the raw downlink bytes into a Request and checks the FORM only -
// version, type, the correlation id, the stage and the register shape.
// Everything about WHETHER it may run is a separate, explicit step (Matches /
// Expired / Admissible), so a caller cannot accidentally skip one by parsing
// successfully.
func Parse(payload []byte) (Request, error) {
	var req Request
	if len(payload) == 0 {
		return req, fmt.Errorf("leere Anfrage")
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return req, fmt.Errorf("kein gueltiges JSON: %w", err)
	}
	if req.SchemaVersion != SchemaVersion || req.Type != TypeRequest {
		return req, fmt.Errorf("unbekannte Form (schema_version=%q type=%q)",
			req.SchemaVersion, req.Type)
	}
	if !validRequestID(req.RequestID) {
		return req, fmt.Errorf("request_id fehlt oder ist keine Hex-Kennung")
	}
	if req.Mode != ModeRead && req.Mode != ModeWrite {
		return req, fmt.Errorf("unbekannter Modus %q", req.Mode)
	}
	if req.Register.Address < 0 || req.Register.Address > 0xffff {
		return req, fmt.Errorf("Adresse %d ist kein Register", req.Register.Address)
	}
	if req.Register.Kind != KindHolding && req.Register.Kind != KindCoil {
		return req, fmt.Errorf("unbekannte Registerart %q", req.Register.Kind)
	}
	// A WRITE without value or confirm is refused HERE, before any policy layer
	// sees it: the contract forbids it, and a half-formed write order must never
	// travel further than the parser.
	if req.Mode == ModeWrite {
		if req.Value == nil {
			return req, fmt.Errorf("Schreib-Auftrag ohne Wert")
		}
		if strings.TrimSpace(req.Confirm) == "" {
			return req, fmt.Errorf("Schreib-Auftrag ohne Bestaetigung")
		}
	}
	return req, nil
}

func validRequestID(id string) bool {
	if len(id) < 16 || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		if !reqIDChars[id[i]] {
			return false
		}
	}
	return true
}

// Apply reports whether this order is the REAL write (as opposed to the preview).
func (r Request) Apply() bool { return r.Mode == ModeWrite }

// Matches reports whether the order's payload identity is this box's own.
// A mismatch is discarded, never answered.
func (r Request) Matches(id Identity) bool {
	if id.DeviceID == "" || id.TenantID == "" || id.SiteID == "" {
		return false
	}
	return strings.EqualFold(r.DeviceID, id.DeviceID) &&
		strings.EqualFold(r.TenantID, id.TenantID) &&
		strings.EqualFold(r.SiteID, id.SiteID)
}

// Expired reports whether the order is past its window, counted from its OWN
// `requested_at`. An UNREADABLE stamp counts as expired - in doubt nothing is
// written (the contract says so, and it is the safe direction: the cost of a
// missed order is a second click, the cost of a wrong one is an EEPROM cycle on
// a customer's inverter).
//
// A stamp in the future is deliberately NOT expired: the two clocks are
// independent, and a box running behind must not refuse work the portal is
// actively waiting for.
func (r Request) Expired(now time.Time, window time.Duration) bool {
	ts, err := time.Parse(time.RFC3339, r.RequestedAt)
	if err != nil {
		return true
	}
	return now.Sub(ts) > window
}

// Verdict is a refusal: a machine word plus the German sentence that travels
// with it. The zero value means „admitted".
type Verdict struct {
	Code    string
	Message string
}

// OK reports that nothing refused the order.
func (v Verdict) OK() bool { return v.Code == "" }

// Admissible decides whether this box will EXECUTE the order at all - the rules
// that are about the FORM and this box's capabilities, before any policy about
// the register itself.
//
// It deliberately does NOT judge the address or the value: that is
// installerwrite.Admit's job, and duplicating it here would be a second policy
// that can drift from the one the local trigger obeys.
func (r Request) Admissible() Verdict {
	switch r.Target.Kind {
	case LanePrimary:
		// The one lane Stufe 1 executes.
	case LaneEntity, LaneLAN:
		// Named, never silently dropped: a box in the field must be able to say
		// "I cannot do that (yet)" instead of leaving the portal in a timeout.
		return Verdict{ErrNotSupported, MsgLaneNotSupported}
	default:
		return Verdict{ErrInvalidRequest, "Unbekanntes Ziel."}
	}
	if r.Register.Kind != KindHolding {
		return Verdict{ErrNotSupported, MsgCoilNotSupported}
	}
	return Verdict{}
}

// ControlOwns reports whether the RUNNING control loop currently commands this
// address - the self-conflict rule, and the ONE hard refusal of this channel.
//
// ⚠ It is decided from what the box can PROVE, not from a guess: `owned` are
// the addresses of the newest control readback cycle, i.e. exactly the registers
// our own executor is writing right now. On a hybrid_3p that legitimately
// includes 0x00E7 whenever the plan curtails (the ToU path writes the feed-in
// cap there) and whenever a ToU session holds its installer snapshot - the two
// cases in which an "übernommen ✓" would silently come undone.
//
// `active` is the second half: without the global kill switch AND the model's
// certification the control loop writes nothing at all, so the same registers
// are the installer's domain again and must not be refused.
func ControlOwns(active bool, owned []int, address int) bool {
	if !active {
		return false
	}
	for _, a := range owned {
		if a == address {
			return true
		}
	}
	return false
}

// NewResult shapes the answer to an ADMITTED order.
func NewResult(req Request, id Identity, now time.Time, before, after *int, wrote, adopted *bool,
	targetLabel, message string) Result {
	return Result{
		SchemaVersion: SchemaVersion, Type: TypeResult,
		TenantID: id.TenantID, SiteID: id.SiteID, DeviceID: id.DeviceID,
		RequestID: req.RequestID, AnsweredAt: now.UTC().Format(time.RFC3339),
		Mode: req.Mode, OK: true,
		BeforeRaw: before, AfterRaw: after, Wrote: wrote, Adopted: adopted,
		TargetLabel: targetLabel, Message: message,
	}
}

// Refused shapes the answer to a REFUSED order. It never carries a value: a
// refusal that reported a reading would invite exactly the "but it said 3300"
// confusion this channel exists to avoid.
func Refused(req Request, id Identity, now time.Time, code, message string) Result {
	return Result{
		SchemaVersion: SchemaVersion, Type: TypeResult,
		TenantID: id.TenantID, SiteID: id.SiteID, DeviceID: id.DeviceID,
		RequestID: req.RequestID, AnsweredAt: now.UTC().Format(time.RFC3339),
		Mode: req.Mode, OK: false, ErrorCode: code, Message: message,
	}
}
