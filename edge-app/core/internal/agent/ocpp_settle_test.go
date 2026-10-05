package agent

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// THE START RAMP of a car that wakes up, replayed from the Edge-Light-Pilot
// (05.10.2026, go-e on one phase, „Nur Sonnenstrom", cars before storage,
// single-phase minimum 1.38 kW). The inverter is read every 5 s, the go-e
// meters every 10 s, and what it reports trails the draw even at its own
// timestamp.
//
// Paired anyway, a reading during the ramp subtracts too little charging
// power, the surplus reads under the minimum, the box pauses the car and the
// trailing maximum keeps it paused for a minute. While the draw settles the
// box therefore forms no pair at all and the source lane holds.

const rampMinKw = 1.38

type goeSample struct{ at, kw float64 }

// rampCase is one field ramp, in seconds after base.
type rampCase struct {
	name       string
	base       time.Time
	pvKw       float64
	houseKw    float64
	carKw      [][2]float64 // what the car really drew
	importKw   [][2]float64 // the grid taking the step until the battery backs off
	goe        []goeSample  // what the go-e reported (received 0.8 s later)
	drawChange [][2]float64 // second, 1 = Charging / 0 = not drawing
	commands   [][2]float64 // second, kW: the box's limit from then on
	firstRead  float64
	lastRead   float64
}

// 09:47: the box allocates 1.72 kW at :44, the go-e reports Charging at :45,
// the car draws from :51 and reaches 1.58 kW at :62.
var morningRamp = rampCase{
	name: "09:47", base: time.Date(2026, 10, 5, 7, 47, 0, 0, time.UTC),
	pvKw: 2.65, houseKw: 0.6,
	carKw:      [][2]float64{{51, 0}, {55, 0.6}, {59.5, 1.1}, {62, 1.58}},
	importKw:   [][2]float64{{55, 0}, {63, 0.41}, {70, 0.41}, {78, 0}},
	goe:        []goeSample{{19.5, 0}, {29.5, 0}, {39.5, 0}, {49.5, 0}, {59.5, 0.75}, {69.5, 1.58}, {79.5, 1.58}, {89.5, 1.58}, {99.5, 1.58}},
	drawChange: [][2]float64{{45, 1}},
	commands:   [][2]float64{{-30, 0}, {44, 1.72}},
	firstRead:  24.6, lastRead: 100,
}

// 11:03: after a pause of the go-e's own, it reports Charging at :45; the go-e
// samples −0.01 and 0.15 kW (two samples 0.16 kW apart - a car that has NOT
// started) and 1.99 kW only at :66, while the car already drew 1.3 kW at :61.
var restartRamp = rampCase{
	name: "11:03", base: time.Date(2026, 10, 5, 9, 3, 0, 0, time.UTC),
	pvKw: 3.10, houseKw: 0.85,
	carKw:      [][2]float64{{50, 0}, {61, 1.3}, {64, 2.0}, {66, 2.2}},
	importKw:   [][2]float64{{55, 0}, {61, 0.63}, {66, -0.13}, {75, 0}},
	goe:        []goeSample{{6.5, 0}, {16.5, 0}, {26.5, 0}, {36.5, 0}, {46.5, -0.01}, {56.5, 0.15}, {66.5, 1.99}, {76.5, 2.18}, {86.5, 2.2}, {96.5, 2.2}},
	drawChange: [][2]float64{{-3, 0}, {45, 1}},
	commands:   [][2]float64{{-30, 0}, {35, 2.31}, {46, 2.22}},
	firstRead:  20.6, lastRead: 100,
}

func (rc rampCase) at(sec float64) time.Time {
	return rc.base.Add(time.Duration(sec * float64(time.Second)))
}

// linear interpolates over (second, value) points, flat outside them.
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

// snapshot is the CSMS state at sec. stationSide=false is the box before the
// fix: it did not notice the station starting on its own.
func (rc rampCase) snapshot(sec float64, stationSide bool) csms.Snapshot {
	kw := func(v float64) *float64 { return &v }
	con := csms.Connector{ID: 1, Status: csms.StatusSuspendedEVSE, Session: &csms.Session{TransactionID: 5}}
	for _, c := range rc.commands {
		if c[0] <= sec {
			con.CommandedKw, con.CommandedChangedAt = kw(c[1]), rc.at(c[0])
		}
	}
	for _, d := range rc.drawChange {
		if d[0] > sec {
			break
		}
		if d[1] == 1 {
			con.Status = csms.StatusCharging
		} else {
			con.Status = csms.StatusSuspendedEVSE
		}
		if stationSide {
			con.DrawChangedAt = rc.at(d[0])
		}
	}
	for _, s := range rc.goe {
		if s.at+0.8 > sec {
			break
		}
		con.PrevPowerKw, con.PrevMeteredAt = con.PowerKw, con.MeteredAt
		con.PowerKw, con.MeteredAt = kw(s.kw), rc.at(s.at)
	}
	return csms.Snapshot{Chargers: []csms.ChargerState{{Charger: csms.Charger{ID: "goe-300808"}, Connected: true,
		Connectors: []csms.Connector{con}}}}
}

// run feeds the inverter readings and returns the surplus the lane offered
// after each one.
func (rc rampCase) run(stationSide bool) []lastmgmt.SurplusVerdict {
	tr := lastmgmt.NewBudgetTracker()
	var out []lastmgmt.SurplusVerdict
	for sec := rc.firstRead; sec < rc.lastRead; sec += 5 {
		car, imp := linear(rc.carKw, sec), linear(rc.importKw, sec)
		batt := rc.pvKw - rc.houseKw - car + imp
		ts := rc.at(sec)
		tr.ObserveM(ts, ocppMeasurement(rc.snapshot(sec, stationSide), ts, imp, 0, &batt))
		out = append(out, tr.Surplus(ts, lastmgmt.PolicySolarOnly, lastmgmt.CarsBeforeStorage))
	}
	return out
}

func lowestMeasured(t *testing.T, name string, verdicts []lastmgmt.SurplusVerdict) float64 {
	t.Helper()
	low := math.Inf(1)
	for i, v := range verdicts {
		if !v.Active || v.Blind || v.Mode != lastmgmt.SurplusMeasured {
			t.Fatalf("%s, reading %d: the lane must stay measured, got %+v", name, i, v)
		}
		low = math.Min(low, v.Kw)
	}
	return low
}

func TestTheFieldRampsReproduceThePauseWithoutTheSettleRule(t *testing.T) {
	for _, rc := range []rampCase{morningRamp, restartRamp} {
		if low := lowestMeasured(t, rc.name, rc.run(false)); low >= rampMinKw {
			t.Errorf("%s: the replay must reproduce the field defect, lowest surplus %.2f kW", rc.name, low)
		}
	}
}

func TestTheSourceLaneHoldsThroughAStartRamp(t *testing.T) {
	for _, rc := range []rampCase{morningRamp, restartRamp} {
		truth := rc.pvKw - rc.houseKw
		low := lowestMeasured(t, rc.name, rc.run(true))
		if low < rampMinKw {
			t.Errorf("%s: the surplus fell to %.2f kW during the ramp, under the %.2f kW minimum", rc.name, low, rampMinKw)
		}
		// Held, not guessed: what the lane offers is the surplus measured
		// before and after the ramp - the go-e's own trail is the only error.
		if low < truth-0.1 {
			t.Errorf("%s: lowest surplus %.2f kW, the site had %.2f kW", rc.name, low, truth)
		}
	}
}

// The hold is bounded: a charge point that never settles cannot keep a
// surplus alive for longer than SurplusSettleHold.
func TestTheSettleHoldEnds(t *testing.T) {
	tr := lastmgmt.NewBudgetTracker()
	t0 := time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)
	batt := 2.0
	tr.ObserveM(t0, lastmgmt.Measurement{GridKw: 0, BatteryKw: batt, HaveBattery: true, Complete: true})
	for s := 5; s <= 70; s += 5 {
		ts := t0.Add(time.Duration(s) * time.Second)
		tr.ObserveM(ts, lastmgmt.Measurement{GridKw: 0, BatteryKw: batt, HaveBattery: true, Settling: true})
		v := tr.Surplus(ts, lastmgmt.PolicySolarOnly, lastmgmt.CarsBeforeStorage)
		held := time.Duration(s)*time.Second <= lastmgmt.SurplusSettleHold
		if held && (v.Blind || v.Kw != 2.0) {
			t.Fatalf("after %d s the lane must still hold 2.0 kW: %+v", s, v)
		}
		if !held && (!v.Blind || v.Kw != 0) {
			t.Fatalf("after %d s the hold must have ended: %+v", s, v)
		}
	}
}
