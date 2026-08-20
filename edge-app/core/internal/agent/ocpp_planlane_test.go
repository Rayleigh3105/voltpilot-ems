package agent

import (
	"context"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// Die FAHRPLAN-Bahn AN DEN SÄULEN (Stufe 4, Weg A): was die Fahrzeuge wirklich
// ziehen dürfen, gelesen aus den Ladeprofilen, die der Kern installiert hat.
//
// Die REGELN stehen in internal/lastmgmt/planlane_test.go; hier geht es um die
// VERDRAHTUNG - dass das Ziel des Plans über den Lastspitzen-Zähler wirklich
// beim Verteiler ankommt, und dass es verschwindet, sobald es das soll.

// peakPlan is a fresh plan carrying a billing-period peak target.
func peakPlan(now time.Time, targetKw float64) *plan.Plan {
	p := freshPlan(now, 0, nil)
	p.GridImportLimitKw = &targetKw
	return p
}

// feedGrid drives the peak tracker AND the budget the way the telemetry choke
// point does: one paired sample of the connection point.
func feedGrid(a *Agent, at time.Time, gridKw, chargingKw float64) {
	a.peak.Add(at, gridKw)
	a.ocpp.budget.Observe(at, gridKw, chargingKw, true)
}

// feedAtTheTarget makes the projection DETERMINISTIC at any second of any
// quarter hour, and it does so with a physically meaningful state.
//
// ⚠ Der Lastspitzen-Zähler projiziert das Viertelstunden-MITTEL: erlaubt =
// (Ziel·900 s − bisher Bezogenes) / Restsekunden. Eine RUHIGE Viertelstunde
// erlaubt kurz vor ihrem Ende deshalb völlig zu Recht ein Vielfaches des Ziels
// - der Mittelwert ist die Grösse, nicht der Augenblick. Ein Test, der einfach
// „jetzt" misst, hängt damit an der Uhr und flackert (genau so passiert).
// Läuft der Standort dagegen die ganze bisherige Viertelstunde GENAU auf dem
// Ziel, ist die Projektion exakt das Ziel - unabhängig davon, wie weit die
// Viertelstunde fortgeschritten ist.
func feedAtTheTarget(a *Agent, now time.Time, targetKw, chargingKw float64) {
	qs := now.Truncate(15 * time.Minute)
	feedGrid(a, qs, targetKw, chargingKw)
	feedGrid(a, now, targetKw, chargingKw)
}

// TestTheFahrplanCeilingReachesTheStations is the headline: the same site, the
// same measurement - once with a peak target and once without.
func TestTheFahrplanCeilingReachesTheStations(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// Der Standort läuft die bisherige Viertelstunde auf 100 kW, davon 40 kW
	// Laden -> Rest 60 kW, lokales Budget 249,3 - 60 = 189,3 kW.
	now := time.Now().UTC()
	feedAtTheTarget(a, now, 100, 40)
	a.ocppStep(context.Background())
	wide := a.State.Get().Ocpp
	nearKw(t, "ohne Fahrplan", wide.BudgetKw, 189.3)
	if wide.PlanLimitKw != nil {
		t.Fatalf("ohne Plan wird ein Deckel behauptet: %v", *wide.PlanLimitKw)
	}

	// Jetzt hält der Fahrplan die Lastspitze bei genau diesen 100 kW. Davon
	// nimmt der Rest des Standorts 60 - den Fahrzeugen bleiben 40 kW statt
	// 189,3.
	a.mu.Lock()
	a.currentPlan = peakPlan(now, 100)
	a.mu.Unlock()
	a.ocppStep(context.Background())
	capped := a.State.Get().Ocpp
	if capped.PlanLimitKw == nil || !capped.PlanLimitBinds {
		t.Fatalf("der Fahrplan-Deckel bindet nicht: %+v (%s)", capped.PlanLimitKw, capped.BudgetNote)
	}
	nearKw(t, "mit Fahrplan", capped.BudgetKw, 40)
	if capped.BudgetKw >= wide.BudgetKw {
		t.Fatalf("der Deckel hat nichts verengt (%v -> %v kW)", wide.BudgetKw, capped.BudgetKw)
	}
	// Und die Säule zieht wirklich weniger: gemessen am Ladeprofil, nicht an
	// einer Quittung.
	waitUntil(t, "die Säule bekommt das engere Profil", func() bool {
		return findProfileSoft(s1, "TxProfile")/1000 <= capped.BudgetKw+1
	})
	if !contains(capped.BudgetNote, "Fahrplan") {
		t.Fatalf("der Grund nennt den Fahrplan nicht: %q", capped.BudgetNote)
	}
}

// TestAStalePlanNeverHoldsAVehicleBack ist die tragende Zusage des Captains:
// ein veralteter Plan räumt die Bahn ab, die lokale Logik gilt unverändert -
// im Zweifel lädt das Auto.
func TestAStalePlanNeverHoldsAVehicleBack(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	_ = ocppStation(t, a, "SAEULE-1", 1, 240)

	now := time.Now().UTC()
	feedAtTheTarget(a, now, 100, 40)
	a.mu.Lock()
	a.currentPlan = peakPlan(now, 100)
	a.mu.Unlock()
	a.ocppStep(context.Background())
	if v := a.State.Get().Ocpp; !v.PlanLimitBinds {
		t.Fatalf("Ausgangslage: der Deckel bindet nicht (%s)", v.BudgetNote)
	}

	// Derselbe Plan, nur zu alt (die Staleness des Plan-Ausführers).
	a.mu.Lock()
	a.currentPlan.ReceivedAt = now.Add(-plan.StaleAfter - time.Minute)
	a.mu.Unlock()
	a.ocppStep(context.Background())
	v := a.State.Get().Ocpp
	if v.PlanLimitKw != nil || v.PlanLimitBinds {
		t.Fatalf("ein VERALTETER Plan deckelt weiter: %+v (%s)", v.PlanLimitKw, v.BudgetNote)
	}
	nearKw(t, "die lokale Logik gilt wieder", v.BudgetKw, 189.3)
}

// TestAPlanWithoutAPeakTargetIsByteForByteTheLocalLogic - die meisten Anlagen
// haben kein Lastspitzen-Modul, und für sie darf sich NICHTS ändern.
func TestAPlanWithoutAPeakTargetIsByteForByteTheLocalLogic(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	_ = ocppStation(t, a, "SAEULE-1", 1, 240)

	now := time.Now().UTC()
	feedGrid(a, now, 60, 40)
	a.mu.Lock()
	a.currentPlan = freshPlan(now, -5, nil) // ein ganz normaler Fahrplan
	a.mu.Unlock()
	a.ocppStep(context.Background())
	v := a.State.Get().Ocpp
	if v.PlanLimitKw != nil {
		t.Fatalf("ein Plan ohne Lastspitzen-Ziel erzeugt einen Deckel: %v", *v.PlanLimitKw)
	}
	nearKw(t, "budget", v.BudgetKw, 229.3)
}

// TestWithoutAMeasurementTheFahrplanCannotHoldAnythingBack - der Deckel lebt
// nur im gemessenen Zweig. Ohne Messung am Netzanschluss gibt es weder eine
// Projektion noch eine Grundlage, und die blinden Stufen bleiben unberührt.
func TestWithoutAMeasurementTheFahrplanCannotHoldAnythingBack(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167) // 82,3 kW hinterlegtes Budget
	_ = ocppStation(t, a, "SAEULE-1", 1, 240)

	now := time.Now().UTC()
	a.mu.Lock()
	a.currentPlan = peakPlan(now, 10) // ein sehr enges Ziel
	a.mu.Unlock()
	a.ocppStep(context.Background())
	v := a.State.Get().Ocpp
	if v.BudgetMode != string(lastmgmt.BudgetStatic) {
		t.Fatalf("mode = %q, want %q", v.BudgetMode, lastmgmt.BudgetStatic)
	}
	nearKw(t, "das hinterlegte Budget", v.BudgetKw, 82.3)
	if v.PlanLimitKw != nil {
		t.Fatalf("ein blinder Zweig meldet einen Fahrplan-Deckel: %v", *v.PlanLimitKw)
	}
}

// TestTheProjectionIsExactlyTheTargetWhenTheSiteRanAtIt belegt die Prämisse von
// feedAtTheTarget - und damit, dass die Fälle darüber NICHT an der Uhr hängen.
//
// Die Projektion ist (Ziel·900 s − bisher Bezogenes) / Restsekunden. Lief der
// Standort die bisherige Viertelstunde genau auf dem Ziel, kürzt sich der
// Fortschritt heraus: erlaubt == Ziel, an jeder Sekunde der Viertelstunde.
func TestTheProjectionIsExactlyTheTargetWhenTheSiteRanAtIt(t *testing.T) {
	const target = 100.0
	qs := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	for _, elapsed := range []time.Duration{
		0, time.Second, time.Minute, 5 * time.Minute, 14 * time.Minute, 899 * time.Second,
	} {
		tr := guards.NewPeakTracker()
		now := qs.Add(elapsed)
		tr.Add(qs, target)
		tr.Add(now, target)
		got, ok := tr.AllowedImport(now, target)
		if !ok {
			t.Fatalf("elapsed %s: der Zähler ist inaktiv", elapsed)
		}
		if got < target-0.5 || got > target+0.5 {
			t.Fatalf("elapsed %s: erlaubt %.3f kW, erwartet %.1f - die Projektion hängt doch an der Uhr",
				elapsed, got, target)
		}
	}

	// Und die Gegenprobe, die den ursprünglichen Flake ERKLÄRT: eine RUHIGE
	// Viertelstunde erlaubt kurz vor ihrem Ende völlig zu Recht ein Vielfaches
	// des Ziels - der Mittelwert ist die Grösse, nicht der Augenblick.
	quiet := guards.NewPeakTracker()
	late := qs.Add(870 * time.Second)
	quiet.Add(qs, 0)
	quiet.Add(late, 0)
	got, ok := quiet.AllowedImport(late, target)
	if !ok {
		t.Fatal("der Zähler ist inaktiv")
	}
	if got <= target*2 {
		t.Fatalf("erlaubt %.1f kW - dann wäre der ursprüngliche Flake nicht erklärbar", got)
	}
}
