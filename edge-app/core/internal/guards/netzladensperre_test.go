package guards

import (
	"math"
	"testing"
	"time"
)

// The Netzladen-Sperre (EN-1 A, 2026-11-02): with grid charging not allowed
// the last stage caps a charge at max(measured pv - load - 1 kW, 0), gives 0
// on an unknown or older than 30 s reading, lowers at once and raises damped.

var sperreT0 = time.Date(2026, 11, 2, 9, 30, 0, 0, time.UTC)

func sperreReading(pv, load float64) Reading {
	return Reading{SocPct: 50, PvKw: pv, LoadKw: load, GridLimitKw: Unknown()}
}

// sperreLive evaluates the lock on a live reading alone: no control reading,
// no grid value - the device without a follower (Profile Off or no pair yet).
func sperreLive(s *NetzladenSperre, now time.Time, kw float64, active bool, r Reading, at time.Time, p DampProfile) NetzladenSperreResult {
	return s.Apply(now, NetzladenSperreInput{
		Active: active, CommandKw: kw, Live: r, LiveAt: at,
		Control: Reading{SocPct: Unknown(), PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()},
		GridKw:  math.NaN(), Profile: p,
	})
}

func TestNetzladenSperreHoldsTheReserveOnTheExportSide(t *testing.T) {
	s := NewNetzladenSperre()
	got := sperreLive(s, sperreT0, 8, true, sperreReading(10, 4), sperreT0, DefaultDampProfile())
	if !got.Active || !got.Lowered || got.Kw != 10-4-NetzladenReserveKw {
		t.Fatalf("%+v, want 8 kW lowered to the surplus 6 minus the reserve", got)
	}
	// A command inside the bound passes untouched.
	got = sperreLive(s, sperreT0.Add(time.Second), 3, true, sperreReading(10, 4), sperreT0, DefaultDampProfile())
	if got.Lowered || got.Kw != 3 {
		t.Fatalf("%+v, want 3 untouched", got)
	}
}

func TestNetzladenSperreChargesNothingWhileTheHouseImports(t *testing.T) {
	// Herzogau 02.11.2026: house 6,5 kW, PV 1-3 kW, the plan wanted +7,6 kW.
	for _, pv := range []float64{1, 2, 3} {
		s := NewNetzladenSperre()
		got := sperreLive(s, sperreT0, 7.6, true, sperreReading(pv, 6.5), sperreT0, DefaultDampProfile())
		if got.Kw != 0 || !got.Lowered {
			t.Fatalf("pv %v: %+v, want 0", pv, got)
		}
	}
	// A surplus smaller than the reserve is no room either.
	s := NewNetzladenSperre()
	if got := sperreLive(s, sperreT0, 5, true, sperreReading(7.2, 6.5), sperreT0, DefaultDampProfile()); got.Kw != 0 {
		t.Fatalf("%+v, want 0 below the reserve", got)
	}
}

func TestNetzladenSperreAgeLimitAndUnknownGiveZero(t *testing.T) {
	r := sperreReading(20, 2)
	cases := []struct {
		name      string
		readingAt time.Time
		r         Reading
		blind     bool
	}{
		{"fresh at the limit", sperreT0.Add(-NetzladenMessAlter), r, false},
		{"one second too old", sperreT0.Add(-NetzladenMessAlter - time.Second), r, true},
		{"no reading time at all", time.Time{}, r, true},
		{"unknown pv", sperreT0, Reading{SocPct: 50, PvKw: Unknown(), LoadKw: 2}, true},
		{"unknown load", sperreT0, Reading{SocPct: 50, PvKw: 20, LoadKw: Unknown()}, true},
		{"a reading stamped just after the tick is fresh", sperreT0.Add(50 * time.Millisecond), r, false},
	}
	for _, c := range cases {
		s := NewNetzladenSperre()
		got := sperreLive(s, sperreT0, 10, true, c.r, c.readingAt, DefaultDampProfile())
		if got.Blind != c.blind {
			t.Fatalf("%s: blind = %v, want %v", c.name, got.Blind, c.blind)
		}
		if c.blind && (got.Kw != 0 || got.CapKw != 0 || !math.IsNaN(got.SurplusKw)) {
			t.Fatalf("%s: %+v, want 0 kW on a blind reading", c.name, got)
		}
		if !c.blind && got.Kw != 10 {
			t.Fatalf("%s: %+v, want 10 untouched (bound 17)", c.name, got)
		}
	}
}

func TestNetzladenSperreNeverTouchesDischargeOrRest(t *testing.T) {
	s := NewNetzladenSperre()
	for _, kw := range []float64{-12.345, -0.001, 0} {
		got := sperreLive(s, sperreT0, kw, true, sperreReading(0, 6.5), time.Time{}, DefaultDampProfile())
		if got.Kw != kw || got.Lowered {
			t.Fatalf("command %v: %+v, want untouched", kw, got)
		}
	}
}

func TestNetzladenSperreIsANoOpWhereGridChargingIsAllowed(t *testing.T) {
	// The counter-test: a plant with grid charging allowed keeps its command
	// byte for byte, blind or not, importing or not.
	s := NewNetzladenSperre()
	for _, kw := range []float64{30, 7.654321, -4, 0} {
		for _, r := range []Reading{sperreReading(0, 6.5), sperreReading(20, 2), {SocPct: Unknown(), PvKw: Unknown(), LoadKw: Unknown()}} {
			got := sperreLive(s, sperreT0, kw, false, r, time.Time{}, DefaultDampProfile())
			if got.Active || got.Lowered || got.Kw != kw {
				t.Fatalf("merchant %v on %+v: %+v, want untouched", kw, r, got)
			}
		}
	}
}

func TestNetzladenSperreLowersAtOnceAndRaisesDamped(t *testing.T) {
	p := DefaultDampProfile() // Settle 15 s, Ramp 3 kW
	s := NewNetzladenSperre()
	at := sperreT0
	// Full sun: bound 18.
	if got := sperreLive(s, at, 25, true, sperreReading(21, 2), at, p); got.Kw != 18 {
		t.Fatalf("start: %+v, want 18", got)
	}
	// A cloud: the very next reading lowers at once - no settle, no ramp -
	// the deadband below the bound the reading allows (6 - 2 - 1 - 0.2).
	at = at.Add(5 * time.Second)
	if got := sperreLive(s, at, 25, true, sperreReading(6, 2), at, p); got.Kw != 3-p.DeadbandKw {
		t.Fatalf("cloud: %+v, want 2.8 at once", got)
	}
	// The sun returns 5 s later: a reading taken before the settle time after
	// the cut must not raise (it can be the echo of the cut).
	at = at.Add(5 * time.Second)
	if got := sperreLive(s, at, 25, true, sperreReading(21, 2), at, p); got.Kw != 2.8 {
		t.Fatalf("unsettled: %+v, want 2.8 held", got)
	}
	// A reading taken after the settle time raises by one ramp step only.
	at = at.Add(11 * time.Second) // 16 s after the cut
	if got := sperreLive(s, at, 25, true, sperreReading(21, 2), at, p); got.Kw != 5.8 {
		t.Fatalf("first step: %+v, want 2.8 + 3", got)
	}
	// The same reading again (no new measurement) never raises twice.
	if got := sperreLive(s, at.Add(10*time.Second), 25, true, sperreReading(21, 2), at, p); got.Kw != 5.8 {
		t.Fatalf("same reading: %+v, want 5.8 held", got)
	}
	// Step by step up to the bound, one ramp per settled reading - it stops
	// the deadband short of the bound the reading allows.
	want := 5.8
	for i := 0; i < 6; i++ {
		at = at.Add(16 * time.Second)
		want = math.Min(want+p.RampKw, 18-p.DeadbandKw)
		if got := sperreLive(s, at, 25, true, sperreReading(21, 2), at, p); math.Abs(got.Kw-want) > 1e-9 {
			t.Fatalf("step %d: %+v, want %v", i, got, want)
		}
	}
	if math.Abs(want-(18-p.DeadbandKw)) > 1e-9 {
		t.Fatalf("the ramp ended at %v, want the bound 18 less the deadband", want)
	}
}

func TestNetzladenSperreStartsAtZeroAfterABlindSpell(t *testing.T) {
	p := DefaultDampProfile()
	s := NewNetzladenSperre()
	at := sperreT0
	sperreLive(s, at, 10, true, sperreReading(20, 2), at, p)
	// The measurement stops: 31 s later the bound is 0.
	at = at.Add(31 * time.Second)
	if got := sperreLive(s, at, 10, true, sperreReading(20, 2), sperreT0, p); got.Kw != 0 || !got.Blind {
		t.Fatalf("stale: %+v, want 0", got)
	}
	// A fresh reading after the settle time: one ramp step, not a jump to 10.
	at = at.Add(16 * time.Second)
	if got := sperreLive(s, at, 10, true, sperreReading(20, 2), at, p); got.Kw != p.RampKw {
		t.Fatalf("after the blind spell: %+v, want one ramp step %v", got, p.RampKw)
	}
}

func TestNetzladenSperreOffProfileStillDamps(t *testing.T) {
	// A device whose control profile turns the K1 damper off (a persistent
	// lever) still gets a damped rise of the bound - the lock always damps.
	s := NewNetzladenSperre()
	at := sperreT0
	sperreLive(s, at, 10, true, sperreReading(2, 2), at, DampProfile{Off: true})
	at = at.Add(time.Second)
	if got := sperreLive(s, at, 10, true, sperreReading(20, 2), at, DampProfile{Off: true}); got.Kw != 0 {
		t.Fatalf("%+v, want 0 until a settled reading", got)
	}
	at = at.Add(DefaultDampProfile().Settle)
	if got := sperreLive(s, at, 10, true, sperreReading(20, 2), at, DampProfile{Off: true}); got.Kw != DefaultDampProfile().RampKw {
		t.Fatalf("%+v, want one default ramp step", got)
	}
}

func TestNetzladenSperreReleasedStartsFromTheReadingAgain(t *testing.T) {
	s := NewNetzladenSperre()
	sperreLive(s, sperreT0, 10, true, sperreReading(2, 2), sperreT0, DefaultDampProfile())
	// The plant's posture changes to "grid charging allowed" and back: the lock
	// starts over from the reading, not from its old bound.
	sperreLive(s, sperreT0.Add(time.Second), 10, false, sperreReading(2, 2), sperreT0, DefaultDampProfile())
	at := sperreT0.Add(2 * time.Second)
	if got := sperreLive(s, at, 10, true, sperreReading(20, 2), at, DefaultDampProfile()); got.Kw != 10 {
		t.Fatalf("%+v, want 10 (bound 17 from the reading)", got)
	}
}

// THE READING: right after a raise the live pair can show the echo of the
// write (a new grid half beside an old battery half: a smaller surplus). The
// bound rests on the follower's control reading, so the echo does not cut -
// unless the fresh live grid value shows real import, which cuts at once on
// the live reading.
func TestNetzladenSperreRestsOnTheControlReadingAndCutsOnRealImport(t *testing.T) {
	p := DefaultDampProfile()
	s := NewNetzladenSperre()
	ctl := sperreReading(20, 4) // settled pair: surplus 16, bound 15
	in := NetzladenSperreInput{Active: true, CommandKw: 15, Live: ctl, LiveAt: sperreT0, Control: ctl,
		GridKw: -1, GridFresh: true, Profile: p}
	if got := s.Apply(sperreT0, in); got.Kw != 15 || got.Lowered {
		t.Fatalf("settled: %+v, want 15 untouched", got)
	}
	// The echo: live surplus looks 6 kW smaller, the grid still exports 1 kW.
	in.Live, in.LiveAt, in.GridKw = sperreReading(20, 10), sperreT0.Add(5*time.Second), -1
	if got := s.Apply(sperreT0.Add(5*time.Second), in); got.Kw != 15 || got.Lowered || got.Importing {
		t.Fatalf("echo: %+v, want 15 held (no import at the meter)", got)
	}
	// A real cloud: the meter imports 4 kW while the battery charges - cut at
	// once to the live bound, whatever the control reading still says.
	in.Live, in.LiveAt, in.GridKw = sperreReading(12, 4.5), sperreT0.Add(10*time.Second), 4
	got := s.Apply(sperreT0.Add(10*time.Second), in)
	if want := 12 - 4.5 - NetzladenReserveKw - p.DeadbandKw; !got.Importing || !got.Lowered || math.Abs(got.Kw-want) > 1e-9 {
		t.Fatalf("import: %+v, want the live bound less the deadband %v at once", got, want)
	}
	// Import below the meter-noise threshold, or a stale grid value, is no
	// evidence; a discharge never counts as charging into an import.
	s2 := NewNetzladenSperre()
	in2 := NetzladenSperreInput{Active: true, CommandKw: 15, Live: sperreReading(12, 4.5), LiveAt: sperreT0,
		Control: ctl, GridKw: NetzladenBezugKw, GridFresh: true, Profile: p}
	if got := s2.Apply(sperreT0, in2); got.Importing || got.Kw != 15 {
		t.Fatalf("noise: %+v, want 15 on the control reading", got)
	}
	in2.GridKw, in2.GridFresh = 5, false
	if got := s2.Apply(sperreT0, in2); got.Importing {
		t.Fatalf("stale grid: %+v, want no import verdict", got)
	}
	in2.CommandKw, in2.GridFresh = -3, true
	if got := s2.Apply(sperreT0, in2); got.Importing || got.Kw != -3 {
		t.Fatalf("discharge: %+v, want -3 untouched", got)
	}
}

// THE DEADBAND: a derived house load that wanders by a few tens of watts does
// not rewrite the device, and the bound never rises above the reading.
func TestNetzladenSperreDoesNotFollowMeterNoise(t *testing.T) {
	p := DefaultDampProfile()
	s := NewNetzladenSperre()
	at := sperreT0
	got := sperreLive(s, at, 30, true, sperreReading(30, 13), at, p) // bound 16
	if got.Kw != 16 {
		t.Fatalf("start: %+v, want 16", got)
	}
	writes, last := 0, got.Kw
	for i, load := range []float64{13.03, 12.97, 13.09, 12.98, 13.0, 13.06, 12.99, 13.02, 12.97, 13.05} {
		at = at.Add(10 * time.Second)
		got = sperreLive(s, at, 30, true, sperreReading(30, load), at, p)
		if got.Kw > 30-load-NetzladenReserveKw+1e-9 {
			t.Fatalf("tick %d: %v above the bound the reading allows (load %v)", i, got.Kw, load)
		}
		if math.Abs(got.Kw-last) > 0.005 {
			writes++
			last = got.Kw
		}
	}
	if writes > 1 {
		t.Fatalf("%d rewrites on +-0.05 kW of meter noise, want at most the one first step down", writes)
	}
}

// LIMITED PV: at a negative price the plan curtails and charges; the box's own
// tracker caps the PV at house + battery (zero export). The measured surplus is
// then exactly what the battery takes, so a reserve bound on it would lower
// the charge by the reserve on every reading and the cap with it - down to 0.
// With the box's cap known and a fresh grid value the bound rests and the meter
// judges; without that knowledge the ratchet is what happens (the counter-case
// that shows why the input exists).
func TestNetzladenSperreDoesNotRatchetUnderItsOwnCurtailment(t *testing.T) {
	p := DefaultDampProfile()
	run := func(knowsTheCap bool, deviceLimit *float64) float64 {
		s := NewNetzladenSperre()
		const availPv, house, plan = 45.0, 10.0, 30.0
		out := plan
		var cap *float64
		for i := 0; i < 40; i++ {
			at := sperreT0.Add(time.Duration(i) * 20 * time.Second)
			// The plant: PV held at house + battery by the box's cap (or at
			// house + battery + device limit by the device), the battery
			// follows the last command.
			pv := availPv
			if cap != nil {
				pv = math.Min(availPv, *cap)
			}
			if deviceLimit != nil {
				pv = math.Min(pv, house+out+*deviceLimit)
			}
			grid := house + out - pv
			in := NetzladenSperreInput{Active: true, CommandKw: plan, Live: sperreReading(pv, house), LiveAt: at,
				Control: sperreReading(pv, house), GridKw: grid, GridFresh: true, Profile: p,
				DeviceExportLimitKw: deviceLimit}
			if knowsTheCap {
				in.PvCapKw = cap
			}
			out = s.Apply(at, in).Kw
			c := house + out // the tracker's law for the next tick
			if deviceLimit == nil {
				cap = &c
			}
		}
		return out
	}
	if got := run(true, nil); got != 30 {
		t.Fatalf("own curtailment known: charge %v, want the plan's 30 standing", got)
	}
	if got := run(false, nil); got > 1 {
		t.Fatalf("counter-case: without the cap the charge stood at %v - the ratchet this input prevents did not show", got)
	}
	zero := 0.0
	if got := run(false, &zero); got != 30 {
		t.Fatalf("device holds zero feed-in: charge %v, want the plan's 30 standing", got)
	}
}

// LIMITED PV does not lift the protection: when the curtailed plant cannot
// cover the charge (a cloud), the meter imports and the charge is cut at once.
func TestNetzladenSperreCutsOnImportEvenWithLimitedPv(t *testing.T) {
	p := DefaultDampProfile()
	s := NewNetzladenSperre()
	cap := 40.0
	in := NetzladenSperreInput{Active: true, CommandKw: 30, Live: sperreReading(40, 10), LiveAt: sperreT0,
		Control: sperreReading(40, 10), GridKw: 0, GridFresh: true, Profile: p, PvCapKw: &cap}
	if got := s.Apply(sperreT0, in); got.Kw != 30 || !got.PvLimited {
		t.Fatalf("at the cap: %+v, want 30 and limited", got)
	}
	in.Live, in.LiveAt, in.GridKw = sperreReading(22, 10), sperreT0.Add(10*time.Second), 18
	got := s.Apply(sperreT0.Add(10*time.Second), in)
	if !got.Importing || got.Kw != 22-10-NetzladenReserveKw-p.DeadbandKw {
		t.Fatalf("cloud under the cap: %+v, want the live bound less the deadband at once", got)
	}
	// Without a fresh grid value the cap knowledge counts for nothing: the
	// reserve bound applies.
	s2 := NewNetzladenSperre()
	in.Live, in.LiveAt, in.GridKw, in.GridFresh = sperreReading(40, 10), sperreT0, math.NaN(), false
	if got := s2.Apply(sperreT0, in); got.PvLimited || got.Kw != 29 {
		t.Fatalf("no grid value: %+v, want the reserve bound 29", got)
	}
}
