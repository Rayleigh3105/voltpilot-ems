package guards

import (
	"math"
	"testing"
	"time"
)

// "Genau ein Führungsgerät je Netzpunkt": the rule as a table - every refusal
// names its own cause, and only the one complete, consistent statement leads.
func TestOnlyTheLeaderAtTheGridPointMayRegulateItself(t *testing.T) {
	cases := []struct {
		name string
		in   LeaderInput
		want string // "" = leads
	}{
		{"meter at the grid point, alone", LeaderInput{MeterAtGridPoint, "", MeterPlausibilityUnchecked}, ""},
		{"meter at the grid point, meter comparison fits", LeaderInput{MeterAtGridPoint, FurtherStorageNone, MeterPlausibilityOK}, ""},
		{"a second storage follows (master/slave)", LeaderInput{MeterAtGridPoint, FurtherStorageFollower, MeterPlausibilityOK}, ""},
		{"a second storage holds / fixed setpoint", LeaderInput{MeterAtGridPoint, FurtherStorageHold, ""}, ""},
		{"a second storage regulates itself", LeaderInput{MeterAtGridPoint, FurtherStorageSelfRegulating, MeterPlausibilityOK}, NativeSecondRegulator},
		{"an unknown word about a second storage", LeaderInput{MeterAtGridPoint, "vielleicht", MeterPlausibilityOK}, NativeSecondRegulator},
		{"meter elsewhere", LeaderInput{MeterElsewhere, "", MeterPlausibilityUnchecked}, NativeMeterElsewhere},
		{"meter location not stated", LeaderInput{"", "", MeterPlausibilityOK}, NativeMeterLocationMissing},
		{"meter location unknown", LeaderInput{MeterUnknown, "", MeterPlausibilityOK}, NativeMeterLocationMissing},
		{"declared at the grid point, measured elsewhere", LeaderInput{MeterAtGridPoint, "", MeterPlausibilityMismatch}, NativeMeterImplausible},
		{"a second regulator outranks the meter question", LeaderInput{MeterElsewhere, FurtherStorageSelfRegulating, ""}, NativeSecondRegulator},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := LeaderFor(c.in)
			if v.Leads != (c.want == "") || v.Reason != c.want {
				t.Fatalf("got %+v, want reason %q", v, c.want)
			}
			if c.want != "" && v.Text == "" {
				t.Fatalf("a refusal must carry its German sentence: %+v", v)
			}
		})
	}
}

// F11 on the measurement side: a device meter that does not see the second PV
// system differs from the box's Netz meter by that system's output, persistently.
// One honest outlier pair (a load step read at different moments) does not.
func TestMeterCheckSeparatesAForeignPvSystemFromReadingSkew(t *testing.T) {
	t0 := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	feed := func(m *MeterCheck, n int, dev, meter func(i int) float64) time.Time {
		at := t0
		for i := 0; i < n; i++ {
			at = t0.Add(time.Duration(i) * 10 * time.Second)
			m.Observe(at, dev(i), meter(i), 2*time.Second)
		}
		return at
	}

	var fits MeterCheck
	end := feed(&fits, 18, func(i int) float64 {
		if i == 7 {
			return 9 // a load step the device read first
		}
		return -12.2
	}, func(int) float64 { return -12 })
	if v := fits.Verdict(end); v.State != MeterPlausibilityOK {
		t.Fatalf("the same connection point must fit: %+v", v)
	}

	var foreign MeterCheck
	// The device sees only its own branch: +3 kW import while the connection
	// point exports the Fronius' 17 kW.
	end = feed(&foreign, 18, func(int) float64 { return 3 }, func(int) float64 { return -17 })
	v := foreign.Verdict(end)
	if v.State != MeterPlausibilityMismatch || math.Abs(v.DeviationKw-20) > 1e-9 {
		t.Fatalf("a meter that misses the second PV system must not fit: %+v", v)
	}

	var early MeterCheck
	end = feed(&early, 6, func(int) float64 { return 3 }, func(int) float64 { return -17 })
	if v := early.Verdict(end); v.State != MeterPlausibilityUnchecked {
		t.Fatalf("a minute of pairs is no verdict yet: %+v", v)
	}
}

func TestMeterCheckIgnoresPairsThatAreNotPairs(t *testing.T) {
	t0 := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	var m MeterCheck
	for i := 0; i < 20; i++ {
		at := t0.Add(time.Duration(i) * 10 * time.Second)
		m.Observe(at, 3, -17, 45*time.Second) // a stale meter reading
		m.Observe(at, math.NaN(), -17, 0)
	}
	if v := m.Verdict(t0.Add(200 * time.Second)); v.State != MeterPlausibilityUnchecked || v.Pairs != 0 {
		t.Fatalf("stale or unknown halves must not form pairs: %+v", v)
	}
	// Pairs fall out of the window: an old mismatch does not outlive a fix.
	for i := 0; i < 20; i++ {
		m.Observe(t0.Add(time.Duration(i)*10*time.Second), 3, -17, 0)
	}
	later := t0.Add(time.Hour)
	for i := 0; i < 20; i++ {
		m.Observe(later.Add(time.Duration(i)*10*time.Second), -17.1, -17, 0)
	}
	if v := m.Verdict(later.Add(200 * time.Second)); v.State != MeterPlausibilityOK {
		t.Fatalf("after the fix the comparison must fit again: %+v", v)
	}
	m.Reset()
	if v := m.Verdict(later.Add(200 * time.Second)); v.Pairs != 0 {
		t.Fatalf("reset must forget: %+v", v)
	}
}
