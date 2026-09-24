package guards

import (
	"math"
	"testing"
	"time"
)

// vp-wr-deye-tou-schreibbudget: in a proven E↓ the device may cover the house
// from the storage, never sell storage energy. When the battery discharges while
// the grid point exports - the storage's share of the export, min(discharge,
// export), above 0.5 kW - for longer than 60 s, the supervision takes the
// battery back, latched until the slot ends.

func coverInput() NativeInput {
	in := good()
	in.Levers = &NativeLevers{Intents: []string{NativeIntentCoverLoad}}
	in.Intent, in.ProvenIntent = NativeIntentCoverLoad, NativeIntentCoverLoad
	in.Window = Window{MinKw: -30, MaxKw: 0}
	in.GridKw, in.BatteryKw = 0.1, -6 // covering the house, grid at ~0
	return in
}

func TestStorageExportInCoverLoadTakesBackAfterAMinute(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := coverInput()
	if d := n.Decide(slotA.Add(time.Second), in); !d.Native || !d.Proven {
		t.Fatalf("a covering device stays native: %+v", d)
	}
	// The storage discharges 8 kW while the grid point exports 2 kW: 2 kW of it
	// is storage energy sold.
	in.GridKw, in.BatteryKw = -2, -8
	for s := 10; s <= 70; s += 10 {
		if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); !d.Native {
			t.Fatalf("not before a full minute (s=%d): %+v", s, d)
		}
	}
	d := n.Decide(slotA.Add(81*time.Second), in)
	if d.Native || d.Reason != NativeStorageExport || d.Text == "" {
		t.Fatalf("want %s after > 60 s, got %+v", NativeStorageExport, d)
	}
	// Latched until the slot ends, even once the export stopped.
	in.GridKw, in.BatteryKw = 0.1, -6
	if d := n.Decide(slotA.Add(91*time.Second), in); d.Native || d.Reason != NativeStorageExport {
		t.Fatalf("latched until the slot ends: %+v", d)
	}
	in.SlotStart = slotB
	if d := n.Decide(slotB.Add(time.Second), in); !d.Native {
		t.Fatalf("the next slot re-arms: %+v", d)
	}
}

func TestStorageExportAlsoWatchesTheLegacyCoverPath(t *testing.T) {
	// A Layer 1 without a report hands over the pre-existing E↓ on the duty
	// alone; the watch applies to it just the same.
	n := NewNativeMode(time.Minute)
	in := good()
	in.GridKw, in.BatteryKw = -1, -5
	for s := 0; s <= 60; s += 10 {
		n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in)
	}
	if d := n.Decide(slotA.Add(71*time.Second), in); d.Native || d.Reason != NativeStorageExport {
		t.Fatalf("want %s on the legacy E↓, got %+v", NativeStorageExport, d)
	}
}

func TestStorageExportNeedsBothHalves(t *testing.T) {
	cases := []struct {
		name       string
		grid, batt float64
	}{
		{"PV exports beside a covering battery (battery idle)", -3, 0},
		{"PV exports while the battery charges", -3, 4},
		{"the battery covers, the grid imports", 1.5, -6},
		{"storage share at 0.5 kW is noise, not a sale", -0.5, -6},
		{"a small discharge beside a big PV export", -6, -0.4},
		{"unknown grid reading", math.NaN(), -8},
		{"unknown battery reading", -2, math.NaN()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := NewNativeMode(time.Minute)
			in := coverInput()
			in.GridKw, in.BatteryKw = c.grid, c.batt
			for s := 0; s <= 300; s += 10 {
				if d := n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in); !d.Native {
					t.Fatalf("s=%d: must stay native, got %+v", s, d)
				}
			}
		})
	}
}

func TestStorageExportIntervalRestartsWhenItBreaks(t *testing.T) {
	n := NewNativeMode(time.Minute)
	in := coverInput()
	in.GridKw, in.BatteryKw = -2, -8
	n.Decide(slotA.Add(1*time.Second), in)
	n.Decide(slotA.Add(50*time.Second), in)
	in.GridKw = 0.2 // one tick without export
	n.Decide(slotA.Add(55*time.Second), in)
	in.GridKw = -2
	for s := 60; s <= 110; s += 10 {
		if d := n.Decide(slotA.Add(time.Duration(s)*time.Second), in); !d.Native {
			t.Fatalf("a broken interval starts over (s=%d): %+v", s, d)
		}
	}
	if d := n.Decide(slotA.Add(121*time.Second), in); d.Native || d.Reason != NativeStorageExport {
		t.Fatalf("want %s after a full minute again, got %+v", NativeStorageExport, d)
	}
}

func TestStorageExportWatchesEveryIntentThatMayDischarge(t *testing.T) {
	// E and E~ promise no sale of storage energy either; E↑ never discharges and
	// has its own rule (entladen_gegen_absicht).
	n := NewNativeMode(time.Minute)
	in := surplusInput()
	in.Intent, in.ProvenIntent = NativeIntentSelfConsumption, NativeIntentSelfConsumption
	in.Window = Window{MinKw: -30, MaxKw: 30}
	in.GridKw, in.BatteryKw = -2, -8
	for s := 0; s <= 60; s += 10 {
		n.Decide(slotA.Add(time.Duration(s+1)*time.Second), in)
	}
	if d := n.Decide(slotA.Add(71*time.Second), in); d.Native || d.Reason != NativeStorageExport {
		t.Fatalf("want %s in E, got %+v", NativeStorageExport, d)
	}
	// Not proven yet (pending): nothing of ours is regulating, nothing to watch.
	n2 := NewNativeMode(5 * time.Minute)
	in2 := coverInput()
	in2.Proven = false
	in2.GridKw, in2.BatteryKw = -2, -8
	for s := 0; s <= 120; s += 10 {
		if d := n2.Decide(slotA.Add(time.Duration(s+1)*time.Second), in2); !d.Native || d.Reason != NativePending {
			t.Fatalf("s=%d: an unproven hand-over is pending, not watched: %+v", s, d)
		}
	}
}
