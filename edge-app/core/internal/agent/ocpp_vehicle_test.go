package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// Fahrzeug-Profile (Verbrauchsmanagement v1 / P7), gemessen an der SITZUNG.
//
// Die Zusage, an der alles hängt: das Profil ersetzt die Quelle DIESER Sitzung
// und sonst nichts. Jede physische Grenze und jede Regel des Verteilers liest
// danach weiter die Sitzung - dass die Quelle aus einer Karte statt aus einer
// Säule kommt, ist ihnen nicht anzusehen.

const (
	tagDienst = "tagref_1f2e3d4c5b6a798877665544"
	tagPrivat = "tagref_00112233445566778899aabb"
)

// stationWithCards ist der Live-Fall: EINE Säule auf „Nur Sonnenstrom", zwei
// Stecker, an jedem eine andere Karte.
func stationWithCards(a, b string) csms.Snapshot {
	started := time.Date(2026, 8, 31, 9, 0, 0, 0, time.UTC)
	return csms.Snapshot{Enabled: true, Chargers: []csms.ChargerState{{
		Charger:   csms.Charger{ID: "SAEULE-HOF", RatedKw: 22, Source: "nur_sonne"},
		Connected: true,
		Connectors: []csms.Connector{
			{ID: 1, Status: csms.StatusCharging,
				Session: &csms.Session{TransactionID: 11, StartedAt: started, TagRef: a}},
			{ID: 2, Status: csms.StatusCharging,
				Session: &csms.Session{TransactionID: 12, StartedAt: started, TagRef: b}},
		},
	}}}
}

func sessionByKey(t *testing.T, list []lastmgmt.Session, key string) lastmgmt.Session {
	t.Helper()
	for _, s := range list {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("keine Sitzung %q in %+v", key, list)
	return lastmgmt.Session{}
}

// Der Fall des Auftrags: zwei Karten an DERSELBEN Säule, zwei verschiedene
// Steuerarten. Ohne P7 fuhren beide die Bahn der Säule.
func TestTwoCardsAtOneStationFollowTheirOwnLanes(t *testing.T) {
	sessions, byKey := ocppSessions(stationWithCards(tagDienst, tagPrivat), 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(sessions, byKey, []lastmgmt.VehicleProfile{
		{TagRef: tagDienst, Name: "Dienstwagen", Source: lastmgmt.PolicyFast},
		{TagRef: tagPrivat, Name: "Privatwagen", Source: lastmgmt.PolicySolarFirst, MinKw: 4.2},
	})

	dienst := sessionByKey(t, sessions, "SAEULE-HOF#1")
	if dienst.Source != lastmgmt.PolicyFast {
		t.Fatalf("der Dienstwagen muss die Bahn seiner Karte fahren: %+v", dienst)
	}
	privat := sessionByKey(t, sessions, "SAEULE-HOF#2")
	if privat.Source != lastmgmt.PolicySolarFirst || privat.MinKw != 4.2 {
		t.Fatalf("der Privatwagen muss die Bahn seiner Karte fahren: %+v", privat)
	}
	// Und die Wirkung, um die es geht: der Dienstwagen zieht aus dem
	// PHYSISCHEN Topf, der Privatwagen bleibt an der Sonne gebunden.
	set := lastmgmt.Settings{GridLimitKw: 32, MinPowerKw: 1}.WithDefaults()
	budget, source := 22.0, 0.0
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: set, Sessions: sessions, BudgetKw: &budget, SourceBudgetKw: &source,
		Policy: lastmgmt.PolicySolarOnly, Now: time.Now(),
	})
	dienstAlloc, _ := plan.Get("SAEULE-HOF#1")
	if dienstAlloc.Kw <= 0 {
		t.Fatalf("der Dienstwagen muss trotz fehlender Sonne laden: %+v", plan.Allocations)
	}
	privatAlloc, _ := plan.Get("SAEULE-HOF#2")
	if privatAlloc.Kw > 0 {
		t.Fatalf("der Privatwagen darf ohne Sonne nicht laden: %+v", plan.Allocations)
	}
}

// Eine Karte OHNE Profil behält die Bahn ihrer Säule - es gibt kein
// Vorgabe-Fahrzeug, und eines zu erfinden hieße, für den Kunden zu
// entscheiden.
func TestACardWithoutAProfileKeepsTheStationsLane(t *testing.T) {
	sessions, byKey := ocppSessions(stationWithCards(tagDienst, "tagref_ffffffffffffffffffffffff"), 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(sessions, byKey, []lastmgmt.VehicleProfile{
		{TagRef: tagDienst, Source: lastmgmt.PolicyFast},
	})
	if got := sessionByKey(t, sessions, "SAEULE-HOF#2").Source; got != lastmgmt.SurplusPolicy("nur_sonne") {
		t.Fatalf("die fremde Karte muss die Bahn der Säule behalten: %q", got)
	}
}

// Ohne Profile ist der Schritt ein NO-OP - Zeichen für Zeichen der Zustand vor
// P7. Das ist die Kompatibilitäts-Zusage: eine Anlage ohne Fahrzeug-Profile
// verhält sich unverändert.
func TestWithoutProfilesNothingChanges(t *testing.T) {
	snap := stationWithCards(tagDienst, tagPrivat)
	vorher, byKey := ocppSessions(snap, 22, lastmgmt.Settings{})
	nachher, _ := ocppSessions(snap, 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(nachher, byKey, nil)
	for i := range vorher {
		if vorher[i] != nachher[i] {
			t.Fatalf("Sitzung %d hat sich geändert: %+v vs %+v", i, vorher[i], nachher[i])
		}
	}
	ocppApplyVehicleProfiles(nachher, byKey, []lastmgmt.VehicleProfile{})
	for i := range vorher {
		if vorher[i] != nachher[i] {
			t.Fatalf("eine leere Liste darf nichts ändern: %+v vs %+v", vorher[i], nachher[i])
		}
	}
}

// Eine Sitzung OHNE Karte (eine Säule, die ohne Tag autorisiert) bekommt nie
// ein Profil - ein Pseudonym des leeren Strings wäre EINE geteilte „Karte" für
// alle tag-losen Ladungen dieser Box.
func TestASessionWithoutACardIsNeverProfiled(t *testing.T) {
	snap := stationWithCards("", "")
	sessions, byKey := ocppSessions(snap, 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(sessions, byKey, []lastmgmt.VehicleProfile{
		{TagRef: "", Source: lastmgmt.PolicyFast},
		{TagRef: tagDienst, Source: lastmgmt.PolicyFast},
	})
	for _, s := range sessions {
		if s.Source != lastmgmt.SurplusPolicy("nur_sonne") {
			t.Fatalf("eine tag-lose Sitzung darf kein Profil bekommen: %+v", s)
		}
	}
}

// Das Profil sagt NUR etwas über die Quelle. Eine Mindestleistung, die es
// nicht nennt, lässt die der Säule stehen - 0 ist „äußert sich nicht".
func TestAProfileWithoutAMinimumLeavesTheStationsFloorAlone(t *testing.T) {
	snap := stationWithCards(tagDienst, tagPrivat)
	snap.Chargers[0].Charger.MinKw = 6
	sessions, byKey := ocppSessions(snap, 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(sessions, byKey, []lastmgmt.VehicleProfile{
		{TagRef: tagDienst, Source: lastmgmt.PolicySolarFirst},
	})
	if got := sessionByKey(t, sessions, "SAEULE-HOF#1").MinKw; got != 6 {
		t.Fatalf("die Mindestleistung der Säule muss stehen bleiben: %v", got)
	}
}

// ⚠ VORRANG: Handeingriff > Profil > Säule. Er ist keine Zusage, sondern die
// Bauform - Boost und K3-Halter greifen NACH dem Profil und heben die
// Quellen-Bahn ohnehin auf.
func TestAnInterventionStillBeatsTheProfile(t *testing.T) {
	sessions, byKey := ocppSessions(stationWithCards(tagDienst, tagPrivat), 22, lastmgmt.Settings{})
	ocppApplyVehicleProfiles(sessions, byKey, []lastmgmt.VehicleProfile{
		{TagRef: tagDienst, Source: lastmgmt.PolicySolarOnly},
	})
	// Der Halter deckelt auf 0 - die Karte wollte laden, der Mensch nicht.
	zero := 0.0
	for i := range sessions {
		if sessions[i].Key == "SAEULE-HOF#1" {
			sessions[i].CapKw = &zero
			sessions[i].CapReason = lastmgmt.ReasonRule
		}
	}
	set := lastmgmt.Settings{GridLimitKw: 32, MinPowerKw: 1}.WithDefaults()
	budget := 22.0
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: set, Sessions: sessions, BudgetKw: &budget,
		Policy: lastmgmt.PolicyFast, Now: time.Now(),
	})
	alloc, _ := plan.Get("SAEULE-HOF#1")
	if alloc.Kw != 0 {
		t.Fatalf("der Handeingriff muss das Profil schlagen: %+v", plan.Allocations)
	}
	if alloc.Reason != lastmgmt.ReasonRule {
		t.Fatalf("und seinen Grund nennen: %+v", alloc)
	}
}
