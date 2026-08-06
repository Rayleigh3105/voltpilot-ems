package guards

import (
	"math"
	"strings"
	"testing"
	"time"
)

// plant is the smallest honest simulation of the Pilsting site for the loop
// tests: producers that follow the commanded cap with ONE cycle of actuation
// dead time (the cap written this cycle takes effect next cycle - the real
// Modbus write + WMaxLimPct ramp), a house load, and a battery.
//
// pv     = min(potential, applied cap)
// grid   = load + battery - pv        (+ import / - export)
type plant struct {
	potential float64
	load      float64
	battery   float64 // + charge / - discharge
	applied   float64
	capValid  bool
}

func (p *plant) pv() float64 {
	if !p.capValid {
		return p.potential
	}
	return math.Min(p.potential, p.applied)
}

func (p *plant) grid() float64 { return p.load + p.battery - p.pv() }

func (p *plant) export() float64 { return math.Max(-p.grid(), 0) }

// step advances one control cycle: observe the CURRENT operating point, ask the
// watchdog for a cap, and only THEN let the plant adopt it (dead time).
func (p *plant) step(t *testing.T, l *ExportLimiter, now time.Time, limit float64, safe float64) ExportCap {
	t.Helper()
	l.Observe(now, p.grid(), p.pv())
	c := l.Cap(now, &limit, safe)
	if !c.Active {
		t.Fatalf("watchdog inactive with a configured limit")
	}
	p.applied, p.capValid = c.CapKw, true
	return c
}

const tick = 10 * time.Second

func TestNoLimitConfiguredMeansNoCapIsEverInvented(t *testing.T) {
	l := NewExportLimiter()
	now := time.Now().UTC()
	l.Observe(now, -40, 45)

	c := l.Cap(now, nil, 30)
	if c.Active || c.State != ExportOff || c.CapKw != 0 {
		t.Fatalf("no limit must produce no cap, got %+v", c)
	}
	// A garbage limit is refused just as hard - a compliance target is never
	// guessed from a malformed payload.
	for _, bad := range []float64{-1, math.NaN(), math.Inf(1)} {
		if got := l.Cap(now, &bad, 30); got.Active {
			t.Fatalf("limit %v must not activate the watchdog", bad)
		}
	}
}

// The captain's live case: the plant sits comfortably under the limit because a
// car is charging; the car is unplugged and the feed-in jumps. The watchdog must
// pull the producers back at once and the limit must hold from the next cycle.
func TestUnpluggedWallboxIsPulledBackWithinOneCycleAndTheLimitHolds(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()

	// 40 kW of PV potential, 15 kW house (11 kW of it the car): export 25 kW.
	p := &plant{potential: 40, load: 15}
	for i := 0; i < 4; i++ {
		p.step(t, l, now, limit, exportSafe(limit, p.battery))
		now = now.Add(tick)
	}
	if p.export() > limit {
		t.Fatalf("baseline already over the limit: %.2f kW", p.export())
	}
	if got, _ := l.CommandedCap(); got < p.potential {
		t.Fatalf("with 5 kW of headroom the cap should not hold the plant back, got %.2f", got)
	}

	// The car is unplugged: 11 kW of load vanish. This cycle STILL overruns -
	// no measurement-based controller can prevent the step itself.
	p.load = 4
	overrun := p.export()
	if overrun <= limit {
		t.Fatalf("the test does not reproduce the symptom: export %.2f kW", overrun)
	}
	c := p.step(t, l, now, limit, exportSafe(limit, p.battery))
	if c.State != ExportLimiting {
		t.Fatalf("a breach must put the watchdog into %q, got %q (%s)", ExportLimiting, c.State, c.Reason)
	}
	now = now.Add(tick)

	// From the very next cycle the limit holds, and keeps holding.
	for i := 0; i < 20; i++ {
		p.step(t, l, now, limit, exportSafe(limit, p.battery))
		if p.export() > limit+1e-6 {
			t.Fatalf("cycle %d: export %.3f kW exceeds the %.1f kW limit", i, p.export(), limit)
		}
		now = now.Add(tick)
	}
	// ...and it does not throw away yield: the plant runs just under the limit.
	if p.export() < limit-2*exportMargin(limit) {
		t.Fatalf("over-curtailed: export %.3f kW against a %.1f kW limit", p.export(), limit)
	}
}

// A fresh sample that demands a tighter cap than the one in force is URGENT, so
// the setpoint can be republished at once instead of waiting for the next tick.
// That is what makes the reaction one measurement cycle instead of two.
func TestATighteningSampleIsUrgentAndAReleasingOneIsNot(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()
	p := &plant{potential: 40, load: 15}
	p.step(t, l, now, limit, exportSafe(limit, 0))
	now = now.Add(tick)

	p.load = 4 // car unplugged
	if !l.Observe(now, p.grid(), p.pv()) {
		t.Fatalf("a breach sample must be urgent")
	}
	// The mirror image never is: a release must go through its rate limit.
	p.load = 20
	if l.Observe(now.Add(time.Second), p.grid(), p.pv()) {
		t.Fatalf("a releasing sample must never be urgent")
	}
	// Neither is an incomplete sample - it is not a measurement at all.
	if l.Observe(now.Add(2*time.Second), Unknown(), 10) {
		t.Fatalf("a sample without grid power must not be urgent")
	}
}

// The car is plugged back in: room appears, and the watchdog gives it back
// SLOWLY - it must not chase its own actuation.
func TestReleaseIsRateLimitedAndConverges(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()

	p := &plant{potential: 40, load: 4}
	for i := 0; i < 6; i++ {
		p.step(t, l, now, limit, exportSafe(limit, 0))
		now = now.Add(tick)
	}
	capped, _ := l.CommandedCap()
	if capped > 35 {
		t.Fatalf("expected the plant to be held back, cap %.2f", capped)
	}

	// Car plugged in: +11 kW of load.
	p.load = 15
	c := p.step(t, l, now, limit, exportSafe(limit, 0))
	now = now.Add(tick)
	rise := c.CapKw - capped
	maxStep := releaseRate(limit) * tick.Seconds()
	if rise > maxStep+1e-9 {
		t.Fatalf("release of %.3f kW in one %v tick exceeds the rate limit %.3f kW", rise, tick, maxStep)
	}
	if rise <= 0 {
		t.Fatalf("the watchdog must release when room appears, cap moved %.3f kW", rise)
	}

	// Within the release window the plant is back to free-running, and the
	// limit was never exceeded on the way there (no oscillation).
	for i := 0; i < 30; i++ {
		p.step(t, l, now, limit, exportSafe(limit, 0))
		if p.export() > limit+1e-6 {
			t.Fatalf("cycle %d: release overshot the limit (%.3f kW)", i, p.export())
		}
		now = now.Add(tick)
	}
	if p.pv() < p.potential-1e-6 {
		t.Fatalf("the plant should be free-running again, pv %.3f of %.3f", p.pv(), p.potential)
	}
}

// A passing cloud lowers the generation on its own. The watchdog then has room
// it never asked for - it must give it back without letting the plant overshoot
// when the cloud clears.
func TestACloudReleasesWithoutOvershootWhenItClears(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()

	p := &plant{potential: 40, load: 4}
	for i := 0; i < 6; i++ {
		p.step(t, l, now, limit, exportSafe(limit, 0))
		now = now.Add(tick)
	}

	// Cloud: potential collapses to 8 kW for two minutes.
	p.potential = 8
	for i := 0; i < 12; i++ {
		c := p.step(t, l, now, limit, exportSafe(limit, 0))
		if c.State == ExportLimiting {
			t.Fatalf("a cloudy plant is not being held back, state %q (%s)", c.State, c.Reason)
		}
		now = now.Add(tick)
	}

	// The cloud clears instantly - the worst case for a released cap.
	p.potential = 40
	worst := 0.0
	for i := 0; i < 30; i++ {
		p.step(t, l, now, limit, exportSafe(limit, 0))
		if e := p.export(); e > worst {
			worst = e
		}
		now = now.Add(tick)
	}
	if worst > limit+1e-6 {
		t.Fatalf("clearing cloud overshot the limit: peak export %.3f kW", worst)
	}
}

// ⚠ The fail-safe rule that is the OPPOSITE of every other guard here.
func TestLosingTheMeasurementHoldsThenContractsAndNeverReleases(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()

	p := &plant{potential: 40, load: 4}
	for i := 0; i < 6; i++ {
		p.step(t, l, now, limit, exportSafe(limit, 0))
		now = now.Add(tick)
	}
	held, _ := l.CommandedCap()
	// The last measurement was one tick before the loop's final advance.
	last := now.Add(-tick)

	// The measurement goes away. Inside the hold window the cap is FROZEN.
	safe := exportSafe(limit, 0)
	for _, age := range []time.Duration{ExportFreshWindow + time.Second, 60 * time.Second, ExportHoldWindow} {
		c := l.Cap(last.Add(age), &limit, safe)
		if c.State != ExportHolding {
			t.Fatalf("age %v: expected %q, got %q", age, ExportHolding, c.State)
		}
		if math.Abs(c.CapKw-held) > 1e-6 {
			t.Fatalf("age %v: the cap moved while holding (%.3f -> %.3f)", age, held, c.CapKw)
		}
		if !c.Blind || c.Reason == "" {
			t.Fatalf("age %v: a blind verdict must be flagged and named, got %+v", age, c)
		}
	}

	// Beyond it the cap CONTRACTS toward the safe static cap - monotonically
	// downward, never a release.
	prev := held
	for age := ExportHoldWindow + 30*time.Second; age < ExportHoldWindow+ExportContractWindow; age += 30 * time.Second {
		c := l.Cap(last.Add(age), &limit, safe)
		if c.State != ExportContracting {
			t.Fatalf("age %v: expected %q, got %q", age, ExportContracting, c.State)
		}
		if c.CapKw > prev+1e-9 {
			t.Fatalf("age %v: the cap ROSE while blind (%.3f -> %.3f)", age, prev, c.CapKw)
		}
		prev = c.CapKw
	}

	// And it ends on the safe static cap, which holds for ANY house load.
	c := l.Cap(last.Add(ExportHoldWindow+ExportContractWindow+time.Minute), &limit, safe)
	if c.State != ExportSafeCap {
		t.Fatalf("expected %q, got %q", ExportSafeCap, c.State)
	}
	if math.Abs(c.CapKw-safe) > 1e-6 {
		t.Fatalf("expected the safe cap %.3f, got %.3f", safe, c.CapKw)
	}
	// The point of that cap: with ZERO house consumption the export equals the
	// total PV, so capping the PV at the limit is exactly sufficient.
	p.load, p.applied, p.capValid = 0, c.CapKw, true
	if p.export() > limit+1e-6 {
		t.Fatalf("the safe cap does not hold at zero self-consumption: %.3f kW", p.export())
	}
}

func TestABoxThatHasNeverMeasuredStartsOnTheSafeCap(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	safe := exportSafe(limit, 0)
	c := l.Cap(time.Now().UTC(), &limit, safe)
	if c.State != ExportSafeCap || math.Abs(c.CapKw-safe) > 1e-6 {
		t.Fatalf("a box without a measurement must start capped, got %+v", c)
	}
	if !strings.Contains(c.Reason, "Noch keine Messung") {
		t.Fatalf("the reason must name the missing measurement, got %q", c.Reason)
	}
}

// The safe static cap subtracts a COMMANDED DISCHARGE, because a discharging
// battery feeds the grid too.
func TestTheSafeCapAccountsForACommandedDischarge(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	safe := exportSafe(limit, -8) // 8 kW discharge commanded
	if math.Abs(safe-22) > 1e-9 {
		t.Fatalf("expected a 22 kW safe cap, got %.3f", safe)
	}
	c := l.Cap(time.Now().UTC(), &limit, safe)
	p := &plant{potential: 40, load: 0, battery: -8, applied: c.CapKw, capValid: true}
	if p.export() > limit+1e-6 {
		t.Fatalf("safe cap + discharge exceeds the limit: %.3f kW", p.export())
	}
	// A commanded CHARGE only ever absorbs PV, so it subtracts nothing.
	if got := exportSafe(limit, 12); math.Abs(got-limit) > 1e-9 {
		t.Fatalf("a charge must not shrink the safe cap, got %.3f", got)
	}
}

// A cap that comes back from blind must not be inherited by a DIFFERENT limit:
// clearing is the contract's rule for a new plan without the field.
func TestForgetDropsTheCapSoANewLimitStartsFromAMeasurement(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()
	l.Observe(now, -25, 29)
	l.Cap(now, &limit, exportSafe(limit, 0))
	if _, ok := l.CommandedCap(); !ok {
		t.Fatalf("expected a commanded cap")
	}
	// The contract's clear-on-absent: a plan without the field drops it.
	if c := l.Cap(now, nil, 0); c.Active {
		t.Fatalf("an absent limit must deactivate the watchdog")
	}
	if _, ok := l.CommandedCap(); ok {
		t.Fatalf("the cap must not survive the limit that produced it")
	}
}

// Every state names its cause in German - the OTA-blocker lesson applied here:
// a limitation nobody names reads as a defect, and "the measurement went away"
// must never look like "everything is fine".
func TestEveryActiveStateCarriesAGermanReason(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()
	safe := exportSafe(limit, 0)

	seen := map[ExportState]string{}
	record := func(c ExportCap) {
		if c.Active {
			seen[c.State] = c.Reason
		}
	}
	record(l.Cap(now, &limit, safe))                                         // sicherheitskappe (never measured)
	l.Observe(now, +5, 10)                                                   //
	record(l.Cap(now, &limit, safe))                                         // ueberwacht
	l.Observe(now.Add(tick), -29.8, 34)                                      //
	record(l.Cap(now.Add(tick), &limit, safe))                               // regelt
	record(l.Cap(now.Add(tick+ExportFreshWindow+time.Second), &limit, safe)) // haelt
	record(l.Cap(now.Add(20*time.Minute), &limit, safe))                     // sicherheitskappe
	for _, want := range []ExportState{ExportWatching, ExportLimiting, ExportHolding, ExportSafeCap} {
		reason, ok := seen[want]
		if !ok {
			t.Fatalf("state %q was never reached by the fixture", want)
		}
		if strings.TrimSpace(reason) == "" {
			t.Fatalf("state %q carries no reason", want)
		}
		if !strings.Contains(reason, "kW") {
			t.Fatalf("state %q reason names no numbers: %q", want, reason)
		}
	}
}

// The uncontrollable share (the primary hybrid) rides inside the measured total
// PV, so the loop accounts for it automatically - even when it alone fills the
// limit, in which case the cap floors at that share and the split gives the
// writable units nothing.
func TestUncontrollableGenerationIsAccountedForByTheMeasurement(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()
	// Total PV 34 kW (Deye 34, Fronius 0), no house load: 34 kW exported.
	l.Observe(now, -34, 34)
	c := l.Cap(now, &limit, exportSafe(limit, 0))
	// The cap is the TOTAL plant cap; the executor subtracts the uncontrollable
	// share itself. It must be below the limit, so the writable budget is 0.
	if c.CapKw > limit {
		t.Fatalf("cap %.3f exceeds the limit", c.CapKw)
	}
	if c.State != ExportLimiting {
		t.Fatalf("expected the watchdog to be limiting, got %q", c.State)
	}
}

// A converged plant must not rewrite its cap on measurement noise (the Fronius
// register is written by the executor on every command CHANGE), and sitting
// still must not bank release credit that lets the cap jump when room appears.
func TestAConvergedCapIsStableUnderNoiseAndBanksNoReleaseCredit(t *testing.T) {
	limit := 30.0
	l := NewExportLimiter()
	now := time.Now().UTC()
	safe := exportSafe(limit, 0)

	p := &plant{potential: 40, load: 4}
	for i := 0; i < 8; i++ {
		p.step(t, l, now, limit, safe)
		now = now.Add(tick)
	}
	settled, _ := l.CommandedCap()

	// Five minutes of ±40 W noise on the connection point: the cap must not move.
	for i := 0; i < 30; i++ {
		noise := 0.04
		if i%2 == 0 {
			noise = -0.04
		}
		l.Observe(now, p.grid()+noise, p.pv())
		c := l.Cap(now, &limit, safe)
		if math.Abs(c.CapKw-settled) > ExportStepKw {
			t.Fatalf("cycle %d: the cap moved %.3f kW on noise", i, c.CapKw-settled)
		}
		now = now.Add(tick)
	}

	// Now real room appears. The first release step must still respect the rate
	// limit for ONE tick - the five quiet minutes may not have banked credit.
	before, _ := l.CommandedCap()
	p.load = 15
	c := p.step(t, l, now, limit, safe)
	if rise := c.CapKw - before; rise > releaseRate(limit)*tick.Seconds()+1e-9 {
		t.Fatalf("standing still banked release credit: %.3f kW in one tick", rise)
	}
}

// exportSafe mirrors the agent's exportSafeStaticCap for the guard tests, so the
// arithmetic lives in exactly one place per side.
func exportSafe(limit, setpointKw float64) float64 {
	discharge := 0.0
	if setpointKw < 0 {
		discharge = -setpointKw
	}
	if v := limit - discharge; v > 0 {
		return v
	}
	return 0
}
