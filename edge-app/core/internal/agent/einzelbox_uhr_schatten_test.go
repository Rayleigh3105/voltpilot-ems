package agent

import (
	"math"
	"testing"
)

// The single-box fix must not remove the old shadow's additional ceiling.
// Without it A8r/Mittag reaches +95.9 kW for 15 s: the re-anchored shadow
// releases PV again while the backward clock temporarily leaves the plan.
// The separate package vp-uems-v15-folge-anteilsweg-uhrensprung owns that
// finding; until then this pins the old share path's actual numbers.
func TestA8rAlterSchattenHaeltDieBisherigenZahlen(t *testing.T) {
	for _, f := range zaFaelle() {
		if f.zeile != "A8r" {
			continue
		}
		r := zaFahre(t, f, zaMittag)
		if !r.ok || math.Abs(r.ein.groessteUeberKw-6) > 1e-6 || r.ein.laengsteUeber != 9 || r.ein.sekundenUeber != 9 {
			t.Fatalf("temporary old-shadow ceiling changed: %s (peak %.12f)", zaZeile(r), r.ein.groessteUeberKw)
		}
		t.Logf("%s", zaZeile(r))
		return
	}
	t.Fatal("A8r is missing from the failure matrix")
}
