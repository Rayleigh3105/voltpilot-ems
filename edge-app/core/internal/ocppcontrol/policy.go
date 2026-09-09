// Package ocppcontrol defines the additive, locally enforced OCPP setup.
package ocppcontrol

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"time"
)

type Policy struct {
	Revision      int64         `json:"revision"`
	Enabled       *bool         `json:"enabled,omitempty"`
	Authorization Authorization `json:"authorization"`
	Electrical    []Electrical  `json:"electrical"`
	PhaseLimitsA  []float64     `json:"phase_limits_a"`
	Limits        []Limit       `json:"limits"`
	Test          *TestRequest  `json:"test,omitempty"`
}

type Authorization struct {
	Mode        string   `json:"mode"`         // free | allowlist; absent policy preserves free charging
	AllowedTags []string `json:"allowed_tags"` // box HMAC references, never RFID plaintext
}

type Electrical struct {
	ChargePointID string `json:"charge_point_id"`
	ConnectorID   int    `json:"connector_id"`
	// Declared upper line-neutral operating voltage, not a guessed 230 V.
	VoltageV    float64 `json:"voltage_v"`
	Phases      []int   `json:"phases"` // actual wired grid phases: [1], [2,3], [1,2,3]
	MaxCurrentA float64 `json:"max_current_a"`
}

type Limit struct {
	ChargePointID string    `json:"charge_point_id"`
	ConnectorID   int       `json:"connector_id"`
	LimitKw       float64   `json:"limit_kw"`
	RequestedAt   time.Time `json:"requested_at"`
	ExpiresAt     time.Time `json:"expires_at"`
}

// A supervised test requests three 60-second steps: small limit, pause,
// resume. It expires after 180 seconds even without a subsequent cloud message.
type TestRequest struct {
	ChargePointID string    `json:"charge_point_id"`
	ConnectorID   int       `json:"connector_id"`
	LimitKw       float64   `json:"limit_kw"`
	RequestedAt   time.Time `json:"requested_at"`
}

var stationID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var tagRef = regexp.MustCompile(`^tagref_[0-9a-f]{24}$`)

func finite(v float64, min, max float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= min && v <= max
}
func target(id string, connector int) bool {
	return stationID.MatchString(id) && connector >= 1 && connector <= 32
}
func Key(id string, connector int) string { return fmt.Sprintf("%s#%d", id, connector) }

func (p Policy) Validate() error {
	bad := func() error {
		return errors.New("Ungültige OCPP-Steuerung: Freigabe, Phasen, Karten oder Zeitgrenzen prüfen")
	}
	if p.Revision < 1 || (p.Authorization.Mode != "free" && p.Authorization.Mode != "allowlist") || len(p.Authorization.AllowedTags) > 128 || len(p.Electrical) > 2048 || len(p.Limits) > 2048 {
		return bad()
	}
	tags := map[string]bool{}
	for _, tag := range p.Authorization.AllowedTags {
		if !tagRef.MatchString(tag) || tags[tag] {
			return bad()
		}
		tags[tag] = true
	}
	if len(p.PhaseLimitsA) != 0 && len(p.PhaseLimitsA) != 3 {
		return bad()
	}
	for _, amps := range p.PhaseLimitsA {
		if !finite(amps, 0, 2000) {
			return bad()
		}
	}
	seen := map[string]bool{}
	for _, e := range p.Electrical {
		key := Key(e.ChargePointID, e.ConnectorID)
		if !target(e.ChargePointID, e.ConnectorID) || seen[key] || !finite(e.VoltageV, 100, 300) || !finite(e.MaxCurrentA, 1, 2000) || len(e.Phases) < 1 || len(e.Phases) > 3 || len(p.PhaseLimitsA) != 3 {
			return bad()
		}
		seen[key] = true
		phases := map[int]bool{}
		for _, phase := range e.Phases {
			if phase < 1 || phase > 3 || phases[phase] {
				return bad()
			}
			phases[phase] = true
		}
	}
	seen = map[string]bool{}
	for _, l := range p.Limits {
		key := Key(l.ChargePointID, l.ConnectorID)
		if !target(l.ChargePointID, l.ConnectorID) || seen[key] || !finite(l.LimitKw, 0, 1000) || l.RequestedAt.IsZero() || !l.ExpiresAt.After(l.RequestedAt) || l.ExpiresAt.Sub(l.RequestedAt) > 24*time.Hour {
			return bad()
		}
		seen[key] = true
	}
	if t := p.Test; t != nil && (!target(t.ChargePointID, t.ConnectorID) || !finite(t.LimitKw, 0.1, 1000) || t.RequestedAt.IsZero()) {
		return bad()
	}
	return nil
}

func (p Policy) Clone() Policy {
	raw, _ := json.Marshal(p)
	var out Policy
	_ = json.Unmarshal(raw, &out)
	return out
}

func (p Policy) PhaseKey() string {
	raw, _ := json.Marshal(struct {
		Electrical []Electrical
		Limits     []float64
	}{p.Electrical, p.PhaseLimitsA})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

// Grants, manual requests and enable/disable do not rewrite safety profiles.
func (p Policy) SafetyKey() string { return p.PhaseKey() + ":" + p.Authorization.Mode }

func (p Policy) ProfileDuration(id string, connector int, now time.Time, duration time.Duration) time.Duration {
	for _, l := range p.Limits {
		if l.ChargePointID == id && l.ConnectorID == connector && !now.Before(l.RequestedAt) && now.Before(l.ExpiresAt) && l.ExpiresAt.Sub(now) < duration {
			duration = l.ExpiresAt.Sub(now)
		}
	}
	if t := p.Test; t != nil && t.ChargePointID == id && t.ConnectorID == connector {
		age := now.Sub(t.RequestedAt)
		if age >= 0 && age < 180*time.Second {
			remaining := 60*time.Second - age%(60*time.Second)
			if remaining < duration {
				duration = remaining
			}
		}
	}
	duration = duration.Truncate(time.Second)
	if duration < time.Second {
		duration = time.Second
	}
	return duration
}

func (p Policy) Allows(tag string) bool {
	if p.Authorization.Mode == "free" || p.Authorization.Mode == "" {
		return true
	}
	for _, allowed := range p.Authorization.AllowedTags {
		if tag != "" && allowed == tag {
			return true
		}
	}
	return false
}

func (p Policy) Wiring(id string, connector int) (Electrical, bool) {
	for _, e := range p.Electrical {
		if e.ChargePointID == id && e.ConnectorID == connector {
			return e, true
		}
	}
	return Electrical{}, false
}

// AmpereCeiling is conservative in kW and rounds DOWN to OCPP's 0.1 A.
func (e Electrical) AmpereCeiling(kw float64) float64 {
	if e.VoltageV <= 0 || len(e.Phases) == 0 {
		return 0
	}
	return math.Floor(math.Min(e.MaxCurrentA, math.Max(0, kw)*1000/(e.VoltageV*float64(len(e.Phases))))*10) / 10
}

func (p Policy) LimitKw(id string, connector int, now time.Time, kw float64) float64 {
	for _, l := range p.Limits {
		if l.ChargePointID == id && l.ConnectorID == connector && !now.Before(l.RequestedAt) && now.Before(l.ExpiresAt) {
			kw = math.Min(kw, l.LimitKw)
		}
	}
	if t := p.Test; t != nil && t.ChargePointID == id && t.ConnectorID == connector {
		age := now.Sub(t.RequestedAt)
		if age >= 0 && age < 180*time.Second {
			if age >= 60*time.Second && age < 120*time.Second {
				return 0
			}
			kw = math.Min(kw, t.LimitKw)
		}
	}
	return kw
}

// PhaseCaps reserves a FIXED share of each charging circuit for EVERY wired
// connector, including disconnected stations. This conservative first version
// needs no invented phase meter and cannot overspend a phase during fallback.
func (p Policy) PhaseCaps(id string, connector int, kw float64) float64 {
	e, ok := p.Wiring(id, connector)
	if !ok {
		return kw
	}
	amps := e.AmpereCeiling(kw)
	for _, phase := range e.Phases {
		count := 0
		for _, other := range p.Electrical {
			for _, op := range other.Phases {
				if op == phase {
					count++
				}
			}
		}
		if count > 0 {
			amps = math.Min(amps, p.PhaseLimitsA[phase-1]/float64(count))
		}
	}
	amps = math.Floor(amps*10) / 10
	return amps * e.VoltageV * float64(len(e.Phases)) / 1000
}
