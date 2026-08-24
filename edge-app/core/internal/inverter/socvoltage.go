package inverter

import "fmt"

// SocFromVoltage is the pack's two ends: the terminal voltage at 0 % and at
// 100 %, from the battery's own datasheet. The decoder interpolates linearly
// between them when - and only when - the inverter's SoC register shows the
// "the BMS reports nothing" signature (see Connection.SocFromVoltage).
type SocFromVoltage struct {
	VEmpty float64 `json:"v_empty"`
	VFull  float64 `json:"v_full"`
}

// The plausible band a battery terminal voltage can sit in, deliberately WIDE:
// it must cover an LV 48-V-class pack (~40..60 V) and an HV string (~100..1000 V)
// with the same rule, because the api and the box know the pack's class no
// better than the customer typing it. It only catches the values that cannot be
// a battery at all - a unit mix-up (millivolts, a percentage) or a typo'd extra
// digit - and leaves the domain judgement to the operator.
const (
	SocVoltageMin = 10.0
	SocVoltageMax = 1000.0
	// The smallest usable span. Below it the interpolation degenerates into a
	// step function (and at 0 into a division by zero), so a percentage from it
	// would be noise dressed as a state of charge.
	SocVoltageMinSpan = 0.5
)

// validate refuses a pair that cannot describe a battery. A nil receiver is
// valid: "no estimate" is the normal state of almost every plant.
//
// ⚠ It is the box's OWN judgement, not a repeat of the portal's: this connection
// arrives over the retained config, and a device that trusted whatever the cloud
// sent would show a percentage nobody could account for. The api validates the
// same rule with a German message before it ever gets here (ComponentService),
// and the decoder defends itself a third time by simply estimating nothing.
func (v *SocFromVoltage) validate() error {
	if v == nil {
		return nil
	}
	for _, f := range []struct {
		label string
		val   float64
	}{{"Spannung bei 0 %", v.VEmpty}, {"Spannung bei 100 %", v.VFull}} {
		if f.val < SocVoltageMin || f.val > SocVoltageMax {
			return fmt.Errorf("%s muss zwischen %.0f und %.0f Volt liegen.",
				f.label, SocVoltageMin, SocVoltageMax)
		}
	}
	if v.VFull-v.VEmpty < SocVoltageMinSpan {
		return fmt.Errorf(
			"Die Spannung bei 100 %% muss mindestens %.1f Volt über der bei 0 %% liegen.",
			SocVoltageMinSpan)
	}
	return nil
}
