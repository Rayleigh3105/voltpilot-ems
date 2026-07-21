package agent

// The additive per-source status-heartbeat block (#524): the portal shows ONE
// composite PV number, so a multi-inverter site reads "39 kW" with no way to
// see it is the sum of three devices - the captain had to open :8484 to verify.
// The heartbeat now carries the per-measurement-point Ist (primary + sources,
// each with its own reading + freshness) so the cloud can render the breakdown.
//
// This proves: the primary is reported with its OWN pv (never the composite),
// each source with its own reading and health, a stale source is reported AS
// stale (never dropped-to-zero), the parts sum to the composite, and a device
// with nothing configured emits NO block at all.

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

func entryByID(t *testing.T, sum *cloud.SourcesSummary, id string) cloud.SourceEntry {
	t.Helper()
	for _, e := range sum.Entries {
		if e.ID == id {
			return e
		}
	}
	t.Fatalf("no heartbeat source entry %q in %+v", id, sum.Entries)
	return cloud.SourceEntry{}
}

func TestSourcesSummaryReportsThePartsOfTheCompositePv(t *testing.T) {
	a := newGateTestAgent(t)
	if sum := a.sourcesSummary(); sum != nil {
		t.Fatalf("an uncommissioned device must emit no sources block, got %+v", sum)
	}

	selectPrimary(t, a, inverter.BrandDeye, "sun-12k-sg04lp3")
	wr1 := addErzeuger(t, a, 21.0)
	wr2 := addErzeuger(t, a, 10.0)

	// The captain's shape: Deye 8,3 + Fronius 21,3 + Fronius WR 2 9,3 = 38,9.
	feedSource(a, wr1.ID, 21.3)
	feedSource(a, wr2.ID, 9.3)
	feedPrimary(a, 8.3, 4.0, -25.0, 55)

	sum := a.sourcesSummary()
	if sum == nil || len(sum.Entries) != 3 {
		t.Fatalf("want primary + 2 sources, got %+v", sum)
	}
	prim := entryByID(t, sum, "inverter")
	if prim.Kind != "primary" || prim.Brand != inverter.BrandDeye {
		t.Fatalf("primary entry not identified: %+v", prim)
	}
	if prim.PvKw == nil || *prim.PvKw != 8.3 {
		t.Fatalf("primary must report its OWN pv 8.3 (not the composite), got %+v", prim.PvKw)
	}
	if prim.Health != "ok" || prim.ReadAt == "" {
		t.Fatalf("fresh primary must be ok with a read timestamp: %+v", prim)
	}

	var partsSum float64
	for _, e := range sum.Entries {
		if e.PvKw != nil {
			partsSum += *e.PvKw
		}
	}
	composite := a.State.Get().PvKw
	if diff := partsSum - composite; diff > 1e-6 || diff < -1e-6 {
		t.Fatalf("parts %.3f must sum to the composite %.3f", partsSum, composite)
	}

	one := entryByID(t, sum, wr1.ID)
	if one.Kind != "source" || one.Health != "ok" || one.PvKw == nil || *one.PvKw != 21.3 {
		t.Fatalf("source entry wrong: %+v", one)
	}

	// A source that goes stale is reported AS stale, keeping its last value -
	// never silently dropped and never a fabricated 0.
	ageSource(a, wr2.ID)
	stale := entryByID(t, a.sourcesSummary(), wr2.ID)
	if stale.Health != "stale" {
		t.Fatalf("stale source must report health=stale, got %q", stale.Health)
	}
	if stale.PvKw == nil || *stale.PvKw != 9.3 {
		t.Fatalf("stale source keeps its last reading, got %+v", stale.PvKw)
	}
}

func TestSourcesSummarySingleInverterSiteIsAListOfOne(t *testing.T) {
	a := newGateTestAgent(t)
	selectPrimary(t, a, inverter.BrandDeye, "sun-12k-sg04lp3")

	sum := a.sourcesSummary()
	if sum == nil || len(sum.Entries) != 1 {
		t.Fatalf("a single-inverter site reports exactly one entry, got %+v", sum)
	}
	if sum.Entries[0].Health != "never" || sum.Entries[0].PvKw != nil {
		t.Fatalf("before the first read the primary is honestly 'never': %+v", sum.Entries[0])
	}

	feedPrimary(a, 3.0, 1.0, -2.0, 40)
	e := a.sourcesSummary().Entries[0]
	if e.Health != "ok" || e.PvKw == nil || *e.PvKw != 3.0 {
		t.Fatalf("after a read the primary reports its value: %+v", e)
	}
	if _, err := time.Parse(time.RFC3339, e.ReadAt); err != nil {
		t.Fatalf("read_at must be RFC3339: %v", err)
	}
}
