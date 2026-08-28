package guards

import (
	"math"
	"testing"
)

func highSocChargeGood() HighSocChargeInput {
	return HighSocChargeInput{
		Eligible: true, MeasurementsFresh: true, CommandKw: 0,
		SocPct: 91, SocMaxPct: 95, PvKw: 11.4, LoadKw: 2.9,
	}
}

func TestHighSocChargeAbsorbsTheReportedSurplusInsideTheUpperBuffer(t *testing.T) {
	d := HighSocCharge(highSocChargeGood())
	if !d.Active || d.CeilingPct == nil || *d.CeilingPct != 95 {
		t.Fatalf("91%% battery with 8.5 kW surplus must refill the 90-95%% buffer: %+v", d)
	}

	atFloor := highSocChargeGood()
	atFloor.SocPct = 90
	if d := HighSocCharge(atFloor); !d.Active {
		t.Fatalf("the lower edge belongs to the refillable top band: %+v", d)
	}
}

func TestHighSocChargeRefusesOutsideTheExplicitSafeShape(t *testing.T) {
	cases := []struct {
		name  string
		patch func(*HighSocChargeInput)
	}{
		{"authority absent", func(i *HighSocChargeInput) { i.Eligible = false }},
		{"stale measurements", func(i *HighSocChargeInput) { i.MeasurementsFresh = false }},
		{"planned charge", func(i *HighSocChargeInput) { i.CommandKw = 1 }},
		{"planned discharge remains", func(i *HighSocChargeInput) { i.CommandKw = -1 }},
		{"below top band", func(i *HighSocChargeInput) { i.SocPct = 89.9 }},
		{"at ceiling", func(i *HighSocChargeInput) { i.SocPct = 95 }},
		{"no material surplus", func(i *HighSocChargeInput) { i.PvKw = 3; i.LoadKw = 2.9 }},
		{"unknown soc", func(i *HighSocChargeInput) { i.SocPct = math.NaN() }},
		{"unknown pv", func(i *HighSocChargeInput) { i.PvKw = math.NaN() }},
		{"unknown load", func(i *HighSocChargeInput) { i.LoadKw = math.NaN() }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := highSocChargeGood()
			tc.patch(&in)
			if d := HighSocCharge(in); d.Active || d.CeilingPct != nil {
				t.Fatalf("unsafe authorization: %+v", d)
			}
		})
	}
}

func TestHighSocChargeUsesTheConfiguredCeilingInsteadOfHardCodingNinetyFive(t *testing.T) {
	in := highSocChargeGood()
	in.SocMaxPct, in.SocPct = 80, 76
	d := HighSocCharge(in)
	if !d.Active || d.CeilingPct == nil || *d.CeilingPct != 80 {
		t.Fatalf("a configured 75-80%% buffer must behave like the default 90-95%% band: %+v", d)
	}
}
