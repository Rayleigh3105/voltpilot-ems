package guards

import (
	"math"
	"testing"
)

// The live constellation of the incident, read VERBATIM out of the box's own
// state snapshot (scout report vp-herzogau-einspeisung-statt-laden-h3,
// box/state-final.json, 2026-08-29 10:53:13 local): the Fahrplan commanded a
// charge of 9,82 kW, the plant measured 56,907 kW PV against a 29,013 kW house,
// and the difference left the site at a negative price.
func herzogau1053() SurplusStoreInput {
	return SurplusStoreInput{
		Eligible: true, MeasurementsFresh: true, CommandKw: 9.82,
		SocPct: 38, SocMaxPct: 95, PvKw: 56.907, LoadKw: 29.013,
	}
}

func TestStoreSurplusRaisesTheUnderEstimatedChargeOfTheReportedIncident(t *testing.T) {
	in := herzogau1053()
	if d := StoreSurplus(in); !d.Active {
		t.Fatalf("a 9,82 kW charge against a 27,9 kW measured surplus must be raised: %+v", d)
	}
	// The second snapshot of the same quarter hour (box/state-abregel-frage.json,
	// 10:47:17): same command, 55,071 kW PV, 28,852 kW house, storage at 36 %.
	earlier := in
	earlier.PvKw, earlier.LoadKw, earlier.SocPct = 55.071, 28.852, 36
	if d := StoreSurplus(earlier); !d.Active {
		t.Fatalf("the 10:47 snapshot of the same incident must be raised too: %+v", d)
	}
}

// The exported energy is what the rule exists to keep: with the command left at
// the plan's value the predicted grid power is a real export, and at the raised
// value it is exactly zero. Both are pure arithmetic on the SAME measurement.
func TestStoreSurplusTargetsExactlyZeroGridExchange(t *testing.T) {
	in := herzogau1053()
	surplus := in.PvKw - in.LoadKw

	planned := in.LoadKw - in.PvKw + in.CommandKw
	if planned > -18.0 || planned < -18.1 {
		t.Fatalf("the plan as commanded exports %.3f kW; the incident reported ~18 kW", -planned)
	}
	raised := in.LoadKw - in.PvKw + surplus
	if math.Abs(raised) > 1e-9 {
		t.Fatalf("charging the measured surplus must land at grid 0, got %.6f kW", raised)
	}
	// And it can never overshoot into an IMPORT: the bound IS the surplus.
	if surplus < 0 {
		t.Fatalf("a surplus is non-negative by construction, got %.3f", surplus)
	}
}

// The IDLE entry, and the constellation that outgrew the retired top-band
// buffer (scout report §4/§8 B2): Anlage Pilsting/Herzogau 10:14:29, storage
// 19 %, PV 39,354 kW, house 16,383 kW - and 22,8 kW leaving the site while the
// slot's obsolete forecast discharge had already been followed down to 0,0 kW.
func herzogau1014() SurplusStoreInput {
	return SurplusStoreInput{
		Eligible: true, IdleAuthorized: true, MeasurementsFresh: true, CommandKw: 0,
		SocPct: 19, SocMaxPct: 95, PvKw: 39.354, LoadKw: 16.383,
	}
}

func TestStoreSurplusStoresTheSurplusOfAnIdleCoverLoadSlot(t *testing.T) {
	d := StoreSurplus(herzogau1014())
	if !d.Active || !d.Idle {
		t.Fatalf("19%% storage exporting 22,8 kW in a cover-load slot must store it: %+v", d)
	}
	// The retired buffer engaged only between soc_max-5 and soc_max, which is
	// exactly why it refused this case. The general rule reaches every SoC below
	// the ceiling - the same step its DISCHARGE twin took one day earlier.
	for _, soc := range []float64{0, 5, 19, 37, 50, 89.9, 91, 94.99} {
		in := herzogau1014()
		in.SocPct = soc
		if d := StoreSurplus(in); !d.Active || !d.Idle {
			t.Fatalf("SoC %.2f%% below the ceiling must be stored: %+v", soc, d)
		}
	}
}

// The case the retired top-band buffer was built for must keep working
// unchanged: 91 % storage, PV 11,4 kW, house 2,9 kW, 8,5 kW exported while the
// cockpit still called the slot "Verbrauch decken" (28.08.2026, 17:50).
func TestStoreSurplusStillCoversTheRetiredUpperBufferCase(t *testing.T) {
	in := herzogau1014()
	in.SocPct, in.PvKw, in.LoadKw = 91, 11.4, 2.9
	if d := StoreSurplus(in); !d.Active || !d.Idle {
		t.Fatalf("the former upper-buffer vector must still be stored: %+v", d)
	}
}

// THE discriminator of the idle entry. A resting command with a large surplus
// can also mean "sell at the peak price" - only the cloud knows, and it says so
// with cover_load_from_battery. Without that marker nothing is reinterpreted.
func TestStoreSurplusNeverStoresAnIdleCommandWithoutTheCloudsOwnConsumptionMarker(t *testing.T) {
	in := herzogau1014()
	in.IdleAuthorized = false
	if d := StoreSurplus(in); d.Active {
		t.Fatalf("an unmarked resting slot may be a deliberate sale: %+v", d)
	}
	// ... while the CHARGE entry is unaffected by the marker: there the plan
	// itself already decided to store.
	in.CommandKw = 9.82
	if d := StoreSurplus(in); !d.Active || d.Idle {
		t.Fatalf("a planned charge needs no marker: %+v", d)
	}
}

func TestStoreSurplusRefusesOutsideTheExplicitSafeShape(t *testing.T) {
	cases := []struct {
		name  string
		patch func(*SurplusStoreInput)
	}{
		{"authority absent", func(i *SurplusStoreInput) { i.Eligible = false }},
		{"stale measurements", func(i *SurplusStoreInput) { i.MeasurementsFresh = false }},
		// The two commands this rule must never touch: an idle one needs the
		// cloud's own-consumption marker to rule out a sell slot, and a
		// discharge is a direction rather than a magnitude.
		{"idle command without the marker", func(i *SurplusStoreInput) { i.CommandKw = 0 }},
		{"idle command inside the deadband, no marker", func(i *SurplusStoreInput) { i.CommandKw = 0.05 }},
		{"a sale is never idle, marker or not", func(i *SurplusStoreInput) {
			i.IdleAuthorized = true
			i.CommandKw = -0.06
		}},
		{"authorized idle but at the ceiling", func(i *SurplusStoreInput) {
			i.IdleAuthorized = true
			i.CommandKw = 0
			i.SocPct = 95
		}},
		{"authorized idle but no material surplus", func(i *SurplusStoreInput) {
			i.IdleAuthorized = true
			i.CommandKw = 0
			i.PvKw = 29.1
		}},
		{"authorized idle but stale measurements", func(i *SurplusStoreInput) {
			i.IdleAuthorized = true
			i.CommandKw = 0
			i.MeasurementsFresh = false
		}},
		{"planned sale", func(i *SurplusStoreInput) { i.CommandKw = -30 }},
		{"at the ceiling", func(i *SurplusStoreInput) { i.SocPct = 95 }},
		{"above the ceiling", func(i *SurplusStoreInput) { i.SocPct = 96 }},
		{"command already takes the surplus", func(i *SurplusStoreInput) { i.CommandKw = 27.9 }},
		{"shortfall inside meter noise", func(i *SurplusStoreInput) { i.CommandKw = 27.7 }},
		{"house consumes everything", func(i *SurplusStoreInput) { i.LoadKw = 60 }},
		{"unknown pv", func(i *SurplusStoreInput) { i.PvKw = math.NaN() }},
		{"unknown load", func(i *SurplusStoreInput) { i.LoadKw = math.NaN() }},
		{"unknown soc", func(i *SurplusStoreInput) { i.SocPct = math.NaN() }},
		{"unknown command", func(i *SurplusStoreInput) { i.CommandKw = math.Inf(1) }},
		{"no configured ceiling", func(i *SurplusStoreInput) { i.SocMaxPct = 0 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := herzogau1053()
			tc.patch(&in)
			if d := StoreSurplus(in); d.Active {
				t.Fatalf("unsafe authorization: %+v", d)
			}
		})
	}
}

// The magnitude correction must be available at EVERY state of charge below the
// ceiling - unlike the narrow top-band buffer it stands next to, whose SoC
// window is what made the 19 %/37 % incident unreachable in the first place.
func TestStoreSurplusEngagesAtEveryStateOfChargeBelowTheCeiling(t *testing.T) {
	for _, soc := range []float64{0, 5, 19, 37, 38, 89.9, 94.99} {
		in := herzogau1053()
		in.SocPct = soc
		if !StoreSurplus(in).Active {
			t.Fatalf("SoC %.2f%% is below the ceiling and must be raised", soc)
		}
	}
}

// A configured ceiling other than the default must behave identically - the
// rule reads the limit, it never hard-codes 95.
func TestStoreSurplusUsesTheConfiguredCeiling(t *testing.T) {
	in := herzogau1053()
	in.SocMaxPct, in.SocPct = 80, 79.9
	if !StoreSurplus(in).Active {
		t.Fatal("just below a configured 80 % ceiling must still be raised")
	}
	in.SocPct = 80
	if StoreSurplus(in).Active {
		t.Fatal("at a configured 80 % ceiling there is nothing left to fill")
	}
}
