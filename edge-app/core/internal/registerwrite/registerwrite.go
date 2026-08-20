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
// ⚠ IT IS THE SECOND TRIGGER, NOT A SECOND PATH. What it produces goes through
// the SAME two layers the :8484 maintenance endpoint uses - POLICY
// (installerwrite.AdmitExpert since Stufe 2: the free register with its value
// range and the confirm rule; Admit stays the narrow scope of the local button)
// and MECHANISM (Agent.WriteOnce). There is deliberately no way from here to a
// register nobody admitted; the portal-apply doctrine, word for word ("es gibt
// keinen zweiten Weg zum Anwenden, den man später getrennt absichern müsste").
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
//     inverter. It is NOT EXECUTED - but since 20.08.2026 it IS ANSWERED
//     (`invalid_request`, naming BOTH clocks). The execution ban is what
//     protects the EEPROM; the silence protected nothing and hid the one cause
//     nobody can see from the cloud - two clocks that have drifted apart.
//   - REPLAY - the same request_id is executed AT MOST ONCE. Non-retained plus
//     the window stop a LATE redelivery; this stops a concurrent or immediate
//     one (the mqtt-ota-apply token pattern).
//   - LANE - all three lanes of the contract are EXECUTED since Stufe 2
//     („Freie Register"): `primary` (the box resolves its own inverter),
//     `entity` (the box resolves the transport from ITS applied definition -
//     the cloud names only the id, so it can never redirect a write to a
//     foreign host) and `lan` (an explicit address, which is why the LAN
//     whitelist below applies to it). A form this box cannot run is still
//     ANSWERED with not_supported, never silently dropped.
//   - PRIVATE TARGET - the `lan` lane's host must be PROVABLY private, judged by
//     the probe channel's own whitelist (probe.IsPrivateHost, the five-consumer
//     rule of docs/contracts/lan-host-vectors.json - a fifth CONSUMER, not a
//     fifth twin). A bare hostname is refused because it resolves through the
//     box's search domains and cannot be proven private from the string.
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

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
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
	ErrInvalidRequest  = "invalid_request"
	ErrUnreachable     = "unreachable"
	ErrNoAnswer        = "no_answer"
	ErrInvalidResponse = "invalid_response"
	ErrTimeout         = "timeout"
	ErrNotSupported    = "not_supported"
	ErrRateLimited     = "rate_limited"
	// ErrGateDisabled/MsgGateDisabled are CONTRACT vocabulary only - since the
	// Captain-Korrektur of 20.08.2026 there is no per-box arming, so no current
	// build emits them. They stay because an OLDER box in the field still can,
	// and the cloud must keep understanding the word.
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
	MsgLaneUnknown      = "Unbekanntes Ziel."
	MsgEntityMissing    = "Für die Komponente fehlt die Kennung."
	MsgCoilNotSupported = "Über den Solarman-Logger lassen sich nur Holding-Register " +
		"beschreiben, keine Spulen."
	MsgHostNotPrivate = "Das Ziel liegt nicht nachweisbar im Kunden-Netz. Bitte die " +
		"IP-Adresse des Geräts eintragen (ein bloßer Gerätename lässt sich nicht als " +
		"privat nachweisen)."
	MsgBusy = "Auf diesem Gerät läuft bereits ein Schreibvorgang. Bitte einen " +
		"Moment warten."
	MsgControlOwned = "Dieses Register gehört gerade der laufenden Steuerung; Ihr Wert würde " +
		"binnen Sekunden überschrieben bzw. beim Zurückgeben zurückgedreht."
	MsgReplayed = "Diese Anfrage wurde bereits ausgeführt."
	// MsgNoOutcome/MsgCrashed sind die Quittungen der RECEIPT-GARANTIE
	// (agent.runRegisterWrite): ein angenommener Auftrag endet IMMER mit genau
	// einem Ergebnis - auch wenn die Ausführung auf dem Gerät ohne Antwort
	// zurückkehrt oder abstürzt. Beide beschreiben einen Fehler UNSERES Codes,
	// nie einen Zustand der Anlage, und sagen das auch.
	MsgNoOutcome = "Der Auftrag wurde angenommen, die Ausführung ist auf dem Gerät " +
		"aber ohne Ergebnis geendet. Es ist nicht sicher, ob etwas geschrieben wurde - " +
		"bitte den Ist-Wert mit einer Vorschau erneut lesen."
	MsgCrashed = "Bei der Ausführung ist auf dem Gerät ein unerwarteter Fehler " +
		"aufgetreten. Es ist nicht sicher, ob etwas geschrieben wurde - bitte den " +
		"Ist-Wert mit einer Vorschau erneut lesen."
)

// MsgInvalidRequest turns a FORM error into the sentence the portal shows.
//
// ⚠ It exists because a form error used to be answered with SILENCE, and from
// the cloud that is indistinguishable from „the box never got it" - the exact
// ambiguity that cost a whole investigation round on 20.08.2026. The parser's
// own German reason travels with it: it is the most precise thing anyone knows
// about that order.
func MsgInvalidRequest(reason error) string {
	if reason == nil {
		return "Der Auftrag ist nicht ausführbar."
	}
	return "Der Auftrag ist nicht ausführbar: " + reason.Error() + "."
}

// ExpiredMessage names BOTH clocks, because that is the only way the reader can
// tell the two causes apart: a QoS1 message the broker redelivered LATE, or two
// clocks that have drifted apart (a box without a buffered RTC). Neither is
// visible from the cloud, and until 20.08.2026 an expired order was dropped in
// complete silence, so neither was visible at all.
func ExpiredMessage(r Request, now time.Time, window time.Duration) string {
	return "Der Auftrag war bei Ankunft bereits abgelaufen (angefordert " +
		strings.TrimSpace(r.RequestedAt) + ", hier ist es " +
		now.UTC().Format(time.RFC3339) + ", Fenster " + window.String() +
		"). Es wurde nichts gelesen und nichts geschrieben. Wenn das wiederholt " +
		"auftritt, gehen die Uhren von Portal und Gerät auseinander."
}

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
//
// Port/UnitID are POINTERS for the same reason the probe channel's op uses them:
// on Modbus-TCP a unit id of 0 is a legitimate address, so „not given" and
// „given as 0" must not collapse - only the first one takes the contract's
// default (the probe.Op.EffectiveUnit precedent).
type Target struct {
	Kind     string `json:"kind"`
	EntityID string `json:"entity_id"`
	Host     string `json:"host"`
	Port     *int   `json:"port"`
	UnitID   *int   `json:"unit_id"`
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

// Answerable reports whether a REJECTED order can still be ANSWERED, i.e.
// whether the cloud would be able to make sense of the answer at all.
//
// ⚠ It is deliberately strict, and each condition is a rule of this channel:
// the identity must be OURS (answering a mis-addressed sender would confirm this
// device exists - the one refusal that stays silent forever), the correlation id
// must have the contract's shape (the cloud drops an answer it cannot correlate)
// and the stage must be one of the two known words (the cloud drops a result
// whose mode it does not know). Everything that passes all three is worth
// answering - silence there is a riddle, not a protection.
func (r Request) Answerable(id Identity) bool {
	return r.Matches(id) && validRequestID(r.RequestID) &&
		(r.Mode == ModeRead || r.Mode == ModeWrite)
}

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
// about the LANE and the shape of its target, before any policy about the
// register itself.
//
// It deliberately does NOT judge the address or the value: that is
// installerwrite.AdmitExpert's job, and duplicating it here would be a second
// policy that can drift from the one the local trigger obeys.
//
// ⚠ THE COIL RULE IS A PROPERTY OF THE LANE, NOT OF THE BOX. The Solarman-V5
// framing carries the holding-register functions only, so a coil on the primary
// inverter is honestly „not supported"; on plain Modbus-TCP (component / free
// LAN) FC1/FC5 exist and a coil is executed like any other object. Saying „this
// box does not do coils" would be false for two of the three lanes.
func (r Request) Admissible() Verdict {
	switch r.Target.Kind {
	case LanePrimary:
		if r.Register.Kind != KindHolding {
			return Verdict{ErrNotSupported, MsgCoilNotSupported}
		}
	case LaneEntity:
		if strings.TrimSpace(r.Target.EntityID) == "" {
			return Verdict{ErrInvalidRequest, MsgEntityMissing}
		}
	case LaneLAN:
		// ⚠ The ONLY lane whose endpoint the cloud names, so it is the only one
		// whose endpoint the box has to judge: whoever opens a connection checks
		// its target themselves (the OTA-sidecar discipline). The palette node
		// checks it a SECOND time before it dials.
		if !probe.IsPrivateHost(r.Target.Host) {
			return Verdict{ErrInvalidRequest, MsgHostNotPrivate}
		}
	default:
		return Verdict{ErrInvalidRequest, MsgLaneUnknown}
	}
	return Verdict{}
}

// EffectivePort / EffectiveUnit are the contract's documented defaults for the
// free-LAN lane. They live here, not in the agent, so the value the box dials is
// the value the pure rules judged.
func (t Target) EffectivePort() int {
	if t.Port == nil || *t.Port <= 0 || *t.Port > 0xffff {
		return 502
	}
	return *t.Port
}

func (t Target) EffectiveUnit() int {
	if t.UnitID == nil || *t.UnitID < 0 || *t.UnitID > 255 {
		return 1
	}
	return *t.UnitID
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
