package lastmgmt

import (
	"strings"
	"testing"
	"time"
)

// A backward clock jump re-anchors every time the tracker keeps (A8,
// verankernLocked) - the settle mark of a starting charge point (#1395) too.
// Left on the old clock it lay in the future of every later sample: the
// source lane would hold a surplus nobody measured and the blind sentence
// would name a ramp that is long over.
func TestUhrsprungNimmtDieEinschwingMarkeMit(t *testing.T) {
	b := NewBudgetTracker()
	set := dynSite()
	b.Observe(t0, 140, 40, true)
	b.ObserveM(t0.Add(time.Second), Measurement{GridKw: 140, ChargingKw: 40, Settling: true})
	sprung := t0.Add(-840 * time.Second)
	b.Observe(sprung, 60, 40, true)
	if b.settlingAt.After(sprung) {
		t.Fatal("settle mark was left on the old clock")
	}

	now := sprung.Add(40 * time.Second) // no sample since: past the fresh window
	if v := b.Surplus(now, PolicySolarOnly, CarsBeforeStorage); !v.Blind {
		t.Fatalf("no charge point settles on the new clock - the lane must be blind: %+v", v)
	}
	v := b.Budget(now, set)
	if !v.Blind || !strings.HasPrefix(v.Reason, "Seit 40 s keine Messung am Netzanschluss") {
		t.Fatalf("the blind sentence must name the missing measurement: %+v", v)
	}
}
