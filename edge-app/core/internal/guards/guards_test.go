package guards

import (
	"math"
	"testing"
)

var limits = Limits{MaxChargeKw: 50, MaxDischargeKw: 40, SocMinPct: 5, SocMaxPct: 95}

func reading(soc, pv, load, gridLimit float64) Reading {
	return Reading{SocPct: soc, PvKw: pv, LoadKw: load, GridLimitKw: gridLimit}
}

func TestClampRatedPowerBand(t *testing.T) {
	r := reading(50, 10, 10, 100)
	if got := Clamp(120, limits, r); got != 50 {
		t.Errorf("charge beyond rating: got %v, want 50", got)
	}
	if got := Clamp(-120, limits, r); got != -40 {
		t.Errorf("discharge beyond rating: got %v, want -40", got)
	}
	if got := Clamp(12.3456, limits, r); got != 12.346 {
		t.Errorf("within band rounds to W: got %v", got)
	}
}

func TestClampSocBounds(t *testing.T) {
	if got := Clamp(30, limits, reading(95, 10, 10, 100)); got != 0 {
		t.Errorf("charging at SocMax must clamp to 0, got %v", got)
	}
	if got := Clamp(30, limits, reading(96, 10, 10, 100)); got != 0 {
		t.Errorf("charging above SocMax must clamp to 0, got %v", got)
	}
	if got := Clamp(-30, limits, reading(5, 10, 10, 100)); got != 0 {
		t.Errorf("discharging at SocMin must clamp to 0, got %v", got)
	}
	// Discharging at full SoC stays allowed; charging at empty stays allowed.
	if got := Clamp(-30, limits, reading(95, 10, 10, 100)); got != -30 {
		t.Errorf("discharging at SocMax should pass, got %v", got)
	}
	if got := Clamp(30, limits, reading(5, 10, 10, 100)); got != 30 {
		t.Errorf("charging at SocMin should pass, got %v", got)
	}
}

func TestClampGridLimitImport(t *testing.T) {
	// load 10, pv 0, limit 15: charging 20 would import 30 -> cap at 5.
	if got := Clamp(20, limits, reading(50, 0, 10, 15)); got != 5 {
		t.Errorf("§14a import cap: got %v, want 5", got)
	}
}

func TestClampGridLimitExport(t *testing.T) {
	// load 0, pv 30, limit 15: idle battery would export 30 -> charge 15 to
	// keep export within the envelope.
	if got := Clamp(0, limits, reading(50, 30, 0, 15)); got != 15 {
		t.Errorf("§14a export cap: got %v, want 15", got)
	}
	// Discharging into an already-exporting site must be pulled back.
	if got := Clamp(-20, limits, reading(50, 30, 0, 15)); got != 15 {
		t.Errorf("§14a export cap on discharge command: got %v, want 15", got)
	}
}

func TestClampGridCorrectionNeverEscapesRatedBand(t *testing.T) {
	// The correction wants charge 60 (pv 70, load 0, limit 10) but the
	// battery can only do 50: final must be the rated max, even though the
	// export limit is then physically violated (the grid operator's device
	// enforces it; we do the best the battery can).
	if got := Clamp(0, limits, reading(50, 70, 0, 10)); got != 50 {
		t.Errorf("correction must re-clamp to rated band: got %v, want 50", got)
	}
	// Import side: load 100, pv 0, limit 10 -> correction wants -90; rated
	// discharge is 40.
	if got := Clamp(0, limits, reading(50, 0, 100, 10)); got != -40 {
		t.Errorf("correction must re-clamp to rated band: got %v, want -40", got)
	}
}

func TestClampUnknownReadingsSkipGuards(t *testing.T) {
	r := Reading{SocPct: Unknown(), PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()}
	if got := Clamp(30, limits, r); got != 30 {
		t.Errorf("unknown readings must not block: got %v, want 30", got)
	}
	if got := Clamp(999, limits, r); got != 50 {
		t.Errorf("power band still applies: got %v, want 50", got)
	}
}

func TestClampNonFinite(t *testing.T) {
	r := reading(50, 10, 10, 100)
	if got := Clamp(math.NaN(), limits, r); got != 0 {
		t.Errorf("NaN command: got %v, want 0", got)
	}
	if got := Clamp(math.Inf(1), limits, r); got != 0 {
		t.Errorf("Inf command: got %v, want 0", got)
	}
}

func TestClampCombinedSocAndGrid(t *testing.T) {
	// Battery full + §14a export correction wants to charge: SoC guard put
	// kw at 0, the correction raises it, but the SoC guard result must not
	// be overridden into charging a full battery... the correction runs
	// after SoC, so verify the final value respects the rated band and the
	// invariant: never charge a full battery MORE than the §14a correction
	// requires. Contractually §14a is enforced by the grid operator; SoC
	// protection is the battery's own BMS. Our order (SoC first, §14a after)
	// mirrors the Node-RED guard chain.
	got := Clamp(20, limits, reading(95, 30, 0, 15))
	if got != 15 {
		t.Errorf("§14a correction after SoC clamp: got %v, want 15", got)
	}
}

func TestSelfConsumption(t *testing.T) {
	if got := SelfConsumption(reading(50, 12, 8, 100)); got != 4 {
		t.Errorf("surplus charges: got %v, want 4", got)
	}
	if got := SelfConsumption(reading(50, 2, 8, 100)); got != -6 {
		t.Errorf("deficit discharges: got %v, want -6", got)
	}
	if got := SelfConsumption(Reading{PvKw: Unknown(), LoadKw: 5}); got != 0 {
		t.Errorf("unknown pv: got %v, want 0", got)
	}
}

// TestSocPlausible pins the SAME vectors as the canonical Deye decoder gate's
// test (edge-app/nodered/deye/deye-decode.test.js "socPlausible accepts (0,100]
// and rejects ..."), so the Go and JS implementations cannot drift apart.
func TestSocPlausible(t *testing.T) {
	accept := []float64{57, 0.5, 100, 8}
	for _, v := range accept {
		if !SocPlausible(v) {
			t.Errorf("SocPlausible(%v) = false, want true", v)
		}
	}
	reject := []float64{0, -1, 100.1, 1250, 1270, math.NaN(), math.Inf(1), math.Inf(-1)}
	for _, v := range reject {
		if SocPlausible(v) {
			t.Errorf("SocPlausible(%v) = true, want false", v)
		}
	}
}
