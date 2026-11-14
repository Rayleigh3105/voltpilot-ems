package guards

// The CHANGE GUARD (Steuerlogik K2, docs/contracts/v2/steuerlogik.md
// "Geräte mit Sollwert und Betriebsart"): an air conditioner, a heat pump or a
// cold-room controller regulates its compressor ITSELF. The box only moves its
// setpoint and picks its operating mode - and a compressor must not be pushed
// back and forth by a setpoint that changes every few seconds. So two changes
// of the setpoint in °C (or of the mode) are at least MinInterval apart; a
// change that comes earlier is HELD at the value granted before, with an honest
// reason, and lands on the first re-evaluation after the interval.
//
// It is the temporal sibling of the cycle guard and runs on the same path: every
// command of the entity - desires and the failsafe rest values alike (device
// protection ranks above the failsafe, §3.1 of the consumer doctrine). The very
// first value is never held: a guard that cannot know when the device last
// changed must not invent a pause (in-memory state, like the cycle guard).

import (
	"math"
	"sync"
	"time"
)

// ChangeReasonInterval is the reason code of a held change (the §15
// reason_code vocabulary, K2 extension).
const ChangeReasonInterval = "guard_change_interval"

// StageChangeInterval is the arbitration-event stage of a held change.
const StageChangeInterval = "guard:change_interval"

// StageSetpointBand is the stage of the setpoint clamp in °C: the band and
// step the installer released at the device.
const StageSetpointBand = "guard:setpoint_band"

// ChangeGuard holds changes of one entity's setpoint (°C) and mode.
type ChangeGuard struct {
	mu          sync.Mutex
	minInterval time.Duration

	setpoint   *float64
	setpointAt time.Time
	mode       string
	modeAt     time.Time
}

// NewChangeGuard builds the guard; an interval of 0 lets every change pass.
func NewChangeGuard(minInterval time.Duration) *ChangeGuard {
	return &ChangeGuard{minInterval: minInterval}
}

// SetInterval updates the interval without forgetting the last changes (a
// registry re-push must not reopen a closed window).
func (g *ChangeGuard) SetInterval(d time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.minInterval = d
}

// ChangeHold names one held change: what was wished, what stays, and the
// German sentence for the status surfaces.
type ChangeHold struct {
	Code string
	Text string
	// Field is "setpoint_c" or "mode".
	Field string
	// Until is when the held change may land.
	Until time.Time
}

// Apply passes a granted setpoint (nil = none) and mode ("" = none) through
// the guard and returns what may be commanded now, plus the holds. A value
// that equals the last granted one is no change and never held.
func (g *ChangeGuard) Apply(now time.Time, setpoint *float64, mode string) (*float64, string, []ChangeHold) {
	g.mu.Lock()
	defer g.mu.Unlock()
	var holds []ChangeHold
	outSP := setpoint
	if setpoint != nil {
		switch {
		case g.setpoint == nil || math.Abs(*g.setpoint-*setpoint) < 1e-9:
			if g.setpoint == nil {
				g.setpointAt = now
			}
			v := *setpoint
			g.setpoint = &v
		case now.Sub(g.setpointAt) < g.minInterval:
			v := *g.setpoint
			outSP = &v
			holds = append(holds, ChangeHold{Code: ChangeReasonInterval, Field: "setpoint_c",
				Until: g.setpointAt.Add(g.minInterval),
				Text:  "wartet - Abstand zwischen zwei Sollwert-Änderungen"})
		default:
			v := *setpoint
			g.setpoint, g.setpointAt = &v, now
		}
	}
	outMode := mode
	if mode != "" {
		switch {
		case g.mode == "" || g.mode == mode:
			if g.mode == "" {
				g.modeAt = now
			}
			g.mode = mode
		case now.Sub(g.modeAt) < g.minInterval:
			outMode = g.mode
			holds = append(holds, ChangeHold{Code: ChangeReasonInterval, Field: "mode",
				Until: g.modeAt.Add(g.minInterval),
				Text:  "wartet - Abstand zwischen zwei Wechseln der Betriebsart"})
		default:
			g.mode, g.modeAt = mode, now
		}
	}
	return outSP, outMode, holds
}
