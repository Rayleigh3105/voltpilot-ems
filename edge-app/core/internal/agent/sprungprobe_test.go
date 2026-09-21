package agent

// AP-15 IP-21, agent half: a Sprungprobe order reaches the published setpoint
// as a bounded LOWERING ceiling and goes again - on the plant's PV cap
// (erzeugung_senken) and on the battery's charge (verbrauch_senken); an own
// watchdog or control off abort it on the same tick; another box's order is
// never run; without an order the setpoint is the one of an agent that never
// had one. The probe itself is proven in internal/sprungprobe. Only the model
// of a plant runs here - never a real device.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sprungprobe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func sprungAuftrag(device, art string, kw float64, gueltigBis time.Time) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"probe_id":"7c0f5e0a-0000-4000-8000-000000000021","art":%q,"sprung_kw":%v,"dauer_s":60,"wiederholungen":2,`+
		`"pause_s":60,"gueltig_bis":%q,"ts":%q}`, vaTenant, vaSite, device, art, kw,
		gueltigBis.Format(time.RFC3339), gueltigBis.Add(-2*time.Minute).Format(time.RFC3339)))
}

// Box Verwaltung (E-4) with control on and no inverter selected (certified).
func sprungAgent(t *testing.T, control bool) (*Agent, *setpointSubscriber) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = control
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 100, 100
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE4
	a, addr := startBusOnlyAgent(t, cfg)
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	return a, subscribeSetpoint(t, addr)
}

// sprungTakt runs one setpoint tick at `at` with the plan and reading given
// and returns exactly that tick's published setpoint.
func sprungTakt(t *testing.T, a *Agent, sub *setpointSubscriber, at time.Time, planKw, pvKw float64,
	battKw *float64, exportLimit *float64) map[string]any {
	t.Helper()
	a.mu.Lock()
	a.currentPlan = exportPlan(at, planKw, nil, exportLimit)
	a.lastReading = guards.Reading{SocPct: 50, PvKw: pvKw, LoadKw: 10, GridLimitKw: guards.Unknown()}
	a.lastBattKw = battKw
	a.mu.Unlock()
	a.applySetpoint(at)
	ts := at.Format(time.RFC3339Nano)
	waitFor(t, 5*time.Second, "setpoint at "+ts, func() bool { m, ok := sub.latest(); return ok && m["ts"] == ts })
	m, _ := sub.latest()
	return m
}

func sprungBericht(t *testing.T, a *Agent) sprungprobe.Bericht {
	t.Helper()
	a.sprungMu.Lock()
	defer a.sprungMu.Unlock()
	if a.sprungBericht == nil {
		t.Fatal("no report waiting")
	}
	return *a.sprungBericht
}

// R1 at Box Verwaltung: PV 55 kW, order 30 kW - the plant cap is 25 kW for
// the jump, gone after it, 25 again in the second jump, gone for good; the
// battery setpoint is never touched; the report waits with two jumps and the
// own measurement 55 -> 25.
func TestSprungprobeSenktDiePvKappeZweimalUndStelltZurueck(t *testing.T) {
	a, sub := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	if a.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("a second order while one runs was taken")
	}
	for _, s := range []struct {
		nach int
		pv   float64
		cap  any
	}{{0, 55, 25.0}, {30, 25, 25.0}, {50, 25, 25.0}, {60, 25, nil}, {110, 55, nil},
		{120, 55, 25.0}, {150, 25, 25.0}, {180, 25, nil}, {200, 55, nil}, {210, 55, nil}} {
		m := sprungTakt(t, a, sub, t0.Add(time.Duration(s.nach)*time.Second), 0, s.pv, nil, nil)
		if m["pv_limit_kw"] != s.cap {
			t.Fatalf("+%d s: pv_limit_kw %v, want %v", s.nach, m["pv_limit_kw"], s.cap)
		}
		if m["battery_setpoint_kw"] != 0.0 {
			t.Fatalf("+%d s: the battery moved: %v", s.nach, m["battery_setpoint_kw"])
		}
	}
	b := sprungBericht(t, a)
	if b.Abgebrochen || len(b.Spruenge) != 2 || *b.Spruenge[0].VorherKw != 55 || *b.Spruenge[0].WaehrendKw != 25 ||
		*b.Spruenge[1].WaehrendKw != 25 || b.Stellgroesse != "pv_kappe" {
		t.Fatalf("report: %+v", b)
	}
}

// verbrauch_senken takes back the battery's own measured charge: 40 -> 20 kW,
// never a discharge; the same tick without an order charges 40.
func TestSprungprobeSenktNurDasLaden(t *testing.T) {
	batt := 40.0
	ohne, subOhne := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if m := sprungTakt(t, ohne, subOhne, t0, 40, 60, &batt, nil); m["battery_setpoint_kw"] != 40.0 {
		t.Fatalf("without an order: %v", m["battery_setpoint_kw"])
	}
	a, sub := sprungAgent(t, true)
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "verbrauch_senken", 20, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	if m := sprungTakt(t, a, sub, t0, 40, 60, &batt, nil); m["battery_setpoint_kw"] != 20.0 || m["pv_limit_kw"] != nil {
		t.Fatalf("in the jump: battery %v, pv cap %v", m["battery_setpoint_kw"], m["pv_limit_kw"])
	}
	if m := sprungTakt(t, a, sub, t0.Add(60*time.Second), 40, 60, &batt, nil); m["battery_setpoint_kw"] != 40.0 {
		t.Fatalf("after the jump: battery %v", m["battery_setpoint_kw"])
	}
}

// The feed-in watchdog stands above the probe: it holds the producers back
// (limit 30 kW, 40 kW exported) - the probe aborts on that tick, and the
// published cap is exactly the watchdog's, the same as without an order.
func TestSprungprobeBrichtAbWennDerEinspeisewaechterEingreift(t *testing.T) {
	limit := 30.0
	run := func(mitAuftrag bool) (map[string]any, *Agent) {
		a, sub := sprungAgent(t, true)
		t0 := time.Now().UTC().Truncate(time.Second)
		if mitAuftrag && !a.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
			t.Fatal("order not taken")
		}
		observe(a, t0, -40, 55)
		a.mu.Lock()
		a.currentPlan = exportPlan(t0, 0, nil, &limit)
		a.mu.Unlock()
		a.applySetpoint(t0)
		ts := t0.Format(time.RFC3339Nano)
		waitFor(t, 5*time.Second, "setpoint", func() bool { m, ok := sub.latest(); return ok && m["ts"] == ts })
		m, _ := sub.latest()
		return m, a
	}
	ohne, _ := run(false)
	mit, a := run(true)
	if ohne["pv_limit_kw"] == nil || mit["pv_limit_kw"] != ohne["pv_limit_kw"] || mit["pv_limit_kw"] == 25.0 {
		t.Fatalf("watchdog cap without order %v, with order %v (the probe's 25 must not reach it)",
			ohne["pv_limit_kw"], mit["pv_limit_kw"])
	}
	if b := sprungBericht(t, a); !b.Abgebrochen || b.Grund != sprungprobe.Einspeisewaechter || len(b.Spruenge) != 0 {
		t.Fatalf("report: %+v", b)
	}
}

// An import-side guard that lowers the battery on this tick aborts before the
// ceiling reaches anything (verbrauch_senken would otherwise compete with it).
func TestSprungprobeBrichtAbWennDerBezugswaechterEingreift(t *testing.T) {
	a, _ := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "verbrauch_senken", 20, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	batt := 40.0
	if w := a.sprungSchritt(t0, guards.Reading{PvKw: 60}, &batt, true, nil); w.DeckelKw != nil {
		t.Fatalf("ceiling %v despite the import guard", *w.DeckelKw)
	}
	if b := sprungBericht(t, a); b.Grund != sprungprobe.Bezugswaechter {
		t.Fatalf("report: %+v", b)
	}
}

// The battery's hard protection stop is Geraeteschutz: no jump against it.
func TestSprungprobeBrichtAbBeimGeraeteschutz(t *testing.T) {
	a, _ := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "verbrauch_senken", 20, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	batt := 40.0
	stop := &guards.BmsEnvelope{ChargeKw: guards.Unknown(), DischargeKw: guards.Unknown(), ChargeBlocked: true}
	if w := a.sprungSchritt(t0, guards.Reading{PvKw: 60}, &batt, false, stop); w.DeckelKw != nil {
		t.Fatalf("ceiling %v despite the protection stop", *w.DeckelKw)
	}
	if b := sprungBericht(t, a); b.Grund != sprungprobe.Geraeteschutz {
		t.Fatalf("report: %+v", b)
	}
}

// Control off: the setpoint is not written, so there is no jump to report.
func TestSprungprobeOhneRegelungSpringtNicht(t *testing.T) {
	a, sub := sprungAgent(t, false)
	t0 := time.Now().UTC().Truncate(time.Second)
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	if m := sprungTakt(t, a, sub, t0, 0, 55, nil, nil); m["pv_limit_kw"] != nil {
		t.Fatalf("control off: pv cap %v", m["pv_limit_kw"])
	}
	if b := sprungBericht(t, a); b.Grund != sprungprobe.RegelungAus || len(b.Spruenge) != 0 {
		t.Fatalf("report: %+v", b)
	}
}

// Another box's order (T4) and an expired one never run; an expired one is
// still reported once - a taken order never vanishes.
func TestSprungprobeFremderUndAbgelaufenerAuftrag(t *testing.T) {
	a, _ := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if a.nimmSprungprobe(sprungAuftrag(vaE1, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("another box's order was taken")
	}
	a.sprungMu.Lock()
	if a.sprung != nil || a.sprungBericht != nil {
		t.Fatal("another box's order left a trace")
	}
	a.sprungMu.Unlock()
	if !a.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(-time.Second)), t0) {
		t.Fatal("an expired order of this box is taken - and reported")
	}
	if b := sprungBericht(t, a); b.Grund != sprungprobe.Abgelaufen {
		t.Fatalf("report: %+v", b)
	}
}

// Without an order the setpoint is the one of an agent that never had one -
// also after a probe has run and been reported (byte for byte, but the tick
// time).
func TestOhneAuftragIstDerSollwertByteGleich(t *testing.T) {
	nie, subNie := sprungAgent(t, true)
	nach, subNach := sprungAgent(t, true)
	t0 := time.Now().UTC().Truncate(time.Second)
	if !nach.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	for _, s := range []int{0, 60, 120, 180, 210} {
		sprungTakt(t, nach, subNach, t0.Add(time.Duration(s)*time.Second), 0, 55, nil, nil)
	}
	nach.sprungMu.Lock()
	nach.sprungBericht = nil // the link took it
	nach.sprungMu.Unlock()
	batt := 12.0
	limit := 70.0
	at := t0.Add(5 * time.Minute)
	m1 := sprungTakt(t, nie, subNie, at, 12, 55, &batt, &limit)
	m2 := sprungTakt(t, nach, subNach, at, 12, 55, &batt, &limit)
	r1, r2 := fmt.Sprint(m1), fmt.Sprint(m2)
	if r1 != r2 {
		t.Fatalf("setpoint differs without an order:\n never: %s\n after: %s", r1, r2)
	}
}

// A taken order never vanishes: open when the box stops, it is reported once
// after the restart - aborted with "neustart", never resumed. An order that
// was reported leaves nothing behind.
func TestSprungprobeNachDemNeustartAbgebrochenGemeldet(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE4
	vorher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	vorher.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	t0 := time.Now().UTC().Truncate(time.Second)
	if !vorher.nimmSprungprobe(sprungAuftrag(vaE4, "erzeugung_senken", 30, t0.Add(2*time.Minute)), t0) {
		t.Fatal("order not taken")
	}
	nachher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b := sprungBericht(t, nachher)
	if !b.Abgebrochen || b.Grund != sprungprobe.Neustart || b.ProbeID != "7c0f5e0a-0000-4000-8000-000000000021" ||
		len(b.Spruenge) != 0 {
		t.Fatalf("report after the restart: %+v", b)
	}
	nachher.sprungMu.Lock()
	laeuft := nachher.sprung != nil
	nachher.sprungMu.Unlock()
	if laeuft {
		t.Fatal("a restart must never resume a jump")
	}
	nachher.sprungOffenVergessen() // what a delivered report does
	dritter, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	dritter.sprungMu.Lock()
	defer dritter.sprungMu.Unlock()
	if dritter.sprungBericht != nil {
		t.Fatal("a delivered report is reported again")
	}
}
