package agent

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// THE START RAMP of a car that wakes up (Edge-Light-Pilot, 05.10.2026).
//
// PV 2.65 kW, house 0.6 kW, the battery takes the rest: 2.05 kW of surplus,
// cars before storage, „Nur Sonnenstrom", one go-e on one phase (minimum
// 1.38 kW). The box allocates 1.72 kW at 09:47:44, the go-e reports Charging at
// :45, the car draws from :52 and reaches 1.58 kW at :62. The inverter is read
// every 5 s; the go-e meters every 10 s, and what it reports trails the draw
// (0.75 kW at :59.5 while the car already drew 1.1 kW).
//
// Paired at telemetry cadence, the reading at :64.6 met the :59.5 sample: the
// surplus read 1.22 kW, under the minimum, the box paused the car, and the
// trailing maximum kept it paused for a minute. Eleven starts in fifteen
// minutes, each one a simulated unplugging and a contactor cycle. Late pairing
// keeps the surplus where it is.

const (
	rampPvKw    = 2.65
	rampHouseKw = 0.6
	rampMinKw   = 1.38
)

var rampBase = time.Date(2026, 10, 5, 7, 47, 0, 0, time.UTC)

func rampAt(sec float64) time.Time {
	return rampBase.Add(time.Duration(sec * float64(time.Second)))
}

// linear interpolates over (second, kW) points, flat outside them.
func linear(points [][2]float64, sec float64) float64 {
	if sec <= points[0][0] {
		return points[0][1]
	}
	for i := 1; i < len(points); i++ {
		if sec <= points[i][0] {
			a, b := points[i-1], points[i]
			return a[1] + (b[1]-a[1])*(sec-a[0])/(b[0]-a[0])
		}
	}
	return points[len(points)-1][1]
}

// What the car really drew - the grid meter sees it within its own cadence.
var rampCarKw = [][2]float64{{51, 0}, {55, 0.6}, {59.5, 1.1}, {62, 1.58}}

// The inverter lets the grid take the step for a few seconds before the
// battery backs off.
var rampImportKw = [][2]float64{{55, 0}, {63, 0.41}, {70, 0.41}, {78, 0}}

// What the go-e reported: sampled at x9.5, received 0.8 s later.
var rampGoe = []struct{ at, kw float64 }{
	{19.5, 0}, {29.5, 0}, {39.5, 0}, {49.5, 0}, {59.5, 0.75}, {69.5, 1.58}, {79.5, 1.58}, {89.5, 1.58}, {99.5, 1.58},
}

// rampSnapshot is the CSMS state at sec. stationSide=false is the box before
// this change: it did not notice that the station started on its own.
func rampSnapshot(sec float64, stationSide bool) csms.Snapshot {
	kw := func(v float64) *float64 { return &v }
	con := csms.Connector{ID: 1, Status: csms.StatusSuspendedEVSE, Session: &csms.Session{TransactionID: 5},
		CommandedKw: kw(0), CommandedChangedAt: rampAt(-30)}
	if sec >= 44 {
		con.Status, con.CommandedKw, con.CommandedChangedAt = csms.StatusSuspendedEV, kw(1.72), rampAt(44)
	}
	if sec >= 45 {
		con.Status = csms.StatusCharging
		if stationSide {
			con.DrawChangedAt = rampAt(45)
		}
	}
	for _, s := range rampGoe {
		if s.at+0.8 > sec {
			break
		}
		con.PrevPowerKw, con.PrevMeteredAt = con.PowerKw, con.MeteredAt
		con.PowerKw, con.MeteredAt = kw(s.kw), rampAt(s.at)
	}
	return csms.Snapshot{Chargers: []csms.ChargerState{{Charger: csms.Charger{ID: "goe-300808"}, Connected: true,
		Connectors: []csms.Connector{con}}}}
}

func rampReading(sec float64) gridReading {
	car, imp := linear(rampCarKw, sec), linear(rampImportKw, sec)
	batt := rampPvKw - rampHouseKw - car + imp
	return gridReading{at: rampAt(sec), gridKw: imp, battKw: &batt}
}

// runRamp feeds the inverter readings from :24.6 to :99.6 and returns the
// surplus the lane offered after each one.
func runRamp(t *testing.T, latePairing bool) []lastmgmt.SurplusVerdict {
	t.Helper()
	tr := lastmgmt.NewBudgetTracker()
	var p gridPairer
	var out []lastmgmt.SurplusVerdict
	for sec := 24.6; sec < 100; sec += 5 {
		r := rampReading(sec)
		if latePairing {
			at, m := p.pair(r, rampSnapshot(sec, true))
			tr.ObserveM(at, m)
		} else {
			charging, complete := rampSnapshot(sec, false).ChargingTotal(r.at, ocppMeterMaxAge)
			tr.ObserveM(r.at, r.measurement(charging, complete))
		}
		out = append(out, tr.Surplus(r.at, lastmgmt.PolicySolarOnly, lastmgmt.CarsBeforeStorage))
	}
	return out
}

func minSurplus(t *testing.T, verdicts []lastmgmt.SurplusVerdict) float64 {
	t.Helper()
	low := math.Inf(1)
	for i, v := range verdicts {
		if !v.Active || v.Blind || v.Mode != lastmgmt.SurplusMeasured {
			t.Fatalf("reading %d: the lane must stay measured, got %+v", i, v)
		}
		low = math.Min(low, v.Kw)
	}
	return low
}

func TestTheFieldRampReproducesThePauseWithoutLatePairing(t *testing.T) {
	if low := minSurplus(t, runRamp(t, false)); low >= rampMinKw {
		t.Fatalf("the replay must reproduce the field defect: lowest surplus %.2f kW", low)
	}
}

func TestLatePairingKeepsTheCarChargingThroughItsStartRamp(t *testing.T) {
	low := minSurplus(t, runRamp(t, true))
	if low < rampMinKw {
		t.Fatalf("the surplus fell to %.2f kW during the ramp, under the %.2f kW minimum", low, rampMinKw)
	}
	// The pairs are not exact: the go-e's 0.75 kW trailed the car's 1.1 kW. But
	// the error is that trail, never a whole cadence of ramp.
	if low < (rampPvKw-rampHouseKw)-0.4 {
		t.Fatalf("lowest surplus %.2f kW, more than the trail below %.2f kW", low, rampPvKw-rampHouseKw)
	}
}

func TestALateSampleIsPairedOnceWithItsNearestReading(t *testing.T) {
	var p gridPairer
	snap := rampSnapshot(65, true) // newest sample :59.5 (0.75 kW), settling
	for _, sec := range []float64{54.6, 59.6} {
		p.pair(rampReading(sec), rampSnapshot(sec, true))
	}
	at, m := p.pair(rampReading(64.6), snap)
	if !m.Complete || !at.Equal(rampAt(59.6)) || m.ChargingKw != 0.75 {
		t.Fatalf("the :59.5 sample pairs with the :59.6 reading: at=%v %+v", at, m)
	}
	if at, m := p.pair(rampReading(64.7), snap); m.Complete {
		t.Fatalf("a sample is paired once, not again at %v", at)
	}
}

// A reading within the window after the settling sample IS its moment - every
// such reading counts, so a building load step right after it is seen at once.
func TestAReadingOfTheSampleMomentPairsDirectly(t *testing.T) {
	var p gridPairer
	snap := rampSnapshot(61, true) // newest sample :59.5, settling
	for _, sec := range []float64{61.0, 62.0} {
		r := rampReading(sec)
		if sec == 62.0 {
			r.gridKw += 30 // a machine switches on
		}
		at, m := p.pair(r, snap)
		if !m.Complete || !at.Equal(rampAt(sec)) || m.GridKw != r.gridKw {
			t.Fatalf("the reading at :%v belongs to the :59.5 sample: at=%v %+v", sec, at, m)
		}
	}
}

func TestASettlingSampleWithoutANearbyReadingIsNotPaired(t *testing.T) {
	var p gridPairer
	// The only reading near :59.5 is missing (a slow inverter read).
	at, m := p.pair(rampReading(64.6), rampSnapshot(64.6, true))
	if m.Complete {
		t.Fatalf("a reading 5 s after the sample is not its moment: at=%v %+v", at, m)
	}
	if !at.Equal(rampAt(64.6)) {
		t.Fatalf("an incomplete reading is reported at its own time, got %v", at)
	}
}
