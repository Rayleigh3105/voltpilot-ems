package guards

import (
	"strings"
	"testing"
)

// F9 on the rule side: when the box fails, the Fronius revert timers free the
// plant - so a site with a feed-in limit must hold it DEVICE-SIDE, and the box
// warns until something does.
func TestTheFeedInLimitNeedsADeviceSideBackstop(t *testing.T) {
	limit, deye33, deye30 := 30.0, 33.0, 30.0
	cases := []struct {
		name    string
		in      BackstopInput
		covered bool
		source  string
		says    string
	}{
		{"Herzogau today: nothing declared, the Deye's own cap is 33 kW",
			BackstopInput{LimitKw: &limit, DeviceLimitKw: &deye33, MeterLocation: MeterAtGridPoint, OtherPvKwp: 54},
			false, "", "33,0 kW) liegt über"},
		{"the Deye's own cap at the limit cannot reach 54 kWp of Fronius",
			BackstopInput{LimitKw: &limit, DeviceLimitKw: &deye30, MeterLocation: MeterAtGridPoint, OtherPvKwp: 54},
			false, "", "54,0 kWp"},
		{"a device cap only counts from a meter at the grid point",
			BackstopInput{LimitKw: &limit, DeviceLimitKw: &deye30, MeterLocation: MeterUnknown, OtherPvKwp: 10},
			false, "", "Netzpunkt"},
		{"a further producer without a nameplate is unknown, not small",
			BackstopInput{LimitKw: &limit, DeviceLimitKw: &deye30, MeterLocation: MeterAtGridPoint, OtherPvUnknown: true},
			false, "", "unbekannt"},
		{"the hybrid's own cap covers a plant whose other PV cannot exceed the limit",
			BackstopInput{LimitKw: &limit, DeviceLimitKw: &deye30, MeterLocation: MeterAtGridPoint, OtherPvKwp: 20},
			true, BackstopDevice, "hält selbst"},
		{"the installer declared a device-side backstop",
			BackstopInput{LimitKw: &limit, Declared: ExportBackstopPresent, OtherPvKwp: 54},
			true, BackstopDeclared, "gemeldet"},
		{"the installer declared that there is none",
			BackstopInput{LimitKw: &limit, Declared: ExportBackstopNone, OtherPvKwp: 54},
			false, "", "„kein geräteseitiger Rückhalt“"},
		{"nothing known at all",
			BackstopInput{LimitKw: &limit},
			false, "", "hält nur die Box"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, ok := ExportBackstopFor(c.in)
			if !ok || v.Covered != c.covered || v.Source != c.source || !strings.Contains(v.Text, c.says) {
				t.Fatalf("got %+v (ok=%v), want covered=%v source=%q text containing %q", v, ok, c.covered, c.source, c.says)
			}
		})
	}
	if _, ok := ExportBackstopFor(BackstopInput{}); ok {
		t.Fatalf("a site without a feed-in limit needs no backstop verdict")
	}
}
