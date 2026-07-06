package guards

import (
	"math"
	"testing"
)

// envFor12k builds an envelope for a 12 kW hybrid inverter (the captain's
// SUN-12K-SG04LP3): PV bound 12*2 + 2 = 26 kW, battery bound 12*1.5 + 2 = 20 kW.
func envFor12k() *Envelope {
	e := NewEnvelope()
	pv, batt := EnvelopeFor(12, true)
	e.SetBounds(pv, batt)
	return e
}

// TestEnvelopeInactiveWithoutRating: no rating known -> the envelope passes
// everything, whatever the value. This is the "no inverter selected" case.
func TestEnvelopeInactiveWithoutRating(t *testing.T) {
	e := NewEnvelope()
	if e.Active() {
		t.Fatal("a fresh envelope must be inactive")
	}
	m := map[string]float64{"power_kw": 999, "load_kw": 1, "pv_power_kw": 500}
	if drops := e.Accept(m); drops != nil {
		t.Fatalf("inactive envelope must not drop anything, got %+v", drops)
	}
	if m["power_kw"] != 999 || m["pv_power_kw"] != 500 {
		t.Fatalf("inactive envelope must pass values untouched, got %+v", m)
	}
	// A zero rating stays inactive.
	pv, batt := EnvelopeFor(0, true)
	if pv != 0 || batt != 0 {
		t.Fatalf("zero rating must yield inactive bounds, got pv=%v batt=%v", pv, batt)
	}
}

// TestEnvelopeCatchesCaptainsGridSpikeAtAnyPreset is the core sharpening: on a
// 12 kW inverter, an UNBALANCED ~26 kW grid spike (grid jumps, load/pv steady)
// drives the derived battery to ~26 kW, far beyond the 20 kW battery bound. The
// grid channel (largest jump) is held to its last in-envelope value, so all four
// lines - including the derived battery - stay continuous. This fires regardless
// of the despike preset (the envelope is preset-independent).
func TestEnvelopeCatchesCaptainsGridSpikeAtAnyPreset(t *testing.T) {
	e := envFor12k()
	// Baseline: a normal balanced sample. battery = 4 - 5 + 1 = 0, in-envelope.
	base := map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 1}
	if drops := e.Accept(base); len(drops) != 0 {
		t.Fatalf("balanced baseline must pass, got %+v", drops)
	}
	// The captain's spike: grid jumps to 26, load/pv unchanged. Derived battery =
	// 26 - 5 + 1 = 22 kW > 20 kW bound.
	m := map[string]float64{"power_kw": 26, "load_kw": 5, "pv_power_kw": 1}
	drops := e.Accept(m)
	if len(drops) != 1 || drops[0].Channel != "power_kw" || drops[0].Held != 4 {
		t.Fatalf("the grid spike must be identified and held to last-good 4, got %+v", drops)
	}
	if m["power_kw"] != 4 {
		t.Fatalf("grid must be held-last to 4 (continuous derived battery), got %v", m["power_kw"])
	}
	// Derived battery after holding: 4 - 5 + 1 = 0, back in-envelope.
	if b, _ := derivedBattery(m); math.Abs(b) > 20 {
		t.Fatalf("derived battery must be back in-envelope after the hold, got %v", b)
	}
	// The return to a normal grid value is accepted.
	ret := map[string]float64{"power_kw": 4.2, "load_kw": 5, "pv_power_kw": 1}
	if drops := e.Accept(ret); len(drops) != 0 {
		t.Fatalf("the return to a normal grid value must pass, got %+v", drops)
	}
}

// TestEnvelopeBalancedHighGridPasses: a genuine high grid DRAW is balanced by a
// matching house load, so the derived battery stays ~0 - well in-envelope - and
// nothing is held. Pure grid import is NOT inverter-bounded (it follows the house
// connection); only the physically-impossible unbalanced excursion is caught.
func TestEnvelopeBalancedHighGridPasses(t *testing.T) {
	e := envFor12k()
	e.Accept(map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 1})
	// House pulls 30 kW from the grid to run a 31 kW load; battery = 30 - 31 + 1 = 0.
	m := map[string]float64{"power_kw": 30, "load_kw": 31, "pv_power_kw": 1}
	if drops := e.Accept(m); len(drops) != 0 {
		t.Fatalf("a balanced high grid draw must pass (grid is not inverter-bounded), got %+v", drops)
	}
	if m["power_kw"] != 30 {
		t.Fatalf("a balanced high grid value must be preserved, got %v", m["power_kw"])
	}
}

// TestEnvelopeDirectPvBound: a raw PV reading beyond the model's PV envelope is
// held-last directly (this is the only bound for no-battery families, and a
// belt-and-braces bound for hybrids).
func TestEnvelopeDirectPvBound(t *testing.T) {
	e := NewEnvelope()
	pv, _ := EnvelopeFor(5, false) // 5 kW string inverter: PV bound 5*2 + 2 = 12 kW
	e.SetBounds(pv, 0)
	e.Accept(map[string]float64{"pv_power_kw": 3})
	m := map[string]float64{"pv_power_kw": 40}
	drops := e.Accept(m)
	if len(drops) != 1 || drops[0].Channel != "pv_power_kw" || m["pv_power_kw"] != 3 {
		t.Fatalf("a beyond-envelope PV reading must be held to last-good 3, got drops=%+v m=%v", drops, m["pv_power_kw"])
	}
}

// TestEnvelopePvSpikeIdentifiedOverGrid: when PV (not grid) is the spiking
// channel, the derived-battery check still identifies PV as the offender (largest
// jump vs its last in-envelope value) and holds only it.
func TestEnvelopePvSpikeIdentifiedOverGrid(t *testing.T) {
	e := envFor12k()
	e.Accept(map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 2})
	// PV jumps 2 -> 25 (within the 26 kW direct PV bound, so the direct bound does
	// NOT fire), grid/load steady. battery = 4 - 5 + 25 = 24 > 20 -> caught via
	// the balance, PV is the largest jump.
	m := map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 25}
	drops := e.Accept(m)
	if len(drops) != 1 || drops[0].Channel != "pv_power_kw" || m["pv_power_kw"] != 2 {
		t.Fatalf("the PV spike must be identified and held to 2, got drops=%+v m=%v", drops, m["pv_power_kw"])
	}
	if m["power_kw"] != 4 || m["load_kw"] != 5 {
		t.Fatalf("the steady grid/load must be untouched, got %+v", m)
	}
}

// TestEnvelopeNoBatteryFamilyDerivesNothing: a string/micro selection has no
// battery bound, so the derived-battery check never fires (an unbalanced
// grid/load reading has no meaningful battery to bound); only the direct PV
// bound applies.
func TestEnvelopeNoBatteryFamilyDerivesNothing(t *testing.T) {
	e := NewEnvelope()
	pv, batt := EnvelopeFor(5, false)
	if batt != 0 {
		t.Fatalf("a no-battery family must have no battery bound, got %v", batt)
	}
	e.SetBounds(pv, batt)
	e.Accept(map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 3})
	// A wild unbalanced grid value with no battery bound is NOT caught by the
	// balance check (no battery to bound); PV stays within its bound too.
	m := map[string]float64{"power_kw": 50, "load_kw": 5, "pv_power_kw": 3}
	if drops := e.Accept(m); len(drops) != 0 {
		t.Fatalf("no-battery family must not run the derived-battery check, got %+v", drops)
	}
}

// TestEnvelopePersistentBeyondNotAdopted: an envelope violation is a hard bound,
// never adopted after confirmation - a persistently spiking channel keeps being
// held (it indicates a scaling/model misconfiguration to fix on the device).
func TestEnvelopePersistentBeyondNotAdopted(t *testing.T) {
	e := envFor12k()
	e.Accept(map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 1})
	for i := 0; i < 5; i++ {
		m := map[string]float64{"power_kw": 26, "load_kw": 5, "pv_power_kw": 1}
		drops := e.Accept(m)
		if len(drops) != 1 || m["power_kw"] != 4 {
			t.Fatalf("iteration %d: a persistent beyond-envelope grid value must stay held to 4, got drops=%+v m=%v", i, drops, m["power_kw"])
		}
	}
	if got := e.DroppedTotal(); got != 5 {
		t.Fatalf("dropped total = %d, want 5 (each held)", got)
	}
	if by := e.DroppedByChannel(); by["power_kw"] != 5 {
		t.Fatalf("per-channel grid counter = %d, want 5", by["power_kw"])
	}
}

// TestEnvelopeReconfigureLive: changing the selected model live changes the
// bounds; a value in-envelope for a big inverter becomes out-of-envelope for a
// small one, and the last-good state carries across.
func TestEnvelopeReconfigureLive(t *testing.T) {
	e := envFor12k()
	// 18 kW derived battery is in-envelope for the 12 kW model (bound 20).
	e.Accept(map[string]float64{"power_kw": 4, "load_kw": 5, "pv_power_kw": 1})
	ok := map[string]float64{"power_kw": 22, "load_kw": 5, "pv_power_kw": 1} // batt = 18
	if drops := e.Accept(ok); len(drops) != 0 {
		t.Fatalf("battery 18 must be in-envelope for the 12 kW model, got %+v", drops)
	}
	// Switch to a 5 kW model (battery bound 5*1.5 + 2 = 9.5 kW), then re-establish
	// a low steady baseline valid for the small model.
	pv, batt := EnvelopeFor(5, true)
	e.SetBounds(pv, batt)
	e.Accept(map[string]float64{"power_kw": 2, "load_kw": 3, "pv_power_kw": 1}) // batt = 0
	// A grid spike that would have been fine on the 12 kW model (batt 12) is now
	// beyond the 5 kW model's 9.5 kW bound and is caught.
	m := map[string]float64{"power_kw": 14, "load_kw": 3, "pv_power_kw": 1} // batt = 12 > 9.5
	drops := e.Accept(m)
	if len(drops) != 1 || drops[0].Channel != "power_kw" || m["power_kw"] != 2 {
		t.Fatalf("after downsizing the model, the grid spike must be caught and held to 2, got drops=%+v m=%v", drops, m["power_kw"])
	}
}
