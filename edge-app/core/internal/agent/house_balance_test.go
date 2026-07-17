package agent

// The captain-decreed house-consumption STANDARD (2026-07-17, verbatim: "Haus
// = Erzeugung (inkl. Fronius) − Einspeisung (hier wird der Fronius auch mit
// gemessen) − Batterie (Register lesen hybrid inverter -> nicht berechnen!)"):
//
//	house = pv_total + grid - battery   (grid +import/-export, battery +charge/-discharge)
//
// is THE rule whenever a site-authoritative grid value exists - a fresh Netz
// (grid-meter) reading takes precedence, else the primary inverter's own grid
// reading serves BY DEFAULT (opt-out via sources.BalanceSettings
// PrimaryGridNotSiteTotal for the genuinely different topology). The battery
// term is the hybrid's MEASURED register, never derived. These tests prove:
//   - the captain's live-site canonical fixture: PV 23,7 + 22 + 26,9 = 72,6 kW,
//     true connection-point export 54,2 kW, battery 0 -> house 18,4 kW; the
//     Deye's raw load register (−30,5) never surfaces as the site house;
//   - meter precedence over the primary's grid; the default-on standard with
//     no meter; the expert opt-out restoring the raw-load fallback;
//   - every sign case (import/export x charge/discharge, PV zero);
//   - honesty: a PROVABLE hybrid without a battery reading drops the house
//     (never an estimate that pretends battery = 0); an unknown family falls
//     back to the raw-load estimate; a provably batteryless primary counts
//     battery as a physical 0;
//   - persistence of the opt-out across restarts.

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// feedPrimaryBatt publishes a primary sample that carries the measured battery
// power (+ charge / - discharge) alongside the canonical channels.
func feedPrimaryBatt(a *Agent, pv, load, grid, soc, batt float64) {
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(fmt.Sprintf(
		`{"pv_power_kw": %v, "load_kw": %v, "power_kw": %v, "soc_pct": %v, "battery_power_kw": %v}`,
		pv, load, grid, soc, batt)))
}

func selectPrimary(t *testing.T, a *Agent, brand, model string) {
	t.Helper()
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand:      brand,
		Model:      model,
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("SetInverter(%s/%s): %v", brand, model, err)
	}
}

func ageSource(a *Agent, id string) {
	a.srcMu.Lock()
	r := a.srcReadings[id]
	r.recv = time.Now().Add(-10 * time.Minute)
	a.srcReadings[id] = r
	a.srcMu.Unlock()
}

// optOut declares the expert exception "Die Netzmessung des Wechselrichters
// sitzt NICHT am Hausanschluss" - the primary's grid reading then never serves
// as the site grid.
func optOut(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetBalance(sources.BalanceSettings{PrimaryGridNotSiteTotal: true}); err != nil {
		t.Fatalf("SetBalance: %v", err)
	}
}

// TestStandardReproducesTheCaptainsLiveSite is the CANONICAL fixture from the
// captain's live device (2026-07-17): a Deye SUN-30K hybrid_3p primary
// (own PV 23,7 kW, battery register 0) plus two Fronius Eco Erzeuger sources
// (22 + 26,9 kW) behind one Datamanager - site PV 72,6 kW. The true
// connection-point export at that moment was 54,2 kW (the hybrid_3p External
// CT register; the "Grid Power" alias wrongly read −23,7 = exactly the Deye's
// own PV before the register fix), and the Deye's own load register showed the
// internally-netted −30,5 (= 23,7 − 54,2). NO meter, NO toggle - the standard
// is on by default:
//
//	house = 72,6 − 54,2 − 0 = 18,4 kW
//
// and the raw −30,5 must never surface as the site house consumption.
func TestStandardReproducesTheCaptainsLiveSite(t *testing.T) {
	a := newGateTestAgent(t)
	selectPrimary(t, a, inverter.BrandDeye, "sun-30k-sg01hp3")
	wr1 := addErzeuger(t, a, 30)
	wr2 := addErzeuger(t, a, 30)
	feedSource(a, wr1.ID, 22)
	feedSource(a, wr2.ID, 26.9)

	feedPrimaryBatt(a, 23.7, -30.5, -54.2, 53, 0)

	snap := a.State.Get()
	approx(t, snap.PvKw, 72.6, "site PV (23,7 + 22 + 26,9)")
	approx(t, snap.LoadKw, 18.4, "house per the standard (72,6 − 54,2 − 0)")
	if got := gridOf(t, a); got != -54.2 {
		t.Fatalf("site grid = %v, want -54.2 (the primary's connection-point reading)", got)
	}
	// The Deye's raw load register stays visible ONLY as the per-device
	// "Zuletzt gelesen" diagnosis value - never as the site house.
	if snap.LastReading["load_kw"] != -30.5 {
		t.Fatalf("per-device raw load = %v, want -30.5 (diagnosis row keeps RAW readings)", snap.LastReading["load_kw"])
	}
	last, ok := a.hist.Latest()
	if !ok || last.LoadKw == nil {
		t.Fatal("history house missing")
	}
	approx(t, *last.LoadKw, 18.4, "history house (never the raw -30.5)")
	// The battery line is the MEASURED register (0), not a derivation.
	if last.BattKw == nil || *last.BattKw != 0 {
		t.Fatalf("history battery = %v, want the measured 0", last.BattKw)
	}
}

// TestHouseFromBalanceReproducesTheCaptainsMeterTopology: the Netz-meter
// variant (meter at the PCC always takes precedence). Site PV 35 kW (primary
// hybrid 20 + AC-coupled Erzeuger 15), battery discharging 8.5 kW, meter reads
// 43.6 kW export -> house = 35 - 43.6 + 8.5 = -0.1 ~ 0 (noise around a
// balanced node clamps, never negative).
func TestHouseFromBalanceReproducesTheCaptainsMeterTopology(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)

	feedSource(a, erz.ID, 15)
	feedNetz(a, netz.ID, -43.6)
	// The primary's own grid reading (-35) and load reading (16) must both be
	// beaten by the meter + the balance.
	feedPrimaryBatt(a, 20, 16, -35, 50, -8.5)

	snap := a.State.Get()
	if snap.PvKw != 35 {
		t.Fatalf("site PV = %v, want 35 (primary 20 + Erzeuger 15)", snap.PvKw)
	}
	if snap.LoadKw != 0 {
		t.Fatalf("house = %v, want 0 (35 - 43.6 + 8.5 = -0.1 clamps to 0)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("site grid = %v, want -43.6 (meter authoritative)", got)
	}

	// A different authoritative grid (less export) now yields the REAL non-zero
	// house.
	feedNetz(a, netz.ID, -30)
	feedPrimaryBatt(a, 20, 16, -35, 50, -8.5)
	snap = a.State.Get()
	if snap.LoadKw != 13.5 {
		t.Fatalf("house = %v, want 13.5 (35 - 30 + 8.5)", snap.LoadKw)
	}
}

func TestHouseFromBalanceSignCases(t *testing.T) {
	cases := []struct {
		name                 string
		pv, grid, batt, want float64
	}{
		{"importing while charging (cheap-price grid charge)", 0, 5, 3, 2},
		{"importing while discharging (evening peak support)", 0, 2, -3, 5},
		{"exporting while charging (midday surplus)", 10, -4, 2, 4},
		{"pv zero, battery idle (plain night import)", 0, 1.2, 0, 1.2},
		{"exporting while discharging", 6, -2, -1.5, 5.5},
	}
	for _, tc := range cases {
		t.Run(tc.name+" via meter", func(t *testing.T) {
			a := newGateTestAgent(t)
			netz := addNetz(t, a)
			feedNetz(a, netz.ID, tc.grid)
			// The primary's own load reading (99) is deliberately garbage so the
			// assertion can only pass via the balance.
			feedPrimaryBatt(a, tc.pv, 99, 0, 50, tc.batt)
			if got := a.State.Get().LoadKw; got != tc.want {
				t.Fatalf("house = %v, want %v (pv %v + grid %v - batt %v)",
					got, tc.want, tc.pv, tc.grid, tc.batt)
			}
		})
		t.Run(tc.name+" via primary grid (default standard)", func(t *testing.T) {
			a := newGateTestAgent(t)
			feedPrimaryBatt(a, tc.pv, 99, tc.grid, 50, tc.batt)
			if got := a.State.Get().LoadKw; got != tc.want {
				t.Fatalf("house = %v, want %v (pv %v + grid %v - batt %v)",
					got, tc.want, tc.pv, tc.grid, tc.batt)
			}
		})
	}
}

// TestStandardIsOnByDefaultWithoutMeter pins the decree: a fresh agent (no
// meter, no toggle ever touched) runs the balance off the primary's own grid
// reading - the pre-standard opt-in estimate is gone.
func TestStandardIsOnByDefaultWithoutMeter(t *testing.T) {
	a := newGateTestAgent(t)
	if a.GetBalance().PrimaryGridNotSiteTotal {
		t.Fatal("the opt-out must default to false (standard ON)")
	}
	erz := addErzeuger(t, a, 30)
	feedSource(a, erz.ID, 15)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 0 { // 35 - 43.6 + 8.5 = -0.1 clamps; NOT the estimate max(0, 16-15) = 1
		t.Fatalf("house = %v, want 0 (the standard balance, not the estimate)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("grid = %v, want -43.6 (primary CT)", got)
	}
}

// TestExpertOptOutRestoresTheRawLoadFallback: the declared exception topology
// ("CT nicht am Hausanschluss") withdraws the primary's grid from site-grid
// duty - the raw-load fallback path (Erzeuger netting estimate) applies again.
func TestExpertOptOutRestoresTheRawLoadFallback(t *testing.T) {
	a := newGateTestAgent(t)
	optOut(t, a)
	erz := addErzeuger(t, a, 30)
	feedSource(a, erz.ID, 15)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 1 { // max(0, 16 - 15): the fallback estimate
		t.Fatalf("load = %v, want 1 (opt-out -> raw-load fallback)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("grid = %v, want -43.6 (published grid untouched by the opt-out)", got)
	}
}

// TestNetzMeterWinsOverThePrimaryGrid: a FRESH dedicated meter overrides the
// primary's reading (its grid drives both power_kw and the balance); once the
// meter goes stale the default standard keeps the balance alive off the
// primary's CT instead of degrading to the estimate.
func TestNetzMeterWinsOverThePrimaryGrid(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)
	feedSource(a, erz.ID, 15)
	feedNetz(a, netz.ID, -30)

	// Meter fresh: its -30 wins over the primary CT's -43.6.
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap := a.State.Get()
	if got := gridOf(t, a); got != -30 {
		t.Fatalf("grid = %v, want -30 (fresh meter wins)", got)
	}
	if snap.LoadKw != 13.5 {
		t.Fatalf("house = %v, want 13.5 (35 - 30 + 8.5, from the METER grid)", snap.LoadKw)
	}

	// Meter stale: the standard takes over with the primary's own CT.
	ageSource(a, netz.ID)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap = a.State.Get()
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("grid = %v, want -43.6 (stale meter -> primary CT)", got)
	}
	if snap.LoadKw != 0 {
		t.Fatalf("house = %v, want 0 (35 - 43.6 + 8.5 clamps; the standard, not the estimate)", snap.LoadKw)
	}
}

// TestStaleNetzMeterWithOptOutFallsBackToTheEstimate: opt-out + stale meter =
// no usable site grid at all -> the raw-load fallback.
func TestStaleNetzMeterWithOptOutFallsBackToTheEstimate(t *testing.T) {
	a := newGateTestAgent(t)
	optOut(t, a)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)
	feedSource(a, erz.ID, 15)
	feedNetz(a, netz.ID, -30)
	ageSource(a, netz.ID)

	feedPrimaryBatt(a, 20, 16, -35, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 1 { // back to max(0, 16 - 15), never a wrong balance
		t.Fatalf("load = %v, want 1 (stale meter + opt-out -> estimate)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -35 {
		t.Fatalf("grid = %v, want -35 (stale meter -> primary CT)", got)
	}
}

// TestUnknownBatteryPowerDegradesPerClass: without a battery reading the
// standard must never pretend battery = 0. An UNKNOWN family (no selection -
// the device MAY have a battery) falls back to the raw-load estimate; a
// PROVABLE hybrid (the register exists and should have been read) drops the
// house outright - an honest gap instead of a wrong number.
func TestUnknownBatteryPowerDegradesPerClass(t *testing.T) {
	t.Run("no inverter selection -> raw-load fallback", func(t *testing.T) {
		a := newGateTestAgent(t)
		erz := addErzeuger(t, a, 30)
		netz := addNetz(t, a)
		feedSource(a, erz.ID, 15)
		feedNetz(a, netz.ID, -30)
		feedPrimary(a, 20, 16, -35, 50) // no battery_power_kw in the sample
		snap := a.State.Get()
		if snap.LoadKw != 1 { // the estimate, NOT 35-30-? = a guessed balance
			t.Fatalf("load = %v, want 1 (unknown family + unknown battery -> estimate)", snap.LoadKw)
		}
		if got := gridOf(t, a); got != -30 {
			t.Fatalf("grid = %v, want -30 (meter still authoritative)", got)
		}
	})
	t.Run("provable hybrid -> honest absence", func(t *testing.T) {
		a := newGateTestAgent(t)
		selectPrimary(t, a, inverter.BrandDeye, "sun-12k-sg04lp3")
		erz := addErzeuger(t, a, 30)
		netz := addNetz(t, a)
		feedSource(a, erz.ID, 15)
		feedNetz(a, netz.ID, -30)
		feedPrimary(a, 20, 16, -35, 50) // hybrid family, battery register missing
		last, ok := a.hist.Latest()
		if !ok {
			t.Fatal("no history sample recorded")
		}
		if last.LoadKw != nil {
			t.Fatalf("house = %v, want an honest gap (hybrid without battery reading)", *last.LoadKw)
		}
		if last.BattKw != nil {
			t.Fatalf("battery = %v, want an honest gap (register unreadable)", *last.BattKw)
		}
		// The per-device raw row keeps its diagnosis value.
		if a.State.Get().LastReading["load_kw"] != 16 {
			t.Fatalf("per-device raw load = %v, want 16", a.State.Get().LastReading["load_kw"])
		}
		if got := gridOf(t, a); got != -30 {
			t.Fatalf("grid = %v, want -30 (meter still authoritative)", got)
		}
	})
}

// TestBatterylessPrimaryBalancesWithZeroBattery: a provably batteryless
// primary (Deye string family) needs no battery reading - 0 is a physical
// fact. Proven via meter AND via the default primary-grid standard, which even
// CREATES the load channel for a generation-only device.
func TestBatterylessPrimaryBalancesWithZeroBattery(t *testing.T) {
	t.Run("via meter", func(t *testing.T) {
		a := newGateTestAgent(t)
		selectPrimary(t, a, inverter.BrandDeye, "sun-5k-g03")
		netz := addNetz(t, a)
		feedNetz(a, netz.ID, -3)
		// A string primary reports only generation (pv); no load, no battery.
		a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 5}`))
		if got := a.State.Get().LoadKw; got != 2 {
			t.Fatalf("house = %v, want 2 (5 pv - 3 export, batteryless)", got)
		}
		// The battery line is a physical 0, not a gap.
		if last, ok := a.hist.Latest(); !ok || last.BattKw == nil || *last.BattKw != 0 {
			t.Fatalf("battery = %v, want the physical 0", last.BattKw)
		}
	})
	t.Run("via primary grid (default standard)", func(t *testing.T) {
		a := newGateTestAgent(t)
		selectPrimary(t, a, inverter.BrandDeye, "sun-5k-g03")
		a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 5, "power_kw": -3}`))
		if got := a.State.Get().LoadKw; got != 2 {
			t.Fatalf("house = %v, want 2 (5 pv - 3 export, batteryless)", got)
		}
	})
}

// TestStringInverterWithoutGridStaysHonestlyAbsent: a generation-only primary
// with NO grid reading and NO meter has no house to show - the standard never
// fabricates one, and there is no raw load to pass through either.
func TestStringInverterWithoutGridStaysHonestlyAbsent(t *testing.T) {
	a := newGateTestAgent(t)
	selectPrimary(t, a, inverter.BrandDeye, "sun-5k-g03")
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 5}`))
	last, ok := a.hist.Latest()
	if !ok {
		t.Fatal("no history sample recorded")
	}
	if last.LoadKw != nil {
		t.Fatalf("house = %v, want absent (no grid value anywhere)", *last.LoadKw)
	}
}

// TestMissingPvFallsBackToTheEstimate: without the composite PV the balance is
// incomputable - an unknown-family primary keeps whatever load the sample
// carried (the raw-load fallback).
func TestMissingPvFallsBackToTheEstimate(t *testing.T) {
	a := newGateTestAgent(t)
	netz := addNetz(t, a)
	feedNetz(a, netz.ID, 4)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"load_kw": 7, "power_kw": 3, "soc_pct": 50, "battery_power_kw": 1}`))
	snap := a.State.Get()
	if snap.LoadKw != 7 {
		t.Fatalf("load = %v, want 7 (no pv -> no balance)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != 4 {
		t.Fatalf("grid = %v, want 4 (meter authoritative regardless)", got)
	}
}

// TestSingleHybridFallbackWithoutGridReading: the documented surviving raw-load
// path - a plain single inverter (no sources) whose sample carries no grid
// reading passes its load register through unchanged.
func TestSingleHybridFallbackWithoutGridReading(t *testing.T) {
	a := newGateTestAgent(t)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"pv_power_kw": 20, "load_kw": 7, "soc_pct": 50, "battery_power_kw": 1}`))
	if got := a.State.Get().LoadKw; got != 7 {
		t.Fatalf("load = %v, want 7 (no grid -> raw-load passthrough)", got)
	}
}

// TestBalanceSettingsPersistAcrossRestart: the expert opt-out survives a device
// reboot (data-dir/balance.json) and is live again without re-configuration.
func TestBalanceSettingsPersistAcrossRestart(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a1, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	optOut(t, a1)
	a1.Stop()

	a2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a2.Stop)
	if !a2.GetBalance().PrimaryGridNotSiteTotal {
		t.Fatal("opt-out not restored from disk after restart")
	}
	feedPrimaryBatt(a2, 10, 99, -4, 50, 2)
	if got := a2.State.Get().LoadKw; got != 99 {
		t.Fatalf("load = %v, want 99 (opt-out active after restart -> raw load)", got)
	}
}

// TestLegacyBalanceJsonMigratesToTheStandard: a pre-standard balance.json
// (opt-in era) migrates to standard-ON regardless of the stored value - an
// explicit legacy ON stays on, and the legacy default false is superseded by
// the decree (the genuinely different topology is re-declared via the new
// opt-out).
func TestLegacyBalanceJsonMigratesToTheStandard(t *testing.T) {
	for _, legacy := range []string{
		`{"primary_grid_is_site_total": true}`,
		`{"primary_grid_is_site_total": false}`,
	} {
		cfg := config.Defaults()
		cfg.DataDir = t.TempDir()
		if err := os.WriteFile(filepath.Join(cfg.DataDir, "balance.json"), []byte(legacy), 0o644); err != nil {
			t.Fatal(err)
		}
		a, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(a.Stop)
		if a.GetBalance().PrimaryGridNotSiteTotal {
			t.Fatalf("legacy %s must migrate to opt-out=false (standard ON)", legacy)
		}
		feedPrimaryBatt(a, 10, 99, -4, 50, 2)
		if got := a.State.Get().LoadKw; got != 4 {
			t.Fatalf("house = %v, want 4 (10 - 4 - 2: the standard runs after migration)", got)
		}
		a.Stop()
	}
}

// TestBatteryPowerNeverLeaksIntoPublishedMeasurements: battery_power_kw is a
// local input - the cloud-published measurement channels and the per-device
// raw row must not grow a battery channel (the cloud keeps deriving battery
// from the balance, which with the balance-derived load resolves to the
// measured value); the LOCAL history ring however carries the MEASURED value
// for the dashboard's battery line.
func TestBatteryPowerNeverLeaksIntoPublishedMeasurements(t *testing.T) {
	a := newGateTestAgent(t)
	netz := addNetz(t, a)
	feedNetz(a, netz.ID, -2)
	feedPrimaryBatt(a, 6, 99, 0, 50, -1.5)

	rec := a.hist.Recent(time.Hour, time.Now())
	if len(rec) == 0 {
		t.Fatal("no history sample recorded")
	}
	last := rec[len(rec)-1]
	// The ring's battery line is the MEASURED register...
	if last.BattKw == nil || *last.BattKw != -1.5 {
		t.Fatalf("ring battery = %v, want the measured -1.5", last.BattKw)
	}
	// ...and the balance cross-check (diagnostic only) agrees here: with the
	// balance-derived load, grid - house + pv = batt.
	if batt, ok := last.BatteryKw(); !ok || batt != -1.5 {
		t.Fatalf("derived battery = %v (ok=%v), want -1.5 (grid -2 - house 5.5 + pv 6)", batt, ok)
	}
	if last.LoadKw == nil || *last.LoadKw != 5.5 {
		t.Fatalf("house on the ring = %v, want 5.5", last.LoadKw)
	}
	// No battery channel on the published/per-device surfaces.
	if _, ok := a.State.Get().LastReading["battery_power_kw"]; ok {
		t.Fatal("battery_power_kw must not appear as a measurement channel")
	}
}
