package agent

// AP-15 IP-18, agent half: the held share reaches the feed-in watchdog on the
// setpoint path - before the first measurement, without a plan, above the
// arbitration - and the discharge ceiling (V6) only ever lowers the battery
// setpoint. The guard itself is proven in guards/exportanteil_test.go.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// halle1Dok is the share document of Box Halle 1 (E-1): 40 / 60 kW feed-in.
func halle1Dok(rolle string) []byte {
	r := ""
	if rolle != "" {
		r = fmt.Sprintf(`,"rolle":%q`, rolle)
	}
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":1,"schritt":"ziel","verteilbar":{"einspeisung":100.0,"bezug":77.0},`+
		`"anteile":{"einspeisung":{%q:40.0,%q:60.0},"bezug":{%q:0.0,%q:77.0}},"published_at":"2027-06-13T09:00:00Z"%s}`,
		vaTenant, vaSite, vaE1, vaE1, vaE4, vaE1, vaE4, r))
}

// halle1Cfg accepts the document once and returns the config of the box, so
// the next New(cfg) starts with the share on disk - the restart of R15.
func halle1Cfg(t *testing.T, rolle string) config.Config {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 100, 100
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE1
	vorher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	vorher.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE1 })
	if r := vorher.nimmAnteile(halle1Dok(rolle), time.Now()); r == nil || !r.Angenommen {
		t.Fatalf("document not accepted: %+v", r)
	}
	return cfg
}

// R15 end to end: Box Halle 1 restarts in the middle of curtailing; before
// the first measurement - and without any plan (V5) - the watchdog already
// states the share of 40 kW as sicherheitskappe.
func TestR15NachDemNeustartGiltDerAnteilVorDemErstenMesswert(t *testing.T) {
	a, _ := startBusOnlyAgent(t, halle1Cfg(t, "fuehrt"))
	addFronius(t, a, 1, 27)
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: guards.Unknown(), PvKw: guards.Unknown(),
		LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown()}
	a.mu.Unlock()
	a.applySetpoint(time.Now().UTC())
	g := a.State.Get().ExportGuard
	if g == nil || g.State != string(guards.ExportSafeCap) || g.CapKw == nil || *g.CapKw != 40 {
		t.Fatalf("expected sicherheitskappe = own share 40 kW, got %+v", g)
	}
}

// V6 on the published setpoint: the plan discharges 60 kW for the market;
// blind, the share of 40 kW lowers it to 40 and the producers to 0. The same
// plan without a document is published untouched.
func TestV6DerSollwertEntlaedtHoechstensDenAnteil(t *testing.T) {
	limit := 100.0
	run := func(cfg config.Config) (float64, float64) {
		a, addr := startBusOnlyAgent(t, cfg)
		sub := subscribeSetpoint(t, addr)
		now := time.Now().UTC()
		a.mu.Lock()
		a.currentPlan = exportPlan(now, -60, nil, &limit)
		a.lastReading = guards.Reading{SocPct: 80, PvKw: 20, LoadKw: 10, GridLimitKw: guards.Unknown()}
		a.mu.Unlock()
		a.applySetpoint(now)
		waitFor(t, 5*time.Second, "setpoint", func() bool { _, ok := sub.latest(); return ok })
		m, _ := sub.latest()
		pv, _ := setpointPvLimit(t, sub)
		return m["battery_setpoint_kw"].(float64), pv
	}
	kw, pv := run(halle1Cfg(t, "fuehrt"))
	if kw != -40 || pv != 0 {
		t.Fatalf("with the share: discharge 40 and PV 0 expected, got battery %.3f, pv cap %.3f", kw, pv)
	}
	ohne := config.Defaults()
	ohne.DataDir = t.TempDir()
	ohne.ControlEnabled = true
	ohne.MaxChargeKw, ohne.MaxDischargeKw = 100, 100
	kw, pv = run(ohne)
	if kw != -60 || pv != 40 {
		t.Fatalf("without a document the plan is untouched (static cap 100 - 60): got battery %.3f, pv cap %.3f", kw, pv)
	}
}

// The role is optional in the document. Without it the box holds its share
// at its own point, always - the safe side, like steuert_mit.
func TestOhneRolleImDokumentHaeltDieBoxIhrenAnteilWieMitsteuernd(t *testing.T) {
	for rolle, fuehrt := range map[string]bool{"fuehrt": true, "steuert_mit": false, "": false} {
		a := anteilAgent(t, t.TempDir())
		quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 1, "40.0", "60.0", rolle), time.Now()), true, "", 1)
		an := a.exportAnteil()
		if an == nil || an.AnteilKw != 60 || an.Fuehrt != fuehrt {
			t.Fatalf("rolle %q: %+v", rolle, an)
		}
	}
	if (&Agent{State: state.New("", "")}).exportAnteil() != nil {
		t.Fatal("without a document there is no share - today's watchdog")
	}
}

// V6: the ceiling only ever lowers a discharge - never charges, never raises.
func TestLowerDischargeSenktNur(t *testing.T) {
	c := func(v float64) *float64 { return &v }
	for _, tc := range []struct {
		kw   float64
		ceil *float64
		want float64
	}{
		{-60, c(40), -40}, // lowered to the share
		{-20, c(40), -20}, // below the ceiling: untouched, never raised
		{15, c(0), 15},    // a charge passes unchanged
		{-10, c(0), 0},    // stop discharging - not a charge
		{-60, nil, -60},   // no ceiling
	} {
		if got := lowerDischarge(tc.kw, tc.ceil); got != tc.want {
			t.Fatalf("lowerDischarge(%v) = %v, want %v", tc.kw, got, tc.want)
		}
	}
}
