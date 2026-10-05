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
	// PhaseSwitching allows the live allocation to charge this three-phase
	// connector on ONE phase (OCPP numberPhases=1), so a vehicle can start
	// below the three-phase minimum. Opt-in by the operator; the station must
	// also report ConnectorSwitch3to1PhaseSupported=true. It never touches the
	// permanent safety profiles, which stay three-phase.
	PhaseSwitching bool `json:"phase_switching,omitempty"`
}

// MinChargeCurrentA is the lowest current an AC vehicle charges with (IEC
// 61851-1). Below it a limit is not a slower charge but a pause.
const MinChargeCurrentA = 6.0

// PhaseRange is one achievable charging band of a connector at a fixed phase
// count. Between two bands nothing is achievable.
type PhaseRange struct {
	Phases int
	MinKw  float64
	MaxKw  float64
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
		if e.PhaseSwitching && len(e.Phases) != 3 {
			return bad()
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

// wiringKey is Electrical without PhaseSwitching. The switch changes neither
// the safety profiles nor any reserved phase share, so toggling it must not
// demand idle stations or a new commissioning - and the key of every policy
// without it stays byte-identical to before.
type wiringKey struct {
	ChargePointID string  `json:"charge_point_id"`
	ConnectorID   int     `json:"connector_id"`
	VoltageV      float64 `json:"voltage_v"`
	Phases        []int   `json:"phases"`
	MaxCurrentA   float64 `json:"max_current_a"`
}

func (p Policy) PhaseKey() string {
	var wiring []wiringKey
	if p.Electrical != nil {
		wiring = make([]wiringKey, 0, len(p.Electrical))
	}
	for _, e := range p.Electrical {
		wiring = append(wiring, wiringKey{e.ChargePointID, e.ConnectorID, e.VoltageV, e.Phases, e.MaxCurrentA})
	}
	raw, _ := json.Marshal(struct {
		Electrical []wiringKey
		Limits     []float64
	}{wiring, p.PhaseLimitsA})
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
	amps := math.Min(e.AmpereCeiling(kw), p.shareA(e))
	amps = math.Floor(amps*10) / 10
	return amps * e.VoltageV * float64(len(e.Phases)) / 1000
}

// shareA is the per-phase current this connector may draw on ANY of its
// phases: its own maximum, and the fixed share of every circuit it is wired to.
// One-phase charging uses one of those phases, so the same ceiling binds it.
func (p Policy) shareA(e Electrical) float64 {
	amps := e.MaxCurrentA
	for _, phase := range e.Phases {
		count := 0
		for _, other := range p.Electrical {
			for _, op := range other.Phases {
				if op == phase {
					count++
				}
			}
		}
		if count > 0 && phase-1 < len(p.PhaseLimitsA) {
			amps = math.Min(amps, p.PhaseLimitsA[phase-1]/float64(count))
		}
	}
	return amps
}

// SwitchRanges are the two bands of a connector the operator allowed to charge
// on one phase: 1-phase and 3-phase over the same current band (6 A up to the
// connector's per-phase ceiling), e.g. [1.38, 3.68] and [4.14, 11.04] kW at
// 230 V and 16 A. ok=false = no switching here (not allowed, not three wired
// phases, or a ceiling below the charging minimum).
func (p Policy) SwitchRanges(id string, connector int) ([]PhaseRange, bool) {
	e, ok := p.Wiring(id, connector)
	if !ok || !e.PhaseSwitching || len(e.Phases) != 3 || e.VoltageV <= 0 {
		return nil, false
	}
	amps := math.Floor(p.shareA(e)*10) / 10
	if amps < MinChargeCurrentA {
		return nil, false
	}
	kw := func(a float64, phases int) float64 {
		return math.Round(a*e.VoltageV*float64(phases)) / 1000
	}
	return []PhaseRange{
		{Phases: 1, MinKw: kw(MinChargeCurrentA, 1), MaxKw: kw(amps, 1)},
		{Phases: 3, MinKw: kw(MinChargeCurrentA, 3), MaxKw: kw(amps, 3)},
	}, true
}

// SwitchAmpere converts a kW limit of a connector that may switch, for the
// given phase count (1 or 3), bounded by the same per-phase ceiling either way
// and rounded DOWN to OCPP's 0.1 A. The tiny tolerance keeps a band minimum
// such as 1.38 kW at 230 V from flooring to 5.9 A and pausing the vehicle.
func (p Policy) SwitchAmpere(id string, connector int, kw float64, phases int) (float64, bool) {
	e, ok := p.Wiring(id, connector)
	if !ok || !e.PhaseSwitching || len(e.Phases) != 3 || e.VoltageV <= 0 || (phases != 1 && phases != 3) {
		return 0, false
	}
	amps := math.Min(p.shareA(e), math.Max(0, kw)*1000/(e.VoltageV*float64(phases)))
	return math.Floor(amps*10+1e-6) / 10, true
}
