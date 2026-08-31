package lastmgmt

import (
	"testing"
	"time"
)

// Verbrauchsmanagement v1 / P5: die QUELLE je Säule und der DECKEL des
// Arbiters. Beides ist RESTRICT-ONLY - der physische Verteiler bleibt der
// Verteiler.

// srcSess ist eine Sitzung mit eigener Quellen-Wahl.
func srcSess(key string, maxKw float64, since time.Duration, source SurplusPolicy) Session {
	s := sess(key, maxKw, since)
	s.Source = source
	return s
}

// TestAStationsOwnSourceOverridesTheSiteInBothDirections.
func TestAStationsOwnSourceOverridesTheSiteInBothDirections(t *testing.T) {
	// Der Standort steht auf „Nur Sonnenstrom", die Sonne gibt 40 kW her.
	// „chef" hat sich ausdrücklich für „Schnell laden" entschieden.
	p := Decide(Input{
		Settings:       site(0),
		Sessions:       []Session{srcSess("chef#1", 50, 0, PolicyFast), sess("hof#1", 50, time.Minute)},
		SourceBudgetKw: kwp(40),
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	near(t, "chef (eigene Quelle: schnell)", alloc(t, p, "chef#1").Kw, 50)
	near(t, "hof (folgt dem Standort)", alloc(t, p, "hof#1").Kw, 40)

	// Umgekehrt: der Standort lädt „schnell", EINE Säule steht auf „Nur
	// Sonnenstrom" - und ohne Überschuss pausiert genau sie.
	p = Decide(Input{
		Settings:       site(0),
		Sessions:       []Session{srcSess("sonne#1", 50, 0, PolicySolarOnly), sess("hof#1", 50, time.Minute)},
		SourceBudgetKw: kwp(0),
		Policy:         PolicyFast,
		Now:            base,
	})
	if a := alloc(t, p, "sonne#1"); a.Kw != 0 || a.Reason != ReasonNoSurplus {
		t.Fatalf("die Sonnen-Säule muss ohne Überschuss pausieren: %+v", a)
	}
	near(t, "die Nachbarin bleibt bei der Wahl der Anlage", alloc(t, p, "hof#1").Kw, 50)
}

// TestALaneWithoutAPolicyStillBindsEverybody ist die Kompatibilitäts-Zusage
// für jeden Aufrufer VOR P5: wer eine Bahn öffnet, ohne eine Politik zu
// nennen, hat über die Zugehörigkeit nichts gesagt - also folgen ihr alle.
func TestALaneWithoutAPolicyStillBindsEverybody(t *testing.T) {
	p := Decide(Input{
		Settings:       site(0),
		Sessions:       []Session{sess("a#1", 50, 0), sess("b#1", 50, time.Minute)},
		SourceBudgetKw: kwp(60),
		Now:            base,
	})
	near(t, "die Bahn bindet", alloc(t, p, "a#1").Kw+alloc(t, p, "b#1").Kw, 60)
}

// TestTheHoldersCapOnlyEverNarrows: der Deckel der K3-Brücke.
func TestTheHoldersCapOnlyEverNarrows(t *testing.T) {
	capped := sess("a#1", 50, 0)
	capped.CapKw = kwp(12)
	// Ein Deckel ÜBER der Steckdose ist keine Anhebung.
	wide := sess("b#1", 22, time.Minute)
	wide.CapKw = kwp(400)

	p := Decide(Input{Settings: site(0), Sessions: []Session{capped, wide}, Now: base})
	near(t, "gedeckelt", alloc(t, p, "a#1").Kw, 12)
	near(t, "ein zu weiter Deckel hebt nichts an", alloc(t, p, "b#1").Kw, 22)
}

// TestACapOfZeroPausesWithItsOwnReason - „es hält etwas", nie „es fehlt
// Leistung": der Kunde muss den HEBEL erkennen können.
func TestACapOfZeroPausesWithItsOwnReason(t *testing.T) {
	byPlan := sess("plan#1", 50, 0)
	byPlan.CapKw = kwp(0)
	byPlan.CapReason = ReasonPlan
	byRule := sess("regel#1", 50, time.Minute)
	byRule.CapKw = kwp(0)
	// Ohne Wort fällt es auf „regel" zurück - eine Pause OHNE Grund gibt es
	// auf dieser Fläche nicht.
	free := sess("frei#1", 50, 2*time.Minute)

	p := Decide(Input{Settings: site(0), Sessions: []Session{byPlan, byRule, free}, Now: base})
	if a := alloc(t, p, "plan#1"); a.Kw != 0 || a.Reason != ReasonPlan {
		t.Fatalf("Plan-Pause: %+v", a)
	}
	if a := alloc(t, p, "regel#1"); a.Kw != 0 || a.Reason != ReasonRule {
		t.Fatalf("Regel-Pause: %+v", a)
	}
	near(t, "die ungedeckelte Sitzung ist unberührt", alloc(t, p, "frei#1").Kw, 50)
	if TextFor(ReasonPlan, "") == TextFor(ReasonRule, "") {
		t.Fatal("Plan und Regel schicken den Kunden an zwei Orte - zwei Sätze")
	}
}

// TestAnExemptSessionIsStillBoundByThePhysics ist die tragende Zusage der
// K3-Brücke: befreit ist befreit von der ÖKONOMIE, nie von der PHYSIK.
func TestAnExemptSessionIsStillBoundByThePhysics(t *testing.T) {
	free := sess("plan#1", 400, 0)
	free.SourceExempt = true
	p := Decide(Input{
		Settings:       site(167), // 82,3 kW Budget
		Sessions:       []Session{free},
		SourceBudgetKw: kwp(0),
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	got := alloc(t, p, "plan#1").Kw
	if got <= 0 {
		t.Fatalf("die Befreiung muss die Quellen-Bahn aufheben, got %v", got)
	}
	if got > 82.4 {
		t.Fatalf("aber NIE die Anschlussgrenze: %v kW", got)
	}
}
