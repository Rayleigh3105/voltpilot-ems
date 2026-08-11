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

// Op types. Only OpRead is EXECUTED in this stage; OpSwitchTest is part of the
// contract so its form is fixed from the start, and a box of this stage answers
// it honestly with ErrNotSupported instead of discarding a shape it does not
// know (see the schema's op_switch_test title).
const (
	OpRead       = "read"
	OpSwitchTest = "switch_test"
)

// TransportModbusTCP is the only transport V1 executes.
const TransportModbusTCP = "modbus_tcp"

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

	// switch_test only (reserved, never executed in this stage).
	OnValue         *int `json:"on_value,omitempty"`
	OffValue        *int `json:"off_value,omitempty"`
	TTLSeconds      *int `json:"ttl_s,omitempty"`
	ReadbackAddress *int `json:"readback_address,omitempty"`
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
	case OpSwitchTest:
		// VOLLSTAENDIG spezifiziert, hier NICHT ausgefuehrt. Der Satz sagt, dass
		// es an dieser Box liegt und nicht am Geraet - und er verspricht nichts
		// ueber einen Zeitpunkt.
		return ErrNotSupported, "Schalt-Tests führt diese VoltPilot-Box noch nicht aus."
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
		// Wörtlich der Grund, nicht nur die Ablehnung: der Kunde soll die IP
		// korrigieren, nicht raten, warum das Portal schweigt.
		return ErrInvalidRequest,
			"Die Adresse liegt nicht im eigenen Netz. VoltPilot liest nur Geräte im Heim-/Firmennetz."
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
//   - a bare hostname (no dot) or an mDNS/.local/.lan/.home.arpa name - the
//     names a LAN device actually answers to.
//
// Everything else - a public IP, a public FQDN - is refused. This is
// deliberately a WHITELIST: a blacklist of "bad" targets is one new address
// range away from being wrong, and the cost of being too strict here is a
// customer typing an IP instead of a name.
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
	if !strings.Contains(lower, ".") {
		return true // a bare LAN hostname
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
