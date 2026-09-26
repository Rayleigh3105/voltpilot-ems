package guards

import (
	"testing"
	"time"
)

// K5 (concept §6.3): a primitive that regulates the grid to 0 (Deye
// "netzseitig Ziel 0") throttles the device's OWN PV once the storage cannot
// take more - also at a positive price. The supervision takes it back to the
// setpoint path, latched for the slot; a plan that caps the PV anyway keeps it.

func curtailingInput(intent string) NativeInput {
	in := surplusInput()
	in.Intent, in.ProvenIntent = intent, intent
	in.ProvenCurtailsOwnPv = true
	return in
}

func TestOwnPvCurtailedAtTheCeiling(t *testing.T) {
	for _, intent := range []string{NativeIntentSurplusCharge, NativeIntentSelfConsumption} {
		t.Run(intent, func(t *testing.T) {
			in := curtailingInput(intent)
			in.SocPct = in.SocMaxPct - NativeCeilingMarginPct + 0.1
			d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in)
			if d.Native || d.Reason != NativeOwnPvCurtailed || d.Text == "" {
				t.Fatalf("want %s at the ceiling, got %+v", NativeOwnPvCurtailed, d)
			}
			// Below the margin: the device keeps regulating.
			in.SocPct = in.SocMaxPct - NativeCeilingMarginPct - 0.5
			if d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in); !d.Native {
				t.Fatalf("below the margin it stays native: %+v", d)
			}
		})
	}
}

func TestOwnPvCurtailedAtTheChargeLimitWhileExporting(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := curtailingInput(NativeIntentSelfConsumption)
	in.Window = Window{MinKw: -30, MaxKw: 30}
	in.GridKw, in.BatteryKw = -2, 29.8 // at the limit, exporting
	for s := 0; s <= 60; s += 10 {
		if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); !d.Native {
			t.Fatalf("not before a full minute (s=%d): %+v", s, d)
		}
	}
	d := n.Decide(slotA.Add(71*time.Second), in)
	if d.Native || d.Reason != NativeOwnPvCurtailed {
		t.Fatalf("want %s after > 60 s, got %+v", NativeOwnPvCurtailed, d)
	}
	in.GridKw, in.BatteryKw = 0, 10
	if d := n.Decide(slotA.Add(81*time.Second), in); d.Native || d.Reason != NativeOwnPvCurtailed {
		t.Fatalf("latched until the slot ends: %+v", d)
	}
	in.SlotStart = slotB
	if d := n.Decide(slotB.Add(time.Second), in); !d.Native {
		t.Fatalf("the next slot re-arms: %+v", d)
	}
}

func TestOwnPvCurtailRuleNeedsItsPreconditions(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*NativeInput)
		ceiling bool // does the SoC-ceiling half still apply?
	}{
		{"a primitive without the side effect (own_config)", func(in *NativeInput) { in.ProvenCurtailsOwnPv = false }, false},
		{"the plan caps the PV anyway (negative price, §51)", func(in *NativeInput) { in.CurtailmentWanted = true }, false},
		{"exporting below the limit is the hint, not this rule", func(in *NativeInput) { in.BatteryKw = 20 }, true},
		{"at the limit without export", func(in *NativeInput) { in.GridKw = -0.2 }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := NewNativeMode(time.Minute)
			in := curtailingInput(NativeIntentSelfConsumption)
			in.Window = Window{MinKw: -30, MaxKw: 30}
			in.GridKw, in.BatteryKw = -2, 29.8
			c.mutate(&in)
			for s := 0; s <= 300; s += 10 {
				if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); d.Reason == NativeOwnPvCurtailed {
					t.Fatalf("must not take back here (s=%d): %+v", s, d)
				}
			}
			// At the SoC ceiling only a curtailing, unwanted primitive is taken back.
			in.SocPct = 94
			d := NewNativeMode(time.Minute).Decide(slotA.Add(time.Second), in)
			if (d.Reason == NativeOwnPvCurtailed) != c.ceiling {
				t.Fatalf("ceiling rule: want fire=%v, got %+v", c.ceiling, d)
			}
		})
	}
}
