// Package ocppsim is the OCPP charge-point simulator of the load-management
// rig — the counterpart of internal/consumersim, and the reason the whole
// feature is provable without hardware.
//
// It is split like internal/csms: this file is the PURE half (the OCPP
// charging-profile stack and the simulated physics, no library, no socket,
// unit-testable), station.go binds it to a real ocpp-go charge point.
//
// ⚠ WHY THE STACK RESOLUTION LIVES HERE AND NOT IN THE PRODUCT: the CSMS
// decides what to COMMAND; a station decides what it will DO with the
// commands it holds. Those are two different jobs, and modelling the second
// one here is what makes "the budget is held" measurable at simulated meter
// values instead of merely acknowledged. The rules implemented are OCPP 1.6's
// own (§ Smart Charging): TxProfile beats TxDefaultProfile, both are capped by
// ChargePointMaxProfile, and a schedule whose `duration` has run out does not
// apply — the last of which IS the dead man's switch.
//
// Dev/rig tool. It is never part of a customer image.
package ocppsim

import (
	"sort"
	"time"
)

// Profile purposes (OCPP 1.6 vocabulary, verbatim).
const (
	PurposeMax       = "ChargePointMaxProfile"
	PurposeTxDefault = "TxDefaultProfile"
	PurposeTx        = "TxProfile"
)

// Profile is one charging profile as a station stores it.
type Profile struct {
	ID         int
	ConnectorD int // the connector it was set on; 0 = the whole station
	Purpose    string
	StackLevel int
	LimitW     float64
	StartsAt   time.Time
	Duration   time.Duration
}

// Expired reports whether this profile's schedule window has run out.
// A profile with no duration NEVER expires — that is what makes the two
// permanent profiles the safety net they are.
func (p Profile) Expired(now time.Time) bool {
	if p.Duration <= 0 || p.StartsAt.IsZero() {
		return false
	}
	return now.After(p.StartsAt.Add(p.Duration))
}

// Applies reports whether the profile is relevant for a connector.
func (p Profile) Applies(connector int) bool {
	return p.ConnectorD == 0 || p.ConnectorD == connector
}

// Resolve is the station's own answer to "what may connector c draw right
// now", in WATTS, given everything it holds.
//
// ok=false means NO profile applies at all — which is not a limit of 0 but
// the absence of one, and a station with no limit charges at its own rating.
// Conflating the two is exactly the error that makes a load manager look like
// it works right up until the first expiry.
func Resolve(profiles []Profile, connector int, now time.Time) (limitW float64, ok bool) {
	var tx, def *Profile
	var max *Profile
	list := append([]Profile(nil), profiles...)
	// Deterministic: highest stack level wins within a purpose, then the
	// highest id, so two profiles of one purpose never resolve by map order.
	sort.Slice(list, func(i, j int) bool {
		if list[i].StackLevel != list[j].StackLevel {
			return list[i].StackLevel < list[j].StackLevel
		}
		return list[i].ID < list[j].ID
	})
	for i := range list {
		p := &list[i]
		if !p.Applies(connector) || p.Expired(now) {
			continue
		}
		switch p.Purpose {
		case PurposeTx:
			tx = p
		case PurposeTxDefault:
			def = p
		case PurposeMax:
			max = p
		}
	}
	switch {
	case tx != nil:
		limitW, ok = tx.LimitW, true
	case def != nil:
		limitW, ok = def.LimitW, true
	}
	if max != nil {
		if !ok {
			// A station-wide cap alone IS a limit.
			return max.LimitW, true
		}
		if limitW > max.LimitW {
			limitW = max.LimitW
		}
	}
	return limitW, ok
}

// Vehicle is what is plugged into one connector.
type Vehicle struct {
	// DemandKw is what the car would draw if nothing limited it.
	DemandKw float64
	// MinKw is the car's own floor: below it a charge does not start at all.
	// This is the physics behind "pausing beats starving" — an allocation
	// under the floor buys nothing.
	MinKw float64
	// IdTag is the card this vehicle presents (Verbrauchsmanagement v1 / P7).
	// Empty falls back to the rig's one card, so every pre-P7 caller keeps
	// behaving byte-for-byte: two cards are the NEW case, not the default.
	IdTag string
}

// DrawKw is what a connector ACTUALLY draws: the vehicle's demand, capped by
// whatever profile applies — and 0 when that cap is under the car's own floor.
//
// A connector with NO applicable profile draws its full demand: that is the
// un-managed state, and it is precisely what the load management exists to
// prevent from happening by accident.
func DrawKw(v Vehicle, profiles []Profile, connector int, now time.Time) float64 {
	demand := v.DemandKw
	if demand < 0 {
		demand = 0
	}
	limitW, ok := Resolve(profiles, connector, now)
	if !ok {
		return demand
	}
	limit := limitW / 1000
	if limit < 0 {
		limit = 0
	}
	if limit < demand {
		demand = limit
	}
	if v.MinKw > 0 && demand < v.MinKw {
		return 0
	}
	return demand
}
