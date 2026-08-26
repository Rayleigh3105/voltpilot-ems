package guards

import (
	"math"
	"testing"
	"time"
)

func ptr(v float64) *float64 { return &v }
func bptr(v bool) *bool      { return &v }

var slotA = time.Date(2026, 8, 26, 21, 15, 0, 0, time.UTC)
var slotB = slotA.Add(15 * time.Minute)

// good is the fully-healthy input: every fact present, every fact good.
func good() NativeInput {
	return NativeInput{
		Enabled:           true,
		Duty:              NativeDutyCoverLoad,
		SlotStart:         slotA,
		PlanFresh:         true,
		HolderExempt:      true,
		Authorized:        true,
		MeasurementsFresh: true,
		ReadbackHealthy:   true,
		SocPct:            77,
		FloorPct:          ptr(20),
		PeakThreatened:    false,
		SolarOnlyCharge:   false,
		Proven:            true,
	}
}

func TestAHealthyCoveringSlotHandsTheBatteryToTheInverter(t *testing.T) {
	n := NewNativeMode(time.Minute)
	d := n.Decide(slotA.Add(time.Second), good())
	if !d.Native || !d.Proven {
		t.Fatalf("want a proven native mode, got %+v", d)
	}
	if d.Reason != NativeEngaged || d.Text == "" {
		t.Fatalf("every outcome names its cause: %+v", d)
	}
	if d.Duty != NativeDutyCoverLoad {
		t.Fatalf("duty must name the authorising cloud flag, got %q", d.Duty)
	}
	if !n.Engaged() {
		t.Fatal("Engaged must mirror the decision")
	}
}

func TestTheIdleSlotAuthorizationOpensItToo(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := good()
	in.Duty = NativeDutyUnplanned
	if d := n.Decide(slotA, in); !d.Native || d.Duty != NativeDutyUnplanned {
		t.Fatalf("unplanned_load_discharge is equally authorised, got %+v", d)
	}
}

// The rule this whole file exists for: every missing fact means the proven
// 10-second follower carries the slot.
func TestEveryMissingFactFallsBackToTheFollowerAndNamesItsCause(t *testing.T) {
	cases := []struct {
		name  string
		patch func(*NativeInput)
		want  string
	}{
		{"operator switch off", func(i *NativeInput) { i.Enabled = false }, NativeOff},
		{"not a covering slot", func(i *NativeInput) { i.Duty = "" }, NativeNoDuty},
		{"both duties at once", func(i *NativeInput) { i.Duty = "cover_load_and_unplanned" }, NativeNoDuty},
		{"stale plan", func(i *NativeInput) { i.PlanFresh = false }, NativePlanStale},
		{"foreign holder", func(i *NativeInput) { i.HolderExempt = false }, NativeForeignHolder},
		{"not authorized", func(i *NativeInput) { i.Authorized = false }, NativeNotAuthorized},
		{"stale measurement", func(i *NativeInput) { i.MeasurementsFresh = false }, NativeStaleMeasurement},
		{"unhealthy readback", func(i *NativeInput) { i.ReadbackHealthy = false }, NativeNoReadback},
		{"no reserve floor", func(i *NativeInput) { i.FloorPct = nil }, NativeNoFloor},
		{"unknown soc", func(i *NativeInput) { i.SocPct = math.NaN() }, NativeFloorReached},
		{"soc at the floor", func(i *NativeInput) { i.SocPct = 20 }, NativeFloorReached},
		{"soc inside the margin", func(i *NativeInput) { i.SocPct = 20 + NativeFloorMarginPct }, NativeFloorReached},
		{"peak threatened", func(i *NativeInput) { i.PeakThreatened = true }, NativePeakThreatened},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := NewNativeMode(time.Minute)
			in := good()
			c.patch(&in)
			d := n.Decide(slotA, in)
			if d.Native {
				t.Fatalf("must not hand the battery over: %+v", d)
			}
			if d.Reason != c.want {
				t.Fatalf("reason: want %q got %q", c.want, d.Reason)
			}
			if d.Text == "" {
				t.Fatal("a refusal nobody names reads as a defect")
			}
		})
	}
}

// EEG: the ONE compliance rule that moves into the device's own configuration
// when we stop commanding. Unknown is NOT proven.
func TestOnAnEegSiteTheDeviceMustProveItCannotGridCharge(t *testing.T) {
	for _, c := range []struct {
		name    string
		blocked *bool
		native  bool
	}{
		{"device stayed silent", nil, false},
		{"device says it CAN grid-charge", bptr(false), false},
		{"device proves it cannot", bptr(true), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			n := NewNativeMode(time.Minute)
			in := good()
			in.SolarOnlyCharge = true
			in.GridChargeBlocked = c.blocked
			d := n.Decide(slotA, in)
			if d.Native != c.native {
				t.Fatalf("native=%v want %v (%+v)", d.Native, c.native, d)
			}
			if !c.native && d.Reason != NativeGridChargeUnproven {
				t.Fatalf("reason: want %q got %q", NativeGridChargeUnproven, d.Reason)
			}
		})
	}
	// A merchant site is unaffected: the posture is what makes it a rule.
	n := NewNativeMode(time.Minute)
	in := good()
	in.SolarOnlyCharge = false
	in.GridChargeBlocked = nil
	if d := n.Decide(slotA, in); !d.Native {
		t.Fatalf("a merchant site needs no grid-charge proof: %+v", d)
	}
}

// The proof loop: an intent nobody confirms is not a native mode.
func TestAnUnconfirmedIntentIsWithdrawnAfterTheGrace(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := good()
	in.Proven = false

	d := n.Decide(slotA, in)
	if !d.Native || d.Proven || d.Reason != NativePending {
		t.Fatalf("inside the grace the intent stands as PENDING: %+v", d)
	}
	// Still inside the window.
	if d := n.Decide(slotA.Add(59*time.Second), in); !d.Native {
		t.Fatalf("one lost readback cycle must not end the slot: %+v", d)
	}
	// Past it.
	d = n.Decide(slotA.Add(61*time.Second), in)
	if d.Native || d.Reason != NativeUnproven {
		t.Fatalf("want a withdrawal named %q, got %+v", NativeUnproven, d)
	}
	// And it stays withdrawn for the rest of THIS slot even if the device
	// suddenly answers - one transition per slot, never a toggle.
	if d := n.Decide(slotA.Add(120*time.Second), good()); d.Native {
		t.Fatalf("the take-back is latched for the slot: %+v", d)
	}
	// The next slot re-arms.
	in2 := good()
	in2.SlotStart = slotB
	if d := n.Decide(slotB, in2); !d.Native {
		t.Fatalf("a new slot must re-arm the mode: %+v", d)
	}
}

// Anti-flap: a take-back is remembered for the rest of the slot, so a blinking
// measurement cannot toggle the device's mode with the setpoint cadence.
func TestATakeBackIsLatchedForTheRestOfItsSlot(t *testing.T) {
	n := NewNativeMode(time.Minute)
	if d := n.Decide(slotA, good()); !d.Native {
		t.Fatalf("setup: %+v", d)
	}
	stale := good()
	stale.MeasurementsFresh = false
	if d := n.Decide(slotA.Add(10*time.Second), stale); d.Native {
		t.Fatalf("setup: %+v", d)
	}
	// The measurement is back - the slot still finishes on the follower.
	d := n.Decide(slotA.Add(20*time.Second), good())
	if d.Native {
		t.Fatalf("must stay withdrawn inside the slot: %+v", d)
	}
	if d.Reason != NativeStaleMeasurement {
		t.Fatalf("the latch keeps the ORIGINAL cause: %q", d.Reason)
	}
	// A new slot clears it.
	next := good()
	next.SlotStart = slotB
	if d := n.Decide(slotB, next); !d.Native {
		t.Fatalf("the latch must not survive its slot: %+v", d)
	}
}

// A non-covering slot RESETS the arming - so a covering slot after a plain one
// is not blocked by a take-back from two slots ago.
func TestALeftSlotClearsTheArming(t *testing.T) {
	n := NewNativeMode(time.Minute)
	floor := good()
	floor.SocPct = 20
	if d := n.Decide(slotA, floor); d.Native {
		t.Fatalf("setup: %+v", d)
	}
	plain := good()
	plain.Duty = ""
	if d := n.Decide(slotA.Add(time.Minute), plain); d.Reason != NativeNoDuty {
		t.Fatalf("setup: %+v", d)
	}
	// Same slot id, but the arming was cleared by the plain tick: a healthy
	// covering fact set may engage again.
	if d := n.Decide(slotA.Add(2*time.Minute), good()); !d.Native {
		t.Fatalf("a left slot must clear the latch: %+v", d)
	}
}

func TestReleaseDropsEverything(t *testing.T) {
	n := NewNativeMode(time.Minute)
	stale := good()
	stale.MeasurementsFresh = false
	n.Decide(slotA, stale)
	n.Release()
	if n.Engaged() {
		t.Fatal("Release must clear the engaged flag")
	}
	if d := n.Decide(slotA, good()); !d.Native {
		t.Fatalf("Release must clear the latch too: %+v", d)
	}
}

func TestAZeroGraceCannotCreateAnIntentThatIsNeverWithdrawn(t *testing.T) {
	n := NewNativeMode(0)
	in := good()
	in.Proven = false
	n.Decide(slotA, in)
	if d := n.Decide(slotA.Add(nativeDefaultGrace+time.Second), in); d.Native {
		t.Fatalf("a mis-wired grace must fall back to the default: %+v", d)
	}
}

func TestReasonTextNeverInventsASentence(t *testing.T) {
	if NativeReasonText("ein_wort_das_wir_nicht_kennen") != "" {
		t.Fatal("a word we do not understand must not become a sentence")
	}
	for _, code := range []string{
		NativeEngaged, NativePending, NativeOff, NativeNoDuty, NativePlanStale,
		NativeForeignHolder, NativeNotAuthorized, NativeStaleMeasurement,
		NativeNoReadback, NativeNoFloor, NativeFloorReached, NativePeakThreatened,
		NativeGridChargeUnproven, NativeUnproven,
	} {
		if NativeReasonText(code) == "" {
			t.Fatalf("%q has no German sentence", code)
		}
	}
}

// The peak threat keys on what the METER is doing, not on what a correction
// would do to a commanded value - in native mode there is no lever to test.
func TestNativePeakThreatReadsTheMeasuredImport(t *testing.T) {
	if NativePeakThreat(nil, slotA, ptr(20)) {
		t.Fatal("no tracker = not threatened (never regulate blind)")
	}
	tr := NewPeakTracker()
	if NativePeakThreat(tr, slotA, ptr(20)) {
		t.Fatal("a tracker that never saw a sample = not threatened")
	}
	// A quarter running exactly at the target: the remaining allowance equals
	// the target, so the held import is NOT above it.
	tr.Add(slotA, 20)
	tr.Add(slotA.Add(5*time.Minute), 20)
	if NativePeakThreat(tr, slotA.Add(5*time.Minute), ptr(20)) {
		t.Fatal("running AT the target is not a threat")
	}
	if NativePeakThreat(tr, slotA.Add(5*time.Minute), nil) {
		t.Fatal("no target = no module = not threatened")
	}
	// Now the meter runs well above what the rest of the quarter allows.
	tr2 := NewPeakTracker()
	tr2.Add(slotA, 40)
	tr2.Add(slotA.Add(10*time.Minute), 40)
	if !NativePeakThreat(tr2, slotA.Add(10*time.Minute), ptr(20)) {
		t.Fatal("a meter running above the remaining budget IS a threat")
	}
}
