// Package probe holds the PURE half of the Probe-Kanal (Einheitsmodell Stufe
// 0b; contract docs/contracts/mqtt-probe.schema.json): parsing the cloud's
// one-shot request, deciding whether it may be executed at all, and shaping the
// answer. It touches nothing - no socket, no bus, no clock: every
// time-dependent function takes `now`, exactly like internal/otaapply,
// internal/calibration and internal/curtailcal.
//
// The split is the point. Every rule that can REFUSE a probe lives here and is
// provable without a single container or device; internal/agent only wires it
// to the cloud link and to the box's existing read discipline.
//
// The three refusals this package owns, and why each exists:
//
//   - IDENTITY - a request whose payload identity is not this box's own is
//     discarded. The broker's ACL + the mTLS CN already make it impossible for
//     anyone else to publish here; this is the second half of the same
//     discipline that telemetry, purge_data, the OTA assignment and the apply
//     approval all carry.
//   - EXPIRY - `requested_at` (NOT the arrival time) starts the window. The box
//     holds a durable session, so the broker may REDELIVER a QoS1 message after
//     an outage; without this rule a probe from an hour ago would knock on a
//     customer's device long after the portal route that asked for it gave up.
//   - PRIVATE TARGET - the host must be in the customer's own LAN. Without it a
//     bug in the portal (or a hostile input reaching it) would turn every box in
//     the fleet into an outbound port scanner. The box checks this ITSELF and
//     does not take the cloud's word for it - the OTA-sidecar discipline.
//
// Plus one bound: a RATE LIMIT, because the thing at the other end is a
// customer's Modbus device, and many of them fall over under load. A refused
// probe is ANSWERED (`rate_limited`), never silently swallowed - the assistant
// has to be able to say why nothing is coming.
package probe

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"time"
)

// SchemaVersion is the only accepted contract version.
const SchemaVersion = "1.0"

// Message types on the two topics.
const (
	TypeRequest = "probe_request"
	TypeResult  = "probe_result"
)

// Op types.
const (
	OpRead = "read"
	// OpTestConnection is the assistant's connection test, GENERALIZED to every
	// transport (Einheitsmodell Stufe 1). Unlike OpRead it names the DEVICE
	// (brand/model/family + the template's connection fields) instead of a
	// register, and the box picks the matching reader itself - the exact form
	// the :8484 button has taken since it existed, only asked from the portal.
	OpTestConnection = "test_connection"
	// OpSwitchTest and OpSwitchCancel are the only WRITING ops of this channel
	// (Einheitsmodell Stufe 4): the guided switch test of the release assistant
	// and its abort. They write exactly the two values the request names, into
	// exactly the one register it names, with an auto-off armed BEFORE the
	// write - never a value the box chose and never an address it remembered.
	OpSwitchTest   = "switch_test"
	OpSwitchCancel = "switch_cancel"
	// OpSwitchSet is the ON/OFF switch of a FREE I/O-module output on the
	// portal's device page: set_value stays until someone switches again - no
	// auto-off. That is only acceptable for TransportEbyte: the module's own
	// watchdog drops every output when the box falls silent, and the core
	// driver re-checks identity, stack and ownership. A free Modbus register
	// has no such net and never gets this op.
	OpSwitchSet = "switch_set"
)

// TransportModbusTCP is the only transport V1 executes.
const TransportModbusTCP = "modbus_tcp"

// TransportEbyte is the Ebyte I/O module's output: a WRITE-only transport of
// the switch ops (switch_test / switch_cancel) that the CORE executes through
// its own module driver (internal/ebyte - the one socket owner, MAC and stack
// checks included). The coil address is the 0-based output (DO1 = 0).
const TransportEbyte = "ebyte_modbus_tcp"

// Modbus function codes a switch op may use. FC16 is the DEFAULT for a holding
// register, not FC6: a single-register write is ACCEPTED but not ADOPTED by
// several real devices (the documented Fronius/Deye lesson), so the safe
// default is the one that provably lands and FC6 stays the explicit fallback.
const (
	WriteFCCoil     = 5
	WriteFCSingle   = 6
	WriteFCMultiple = 16
)

// RegisterKindHolding / RegisterKindCoil are the two writable register kinds.
const (
	RegisterKindHolding = "holding"
	RegisterKindCoil    = "coil"
)

// MaxSwitchTTL mirrors the contract's ttl_s ceiling. A test the customer has to
// watch is short by construction; a long one would be a control channel.
const MaxSwitchTTL = 120

// Error codes. The first six are the testconn vocabulary verbatim
// (edge-app/core/internal/testconn) so one German copy table serves both
// surfaces; the last two are the cases the probe channel has and the local
// connection test does not.
const (
	ErrInvalidRequest  = "invalid_request"
	ErrUnreachable     = "unreachable"
	ErrNoAnswer        = "no_answer"
	ErrInvalidResponse = "invalid_response"
	ErrImplausible     = "implausible"
	ErrTimeout         = "timeout"
	// ErrFroniusAPI - the Fronius Solar API did not answer / TLS problem. Part
	// of the testconn vocabulary; it can only ever come from a test_connection.
	ErrFroniusAPI = "fronius_api"
	// ErrNotSupported - this build does not EXECUTE that op type or transport.
	// It is a statement about the box, never about the device.
	ErrNotSupported = "not_supported"
	// ErrRateLimited - the box is deliberately not knocking again right now.
	ErrRateLimited = "rate_limited"
)

// DefaultWindow is how long a request stays executable, counted from its own
// `requested_at`. The portal route waits ~5 s and then gives up, so anything
// older is certainly unwanted; the remaining headroom is for clock skew between
// cloud and box (the box's clock is not authoritative for anything else here,
// and a box that runs BEHIND simply becomes more permissive, never less safe -
// a future stamp is not "expired").
const DefaultWindow = 60 * time.Second

// MaxOps mirrors the contract's `maxItems`. A probe answers one assistant step,
// not a register map.
const MaxOps = 8

// Request is the parsed cloud -> edge envelope.
type Request struct {
	SchemaVersion string `json:"schema_version"`
	Type          string `json:"type"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	RequestID     string `json:"request_id"`
	RequestedAt   string `json:"requested_at"`
	RequestedBy   string `json:"requested_by,omitempty"`
	Ops           []Op   `json:"ops"`
}

// Op is one step of a request. It is the UNION of the contract's op shapes -
// which op the fields belong to is decided by Op.Op, and ValidateOp refuses
// anything it cannot place.
type Op struct {
	Op           string   `json:"op"`
	ID           string   `json:"id"`
	Transport    string   `json:"transport"`
	Host         string   `json:"host"`
	Port         *int     `json:"port,omitempty"`
	UnitID       *int     `json:"unit_id,omitempty"`
	RegisterKind string   `json:"register_kind"`
	Address      *int     `json:"address"`
	DataType     string   `json:"data_type,omitempty"`
	WordOrder    string   `json:"word_order,omitempty"`
	Scale        *float64 `json:"scale,omitempty"`
	Offset       *float64 `json:"offset,omitempty"`

	// test_connection only: the DEVICE, in the same shape the local test form
	// takes. Connection stays raw so the box maps it onto its OWN catalog
	// connection struct - the field list lives in exactly one place.
	Brand      string          `json:"brand,omitempty"`
	Model      string          `json:"model,omitempty"`
	Family     string          `json:"family,omitempty"`
	Role       string          `json:"role,omitempty"`
	Connection json.RawMessage `json:"connection,omitempty"`

	// switch_test / switch_cancel only.
	WriteFC         *int `json:"write_fc,omitempty"`
	OnValue         *int `json:"on_value,omitempty"`
	OffValue        *int `json:"off_value,omitempty"`
	TTLSeconds      *int `json:"ttl_s,omitempty"`
	ReadbackAddress *int `json:"readback_address,omitempty"`
	// switch_set only: 1 = on, 0 = off.
	SetValue *int `json:"set_value,omitempty"`
}

// Writes reports whether this op type WRITES to the device. It is the one
// place that answers that question, so a new op type cannot silently slip past
// a caller that only meant to allow reads.
func (o Op) Writes() bool {
	return o.Op == OpSwitchTest || o.Op == OpSwitchCancel || o.Op == OpSwitchSet
}

// EffectiveWriteFC returns the function code this switch op writes with, with
// the contract default applied (coil -> 5, holding -> 16). ValidateOp has
// already refused an inconsistent pairing, so this never has to guess.
func (o Op) EffectiveWriteFC() int {
	if o.WriteFC != nil {
		return *o.WriteFC
	}
	if o.RegisterKind == RegisterKindCoil {
		return WriteFCCoil
	}
	return WriteFCMultiple
}

// EffectiveTTL returns the switch test's auto-off delay in seconds (0 for a
// cancel, which has none).
func (o Op) EffectiveTTL() int {
	if o.TTLSeconds == nil {
		return 0
	}
	return *o.TTLSeconds
}

// Result is the edge -> cloud answer.
type Result struct {
	SchemaVersion string     `json:"schema_version"`
	Type          string     `json:"type"`
	TenantID      string     `json:"tenant_id"`
	SiteID        string     `json:"site_id"`
	DeviceID      string     `json:"device_id"`
	RequestID     string     `json:"request_id"`
	AnsweredAt    string     `json:"answered_at"`
	ErrorCode     string     `json:"error_code,omitempty"`
	Message       string     `json:"message,omitempty"`
	Results       []OpResult `json:"results"`
}

// OpResult is one answered op. A FAILED line carries NO value - not a
// fabricated 0 - and a successful one carries raw AND decoded side by side,
// because that pair is what makes a scaling mistake visible at a glance.
type OpResult struct {
	ID        string   `json:"id"`
	OK        bool     `json:"ok"`
	Raw       *float64 `json:"raw,omitempty"`
	Registers []int    `json:"registers,omitempty"`
	Value     *float64 `json:"value,omitempty"`
	ErrorCode string   `json:"error_code,omitempty"`
	Message   string   `json:"message,omitempty"`
	// Switched is the outcome of a switch_test / switch_cancel op. It is its OWN
	// block, never Raw/Value: those are reserved for a READING, and a write that
	// dresses up as a measurement is the kind of ambiguity false confirmations
	// grow out of.
	Switched *Switched `json:"switched,omitempty"`
	// Reading is the decoded snapshot of a test_connection op. Every field is a
	// pointer so a channel this device does NOT report is ABSENT - never a
	// fabricated 0 (the gap-not-zero rule the whole codebase runs on).
	//
	// It also rides an `implausible` REFUSAL whose Finding names one violating
	// channel: the box really read the device, the other channels decoded fine,
	// and hiding them turned a refusal into a riddle (live case Muehlfeldweg 2,
	// 21.08.2026). Raw/Value stay absent there - those belong to a register read.
	Reading *Reading `json:"reading,omitempty"`
	// Finding names WHICH channel violated WHICH plausibility rule. Machine
	// readable next to the German sentence, so no surface parses prose.
	Finding *Finding `json:"finding,omitempty"`
	// Samples are the NAMED channels a test_connection read (contract
	// op_result.samples): one row per channel for a device whose readings are
	// not the closed four-channel Reading - an I/O module's di_k/do_k states.
	Samples []Sample `json:"samples,omitempty"`
}

// Sample is one named channel of a test_connection read. Count 0 carries no
// value (never a fabricated 0).
type Sample struct {
	Channel string   `json:"channel"`
	Raw     *float64 `json:"raw,omitempty"`
	Value   *float64 `json:"value,omitempty"`
	Count   int      `json:"count"`
}

// MaxSamples is the contract bound of op_result.samples.
const MaxSamples = 16

// Finding is the plausibility verdict about one channel of a test_connection
// read (contract op_result.finding). Raw is the register word, Value the
// decoded number; both absent when the register was not readable at all.
type Finding struct {
	Channel string   `json:"channel"`
	Rule    string   `json:"rule"`
	Raw     *float64 `json:"raw,omitempty"`
	Value   *float64 `json:"value,omitempty"`

	// Estimate: what the box WOULD estimate this channel to be from a related
	// measurement (today: the state of charge from the battery voltage). Only
	// ever offered for the "missing" rule, and it does NOT change the verdict -
	// the finding still says the channel is missing, so the customer still has
	// to wave it through explicitly. Absent = nothing to offer.
	Estimate *Estimate `json:"estimate,omitempty"`
}

// Estimate is a value the box DERIVED rather than measured, carried next to the
// finding with the input it came from - the raw-next-to-decoded discipline that
// makes a wrong scale or a mis-stated pack end visible.
type Estimate struct {
	SocPct   float64 `json:"soc_pct"`
	VoltageV float64 `json:"voltage_v"`
}

// Switched reports what a write REALLY wrote and what stood in the register
// afterwards. Readback/ReadbackMatches travel together: a readback that was not
// performed is ABSENT, never a "does not match".
type Switched struct {
	Written         int   `json:"written"`
	OffAfterSeconds *int  `json:"off_after_s,omitempty"`
	Readback        *int  `json:"readback,omitempty"`
	ReadbackMatches *bool `json:"readback_matches,omitempty"`
}

// Reading is the decoded snapshot of a test_connection op - the same four
// channels the local test surfaces.
type Reading struct {
	PvKw   *float64 `json:"pv_kw,omitempty"`
	LoadKw *float64 `json:"load_kw,omitempty"`
	GridKw *float64 `json:"grid_kw,omitempty"`
	SocPct *float64 `json:"soc_pct,omitempty"`
}

// Identity is the box's own cloud identity, used for the topic==payload check.
type Identity struct {
	TenantID string
	SiteID   string
	DeviceID string
}

var reqIDChars = func() [256]bool {
	var t [256]bool
	for _, c := range "0123456789abcdef" {
		t[byte(c)] = true
	}
	return t
}()

// Parse turns the raw downlink bytes into a Request and checks the FORM only -
// version, type, the correlation id and the op count. Everything about WHETHER
// it may run is a separate, explicit step (Matches / Expired / ValidateOp), so
// a caller can never accidentally skip one by parsing successfully.
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
	if len(req.Ops) == 0 {
		return req, fmt.Errorf("Anfrage ohne ops")
	}
	if len(req.Ops) > MaxOps {
		return req, fmt.Errorf("Anfrage mit %d ops uebersteigt die Obergrenze %d",
			len(req.Ops), MaxOps)
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

// Matches reports whether the request's payload identity is this box's own.
// A mismatch is discarded, never answered: an answer would confirm to a
// mis-addressed sender that this device exists.
func (r Request) Matches(id Identity) bool {
	if id.DeviceID == "" || id.TenantID == "" || id.SiteID == "" {
		return false
	}
	return strings.EqualFold(r.DeviceID, id.DeviceID) &&
		strings.EqualFold(r.TenantID, id.TenantID) &&
		strings.EqualFold(r.SiteID, id.SiteID)
}

// Expired reports whether the request is past its window, counted from its OWN
// `requested_at`. An UNREADABLE stamp counts as expired - in doubt nothing is
// read (the contract says so, and it is the safe direction: the cost of a
// missed preview is a second click).
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

// ValidateOp decides whether ONE op may be executed. It returns ("", "") when
// it may, and (code, German sentence) when it may not - never a bare boolean,
// because every refusal has to reach the customer as a sentence.
//
// The order matters: what the box does not EXECUTE is answered before what is
// malformed, so a reserved op type reads as "this box cannot do that (yet)"
// instead of as a broken request.
func ValidateOp(op Op) (code string, message string) {
	if op.ID == "" || !validOpID(op.ID) {
		return ErrInvalidRequest, "Der Prüfschritt hat keine gültige Kennung."
	}
	switch op.Op {
	case OpRead:
		// falls through to the read validation below
	case OpTestConnection:
		return validateTestConnection(op)
	case OpSwitchTest, OpSwitchCancel:
		return validateSwitch(op)
	case OpSwitchSet:
		return validateSwitchSet(op)
	default:
		return ErrNotSupported, "Diesen Prüfschritt kennt diese VoltPilot-Box nicht."
	}
	if op.Transport != TransportModbusTCP {
		return ErrNotSupported, "Diese Verbindungsart kann diese VoltPilot-Box noch nicht prüfen."
	}
	host := strings.TrimSpace(op.Host)
	if host == "" {
		return ErrInvalidRequest, "Es fehlt die Adresse des Geräts."
	}
	if !IsPrivateHost(host) {
		// Wörtlich der Grund UND der Weg, nicht nur die Ablehnung: der Kunde
		// soll die Adresse korrigieren, nicht raten, warum das Portal schweigt.
		return ErrInvalidRequest,
			"Die Adresse liegt nicht im eigenen Netz. Bitte die IP-Adresse des Geräts " +
				"eintragen (oder einen Namen wie „geraet.local“) - VoltPilot liest nur " +
				"Geräte im Heim- oder Firmennetz."
	}
	if op.Port != nil && (*op.Port < 1 || *op.Port > 65535) {
		return ErrInvalidRequest, "Der Port liegt außerhalb des gültigen Bereichs."
	}
	if op.UnitID != nil && (*op.UnitID < 0 || *op.UnitID > 255) {
		return ErrInvalidRequest, "Die Unit-ID liegt außerhalb des gültigen Bereichs."
	}
	if op.RegisterKind != "holding" && op.RegisterKind != "input" {
		return ErrInvalidRequest, "Die Registerart muss „holding“ oder „input“ sein."
	}
	if op.Address == nil || *op.Address < 0 || *op.Address > 65535 {
		return ErrInvalidRequest, "Die Registeradresse fehlt oder liegt außerhalb des gültigen Bereichs."
	}
	// Der Datentyp bestimmt, WIE VIELE Woerter gelesen werden - ohne ihn muesste
	// die Box raten, und ein falsch geratener 32-Bit-Wert sieht plausibel aus.
	switch op.DataType {
	case "u16", "s16", "u32", "s32", "float32":
	default:
		return ErrInvalidRequest, "Der Datentyp des Registers fehlt oder ist unbekannt."
	}
	if op.WordOrder != "" && op.WordOrder != "big" && op.WordOrder != "little" {
		return ErrInvalidRequest, "Die Wortreihenfolge muss „big“ oder „little“ sein."
	}
	return "", ""
}

// Verdict is one op's admission decision: an empty Code means "may run".
type Verdict struct {
	Code    string
	Message string
}

// OK reports whether this op may be executed.
func (v Verdict) OK() bool { return v.Code == "" }

// ValidateOps admits a whole request: every op through ValidateOp, PLUS the one
// rule that only exists ACROSS ops - the ids must be unique.
//
// Uniqueness is not cosmetic here: the id is the ONLY thing that maps an answer
// back onto the question the customer asked. Two ops called "soc" would make
// one of the two readings silently describe the other's register, and the
// preview's whole job is to be trustworthy about exactly that. The FIRST
// occurrence keeps the name; every later one is refused by name.
//
// Returns one verdict per op, in the request's order.
func ValidateOps(ops []Op) []Verdict {
	verdicts := make([]Verdict, len(ops))
	seen := make(map[string]bool, len(ops))
	for i, op := range ops {
		code, msg := ValidateOp(op)
		if code == "" && seen[op.ID] {
			code, msg = ErrInvalidRequest,
				"Die Kennung dieses Prüfschritts kommt in der Anfrage mehrfach vor."
		}
		if code == "" {
			seen[op.ID] = true
		}
		verdicts[i] = Verdict{Code: code, Message: msg}
	}
	return verdicts
}

func validOpID(id string) bool {
	if len(id) == 0 || len(id) > 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			(i > 0 && (c == '_' || c == '-'))
		if !ok {
			return false
		}
	}
	return true
}

// validateTestConnection admits a connection test. It carries the SAME private
// target rule as a register read - the whole reason that rule exists (a bug in
// the portal must never turn the fleet into an outbound port scanner) does not
// care which op type asks.
//
// The host is taken from the connection block's `ip` field, which every
// transport in the catalog uses for its address. A connection WITHOUT one names
// no device, and a box that cannot see the address it is about to dial cannot
// prove the target is private - so both are refused rather than dialled.
func validateTestConnection(op Op) (string, string) {
	if strings.TrimSpace(op.Brand) == "" {
		return ErrInvalidRequest, "Es fehlt die Marke des Geräts."
	}
	if len(op.Connection) == 0 {
		return ErrInvalidRequest, "Es fehlen die Verbindungsdaten des Geräts."
	}
	host, ok := ConnectionHost(op.Connection)
	if !ok {
		return ErrInvalidRequest, "Es fehlt die Adresse des Geräts."
	}
	if !IsPrivateHost(host) {
		return ErrInvalidRequest,
			"Die Adresse liegt nicht im eigenen Netz. Bitte die IP-Adresse des Geräts " +
				"eintragen (oder einen Namen wie „geraet.local“) - VoltPilot liest nur " +
				"Geräte im Heim- oder Firmennetz."
	}
	return "", ""
}

// validateSwitch admits the two WRITING ops. It re-applies every rule a read
// carries - the reason the private-target rule exists does not care which op
// asks, and a write is the one that matters most - and adds the rules that only
// a write has:
//
//   - the two VALUES must be stated. The box never chooses a value; it writes
//     exactly the numbers in this request, which is what makes "kein Wert
//     ausserhalb des Freigegebenen" a property of the transport and not a
//     promise of the cloud.
//   - a COIL takes 0 or 1 and nothing else. A 300 written to a relay coil is a
//     malformed request, not a device problem.
//   - the FUNCTION CODE must fit the register kind. FC5 on a holding register
//     (or FC6/FC16 on a coil) would address a different register file - the
//     kind of mistake that writes to something nobody looked at.
//   - a switch_test must carry a bounded ttl_s: the auto-off is the safety net,
//     and a test without one would be a switch-on with no way back.
func validateSwitch(op Op) (string, string) {
	if op.Transport != TransportModbusTCP && op.Transport != TransportEbyte {
		return ErrNotSupported, "Diese Verbindungsart kann diese VoltPilot-Box nicht schalten."
	}
	// An I/O-module output is a relay coil and nothing else: FC5, values 0/1.
	if op.Transport == TransportEbyte && (op.RegisterKind != RegisterKindCoil ||
		(op.WriteFC != nil && *op.WriteFC != WriteFCCoil) || op.ReadbackAddress != nil) {
		return ErrInvalidRequest, "Ein Ausgang des I/O-Moduls ist eine Relais-Spule (Funktionscode 5)."
	}
	host := strings.TrimSpace(op.Host)
	if host == "" {
		return ErrInvalidRequest, "Es fehlt die Adresse des Geräts."
	}
	if !IsPrivateHost(host) {
		return ErrInvalidRequest,
			"Die Adresse liegt nicht im eigenen Netz. Bitte die IP-Adresse des Geräts " +
				"eintragen (oder einen Namen wie „geraet.local“) - VoltPilot schaltet nur " +
				"Geräte im Heim- oder Firmennetz."
	}
	if op.Port != nil && (*op.Port < 1 || *op.Port > 65535) {
		return ErrInvalidRequest, "Der Port liegt außerhalb des gültigen Bereichs."
	}
	if op.UnitID != nil && (*op.UnitID < 0 || *op.UnitID > 255) {
		return ErrInvalidRequest, "Die Unit-ID liegt außerhalb des gültigen Bereichs."
	}
	if op.RegisterKind != RegisterKindHolding && op.RegisterKind != RegisterKindCoil {
		return ErrInvalidRequest, "Die Registerart muss „holding“ oder „coil“ sein."
	}
	if op.Address == nil || *op.Address < 0 || *op.Address > 65535 {
		return ErrInvalidRequest, "Die Registeradresse fehlt oder liegt außerhalb des gültigen Bereichs."
	}
	if op.WriteFC != nil {
		switch *op.WriteFC {
		case WriteFCCoil:
			if op.RegisterKind != RegisterKindCoil {
				return ErrInvalidRequest, "Funktionscode 5 schreibt eine Spule, nicht ein Register."
			}
		case WriteFCSingle, WriteFCMultiple:
			if op.RegisterKind != RegisterKindHolding {
				return ErrInvalidRequest, "Die Funktionscodes 6 und 16 schreiben ein Register, keine Spule."
			}
		default:
			return ErrInvalidRequest, "Der Schreib-Funktionscode muss 5, 6 oder 16 sein."
		}
	}
	if op.OffValue == nil {
		return ErrInvalidRequest, "Es fehlt der Aus- bzw. Sicherheitswert."
	}
	values := []*int{op.OffValue}
	if op.Op == OpSwitchTest {
		if op.OnValue == nil {
			return ErrInvalidRequest, "Es fehlt der Wert, der im Test geschrieben werden soll."
		}
		values = append(values, op.OnValue)
		if op.TTLSeconds == nil {
			return ErrInvalidRequest, "Es fehlt die Testdauer - ohne sie gäbe es kein automatisches Aus."
		}
		if *op.TTLSeconds < 1 || *op.TTLSeconds > MaxSwitchTTL {
			return ErrInvalidRequest, "Die Testdauer muss zwischen 1 und 120 Sekunden liegen."
		}
	} else if op.OnValue != nil || op.TTLSeconds != nil {
		return ErrInvalidRequest, "Ein Abbruch schreibt nur den Aus-Wert - er kennt weder Ein-Wert noch Testdauer."
	}
	for _, v := range values {
		if *v < 0 || *v > 65535 {
			return ErrInvalidRequest, "Ein Schaltwert liegt außerhalb des gültigen Bereichs."
		}
		if op.RegisterKind == RegisterKindCoil && *v != 0 && *v != 1 {
			return ErrInvalidRequest, "Eine Spule kennt nur 0 und 1."
		}
	}
	if op.ReadbackAddress != nil && (*op.ReadbackAddress < 0 || *op.ReadbackAddress > 65535) {
		return ErrInvalidRequest, "Die Rücklese-Adresse liegt außerhalb des gültigen Bereichs."
	}
	return "", ""
}

// validateSwitchSet admits the persistent ON/OFF of an I/O-module output:
// the Ebyte transport only, a relay coil only (FC5, 0/1), and none of the
// switch-test fields - a set that carried a ttl_s would promise an auto-off
// it does not have.
func validateSwitchSet(op Op) (string, string) {
	if op.Transport != TransportEbyte {
		return ErrInvalidRequest, "Dauerhaft schalten lassen sich nur die Ausgänge eines I/O-Moduls."
	}
	if op.RegisterKind != RegisterKindCoil || (op.WriteFC != nil && *op.WriteFC != WriteFCCoil) {
		return ErrInvalidRequest, "Ein Ausgang des I/O-Moduls ist eine Relais-Spule (Funktionscode 5)."
	}
	if op.OnValue != nil || op.OffValue != nil || op.TTLSeconds != nil || op.ReadbackAddress != nil {
		return ErrInvalidRequest, "Dauerhaftes Schalten kennt nur den Zielwert - keine Testwerte und keine Testdauer."
	}
	host := strings.TrimSpace(op.Host)
	if host == "" {
		return ErrInvalidRequest, "Es fehlt die Adresse des Geräts."
	}
	if !IsPrivateHost(host) {
		return ErrInvalidRequest,
			"Die Adresse liegt nicht im eigenen Netz. VoltPilot schaltet nur Geräte im Heim- oder Firmennetz."
	}
	if op.Port != nil && (*op.Port < 1 || *op.Port > 65535) {
		return ErrInvalidRequest, "Der Port liegt außerhalb des gültigen Bereichs."
	}
	if op.UnitID != nil && (*op.UnitID < 0 || *op.UnitID > 255) {
		return ErrInvalidRequest, "Die Unit-ID liegt außerhalb des gültigen Bereichs."
	}
	if op.Address == nil || *op.Address < 0 || *op.Address > 255 {
		return ErrInvalidRequest, "Den Ausgang gibt es nicht."
	}
	if op.SetValue == nil || (*op.SetValue != 0 && *op.SetValue != 1) {
		return ErrInvalidRequest, "Ein Ausgang kennt nur ein (1) und aus (0)."
	}
	return "", ""
}

// ConnectionHost extracts the address from an opaque connection block. ok=false
// when the block names none - never an empty string that a caller could treat
// as "no restriction".
func ConnectionHost(raw json.RawMessage) (string, bool) {
	var conn struct {
		IP string `json:"ip"`
	}
	if err := json.Unmarshal(raw, &conn); err != nil {
		return "", false
	}
	h := strings.TrimSpace(conn.IP)
	return h, h != ""
}

// SucceededSwitch builds an answered switch line. The caller passes what it
// ACTUALLY wrote, so the answer can never claim a value the device never saw.
func SucceededSwitch(id string, written int, offAfter *int, readback *int) OpResult {
	sw := &Switched{Written: written, OffAfterSeconds: offAfter}
	if readback != nil {
		v := *readback
		sw.Readback = &v
		m := v == written
		sw.ReadbackMatches = &m
	}
	return OpResult{ID: id, OK: true, Switched: sw}
}

// SucceededReading builds an answered test_connection line.
func SucceededReading(id string, reading *Reading) OpResult {
	return OpResult{ID: id, OK: true, Reading: reading}
}

// SucceededSamples builds an answered test_connection line whose readings are
// named channels (an I/O module's states) instead of the four-channel Reading.
func SucceededSamples(id string, samples []Sample) OpResult {
	if len(samples) > MaxSamples {
		samples = samples[:MaxSamples]
	}
	return OpResult{ID: id, OK: true, Samples: samples}
}

// FailedReading builds a REFUSED test_connection line that still shows what the
// box read. It exists for exactly one situation: the device answered, every
// other channel decoded, and a single channel violated its plausibility rule -
// then the refusal names the rule AND the evidence. Everything else keeps using
// Failed, which carries no numbers at all.
func FailedReading(id, code, message string, reading *Reading, finding *Finding) OpResult {
	return OpResult{ID: id, OK: false, ErrorCode: code, Message: message,
		Reading: reading, Finding: finding}
}

// EffectivePort returns the op's port with the contract default applied.
func (o Op) EffectivePort() int {
	if o.Port == nil {
		return 502
	}
	return *o.Port
}

// EffectiveUnit returns the op's unit id with the contract default applied.
func (o Op) EffectiveUnit() int {
	if o.UnitID == nil {
		return 1
	}
	return *o.UnitID
}

// EffectiveAddress returns the op's 0-based register address (0 when absent - ValidateOp
// has already refused that case for an executed op).
func (o Op) EffectiveAddress() int {
	if o.Address == nil {
		return 0
	}
	return *o.Address
}

// EffectiveWordOrder returns the op's word order with the contract default applied.
func (o Op) EffectiveWordOrder() string {
	if o.WordOrder == "" {
		return "big"
	}
	return o.WordOrder
}

// Scaled applies the DISPLAY scaling `raw * scale + offset`. Absent scale means
// 1 and absent offset means 0, so an op that states neither shows raw == value -
// which is the honest reading of "no scaling was requested".
func (o Op) Scaled(raw float64) float64 {
	s := 1.0
	if o.Scale != nil {
		s = *o.Scale
	}
	off := 0.0
	if o.Offset != nil {
		off = *o.Offset
	}
	return raw*s + off
}

// Failed builds a refused op line. It NEVER carries a value.
func Failed(id, code, message string) OpResult {
	return OpResult{ID: id, OK: false, ErrorCode: code, Message: message}
}

// Succeeded builds an answered op line carrying raw AND decoded value.
func Succeeded(id string, raw float64, registers []int, value float64) OpResult {
	r, v := raw, value
	return OpResult{ID: id, OK: true, Raw: &r, Registers: registers, Value: &v}
}

// NewResult builds the answer envelope for a request.
func NewResult(req Request, id Identity, now time.Time, results []OpResult) Result {
	if results == nil {
		results = []OpResult{}
	}
	return Result{
		SchemaVersion: SchemaVersion,
		Type:          TypeResult,
		TenantID:      id.TenantID,
		SiteID:        id.SiteID,
		DeviceID:      id.DeviceID,
		RequestID:     req.RequestID,
		AnsweredAt:    now.UTC().Format(time.RFC3339),
		Results:       results,
	}
}

// Refused builds the WHOLE-request refusal (today only the rate limit): no op
// was executed, and the reason is stated once instead of repeated per line.
func Refused(req Request, id Identity, now time.Time, code, message string) Result {
	res := NewResult(req, id, now, nil)
	res.ErrorCode = code
	res.Message = message
	return res
}

// IsPrivateHost reports whether a host string names a target inside the
// customer's own network. It accepts:
//
//   - IPv4 in RFC1918 (10/8, 172.16/12, 192.168/16), loopback, link-local
//     (169.254/16) and the CGNAT range 100.64/10 (real customer routers hand it
//     out, and it is never publicly routable);
//   - IPv6 loopback (::1), unique-local (fc00::/7) and link-local (fe80::/10),
//     including an IPv4-mapped address whose v4 half is private;
//   - a name with a LAN suffix (.local/.lan/.home/.home.arpa/.internal/.intern) -
//     the mDNS/router-assigned names a LAN device actually answers to.
//
// Everything else is refused - including a BARE hostname without a suffix, and
// that exclusion is deliberate even though it costs a little convenience: a
// bare name is resolved by whatever search domains the box happens to have, so
// it CANNOT be shown to be private from the string alone, and this function
// would then be promising something it does not check. The rule is a WHITELIST
// of forms we can actually prove: a blacklist of "bad" targets is one new
// address range away from being wrong, and the cost of being strict here is a
// customer typing an IP instead of a nickname.
func IsPrivateHost(host string) bool {
	h := strings.TrimSpace(host)
	if h == "" {
		return false
	}
	// A bracketed IPv6 literal, as it may arrive from a URL-shaped field.
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	// A trailing dot is a fully-qualified DNS name; strip it before matching.
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return false
	}
	if ip := net.ParseIP(h); ip != nil {
		return isPrivateIP(ip)
	}
	lower := strings.ToLower(h)
	if strings.ContainsAny(lower, " /\\@:") {
		return false // not a hostname we are willing to interpret
	}
	for _, suffix := range []string{".local", ".lan", ".home", ".home.arpa", ".internal", ".intern"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate() {
		// net.IP.IsPrivate covers RFC1918 for v4 and fc00::/7 for v6.
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		// CGNAT 100.64.0.0/10 - not publicly routable, and handed out by real
		// customer-premises equipment.
		return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
	}
	return false
}
