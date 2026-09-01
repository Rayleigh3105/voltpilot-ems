package agent

// Der Netz-Sollwert-Test (Konzept `vp-deye-netzseitig-drossel-k2` P1) auf der
// VERDRAHTUNGS-Ebene: die Zulassung gegen die echte Anlagen-Lage, der
// veroeffentlichte Sollwert, die Rueckkehr per Frist und per Abbruch - und die
// Zusage, dass eine Anlage OHNE armierten Test byte-identisch weiterlaeuft.
//
// Die REGELN selbst (Schrittfolge, Abbruch-Huelle, Plateau-Beweis) sind
// Docker-frei in `internal/curtailcal/gridtest_test.go` bewiesen; hier steht
// ausschliesslich, was nur mit Bus, Zustand und Sollwert-Pfad pruefbar ist.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// gridRig baut die Lage aus §3.1: ein Deye-Pilot auf dem Fernsteuerpfad, zwei
// freigegebene und ruhig meldende Fronius, satte Einspeisung, ein Fahrplan, der
// im laufenden UND im naechsten Slot laedt.
//
// ⚠ Die Familie wird hier ueber die TEST-Konfiguration zertifiziert, nicht ueber
// `CERTIFIED_CONTROL_FAMILIES` in Layer 1 - der Testpfad erweitert die
// ausgelieferte Allowlist um nichts.
func gridRig(t *testing.T, now time.Time) (*Agent, string, []sources.Source) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.ControlCertifiedFamilies = []string{"hybrid_3p"}
	a, addr := startBusOnlyAgent(t, cfg)
	selectDeye(t, a)

	fr1 := addFronius(t, a, 1, 25)
	fr2 := addFronius(t, a, 2, 30)
	feedSource(a, fr1.ID, 12)
	feedSource(a, fr2.ID, 12)
	gridCertifyFronius(t, a, fr1, now)
	gridCertifyFronius(t, a, fr2, now)

	// Der Fernsteuerpfad ist eine BEOBACHTUNG des Rueckmeldens, kein Schalter.
	rb, _ := json.Marshal(map[string]any{
		"ts": now.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": "schedule",
		"mode": "normal", "all_match": true, "control_path": "remote",
		"registers": []map[string]any{{"role": "battery_power", "match": true}},
	})
	a.onControlReadback("", rb)

	// ⚠ Der Ruhe-Beobachter sieht die KOMPOSITE Anlagen-PV (Primaer + Fronius),
	// nicht den Rohwert der Nutzlast - mit dem Rohwert geseedet waere der erste
	// echte Messwert ein Sprung und die Ruhe waere weg. Also erst messen, dann
	// mit dem GEMESSENEN Wert eine ruhige Historie legen.
	gridFeedTelemetry(a, now, 45, -24.9, 52)
	a.mu.Lock()
	sitePv := a.lastReading.PvKw
	a.mu.Unlock()
	gridSeedPv(a, now, sitePv)
	gridFeedTelemetry(a, now, 45, -24.9, 52)

	a.mu.Lock()
	a.currentPlan = gridPlan(now)
	a.mu.Unlock()
	return a, addr, []sources.Source{fr1, fr2}
}

// gridCertifyFronius setzt Freigabe + frische, widerspruchsfreie Rueckmeldung
// einer Abregel-Einheit - die §3.1-Bedingung „die Kappen stehen".
func gridCertifyFronius(t *testing.T, a *Agent, s sources.Source, now time.Time) {
	t.Helper()
	key := curtailUnitKey(s.Connection)
	match := true
	a.curtailMu.Lock()
	if a.curtailCert == nil {
		a.curtailCert = map[string]bool{}
	}
	if a.curtailUnits == nil {
		a.curtailUnits = map[string]state.CurtailUnit{}
	}
	a.curtailCert[key] = true
	a.curtailUnits[key] = state.CurtailUnit{CheckedAt: now, AllMatch: &match}
	a.curtailMu.Unlock()
}

// gridSeedPv legt eine RUHIGE Erzeugungs-Historie an: die §3.1-Bedingung
// verlangt 60 s ohne Sprung, und eine Luecke groesser als 60 s setzt den Anker
// zurueck - eine Reihe aus zwei weit auseinander liegenden Punkten waere also
// gerade KEINE Ruhe.
func gridSeedPv(a *Agent, now time.Time, pv float64) {
	a.gridMu.Lock()
	defer a.gridMu.Unlock()
	// ⚠ Ein RUECKWAERTS gelegter Messwert verschiebt den Anker nicht (der
	// Beobachter kennt nur Sprung und Luecke, keine Zeitreise) - die Historie
	// muss deshalb auf einem LEEREN Beobachter beginnen.
	a.gridPv = curtailcal.GridPvTracker{}
	for d := 2 * time.Minute; d >= 0; d -= 20 * time.Second {
		a.gridPv.Observe(pv, now.Add(-d))
	}
}

// gridFeedTelemetry faehrt den ECHTEN Telemetrie-Pfad (inkl. der Gates), damit
// Messalter und die Beobachtung des Laufs so entstehen wie im Betrieb.
func gridFeedTelemetry(a *Agent, at time.Time, pv, grid, soc float64) {
	raw, _ := json.Marshal(map[string]any{
		"ts": at.Format(time.RFC3339Nano), "pv_power_kw": pv,
		"power_kw": grid, "load_kw": 6.0, "soc_pct": soc,
	})
	a.onLocalTelemetry("", raw)
	a.mu.Lock()
	a.lastReadingAt = at
	a.mu.Unlock()
}

// gridPlan: der laufende UND der naechste Slot laden - die §3.1-Bedingung, die
// verhindert, dass der Test in einen geplanten Entlade-Slot faellt.
func gridPlan(now time.Time) *plan.Plan {
	start := now.Add(-time.Minute)
	return &plan.Plan{
		SlotMinutes: 15,
		ReceivedAt:  now,
		Slots: []plan.Slot{
			{Start: start, BatterySetpointKw: 5},
			{Start: start.Add(15 * time.Minute), BatterySetpointKw: 5},
		},
	}
}

func gridBlock(m map[string]any) (map[string]any, bool) {
	b, ok := m["grid_test"].(map[string]any)
	return b, ok
}

// ⚠ DIE KOMPATIBILITAETS-ZUSAGE: ohne armierten Test ist der Sollwert-Pfad
// zeichengleich zu vorher - kein Feld, kein anderer Modus, keine Freigabe.
func TestWithoutAnArmedGridTestTheSetpointIsByteForByteUnchanged(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)

	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "gewoehnlicher Sollwert", func() bool {
		m, ok := sub.latest()
		return ok && m["source"] != nil
	})
	m, _ := sub.latest()
	if _, ok := gridBlock(m); ok {
		t.Fatal("ohne armierten Test darf kein grid_test-Block reisen")
	}
	if m["source"] == "grid-test" {
		t.Fatal("ohne armierten Test darf der Testpfad den Sollwert nicht besitzen")
	}
	if s := a.State.Get(); s.Mode == "calibration" {
		t.Fatal("ohne armierten Test bleibt der Betriebsmodus unberuehrt")
	}
}

// Jede offene Voraussetzung aus §3.1 lehnt den Start ab - und schreibt NICHTS.
func TestGridTestStartRefusesAnOpenPreconditionWithoutTouchingTheSetpoint(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name string
		mut  func(t *testing.T, a *Agent)
		want string
	}{
		{"Not-Aus", func(_ *testing.T, a *Agent) { a.Cfg.ControlEnabled = false }, "Not-Aus"},
		{"nicht freigegeben", func(_ *testing.T, a *Agent) { a.Cfg.ControlCertifiedFamilies = nil }, "freigegeben"},
		{"kein Fronius", func(_ *testing.T, a *Agent) {
			for _, s := range a.ListSources() {
				_ = a.DeleteSource(s.ID)
			}
		}, "Fronius"},
		{"Fahrplan entlaedt", func(_ *testing.T, a *Agent) {
			a.mu.Lock()
			a.currentPlan = freshPlan(now, -5, nil)
			a.mu.Unlock()
		}, "entladen"},
		{"Messwerte alt", func(_ *testing.T, a *Agent) {
			a.mu.Lock()
			a.lastReadingAt = now.Add(-time.Hour)
			a.mu.Unlock()
		}, "älter"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, addr, _ := gridRig(t, now)
			sub := subscribeSetpoint(t, addr)
			tc.mut(t, a)

			if _, err := a.GridTestStart(curtailcal.GridModeGrid); err == nil {
				t.Fatalf("%s: der Start wurde zugelassen", tc.name)
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%s: der Grund nennt %q nicht: %s", tc.name, tc.want, err.Error())
			}
			// Eine Ablehnung erreicht den Wechselrichter nie.
			a.applySetpoint(now)
			waitFor(t, 5*time.Second, "Sollwert", func() bool { _, ok := sub.latest(); return ok })
			m, _ := sub.latest()
			if _, ok := gridBlock(m); ok {
				t.Fatalf("%s: eine Ablehnung darf keinen Testschritt veroeffentlichen", tc.name)
			}
		})
	}
}

// Die Reise: armieren -> Neutralschritt -> netzseitig halten -> Abbruch faehrt
// die Rueckkehr -> danach gehoert der Sollwert wieder dem Fahrplan.
func TestGridTestJourneyPublishesTheStepsAndAlwaysReturnsToTheBatterySide(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)

	view, err := a.GridTestStart(curtailcal.GridModeGrid)
	if err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	if view.Run == nil || view.Run.Step != curtailcal.GridStepNeutral {
		t.Fatalf("ein frisch armierter Lauf beginnt im Neutralschritt: %+v", view.Run)
	}

	// ⚠ Ein Messwert IM Neutralschritt ist Pflicht: erst er latcht das
	// Halte-Ziel. Ohne ihn faellt jeder Folgeschritt bewusst auf die
	// batterieseitige Ruhe zurueck (lieber ein Takt ohne Fortschritt als ein
	// erfundener Sollwert) - so verhaelt sich auch die echte Box, die alle
	// 5-10 s misst.
	gridFeedTelemetry(a, now.Add(5*time.Second), 45, -24.9, 52)

	// (1) Der Neutralschritt: batterieseitige Ruhe, PV-Kappe noch NICHT.
	waitFor(t, 5*time.Second, "Neutralschritt am Sollwert", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		b, ok := gridBlock(m)
		return ok && b["step"] == curtailcal.GridStepNeutral
	})
	m, _ := sub.latest()
	b, _ := gridBlock(m)
	if b["side"] != curtailcal.GridSideBattery {
		t.Fatalf("der Neutralschritt ist batterieseitig, war %v", b["side"])
	}
	if _, ok := b["pv_cap_permille"]; ok {
		t.Fatal("die PV-Kappe gehoert erst hinter die Beobachtung")
	}
	if m["battery_setpoint_kw"] != 0.0 {
		t.Fatalf("netzseitig kommandieren wir keinen Batterie-Sollwert: %v", m["battery_setpoint_kw"])
	}
	if m["grid_charge_allowed"] != false {
		t.Fatal("ein Netz-Sollwert-Test laedt nie aus dem Netz")
	}
	if m["control_enabled"] != true || m["device_certified"] != true {
		t.Fatalf("dieser Test umgeht KEIN Tor: %v / %v", m["control_enabled"], m["device_certified"])
	}

	// (2) Nach dem Neutralschritt: netzseitig, mit dem gelatchten Halte-Ziel.
	at := now.Add(21 * time.Second)
	gridFeedTelemetry(a, at, 45, -24.9, 52)
	a.applySetpoint(at)
	waitFor(t, 5*time.Second, "netzseitiger Schritt", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		b, ok := gridBlock(m)
		return ok && b["side"] == curtailcal.GridSideGrid
	})
	m, _ = sub.latest()
	b, _ = gridBlock(m)
	if b["neutralize"] != true {
		t.Fatal("der Seitenwechsel braucht den Neutralschritt VOR 1104")
	}
	if got, want := b["target_kw"], -24.9; got != want {
		t.Fatalf("das Halte-Ziel ist der gemessene Netzpunkt: %v, erwartet %v", got, want)
	}

	// (3) Abbrechen heisst ZURUECKNEHMEN, nicht aufhoeren zu schreiben - und
	// zwar SOFORT: der Abbruch stoesst den Sollwert selbst an, es braucht
	// keinen weiteren Takt.
	a.GridTestAbort()
	waitFor(t, 5*time.Second, "Rueckkehr", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		b, ok := gridBlock(m)
		return ok && b["step"] == curtailcal.GridStepRueckkehr
	})
	m, _ = sub.latest()
	b, _ = gridBlock(m)
	if b["side"] != curtailcal.GridSideBattery || b["neutralize"] != true {
		t.Fatalf("die Rueckkehr ist ein batterieseitiger Seitenwechsel: %+v", b)
	}

	// (4) Nach der Rueckkehr gehoert der Sollwert wieder dem Fahrplan.
	after := at.Add(curtailcal.GridReturnGrace + 2*time.Second)
	gridFeedTelemetry(a, after, 45, -24.9, 52)
	a.applySetpoint(after)
	waitFor(t, 5*time.Second, "gewoehnlicher Sollwert", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, isTest := gridBlock(m)
		return !isTest
	})
}

// ⚠ Die TTL ist die Sicherheit: sie faehrt die Rueckkehr, auch wenn niemand
// mehr zusieht - ohne Klick, ohne Oberflaeche, ohne Cloud.
func TestGridTestReturnsOnItsOwnWhenTheDeadlinePasses(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}

	after := now.Add(curtailcal.GridDefaultTTL + time.Second)
	a.applySetpoint(after)
	waitFor(t, 5*time.Second, "Rueckkehr nach der Frist", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		b, ok := gridBlock(m)
		return ok && b["step"] == curtailcal.GridStepRueckkehr
	})
	if a.GridTestSnapshot().Run == nil {
		t.Fatal("der abgelaufene Lauf bleibt fuer die Nachschau sichtbar")
	}
}

// ⚠ Ein laufender Test BESITZT den Wechselrichter: keine oekonomische
// Ausfuehrungsart darf daneben einen scharfen Zustand behaupten - und die
// Fronius-Kappe des Plans reist UNVERAENDERT weiter (sonst gaebe der Test die
// Abregelung frei, gegen die er misst).
func TestGridTestOwnsTheSetpointAndCarriesThePlanCapAlong(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)

	cap := 30.0
	a.mu.Lock()
	p := gridPlan(now)
	p.Slots[0].PvLimitKw = &cap
	a.currentPlan = p
	a.mu.Unlock()

	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	waitFor(t, 5*time.Second, "Testsollwert", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, isTest := gridBlock(m)
		return isTest
	})
	m, _ := sub.latest()
	if m["pv_limit_kw"] != 30.0 {
		t.Fatalf("die geplante Fronius-Kappe muss unveraendert mitreisen: %v", m["pv_limit_kw"])
	}
	s := a.State.Get()
	if s.Trim != nil || s.Follow != nil || s.Absorb != nil || s.Native != nil {
		t.Fatalf("waehrend des Tests darf keine Ausfuehrungsart scharf stehen: %+v", s)
	}
}

// ⚠ Der Testpfad umgeht GAR KEIN Tor - anders als die First-Light-Kalibrierung,
// die bewusst die ZERTIFIZIERUNG umgeht (sie verdient sie ja erst). Wird der
// Not-Aus WAEHREND eines Laufs gedrueckt, faellt `control_enabled` sofort, und
// Layer 1 schreibt nichts mehr.
func TestGridTestNeverBypassesTheKillSwitchWhileItRuns(t *testing.T) {
	now := time.Now().UTC()
	a, addr, _ := gridRig(t, now)
	sub := subscribeSetpoint(t, addr)
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	waitFor(t, 5*time.Second, "Testsollwert", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, isTest := gridBlock(m)
		return isTest && m["control_enabled"] == true
	})

	a.Cfg.ControlEnabled = false
	at := now.Add(5 * time.Second)
	gridFeedTelemetry(a, at, 45, -24.9, 52)
	a.applySetpoint(at)
	waitFor(t, 5*time.Second, "Sollwert ohne Freigabe", func() bool {
		m, ok := sub.latest()
		return ok && m["control_enabled"] == false
	})
	m, _ := sub.latest()
	if _, ok := gridBlock(m); !ok {
		t.Fatal("der Lauf bleibt sichtbar - nur schreiben darf er nicht mehr")
	}
}

// Zwei Laeufe gleichzeitig darf es nie geben - auch nicht waehrend der Rueckkehr.
func TestGridTestRefusesASecondRunWhileOneOwnsTheSetpoint(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err == nil {
		t.Fatal("ein zweiter Lauf muss abgelehnt werden")
	}
}

// Die Abbruch-Huelle wirkt aus der BEOBACHTUNG heraus, nicht erst beim naechsten
// Sollwert-Takt: ein Ladestand am Rand beendet den Lauf sofort.
func TestGridTestAbortsFromTheObservationWhenTheEnvelopeIsLeft(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	// ⚠ Bewusst der Beobachtungs-Eingang statt des Telemetrie-Pfads: ein Sprung
	// von 52 auf 97 % waere ein Despiker-Fall (hold-last), und der ist an
	// anderer Stelle bewiesen. Hier geht es um die Kette Messung -> Huelle ->
	// Abbruch, nicht um das Messwert-Tor davor.
	at := now.Add(10 * time.Second)
	a.gridObserve(at, map[string]float64{"power_kw": -24.9, "pv_power_kw": 69, "soc_pct": 97}, nil)
	v := a.gridView(curtailcal.GridModeGrid, at.Add(time.Second))
	if v.Evidence == nil || v.Evidence.Verdict != curtailcal.GridVerdictAborted {
		t.Fatalf("ein Ladestand am Rand muss den Lauf beenden: %+v", v.Evidence)
	}
}

// Der Rueckmelde-Zyklus zaehlt nur ENTSCHIEDEN: zwei nicht gehaltene Zyklen
// beenden den Lauf, ein Zyklus ohne Antwort ist keine Aussage.
func TestGridTestAbortsAfterTwoUnconfirmedRegisterCycles(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err != nil {
		t.Fatalf("GridTestStart: %v", err)
	}
	for i := 0; i < curtailcal.GridBadCyclesAbort; i++ {
		a.gridNoteReadback(false, now.Add(time.Duration(10+i*10)*time.Second))
	}
	v := a.gridView(curtailcal.GridModeGrid, now.Add(45*time.Second))
	if v.Evidence == nil || v.Evidence.Verdict != curtailcal.GridVerdictAborted {
		t.Fatalf("zwei unbestaetigte Zyklen beenden den Lauf: %+v", v.Evidence)
	}
}

// Die AC-Probe ist ein EIGENER, kuerzerer Lauf (Captain-Entscheid E1) - nie eine
// Verlaengerung des netzseitigen Fensters.
func TestGridTestAcProbeIsItsOwnShorterRun(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	v, err := a.GridTestStart(curtailcal.GridModeAc)
	if err != nil {
		t.Fatalf("GridTestStart(ac): %v", err)
	}
	if v.Run == nil || v.Run.Mode != curtailcal.GridModeAc {
		t.Fatalf("die AC-Probe laeuft in ihrem eigenen Modus: %+v", v.Run)
	}
	if v.Run.SecondsRemaining > int(curtailcal.GridAcTTL/time.Second) {
		t.Fatalf("die AC-Probe ist auf %s begrenzt, meldete %d s", curtailcal.GridAcTTL, v.Run.SecondsRemaining)
	}
}

// Die Voraussetzungs-Liste der Karte stimmt mit dem ueberein, was Start tut.
func TestGridViewPreconditionsAgreeWithStart(t *testing.T) {
	now := time.Now().UTC()
	a, _, _ := gridRig(t, now)
	v := a.gridView(curtailcal.GridModeGrid, now)
	if !v.Supported {
		t.Fatalf("die Lage aus §3.1 muss unterstuetzt sein: %s", v.Reason)
	}
	if failed := curtailcal.GridPreconditionsFailed(v.Preconditions); len(failed) != 0 {
		t.Fatalf("keine offene Bedingung erwartet: %v", failed)
	}
	a.Cfg.ControlEnabled = false
	v2 := a.gridView(curtailcal.GridModeGrid, now)
	if failed := curtailcal.GridPreconditionsFailed(v2.Preconditions); len(failed) == 0 {
		t.Fatal("der Not-Aus muss als offene Bedingung erscheinen")
	}
	if _, err := a.GridTestStart(curtailcal.GridModeGrid); err == nil {
		t.Fatal("dieselbe Bedingung muss den Start ablehnen")
	}
}
