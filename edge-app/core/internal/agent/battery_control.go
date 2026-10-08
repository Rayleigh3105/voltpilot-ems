package agent

import (
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
)

// The steering state of the battery, reported in every status heartbeat
// (`battery_control`, contract docs/contracts/speicher-steuerstand.md): does
// VoltPilot COMMAND this box's battery, or does the box only OBSERVE it?
//
// The optimizer reads it to stop planning trades for a battery nobody steers
// (services/optimization, battery_observed). The word comes from the SAME gate
// applySetpoint uses for the „Sonne + Speicher" readiness - the kill-switch AND
// the certification merge - so the heartbeat and the release path can never
// disagree about which battery is observed.
const (
	batteryControlCommanded = "gesteuert"
	batteryControlObserved  = "beobachtet"
	batteryControlStopped   = "not_aus"
)

// batteryControlState maps the two gate inputs to the contract word. Pure;
// pinned by the `box` vectors in docs/contracts/speicher-steuerstand-vectors.json.
func batteryControlState(killSwitchOn, certified bool) string {
	switch {
	case !killSwitchOn:
		return batteryControlStopped
	case certified:
		return batteryControlCommanded
	default:
		return batteryControlObserved
	}
}

// batteryControlSummary is the heartbeat block, evaluated at publish time from
// the core gate. nil while no inverter is selected: without a selection there
// is no battery path to speak of, and "unknown" must not travel as "observed".
func (a *Agent) batteryControlSummary() *cloud.BatteryControlSummary {
	family := a.currentFamily()
	if strings.TrimSpace(family) == "" {
		return nil
	}
	certified := a.controlCertified(family)
	return &cloud.BatteryControlSummary{
		State:          batteryControlState(a.Cfg.ControlEnabled, certified),
		ControlEnabled: a.Cfg.ControlEnabled && certified,
		Certified:      certified,
	}
}
