package agent

// House load from the site power balance (Netz-Zähler feature): with a
// battery-hybrid primary PLUS a separate AC-coupled PV, NEITHER device measures
// the true house consumption - the Erzeuger load-subtraction max(0, load - Σpv)
// clamps to 0 behind a large AC PV and masked the captain's real consumption
// ("Hausverbrauch 0,0 kW"). Once a FRESH Netz (grid-meter) reading is
// authoritative the agent derives
//
//	house = pv_total + grid - battery   (grid +import/-export, battery +charge/-discharge)
//
// at the onLocalTelemetry choke point. These tests prove:
//   - the captain's real numbers: PV 35 kW, battery discharging 8.5 kW, grid
//     export 43.6 kW -> house ~0; a different authoritative grid -> a real
//     non-zero house the old estimate could never show;
//   - every sign case (import/export x charge/discharge, PV zero);
//   - meter-gating: no/stale Netz meter keeps the old estimate byte-for-byte;
//   - honesty: unknown battery power (possible battery, none reported) or a
//     missing composite PV falls back to the estimate - never a fabricated
//     house; a provably batteryless primary counts battery as a physical 0;
//   - the balance value (not the battery input) is what reaches the live paths.

import (
	"fmt"
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

// TestHouseFromBalanceReproducesTheCaptainsTopology is the numeric scenario
// from the captain's live device: Deye battery-hybrid primary + a separate
// AC-coupled Fronius PV as Erzeuger source + a Netz meter at the PCC.
func TestHouseFromBalanceReproducesTheCaptainsTopology(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)

	// Site PV 35 kW total: primary hybrid 20 + AC-coupled Erzeuger 15.
	feedSource(a, erz.ID, 15)
	// Battery discharging 8.5 kW, meter reads 43.6 kW export: the site is
	// (nearly) fully exporting -> house = 35 - 43.6 + 8.5 = -0.1 ~ 0 (noise
	// around a balanced node clamps, never negative).
	feedNetz(a, netz.ID, -43.6)
	// The primary's own load reading (16) is the misattributed garbage the old
	// estimate would have used: max(0, 16 - 15) = 1.
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
	// house the estimate structurally cannot show (it stays clamped near 0).
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
		t.Run(tc.name, func(t *testing.T) {
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
	}
}

// TestNoNetzMeterKeepsTheEstimateByteForByte: battery power in the sample alone
// must change NOTHING - the balance is meter-gated.
func TestNoNetzMeterKeepsTheEstimateByteForByte(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 30)
	feedSource(a, erz.ID, 15)
	feedPrimaryBatt(a, 20, 16, -35, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 1 { // max(0, 16 - 15): the existing Erzeuger estimate
		t.Fatalf("load = %v, want 1 (estimate; no meter -> no balance)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -35 {
		t.Fatalf("grid = %v, want -35 (primary CT; no meter)", got)
	}
}

func TestStaleNetzMeterFallsBackToTheEstimate(t *testing.T) {
	a := newGateTestAgent(t)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)
	feedSource(a, erz.ID, 15)
	feedNetz(a, netz.ID, -30)
	ageSource(a, netz.ID)

	feedPrimaryBatt(a, 20, 16, -35, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 1 { // back to max(0, 16 - 15), never a wrong balance
		t.Fatalf("load = %v, want 1 (stale meter -> estimate)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -35 {
		t.Fatalf("grid = %v, want -35 (stale meter -> primary CT)", got)
	}
}

// TestUnknownBatteryPowerFallsBackToTheEstimate: a primary that MAY have a
// battery (hybrid selection, or no selection at all) without battery power in
// the sample must keep the estimate - the balance would be wrong by the full
// battery power, and a fabricated house is worse than the honest estimate.
func TestUnknownBatteryPowerFallsBackToTheEstimate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		choose func(t *testing.T, a *Agent)
	}{
		{"no inverter selection", func(t *testing.T, a *Agent) {}},
		{"hybrid selection", func(t *testing.T, a *Agent) {
			selectPrimary(t, a, inverter.BrandDeye, "sun-12k-sg04lp3")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newGateTestAgent(t)
			tc.choose(t, a)
			erz := addErzeuger(t, a, 30)
			netz := addNetz(t, a)
			feedSource(a, erz.ID, 15)
			feedNetz(a, netz.ID, -30)
			feedPrimary(a, 20, 16, -35, 50) // no battery_power_kw in the sample
			snap := a.State.Get()
			if snap.LoadKw != 1 { // the estimate, NOT 35-30-? = a guessed balance
				t.Fatalf("load = %v, want 1 (unknown battery -> estimate)", snap.LoadKw)
			}
			// The grid override itself is independent of the balance and stays.
			if got := gridOf(t, a); got != -30 {
				t.Fatalf("grid = %v, want -30 (meter still authoritative)", got)
			}
		})
	}
}

// TestBatterylessPrimaryBalancesWithZeroBattery: a provably batteryless primary
// (Deye string family) needs no battery reading - 0 is a physical fact.
func TestBatterylessPrimaryBalancesWithZeroBattery(t *testing.T) {
	a := newGateTestAgent(t)
	selectPrimary(t, a, inverter.BrandDeye, "sun-5k-g03")
	netz := addNetz(t, a)
	feedNetz(a, netz.ID, -3)
	// A string primary reports only generation (pv); no load, no battery.
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 5}`))
	snap := a.State.Get()
	if snap.LoadKw != 2 { // 5 - 3 - 0: the balance even CREATES the load channel
		t.Fatalf("house = %v, want 2 (5 pv - 3 export, batteryless)", snap.LoadKw)
	}
}

// TestMissingPvFallsBackToTheEstimate: without the composite PV the balance is
// incomputable - keep whatever load the sample carried.
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

/* ---- "Primär misst den gesamten Netzübergang" toggle (no dedicated meter) ----
   The captain's real case: a Deye battery-hybrid whose grid CT sits at the
   point of common coupling and already measures the whole site exchange incl.
   the separate AC-coupled Fronius PV (his live numbers close the balance:
   PV 35 + discharge 8.5 ≈ export 43.6). With the operator-declared
   primary_grid_is_site_total toggle ON, the SAME house balance runs off the
   primary's own power_kw - no meter hardware needed. Default OFF keeps the
   estimate byte-for-byte (topology-dependent: a primary CT that does NOT see
   the AC PV would over-count); a fresh Netz meter always takes precedence. */

func enablePrimGrid(t *testing.T, a *Agent) {
	t.Helper()
	if _, err := a.SetBalance(sources.BalanceSettings{PrimaryGridIsSiteTotal: true}); err != nil {
		t.Fatalf("SetBalance: %v", err)
	}
}

// TestPrimaryGridSiteTotalReproducesTheCaptainsTopologyWithoutMeter: the exact
// numeric scenario from the task, with NO Netz meter configured - the primary's
// own grid reading closes the balance.
func TestPrimaryGridSiteTotalReproducesTheCaptainsTopologyWithoutMeter(t *testing.T) {
	a := newGateTestAgent(t)
	enablePrimGrid(t, a)
	erz := addErzeuger(t, a, 30)

	// Site PV 35 kW total: primary hybrid 20 + AC-coupled Erzeuger 15. The
	// primary's CT reads 43.6 kW export FOR THE WHOLE SITE (it sees the Fronius
	// feed-in too); battery discharging 8.5 kW.
	feedSource(a, erz.ID, 15)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)

	snap := a.State.Get()
	if snap.PvKw != 35 {
		t.Fatalf("site PV = %v, want 35 (primary 20 + Erzeuger 15)", snap.PvKw)
	}
	if snap.LoadKw != 0 {
		t.Fatalf("house = %v, want 0 (35 - 43.6 + 8.5 = -0.1 clamps to 0)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("site grid = %v, want -43.6 (the primary CT, unchanged)", got)
	}

	// Less export on the next sample -> the REAL non-zero house the old
	// estimate (max(0, 16 - 15) = 1) structurally cannot show.
	feedPrimaryBatt(a, 20, 16, -30, 50, -8.5)
	if got := a.State.Get().LoadKw; got != 13.5 {
		t.Fatalf("house = %v, want 13.5 (35 - 30 + 8.5)", got)
	}
}

func TestPrimaryGridToggleSignCases(t *testing.T) {
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
		t.Run(tc.name, func(t *testing.T) {
			a := newGateTestAgent(t)
			enablePrimGrid(t, a)
			// The primary's own load reading (99) is deliberately garbage so the
			// assertion can only pass via the balance off the primary's grid.
			feedPrimaryBatt(a, tc.pv, 99, tc.grid, 50, tc.batt)
			if got := a.State.Get().LoadKw; got != tc.want {
				t.Fatalf("house = %v, want %v (pv %v + grid %v - batt %v)",
					got, tc.want, tc.pv, tc.grid, tc.batt)
			}
		})
	}
}

// TestPrimaryGridToggleDefaultsOff pins the safety default: a fresh agent has
// the toggle OFF, so even a sample carrying battery power keeps the estimate
// byte-for-byte (no existing install changes behavior silently).
func TestPrimaryGridToggleDefaultsOff(t *testing.T) {
	a := newGateTestAgent(t)
	if a.GetBalance().PrimaryGridIsSiteTotal {
		t.Fatal("primary_grid_is_site_total must default to false")
	}
	erz := addErzeuger(t, a, 30)
	feedSource(a, erz.ID, 15)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap := a.State.Get()
	if snap.LoadKw != 1 { // max(0, 16 - 15): the existing Erzeuger estimate
		t.Fatalf("load = %v, want 1 (toggle off -> estimate, never the balance)", snap.LoadKw)
	}
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("grid = %v, want -43.6 (primary CT untouched)", got)
	}
}

// TestNetzMeterWinsOverThePrimaryGridToggle: a FRESH dedicated meter overrides
// the toggle (its grid drives both power_kw and the balance); once the meter
// goes stale the toggle keeps the balance alive off the primary's CT instead of
// degrading all the way to the estimate.
func TestNetzMeterWinsOverThePrimaryGridToggle(t *testing.T) {
	a := newGateTestAgent(t)
	enablePrimGrid(t, a)
	erz := addErzeuger(t, a, 30)
	netz := addNetz(t, a)
	feedSource(a, erz.ID, 15)
	feedNetz(a, netz.ID, -30)

	// Meter fresh: its -30 wins over the primary CT's -43.6.
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap := a.State.Get()
	if got := gridOf(t, a); got != -30 {
		t.Fatalf("grid = %v, want -30 (fresh meter wins over the toggle)", got)
	}
	if snap.LoadKw != 13.5 {
		t.Fatalf("house = %v, want 13.5 (35 - 30 + 8.5, from the METER grid)", snap.LoadKw)
	}

	// Meter stale: the toggle path takes over with the primary's own CT.
	ageSource(a, netz.ID)
	feedPrimaryBatt(a, 20, 16, -43.6, 50, -8.5)
	snap = a.State.Get()
	if got := gridOf(t, a); got != -43.6 {
		t.Fatalf("grid = %v, want -43.6 (stale meter -> primary CT)", got)
	}
	if snap.LoadKw != 0 {
		t.Fatalf("house = %v, want 0 (35 - 43.6 + 8.5 clamps; toggle balance, not the estimate)", snap.LoadKw)
	}
}

// TestPrimaryGridToggleUnknownBatteryFallsBackToTheEstimate: a hybrid primary
// without battery power in the sample keeps the estimate - the toggle never
// fabricates a balance that would be wrong by the full battery power.
func TestPrimaryGridToggleUnknownBatteryFallsBackToTheEstimate(t *testing.T) {
	a := newGateTestAgent(t)
	enablePrimGrid(t, a)
	selectPrimary(t, a, inverter.BrandDeye, "sun-12k-sg04lp3")
	erz := addErzeuger(t, a, 30)
	feedSource(a, erz.ID, 15)
	feedPrimary(a, 20, 16, -35, 50) // no battery_power_kw in the sample
	if got := a.State.Get().LoadKw; got != 1 {
		t.Fatalf("load = %v, want 1 (unknown battery -> estimate)", got)
	}
}

// TestPrimaryGridToggleMissingGridKeepsTheSampleLoad: without power_kw in the
// sample there is no site grid to balance against - the load passes through.
func TestPrimaryGridToggleMissingGridKeepsTheSampleLoad(t *testing.T) {
	a := newGateTestAgent(t)
	enablePrimGrid(t, a)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"pv_power_kw": 20, "load_kw": 7, "soc_pct": 50, "battery_power_kw": 1}`))
	if got := a.State.Get().LoadKw; got != 7 {
		t.Fatalf("load = %v, want 7 (no grid -> no balance)", got)
	}
}

// TestPrimaryGridToggleBatterylessPrimary: a provably batteryless primary
// (Deye string family) balances with battery = 0 - the toggle even CREATES the
// load channel for a generation-only device whose CT is at the PCC.
func TestPrimaryGridToggleBatterylessPrimary(t *testing.T) {
	a := newGateTestAgent(t)
	enablePrimGrid(t, a)
	selectPrimary(t, a, inverter.BrandDeye, "sun-5k-g03")
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 5, "power_kw": -3}`))
	if got := a.State.Get().LoadKw; got != 2 {
		t.Fatalf("house = %v, want 2 (5 pv - 3 export, batteryless)", got)
	}
}

// TestBalanceSettingsPersistAcrossRestart: the toggle survives a device reboot
// (data-dir/balance.json) and is live again without re-configuration.
func TestBalanceSettingsPersistAcrossRestart(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a1, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	enablePrimGrid(t, a1)
	a1.Stop()

	a2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a2.Stop)
	if !a2.GetBalance().PrimaryGridIsSiteTotal {
		t.Fatal("toggle not restored from disk after restart")
	}
	feedPrimaryBatt(a2, 10, 99, -4, 50, 2)
	if got := a2.State.Get().LoadKw; got != 4 {
		t.Fatalf("house = %v, want 4 (10 - 4 - 2: the balance is active after restart)", got)
	}
}

// TestBatteryPowerNeverLeaksIntoPublishedMeasurements: battery_power_kw is an
// internal balance input, not a measurement channel - the cloud buffer, the
// history ring and the snapshot must not grow a battery channel (the cloud
// keeps deriving battery from the balance, which now resolves to the measured
// value: grid - house + pv = batt).
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
	// history derives battery = grid - load + pv; with the balance-derived load
	// that resolves to exactly the measured battery power.
	if batt, ok := last.BatteryKw(); !ok || batt != -1.5 {
		t.Fatalf("derived battery = %v (ok=%v), want -1.5 (grid -2 - house 5.5 + pv 6)", batt, ok)
	}
	if last.LoadKw == nil || *last.LoadKw != 5.5 {
		t.Fatalf("house on the ring = %v, want 5.5", last.LoadKw)
	}
}
