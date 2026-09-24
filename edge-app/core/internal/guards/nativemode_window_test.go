package guards

import (
	"testing"
	"time"
)

// K4b: Absicht + Fenster on the native supervision - Box ② (which lever) and
// Box ③ (the charge side). The pre-existing E↓ behaviour is pinned by
// nativemode_test.go and must stay byte-identical without a Layer-1 report.

var allLevers = &NativeLevers{
	Intents: []string{NativeIntentCoverLoad, NativeIntentSurplusCharge, NativeIntentSelfConsumption},
	Window:  true,
}

// surplusInput is a healthy E↑ slot (the Herzogau case) on a Layer 1 that
// reports and proves the lever.
func surplusInput() NativeInput {
	in := good()
	in.Duty = ""
	in.Intent = NativeIntentSurplusCharge
	in.Window = Window{MinKw: 0, MaxKw: 30}
	in.Levers = allLevers
	in.ProvenIntent = NativeIntentSurplusCharge
	in.SocPct = 40
	in.SocMaxPct = 95
	in.GridKw, in.BatteryKw = 0, 8
	return in
}

func TestWindowIntentNeedsANamedLever(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*NativeInput)
		want   string
	}{
		{"no report: only the pre-existing E↓ exists", func(in *NativeInput) { in.Levers = nil }, NativeNoLever},
		{"report without the intent", func(in *NativeInput) {
			in.Levers = &NativeLevers{Intents: []string{NativeIntentCoverLoad}, Window: true}
		}, NativeNoLever},
		{"E~ needs a window lever", func(in *NativeInput) {
			in.Intent, in.NeedsWindow = NativeIntentSelfConsumption, true
			in.Levers = &NativeLevers{Intents: []string{NativeIntentSelfConsumption}}
		}, NativeNoLever},
		{"E↓ with a policy bound stays with the box", func(in *NativeInput) {
			in.Intent, in.NeedsWindow, in.Duty = NativeIntentCoverLoad, true, NativeDutyCoverLoad
		}, NativeNoLever},
		{"no open window", func(in *NativeInput) { in.Intent = "" }, NativeNoDuty},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := surplusInput()
			c.mutate(&in)
			d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in)
			if d.Native || d.Reason != c.want || d.Text == "" {
				t.Fatalf("want refusal %s, got %+v", c.want, d)
			}
		})
	}
}

func TestSurplusChargeEngagesWithItsOwnWordAndWindow(t *testing.T) {
	n := NewNativeMode(time.Minute)
	d := n.Decide(slotA.Add(time.Second), surplusInput())
	if !d.Native || !d.Proven || d.Intent != NativeIntentSurplusCharge || d.Mode != "native_window" {
		t.Fatalf("want a proven E↑, got %+v", d)
	}
	if d.Window != (Window{MinKw: 0, MaxKw: 30}) || d.Text != nativeEngagedText(NativeIntentSurplusCharge) {
		t.Fatalf("window/text: %+v", d)
	}
	// A readback that proves ANOTHER primitive is no proof of this one.
	in := surplusInput()
	in.ProvenIntent = NativeIntentCoverLoad
	d = NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in)
	if !d.Native || d.Proven || d.Reason != NativePending {
		t.Fatalf("a foreign proof must leave the intent pending, got %+v", d)
	}
	// ... and never confirmed within the grace -> withdrawn, latched.
	n = NewNativeMode(time.Minute)
	n.Decide(slotA.Add(time.Second), in)
	d = n.Decide(slotA.Add(62*time.Second), in)
	if d.Native || d.Reason != NativeUnproven {
		t.Fatalf("want nachweis_fehlt, got %+v", d)
	}
}

func TestCoverLoadModeWordStaysNative(t *testing.T) {
	in := good()
	in.Intent = NativeIntentCoverLoad
	in.Levers = allLevers
	in.ProvenIntent = NativeIntentCoverLoad
	in.Window = Window{MinKw: -30, MaxKw: 0}
	d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in)
	if !d.Native || !d.Proven || d.Mode != "native" || d.Intent != NativeIntentCoverLoad {
		t.Fatalf("E↓ keeps battery_mode native: %+v", d)
	}
	// Without a report the pre-existing E↓ also accepts a proof that names no word.
	legacy := good()
	d = NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), legacy)
	if !d.Native || !d.Proven || d.Mode != "native" || d.Intent != NativeIntentCoverLoad {
		t.Fatalf("legacy E↓: %+v", d)
	}
}

func TestWindowPointAndForcedFlowStayWithTheBox(t *testing.T) {
	in := surplusInput()
	in.Window = Window{MinKw: 0, MaxKw: 0.05}
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); d.Native || d.Reason != NativeWindowClosed {
		t.Fatalf("a point is a setpoint: %+v", d)
	}
	in = surplusInput()
	in.Window = Window{MinKw: 4, MaxKw: 30}
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); d.Native || d.Reason != NativeWindowForcesFlow {
		t.Fatalf("a charge floor is a command: %+v", d)
	}
}

func TestWindowNarrowsWithinTheSlotAndReopensOnTheNext(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := surplusInput()
	in.Intent = NativeIntentSelfConsumption
	in.ProvenIntent = NativeIntentSelfConsumption
	in.Window = Window{MinKw: -30, MaxKw: 30}
	n.Decide(slotA.Add(time.Second), in)
	in.Window = Window{MinKw: -30, MaxKw: 0} // SoC touched its upper bound
	if d := n.Decide(slotA.Add(11*time.Second), in); d.Window.MaxKw != 0 {
		t.Fatalf("narrowed: %+v", d.Window)
	}
	in.Window = Window{MinKw: -30, MaxKw: 30} // SoC dipped again
	if d := n.Decide(slotA.Add(21*time.Second), in); d.Window.MaxKw != 0 {
		t.Fatalf("never re-widened within the slot (no device write per SoC blink): %+v", d.Window)
	}
	in.SlotStart = slotB
	if d := n.Decide(slotB.Add(time.Second), in); d.Window.MaxKw != 30 {
		t.Fatalf("the next slot starts from its own window: %+v", d.Window)
	}
}

// F-rules of §6.1 step 5, each latched for the rest of the slot.
func TestChargeSideTakeBacks(t *testing.T) {
	type step struct{ grid, batt float64 }
	cases := []struct {
		name   string
		intent string
		cond   step
		want   string
	}{
		{"Laden bei Bezug in E↑", NativeIntentSurplusCharge, step{grid: 2, batt: 3}, NativeChargeFromGrid},
		{"Laden bei Bezug in E", NativeIntentSelfConsumption, step{grid: 0.8, batt: 0.9}, NativeChargeFromGrid},
		{"Entladen in E↑", NativeIntentSurplusCharge, step{grid: 0, batt: -1.2}, NativeDischargeAgainstIntent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := NewNativeMode(time.Minute)
			in := surplusInput()
			in.Intent, in.ProvenIntent = c.intent, c.intent
			in.GridKw, in.BatteryKw = c.cond.grid, c.cond.batt
			for s := 0; s <= 60; s += 10 {
				d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in)
				if !d.Native {
					t.Fatalf("taken back too early at %d s: %+v", s, d)
				}
			}
			d := n.Decide(slotA.Add(71*time.Second), in)
			if d.Native || d.Reason != c.want || d.Text == "" {
				t.Fatalf("want take-back %s after > 60 s, got %+v", c.want, d)
			}
			in.GridKw, in.BatteryKw = 0, 5
			if d := n.Decide(slotA.Add(81*time.Second), in); d.Native || d.Reason != c.want {
				t.Fatalf("latched until the slot ends: %+v", d)
			}
		})
	}
	// A condition that breaks before the minute is over restarts its clock.
	n := NewNativeMode(time.Minute)
	in := surplusInput()
	for s := 0; s <= 120; s += 10 {
		in.GridKw, in.BatteryKw = 2, 3
		if s == 50 {
			in.GridKw = 0
		}
		if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); !d.Native && s < 110 {
			t.Fatalf("a broken condition must restart its minute (s=%d): %+v", s, d)
		}
	}
	// Below the 0.5 kW threshold nothing happens, ever.
	n = NewNativeMode(time.Minute)
	in = surplusInput()
	in.GridKw, in.BatteryKw = 0.4, 6
	for s := 0; s <= 300; s += 10 {
		if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); !d.Native {
			t.Fatalf("noise must not take back: %+v", d)
		}
	}
}

func TestStorageFullTakesE_upBackButNotE(t *testing.T) {
	in := surplusInput()
	in.SocPct = 95
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); d.Native || d.Reason != NativeStorageFull {
		t.Fatalf("E↑ at the top: %+v", d)
	}
	in.Intent, in.ProvenIntent = NativeIntentSelfConsumption, NativeIntentSelfConsumption
	in.Window = Window{MinKw: -30, MaxKw: 0}
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); !d.Native {
		t.Fatalf("E at the top keeps covering the house: %+v", d)
	}
}

func TestFloorOnlyBindsAnIntentThatDischarges(t *testing.T) {
	in := surplusInput()
	in.SocPct = 21 // below floor + margin
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); !d.Native {
		t.Fatalf("E↑ never discharges - the reserve floor does not bind it: %+v", d)
	}
	in.Intent, in.ProvenIntent = NativeIntentSelfConsumption, NativeIntentSelfConsumption
	in.Window = Window{MinKw: -30, MaxKw: 30}
	if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); d.Native || d.Reason != NativeFloorReached {
		t.Fatalf("E discharges - floor take-back: %+v", d)
	}
}

func TestExportWithHeadroomIsAHintNotATakeBack(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := surplusInput()
	in.GridKw, in.BatteryKw = -6, 2 // Fronius feeds in, the Deye sees only its own PV
	var d NativeDecision
	for s := 0; s <= 120; s += 10 {
		d = n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in)
		if !d.Native {
			t.Fatalf("a hint never takes back: %+v", d)
		}
	}
	if d.Hint != NativeHintExportWithHeadroom || d.HintText == "" {
		t.Fatalf("want the hint after a minute, got %+v", d)
	}
	in.BatteryKw = 29.8 // at its cap: no headroom, no hint
	if d = n.Decide(slotA.Add(131*time.Second), in); d.Hint != "" {
		t.Fatalf("no headroom, no hint: %+v", d)
	}
}

// F12: every change of what the device is asked is one write; a persistent
// lever stops at the day's budget (with room for the exit), a RAM lever is only
// counted.
func TestWriteBudget(t *testing.T) {
	run := func(persistent bool) (engagedSlots, writes int) {
		n := NewNativeMode(time.Minute)
		day := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
		for i := 0; i < 96; i++ {
			slot := day.Add(time.Duration(i) * 15 * time.Minute)
			in := surplusInput()
			in.Levers = &NativeLevers{Intents: allLevers.Intents, Window: true, Persistent: persistent}
			in.SlotStart = slot
			if i%2 == 1 { // alternate E↑ and a sell slot: the worst realistic day
				in.Intent = ""
			}
			d := n.Decide(slot.Add(time.Second), in)
			if d.Native {
				engagedSlots++
			}
			writes = d.WritesToday
		}
		return
	}
	pSlots, pWrites := run(true)
	if pWrites > NativeWriteBudgetPerDay || pSlots != NativeWriteBudgetPerDay/2 {
		t.Fatalf("persistent lever: %d engaged slots, %d writes - budget %d", pSlots, pWrites, NativeWriteBudgetPerDay)
	}
	slots, writes := run(false)
	if slots != 48 || writes != 96 {
		t.Fatalf("RAM lever is counted, not bounded: %d slots, %d writes", slots, writes)
	}
	t.Logf("F12: persistent lever %d engaged slots / %d writes (budget %d), RAM lever %d slots / %d writes counted",
		pSlots, pWrites, NativeWriteBudgetPerDay, slots, writes)
}
