package lastmgmt

import (
	"math"
	"sort"
	"time"
)

// PHASENUMSCHALTUNG (1p/3p). A three-phase AC charge point that may switch to
// one phase has TWO achievable bands instead of one, e.g. at 230 V / 16 A:
//
//	1 phase:  1.38 … 3.68 kW
//	3 phases: 4.14 … 11.04 kW
//
// Below the lower band the vehicle does not charge, and between the two bands
// nothing is achievable. Session.Ranges carries the bands; the allocator admits
// a session at the smallest achievable value and snaps every allocation DOWN
// into a band (restrict-only), handing the rest back to the others.
//
// WHICH band runs is a physical switch of the vehicle's charging, so it is
// paced by PhasePacer: a new band must be wanted for a while (dwell) and two
// switches keep a minimum distance (pause). While a switch is held back the
// executor offers the session only its ACTIVE band.

// PowerRange is one achievable band of a session at a fixed phase count.
type PowerRange struct {
	Phases int
	MinKw  float64
	MaxKw  float64
}

// Bands holds up to two bands of a session; an entry with Phases 0 is empty,
// and an all-empty value means one continuous band as before. A fixed array
// keeps Session comparable.
type Bands [2]PowerRange

// BandsOf takes the first two bands of a list.
func BandsOf(in []PowerRange) Bands {
	var b Bands
	copy(b[:], in)
	return b
}

// Any reports whether the session has bands at all.
func (b Bands) Any() bool { return b[0].Phases != 0 || b[1].Phases != 0 }

// list returns the bands in ascending order.
func (b Bands) list() []PowerRange {
	var out []PowerRange
	for _, r := range b {
		if r.Phases != 0 {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MinKw < out[j].MinKw })
	return out
}

// OnlyActive narrows the bands to the active one.
func (b Bands) OnlyActive(active int) Bands {
	for _, r := range b {
		if r.Phases == active {
			return Bands{r}
		}
	}
	return b
}

// explicitMin is the minimum somebody CHOSE for this session (charge point,
// vehicle profile). It stays a threshold on top of the bands.
//
// ⚠ The site-wide Mindestleistung is NOT applied to a session with bands: it
// stands in for the physical floor of a charge point the box cannot know
// ("4,2 kW 3p"), and the bands ARE that floor, known from the wiring. Keeping
// it would make every site that entered the three-phase minimum lose exactly
// the one-phase band it just allowed.
func explicitMin(s Session, _ Settings) float64 {
	return math.Max(0, s.MinKw)
}

// band is one band after the session's chosen minimum and its ceiling.
func band(s Session, set Settings, r PowerRange) (lo, hi float64, ok bool) {
	lo = math.Max(r.MinKw, explicitMin(s, set))
	hi = r.MaxKw
	if c := s.capped(); c < hi {
		hi = c
	}
	return lo, hi, lo <= hi+1e-9
}

// feasibleMin is the smallest value a session with bands can actually charge
// with. ok=false = no band survives its minimum and ceiling: it cannot charge.
func feasibleMin(s Session, set Settings) (float64, bool) {
	for _, r := range s.Ranges.list() {
		if lo, _, ok := band(s, set, r); ok {
			return lo, true
		}
	}
	return 0, false
}

// snapDown is the largest achievable value not above kw, and its phase count.
// 0 = nothing achievable at or below kw.
func snapDown(s Session, set Settings, kw float64) (float64, int) {
	rs := s.Ranges.list()
	for i := len(rs) - 1; i >= 0; i-- {
		lo, hi, ok := band(s, set, rs[i])
		if !ok || kw+1e-9 < lo {
			continue
		}
		return math.Min(kw, hi), rs[i].Phases
	}
	return 0, 0
}

// snapBands moves every banded allocation of a filled group DOWN into a band
// and water-fills what that frees among the others. Returns what is left.
// Each pass fixes at least one session at its band ceiling, so it ends.
func snapBands(adm []Session, give map[string]float64, left float64, set Settings) float64 {
	open := append([]Session(nil), adm...)
	for range open {
		snapped := false
		for i := range open {
			if !open[i].Ranges.Any() {
				continue
			}
			v := give[open[i].Key]
			f, _ := snapDown(open[i], set, v)
			if v-f <= 1e-9 {
				continue
			}
			give[open[i].Key] = f
			left += v - f
			// Its ceiling for the refill: what it gave back must not flow
			// straight back into the gap.
			ceiling := f
			open[i].MaxKw, open[i].CapKw = f, &ceiling
			snapped = true
		}
		if !snapped {
			break
		}
		left = waterFill(open, give, left)
	}
	return left
}

// Defaults of the switch pacing. Both sit ON TOP of the station's own
// protection; never assume the device protects the vehicle.
const (
	DefaultPhaseSwitchDwell = 60 * time.Second
	DefaultPhaseSwitchPause = 5 * time.Minute
)

// PhasePacer is the pacing state of ONE connector. The zero value is not
// usable; start with NewPhasePacer.
type PhasePacer struct {
	// Active is the phase count the station was last commanded with.
	Active int
	// TransactionID is the session this state belongs to. A new vehicle
	// starts over from the station's default.
	TransactionID int
	// Dwell / Pause override the defaults (0 = default); the rig shortens
	// them, the product does not.
	Dwell, Pause time.Duration
	desired      int
	desiredSince time.Time
	lastSwitch   time.Time
}

// NewPhasePacer starts a session at the phase count the station charges with
// without us (its three-phase default profile).
func NewPhasePacer(active, transactionID int) PhasePacer {
	return PhasePacer{Active: active, TransactionID: transactionID}
}

// Observe records which band the free decision wanted (0 = pause, no switch
// wish) and reports whether switching to it is allowed NOW.
func (p *PhasePacer) Observe(now time.Time, desired int) bool {
	if desired == 0 || desired == p.Active {
		p.desired = 0
		return true
	}
	if desired != p.desired {
		// A new wish starts its dwell from scratch: a surplus flapping across
		// the band boundary keeps restarting it.
		p.desired = desired
		p.desiredSince = now
	}
	dwell, pause := p.Dwell, p.Pause
	if dwell <= 0 {
		dwell = DefaultPhaseSwitchDwell
	}
	if pause <= 0 {
		pause = DefaultPhaseSwitchPause
	}
	dwellOk := now.Sub(p.desiredSince) >= dwell
	pauseOk := p.lastSwitch.IsZero() || now.Sub(p.lastSwitch) >= pause
	return dwellOk && pauseOk
}

// Held reports whether a switch is wanted but not yet allowed.
func (p PhasePacer) Held() bool { return p.desired != 0 && p.desired != p.Active }

// Switched records a switch the station ACCEPTED. A refused or unanswered
// command does not burn the pause.
func (p *PhasePacer) Switched(now time.Time, phases int) {
	if phases == p.Active {
		return
	}
	p.Active = phases
	p.lastSwitch = now
	p.desired = 0
}
