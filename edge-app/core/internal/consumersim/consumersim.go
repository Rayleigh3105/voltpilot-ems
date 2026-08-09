// Package consumersim is the generic, fully measurable AND controllable
// consumer simulator of the v2 rig (docs/verbrauchssteuerung.md §23,
// docs/contracts/v2/edge-simulator-v2.md): it models on/off, stepped,
// continuous and non-convex power_ranges_kw control, an availability signal
// (vehicle_connected-like) and register-faithful readback. A simulated
// wallbox, heating rod and pump are CONFIGURATIONS of this one model - no
// vendor driver is prioritized.
//
// The pure model lives here (unit-tested, no I/O); cmd/vp-consumer-sim wraps
// it as an MQTT participant on the core's local bus: it consumes the
// core-owned retained edge/entities/{id}/command, applies it to its
// "physical" state, answers with edge/entities/{id}/readback (the v1
// all_match shape the arbitration layer folds into the heartbeat) and
// publishes periodic edge/entities/{id}/telemetry.
package consumersim

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// ControlKind vocabulary (mirrors consumer_profile.control_kind).
const (
	KindOnOff      = "on_off"
	KindStepped    = "stepped"
	KindContinuous = "continuous"
)

// Config describes one simulated consumer.
type Config struct {
	EntityID    string
	ControlKind string
	// RatedKw is the on-level of an on_off consumer and the fallback ceiling.
	RatedKw float64
	// LevelsKw are the discrete levels of a stepped consumer (must contain 0,
	// ascending).
	LevelsKw []float64
	// MinPowerKw/MaxPowerKw bound a continuous consumer; below min = off.
	MinPowerKw, MaxPowerKw float64
	// PowerRangesKw are the D4 non-convex [min,max] ranges (e.g. 1-/3-phase
	// charging). Empty = the simple [MinPowerKw, MaxPowerKw] band.
	PowerRangesKw [][2]float64
	// AvailabilityChannel, when set, is reported in telemetry (1/0) and gates
	// execution: an unavailable device consumes nothing (a disconnected
	// vehicle cannot charge), whatever is commanded.
	AvailabilityChannel string
}

// Preset returns the §23 example devices as configurations of the ONE model.
func Preset(name string) (Config, error) {
	switch name {
	case "wallbox":
		return Config{
			ControlKind: KindContinuous,
			RatedKw:     11,
			MinPowerKw:  1.4, MaxPowerKw: 11,
			// 1-phase 1.4..3.7, 3-phase 4.2..11 - the D4 shape.
			PowerRangesKw:       [][2]float64{{1.4, 3.7}, {4.2, 11}},
			AvailabilityChannel: "vehicle_connected",
		}, nil
	case "heating-rod":
		return Config{ControlKind: KindOnOff, RatedKw: 6}, nil
	case "pump":
		return Config{ControlKind: KindOnOff, RatedKw: 2.2}, nil
	case "stepped-rod":
		return Config{ControlKind: KindStepped, RatedKw: 4.5,
			LevelsKw: []float64{0, 1.5, 3.0, 4.5}}, nil
	}
	return Config{}, fmt.Errorf("unbekanntes Preset %q (wallbox|heating-rod|pump|stepped-rod)", name)
}

// Applied is the result of executing one command against the device.
type Applied struct {
	// On/AppliedKw are the device's resulting "physical" state.
	On        bool
	AppliedKw float64
	// CommandedKw is the wished level the command carried (NaN for pure
	// on/off commands).
	CommandedKw float64
	// Mismatch reports the device could NOT execute the wish verbatim (a
	// snapped range/level, an unavailable vehicle) - the readback then says
	// all_match=false, honestly.
	Mismatch bool
}

// Device is the stateful simulated consumer.
type Device struct {
	mu        sync.Mutex
	cfg       Config
	available bool
	last      Applied
}

// New builds a device; availability starts true (an unavailable device is a
// scenario move, not a default).
func New(cfg Config) *Device {
	return &Device{cfg: cfg, available: true}
}

// Config returns the device's configuration.
func (d *Device) Config() Config { return d.cfg }

// SetAvailable flips the availability signal (vehicle plugged/unplugged).
// The physical state follows immediately: an unavailable device stops
// consuming; a re-available one stays off until the next command re-asserts.
func (d *Device) SetAvailable(v bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.available = v
	if !v {
		d.last.On = false
		d.last.AppliedKw = 0
	}
}

// Available reports the availability signal.
func (d *Device) Available() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.available
}

// State returns the last applied state.
func (d *Device) State() Applied {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.last
}

// Apply executes one command (the parsed edge/entities/{id}/command payload
// values). onOff / setpointKw may each be nil (absent). controlEnabled=false
// is the two-gate posture: the device treats it as "do not act" and keeps its
// state, reporting a readback about the COMMANDED values verbatim.
func (d *Device) Apply(onOff *bool, setpointKw *float64, controlEnabled bool) Applied {
	d.mu.Lock()
	defer d.mu.Unlock()

	wishOn := false
	wishKw := math.NaN()
	if setpointKw != nil && !math.IsNaN(*setpointKw) {
		wishKw = *setpointKw
		wishOn = wishKw > 0.005
	}
	if onOff != nil {
		wishOn = *onOff
	}

	if !controlEnabled {
		// Not acting is not a mismatch - nothing was executed at all.
		res := d.last
		res.CommandedKw = wishKw
		return res
	}

	res := Applied{CommandedKw: wishKw}
	switch {
	case !wishOn:
		res.On, res.AppliedKw = false, 0
	case !d.available:
		// Commanded on while unavailable: nothing consumes - an honest
		// mismatch (the vehicle is not there).
		res.On, res.AppliedKw, res.Mismatch = false, 0, true
	default:
		res.On = true
		res.AppliedKw = d.snap(wishKw)
		if res.AppliedKw <= 0.005 {
			res.On = false
		}
		if !math.IsNaN(wishKw) && math.Abs(res.AppliedKw-wishKw) > 0.01 {
			res.Mismatch = true
		}
	}
	d.last = res
	return res
}

// snap maps a wished level onto the device's achievable set - RESTRICT-ONLY
// (never above the wish, the highest achievable value at or below it; below
// the lowest achievable level = off). A NaN wish (pure on_off command) runs
// at rated power.
func (d *Device) snap(wishKw float64) float64 {
	if math.IsNaN(wishKw) {
		return d.cfg.RatedKw
	}
	if wishKw < 0 {
		return 0
	}
	switch d.cfg.ControlKind {
	case KindOnOff:
		return d.cfg.RatedKw
	case KindStepped:
		levels := append([]float64(nil), d.cfg.LevelsKw...)
		sort.Float64s(levels)
		best := 0.0
		for _, l := range levels {
			if l <= wishKw+1e-9 {
				best = l
			}
		}
		return best
	default: // continuous
		ranges := d.cfg.PowerRangesKw
		if len(ranges) == 0 {
			lo, hi := d.cfg.MinPowerKw, d.cfg.MaxPowerKw
			if hi <= 0 {
				hi = d.cfg.RatedKw
			}
			ranges = [][2]float64{{lo, hi}}
		}
		best := 0.0
		for _, r := range ranges {
			switch {
			case wishKw >= r[0] && wishKw <= r[1]:
				return wishKw
			case wishKw > r[1] && r[1] > best:
				// Above this range: its max is achievable below the wish.
				best = r[1]
			}
		}
		return best
	}
}
