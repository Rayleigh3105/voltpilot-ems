package agent

import (
	"testing"
)

// A8r without the old discarding shadow (vp-uems-v15-folge-anteilsweg-
// uhrensprung): the share path runs on the healed shadow of the single box
// alone. The plan, anchored on the clock before the jump, comes back 240 s
// after it - the battery from the self-consumption charge to the plan's
// discharge. Without the healing (guards/exportanteil.go einAnstieg,
// ladungVorDemSprung) that is +95.9 kW for 15 s; the old shadow held it at
// +6.0 kW / 9 s. The number may get better, never worse.
func TestA8rHaeltOhneAltenSchatten(t *testing.T) {
	for _, f := range zaFaelle() {
		if f.zeile != "A8r" {
			continue
		}
		r := zaFahre(t, f, zaMittag)
		if !r.ok || r.ein.groessteUeberKw > 6+1e-6 || r.ein.laengsteUeber > 9 || r.ein.sekundenUeber > 9 {
			t.Fatalf("A8r above +6.0 kW / 9 s without the old shadow: %s (peak %.12f)", zaZeile(r), r.ein.groessteUeberKw)
		}
		t.Logf("%s", zaZeile(r))
		return
	}
	t.Fatal("A8r is missing from the failure matrix")
}
