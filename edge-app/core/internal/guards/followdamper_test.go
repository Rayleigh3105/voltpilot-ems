package guards

import (
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
)

var dampT0 = time.Date(2026, 9, 24, 15, 15, 0, 0, time.UTC)

func dampAt(s float64) time.Time { return dampT0.Add(time.Duration(s * float64(time.Second))) }

func deyeProfile() DampProfile { return DampProfileFor(deyeRemote) }

var deyeRemote = controlprofile.Device{Brand: "deye", Model: "sun-30k-sg01hp3", Family: "hybrid_3p", ControlPath: "remote"}

func surplusReading(pv, load float64) Reading {
	return Reading{SocPct: 40, PvKw: pv, LoadKw: load, GridLimitKw: Unknown()}
}

func TestDampProfileFor(t *testing.T) {
	if !DampProfileFor(controlprofile.Device{ControlPath: "remote"}).Off {
		t.Error("no inverter selected: nothing is written, the damper must be off")
	}
	tou := controlprofile.Device{Brand: "deye", Family: "hybrid_3p", ControlPath: DampControlPathPersistent}
	if !DampProfileFor(tou).Off {
		t.Error("the Deye ToU surface is a persistent lever: no box regulation to damp")
	}
	p := DampProfileFor(deyeRemote)
	if p.Off || p.Settle != 15*time.Second || p.MaxCadence != 25*time.Second {
		t.Errorf("Deye remote profile: %+v, want the Herzogau measurement (15 s settle, 25 s cadence)", p)
	}
	if prof, ok := controlprofile.For(deyeRemote); !ok || prof.ID != "deye_hp3_remote" || p != dampProfileFrom(prof, ok) {
		t.Errorf("the Deye remote timing must come from its control profile: %+v %v", prof, ok)
	}
	if d := DampProfileFor(controlprofile.Device{Brand: "kostal", Family: "kostal_plenticore"}); d != DefaultDampProfile() {
		t.Errorf("a profile without measured timing gets the Vorgabe: %+v", d)
	}
	if d := DampProfileFor(controlprofile.Device{Brand: "deye", Family: "hybrid_3p"}); d != DefaultDampProfile() {
		t.Errorf("no profile (older Layer 1 without a control path) gets the Vorgabe: %+v", d)
	}
	if p.RampKw != 3 || p.ReserveKw != 0.5 || p.DeadbandKw != 0.2 {
		t.Errorf("shaping: %+v, want ramp 3 kW, reserve 0.5 kW, deadband 0.2 kW (concept §6.5)", p)
	}
}

// TestDampProfileFromReadsTheProfile pins the mapping with values no Vorgabe
// has: the timing is the profile's, per value; the shaping stays the box's.
func TestDampProfileFromReadsTheProfile(t *testing.T) {
	yes, no := true, false
	settle, cadence := 7.5, 4.0
	p := dampProfileFrom(controlprofile.Profile{Damping: controlprofile.Damping{BoxRegulates: &yes, SettleS: &settle, CadenceS: &cadence}}, true)
	if p.Off || p.Settle != 7500*time.Millisecond || p.MaxCadence != 4*time.Second || p.RampKw != 3 {
		t.Errorf("profile timing: %+v", p)
	}
	p = dampProfileFrom(controlprofile.Profile{Damping: controlprofile.Damping{SettleS: &settle}}, true)
	if p.Settle != 7500*time.Millisecond || p.MaxCadence != DefaultDampProfile().MaxCadence {
		t.Errorf("a missing value keeps the Vorgabe: %+v", p)
	}
	if !dampProfileFrom(controlprofile.Profile{Damping: controlprofile.Damping{BoxRegulates: &no}}, true).Off {
		t.Error("a profile that forbids box regulation turns the damper off")
	}
	if dampProfileFrom(controlprofile.Profile{}, false) != DefaultDampProfile() {
		t.Error("no profile: the Vorgabe")
	}
}

// The gate hands out a new pair only once both halves were refreshed after the
// last write had settled.
func TestFollowDamperGateWaitsForASettledPair(t *testing.T) {
	d, p := NewFollowDamper(), deyeProfile()
	r := surplusReading(30, 5)

	d.Observe(dampAt(0), 1.0, 20.0)
	if _, pair := d.Gate(dampAt(1), p, r, dampAt(0)); pair != DampPairSettled {
		t.Fatalf("no write yet: the first pair is usable, got %v", pair)
	}
	d.Commit(dampAt(1), 24) // a raise

	// 5 s after the write: both halves new, but the device has not followed.
	d.Observe(dampAt(6), -2.0, 21.0)
	if c, pair := d.Gate(dampAt(7), p, surplusReading(31, 5), dampAt(6)); pair != DampPairNone || c.PvKw != 30 {
		t.Fatalf("unsettled pair after a raise: got %v with pv %.1f, want the held control reading", pair, c.PvKw)
	}
	// 16 s after the write only the GRID half refreshed: still a half pair.
	d.Observe(dampAt(17), -3.0, 21.0)
	if _, pair := d.Gate(dampAt(18), p, r, dampAt(17)); pair != DampPairNone {
		t.Fatalf("grid refreshed, battery not: a half pair must wait, got %v", pair)
	}
	// The battery half follows 5 s later: the pair is complete and settled.
	d.Observe(dampAt(22), -3.0, 23.5)
	c, pair := d.Gate(dampAt(23), p, surplusReading(32, 5), dampAt(22))
	if pair != DampPairSettled || c.PvKw != 32 || c.LoadKw != 5 {
		t.Fatalf("complete settled pair: got %v, reading %+v", pair, c)
	}
	// The same pair is used once.
	if _, pair := d.Gate(dampAt(33), p, r, dampAt(22)); pair != DampPairNone {
		t.Fatalf("a consumed pair must not step again, got %v", pair)
	}
	// SoC and grid limit stay live in the control reading.
	live := surplusReading(40, 5)
	live.SocPct, live.GridLimitKw = 55, 11
	if c, _ := d.Gate(dampAt(34), p, live, dampAt(22)); c.SocPct != 55 || c.GridLimitKw != 11 || c.PvKw != 32 {
		t.Fatalf("control reading must hold only pv/load: %+v", c)
	}
}

// A battery resting at exactly the same value must not stall the gate: after
// MaxCadence an unchanged half counts as re-measured.
func TestFollowDamperGateUnchangedHalfCountsAfterTheCadence(t *testing.T) {
	d, p := NewFollowDamper(), deyeProfile()
	r := surplusReading(10, 5)
	d.Observe(dampAt(0), -5.0, 0.0)
	d.Gate(dampAt(0), p, r, dampAt(0))
	d.Commit(dampAt(0), 0.5)
	d.Observe(dampAt(20), -4.0, 0.0) // grid changed, battery still 0
	if _, pair := d.Gate(dampAt(20), p, r, dampAt(20)); pair != DampPairNone {
		t.Fatalf("battery unchanged for 20 s < cadence: wait, got %v", pair)
	}
	d.Observe(dampAt(40), -4.1, 0.0)
	if _, pair := d.Gate(dampAt(40), p, r, dampAt(40)); pair != DampPairSettled {
		t.Fatalf("battery unchanged for 40 s > 25 s cadence: re-measured, got %v", pair)
	}
}

// Writes the damper did not cause must not freeze the control reading forever.
func TestFollowDamperGateTakesTheNewestPairWhenOtherWritesKeepTheClockRunning(t *testing.T) {
	d, p := NewFollowDamper(), deyeProfile()
	// (The meter stays on the cheap side of the charge - export - throughout:
	// this is about the settle clock alone, not about the costly verdict.)
	d.Observe(dampAt(0), -1.0, 10.0)
	d.Gate(dampAt(0), p, surplusReading(20, 5), dampAt(0))
	for s := 0.0; s < 80; s += 10 {
		d.Commit(dampAt(s), 10+s/10) // e.g. the peak guard moving the final value
		d.Observe(dampAt(s+5), -1.0-s/100, 10.0+s/100)
		if _, pair := d.Gate(dampAt(s+5), p, surplusReading(20, 5), dampAt(s+5)); pair != DampPairNone {
			t.Fatalf("t=%.0f: unsettled pair taken early (%v)", s+5, pair)
		}
	}
	d.Observe(dampAt(85), -2.0, 11.0)
	if c, pair := d.Gate(dampAt(85), p, surplusReading(21, 5), dampAt(85)); pair != DampPairSettled || c.PvKw != 21 {
		t.Fatalf("after 2x(settle+cadence) the newest pair must be taken: %v %+v", pair, c)
	}
}

// After a RETREAT write an unsettled pair may retreat further - but only when
// its grid half is at least as new as its battery half.
func TestFollowDamperGateRetreatPairOnlyWithANewGridHalf(t *testing.T) {
	p := deyeProfile()
	setup := func() *FollowDamper {
		d := NewFollowDamper()
		d.Observe(dampAt(0), -1.0, 24.0)
		d.Gate(dampAt(0), p, surplusReading(30, 5), dampAt(0))
		d.Commit(dampAt(0), 24)
		d.Commit(dampAt(10), 18) // a retreat
		return d
	}
	d := setup()
	d.Observe(dampAt(14), 6.0, 23.0) // both halves in one sample
	if _, pair := d.Gate(dampAt(15), p, surplusReading(22, 5), dampAt(14)); pair != DampPairRetreat {
		t.Fatalf("consistent pair after a retreat: want a retreat pair, got %v", pair)
	}
	d = setup()
	d.Observe(dampAt(12), 6.0, 24.0) // grid first ...
	d.Observe(dampAt(17), 6.0, 21.0) // ... battery newer: errs toward retreating too far
	if _, pair := d.Gate(dampAt(18), p, surplusReading(22, 5), dampAt(17)); pair != DampPairNone {
		t.Fatalf("battery half newer than grid half after a retreat: must wait, got %v", pair)
	}
	// After a RAISE no unsettled PAIR is used: the control reading waits. (What
	// the grid half alone may do there is TestFollowDamperGateCostlyAtTheMeter.)
	d = NewFollowDamper()
	d.Observe(dampAt(0), -1.0, 18.0)
	d.Gate(dampAt(0), p, surplusReading(30, 5), dampAt(0))
	d.Commit(dampAt(0), 18)
	d.Commit(dampAt(10), 21)
	d.Observe(dampAt(14), -2.0, 19.0)
	if c, pair := d.Gate(dampAt(15), p, surplusReading(22, 5), dampAt(14)); pair != DampPairNone || c.PvKw != 30 {
		t.Fatalf("after a raise an unsettled pair must wait, got %v with pv %.1f", pair, c.PvKw)
	}
}

// dischargeRaised is a discharge the box just deepened: -0.5 kW settled, then
// raised to -2 kW at t=10 for a consumer the control reading shows (PV 4, house
// 6.5). The meter still imports and the battery delivers 0.5 kW.
func dischargeRaised(p DampProfile) *FollowDamper {
	d := NewFollowDamper()
	d.Observe(dampAt(0), 2.0, -0.5)
	d.Gate(dampAt(0), p, surplusReading(4, 6.5), dampAt(0))
	d.Commit(dampAt(0), -0.5)
	d.Commit(dampAt(10), -2) // a raise of the discharge
	return d
}

// EXPORT BEATS THE SETTLE TIME (E2 A, 2026-10-10): after a write that RAISED the
// command, a grid half refreshed since shows the side the correction is bounded
// against - export while discharging. That takes the command back with this
// tick; the pair as such is still not used and the control reading does not
// move.
func TestFollowDamperGateCostlyAtTheMeter(t *testing.T) {
	p := deyeProfile()

	// The consumer ended 5 s after the write: 1.2 kW leave through the meter,
	// the battery (same sample) delivers 1.4 kW by now.
	d := dischargeRaised(p)
	d.Observe(dampAt(15), -1.2, -1.4)
	c, pair := d.Gate(dampAt(16), p, surplusReading(4, 4.2), dampAt(15))
	if pair != DampPairCostly {
		t.Fatalf("export 5 s after a deepened discharge: want the costly verdict, got %v", pair)
	}
	if c.PvKw != 4 || c.LoadKw != 6.5 {
		t.Fatalf("the control reading must not move on a grid half alone: %+v", c)
	}
	// One grid refresh takes back once: the next tick on the same value waits.
	if _, pair := d.Gate(dampAt(26), p, surplusReading(4, 4.2), dampAt(15)); pair != DampPairNone {
		t.Fatalf("a grid value already used must not take back twice, got %v", pair)
	}

	refusals := map[string]func(d *FollowDamper){
		// The cheap side: the meter still imports - the raise has not arrived
		// yet or the consumer still runs. Nothing to take back.
		"import while discharging": func(d *FollowDamper) { d.Observe(dampAt(15), 0.8, -1.4) },
		// Meter noise is not export.
		"export inside the deadband": func(d *FollowDamper) { d.Observe(dampAt(15), -0.2, -1.4) },
		// A grid value from before the write says nothing about it.
		"no grid refresh since the write": func(d *FollowDamper) { d.Observe(dampAt(15), 2.0, -1.4) },
		// A battery beyond its command is an older, deeper command still
		// running out: export then proves nothing about the new one.
		"battery beyond the command": func(d *FollowDamper) { d.Observe(dampAt(15), -1.2, -2.6) },
	}
	for name, observe := range refusals {
		d := dischargeRaised(p)
		observe(d)
		if _, pair := d.Gate(dampAt(16), p, surplusReading(4, 4.2), dampAt(15)); pair != DampPairNone {
			t.Fatalf("%s: must wait for a settled pair, got %v", name, pair)
		}
	}

	// After a RETREAT the battery comes DOWN toward the command: export at the
	// meter may be the old level running out. Only the first exception applies
	// there, and it wants a pair whose grid half is not older than its battery
	// half.
	d = NewFollowDamper()
	d.Observe(dampAt(0), 0.5, -3.0)
	d.Gate(dampAt(0), p, surplusReading(4, 7.5), dampAt(0))
	d.Commit(dampAt(0), -3)
	d.Commit(dampAt(10), -2) // a retreat
	d.Observe(dampAt(12), -1.0, -3.0)
	d.Observe(dampAt(15), -1.0, -2.6) // the battery half is the newer one
	if _, pair := d.Gate(dampAt(16), p, surplusReading(4, 5.6), dampAt(15)); pair != DampPairNone {
		t.Fatalf("export after a retreat with a newer battery half: wait, got %v", pair)
	}

	// Without a write, without a battery half and with the damper off there is
	// nothing to judge.
	d = NewFollowDamper()
	d.Observe(dampAt(0), -1.2, -1.4)
	d.Gate(dampAt(0), p, surplusReading(4, 4.2), dampAt(0))
	d.Observe(dampAt(5), -1.3, -1.4)
	if _, pair := d.Gate(dampAt(40), p, surplusReading(4, 4.2), dampAt(5)); pair == DampPairCostly {
		t.Fatal("no write: nothing was raised")
	}
	d = NewFollowDamper()
	d.Observe(dampAt(0), 2.0, math.NaN())
	d.Gate(dampAt(0), p, surplusReading(4, 6.5), dampAt(0))
	d.Commit(dampAt(10), -2)
	d.Observe(dampAt(15), -1.2, math.NaN())
	if _, pair := d.Gate(dampAt(16), p, surplusReading(4, 4.2), dampAt(15)); pair != DampPairNone {
		t.Fatalf("no battery half ever seen: nothing to measure the command against, got %v", pair)
	}
	d = dischargeRaised(p)
	d.Observe(dampAt(15), -1.2, -1.4)
	if _, pair := d.Gate(dampAt(16), DampProfile{Off: true}, surplusReading(4, 4.2), dampAt(15)); pair != DampPairNone {
		t.Fatalf("off: nothing is shaped, got %v", pair)
	}
}

// The charge side, mirrored: after a raised charge the meter shows IMPORT - the
// battery is being charged from the grid (the EEG-sensitive side).
func TestFollowDamperGateCostlyAtTheMeterChargeSide(t *testing.T) {
	p := deyeProfile()
	d := NewFollowDamper()
	d.Observe(dampAt(0), -1.0, 18.0)
	d.Gate(dampAt(0), p, surplusReading(30, 5), dampAt(0))
	d.Commit(dampAt(0), 18)
	d.Commit(dampAt(10), 21) // a raise of the charge
	d.Observe(dampAt(14), 2.0, 19.0)
	c, pair := d.Gate(dampAt(15), p, surplusReading(22, 5), dampAt(14))
	if pair != DampPairCostly || c.PvKw != 30 {
		t.Fatalf("import 4 s after a raised charge: want the costly verdict on the held reading, got %v pv %.1f", pair, c.PvKw)
	}
	// 19 kW delivered, 2 kW of it bought: the surplus is 17 kW. A trimmed plan
	// charge of 30 kW goes back to 16.5 kW (surplus - reserve) with this tick,
	// although the control reading still shows 25 kW of surplus.
	if kw, _ := d.Shape(p, 30, 25, true, pair, c); kw != 16.5 {
		t.Fatalf("import 2 kW at 19 kW delivered: %.3f, want 16.5 at once", kw)
	}
	// The cheap side - export after a raised charge - waits like before.
	d = NewFollowDamper()
	d.Observe(dampAt(0), -1.0, 18.0)
	d.Gate(dampAt(0), p, surplusReading(30, 5), dampAt(0))
	d.Commit(dampAt(0), 18)
	d.Commit(dampAt(10), 21)
	d.Observe(dampAt(14), -3.0, 19.0)
	if _, pair := d.Gate(dampAt(15), p, surplusReading(27, 5), dampAt(14)); pair != DampPairNone {
		t.Fatalf("export after a raised charge is the cheap side: wait, got %v", pair)
	}
}

// Shape takes the command back to what the battery delivered, minus the excess
// at the meter, minus the reserve - at once, never upward, and never past the
// correction's own bounds.
func TestFollowDamperShapeCostlyTakesTheCommandBackAtOnce(t *testing.T) {
	p := deyeProfile()
	ctl := surplusReading(4, 6.5) // the control reading still shows the consumer

	// The level engaged at -2 kW (deficit 2.5 - reserve).
	engage := func() *FollowDamper {
		d := dischargeRaised(p)
		if kw, _ := d.Shape(p, 0, -2.5, true, DampPairNone, ctl); kw != -2 {
			t.Fatalf("setup: the discharge stands at %.3f, want -2", kw)
		}
		return d
	}

	// Battery half as new as the grid half: delivered 1.4, exported 1.2 - the
	// house needs 0.2 kW, minus the reserve that is rest.
	d := engage()
	d.Observe(dampAt(15), -1.2, -1.4)
	_, pair := d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, shaped := d.Shape(p, 0, -2.5, true, pair, ctl); !shaped || kw != 0 {
		t.Fatalf("export 1.2 kW at 1.4 kW delivered: %.3f, want 0 at once", kw)
	}

	// A larger remaining deficit: delivered 2.0, exported 0.4 -> house 1.6,
	// minus the reserve 1.1.
	d = engage()
	d.Observe(dampAt(15), -0.4, -2.0)
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, 0, -2.5, true, pair, ctl); math.Abs(kw+1.1) > 1e-9 {
		t.Fatalf("export 0.4 kW at 2.0 kW delivered: %.3f, want -1.1 (house 1.6 - reserve)", kw)
	}

	// The battery has not moved yet (still at 0.5 kW from before the write) and
	// the PV surplus alone leaves through the meter: nothing may be discharged.
	d = engage()
	d.Observe(dampAt(15), -0.8, -0.5)
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, 0, -2.5, true, pair, ctl); kw != 0 {
		t.Fatalf("export before the battery even followed: %.3f, want 0", kw)
	}

	// A battery still on the CHARGE side counts as delivering nothing.
	d = engage()
	d.Observe(dampAt(15), -1.5, 0.6)
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, 0, -2.5, true, pair, ctl); kw != 0 {
		t.Fatalf("export while the battery still charges: %.3f, want 0", kw)
	}

	// Never upward: a costly verdict whose level lies above the held one holds.
	d = engage()
	d.Observe(dampAt(15), -0.3, -2.0) // house 1.7 -> 1.2 after the reserve
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, 0, -1.0, true, pair, surplusReading(4, 5)); kw != -1 {
		// (the corrections meanwhile propose -1.0: the bound hi is 1.0)
		t.Fatalf("the level is clamped to the corrections' own interval: %.3f, want -1", kw)
	}

	// Never below a command a RAISING correction raises: the plan itself
	// discharges 1.5 kW, the deepen added the rest - only the rest goes.
	d = NewFollowDamper()
	d.Observe(dampAt(0), 1.0, -1.5)
	d.Gate(dampAt(0), p, ctl, dampAt(0))
	d.Commit(dampAt(0), -1.5)
	if kw, _ := d.Shape(p, -1.5, -2.5, true, DampPairNone, ctl); kw != -2 {
		t.Fatalf("setup: %.3f", kw)
	}
	d.Commit(dampAt(10), -2)
	d.Observe(dampAt(15), -1.2, -1.9)
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, -1.5, -2.5, true, pair, ctl); kw != -1.5 {
		t.Fatalf("the plan's own 1.5 kW discharge is not the damper's to cut: %.3f, want -1.5", kw)
	}

	// The other side's verdict is not this correction's: a costly verdict about
	// a discharge never shapes a charge.
	d = engage()
	d.Observe(dampAt(15), -1.2, -1.4)
	_, pair = d.Gate(dampAt(16), p, ctl, dampAt(15))
	if kw, _ := d.Shape(p, 5, 3, true, pair, surplusReading(8, 4)); kw != 3 {
		t.Fatalf("a discharge verdict on a charge-side correction: %.3f, want the trim's own 3", kw)
	}
}

func TestFollowDamperGateGoesBlindWithTheReading(t *testing.T) {
	d, p := NewFollowDamper(), deyeProfile()
	d.Observe(dampAt(0), 1.0, 10.0)
	d.Gate(dampAt(0), p, surplusReading(20, 5), dampAt(0))
	d.Commit(dampAt(0), 10)
	if c, _ := d.Gate(dampAt(5), p, surplusReading(math.NaN(), 5), dampAt(5)); known(c.PvKw) {
		t.Fatal("unknown pv must pass through as unknown")
	}
	d.Observe(dampAt(6), 1.5, 10.5)
	if c, pair := d.Gate(dampAt(7), p, surplusReading(20, 5), dampAt(6)); known(c.PvKw) || known(c.LoadKw) || pair != DampPairNone {
		t.Fatalf("after going blind only a SETTLED pair may restore the control reading: %v %+v", pair, c)
	}
}

func TestFollowDamperOffPassesThrough(t *testing.T) {
	d, off := NewFollowDamper(), DampProfile{Off: true}
	r := surplusReading(30, 5)
	d.Commit(dampAt(0), 10)
	if c, pair := d.Gate(dampAt(1), off, r, dampAt(1)); c.PvKw != r.PvKw || c.LoadKw != r.LoadKw || pair != DampPairNone {
		t.Fatalf("off: the live reading passes, got %+v %v", c, pair)
	}
	if kw, shaped := d.Shape(off, 16.784, 25, true, DampPairSettled, r); shaped || kw != 25 {
		t.Fatalf("off: the correction passes unchanged, got %.3f shaped=%v", kw, shaped)
	}
}

// Charge side: lowering at once onto surplus - reserve, raising in ramps.
func TestFollowDamperShapeChargeSide(t *testing.T) {
	p := deyeProfile()

	// TRIM: plan 22 kW, surplus 12 kW - buying is the expensive side.
	d := NewFollowDamper()
	if kw, _ := d.Shape(p, 22, 12, true, DampPairNone, surplusReading(20, 8)); kw != 11.5 {
		t.Fatalf("trim starts: %.3f, want 11.5 at once (12 kW surplus - 0.5 reserve)", kw)
	}

	// ABSORPTION: plan 16.784, surplus 25 - selling is the cheap side.
	d = NewFollowDamper()
	r := surplusReading(30, 5)
	want := []float64{19.784, 22.784, 24.5, 24.5}
	for i, w := range want {
		pair := DampPairSettled
		if i == 0 {
			pair = DampPairNone // the first engagement steps on its own
		}
		if kw, _ := d.Shape(p, 16.784, 25, true, pair, r); math.Abs(kw-w) > 1e-9 {
			t.Fatalf("step %d: %.3f, want %.3f (<= 3 kW per settled pair onto surplus - reserve)", i, kw, w)
		}
	}
	// Between settled pairs: hold, whatever the corrections now propose.
	if kw, _ := d.Shape(p, 16.784, 30, true, DampPairNone, surplusReading(35, 5)); kw != 24.5 {
		t.Fatalf("no new pair: hold, got %.3f", kw)
	}
	// A retreat pair never raises ...
	if kw, _ := d.Shape(p, 16.784, 30, true, DampPairRetreat, surplusReading(35, 5)); kw != 24.5 {
		t.Fatalf("retreat pair must not raise, got %.3f", kw)
	}
	// ... but lowers at once.
	if kw, _ := d.Shape(p, 16.784, 20, true, DampPairRetreat, surplusReading(25, 5)); kw != 19.5 {
		t.Fatalf("retreat pair: %.3f, want 19.5 at once", kw)
	}
	// Deadband: a goal within 0.2 kW is not a write.
	if kw, _ := d.Shape(p, 16.784, 20.1, true, DampPairSettled, surplusReading(25.1, 5)); kw != 19.5 {
		t.Fatalf("deadband: %.3f, want the held 19.5", kw)
	}
	// A RAISING correction never undercuts the command it raises.
	if kw, _ := d.Shape(p, 16.784, 17.1, true, DampPairSettled, surplusReading(22.1, 5)); kw != 16.784 {
		t.Fatalf("absorption with reserve below the plan: %.3f, want the plan's 16.784", kw)
	}
	// Trim -> absorption inside one slot: the level below the plan ramps up
	// through the plan instead of jumping onto it.
	d = NewFollowDamper()
	if kw, _ := d.Shape(p, 16.784, 8.5, true, DampPairNone, surplusReading(13.5, 5)); kw != 8 {
		t.Fatalf("trim under a cloud: %.3f, want 8", kw)
	}
	if kw, _ := d.Shape(p, 16.784, 25, true, DampPairSettled, surplusReading(30, 5)); kw != 11 {
		t.Fatalf("sky clears, absorption bites: %.3f, want one 3 kW ramp (11), not a jump onto the plan", kw)
	}
	if kw, _ := d.Shape(p, 16.784, 25, true, DampPairNone, surplusReading(30, 5)); kw != 11 {
		t.Fatalf("no new pair: hold 11, got %.3f", kw)
	}
	// Never a flip: a vanished surplus trims to zero, not into a discharge.
	d = NewFollowDamper()
	if kw, _ := d.Shape(p, 10, 0, true, DampPairSettled, surplusReading(3, 5)); kw != 0 {
		t.Fatalf("trim below zero surplus: %.3f, want 0", kw)
	}
}

// Discharge side, mirrored: selling the storage is the expensive side.
func TestFollowDamperShapeDischargeSide(t *testing.T) {
	p := deyeProfile()
	// DEEPEN: plan -4.332 into a 7.117 kW deficit (Pilsting night).
	d := NewFollowDamper()
	if kw, _ := d.Shape(p, -4.332, -7.117, true, DampPairNone, surplusReading(0, 7.117)); math.Abs(kw+6.617) > 1e-9 {
		t.Fatalf("deepen: %.3f, want -6.617 (deficit - reserve, within one ramp)", kw)
	}
	// LIMIT: plan -6.7 into a 5.1 kW house - at once onto deficit - reserve.
	d = NewFollowDamper()
	if kw, _ := d.Shape(p, -6.7, -5.1, true, DampPairNone, surplusReading(0, 5.1)); math.Abs(kw+4.6) > 1e-9 {
		t.Fatalf("limit: %.3f, want -4.6 at once", kw)
	}
	// A larger deepening ramps.
	d = NewFollowDamper()
	if kw, _ := d.Shape(p, 0, -12, true, DampPairNone, surplusReading(0, 12)); kw != -3 {
		t.Fatalf("deepen from rest: %.3f, want -3 (one ramp)", kw)
	}
}

func TestFollowDamperShapeReleasesWhenNothingIsEngaged(t *testing.T) {
	d, p := NewFollowDamper(), deyeProfile()
	d.Shape(p, 16.784, 25, true, DampPairSettled, surplusReading(30, 5))
	if kw, shaped := d.Shape(p, 16.784, 16.784, false, DampPairSettled, surplusReading(30, 5)); shaped || kw != 16.784 || d.Engaged() {
		t.Fatalf("no correction engaged: pass the command, got %.3f shaped=%v", kw, shaped)
	}
	// Re-engaging starts from the command again.
	if kw, _ := d.Shape(p, 16.784, 25, true, DampPairNone, surplusReading(30, 5)); kw != 19.784 {
		t.Fatalf("re-engaged: %.3f, want one ramp from the command", kw)
	}
}
