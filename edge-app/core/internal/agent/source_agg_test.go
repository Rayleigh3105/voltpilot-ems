package agent

// Multi-source aggregation (Phase 1): a site with a battery-hybrid inverter PLUS
// one or more separate Erzeuger (PV) sources reads them all through the one edge
// and SUMS PV into the composite site reading at onLocalTelemetry, correcting the
// primary's "garbage load". This proves:
//   - two sources sum into site PV and reduce site load;
//   - a source that never reports (or goes stale) is ABSENT, not a fabricated 0
//     (error isolation) - the others still contribute;
//   - with zero sources the path is byte-for-byte the single-source behaviour;
//   - the physical envelope's PV bound widens to Σ generation nameplate.

import (
	"fmt"
	"os"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

func addErzeuger(t *testing.T, a *Agent, capacityKwp float64) sources.Source {
	t.Helper()
	src, err := a.AddSource(sources.Request{
		Role:        sources.RoleErzeuger,
		Brand:       inverter.BrandGenericModbus,
		Model:       inverter.FamSunSpec,
		Connection:  inverter.Connection{IP: "192.168.0.60"},
		CapacityKwp: capacityKwp,
	})
	if err != nil {
		t.Fatalf("AddSource: %v", err)
	}
	return src
}

func feedSource(a *Agent, id string, pv float64) {
	a.onSourceTelemetry(sources.TopicPrefix+id+"/telemetry",
		[]byte(fmt.Sprintf(`{"pv_power_kw": %v}`, pv)))
}

func addNetz(t *testing.T, a *Agent) sources.Source {
	t.Helper()
	src, err := a.AddSource(sources.Request{
		Role:       sources.RoleNetz,
		Brand:      inverter.BrandGenericModbus,
		Model:      inverter.FamSunSpec,
		Connection: inverter.Connection{IP: "192.168.0.70"},
	})
	if err != nil {
		t.Fatalf("AddSource(Netz): %v", err)
	}
	return src
}

func feedNetz(a *Agent, id string, grid float64) {
	a.onSourceTelemetry(sources.TopicPrefix+id+"/telemetry",
		[]byte(fmt.Sprintf(`{"power_kw": %v}`, grid)))
}

func feedPrimary(a *Agent, pv, load, grid, soc float64) {
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(fmt.Sprintf(
		`{"pv_power_kw": %v, "load_kw": %v, "power_kw": %v, "soc_pct": %v}`, pv, load, grid, soc)))
}

func TestTwoErzeugerSourcesSumIntoSitePvAndCorrectLoad(t *testing.T) {
	a := newGateTestAgent(t)
	sa := addErzeuger(t, a, 40)
	sb := addErzeuger(t, a, 40)

	feedSource(a, sa.ID, 30)
	feedSource(a, sb.ID, 40)
	// Primary battery-hybrid reports its own DC PV + a load that has absorbed the
	// two AC-PV sources' production (the 46,7-kW-class bug in miniature).
	feedPrimary(a, 20, 90, -5, 50)

	snap := a.State.Get()
	if snap.PvKw != 90 { // 20 + 30 + 40
		t.Fatalf("site PV = %v, want 90 (primary 20 + sources 30 + 40)", snap.PvKw)
	}
	if snap.LoadKw != 20 { // 90 - (30 + 40)
		t.Fatalf("corrected site load = %v, want 20 (90 - 70)", snap.LoadKw)
	}
	if snap.SocPct != 50 {
		t.Fatalf("soc should be untouched: %v", snap.SocPct)
	}
}

func TestSourceLoadCorrectionClampsAtZero(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 70)
	feedSource(a, s.ID, 70)
	feedPrimary(a, 20, 46.7, 0, 50) // the captain's real garbage-load figure
	snap := a.State.Get()
	if snap.PvKw != 90 {
		t.Fatalf("site PV = %v, want 90", snap.PvKw)
	}
	if snap.LoadKw != 0 { // 46.7 - 70 -> clamped to 0, never negative
		t.Fatalf("corrected load = %v, want 0 (clamped)", snap.LoadKw)
	}
}

func TestAbsentSourceContributesNothingNotZero(t *testing.T) {
	a := newGateTestAgent(t)
	live := addErzeuger(t, a, 40)
	dead := addErzeuger(t, a, 40)
	_ = dead // dead never reports

	feedSource(a, live.ID, 30)
	feedPrimary(a, 20, 60, -5, 50)

	snap := a.State.Get()
	if snap.PvKw != 50 { // 20 + 30 only; the dead source is absent, not 0
		t.Fatalf("site PV = %v, want 50 (dead source absent)", snap.PvKw)
	}
	if snap.LoadKw != 30 { // 60 - 30
		t.Fatalf("corrected load = %v, want 30", snap.LoadKw)
	}
}

func TestStaleSourceIsDroppedFromAggregation(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 40)
	feedSource(a, s.ID, 30)
	// Age the reading well past the freshness window (3*interval, floor 60 s).
	a.srcMu.Lock()
	r := a.srcReadings[s.ID]
	r.recv = time.Now().Add(-10 * time.Minute)
	a.srcReadings[s.ID] = r
	a.srcMu.Unlock()

	feedPrimary(a, 20, 60, -5, 50)
	snap := a.State.Get()
	if snap.PvKw != 20 { // stale source contributes nothing
		t.Fatalf("site PV = %v, want 20 (stale source dropped)", snap.PvKw)
	}
	if snap.LoadKw != 60 { // no correction from a stale source
		t.Fatalf("load = %v, want 60 (no correction)", snap.LoadKw)
	}
}

func TestZeroSourcesIsByteForByteSingleSource(t *testing.T) {
	a := newGateTestAgent(t)
	feedPrimary(a, 20, 60, -5, 50)
	snap := a.State.Get()
	if snap.PvKw != 20 || snap.LoadKw != 60 {
		t.Fatalf("single-source path changed: pv=%v load=%v (want 20 / 60)", snap.PvKw, snap.LoadKw)
	}
}

// Increment 1 (Netz-Zähler): a dedicated grid meter at the point of common
// coupling measures site_grid directly, so a FRESH reading OVERRIDES the primary
// hybrid inverter's CT-derived power_kw (the money channel becomes
// install-independent); a stale/absent meter falls back to the primary CT; with
// no Netz source the grid channel is byte-for-byte unchanged.

// gridOf reads the newest recorded site grid (power_kw) from the history ring -
// the money channel the cloud publish and the derived-battery both consume. The
// state snapshot has no grid field; the override lands in the buffer + ring.
func gridOf(t *testing.T, a *Agent) float64 {
	t.Helper()
	rec := a.hist.Recent(time.Hour, time.Now())
	if len(rec) == 0 {
		t.Fatalf("no history sample recorded")
	}
	g := rec[len(rec)-1].GridKw
	if g == nil {
		t.Fatalf("newest history sample has no grid value")
	}
	return *g
}

func TestFreshNetzMeterOverridesPrimaryGrid(t *testing.T) {
	a := newGateTestAgent(t)
	n := addNetz(t, a)
	feedNetz(a, n.ID, -8) // meter at PCC reads 8 kW export
	// Primary hybrid's own CT reports a different (wrong) grid figure.
	feedPrimary(a, 20, 60, 3, 50)

	if got := gridOf(t, a); got != -8 {
		t.Fatalf("site grid = %v, want -8 (meter overrides primary CT)", got)
	}
	// The override touches ONLY grid: PV and load stay the primary's (no Erzeuger).
	snap := a.State.Get()
	if snap.PvKw != 20 || snap.LoadKw != 60 {
		t.Fatalf("Netz override changed pv/load: pv=%v load=%v (want 20 / 60)", snap.PvKw, snap.LoadKw)
	}
}

func TestStaleNetzMeterFallsBackToPrimaryGrid(t *testing.T) {
	a := newGateTestAgent(t)
	n := addNetz(t, a)
	feedNetz(a, n.ID, -8)
	// Age the meter reading past its freshness window.
	a.srcMu.Lock()
	r := a.srcReadings[n.ID]
	r.recv = time.Now().Add(-10 * time.Minute)
	a.srcReadings[n.ID] = r
	a.srcMu.Unlock()

	feedPrimary(a, 20, 60, 3, 50)
	if got := gridOf(t, a); got != 3 {
		t.Fatalf("site grid = %v, want 3 (stale meter falls back to primary CT)", got)
	}
}

func TestNoNetzMeterLeavesGridByteForByte(t *testing.T) {
	a := newGateTestAgent(t)
	// An Erzeuger present but NO Netz meter: grid stays exactly the primary's.
	s := addErzeuger(t, a, 40)
	feedSource(a, s.ID, 30)
	feedPrimary(a, 20, 60, -5, 50)
	if got := gridOf(t, a); got != -5 {
		t.Fatalf("site grid = %v, want -5 (no Netz override)", got)
	}
}

func TestNetzMeterAddsNothingToPvEnvelopeBound(t *testing.T) {
	a := newGateTestAgent(t)
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand:      inverter.BrandDeye,
		Model:      "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	base, _ := a.envelope.Bounds()
	addNetz(t, a)
	after, _ := a.envelope.Bounds()
	if after != base {
		t.Fatalf("Netz meter changed the PV envelope bound: %v -> %v", base, after)
	}
}

func TestEnvelopePvBoundWidensWithSourceCapacity(t *testing.T) {
	a := newGateTestAgent(t)
	// Primary 12 kW battery-hybrid: PV bound = 12*2 + 2 = 26 kW.
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand:      inverter.BrandDeye,
		Model:      "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	pvBound, battBound := a.envelope.Bounds()
	if pvBound != 26 {
		t.Fatalf("primary-only PV bound = %v, want 26", pvBound)
	}
	if battBound <= 0 {
		t.Fatalf("battery-hybrid should have a battery bound, got %v", battBound)
	}

	// Add a 70 kWp Erzeuger: PV bound widens to (12 + 70)*2 + 2 = 166 kW, so a
	// legitimate 90 kW composite is no longer "despiked" as impossible. The
	// battery bound stays the primary's (only the hybrid moves the battery).
	addErzeuger(t, a, 70)
	widePv, wideBatt := a.envelope.Bounds()
	if widePv != 166 {
		t.Fatalf("widened PV bound = %v, want 166", widePv)
	}
	if wideBatt != battBound {
		t.Fatalf("battery bound changed: %v -> %v", battBound, wideBatt)
	}
}

func TestDeleteSourceStopsAggregatingAndNarrowsEnvelope(t *testing.T) {
	a := newGateTestAgent(t)
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand:      inverter.BrandDeye,
		Model:      "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	s := addErzeuger(t, a, 70)
	if pv, _ := a.envelope.Bounds(); pv != 166 {
		t.Fatalf("expected widened bound 166, got %v", pv)
	}
	if err := a.DeleteSource(s.ID); err != nil {
		t.Fatalf("DeleteSource: %v", err)
	}
	if pv, _ := a.envelope.Bounds(); pv != 26 {
		t.Fatalf("bound should narrow back to 26, got %v", pv)
	}
	if err := a.DeleteSource("does-not-exist"); err != sources.ErrNotFound {
		t.Fatalf("delete unknown id = %v, want ErrNotFound", err)
	}
	// After removal a fed reading for the removed id must not resurface.
	feedSource(a, s.ID, 30)
	feedPrimary(a, 20, 60, -5, 50)
	if snap := a.State.Get(); snap.PvKw != 20 {
		t.Fatalf("removed source still aggregated: pv=%v", snap.PvKw)
	}
}

// --- Multi-inverter-at-one-Datamanager aggregation regressions -----------------
//
// Live evidence from the captain's site "Asbeck Büro Isaraue" (2026-07-17):
// primary Deye SUN-30K (pv 23,7 / load −30,5 / Einspeisung 23,7 / SoC 53) plus
// TWO Fronius Eco Erzeuger sources behind ONE Datamanager (WR1 "ost" 22 kW,
// WR2 "west" 26,9 kW, no kWp entered). The dashboard PV tile froze at 45,4 kW
// (primary + WR1) although WR2 showed "Liefert Daten": the fixed 60-s freshness
// window dropped the slowly-read WR2 in and out of the sum, and every flip
// reset the despiker's confirmation candidate (the captain runs "Streng"), so
// the composite step was held forever. These tests pin all four fixes.

func approx(t *testing.T, got, want float64, what string) {
	t.Helper()
	if diff := got - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

// feedPrimaryAt feeds a primary sample with an explicit observation timestamp,
// so the despiker's rate window sees controlled spacing between samples.
func feedPrimaryAt(a *Agent, ts time.Time, pv, load, grid, soc float64) {
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(fmt.Sprintf(
		`{"ts": %q, "pv_power_kw": %v, "load_kw": %v, "power_kw": %v, "soc_pct": %v}`,
		ts.Format(time.RFC3339), pv, load, grid, soc)))
}

// setReading rewrites a source's stored reading (age + achieved period) so the
// freshness machinery can be exercised deterministically.
func setReading(a *Agent, id string, age, period time.Duration) {
	a.srcMu.Lock()
	r := a.srcReadings[id]
	r.recv = time.Now().UTC().Add(-age)
	r.period = period
	a.srcReadings[id] = r
	a.srcMu.Unlock()
}

func strengPreset(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetDespike(guards.DespikeSettings{Preset: guards.PresetStrict}); err != nil {
		t.Fatalf("SetDespike(streng): %v", err)
	}
}

// The freshness window follows the ACHIEVED cadence: a source the sequential
// Datamanager loop only manages to read every ~45 s stays in the sum well past
// the 60-s floor, while a source with no achieved-period history still goes
// stale at the floor, and the cap bounds even a huge observed period.
func TestSlowlyReadSourceStaysFreshViaAchievedCadence(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 70)
	feedSource(a, s.ID, 26.9)

	// 100 s old with an achieved 45-s period: window = 3*45 = 135 s -> fresh.
	setReading(a, s.ID, 100*time.Second, 45*time.Second)
	feedPrimary(a, 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 50.6, "site PV with a slowly-read but delivering source")

	// Same age with NO achieved period: the 60-s floor applies -> stale.
	setReading(a, s.ID, 100*time.Second, 0)
	feedPrimary(a, 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 23.7, "site PV once the floor window applies")

	// A huge observed period is capped: 16 min old with a 10-min period -> stale.
	setReading(a, s.ID, 16*time.Minute, 10*time.Minute)
	feedPrimary(a, 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 23.7, "site PV past the staleness cap")
}

// The achieved period is recorded from consecutive receipts (the live path of
// the window widening above).
func TestSourceReadingRecordsAchievedPeriod(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 70)
	feedSource(a, s.ID, 22)
	setReading(a, s.ID, 40*time.Second, 0) // first reading arrived 40 s ago
	feedSource(a, s.ID, 22.5)              // second reading now
	a.srcMu.Lock()
	period := a.srcReadings[s.ID].period
	a.srcMu.Unlock()
	if period < 39*time.Second || period > 42*time.Second {
		t.Fatalf("achieved period = %v, want ~40s", period)
	}
}

// Adding the second Fronius steps the composite by +26,9 kW - an EXPLAINED
// configuration change that must be adopted IMMEDIATELY even on the strict
// despike preset (before the fix, "Streng" held the PV tile at the old level
// and an oscillating composition never confirmed the new one).
func TestSecondErzeugerJoinsTheSumImmediatelyOnStrengPreset(t *testing.T) {
	a := newGateTestAgent(t)
	strengPreset(t, a)
	wr1 := addErzeuger(t, a, 70)
	wr2 := addErzeuger(t, a, 0) // the captain's WR2: no kWp entered

	base := time.Now().UTC().Truncate(time.Second)
	feedSource(a, wr1.ID, 22)
	feedPrimaryAt(a, base, 23.7, 50, -20, 53)
	feedPrimaryAt(a, base.Add(10*time.Second), 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 45.7, "established primary+WR1 level")

	// WR2 starts delivering: the very next fold must show the full sum.
	feedSource(a, wr2.ID, 26.9)
	feedPrimaryAt(a, base.Add(20*time.Second), 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 72.6, "composite adopts WR2 immediately (no despike hold)")
}

// A source flapping fresh<->stale (the pre-fix 60-s-window symptom) must never
// FREEZE the tile: every sample honestly reflects the sources that currently
// contribute - the partial sum while WR2 is out, the full sum the moment it is
// back - instead of the despiker holding one stale level forever.
func TestFlappingSourceCompositionNeverFreezesThePvTile(t *testing.T) {
	a := newGateTestAgent(t)
	strengPreset(t, a)
	wr1 := addErzeuger(t, a, 70)
	wr2 := addErzeuger(t, a, 0)

	base := time.Now().UTC().Truncate(time.Second)
	feedSource(a, wr1.ID, 22)
	feedSource(a, wr2.ID, 26.9)
	feedPrimaryAt(a, base, 23.7, 50, -20, 53)
	approx(t, a.State.Get().PvKw, 72.6, "both sources in the sum")

	steps := []struct {
		stale bool
		want  float64
	}{
		{true, 45.7},  // WR2 drops out -> honest partial sum, not a held 72,6
		{false, 72.6}, // back -> full sum again, immediately
		{true, 45.7},
		{false, 72.6},
	}
	for i, st := range steps {
		if st.stale {
			setReading(a, wr2.ID, 10*time.Minute, 0)
		} else {
			setReading(a, wr2.ID, 0, 0)
		}
		feedPrimaryAt(a, base.Add(time.Duration(i+1)*10*time.Second), 23.7, 50, -20, 53)
		approx(t, a.State.Get().PvKw, st.want, fmt.Sprintf("step %d (stale=%v)", i, st.stale))
	}
}

// The captain's exact live sample: primary Deye load −30,5 kW with 48,9 kW of
// AC-coupled Fronius. A meaningfully negative load figure proves the primary's
// load already nets the AC PV out (load = house − Σac), so the derivable house
// is load + Σac = 18,4 kW - NOT the fabricated 0 the subtraction branch
// produced. Plain noise around zero stays on the established branch.
func TestNegativeLoadWithAcCoupledSourcesDerivesHouseInsteadOfZero(t *testing.T) {
	a := newGateTestAgent(t)
	wr1 := addErzeuger(t, a, 70)
	wr2 := addErzeuger(t, a, 0)
	feedSource(a, wr1.ID, 22)
	feedSource(a, wr2.ID, 26.9)

	// Samples are spaced 60 s apart so the (default-preset) despiker's rate
	// window never interferes with what this test pins: the fold's branch.
	base := time.Now().UTC().Truncate(time.Second)
	feedPrimaryAt(a, base, 23.7, -30.5, -23.7, 53)
	snap := a.State.Get()
	approx(t, snap.PvKw, 72.6, "site PV")
	approx(t, snap.LoadKw, 18.4, "derived house load (−30,5 + 48,9)")

	// Noise-negative load (−0,3): NOT proof of the netting topology - the
	// established subtraction branch clamps to 0 as before.
	feedPrimaryAt(a, base.Add(60*time.Second), 23.7, -0.3, -23.7, 53)
	approx(t, a.State.Get().LoadKw, 0, "noise-negative load keeps the established branch")

	// Non-negative load keeps the established subtraction unchanged.
	feedPrimaryAt(a, base.Add(120*time.Second), 23.7, 60, -23.7, 53)
	approx(t, a.State.Get().LoadKw, 11.1, "positive load keeps load − Σpv")
}

// An Erzeuger without a nameplate contributes REAL power the PV bound cannot
// account for, so no honest PV bound exists while one is configured - the
// envelope must not clip (hold) a legitimate composite. The battery bound
// stays in force; entering/removing the kWp restores the PV bound.
func TestKwpLessErzeugerDisablesThePvEnvelopeBound(t *testing.T) {
	a := newGateTestAgent(t)
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand:      inverter.BrandDeye,
		Model:      "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	_, battBound := a.envelope.Bounds()

	kwpLess := addErzeuger(t, a, 0)
	pv, batt := a.envelope.Bounds()
	if pv != 0 {
		t.Fatalf("PV bound with a kWp-less Erzeuger = %v, want 0 (no honest bound)", pv)
	}
	if batt != battBound {
		t.Fatalf("battery bound changed: %v -> %v", battBound, batt)
	}

	// A second, kWp-carrying source does not restore the bound while the
	// kWp-less one remains.
	known := addErzeuger(t, a, 70)
	if pv, _ := a.envelope.Bounds(); pv != 0 {
		t.Fatalf("PV bound = %v, want 0 while any Erzeuger lacks kWp", pv)
	}

	// Removing the kWp-less source restores the stated bound.
	if err := a.DeleteSource(kwpLess.ID); err != nil {
		t.Fatalf("DeleteSource: %v", err)
	}
	if pv, _ := a.envelope.Bounds(); pv != 166 { // (12 + 70)*2 + 2
		t.Fatalf("restored PV bound = %v, want 166", pv)
	}
	_ = known
}

// B9: a failed persist must roll the in-memory removal back (mirroring
// AddSource) - without the rollback, aggregation silently stops summing the
// Erzeuger (site load jumps) while Node-RED keeps reading it and a reboot
// resurrects it from the still-on-disk sources.json.
func TestDeleteSourceRollsBackOnPersistFailure(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 40)
	feedSource(a, s.ID, 30)

	// Make the source store's atomic write fail by putting a DIRECTORY where
	// it writes its scratch file: the write then dies with EISDIR.
	//
	// ⚠ Deliberately NOT chmod. The CI runner is root, root ignores the write
	// bit, so the permission variant of this test passed on every developer
	// machine while it red the edge release gate (tag edge-2026.08.21) - the
	// delete simply SUCCEEDED there. A type collision has no such escape
	// hatch; see sources.Store.TempPath.
	tmp := a.srcStore.TempPath()
	if err := os.Mkdir(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })

	if err := a.DeleteSource(s.ID); err == nil {
		t.Fatal("expected DeleteSource to fail while the store cannot write its scratch file")
	}
	// The source must still be configured, its live reading kept, and the
	// aggregation still summing it.
	a.srcMu.Lock()
	nSrcs := len(a.srcs)
	_, hasReading := a.srcReadings[s.ID]
	a.srcMu.Unlock()
	if nSrcs != 1 || !hasReading {
		t.Fatalf("in-memory removal not rolled back: srcs=%d reading=%v", nSrcs, hasReading)
	}
	feedPrimary(a, 20, 60, -5, 50)
	if snap := a.State.Get(); snap.PvKw != 50 {
		t.Fatalf("source no longer aggregated after failed delete: pv=%v", snap.PvKw)
	}

	// Once the scratch path is free again the delete goes through normally.
	if err := os.Remove(tmp); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteSource(s.ID); err != nil {
		t.Fatalf("DeleteSource after recovery: %v", err)
	}
}

// A CONSUMER source (e.g. a go-e wallbox) publishes load_kw on its per-source
// topic. The agent must INGEST it (so its freshness status becomes "ok" and its
// "Zuletzt gelesen" line shows the load) - a load-only reading was previously
// dropped as "nothing usable". It must NOT feed the PV sum or the authoritative
// grid (consumer aggregation is topology-layer work), so a consumer next to an
// Erzeuger leaves the composite PV untouched.
func TestConsumerSourceLoadIsIngestedButNotSummedIntoPv(t *testing.T) {
	a := newGateTestAgent(t)

	goe, err := a.AddSource(sources.Request{
		Role:       sources.RoleConsumer,
		Brand:      inverter.BrandGoe,
		Model:      inverter.FamGoeHTTP,
		Connection: inverter.Connection{IP: "192.168.1.42"},
	})
	if err != nil {
		t.Fatalf("AddSource(consumer): %v", err)
	}
	erz := addErzeuger(t, a, 70)

	// A load-only consumer reading must be RECORDED (freshness advances).
	a.onSourceTelemetry(sources.TopicPrefix+goe.ID+"/telemetry", []byte(`{"load_kw": 11.04}`))
	feedSource(a, erz.ID, 42) // Erzeuger PV

	if st := a.SourceStatuses()[goe.ID]; st != "ok" {
		t.Fatalf("consumer source status = %q, want ok (its reading must be ingested)", st)
	}
	last, ok := a.SourceLastReadings()[goe.ID]
	if !ok || last.LoadKw == nil || *last.LoadKw != 11.04 {
		t.Fatalf("consumer LastReading = %+v, want LoadKw 11.04", last)
	}
	if last.PvKw != nil || last.PowerKw != nil {
		t.Fatalf("consumer reading must carry only load, got %+v", last)
	}

	// The consumer's load must NOT enter the PV sum: only the Erzeuger's 42 kW.
	pv, _ := a.aggregateSourcePv()
	if pv != 42 {
		t.Fatalf("aggregated PV = %v, want 42 (consumer load must not be summed in)", pv)
	}
	// Nor the authoritative grid (no Netz meter -> nil).
	if g, _ := a.authoritativeGrid(); g != nil {
		t.Fatalf("authoritativeGrid = %v, want nil (a consumer is not a grid meter)", *g)
	}
}
