package consumersim

import (
	"math"
	"testing"
)

func TestOnOffRunsAtRatedAndOffIsZero(t *testing.T) {
	d := New(Config{ControlKind: KindOnOff, RatedKw: 6})
	on := true
	res := d.Apply(&on, nil, true)
	if !res.On || res.AppliedKw != 6 || res.Mismatch {
		t.Fatalf("on wrong: %+v", res)
	}
	off := false
	res = d.Apply(&off, nil, true)
	if res.On || res.AppliedKw != 0 || res.Mismatch {
		t.Fatalf("off wrong: %+v", res)
	}
}

func TestSteppedSnapsDownToTheHighestLevelAtOrBelowTheWish(t *testing.T) {
	d := New(Config{ControlKind: KindStepped, RatedKw: 4.5, LevelsKw: []float64{0, 1.5, 3.0, 4.5}})
	kw := 2.0
	res := d.Apply(nil, &kw, true)
	if res.AppliedKw != 1.5 || !res.Mismatch {
		t.Fatalf("2.0 on [0,1.5,3,4.5] must snap to 1.5 + mismatch: %+v", res)
	}
	kw = 3.0
	res = d.Apply(nil, &kw, true)
	if res.AppliedKw != 3.0 || res.Mismatch {
		t.Fatalf("an exact level is no mismatch: %+v", res)
	}
	kw = 1.0
	res = d.Apply(nil, &kw, true)
	if res.On || res.AppliedKw != 0 {
		t.Fatalf("below the lowest nonzero level = off: %+v", res)
	}
}

func TestPowerRangesNeverApplyAValueInsideTheGap(t *testing.T) {
	cfg, err := Preset("wallbox")
	if err != nil {
		t.Fatal(err)
	}
	d := New(cfg)
	inGap := 4.0 // between 3.7 and 4.2
	res := d.Apply(nil, &inGap, true)
	if res.AppliedKw != 3.7 || !res.Mismatch {
		t.Fatalf("a gap wish must snap DOWN to the lower range max: %+v", res)
	}
	inRange := 3.0
	res = d.Apply(nil, &inRange, true)
	if res.AppliedKw != 3.0 || res.Mismatch {
		t.Fatalf("an in-range wish executes verbatim: %+v", res)
	}
	high := 22.0
	res = d.Apply(nil, &high, true)
	if res.AppliedKw != 11 || !res.Mismatch {
		t.Fatalf("above the top range: its max: %+v", res)
	}
	low := 0.8
	res = d.Apply(nil, &low, true)
	if res.On || res.AppliedKw != 0 {
		t.Fatalf("below the lowest range min = off: %+v", res)
	}
}

func TestUnavailableDeviceConsumesNothingAndReportsTheMismatch(t *testing.T) {
	cfg, _ := Preset("wallbox")
	d := New(cfg)
	d.SetAvailable(false)
	kw := 11.0
	res := d.Apply(nil, &kw, true)
	if res.On || res.AppliedKw != 0 || !res.Mismatch {
		t.Fatalf("an unplugged vehicle cannot charge: %+v", res)
	}
	d.SetAvailable(true)
	res = d.Apply(nil, &kw, true)
	if !res.On || res.AppliedKw != 11 || res.Mismatch {
		t.Fatalf("available again must execute: %+v", res)
	}
}

func TestControlDisabledDoesNotActAndIsNoMismatch(t *testing.T) {
	d := New(Config{ControlKind: KindOnOff, RatedKw: 2.2})
	on := true
	res := d.Apply(&on, nil, false)
	if res.On || res.AppliedKw != 0 || res.Mismatch {
		t.Fatalf("control_enabled=false must not act (and not lie): %+v", res)
	}
}

func TestOnOffCommandWithoutALevelRunsAtRatedOnContinuous(t *testing.T) {
	cfg, _ := Preset("wallbox")
	d := New(cfg)
	on := true
	res := d.Apply(&on, nil, true)
	if !res.On || res.AppliedKw != 11 || !math.IsNaN(res.CommandedKw) {
		t.Fatalf("bare on_off runs at rated: %+v", res)
	}
}

func TestPresetsExist(t *testing.T) {
	for _, name := range []string{"wallbox", "heating-rod", "heat-pump-sgready", "pump", "stepped-rod"} {
		if _, err := Preset(name); err != nil {
			t.Fatalf("preset %s: %v", name, err)
		}
	}
	if _, err := Preset("toaster"); err == nil {
		t.Fatal("unknown preset must refuse")
	}
}

// Der SG-Ready-Freigabekontakt (Verbrauchsmanagement v1 P8): er ist GESETZT und
// verbraucht dabei nichts. Ohne die eigene Regel fiele er auf "applied <= 0 ist
// aus" durch und meldete eine Freigabe, die er gesetzt hat, als aufgehoben.
func TestReleaseContactIsOnWhileConsumingNothing(t *testing.T) {
	d := New(mustPreset(t, "heat-pump-sgready"))
	on := true
	got := d.Apply(&on, nil, true)
	if !got.On || got.AppliedKw != 0 || got.Mismatch {
		t.Fatalf("Freigabe gesetzt: got %+v, want On=true AppliedKw=0 ohne Mismatch", got)
	}
	off := false
	got = d.Apply(&off, nil, true)
	if got.On || got.AppliedKw != 0 {
		t.Fatalf("Freigabe aufgehoben: got %+v", got)
	}
	// Der Kontrast: ein Heizstab MIT Nennleistung meldet sie weiterhin.
	rod := New(mustPreset(t, "heating-rod"))
	if r := rod.Apply(&on, nil, true); !r.On || r.AppliedKw != 6 {
		t.Fatalf("heating-rod: got %+v, want 6 kW", r)
	}
}

func mustPreset(t *testing.T, name string) Config {
	t.Helper()
	cfg, err := Preset(name)
	if err != nil {
		t.Fatalf("preset %s: %v", name, err)
	}
	return cfg
}
