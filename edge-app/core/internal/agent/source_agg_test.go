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

// B9: a failed persist must roll the in-memory removal back (mirroring
// AddSource) - without the rollback, aggregation silently stops summing the
// Erzeuger (site load jumps) while Node-RED keeps reading it and a reboot
// resurrects it from the still-on-disk sources.json.
func TestDeleteSourceRollsBackOnPersistFailure(t *testing.T) {
	a := newGateTestAgent(t)
	s := addErzeuger(t, a, 40)
	feedSource(a, s.ID, 30)

	// Make the source store's atomic write fail: the data dir (where
	// sources.json.tmp is created) becomes read-only.
	dir := a.Cfg.DataDir
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	if err := a.DeleteSource(s.ID); err == nil {
		t.Fatal("expected DeleteSource to fail while the store is unwritable")
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

	// Once the store is writable again the delete goes through normally.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteSource(s.ID); err != nil {
		t.Fatalf("DeleteSource after recovery: %v", err)
	}
}
