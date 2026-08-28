package guards

import (
	"math"
	"testing"
)

func highSocGood() HighSocInput {
	floor := 35.0
	return HighSocInput{
		Eligible: true, MeasurementsFresh: true, CommandKw: 0,
		SocPct: 94, SocMaxPct: 95, EffectiveFloorPct: &floor,
		PvKw: 0.9, LoadKw: 5.0,
	}
}

func TestHighSocReliefCoversTheReportedFullBatteryImportThenStopsAtTheTopBand(t *testing.T) {
	h := NewHighSocRelief()
	d := h.Decide(highSocGood())
	if !d.Active || d.FloorPct == nil || *d.FloorPct != 90 {
		t.Fatalf("94%% battery on a 95%% ceiling must open only the 90-95%% band: %+v", d)
	}

	// Entry has hysteresis: after crossing below the 94 % entry point, the
	// useful top-band correction continues instead of stopping after one tick.
	mid := highSocGood()
	mid.SocPct = 92
	if d := h.Decide(mid); !d.Active || d.FloorPct == nil || *d.FloorPct != 90 {
		t.Fatalf("armed top band must hold to its release floor: %+v", d)
	}

	atFloor := highSocGood()
	atFloor.SocPct = 90
	if d := h.Decide(atFloor); d.Active {
		t.Fatalf("the optimizer keeps everything below the small top band: %+v", d)
	}
	// Once released, 93 % is not close enough to re-arm.
	atFloor.SocPct = 93
	if d := h.Decide(atFloor); d.Active {
		t.Fatalf("released hysteresis must not chatter below the entry point: %+v", d)
	}
}

func TestHighSocReliefComposesWithTheFullReserveStack(t *testing.T) {
	h := NewHighSocRelief()
	in := highSocGood()
	reserve := 93.0
	in.EffectiveFloorPct = &reserve
	d := h.Decide(in)
	if !d.Active || d.FloorPct == nil || *d.FloorPct != 93 {
		t.Fatalf("the higher cloud reserve must win: %+v", d)
	}

	h.Release()
	reserve = 94
	in.EffectiveFloorPct = &reserve
	if d := h.Decide(in); d.Active {
		t.Fatalf("no top band may be invented above a binding reserve: %+v", d)
	}
}

func TestHighSocReliefRefusesEveryAmbiguousOrNonIdleCase(t *testing.T) {
	cases := []struct {
		name  string
		patch func(*HighSocInput)
	}{
		{"authority absent", func(i *HighSocInput) { i.Eligible = false }},
		{"stale measurements", func(i *HighSocInput) { i.MeasurementsFresh = false }},
		{"planned charge", func(i *HighSocInput) { i.CommandKw = 1 }},
		{"planned discharge", func(i *HighSocInput) { i.CommandKw = -1 }},
		{"not near full", func(i *HighSocInput) { i.SocPct = 93.9 }},
		{"no material import", func(i *HighSocInput) { i.LoadKw = 1; i.PvKw = .9 }},
		{"unknown soc", func(i *HighSocInput) { i.SocPct = math.NaN() }},
		{"unknown load", func(i *HighSocInput) { i.LoadKw = math.NaN() }},
		{"missing floor", func(i *HighSocInput) { i.EffectiveFloorPct = nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHighSocRelief()
			in := highSocGood()
			tc.patch(&in)
			if d := h.Decide(in); d.Active || d.FloorPct != nil {
				t.Fatalf("unsafe authorization: %+v", d)
			}
		})
	}
}

func TestHighSocReliefUsesTheConfiguredCeilingInsteadOfHardCodingNinetyFive(t *testing.T) {
	h := NewHighSocRelief()
	in := highSocGood()
	in.SocMaxPct, in.SocPct = 80, 79
	d := h.Decide(in)
	if !d.Active || d.FloorPct == nil || *d.FloorPct != 75 {
		t.Fatalf("an intentionally lower ceiling is still the battery's full point: %+v", d)
	}
}

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
