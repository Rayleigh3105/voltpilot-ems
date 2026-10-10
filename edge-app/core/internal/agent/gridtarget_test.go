package agent

// Der netzseitige Drossel-Slot (Konzept `vp-deye-netzseitig-drossel-k2` P3) auf
// der VERDRAHTUNGS-Ebene: was auf edge/setpoint reist, was der Zustand und der
// Herzschlag sagen, und die Zusage, dass eine Anlage OHNE gemeldeten Hebel oder
// ohne Schreibfreigabe byte-gleich weiterlaeuft.
//
// Die REGEL selbst (Eintritt, jede Ruecknahme, das Ziel) ist rein in
// `internal/guards/gridtarget_test.go` bewiesen; hier steht nur, was Bus,
// Zustand und Sollwert-Pfad brauchen.

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	gtPlanChargeKw = 5.0
	gtPlanCapKw    = 12.0
)

// gtPlan: ein Negativpreis-Slot - der Fahrplan laedt und kappt die PV.
func gtPlan(now time.Time, batteryKw float64) *plan.Plan {
	start := now.Add(-time.Minute)
	limit, floor := gtPlanCapKw, 20.0
	return &plan.Plan{
		SlotMinutes:          15,
		ReceivedAt:           now,
		EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{
			{Start: start, BatterySetpointKw: batteryKw, PvLimitKw: &limit},
			{Start: start.Add(15 * time.Minute), BatterySetpointKw: batteryKw, PvLimitKw: &limit},
		},
	}
}

// gtRig baut Herzogau: der Deye-Pilot auf dem Fernsteuerpfad (zertifiziert,
// Not-Aus an, Zaehler am Netzpunkt), zwei freigegebene Fronius, ein
// Negativpreis-Slot, frische Messung.
func gtRig(t *testing.T, now time.Time) (*Agent, string, []sources.Source) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	return gtRigWith(t, now, cfg)
}

// gtRigWith baut dieselbe Anlage auf einer vorgegebenen Konfiguration (etwa
// einer Box, die ein Anteile-Dokument haelt).
func gtRigWith(t *testing.T, now time.Time, cfg config.Config) (*Agent, string, []sources.Source) {
	t.Helper()
	cfg.ControlCertifiedFamilies = []string{"hybrid_3p"}
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)
	declareMeterAtGridPoint(a)

	fr1 := addFronius(t, a, 1, 25)
	fr2 := addFronius(t, a, 2, 30)
	feedSource(a, fr1.ID, 12)
	feedSource(a, fr2.ID, 12)
	gridCertifyFronius(t, a, fr1, now)
	gridCertifyFronius(t, a, fr2, now)

	gtTelemetry(a, now, 12.5, -6, 5, 60)
	a.mu.Lock()
	a.currentPlan = gtPlan(now, gtPlanChargeKw)
	a.mu.Unlock()
	return a, addr, []sources.Source{fr1, fr2}
}

// gtTelemetry faehrt den ECHTEN Telemetrie-Pfad des Primaergeraets: eigene PV,
// Netzpunkt (+ Bezug / - Einspeisung), Batterie (+ laden), Ladestand.
func gtTelemetry(a *Agent, at time.Time, ownPv, grid, batt, soc float64) {
	raw, _ := json.Marshal(map[string]any{
		"ts": at.Format(time.RFC3339Nano), "pv_power_kw": ownPv, "power_kw": grid,
		"load_kw": 6.0, "soc_pct": soc, "battery_power_kw": batt,
	})
	a.onLocalTelemetry("", raw)
	a.mu.Lock()
	a.lastReadingAt = at
	a.mu.Unlock()
}

// gtReadback ist die Rueckmeldung, wie sie der Kern hinter dem Palettenknoten
// sieht. `lever` = Layer 1 meldet den freigegebenen netzseitigen Hebel;
// `gridSide` = der Zyklus hat die Netzseite geschrieben UND zurueckgelesen
// (1104 liest 2, das Ziel steht), sonst der gewoehnliche Batterie-Plan.
func gtReadback(a *Agent, at time.Time, lever, gridSide bool) {
	intents := []string{"cover_load"}
	if lever {
		intents = append(intents, guards.GridTargetLever)
	}
	regs := []map[string]any{
		{"role": "remote_watchdog", "addr": 1101, "commanded_raw": 60, "actual_raw": 60, "match": true, "verdict": "held"},
		{"role": "power_control_mode", "addr": 1104, "commanded_raw": 1, "actual_raw": 1, "match": true, "verdict": "held"},
		{"role": "battery_power", "addr": 1109, "commanded_raw": 65369, "actual_raw": 65369, "match": true, "verdict": "held",
			"commanded_kw": 5.0, "actual_kw": 5.0},
		{"role": "remote_mode", "addr": 1100, "commanded_raw": 1, "actual_raw": 1, "match": true, "verdict": "held"},
	}
	if gridSide {
		regs = []map[string]any{
			{"role": "remote_watchdog", "addr": 1101, "commanded_raw": 60, "actual_raw": 60, "match": true, "verdict": "held"},
			{"role": "pv_max_permille", "addr": 1115, "commanded_raw": 999, "actual_raw": 999, "match": true, "verdict": "held"},
			{"role": "power_control_mode", "addr": 1104, "commanded_raw": 2, "actual_raw": 2, "match": true, "verdict": "held"},
			{"role": "grid_power", "addr": 1109, "commanded_raw": 0, "actual_raw": 0, "match": true, "verdict": "held",
				"commanded_kw": 0.0, "actual_kw": 0.0},
			{"role": "remote_mode", "addr": 1100, "commanded_raw": 1, "actual_raw": 1, "match": true, "verdict": "held"},
		}
	}
	rb, _ := json.Marshal(map[string]any{
		"ts": at.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": "schedule",
		"mode": "normal", "all_match": true, "verify": "held", "control_enabled": true, "certified": true,
		"control_path": "remote", "registers": regs,
		"native_capabilities": map[string]any{"intents": intents, "window": false, "persistent": false},
	})
	a.onControlReadback("", rb)
}

// gtTick faehrt einen Sollwert-Takt und liefert, was auf dem Bus steht.
func gtTick(t *testing.T, a *Agent, sub *setpointSubscriber, at time.Time) map[string]any {
	t.Helper()
	a.applySetpoint(at)
	want := at.Format(time.RFC3339Nano)
	waitFor(t, 5*time.Second, "Sollwert des Taktes", func() bool {
		m, ok := sub.latest()
		return ok && m["ts"] == want
	})
	m, _ := sub.latest()
	return m
}

// gtEngage bringt die Anlage in den BELEGTEN netzseitigen Slot: Hebel gemeldet,
// Absicht veroeffentlicht, Netzseite zurueckgelesen, Netzpunkt auf dem Ziel.
func gtEngage(t *testing.T, a *Agent, sub *setpointSubscriber, now time.Time) time.Time {
	t.Helper()
	gtReadback(a, now, true, false)
	if m := gtTick(t, a, sub, now); m["battery_mode"] != batteryModeGridTarget {
		t.Fatalf("Vorbereitung: die Absicht steht nicht: %v", m)
	}
	at := now.Add(10 * time.Second)
	gtTelemetry(a, at, 12.5, -0.1, 12, 60)
	gtReadback(a, at, true, true)
	if m := gtTick(t, a, sub, at); m["battery_mode"] != batteryModeGridTarget {
		t.Fatalf("Vorbereitung: die Absicht ist weg: %v", m)
	}
	if g := a.State.Get().GridTarget; g == nil || !g.Proven {
		t.Fatalf("Vorbereitung: nicht belegt: %+v", g)
	}
	return at
}

func gtHasGridFields(m map[string]any) bool {
	_, kw := m["grid_target_kw"]
	_, nz := m["grid_target_neutralize"]
	return kw || nz || m["battery_mode"] == batteryModeGridTarget
}

// ⚠ DIE KOMPATIBILITAETS-ZUSAGE (Akzeptanz P3: „ohne Zertifikat/Not-Aus
// byte-identisches Verhalten zu heute"). Derselbe Negativpreis-Slot, einmal
// ohne gemeldeten Hebel, einmal ohne Zertifikat, einmal mit Not-Aus aus: kein
// Feld, kein anderes Wort, kein Zustandsblock - und der Sollwert ist der, den
// die Anlage ohne dieses Paket veroeffentlicht.
func TestWithoutLeverCertificateOrKillSwitchTheSlotIsByteForByteUnchanged(t *testing.T) {
	now := time.Now().UTC()
	reference := func() map[string]any {
		a, addr, _ := gtRig(t, now)
		sub := subscribeSetpoint(t, addr)
		gtReadback(a, now, false, false)
		return gtTick(t, a, sub, now)
	}()
	if gtHasGridFields(reference) || reference["battery_mode"] != batteryModeSetpoint {
		t.Fatalf("ohne gemeldeten Hebel reist nichts vom netzseitigen Pfad: %v", reference)
	}

	// Eine Box, deren Layer 1 (noch) gar nichts zurueckgemeldet hat - der Stand
	// jedes Neustarts und jedes aelteren Flows: nichts vom Pfad, kein Block.
	t.Run("keine Rueckmeldung ueberhaupt", func(t *testing.T) {
		a, addr, _ := gtRig(t, now)
		sub := subscribeSetpoint(t, addr)
		m := gtTick(t, a, sub, now)
		if gtHasGridFields(m) || m["battery_mode"] != batteryModeSetpoint {
			t.Fatalf("es reist ein Feld des netzseitigen Pfads: %v", m)
		}
		if s := a.State.Get(); s.GridTarget != nil || s.GridTargetWithheld != nil {
			t.Fatalf("ohne Hebel sagt der Zustand nichts ueber den Pfad: %+v / %+v", s.GridTarget, s.GridTargetWithheld)
		}
		if a.curtailmentSummary().Units != 2 {
			t.Fatal("ohne gemeldeten Hebel zaehlt der Primaere nicht als Abregel-Einheit")
		}
	})

	// MIT gemeldetem Hebel, aber ohne Schreibfreigabe: dieselbe Zusage. Der
	// Vergleich laeuft gegen dieselbe Anlage OHNE Hebel im selben Gate-Zustand
	// (control_enabled/device_certified sind dort natuerlich false).
	gates := []struct {
		name string
		mut  func(a *Agent)
	}{
		{"Not-Aus", func(a *Agent) { a.Cfg.ControlEnabled = false }},
		{"kein Zertifikat", func(a *Agent) { a.Cfg.ControlCertifiedFamilies = nil }},
		{"Automatik abgeschaltet", func(a *Agent) { a.Cfg.NativeSelfRegulationEnabled = false }},
	}
	for _, tc := range gates {
		t.Run(tc.name, func(t *testing.T) {
			run := func(lever bool) map[string]any {
				a, addr, _ := gtRig(t, now)
				sub := subscribeSetpoint(t, addr)
				tc.mut(a)
				gtReadback(a, now, lever, false)
				return gtTick(t, a, sub, now)
			}
			with, without := run(true), run(false)
			if gtHasGridFields(with) {
				t.Fatalf("ohne Freigabe reist ein Feld des netzseitigen Pfads: %v", with)
			}
			got, _ := json.Marshal(with)
			want, _ := json.Marshal(without)
			if string(got) != string(want) {
				t.Fatalf("der Sollwert weicht ab:\n got %s\nwant %s", got, want)
			}
		})
	}
}

// Der Eintritt: die ABSICHT reist (mit Neutralschritt, Ziel 0), der
// Batterie-Sollwert bleibt als Referenz stehen, die Plankappe der Fronius
// reist weiter - und nichts davon wird der Wolke als Tatsache gemeldet, bevor
// das Geraet die Netzseite belegt hat.
func TestACurtailingSlotPublishesTheIntentAndReportsItOnlyOnceProven(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	gtReadback(a, now, true, false)

	m := gtTick(t, a, sub, now)
	if m["battery_mode"] != batteryModeGridTarget || m["grid_target_kw"] != 0.0 {
		t.Fatalf("die Absicht mit dem Ziel 0 reist nicht: %v", m)
	}
	if m["grid_target_neutralize"] != true {
		t.Fatalf("solange nichts belegt ist, reist der Neutralschritt mit (E2): %v", m)
	}
	if m["battery_setpoint_kw"] != gtPlanChargeKw || m["source"] != "schedule" {
		t.Fatalf("der Batterie-Sollwert bleibt die Referenz der Ruecknahme: %v", m)
	}
	if _, ok := m["pv_limit_kw"]; !ok {
		t.Fatalf("die Kappe der Fronius reist weiter (E6): %v", m)
	}
	if m["control_enabled"] != true || m["device_certified"] != true {
		t.Fatalf("kein Tor wird umgangen - dieselbe Konjunktion wie sonst: %v", m)
	}
	snap := a.State.Get()
	if g := snap.GridTarget; g == nil || !g.Active || g.Proven || g.Reason != guards.GridTargetPending {
		t.Fatalf("der Zustand sagt „ausstehend“: %+v", g)
	}
	if e := executionSummary(snap); e != nil && e.Mode == execModeGridTarget {
		t.Fatal("eine unbelegte Absicht darf nicht als netzseitige Regelung gemeldet werden")
	}
	// Vor dem Beleg: das Ziel ist kommandiert, GEURTEILT ist noch nichts - und
	// die Anlage gilt (noch) nicht als abregelnd.
	if u := gridTargetUnit(snap); u == nil || u.Mode != execModeGridTarget || u.TargetKw == nil || *u.TargetKw != 0 || u.Match != nil {
		t.Fatalf("der Eintrag des Primaeren vor dem Beleg: Ziel ja, Urteil nein: %+v", u)
	}
	if cur := a.curtailmentSummary(); cur == nil || cur.Active || cur.AllMatch != nil {
		t.Fatalf("eine unbelegte Absicht macht die Anlage nicht „aktiv“: %+v", cur)
	}

	// Layer 1 hat geschrieben und zurueckgelesen, der Zaehler steht auf dem Ziel.
	at := now.Add(10 * time.Second)
	gtTelemetry(a, at, 12.5, -0.2, 12, 60)
	gtReadback(a, at, true, true)
	m = gtTick(t, a, sub, at)
	if m["battery_mode"] != batteryModeGridTarget || m["grid_target_kw"] != 0.0 {
		t.Fatalf("die Absicht bleibt stehen: %v", m)
	}
	if _, ok := m["grid_target_neutralize"]; ok {
		t.Fatalf("belegt: kein Neutralschritt mehr in jedem Takt: %v", m)
	}
	snap = a.State.Get()
	g := snap.GridTarget
	if g == nil || !g.Proven || g.Reason != guards.GridTargetEngaged || g.Following == nil || !*g.Following {
		t.Fatalf("belegt und auf dem Ziel: %+v", g)
	}
	if g.ReferenceKw != gtPlanChargeKw || g.GridKw == nil {
		t.Fatalf("Referenz und Messwert gehoeren in den Block: %+v", g)
	}

	// Der Herzschlag: das Wort, die Referenz - und KEIN kommandierter Batteriewert.
	ctl := controlSummary(snap)
	if ctl == nil || ctl.Execution == nil || ctl.Execution.Mode != execModeGridTarget {
		t.Fatalf("execution.mode = grid_target fehlt: %+v", ctl)
	}
	if ctl.Execution.PlannedKw == nil || *ctl.Execution.PlannedKw != gtPlanChargeKw {
		t.Fatalf("planned_kw ist die Referenz: %+v", ctl.Execution)
	}
	if ctl.CommandedKw != nil || ctl.ConfirmedKw != nil {
		t.Fatalf("netzseitig schreibt die Box keinen Batteriewert: %+v", ctl)
	}

	cur := a.curtailmentSummary()
	if cur == nil || cur.Units != 3 || cur.CertifiedUnits != 3 || !cur.Active {
		t.Fatalf("der Primaere zaehlt als dritte, freigegebene Einheit: %+v", cur)
	}
	last := cur.PerUnit[len(cur.PerUnit)-1]
	if last.SourceID != primarySourceID || !last.Certified || last.Mode != execModeGridTarget ||
		last.TargetKw == nil || *last.TargetKw != 0 || last.Match == nil || !*last.Match || last.AppliedCapKw != nil {
		t.Fatalf("per_unit des Primaeren: %+v", last)
	}
	raw, _ := json.Marshal(last)
	for _, word := range []string{`"mode":"grid_target"`, `"target_kw":0`, `"match":true`, `"source_id":"inverter"`} {
		if !strings.Contains(string(raw), word) {
			t.Fatalf("das Wort %s fehlt auf dem Draht: %s", word, raw)
		}
	}
}

// Ohne Slot-Abregelung bleibt der Eintrag des Primaeren stehen (die Einheit
// existiert), behauptet aber keine Regelung - und die Zaehlung flackert nicht.
func TestOutsideTheSlotThePrimaryIsAUnitThatClaimsNothing(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	a.mu.Lock()
	a.currentPlan = freshPlan(now, gtPlanChargeKw, nil)
	a.mu.Unlock()
	gtReadback(a, now, true, false)
	if m := gtTick(t, a, sub, now); gtHasGridFields(m) {
		t.Fatalf("ohne Abregelung im Slot kein netzseitiger Modus: %v", m)
	}
	snap := a.State.Get()
	if snap.GridTarget != nil || snap.GridTargetWithheld != nil {
		t.Fatalf("ein Slot ohne Abregelung ist kein zurueckgehaltener: %+v / %+v", snap.GridTarget, snap.GridTargetWithheld)
	}
	cur := a.curtailmentSummary()
	if cur == nil || cur.Units != 3 || cur.CertifiedUnits != 3 || cur.Active {
		t.Fatalf("drei Einheiten, nichts aktiv: %+v", cur)
	}
	last := cur.PerUnit[len(cur.PerUnit)-1]
	if last.SourceID != primarySourceID || last.Mode != execModeGridTarget || last.TargetKw != nil || last.Match != nil {
		t.Fatalf("ausserhalb des Slots: WIE die Einheit abregelt steht da, ein Ziel oder Urteil nicht: %+v", last)
	}
}

// „Trim/Follower/Absorb freigeben": netzseitig gibt es keinen Batterie-Sollwert,
// den eine Korrektur anheben koennte. Derselbe Slot hebt OHNE den Modus die
// Ladung auf den gemessenen Ueberschuss - MIT ihm bleibt die Referenz der reine
// Planwert, und keine Korrektur behauptet etwas.
func TestTheInSlotCorrectionsAreReleasedWhileTheDeviceLeads(t *testing.T) {
	now := time.Now().UTC()
	run := func(lever bool) (map[string]any, state.Snapshot) {
		a, addr, _ := gtRig(t, now)
		sub := subscribeSetpoint(t, addr)
		a.mu.Lock()
		a.currentPlan.Slots[0].ChargeSurplusToBattery = true
		a.lastReading.PvKw, a.lastReading.LoadKw = 36.5, 6
		a.mu.Unlock()
		gtReadback(a, now, lever, false)
		m := gtTick(t, a, sub, now)
		return m, a.State.Get()
	}
	without, snapWithout := run(false)
	if kw, _ := without["battery_setpoint_kw"].(float64); kw <= gtPlanChargeKw || snapWithout.Absorb == nil {
		t.Fatalf("Gegenprobe: ohne den Modus hebt die Ueberschuss-Aufnahme die Ladung: %v", without)
	}
	with, snapWith := run(true)
	if with["battery_setpoint_kw"] != gtPlanChargeKw {
		t.Fatalf("netzseitig bleibt die Referenz der Planwert, got %v", with["battery_setpoint_kw"])
	}
	if snapWith.Absorb != nil || snapWith.Trim != nil || snapWith.Follow != nil {
		t.Fatalf("keine Korrektur darf etwas behaupten: %+v %+v %+v", snapWith.Absorb, snapWith.Trim, snapWith.Follow)
	}
}

// E6 „Fronius zuerst, der Deye regelt den Rest": der belegte netzseitige Slot
// ist der Innenkreis der Kaskade - die Kappe der Fronius kommt vom
// Null-Einspeise-Waechter, der dem Speicher den Vortritt laesst, und der
// Batterie-Term ist die MESSUNG, nicht der Sollwert, dem das Geraet nicht folgt.
func TestTheProvenSlotIsTheInnerLoopAndTheTrackerCountsTheMeasuredBattery(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	gtEngage(t, a, sub, now)

	snap := a.State.Get()
	ct := snap.CurtailTrack
	if ct == nil || !strings.Contains(ct.Reason, "Negativer Preis") {
		t.Fatalf("die Abregelung laeuft ueber die Kaskade: %+v", ct)
	}
	if ct.ChargeKw == nil || *ct.ChargeKw != 12 {
		t.Fatalf("der Batterie-Term ist die Messung (12 kW), nicht der Sollwert (5 kW): %+v", ct)
	}
	inner := a.gridTargetInner(guards.GridTargetDecision{Engage: true, Proven: true},
		guards.Reading{SocPct: 97}, guards.Limits{MaxChargeKw: 30}, now)
	if !inner.Active || inner.SocMaxPct != guards.GridTargetChargeCeilingPct || inner.HeadroomKw() <= 0 {
		t.Fatalf("E4: bis 100 %% hat der Speicher Luft - der Waechter darf die Fronius bei 97 %% nicht "+
			"wie bei vollem Speicher drosseln: %+v", inner)
	}
	if got := a.gridTargetInner(guards.GridTargetDecision{Engage: true}, guards.Reading{}, guards.Limits{}, now); got.Active {
		t.Fatal("eine unbelegte Absicht ist noch kein Innenkreis")
	}
}

// Jede Ruecknahme kehrt im SELBEN Takt auf den Sollwert-Pfad zurueck, nennt
// ihren Grund im Zustand und haelt bis zum Slot-Ende.
func TestATakeBackReturnsToTheSetpointPathAndNamesItsReason(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name string
		mut  func(a *Agent, at time.Time)
		want string
	}{
		// Der Ladestand wird direkt gesetzt: der Telemetrie-Pfad haelt einen
		// Sprung von 60 auf 22,5 % zu Recht als Ausreisser zurueck.
		{"Reserve-Boden + 3 %", func(a *Agent, _ time.Time) {
			a.mu.Lock()
			a.lastReading.SocPct = 22.5
			a.mu.Unlock()
		}, guards.GridTargetFloorReached},
		{"Ruecklesen verloren", func(a *Agent, at time.Time) {
			a.State.Update(func(s *state.Snapshot) { s.Control.CheckedAt = at.Add(-10 * time.Minute) })
		}, guards.GridTargetNoReadback},
		{"Messung veraltet", func(a *Agent, at time.Time) {
			a.mu.Lock()
			a.lastReadingAt = at.Add(-10 * time.Minute)
			a.mu.Unlock()
		}, guards.GridTargetStaleMeasurement},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, addr, _ := gtRig(t, now)
			sub := subscribeSetpoint(t, addr)
			at := gtEngage(t, a, sub, now).Add(10 * time.Second)

			gtTelemetry(a, at, 12.5, -0.1, 12, 60)
			gtReadback(a, at, true, true)
			tc.mut(a, at)
			m := gtTick(t, a, sub, at)
			if gtHasGridFields(m) || m["battery_mode"] != batteryModeSetpoint {
				t.Fatalf("die Ruecknahme veroeffentlicht den gewoehnlichen Sollwert: %v", m)
			}
			snap := a.State.Get()
			if snap.GridTarget != nil {
				t.Fatalf("der Block faellt im selben Takt: %+v", snap.GridTarget)
			}
			w := snap.GridTargetWithheld
			if w == nil || w.Reason != tc.want || w.Text == "" || !w.Ended {
				t.Fatalf("die Ruecknahme nennt %q: %+v", tc.want, w)
			}
			if e := executionSummary(snap); e != nil && e.Mode == execModeGridTarget {
				t.Fatal("das Wort faellt im selben Takt wie die Ruecknahme")
			}

			// Alles wieder gut im selben Slot: es bleibt beim Sollwert-Pfad.
			at = at.Add(10 * time.Second)
			gtTelemetry(a, at, 12.5, -0.1, 12, 60)
			gtReadback(a, at, true, true)
			if m := gtTick(t, a, sub, at); gtHasGridFields(m) {
				t.Fatalf("eine Ruecknahme haelt bis zum Slot-Ende: %v", m)
			}
		})
	}
}

// „Netz folgt Ziel nicht binnen 60 s": Bezug, den das Geraet nicht deckt.
func TestAGridPointThatDoesNotFollowIsTakenBackAfterAMinute(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	at := gtEngage(t, a, sub, now)

	step := func(d time.Duration) map[string]any {
		t.Helper()
		x := at.Add(d)
		gtTelemetry(a, x, 12.5, 3.2, 12, 60)
		gtReadback(a, x, true, true)
		return gtTick(t, a, sub, x)
	}
	if m := step(10 * time.Second); !gtHasGridFields(m) {
		t.Fatalf("eine Abweichung ist innerhalb der Minute noch keine Ruecknahme: %v", m)
	}
	if g := a.State.Get().GridTarget; g == nil || g.Following == nil || *g.Following {
		t.Fatalf("der Block sagt wahr: nicht auf dem Ziel: %+v", g)
	}
	if u := gridTargetUnit(a.State.Get()); u == nil || u.Match == nil || *u.Match {
		t.Fatalf("match ist die gemessene Wirkung: %+v", u)
	}
	if m := step(60 * time.Second); !gtHasGridFields(m) {
		t.Fatalf("50 s Abweichung: noch nicht: %v", m)
	}
	if m := step(75 * time.Second); gtHasGridFields(m) {
		t.Fatalf("ueber eine Minute nicht gefolgt: zurueck auf den Sollwert-Pfad: %v", m)
	}
	if w := a.State.Get().GridTargetWithheld; w == nil || w.Reason != guards.GridTargetNotFollowing {
		t.Fatalf("der Grund ist benannt: %+v", w)
	}
}

// Der Live-Befund vom 08.10.2026: Einspeisung, die von den FRONIUS stammt,
// waehrend der Deye selbst nichts mehr einspeist, ist keine Ruecknahme - sie
// gaebe nur die Deye-PV obendrauf frei. Der Zustand sagt, woher sie kommt.
func TestFeedInOfTheOtherProducersIsNotATakeBack(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	at := gtEngage(t, a, sub, now)
	for d := 10 * time.Second; d <= 5*time.Minute; d += 10 * time.Second {
		x := at.Add(d)
		gtTelemetry(a, x, 12.5, -18, 12.5, 60) // die ganze eigene PV geht in den Speicher
		gtReadback(a, x, true, true)
		if m := gtTick(t, a, sub, x); !gtHasGridFields(m) {
			t.Fatalf("t+%s: ein ausgereizter Deye bleibt netzseitig: %v", d, m)
		}
	}
	g := a.State.Get().GridTarget
	if g == nil || g.Hint != guards.GridTargetHintExhausted || g.HintText == "" {
		t.Fatalf("der Hinweis nennt die anderen Erzeuger: %+v", g)
	}
}

// Die Absicht, die das Geraet nie belegt, wird nach der Frist zurueckgenommen.
func TestAnIntentTheDeviceNeverConfirmsIsWithdrawn(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	grace := a.nativeProofGrace()
	var m map[string]any
	for d := time.Duration(0); d <= grace; d += 10 * time.Second {
		x := now.Add(d)
		gtTelemetry(a, x, 12.5, -6, 5, 60)
		gtReadback(a, x, true, false) // Layer 1 schreibt weiter die Batterieseite
		m = gtTick(t, a, sub, x)
		if !gtHasGridFields(m) || m["grid_target_neutralize"] != true {
			t.Fatalf("t+%s: innerhalb der Frist steht die Absicht mit Neutralschritt: %v", d, m)
		}
	}
	x := now.Add(grace + 10*time.Second)
	gtTelemetry(a, x, 12.5, -6, 5, 60)
	gtReadback(a, x, true, false)
	if m = gtTick(t, a, sub, x); gtHasGridFields(m) {
		t.Fatalf("nach der Frist ohne Beleg: zurueck: %v", m)
	}
	if w := a.State.Get().GridTargetWithheld; w == nil || w.Reason != guards.GridTargetUnproven {
		t.Fatalf("der Grund ist benannt: %+v", w)
	}
}

// Not-Aus MITTEN im Slot: der naechste Takt traegt control_enabled=false und
// kein Feld des Pfads - Layer 1 faehrt dann seine eine Rueckgabe.
func TestTheKillSwitchInsideTheSlotEndsTheMode(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	at := gtEngage(t, a, sub, now).Add(10 * time.Second)
	a.Cfg.ControlEnabled = false
	gtTelemetry(a, at, 12.5, -0.1, 12, 60)
	gtReadback(a, at, true, true)
	m := gtTick(t, a, sub, at)
	if gtHasGridFields(m) || m["control_enabled"] != false {
		t.Fatalf("Not-Aus: kein netzseitiger Modus, keine Schreibfreigabe: %v", m)
	}
	if w := a.State.Get().GridTargetWithheld; w == nil || w.Reason != guards.GridTargetNotAuthorized || !w.Ended {
		t.Fatalf("auch dieses Ende traegt seinen Grund: %+v", w)
	}
}

// Ein Entlade-Slot mit Abregelung bleibt batterieseitig (§2.6): der Deye wuerde
// die Batterie nach seiner Logik fuehren.
func TestACurtailingSlotThatDischargesStaysOnTheBatterySide(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	a.mu.Lock()
	a.currentPlan = gtPlan(now, -4)
	a.mu.Unlock()
	gtReadback(a, now, true, false)
	if m := gtTick(t, a, sub, now); gtHasGridFields(m) {
		t.Fatalf("ein Entlade-Slot ist kein netzseitiger: %v", m)
	}
	if w := a.State.Get().GridTargetWithheld; w == nil || w.Reason != guards.GridTargetPlanDischarges || w.Ended {
		t.Fatalf("der Zustand nennt, warum dieser Abregel-Slot batterieseitig bleibt: %+v", w)
	}
}

// K6: „Geraet regelt" nur fuer das Fuehrungsgeraet - ohne angegebenen
// Zaehlerort am Netzpunkt bleibt auch dieser Pfad zu.
func TestWithoutADeclaredMeterAtTheGridPointTheSlotStaysOnTheBatterySide(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	a.srcMu.Lock()
	a.bal.PrimaryMeterLocation = ""
	a.srcMu.Unlock()
	gtReadback(a, now, true, false)
	if m := gtTick(t, a, sub, now); gtHasGridFields(m) {
		t.Fatalf("ohne Zaehlerort am Netzpunkt regelt das Geraet den Netzpunkt nicht: %v", m)
	}
	if w := a.State.Get().GridTargetWithheld; w == nil || w.Reason != guards.NativeMeterLocationMissing || w.Text == "" {
		t.Fatalf("der K6-Grund mit seinem Satz: %+v", w)
	}
}

// Ein von Hand armierter Netz-Sollwert-Test BESITZT den Wechselrichter: der
// Produktivpfad traegt daneben keinen scharfen Zustand, und der Testpfad selbst
// ist unveraendert.
func TestAnArmedGridTestOwnsTheInverterOverTheProductionPath(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)
	declareMeterAtGridPoint(a)
	limit, floor := gtPlanCapKw, 20.0
	a.mu.Lock()
	a.currentPlan.EffectiveFloorSocPct = &floor
	for i := range a.currentPlan.Slots {
		a.currentPlan.Slots[i].PvLimitKw = &limit
	}
	a.mu.Unlock()
	gtReadback(a, now, true, false)
	if m := gtTick(t, a, sub, now); m["battery_mode"] != batteryModeGridTarget {
		t.Fatalf("Vorbereitung: der Produktivpfad steht nicht: %v", m)
	}
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("der Testpfad startet wie bisher: %v", err)
	}
	a.applySetpoint(now.Add(time.Second))
	waitFor(t, 5*time.Second, "Testsollwert", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] == gridTestSource
	})
	m, _ := sub.latest()
	if gtHasGridFields(m) {
		t.Fatalf("der Testsollwert traegt kein Feld des Produktivpfads: %v", m)
	}
	if a.gridTarget.Engaged() || a.State.Get().GridTarget != nil {
		t.Fatal("der Produktivpfad darf neben einem armierten Test keinen scharfen Zustand tragen")
	}
}

// EEG-Sicherheit durch Konstruktion: was auch immer die Regel liefert, auf dem
// Draht steht nie ein Ziel ueber +50 W.
func TestThePublishedTargetIsNeverAnImportTarget(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRig(t, now)
	sub := subscribeSetpoint(t, addr)
	gtReadback(a, now, true, false)
	m := gtTick(t, a, sub, now)
	kw, ok := m["grid_target_kw"].(float64)
	if !ok || math.IsNaN(kw) || kw > guards.GridTargetMaxKw {
		t.Fatalf("grid_target_kw = %v", m["grid_target_kw"])
	}
}

// Der Beleg ueber die SPRACHGRENZE: was der ausgelieferte Deye-Executor nach
// einem netzseitigen Takt meldet (erzeugt vom Node-e2e gegen den Solarman-Stub,
// docs/contracts/v2/control-readback-vectors.json) ist genau das, woran der
// Kern die Uebernahme erkennt - an den REGISTERN, nicht an einem Wort. Aendert
// Layer 1 eine Rolle oder der Kern seine Lesart, wird dieser Test rot.
func TestGridTargetEvidenceArrivesThroughThePalette(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gtRig(t, now)

	// Ein gewoehnlicher Fahrplan-Takt: der Hebel ist gemeldet, belegt ist nichts.
	a.onControlReadback("", readbackVector(t, "f11_plan_vorher", now, nil))
	c := a.State.Get().Control
	if !gridTargetLever(c) {
		t.Fatalf("der freigegebene Hebel reist in native_capabilities: %+v", c.NativeCapabilities)
	}
	if gridTargetEvidence(c, now, time.Minute) {
		t.Fatal("ein batterieseitiger Takt belegt die Netzseite nicht")
	}

	for _, name := range []string{"netzseitig_takt1_eintritt", "netzseitig_takt2_herzschlag"} {
		a.onControlReadback("", readbackVector(t, name, now, nil))
		c = a.State.Get().Control
		if !gridTargetEvidence(c, now, time.Minute) {
			t.Fatalf("%s: die Register belegen die Netzseite: %+v", name, c.Registers)
		}
		if !gridTargetLever(c) {
			t.Fatalf("%s: der Hebel bleibt gemeldet", name)
		}
		// Die Rollen, auf die sich der Kern stuetzt, stehen im Vektor.
		var side, target bool
		for _, r := range c.Registers {
			side = side || (r.Role == rolePowerControlMode && r.ActualRaw != nil && *r.ActualRaw == deyeGridSideValue)
			target = target || r.Role == roleGridPower
		}
		if !side || !target {
			t.Fatalf("%s: power_control_mode=2 und grid_power fehlen: %+v", name, c.Registers)
		}
	}

	// Ein veralteter Beleg ist keiner, und ein nicht GELESENER Seitenwahl-Wert
	// auch nicht (unread ist nicht held).
	if gridTargetEvidence(c, now.Add(10*time.Minute), time.Minute) {
		t.Fatal("ein alter Beleg belegt nichts")
	}
	unread := *c
	unread.Registers = append([]state.ControlRegister{}, c.Registers...)
	for i := range unread.Registers {
		if unread.Registers[i].Role == rolePowerControlMode {
			unread.Registers[i].ActualRaw = nil
		}
	}
	if gridTargetEvidence(&unread, now, time.Minute) {
		t.Fatal("ohne zurueckgelesene Regelseite kein Beleg")
	}
}

// GEMEINSAME STEUERUNG (AP-15) trifft den netzseitigen Slot - und bekommt ihn
// nicht. Eine Box mit Anteile-Dokument haelt ihren Netzanschluss ueber die
// Hebel, die sie selbst stellt (Batterie-Sollwert, PV-Kappen); netzseitig
// hielte das GERAET diesen Zaehler und glich jede Verstellung der Box aus.
// Gemessen am ersten Zusammenbau: die Einfrierprobe (IP-20) erklaerte einen
// Netzpunkt, der brav auf dem Ziel stand, nach 60 s fuer eingefroren, beide
// Waechter liefen blind. Mit Dokument bleibt derselbe Negativpreis-Slot
// deshalb auf der Batterie-Seite - kein Feld, kein Wort, der Grund genannt.
func TestUnderAShareDocumentTheSlotStaysOnTheBatterySide(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gtRigWith(t, now, halle1Cfg(t, "fuehrt"))
	if a.heldAnteile() == nil {
		t.Fatal("Vorbereitung: die Box haelt kein Anteile-Dokument")
	}
	sub := subscribeSetpoint(t, addr)

	at := now
	for i := 0; i < 9; i++ {
		gtTelemetry(a, at, 12.5, -0.1, 5, 60)
		gtReadback(a, at, true, false)
		m := gtTick(t, a, sub, at)
		if gtHasGridFields(m) {
			t.Fatalf("mit Anteile-Dokument traegt der Sollwert ein netzseitiges Feld: %v", m)
		}
		snap := a.State.Get()
		if snap.GridTarget != nil {
			t.Fatalf("kein netzseitiger Zustand unter gemeinsamer Steuerung: %+v", snap.GridTarget)
		}
		if w := snap.GridTargetWithheld; w == nil || w.Reason != guards.GridTargetSharedControl || w.Text == "" {
			t.Fatalf("die Verweigerung nennt ihren Grund: %+v", w)
		}
		at = at.Add(10 * time.Second)
	}
}
