package ladepunktsim

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/consumersim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// Bestandsschutz (MP-34): the bidirectional point is a NEW model next to the
// existing simulated wallboxes, it does not change them. Both existing ones -
// the generic consumer preset `wallbox` (consumersim) and the OCPP 1.6
// station's vehicle (ocppsim) - only ever draw, never feed back, and their
// answers to a fixed command trace are pinned byte for byte, fingerprint
// taken on origin/mispel 0a71168c6 before this package existed.
func TestBestandsschutzWallboxenOhneRueckspeisung(t *testing.T) {
	var spur strings.Builder

	cfg, err := consumersim.Preset("wallbox")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&spur, "preset %+v\n", cfg)
	d := consumersim.New(cfg)
	for _, w := range []float64{-11, -1.4, 0, 1.0, 1.4, 3.7, 4.0, 4.2, 7.4, 11, 22} {
		kw := w
		res := d.Apply(nil, &kw, true)
		if res.AppliedKw < 0 {
			t.Fatalf("consumersim wallbox speist zurück: %v kW auf %v", res.AppliedKw, w)
		}
		fmt.Fprintf(&spur, "apply %v -> %+v\n", w, res)
	}
	d.SetAvailable(false)
	kw := 11.0
	fmt.Fprintf(&spur, "abgesteckt -> %+v\n", d.Apply(nil, &kw, true))

	now := time.Date(2026, 10, 1, 18, 0, 0, 0, time.UTC)
	profile := []ocppsim.Profile{{ID: 1, Purpose: ocppsim.PurposeTxDefault, LimitW: 7400}}
	for _, v := range []ocppsim.Vehicle{{DemandKw: -5}, {DemandKw: 0}, {DemandKw: 3, MinKw: 4.2}, {DemandKw: 11, MinKw: 1.4}, {DemandKw: 22}} {
		for _, p := range [][]ocppsim.Profile{nil, profile} {
			got := ocppsim.DrawKw(v, p, 1, now)
			if got < 0 {
				t.Fatalf("ocppsim speist zurück: %v kW für %+v", got, v)
			}
			fmt.Fprintf(&spur, "ocpp %+v profile=%d -> %v\n", v, len(p), got)
		}
	}

	const fingerabdruck = "cea970a4ebc39e1912d6cf691848e7b562e5620f2efd258913e35c1d9c103bdf"
	if got := fmt.Sprintf("%x", sha256.Sum256([]byte(spur.String()))); got != fingerabdruck {
		// A deliberate change to an existing simulator: read the trace, make
		// sure nothing feeds back, then carry the fingerprint forward here.
		t.Fatalf("Bestand verändert: Fingerabdruck %s, erwartet %s\n%s", got, fingerabdruck, spur.String())
	}
}
