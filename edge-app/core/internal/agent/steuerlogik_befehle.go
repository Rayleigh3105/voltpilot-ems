package agent

// The seam from a Steuerlogik's outputs to the command vocabulary of the box
// (K2): what a device that regulates itself is told. Arming a logic (Stufe 3)
// submits exactly these commands to the arbiter; the run-along of Stufe 2 only
// compares them. Band, step, mode list, change interval and rest values are the
// guard chain's job, not this mapping's.

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
)

// logikBefehle maps one device's output of a beat onto commands: on_off as is,
// a setpoint in °C as setpoint_c, a setpoint in kW as setpoint_kw, a mode as
// mode. An output without a wish yields no command (the device's rest value
// applies). The heating rod's level is not mapped here: its stage travels as
// setpoint_kw with an output set (heizstab-regler.md) and needs the device's
// kW per output.
func logikBefehle(a logik.Ausgang) entities.Commands {
	var c entities.Commands
	if a.HatEin && a.Ein != nil {
		v := *a.Ein
		c.OnOff = &v
	}
	if a.HatSollwert && a.Sollwert != nil && a.Sollwert.Art == logik.WertZahl {
		v := a.Sollwert.V
		switch a.Sollwert.D {
		case logik.GroesseTemp:
			c.SetpointC = &v
		case logik.GroesseKW:
			c.SetpointKw = &v
		}
	}
	if a.HatBetriebsart && a.Betriebsart != "" {
		c.Mode = a.Betriebsart
	}
	return c
}
