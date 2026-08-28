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
