// Package installerwrite is the deliberately NARROW remote write path for ONE
// Deye installer register: 0x00E7 „Grid Max Export power" (dec. 231, holding
// register, scale x10 -> W).
//
// WHY IT EXISTS: at Anlage Herzogau the Deye held an installer cap of 33,0 kW in
// 0x00E7 while 70 kW were configured in the portal („Grenzen & Wächter" Stufe 0,
// Vierer #4 - the register we already READ once a day). Raising it back used to
// mean an on-site appointment at the inverter's own installer menu. This package
// is the one remote lever for exactly that one number.
//
// ⚠ TRIGGER AND POLICY ARE SEPARATE LAYERS, AND THAT SEPARATION IS THE POINT:
//
//	POLICY (here)      Admit() - the NARROW scope of the :8484 maintenance
//	                   button: it hard-codes the address, the scale, the value
//	                   ceiling and the two-stage confirm rule. Its sibling
//	                   AdmitExpert() (expert.go) is the PORTAL channel's scope -
//	                   a free holding register or coil. They share the confirm
//	                   token, the expected_before bound and the one AdmittedWrite
//	                   type; there is still no third way to build one.
//	MECHANISM (agent)  Agent.WriteOnce(Target, AdmittedWrite) - trigger-agnostic:
//	                   read, optionally write ONCE, read back, report
//	                   {before, after, adopted}. It knows no allowlist and no
//	                   HTTP.
//	TRIGGER (adapter)  today the :8484 maintenance endpoint. A later portal
//	                   downlink is a SECOND ADAPTER over the same two layers -
//	                   not a refactoring.
//
// ⚠ `AdmittedWrite`'s fields stay UNEXPORTED, so no adapter anywhere can point
// the mechanism at a register of its choosing - it can only pass on what an
// Admit function produced. Widening what may be admitted is a code change HERE,
// with its own review, never a parameter: expert.go is exactly such a change,
// announced by the previous one.
//
// The gates, all here and all fail-closed:
//
//  1. FEATURE FLAG (VP_INSTALLER_WRITE_ENABLED, default OFF). Checked by the
//     adapter BEFORE anything here runs; without it the HTTP surface answers 404
//     and this package is dead code. A box that never sets it behaves
//     byte-identically to before the feature.
//  2. REGISTER ALLOWLIST - the family must resolve, through the EXISTING
//     inverter.ExportLimitRegisterFor table, to address 0x00E7. See
//     `AllowedFamily` for why that table (and not a new one) is the right gate.
//  3. VALUE CEILING - 0 < raw <= MaxRaw (70,0 kW). A 0 would forbid feed-in
//     entirely and is refused as an obvious mis-entry, not silently written.
//  4. TWO STAGES - the default is a DRY RUN (read the register, report what
//     would be written). A real write needs the exact confirm token.
//  5. OPTIONAL PRECONDITION - `expected_before` lets a caller say „only write if
//     the register still reads X". Compared ON THE DEVICE inside the one socket
//     session, so there is no read-then-write window someone else can slip into.
//  6. ONE ATTEMPT - the mechanism performs exactly one write per admitted
//     request. There is no retry loop and no periodic refresh: 0x00E7 lives in
//     EEPROM, and every write costs a write cycle.
package installerwrite

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// RegisterAddr is the ONE allowlisted holding-register address: Deye
// „Grid Max Export power" (0x00E7 = 231 decimal).
const RegisterAddr = 0x00e7

// RegisterLabel is the operator-facing form of RegisterAddr. It is byte-equal to
// inverter.ExportLimitRegister.Label for the same register, so the audit log and
// the read path name the register identically.
const RegisterLabel = "0x00e7"

// ScaleW converts the raw register word to WATTS (raw * ScaleW = W). Fixed 10 on
// both the LV and the HV line - the same fact inverter.exportLimitRegisters
// carries for the read side.
const ScaleW = 10

// MaxRaw is the hard value ceiling: 7000 * 10 W = 70,0 kW. It is a POLICY bound,
// not a device bound - the point of this path is raising a plant to its
// registered connection limit, and a fat-fingered 70000 must never reach an
// inverter. Raising it is a code change.
const MaxRaw = 7000

// MaxKw is MaxRaw expressed at the grid connection point, for the copy.
const MaxKw = float64(MaxRaw) * ScaleW / 1000

// maxRegisterWord bounds a plausible `expected_before`: a holding register is
// one 16-bit word, nothing more.
const maxRegisterWord = 0xffff

// KindHolding / KindCoil are the two Modbus object classes a write can address.
// The narrow export-limit scope only ever produces KindHolding; the EXPERT scope
// (expert.go) admits both.
const (
	KindHolding = "holding"
	KindCoil    = "coil"
)

// ModeDry / ModeApply are the two stages. Absent/unknown = ModeDry: the safe
// stage is what you get when you say nothing.
const (
	ModeDry   = "dry_run"
	ModeApply = "apply"
)

// Result codes an outcome carries. They are stable machine words; the German
// sentence travels beside them.
const (
	ResultDryRun       = "dry_run"
	ResultApplied      = "applied"
	ResultMismatch     = "mismatch"
	ResultFailed       = "failed"
	ResultPrecondition = "precondition"
)

// Error codes the MECHANISM reports. They describe the exchange, never policy.
const (
	ErrCodeUnreachable      = "unreachable"
	ErrCodeWriteUnconfirmed = "write_unconfirmed"
	ErrCodeBusy             = "busy"
	ErrCodePrecondition     = "precondition"
	ErrCodeTimeout          = "timeout"
)

// ValidationError is a refusal the operator caused (400), carrying the German
// sentence to render. Everything else is a real failure.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func refuse(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// ErrBusy is returned when a write is already in flight. One attempt at a time,
// per the one-shot rule - two overlapping writes to one EEPROM register is the
// one thing this path must never do.
var ErrBusy = errors.New("installer write already in flight")

// Target is WHERE a one-shot write goes: the device the box currently reads.
// It is a TYPE rather than an implicit assumption so a second trigger addresses
// the same mechanism without changing it.
type Target struct {
	// Family is the register-map family (the narrow allowlist keys on it).
	Family string `json:"family"`
	// Communication is the transport the box reads this device over; the
	// mechanism rides that transport's socket.
	Communication string `json:"communication"`
	// Host/Port/UnitID address a device on the PLAIN Modbus-TCP lane (a
	// component of the plant, or a free LAN address). They are EMPTY for the
	// primary Solarman lane, where the box resolves the endpoint itself and the
	// cloud deliberately names neither host nor unit.
	Host   string `json:"host,omitempty"`
	Port   int    `json:"port,omitempty"`
	UnitID int    `json:"unit_id,omitempty"`
	// Label is the box's own ECHO of where it wrote, in plain words. On a plant
	// with several devices the target is a deliberate choice, never a default in
	// the dark.
	Label string `json:"label,omitempty"`
}

// Request is the operator's (or a future trigger's) input. `Value` is the RAW
// register word (not kW): the caller is looking at the register, so the number
// they hand over is the number that lands - no unit conversion sits between
// intention and EEPROM.
type Request struct {
	// Register is optional and, when present, must name RegisterLabel. It exists
	// so the curl line is self-documenting AND so a copy-paste from another
	// register's instructions is refused instead of silently redirected.
	Register string `json:"register"`
	// Value is the raw holding-register word. 0 < Value <= MaxRaw.
	Value int `json:"value"`
	// Mode is ModeDry (default) or ModeApply.
	Mode string `json:"mode"`
	// Confirm must equal ConfirmToken(Value) for ModeApply. Case-insensitive on
	// the hex digits only; everything else is compared verbatim.
	Confirm string `json:"confirm"`
	// ExpectedBefore is the OPTIONAL precondition: write only while the register
	// still reads this raw word. nil = no expectation. Its purpose is a trigger
	// that decided minutes ago (a portal downlink, a re-sent curl) not
	// overwriting a value someone changed in between.
	ExpectedBefore *int `json:"expected_before"`
}

// AdmittedWrite is ONE write that has passed policy. Its fields are UNEXPORTED
// on purpose: only Admit constructs one, so the mechanism can never be pointed
// at a register or a value nobody admitted.
type AdmittedWrite struct {
	register string
	// kind is KindHolding or KindCoil. The narrow export-limit scope only ever
	// produces a holding register; the EXPERT scope (expert.go) admits both.
	kind  string
	addr  int
	value int
	// kw is the scaled reading of `value` where a scale is KNOWN (the export
	// limit). It is a POINTER because a free register has no scale at all, and a
	// fabricated „0,0 kW" next to a raw word would be an invented unit.
	kw *float64
	// writeFC pins the Modbus write function code; 0 = the executor decides
	// (coil -> 5, holding -> 16, the measured FC16-by-default Deye lesson).
	writeFC        int
	apply          bool
	expectedBefore *int
}

// Register/Kind/Addr/Value/Kw/Apply/ExpectedBefore expose the admitted facts to
// the mechanism and the surfaces - read-only by construction.
func (w AdmittedWrite) Register() string { return w.register }
func (w AdmittedWrite) Kind() string     { return w.kind }
func (w AdmittedWrite) Addr() int        { return w.addr }
func (w AdmittedWrite) Value() int       { return w.value }

// Kw is the scaled value where a scale is known, and 0 otherwise - ALWAYS ask
// KwKnown before rendering it. „0,0 kW" is a value, „no scale" is an absence.
func (w AdmittedWrite) Kw() float64 { return valueOrZero(w.kw) }

// KwKnown reports whether this register has a known scale at all.
func (w AdmittedWrite) KwKnown() bool { return w.kw != nil }

// WriteFC is the pinned Modbus write function code (0 = the executor decides).
func (w AdmittedWrite) WriteFC() int { return w.writeFC }

// Apply is false for a dry run: the mechanism then READS the register and
// writes nothing at all.
func (w AdmittedWrite) Apply() bool { return w.apply }

// ExpectedBefore is the optional precondition (nil = none).
func (w AdmittedWrite) ExpectedBefore() *int { return w.expectedBefore }

// MarshalJSON renders the admitted write for the API surface. The struct has no
// exported fields, so this is the ONE place its shape is defined.
func (w AdmittedWrite) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Register       string   `json:"register"`
		Kind           string   `json:"kind"`
		Addr           int      `json:"addr"`
		Value          int      `json:"value"`
		Kw             *float64 `json:"kw,omitempty"`
		WriteFC        int      `json:"write_fc,omitempty"`
		Apply          bool     `json:"apply"`
		ExpectedBefore *int     `json:"expected_before,omitempty"`
	}{w.register, w.kind, w.addr, w.value, w.kw, w.writeFC, w.apply, w.expectedBefore})
}

// ConfirmToken is the exact string a real write must carry. It names BOTH the
// register and the value, so a confirm copied from an earlier, different attempt
// does not authorise this one.
//
// ⚠ It is the SHARED protocol of both scopes and of both triggers: the cloud
// builds the very same string (RegisterKnowledge.confirmToken) and the box
// compares it. For the export limit it renders byte-identically to what it
// always did („0X00E7=7000").
func ConfirmToken(addr, value int) string {
	return fmt.Sprintf("%s=%d", strings.ToUpper(HexLabel(addr)), value)
}

// HexLabel is the canonical display spelling of an address („0x00e7"). One
// spelling everywhere: audit log, confirm token and the cloud journal.
func HexLabel(addr int) string {
	return fmt.Sprintf("0x%04x", addr)
}

func valueOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// KwFor converts a raw word to kW at the grid connection point.
func KwFor(value int) float64 {
	return float64(value) * ScaleW / 1000
}

// AllowedFamily reports whether this register-map family may be written here.
//
// ⚠ IT REUSES THE READ-SIDE TABLE ON PURPOSE (inverter.ExportLimitRegisterFor).
// That table already encodes the ONE distinction that matters here: on
// hybrid_3p 0x00E7 is a DEDICATED feed-in cap, while on hybrid_1p the feed-in
// cap register IS „Max Sell Power" (0x00F5) - the register OUR OWN discharge
// lever writes (inverter-control-routing.js DEYE_CONTROL_REG). Reading it back
// would report our command as the device's limit; WRITING it would fight the
// control loop outright. A family we may not read honestly is a family we must
// not write at all, so one table governs both - and a family added there later
// still has to resolve to 0x00E7 to land here.
func AllowedFamily(family string) bool {
	reg, ok := inverter.ExportLimitRegisterFor(family)
	return ok && reg.Addr == RegisterAddr
}

// Admit is the POLICY layer: it turns a request into an AdmittedWrite, or
// refuses with a German sentence. It is the ONLY constructor.
func Admit(family string, req Request) (AdmittedWrite, error) {
	if !AllowedFamily(family) {
		if family == "" {
			return AdmittedWrite{}, refuse("Es ist kein Wechselrichter eingerichtet. Das Register %s kann deshalb nicht geschrieben werden.", RegisterLabel)
		}
		return AdmittedWrite{}, refuse(
			"Für diesen Wechselrichter (%s) ist das Register %s nicht freigegeben. Der Fernschreibpfad gilt ausschließlich für die dreiphasigen Deye-Hybride, bei denen %s die eigenständige Einspeisegrenze ist.",
			family, RegisterLabel, RegisterLabel)
	}
	if r := strings.TrimSpace(req.Register); r != "" && !sameRegister(r) {
		return AdmittedWrite{}, refuse("Es ist ausschließlich das Register %s freigegeben (angefragt: %s).", RegisterLabel, r)
	}
	if req.Value <= 0 {
		return AdmittedWrite{}, refuse("Der Wert muss größer als 0 sein. 0 hieße „gar keine Einspeisung erlaubt“ - das wird hier nicht geschrieben.")
	}
	if req.Value > MaxRaw {
		return AdmittedWrite{}, refuse("Der Wert %d überschreitet die Obergrenze %d (%.1f kW).", req.Value, MaxRaw, MaxKw)
	}
	if req.ExpectedBefore != nil && (*req.ExpectedBefore < 0 || *req.ExpectedBefore > maxRegisterWord) {
		return AdmittedWrite{}, refuse("Der erwartete Ist-Wert %d ist kein Registerwert (0 bis %d).", *req.ExpectedBefore, maxRegisterWord)
	}
	apply := strings.TrimSpace(req.Mode) == ModeApply
	if apply {
		want := ConfirmToken(RegisterAddr, req.Value)
		if !strings.EqualFold(strings.TrimSpace(req.Confirm), want) {
			return AdmittedWrite{}, refuse("Zum Schreiben wird die ausdrückliche Bestätigung \"confirm\": \"%s\" benötigt.", want)
		}
	}
	kw := KwFor(req.Value)
	w := AdmittedWrite{
		register: RegisterLabel,
		kind:     KindHolding,
		addr:     RegisterAddr,
		value:    req.Value,
		kw:       &kw,
		apply:    apply,
	}
	if req.ExpectedBefore != nil {
		v := *req.ExpectedBefore
		w.expectedBefore = &v
	}
	return w, nil
}

// equalFold compares two confirm tokens the way both scopes do: trimmed, and
// case-insensitive (the hex digits are the only part where case is a matter of
// taste).
func equalFold(got, want string) bool {
	return strings.EqualFold(strings.TrimSpace(got), want)
}

// sameRegister accepts the register named in any of the spellings an operator
// plausibly types, and nothing else.
func sameRegister(s string) bool {
	t := strings.ToLower(strings.TrimSpace(s))
	t = strings.TrimPrefix(t, "0x")
	if n, err := strconv.ParseInt(t, 16, 32); err == nil && int(n) == RegisterAddr {
		return true
	}
	// A bare decimal ("231") is the other form the Deye documentation prints.
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n == RegisterAddr {
		return true
	}
	return false
}

// WriteOnceResult is what the MECHANISM produces: the two readings and whether
// the device ADOPTED the value. It says nothing about policy or about who asked.
type WriteOnceResult struct {
	// Before/After are the raw words read around the write. POINTERS because
	// „not read" and „read as 0" are different facts: a 0 here is a value („may
	// not feed in at all"), never an absence.
	Before *int `json:"before,omitempty"`
	After  *int `json:"after,omitempty"`
	// Wrote is true once the write frame LEFT - even if its answer was lost.
	// The honest half of „did something happen".
	Wrote bool `json:"wrote"`
	// Adopted is true ONLY when the register read back as the requested value.
	Adopted bool `json:"adopted"`
	// ErrorCode/Message describe a failed exchange (empty on success).
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// OK reports a clean exchange.
func (r WriteOnceResult) OK() bool { return r.ErrorCode == "" }

// Entry is one AUDIT record. It survives a restart (see Log) and answers the
// only question that matters afterwards: who moved this register, when, from
// what to what, and did it stick.
type Entry struct {
	At time.Time `json:"at"`
	// RequestID is the CROSS KEY to the cloud journal (`register_write_event`):
	// a portal-triggered write carries the id of the order that caused it, so
	// the box's book and the cloud's book describe the same operation under the
	// same key and a manipulated one contradicts the other. A LOCAL write gets
	// one only when the heartbeat uplink reports it (Konzept §2.9 point 7);
	// empty = not (yet) correlated.
	RequestID string `json:"request_id,omitempty"`
	Register  string `json:"register"`
	// Before/After follow the WriteOnceResult pointer discipline.
	Before    *int `json:"before,omitempty"`
	Requested int  `json:"requested"`
	After     *int `json:"after,omitempty"`
	// Kw is the scaled requested value where a scale is KNOWN - absent for a
	// free register, never a fabricated 0,0.
	Kw *float64 `json:"kw,omitempty"`
	// Result is one of the Result* codes; Message carries the German sentence.
	Result  string `json:"result"`
	Message string `json:"message,omitempty"`
	// Source names WHICH TRIGGER asked (today the :8484 maintenance access), so
	// the log stays readable once a second adapter exists.
	Source string `json:"source"`
}

// Outcome is what one ADAPTER call produced: the admitted write, the mechanism's
// two readings, and the operator-facing verdict.
type Outcome struct {
	Plan     AdmittedWrite `json:"plan"`
	Before   *int          `json:"before,omitempty"`
	After    *int          `json:"after,omitempty"`
	BeforeKw *float64      `json:"before_kw,omitempty"`
	AfterKw  *float64      `json:"after_kw,omitempty"`
	Result   string        `json:"result"`
	Message  string        `json:"message"`
	// Accepted mirrors WriteOnceResult.Adopted: the register READ BACK as the
	// requested value. A write whose answer was lost leaves this false with an
	// honest message - never an assumed success.
	Accepted bool `json:"accepted"`
}

// View is the GET payload: the switch state, the one register this path may
// touch, and the audit log (newest first).
type View struct {
	Enabled  bool    `json:"enabled"`
	Register string  `json:"register"`
	MaxRaw   int     `json:"max_raw"`
	MaxKw    float64 `json:"max_kw"`
	ScaleW   int     `json:"scale_w"`
	// Family is the selected inverter's register-map family, and Allowed says
	// whether THIS plant may use the path at all - so the operator sees the
	// refusal before they type a value.
	Family  string  `json:"family"`
	Allowed bool    `json:"allowed"`
	Entries []Entry `json:"entries"`
}
