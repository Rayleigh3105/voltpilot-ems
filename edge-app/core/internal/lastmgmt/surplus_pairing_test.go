package lastmgmt

import (
	"testing"
	"time"
)

// THE STAIRCASE: what ONE mispaired sample does to the source lane.
//
// The site's surplus is derived from `restNoBatt = grid - charging - battery`,
// and the smoothing window takes its trailing MAXIMUM (a maximum of the rest is
// a minimum of the surplus - conservative in both directions with one
// mechanism). That is right for NOISE and wrong for a transient WE cause: the
// grid meter follows a changed charging power within its own cadence while the
// station's MeterValues arrive on ITS cadence, so for one metering interval
// after every allocation INCREASE the pair `grid(new) - charging(old)` is wrong
// by exactly the step we just commanded. The trailing maximum then lets that
// one sample govern the lane for a whole BudgetSmoothWindow, the next decision
// takes the allocation back, and the loop settles in a staircase well below the
// surplus the site really has.
//
// Reproduced at the rig on 2026-09-01 (Verbrauchsmanagement v1 / P6, case
// L15b): a 22 kW station on a measured 22 kW surplus settled at 14 kW and
// stayed there. The fix is the PAIRING (csms.Connector.MeterInTransit): a
// sample that still describes the previous limit is treated like a missing one
// and the whole pair is dropped. This test is that mechanism without a rig -
// it feeds the tracker the two pairings and compares where the loop lands.

// pairingSite is the rig's L15b site: a 277 kW connection with nothing reserved
// for the building, so the SOURCE lane - not the physics - is what binds.
func pairingSite() Settings {
	return Settings{
		GridLimitKw: 277, HouseReserveKw: 0, MarginPct: 10,
		MinPowerKw: 5, RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 180,
	}.WithDefaults()
}

// runPairingLoop drives the REAL control loop for `seconds` and returns the
// allocation at every decision. dropMispaired = the fix: a grid sample taken
// while the station has not yet reported under its new limit is not a
// measurement of one moment, so it is dropped instead of paired.
//
// The site: the building EXPORTS 12 kW and the battery takes 10, so the whole
// measured surplus is 22 kW and one 22 kW station could take all of it.
func runPairingLoop(seconds int, dropMispaired bool) []float64 {
	const (
		houseKw      = -12.0 // negative = the site exports while nothing charges
		batteryKw    = 10.0
		meterLagSecs = 2 // the station's MeterValues cadence
		tickSecs     = 20 // ocppTickInterval
	)
	set := pairingSite()
	tr := NewBudgetTracker()
	start := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	simDraw := 0.0                 // what the station is REALLY drawing
	reported := make(map[int]float64) // second -> what the station had reported by then
	lastChange := -1                // second of the last allocation CHANGE
	var prev *Plan
	var out []float64

	for s := 0; s < seconds; s++ {
		now := start.Add(time.Duration(s) * time.Second)
		reported[s] = simDraw

		// --- the meter publishes every second, reading the station's own draw
		charging := reported[max0(s-meterLagSecs)]
		// The station has reported under its current limit as soon as its
		// newest sample was taken STRICTLY AFTER the last allocation change -
		// the exact test csms.Connector.MeterInTransit makes.
		settled := lastChange < 0 || s-meterLagSecs > lastChange
		if settled || !dropMispaired {
			tr.ObserveM(now, Measurement{
				GridKw: houseKw + simDraw, ChargingKw: charging, Complete: true,
				HaveBattery: true, BatteryChargeKw: batteryKw,
			})
		}

		// --- the executor decides every 20 s
		if s%tickSecs != 0 {
			continue
		}
		v := tr.Budget(now, set)
		sv := tr.Surplus(now, PolicySolarOnly, StorageBeforeCars)
		in := Input{
			Settings: set, Now: now, Previous: prev,
			Sessions: []Session{{
				Key: "A#1", MinKw: 5, MaxKw: 22, Since: start.Add(-time.Hour),
				BeforeStorage: true, Rank: 1,
			}},
		}
		if sv.Active {
			kw := minf(sv.Kw, v.Kw)
			in.SourceBudgetKw = &kw
			if sv.TotalKw != nil {
				above := minf(*sv.TotalKw, v.Kw)
				in.SourceBudgetAboveStorageKw = &above
			}
		}
		p := Decide(in)
		prev = &p
		got := 0.0
		if a, ok := p.Get("A#1"); ok {
			got = a.Kw
		}
		out = append(out, got)
		if got != simDraw {
			lastChange = s
		}
		simDraw = got
	}
	return out
}

func max0(i int) int {
	if i < 0 {
		return 0
	}
	return i
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// TestAMispairedSampleDrivesTheSourceLaneIntoAStaircase is the DEFECT, so the
// fix below is not a claim about a scenario nobody ever hits.
func TestAMispairedSampleDrivesTheSourceLaneIntoAStaircase(t *testing.T) {
	got := runPairingLoop(200, false)
	if len(got) < 5 {
		t.Fatalf("expected several decisions, got %v", got)
	}
	last := got[len(got)-1]
	if last > 21 {
		t.Fatalf("the mispaired loop was expected to settle BELOW the 22 kW surplus, got %v (%v)", last, got)
	}
	// And it is not a slow ramp: the very first decision already reaches the
	// full surplus, then the poisoned sample takes it away again.
	if got[0] < 21 {
		t.Fatalf("the first decision sees the true surplus: %v", got)
	}
}

// TestDroppingTheMispairedSampleLetsTheLoopSettleOnTheRealSurplus is the FIX:
// with the pairing rule the station reaches the measured surplus and STAYS
// there - the assertion the rig's L15b makes at the stations.
func TestDroppingTheMispairedSampleLetsTheLoopSettleOnTheRealSurplus(t *testing.T) {
	got := runPairingLoop(200, true)
	if len(got) < 5 {
		t.Fatalf("expected several decisions, got %v", got)
	}
	for i, kw := range got {
		if kw < 20.5 || kw > 23.5 {
			t.Fatalf("decision %d gave %v kW, want the measured 22 kW surplus (%v)", i, kw, got)
		}
	}
}
