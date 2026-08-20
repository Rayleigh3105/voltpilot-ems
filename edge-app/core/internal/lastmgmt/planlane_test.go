package lastmgmt

import (
	"math"
	"strings"
	"testing"
	"time"
)

// Die FAHRPLAN-Bahn (Stufe 4, Captain-Entscheid „Weg A" vom 20.08.2026): der
// Plan reicht eine OBERGRENZE herunter, und sie kann nur einschränken.
//
// ⚠ Die tragende Zusage ist FAIL-OPEN: ohne Plan, mit veraltetem Plan oder ohne
// Messung gilt die lokale Logik UNVERÄNDERT. Ein Fahrzeug darf nie wegen eines
// fehlenden Plans stehen bleiben - im Zweifel lädt es. Jede Regel darunter ist
// eine Variante genau dieses Satzes.

// TestTheFahrplanLaneOnlyEverNarrows ist der Kern: dieselbe Messung, einmal
// ohne und einmal mit Deckel.
func TestTheFahrplanLaneOnlyEverNarrows(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	// 60 kW am Netzanschluss, davon 40 kW Laden -> Rest 20 kW -> 229,3 kW.
	tr.Observe(t0, 60, 40, true)
	base := tr.Budget(t0, set)
	near(t, "ohne Fahrplan", base.Kw, 229.3)
	if base.PlanLimitKw != nil || base.PlanLimitBinds {
		t.Fatalf("ohne Fahrplan darf kein Deckel behauptet werden: %+v", base.PlanLimitKw)
	}

	// Der Plan lässt dem STANDORT noch 100 kW in dieser Viertelstunde; 20 kW
	// davon braucht der Rest des Standorts, also bleiben den Fahrzeugen 80.
	tr.ObservePlanLimit(t0, 100)
	v := tr.Budget(t0, set)
	if !v.PlanLimitBinds || v.PlanLimitKw == nil {
		t.Fatalf("der Fahrplan-Deckel bindet nicht: %+v (%s)", v.PlanLimitKw, v.Reason)
	}
	near(t, "mit Fahrplan", v.Kw, 80)
	near(t, "der gemeldete Deckel", *v.PlanLimitKw, 80)
	if v.Mode != BudgetMeasured {
		t.Fatalf("der Modus bleibt gemessen, war %q", v.Mode)
	}
	// Und er NENNT sich: eine Begrenzung ohne Namen liest sich wie ein Defekt.
	for _, want := range []string{"Fahrplan", "Lastspitze", "80,0"} {
		if !strings.Contains(v.Reason, want) {
			t.Fatalf("der Grund nennt %q nicht: %q", want, v.Reason)
		}
	}
}

// TestAWiderFahrplanCeilingChangesNothing - der Deckel kann NICHTS anheben.
func TestAWiderFahrplanCeilingChangesNothing(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 60, 40, true)
	tr.ObservePlanLimit(t0, 400) // weit über allem
	v := tr.Budget(t0, set)
	near(t, "budget", v.Kw, 229.3)
	if v.PlanLimitBinds {
		t.Fatalf("ein weiter Deckel darf nicht binden (%s)", v.Reason)
	}
	// Er wird trotzdem GEMELDET - die Fläche darf zeigen, dass die Bahn lebt.
	if v.PlanLimitKw == nil {
		t.Fatal("der Deckel wird nicht berichtet, obwohl die Bahn armiert ist")
	}
	if strings.Contains(v.Reason, "Fahrplan") {
		t.Fatalf("ein nicht bindender Deckel gehört nicht in den Satz: %q", v.Reason)
	}
}

// TestClearingTheFahrplanLaneRestoresTheLocalLogic - das ist die Zusage
// wörtlich: der Deckel verschwindet, das Budget ist wieder das lokale.
func TestClearingTheFahrplanLaneRestoresTheLocalLogic(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 60, 40, true)
	tr.ObservePlanLimit(t0, 100)
	if v := tr.Budget(t0, set); !v.PlanLimitBinds {
		t.Fatalf("Ausgangslage: der Deckel bindet nicht (%s)", v.Reason)
	}
	tr.ClearPlanLimit()
	v := tr.Budget(t0, set)
	near(t, "nach dem Abräumen", v.Kw, 229.3)
	if v.PlanLimitKw != nil || v.PlanLimitBinds {
		t.Fatalf("nach dem Abräumen wird noch ein Deckel behauptet: %+v", v.PlanLimitKw)
	}
}

// TestAnUnrefreshedFahrplanCeilingExpiresOpen ist die zweite Hälfte des
// Fail-open: ein Deckel, den niemand mehr auffrischt, ist keiner. Ein
// steckengebliebener Aufrufer darf keine Anlage drosseln.
func TestAnUnrefreshedFahrplanCeilingExpiresOpen(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.ObservePlanLimit(t0, 100)
	// Die Messung wandert weiter, der Deckel nicht.
	late := t0.Add(PlanLimitFreshWindow + time.Second)
	tr.Observe(late, 60, 40, true)
	v := tr.Budget(late, set)
	near(t, "budget", v.Kw, 229.3)
	if v.PlanLimitKw != nil || v.PlanLimitBinds {
		t.Fatalf("ein abgelaufener Deckel wirkt weiter: %+v", v.PlanLimitKw)
	}
}

// TestTheFahrplanLaneNeverTouchesTheBlindStages - ohne Messung gibt es keinen
// Fahrplan-Deckel, egal was der Plan sagt: die statischen und blinden Zweige
// sind per Konstruktion unberührt.
func TestTheFahrplanLaneNeverTouchesTheBlindStages(t *testing.T) {
	set := dynSite()

	// (a) nie gemessen -> das hinterlegte Budget, unverändert.
	tr := NewBudgetTracker()
	tr.ObservePlanLimit(t0, 10) // ein sehr enger Deckel
	v := tr.Budget(t0, set)
	if v.Mode != BudgetStatic {
		t.Fatalf("mode = %q, want %q", v.Mode, BudgetStatic)
	}
	if v.Kw != set.BudgetKw() {
		t.Fatalf("statisches Budget = %v, want %v - der Fahrplan hat einen blinden Zweig angefasst", v.Kw, set.BudgetKw())
	}
	if v.PlanLimitKw != nil {
		t.Fatalf("ein blinder Zweig meldet einen Fahrplan-Deckel: %+v", v.PlanLimitKw)
	}

	// (b) Messung vorhanden, aber veraltet -> gehalten, ohne Deckel.
	tr2 := NewBudgetTracker()
	tr2.Observe(t0, 60, 40, true)
	_ = tr2.Budget(t0, set) // arms t.cur
	stale := t0.Add(BudgetFreshWindow + 10*time.Second)
	tr2.ObservePlanLimit(stale, 10)
	v2 := tr2.Budget(stale, set)
	if v2.Mode != BudgetHolding {
		t.Fatalf("mode = %q, want %q", v2.Mode, BudgetHolding)
	}
	near(t, "gehalten", v2.Kw, 229.3)
	if v2.PlanLimitBinds {
		t.Fatalf("der Fahrplan deckelt einen blinden Zweig (%s)", v2.Reason)
	}
}

// TestAnAlreadyOverrunQuarterPausesRatherThanGoesNegative - der Deckel wird nie
// negativ: ist die Viertelstunde schon vergeben, bleibt 0, nicht weniger.
func TestAnAlreadyOverrunQuarterPausesRatherThanGoesNegative(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 60, 40, true) // Rest 20 kW
	tr.ObservePlanLimit(t0, 5)   // der Standort darf nur noch 5 kW ziehen
	v := tr.Budget(t0, set)
	if v.Kw != 0 {
		t.Fatalf("budget = %v, want 0 (der Rest des Standorts nimmt den Deckel schon ganz)", v.Kw)
	}
	if !v.PlanLimitBinds || v.PlanLimitKw == nil || *v.PlanLimitKw != 0 {
		t.Fatalf("der Deckel meldet %v, want 0 - und er muss binden", v.PlanLimitKw)
	}
}

// TestAGarbageFahrplanCeilingFailsOpen - unlesbar ist wie „kein Plan", nie wie
// „null Kilowatt": eine kaputte Zahl darf keine Anlage stilllegen.
func TestAGarbageFahrplanCeilingFailsOpen(t *testing.T) {
	set := dynSite()
	for _, bad := range []float64{negInf(), nan(), -1} {
		tr := NewBudgetTracker()
		tr.Observe(t0, 60, 40, true)
		tr.ObservePlanLimit(t0, bad)
		v := tr.Budget(t0, set)
		near(t, "budget", v.Kw, 229.3)
		if v.PlanLimitKw != nil {
			t.Fatalf("%v hat einen Deckel erzeugt: %+v", bad, v.PlanLimitKw)
		}
	}
}

func nan() float64    { return math.NaN() }
func negInf() float64 { return math.Inf(-1) }
