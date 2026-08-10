// Package shelly is the Shelly relay driver of the Verbrauchssteuerung - the
// SECOND real consumer control path after go-e (§23 order, D10; pilot hardware
// per the captain: a heating rod behind a Shelly). It turns an arbitrated,
// already guard-clamped consumer on/off command into the Shelly local HTTP
// call of the device's GENERATION dialect, executes it, and reads the relay
// state (plus the measured power on metering models) back to prove the command
// landed. Single-writer discipline: the CORE owns the whole Shelly HTTP
// socket - reads (source poll, connection test) AND writes (executor) - so no
// Node-RED flow ever opens a second path to the same device. Unlike the
// Solarman single-socket logger, a Shelly is a small web server and handles
// concurrent requests; no cross-goroutine socket lock is needed (the go-e
// precedent).
//
// TWO GENERATION DIALECTS, detected once and persisted (never configured by
// the operator - the customer cannot know their "Gen"):
//
//   - Gen2+ (Plus/Pro/Gen3/Gen4 lines): the documented RPC protocol over
//     plain HTTP GET - /rpc/Shelly.GetDeviceInfo, /rpc/Switch.Set?id=N&on=..,
//     /rpc/Switch.GetStatus?id=N. Metering models (Plus 1PM / Plug S class)
//     carry `apower` (W) + `aenergy` in the Switch status; non-metering models
//     (Plus 1) do not - the documented model difference the capability
//     detection keys on (Home Assistant's shelly integration keys its power
//     sensors on exactly this presence).
//   - Gen1 (the classic ESP8266 line): the documented REST API -
//     /relay/N?turn=on|off, /status with `relays` + `meters`. Metering is
//     detected from `meters[ch]` existing with `is_valid: true` (the
//     aioshelly/HA discipline). Gen1 energy counters are Watt-MINUTES, not Wh.
//
// Detection: GET /shelly answers UNAUTHENTICATED on every generation (the
// documented common endpoint); a `gen` field >= 2 selects the RPC dialect, a
// `type` field without `gen` the Gen1 dialect. The detected identity (gen +
// metering) is persisted per device (store.go) so a reboot never re-probes a
// known device; a dialect-level invalid_response drops the cached identity so
// the NEXT pass re-detects once (self-healing after a firmware swap, never a
// re-detect loop).
//
// THE DEAD-MAN TIMER IS THE LOAD-BEARING §4.2 ANSWER. A heating rod's failsafe
// is `off` - "ein Heizstab ohne Verbindung heizt NICHT weiter". The edge
// writing off at plan staleness only covers CLOUD staleness; if the EDGE dies
// or WLAN drops while the relay is on, nobody could write the off. So every ON
// write carries the device's own one-shot flip-back timer (Gen2 Switch.Set
// `toggle_after`, Gen1 /relay `timer` - both documented), re-armed by the
// executor's periodic re-assert: stop writing and the relay falls off by
// itself within the timer window. The same discipline as the Fronius
// WMaxLimPct_RvrtTms / Deye remote watchdog: aufhoeren zu schreiben IST der
// Failsafe. Whether a given firmware honors the timer exactly is
// VERIFY-on-device (CONTROL-BENCH.md -> Shelly).
//
// AUTH IS DELIBERATELY UNSUPPORTED in v1: Gen1 uses HTTP Basic, Gen2 digest
// auth - a password-protected Shelly is refused with an honest German message
// instead of a half-working driver (SHELLY.md names the constraint: LAN
// operation without the Shelly password).
//
// Capability consequence (D3 Bestaetigungshierarchie, §9.4): a metering Shelly
// yields Stufe 2 (power telemetry - runtime exact, energy integrated); a
// non-metering one yields Stufe 3 (relay readback - runtime confirmed, energy
// "angenommen" = Nennleistung x Zeit, labeled so). The driver never fabricates
// a power value for a non-metering device.
package shelly

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"time"
)

// Communication is the driver.communication value that selects this executor.
const Communication = "shelly_http"

// Generation dialects.
const (
	Gen1 = 1
	Gen2 = 2 // the RPC dialect; covers Gen2, Gen3, Gen4 (same protocol)
)

// DefaultPort is the Shelly local HTTP port.
const DefaultPort = 80

// DefaultOnTimerS is the dead-man window (seconds) an ON write carries when
// the driver config does not override it: the relay flips back OFF by itself
// unless the executor re-asserts the command in time. Three re-assert
// intervals of slack (the executor re-writes every 60 s), so one missed pass
// never blips a legitimate run, while a dead edge lets the rod go cold within
// three minutes.
const DefaultOnTimerS = 180

// Config is the Shelly connection from the entity driver.connection (or the
// :8484 source form). Only IP is required.
type Config struct {
	IP   string `json:"ip"`
	Port int    `json:"port,omitempty"`
	// Channel is the switch/relay output on multi-channel devices (0 = the
	// first; a Shelly 2PM has 0 and 1).
	Channel int `json:"channel,omitempty"`
	// RatedPowerKw optionally mirrors the consumer's Nennleistung so a
	// setpoint-only command can be judged restrict-only (see PlanFor). The
	// cloud's consumer_profile stays the authority; this is a driver hint.
	RatedPowerKw float64 `json:"rated_power_kw,omitempty"`
	// OnTimerS overrides the dead-man window of ON writes (seconds).
	// 0/absent = DefaultOnTimerS; -1 disables the timer (documented risk: a
	// dead edge then leaves the relay on - only for devices whose firmware
	// mishandles the timer, named in SHELLY.md).
	OnTimerS int `json:"on_timer_s,omitempty"`
}

// HostPort renders the target host (port only when non-default).
func (c Config) HostPort() string {
	if c.Port > 0 && c.Port != DefaultPort {
		return fmt.Sprintf("%s:%d", c.IP, c.Port)
	}
	return c.IP
}

// Key identifies one physical device+channel for the identity store.
func (c Config) Key() string {
	port := c.Port
	if port == 0 {
		port = DefaultPort
	}
	return fmt.Sprintf("%s:%d/%d", c.IP, port, c.Channel)
}

// onTimerS resolves the dead-man window: default, explicit, or disabled (-1).
func (c Config) onTimerS() int {
	switch {
	case c.OnTimerS < 0:
		return 0 // explicitly disabled (documented risk)
	case c.OnTimerS == 0:
		return DefaultOnTimerS
	default:
		return c.OnTimerS
	}
}

// Identity is the once-detected device dialect + capability, persisted by the
// store so a known device is never re-probed on every pass.
type Identity struct {
	Gen         int       `json:"gen"`   // Gen1 | Gen2 (RPC)
	Model       string    `json:"model"` // Gen2 model id / Gen1 type (e.g. SNSW-001P16EU / SHSW-PM)
	App         string    `json:"app,omitempty"`
	HasMetering bool      `json:"has_metering"`
	DetectedAt  time.Time `json:"detected_at"`
}

// Label is the wizard-facing device description ("Shelly Gen 2 (Plus1PM)").
func (id Identity) Label() string {
	l := fmt.Sprintf("Shelly Gen %d", id.Gen)
	switch {
	case id.App != "":
		l += " (" + id.App + ")"
	case id.Model != "":
		l += " (" + id.Model + ")"
	}
	return l
}

// State is one relay+power snapshot. PowerKw is set ONLY on metering models
// (never fabricated); a real 0.0 W (relay off, or on with no load) is kept.
type State struct {
	On      *bool
	PowerKw *float64
}

// Doer performs one HTTP GET, returning the status code + body. The agent
// injects an *http.Client-backed Doer; tests inject an httptest client or a
// fake (the goe.Doer shape - Gen2 RPC accepts GET with query params, so one
// verb serves both dialects).
type Doer interface {
	Get(ctx context.Context, url string) (statusCode int, body []byte, err error)
}

// Error codes shared with testconn / the readback payload.
const (
	ErrInvalidRequest  = "invalid_request"
	ErrUnreachable     = "unreachable"
	ErrInvalidResponse = "invalid_response"
)

// DriverError is a classified transport/protocol failure with the honest
// German sentence for the surfaces.
type DriverError struct {
	Code    string
	Message string
}

func (e *DriverError) Error() string { return e.Code + ": " + e.Message }

func classify(code int, err error) *DriverError {
	if err != nil {
		return &DriverError{Code: ErrUnreachable, Message: "Das Shelly-Gerät hat nicht geantwortet."}
	}
	if code == 401 {
		// Both generations answer 401 when their password protection is on.
		return &DriverError{Code: ErrInvalidResponse,
			Message: "Das Shelly-Gerät ist passwortgeschützt - der Passwortschutz wird nicht unterstützt (siehe SHELLY.md)."}
	}
	if code >= 400 {
		return &DriverError{Code: ErrInvalidResponse,
			Message: fmt.Sprintf("Das Shelly-Gerät hat mit HTTP %d geantwortet.", code)}
	}
	return nil
}

// Detect probes the device once and derives its generation dialect + metering
// capability. It never guesses: an unreadable answer is an error, a password
// gate is named, and metering is only claimed when the device itself shows the
// documented evidence (Gen2 `apower` present / Gen1 `meters[ch].is_valid`).
func Detect(ctx context.Context, doer Doer, cfg Config) (Identity, error) {
	if cfg.IP == "" {
		return Identity{}, &DriverError{Code: ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	base := "http://" + cfg.HostPort()
	code, body, err := doer.Get(ctx, base+"/shelly")
	if de := classify(code, err); de != nil {
		return Identity{}, de
	}
	var probe struct {
		Gen    *int   `json:"gen"`
		Model  string `json:"model"`
		App    string `json:"app"`
		Type   string `json:"type"` // Gen1 device type (SHSW-1, SHSW-PM, SHPLG-S, ...)
		AuthEn *bool  `json:"auth_en"`
		Auth   *bool  `json:"auth"`
	}
	if e := json.Unmarshal(body, &probe); e != nil {
		return Identity{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
	if (probe.AuthEn != nil && *probe.AuthEn) || (probe.Auth != nil && *probe.Auth) {
		return Identity{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Das Shelly-Gerät ist passwortgeschützt - der Passwortschutz wird nicht unterstützt (siehe SHELLY.md)."}
	}
	switch {
	case probe.Gen != nil && *probe.Gen >= 2:
		ident := Identity{Gen: Gen2, Model: probe.Model, App: probe.App, DetectedAt: time.Now().UTC()}
		// Capability probe: metering models carry `apower` in the Switch
		// status (the documented Plus1 vs Plus1PM difference).
		code, body, err = doer.Get(ctx, base+"/rpc/Switch.GetStatus?id="+strconv.Itoa(cfg.Channel))
		if de := classify(code, err); de != nil {
			return Identity{}, de
		}
		var st map[string]json.RawMessage
		if e := json.Unmarshal(body, &st); e != nil {
			return Identity{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Der Schaltkanal hat nicht verständlich geantwortet (falscher Kanal?)."}
		}
		if _, isErr := st["code"]; isErr && st["output"] == nil {
			// RPC error object (e.g. unknown component id).
			return Identity{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Diesen Schaltkanal kennt das Gerät nicht (Kanal prüfen)."}
		}
		_, ident.HasMetering = st["apower"]
		return ident, nil
	case probe.Type != "":
		ident := Identity{Gen: Gen1, Model: probe.Type, DetectedAt: time.Now().UTC()}
		st, de := gen1Status(ctx, doer, cfg)
		if de != nil {
			return Identity{}, de
		}
		if cfg.Channel >= len(st.Relays) {
			return Identity{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Diesen Schaltkanal kennt das Gerät nicht (Kanal prüfen)."}
		}
		// Gen1 metering rule (VERIFY-on-device, the aioshelly/HA discipline):
		// a meter entry exists for the channel AND declares itself valid.
		ident.HasMetering = cfg.Channel < len(st.Meters) && st.Meters[cfg.Channel].IsValid
		return ident, nil
	default:
		return Identity{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
}

// gen1StatusDoc is the Gen1 /status slice this driver reads.
type gen1StatusDoc struct {
	Relays []struct {
		IsOn *bool `json:"ison"`
	} `json:"relays"`
	Meters []struct {
		Power   *float64 `json:"power"` // W
		IsValid bool     `json:"is_valid"`
	} `json:"meters"`
}

func gen1Status(ctx context.Context, doer Doer, cfg Config) (gen1StatusDoc, *DriverError) {
	code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+"/status")
	if de := classify(code, err); de != nil {
		return gen1StatusDoc{}, de
	}
	var st gen1StatusDoc
	if e := json.Unmarshal(body, &st); e != nil {
		return gen1StatusDoc{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Statusantwort des Geräts war nicht lesbar."}
	}
	return st, nil
}

// ReadState reads the relay (+ measured power on metering models) through the
// detected dialect. An absent/unreadable value stays absent - never a
// fabricated 0.
func ReadState(ctx context.Context, doer Doer, cfg Config, ident Identity) (State, *DriverError) {
	switch ident.Gen {
	case Gen2:
		code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+
			"/rpc/Switch.GetStatus?id="+strconv.Itoa(cfg.Channel))
		if de := classify(code, err); de != nil {
			return State{}, de
		}
		var st struct {
			Output *bool    `json:"output"`
			Apower *float64 `json:"apower"` // W
		}
		if e := json.Unmarshal(body, &st); e != nil || st.Output == nil {
			return State{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Der Schaltkanal hat nicht verständlich geantwortet."}
		}
		out := State{On: st.Output}
		if ident.HasMetering && st.Apower != nil && !math.IsNaN(*st.Apower) && !math.IsInf(*st.Apower, 0) {
			// W -> kW at 3dp; a consumer load is >= 0 (the goe nrg discipline).
			kw := math.Round(math.Max(0, *st.Apower)) / 1000
			out.PowerKw = &kw
		}
		return out, nil
	case Gen1:
		st, de := gen1Status(ctx, doer, cfg)
		if de != nil {
			return State{}, de
		}
		if cfg.Channel >= len(st.Relays) || st.Relays[cfg.Channel].IsOn == nil {
			return State{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Der Schaltkanal hat nicht verständlich geantwortet."}
		}
		out := State{On: st.Relays[cfg.Channel].IsOn}
		if ident.HasMetering && cfg.Channel < len(st.Meters) {
			m := st.Meters[cfg.Channel]
			if m.IsValid && m.Power != nil && !math.IsNaN(*m.Power) && !math.IsInf(*m.Power, 0) {
				kw := math.Round(math.Max(0, *m.Power)) / 1000
				out.PowerKw = &kw
			}
		}
		return out, nil
	default:
		return State{}, &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
	}
}

// SetURL builds the relay write of the detected dialect. An ON write carries
// the dead-man timer (see the package comment); an OFF write never does.
func SetURL(cfg Config, ident Identity, on bool) string {
	base := "http://" + cfg.HostPort()
	timer := cfg.onTimerS()
	switch ident.Gen {
	case Gen2:
		q := url.Values{}
		q.Set("id", strconv.Itoa(cfg.Channel))
		q.Set("on", strconv.FormatBool(on))
		if on && timer > 0 {
			q.Set("toggle_after", strconv.Itoa(timer))
		}
		return base + "/rpc/Switch.Set?" + q.Encode()
	case Gen1:
		q := url.Values{}
		if on {
			q.Set("turn", "on")
			if timer > 0 {
				q.Set("timer", strconv.Itoa(timer))
			}
		} else {
			q.Set("turn", "off")
		}
		return base + "/relay/" + strconv.Itoa(cfg.Channel) + "?" + q.Encode()
	default:
		return ""
	}
}

// SetRelay executes the relay write and validates the device accepted it (the
// documented response shapes: Gen2 `{"was_on":...}`, Gen1 `{"ison":...}`).
// The proof that the command HOLDS is the separate readback - a write echo is
// acceptance, not adoption.
func SetRelay(ctx context.Context, doer Doer, cfg Config, ident Identity, on bool) *DriverError {
	u := SetURL(cfg, ident, on)
	if u == "" {
		return &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
	}
	code, body, err := doer.Get(ctx, u)
	if de := classify(code, err); de != nil {
		return de
	}
	var resp map[string]json.RawMessage
	if e := json.Unmarshal(body, &resp); e != nil {
		return &DriverError{Code: ErrInvalidResponse,
			Message: "Das Gerät hat den Schaltbefehl nicht verständlich beantwortet."}
	}
	switch ident.Gen {
	case Gen2:
		if _, ok := resp["was_on"]; !ok {
			if raw, isErr := resp["message"]; isErr {
				var msg string
				_ = json.Unmarshal(raw, &msg)
				return &DriverError{Code: ErrInvalidResponse,
					Message: "Das Gerät hat den Schaltbefehl abgelehnt: " + msg}
			}
			return &DriverError{Code: ErrInvalidResponse,
				Message: "Das Gerät hat den Schaltbefehl nicht bestätigt."}
		}
	case Gen1:
		if _, ok := resp["ison"]; !ok {
			return &DriverError{Code: ErrInvalidResponse,
				Message: "Das Gerät hat den Schaltbefehl nicht bestätigt."}
		}
	}
	return nil
}
