package guards

import (
	"math"
	"testing"
	"time"
)

// gridGood is the fully-healthy throttling slot: negative price, the plan
// charges, the device carries the released lever and has confirmed the grid
// side, the meter sits on the target.
func gridGood() GridTargetInput {
	return GridTargetInput{
		Enabled:           true,
		SlotStart:         slotA,
		PlanFresh:         true,
		CurtailmentWanted: true,
		PlannedKw:         8,
		Lever:             true,
		HolderExempt:      true,
		Authorized:        true,
		MeasurementsFresh: true,
		ReadbackHealthy:   true,
		SocPct:            60,
		FloorPct:          ptr(20),
		SocMinPct:         10,
		Proven:            true,
		GridKw:            -0.1,
		BatteryKw:         8,
		OwnPvKw:           12,
	}
}

func TestAThrottlingSlotHandsTheGridPointToTheInverter(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	d := g.Decide(slotA.Add(time.Second), gridGood())
	if !d.Engage || !d.Proven {
		t.Fatalf("want a proven grid-target mode, got %+v", d)
	}
	if d.Reason != GridTargetEngaged || d.Text == "" {
		t.Fatalf("every outcome names its cause: %+v", d)
	}
	if d.TargetKw != 0 {
		t.Fatalf("the negative-price slot's target is the null export, got %v", d.TargetKw)
	}
	if d.Following == nil || !*d.Following {
		t.Fatalf("0,1 kW feed-in is on the target: %+v", d)
	}
	if !g.Engaged() {
		t.Fatal("Engaged must mirror the decision")
	}
}

// The entry rule of concept §2.6, one missing fact at a time: nothing is asked
// of the device, and the cause is named.
func TestTheEntryRuleRefusesWithANamedCause(t *testing.T) {
	cases := []struct {
		name string
		edit func(*GridTargetInput)
		want string
	}{
		{"operator switch", func(in *GridTargetInput) { in.Enabled = false }, GridTargetOff},
		{"stale plan", func(in *GridTargetInput) { in.PlanFresh = false }, GridTargetPlanStale},
		{"no curtailment in the slot", func(in *GridTargetInput) { in.CurtailmentWanted = false }, GridTargetNoCurtailment},
		{"the plan discharges", func(in *GridTargetInput) { in.PlannedKw = -3 }, GridTargetPlanDischarges},
		{"no active slot", func(in *GridTargetInput) { in.PlannedKw = math.NaN() }, GridTargetPlanDischarges},
		{"no released lever", func(in *GridTargetInput) { in.Lever = false }, GridTargetNoLever},
		{"native mode holds the slot", func(in *GridTargetInput) { in.OtherModeActive = true }, GridTargetOtherMode},
		{"pause / holder", func(in *GridTargetInput) { in.HolderExempt = false }, GridTargetForeignHolder},
		{"kill-switch / certificate", func(in *GridTargetInput) { in.Authorized = false }, GridTargetNotAuthorized},
		{"stale measurement", func(in *GridTargetInput) { in.MeasurementsFresh = false }, GridTargetStaleMeasurement},
		{"no readback", func(in *GridTargetInput) { in.ReadbackHealthy = false }, GridTargetNoReadback},
		{"unknown reserve floor", func(in *GridTargetInput) { in.FloorPct = nil }, GridTargetNoFloor},
		{"unknown SoC", func(in *GridTargetInput) { in.SocPct = math.NaN() }, GridTargetSocOutside},
		{"SoC at the floor margin", func(in *GridTargetInput) { in.SocPct = 23 }, GridTargetSocOutside},
		{"the technical floor binds when higher", func(in *GridTargetInput) { in.SocMinPct = 58 }, GridTargetSocOutside},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := NewGridTargetMode(time.Minute)
			in := gridGood()
			c.edit(&in)
			d := g.Decide(slotA, in)
			if d.Engage || d.Proven {
				t.Fatalf("must not engage: %+v", d)
			}
			if d.Reason != c.want || d.Text == "" {
				t.Fatalf("reason = %q (%q), want %q", d.Reason, d.Text, c.want)
			}
			if d.Ended != "" {
				t.Fatalf("nothing was handed over, so nothing ended: %+v", d)
			}
		})
	}
}

// A resting slot is not a discharging one - and a plan that charges is the
// ordinary negative-price case.
func TestARestingOrChargingPlanQualifies(t *testing.T) {
	for _, kw := range []float64{0, -0.04, 0.3, 30} {
		g := NewGridTargetMode(time.Minute)
		in := gridGood()
		in.PlannedKw = kw
		if d := g.Decide(slotA, in); !d.Engage {
			t.Fatalf("planned %v kW must qualify, got %+v", kw, d)
		}
	}
}

// E4: the device leads the battery and its charge up to 100 % is accepted -
// a full storage is exactly where the mode throttles the device's own PV.
func TestAFullStorageIsNotATakeBack(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	for _, soc := range []float64{94, 95, 97, 100} {
		in.SocPct = soc
		in.BatteryKw = 0
		in.OwnPvKw = 0
		if d := g.Decide(slotA.Add(time.Duration(soc)*time.Second), in); !d.Engage || !d.Proven {
			t.Fatalf("SoC %v must stay grid side (E4), got %+v", soc, d)
		}
	}
	in.SocPct = 100.5
	if d := g.Decide(slotA.Add(5*time.Minute), in); d.Engage {
		t.Fatalf("a reading above %v %% is not a state of charge: %+v", GridTargetChargeCeilingPct, d)
	}
}

func TestPendingUntilTheDeviceConfirmsThenWithdrawnAfterTheGrace(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.Proven = false
	d := g.Decide(slotA, in)
	if !d.Engage || d.Proven || d.Reason != GridTargetPending {
		t.Fatalf("the intent stands pending: %+v", d)
	}
	if d.Following != nil {
		t.Fatalf("an unproven mode states no effect: %+v", d)
	}
	if d = g.Decide(slotA.Add(60*time.Second), in); !d.Engage {
		t.Fatalf("inside the grace the intent still stands: %+v", d)
	}
	d = g.Decide(slotA.Add(61*time.Second), in)
	if d.Engage || d.Reason != GridTargetUnproven || d.Ended != GridTargetUnproven || d.EndedText == "" {
		t.Fatalf("an unanswered request is withdrawn and named: %+v", d)
	}
	// Latched: a proof that arrives late in the same slot does not re-enter.
	in.Proven = true
	if d = g.Decide(slotA.Add(2*time.Minute), in); d.Engage || d.Reason != GridTargetUnproven {
		t.Fatalf("a take-back holds for the rest of its slot: %+v", d)
	}
	// The next slot re-arms.
	in.SlotStart = slotB
	if d = g.Decide(slotB, in); !d.Engage || !d.Proven {
		t.Fatalf("a new slot may be grid side again: %+v", d)
	}
}

// One lost proof does not end the slot: the grace runs from the last proof.
func TestALostProofGetsTheWholeGrace(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	g.Decide(slotA, in)
	in.Proven = false
	if d := g.Decide(slotA.Add(50*time.Second), in); !d.Engage || d.Reason != GridTargetPending {
		t.Fatalf("pending again, not withdrawn: %+v", d)
	}
	in.Proven = true
	if d := g.Decide(slotA.Add(70*time.Second), in); !d.Proven {
		t.Fatalf("the proof came back: %+v", d)
	}
}

func TestEveryTakeBackIsNamedAndLatched(t *testing.T) {
	cases := []struct {
		name string
		edit func(*GridTargetInput)
		want string
	}{
		{"reserve floor + margin", func(in *GridTargetInput) { in.SocPct = 23 }, GridTargetFloorReached},
		{"SoC lost", func(in *GridTargetInput) { in.SocPct = math.NaN() }, GridTargetSocOutside},
		{"measurement stale", func(in *GridTargetInput) { in.MeasurementsFresh = false }, GridTargetStaleMeasurement},
		{"grid point unknown", func(in *GridTargetInput) { in.GridKw = math.NaN() }, GridTargetStaleMeasurement},
		{"readback lost", func(in *GridTargetInput) { in.ReadbackHealthy = false }, GridTargetNoReadback},
		{"floor no longer published", func(in *GridTargetInput) { in.FloorPct = nil }, GridTargetNoFloor},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := NewGridTargetMode(time.Minute)
			if d := g.Decide(slotA, gridGood()); !d.Proven {
				t.Fatalf("setup: %+v", d)
			}
			in := gridGood()
			c.edit(&in)
			d := g.Decide(slotA.Add(10*time.Second), in)
			if d.Engage || d.Reason != c.want || d.Ended != c.want || d.EndedText == "" {
				t.Fatalf("take-back must be named %q: %+v", c.want, d)
			}
			// Healthy again in the same slot: the latch holds.
			d = g.Decide(slotA.Add(20*time.Second), gridGood())
			if d.Engage || d.Reason != c.want || d.Ended != "" {
				t.Fatalf("latched for the rest of the slot, the end named once: %+v", d)
			}
		})
	}
}

// "Netz folgt Ziel nicht binnen 60 s": a minute of import the device does not
// cover is a device that does not regulate.
func TestImportThatIsNotCoveredForAMinuteTakesBack(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.GridKw = 2.5
	d := g.Decide(slotA, in)
	if !d.Proven || d.Following == nil || *d.Following {
		t.Fatalf("off the target, but inside the hold: %+v", d)
	}
	if d = g.Decide(slotA.Add(60*time.Second), in); !d.Engage {
		t.Fatalf("exactly the hold is not beyond it: %+v", d)
	}
	d = g.Decide(slotA.Add(61*time.Second), in)
	if d.Engage || d.Ended != GridTargetNotFollowing {
		t.Fatalf("want %q, got %+v", GridTargetNotFollowing, d)
	}
}

// A deviation that returns inside the hold starts over - the device answers in
// seconds, a blink is not a refusal.
func TestADeviationThatReturnsStartsTheHoldOver(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.GridKw = -3
	g.Decide(slotA, in)
	g.Decide(slotA.Add(50*time.Second), in)
	in.GridKw = -0.2
	if d := g.Decide(slotA.Add(55*time.Second), in); d.Following == nil || !*d.Following {
		t.Fatalf("back on the target: %+v", d)
	}
	in.GridKw = -3
	if d := g.Decide(slotA.Add(100*time.Second), in); !d.Engage {
		t.Fatalf("the hold starts over at the new deviation: %+v", d)
	}
}

// Feed-in the device itself supplies is the device's to throttle.
func TestFeedInFromTheDevicesOwnShareTakesBack(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.GridKw, in.OwnPvKw, in.BatteryKw = -6, 12, 4 // 8 kW of its own PV go to the grid
	g.Decide(slotA, in)
	d := g.Decide(slotA.Add(61*time.Second), in)
	if d.Engage || d.Ended != GridTargetNotFollowing {
		t.Fatalf("the device feeds in against the target: %+v", d)
	}
}

// A discharging storage adds to the device's own share.
func TestAStorageThatFeedsTheGridTakesBack(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.GridKw, in.OwnPvKw, in.BatteryKw = -4, 0, -4
	g.Decide(slotA, in)
	if d := g.Decide(slotA.Add(61*time.Second), in); d.Engage || d.Ended != GridTargetNotFollowing {
		t.Fatalf("storage energy leaves the site against the target: %+v", d)
	}
}

// The live finding of 08.10.2026 (step "Ziel 0"): the device sets its OWN
// share only. Once it feeds nothing in any more, the remaining feed-in is the
// other producers' - a take-back would release its PV on top of it.
func TestAnExhaustedDeviceStaysAndSaysSo(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	in.GridKw, in.OwnPvKw, in.BatteryKw = -26, 12.5, 12.5 // all of its PV goes into the storage
	var d GridTargetDecision
	for s := 0; s <= 600; s += 10 {
		d = g.Decide(slotA.Add(time.Duration(s)*time.Second), in)
		if !d.Engage || !d.Proven {
			t.Fatalf("t=%ds: an exhausted device must stay grid side: %+v", s, d)
		}
	}
	if d.Hint != GridTargetHintExhausted || d.HintText == "" {
		t.Fatalf("the standing feed-in is named as the others': %+v", d)
	}
	if d.Following == nil || *d.Following {
		t.Fatalf("the meter is NOT on the target, and that is what is reported: %+v", d)
	}
	// Own PV throttled to nothing, storage full: the same verdict.
	in.OwnPvKw, in.BatteryKw, in.SocPct = 0.2, 0, 100
	if d = g.Decide(slotA.Add(11*time.Minute), in); !d.Engage || d.Hint != GridTargetHintExhausted {
		t.Fatalf("throttled away + full is exhausted too: %+v", d)
	}
}

// Silence never excuses: without the device's own PV (or battery) reading the
// standing feed-in cannot be attributed and counts as the device's.
func TestAnUnattributableFeedInTakesBack(t *testing.T) {
	for _, edit := range []func(*GridTargetInput){
		func(in *GridTargetInput) { in.OwnPvKw = math.NaN() },
		func(in *GridTargetInput) { in.BatteryKw = math.NaN() },
	} {
		g := NewGridTargetMode(time.Minute)
		in := gridGood()
		in.GridKw = -10
		edit(&in)
		g.Decide(slotA, in)
		if d := g.Decide(slotA.Add(61*time.Second), in); d.Engage || d.Ended != GridTargetNotFollowing {
			t.Fatalf("unknown share must not excuse the feed-in: %+v", d)
		}
	}
}

// E2: the side is switched per slot - but consecutive throttling slots do not
// toggle the device, and the ordinary end of the last one is named as such.
func TestTheModeContinuesAcrossQualifyingSlotsAndEndsWithItsSlot(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	g.Decide(slotA, in)
	in.SlotStart = slotB
	d := g.Decide(slotB, in)
	if !d.Engage || !d.Proven || d.Ended != "" {
		t.Fatalf("the next throttling slot continues without a side switch: %+v", d)
	}
	slotC := slotB.Add(15 * time.Minute)
	in.SlotStart, in.CurtailmentWanted = slotC, false
	d = g.Decide(slotC, in)
	if d.Engage || d.Reason != GridTargetNoCurtailment || d.Ended != GridTargetSlotEnd || d.EndedText == "" {
		t.Fatalf("the slot end is the named end: %+v", d)
	}
	if d = g.Decide(slotC.Add(10*time.Second), in); d.Ended != "" {
		t.Fatalf("an end is news once: %+v", d)
	}
}

// A slot whose plan now discharges ends the mode at the boundary as well.
func TestADischargingNextSlotEndsItAsSlotEnd(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	g.Decide(slotA, in)
	in.SlotStart, in.PlannedKw = slotB, -6
	if d := g.Decide(slotB, in); d.Engage || d.Ended != GridTargetSlotEnd {
		t.Fatalf("want the slot end, got %+v", d)
	}
}

// A plan update INSIDE the slot that drops the curtailment is not a slot end.
func TestACurtailmentWithdrawnInsideTheSlotNamesThat(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	g.Decide(slotA, in)
	in.CurtailmentWanted = false
	if d := g.Decide(slotA.Add(30*time.Second), in); d.Engage || d.Ended != GridTargetNoCurtailment {
		t.Fatalf("want %q, got %+v", GridTargetNoCurtailment, d)
	}
}

// Pause / holder / kill-switch end the mode with their own word, unlatched:
// the ordinary plan takes the device back on that very tick, and once the
// holder is gone the slot may be grid side again.
func TestPauseHolderAndKillSwitchEndItNamedButUnlatched(t *testing.T) {
	cases := []struct {
		edit func(*GridTargetInput)
		want string
	}{
		{func(in *GridTargetInput) { in.HolderExempt = false }, GridTargetForeignHolder},
		{func(in *GridTargetInput) { in.Authorized = false }, GridTargetNotAuthorized},
		{func(in *GridTargetInput) { in.Enabled = false }, GridTargetOff},
		{func(in *GridTargetInput) { in.Lever = false }, GridTargetNoLever},
	}
	for _, c := range cases {
		g := NewGridTargetMode(time.Minute)
		g.Decide(slotA, gridGood())
		in := gridGood()
		c.edit(&in)
		d := g.Decide(slotA.Add(10*time.Second), in)
		if d.Engage || d.Reason != c.want || d.Ended != c.want {
			t.Fatalf("want the end named %q, got %+v", c.want, d)
		}
		if d = g.Decide(slotA.Add(20*time.Second), gridGood()); !d.Engage {
			t.Fatalf("%q is not a latch: %+v", c.want, d)
		}
	}
}

// K6: "Gerät regelt" needs the connection point's Führungsgerät on this path
// too - a device whose meter does not see the whole site regulates the wrong
// quantity to 0. A refusal before the hand-over, a latched take-back when the
// verdict turns while the device regulates; the K6 word and sentence are kept.
func TestOnlyTheConnectionPointsLeaderMayRegulateIt(t *testing.T) {
	for _, code := range []string{NativeMeterLocationMissing, NativeMeterElsewhere, NativeMeterImplausible, NativeSecondRegulator} {
		g := NewGridTargetMode(time.Minute)
		in := gridGood()
		in.LeaderRefusal = code
		d := g.Decide(slotA, in)
		if d.Engage || d.Reason != code || d.Text == "" || d.Ended != "" {
			t.Fatalf("%q must refuse with its own sentence: %+v", code, d)
		}
		if d = g.Decide(slotA.Add(10*time.Second), gridGood()); !d.Engage {
			t.Fatalf("a refusal before the hand-over is not a latch: %+v", d)
		}
		d = g.Decide(slotA.Add(20*time.Second), in)
		if d.Engage || d.Ended != code {
			t.Fatalf("the verdict turned while the device regulated - a named take-back: %+v", d)
		}
		if d = g.Decide(slotA.Add(30*time.Second), gridGood()); d.Engage || d.Reason != code {
			t.Fatalf("and that one is latched for the slot: %+v", d)
		}
	}
}

// EEG safety by construction: no path of this file commands an import target.
func TestTheTargetIsNeverAnImportTarget(t *testing.T) {
	for _, kw := range []float64{0, -30, 0.05, 0.051, 5, 1000, math.Inf(1)} {
		if got := ClampGridTarget(kw); got > GridTargetMaxKw {
			t.Fatalf("ClampGridTarget(%v) = %v, above +%v kW", kw, got, GridTargetMaxKw)
		}
	}
	if got := ClampGridTarget(math.NaN()); got != GridTargetNullExportKw {
		t.Fatalf("not a number is the null export, got %v", got)
	}
	if got := ClampGridTarget(-30); got != -30 {
		t.Fatalf("a feed-in target is not clamped, got %v", got)
	}
	g := NewGridTargetMode(time.Minute)
	if d := g.Decide(slotA, gridGood()); d.TargetKw > GridTargetMaxKw || d.TargetKw != GridTargetNullExportKw {
		t.Fatalf("the published target is the null export: %+v", d)
	}
}

func TestReleaseDropsTheArmedState(t *testing.T) {
	g := NewGridTargetMode(time.Minute)
	in := gridGood()
	g.Decide(slotA, in)
	in.SocPct = 22
	g.Decide(slotA.Add(time.Second), in) // latched
	g.Release()
	if g.Engaged() {
		t.Fatal("released")
	}
	d := g.Decide(slotA.Add(2*time.Second), gridGood())
	if !d.Engage || d.Ended != "" {
		t.Fatalf("a released supervision starts fresh: %+v", d)
	}
}

func TestANonPositiveGraceFallsBackToTheDefault(t *testing.T) {
	g := NewGridTargetMode(0)
	in := gridGood()
	in.Proven = false
	g.Decide(slotA, in)
	if d := g.Decide(slotA.Add(gridTargetDefaultGrace), in); !d.Engage {
		t.Fatalf("inside the default grace: %+v", d)
	}
	if d := g.Decide(slotA.Add(gridTargetDefaultGrace+time.Second), in); d.Engage {
		t.Fatalf("an intent must always be withdrawable: %+v", d)
	}
}

// A word nobody can read must not exist: every code of the vocabulary has its
// German sentence, and an unknown code has none.
func TestEveryGridTargetReasonHasItsSentence(t *testing.T) {
	for _, code := range []string{
		GridTargetEngaged, GridTargetPending, GridTargetOff, GridTargetNoCurtailment, GridTargetPlanStale,
		GridTargetPlanDischarges, GridTargetNoLever, GridTargetOtherMode, GridTargetForeignHolder,
		GridTargetNotAuthorized, GridTargetNoFloor, GridTargetSocOutside, GridTargetFloorReached,
		GridTargetStaleMeasurement, GridTargetNoReadback, GridTargetUnproven, GridTargetNotFollowing,
		GridTargetSlotEnd, GridTargetHintExhausted,
	} {
		if GridTargetReasonText(code) == "" {
			t.Errorf("reason %q has no sentence", code)
		}
	}
	if GridTargetReasonText("unbekannt") != "" {
		t.Error("an unknown code must not become a sentence")
	}
}
