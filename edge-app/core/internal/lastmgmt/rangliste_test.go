package lastmgmt

import (
	"testing"
	"time"
)

// Verbrauchsmanagement v1 / P6: die RANGLISTE erreicht die Box.
//
// Zwei Zusagen tragen dieses Paket, und beide sind hier festgenagelt:
// ohne einen einzigen Rang ist die Verteilung ZEICHENGLEICH wie vorher, und
// GLEICHE Ränge sind Gleichrangige (sie rotieren, statt einer Reihenfolge zu
// folgen, die niemand gewählt hat).

// rankSess ist eine Sitzung mit einer Rangliste-Position.
func rankSess(key string, maxKw float64, since time.Duration, rank int) Session {
	s := sess(key, maxKw, since)
	s.Rank = rank
	return s
}

// smallSite ist ein Standort, an dem die Leistung wirklich knapp ist: 44 kW
// Anschluss, 10 % Abstand, keine Gebäudereserve, Mindestleistung 11 kW ⇒ ein
// Ladebudget von 39,6 kW, also genau drei von vier 11-kW-Steckern.
func smallSite() Settings {
	return Settings{
		GridLimitKw: 44, MarginPct: 10, MinPowerKw: 11,
		RotationPeriod: 15 * time.Minute,
	}.WithDefaults()
}

// TestWithoutASingleRankTheAllocationIsByteForBytePreP6 ist die
// Kompatibilitäts-Zusage des ganzen Pakets - die Pflicht-Prüfung des Auftrags.
//
// ⚠ Der VORRANG-Satz behält seine Ankunftsreihenfolge und ROTIERT NICHT; der
// unbenannte Rest rotiert. Damit das etwas beweist, ist der Vorrang-Satz hier
// ÜBERZEICHNET (drei Säulen, von denen bei 20 kW Mindestleistung nur eine ins
// Budget passt): rotierte er, käme über die Epochen hinweg eine ANDERE dran -
// genau das darf nicht passieren.
func TestWithoutASingleRankTheAllocationIsByteForBytePreP6(t *testing.T) {
	set := Settings{
		GridLimitKw: 44, MarginPct: 10, MinPowerKw: 20,
		RotationPeriod: 15 * time.Minute,
	}.WithDefaults()
	var sessions []Session
	for i, key := range []string{"vorrang-a#1", "vorrang-b#1", "vorrang-c#1"} {
		s := sess(key, 20, time.Duration(i)*time.Minute)
		s.Priority = true
		sessions = append(sessions, s)
	}
	sessions = append(sessions,
		sess("rest-a#1", 20, 10*time.Minute),
		sess("rest-b#1", 20, 11*time.Minute))

	rest := map[string]bool{}
	for i := 0; i < 4; i++ {
		p := Decide(Input{Settings: set, Sessions: sessions,
			Now: base.Add(time.Duration(i) * 15 * time.Minute)})
		// Der Vorrang-Satz: IMMER dieselbe, zuerst angekommene Säule.
		near(t, "die erste Vorrang-Säule bleibt bedient", alloc(t, p, "vorrang-a#1").Kw, 20)
		for _, key := range []string{"vorrang-b#1", "vorrang-c#1"} {
			if a := alloc(t, p, key); !a.Paused {
				t.Fatalf("Epoche %d: %q darf nicht drankommen - der Vorrang-Satz rotiert nicht (%+v)", i, key, a)
			}
		}
		// ⚠ Und der Vorrang-Satz frisst hier das GANZE Budget, also darf auch
		// keine der beiden Rest-Säulen laden - aber die Rotation muss sie
		// weiterhin durchreichen, sobald es etwas zu verteilen gibt.
		for _, a := range p.Allocations {
			if !a.Paused && a.Key != "vorrang-a#1" {
				t.Fatalf("Epoche %d: unerwartet bedient: %+v", i, a)
			}
		}
		if p.AllocatedKw > 39.6+1e-9 {
			t.Fatalf("Budget überschritten: %v", p.AllocatedKw)
		}
	}

	// Die Gegenprobe zur ROTATION des unbenannten Rests: ohne Vorrang-Satz
	// wechseln sich die zwei ab - das ist das Verhalten, das erhalten bleibt.
	tail := []Session{sess("rest-a#1", 20, 0), sess("rest-b#1", 20, time.Minute)}
	for i := 0; i < 2; i++ {
		p := Decide(Input{Settings: set, Sessions: tail,
			Now: base.Add(time.Duration(i) * 15 * time.Minute)})
		for _, a := range p.Allocations {
			if !a.Paused {
				rest[a.Key] = true
			}
		}
	}
	if len(rest) != 2 {
		t.Fatalf("der unbenannte Rest muss weiterhin rotieren, bedient wurden: %v", rest)
	}
}

// TestARankIsServedBeforeAnUnrankedStation: eine eingeordnete Säule steht vor
// jeder, die der Kunde nicht eingeordnet hat.
func TestARankIsServedBeforeAnUnrankedStation(t *testing.T) {
	p := Decide(Input{
		Settings: smallSite(),
		Sessions: []Session{
			// Ankunftsreihenfolge SPRICHT GEGEN den Rang - genau das prüft der Fall.
			sess("ohne#1", 11, 0),
			sess("ohne#2", 11, time.Minute),
			sess("ohne#3", 11, 2*time.Minute),
			rankSess("gewaehlt#1", 11, 3*time.Minute, 1),
		},
		Now: base,
	})
	near(t, "die eingeordnete Säule wird bedient", alloc(t, p, "gewaehlt#1").Kw, 11)
	waiting := 0
	for _, a := range p.Allocations {
		if a.Paused {
			waiting++
		}
	}
	if waiting != 1 {
		t.Fatalf("genau eine Säule muss warten, nicht %d: %+v", waiting, p.Allocations)
	}
}

// TestEqualRanksRotateAmongThemselves: die Säulen, die der Kunde nebeneinander
// stehen lässt, bekommen DIESELBE Zahl - und die Box wechselt zwischen ihnen
// weiter ab, statt eine Reihenfolge zu behaupten, die niemand gewählt hat.
func TestEqualRanksRotateAmongThemselves(t *testing.T) {
	sessions := []Session{
		rankSess("a#1", 11, 0, 3),
		rankSess("b#1", 11, time.Minute, 3),
		rankSess("c#1", 11, 2*time.Minute, 3),
		rankSess("d#1", 11, 3*time.Minute, 3),
	}
	served := map[string]bool{}
	for i := 0; i < 4; i++ {
		p := Decide(Input{Settings: smallSite(), Sessions: sessions,
			Now: base.Add(time.Duration(i) * 15 * time.Minute)})
		n := 0
		for _, a := range p.Allocations {
			if !a.Paused {
				served[a.Key] = true
				n++
			}
		}
		if n != 3 {
			t.Fatalf("Epoche %d: %d bedient, erwartet 3", i, n)
		}
	}
	if len(served) != 4 {
		t.Fatalf("über vier Epochen muss jede Säule einmal drankommen, bedient wurden: %v", served)
	}
}

// TestATopRankMakesTheOthersWaitAndTheWaitingOneSaysWhy: der Rang ist ein
// RANG, kein Freibrief - er wird selbst vom Budget gedeckelt, und wer wartet,
// nennt seinen Grund.
func TestATopRankMakesTheOthersWaitAndTheWaitingOneSaysWhy(t *testing.T) {
	p := Decide(Input{
		Settings: smallSite(),
		Sessions: []Session{
			rankSess("gross#1", 39, 0, 1),
			rankSess("klein#1", 11, time.Minute, 2),
		},
		Now: base,
	})
	near(t, "der erste Rang bekommt seine volle Nachfrage", alloc(t, p, "gross#1").Kw, 39)
	a := alloc(t, p, "klein#1")
	if !a.Paused || a.Reason != ReasonBudget {
		t.Fatalf("der zweite Rang muss mit genanntem Grund warten: %+v", a)
	}
	if p.AllocatedKw > 39.6+1e-9 {
		t.Fatalf("das Budget wurde überschritten: %v", p.AllocatedKw)
	}
}

// TestTheLegacyVorrangSetStillOutranksAnExplicitRank: „Vorrang" ist die
// stehende Aussage des Betreibers an der Box; ein Dokument, das nur EINIGE
// Säulen einordnet, darf sie nicht still degradieren.
func TestTheLegacyVorrangSetStillOutranksAnExplicitRank(t *testing.T) {
	prio := sess("vorrang#1", 39, 0)
	prio.Priority = true
	p := Decide(Input{
		Settings: smallSite(),
		Sessions: []Session{rankSess("rang1#1", 39, 0, 1), prio},
		Now:      base,
	})
	near(t, "der Vorrang-Satz zuerst", alloc(t, p, "vorrang#1").Kw, 39)
	if a := alloc(t, p, "rang1#1"); !a.Paused {
		t.Fatalf("Rang 1 muss hinter dem Vorrang-Satz warten: %+v", a)
	}
}

// --- Der SPEICHER-SPLIT ---------------------------------------------------

// TestBeforeStorageFallsBackToTheSitePriority: ohne beide Ränge gibt es keine
// Ordnung zu lesen, und die anlagenweite Wahl entscheidet wie vor P6.
func TestBeforeStorageFallsBackToTheSitePriority(t *testing.T) {
	cases := []struct {
		rank, storage int
		site          StoragePriority
		want          bool
	}{
		{0, 0, CarsBeforeStorage, true},
		{0, 0, StorageBeforeCars, false},
		{2, 0, CarsBeforeStorage, true},  // halbe Ordnung ist keine Ordnung
		{0, 2, StorageBeforeCars, false}, // ebenso andersherum
		{1, 2, StorageBeforeCars, true},  // die Ordnung schlägt die Vorgabe
		{3, 2, CarsBeforeStorage, false}, // und zwar in beide Richtungen
		{2, 2, CarsBeforeStorage, false}, // gleichauf ist NICHT darüber
		{0, 0, "", false},                // unbekanntes Wort ⇒ der Status quo
	}
	for _, c := range cases {
		if got := BeforeStorage(c.rank, c.storage, c.site); got != c.want {
			t.Fatalf("BeforeStorage(%d,%d,%q) = %v, erwartet %v", c.rank, c.storage, c.site, got, c.want)
		}
	}
}

// TestAStationAboveTheStorageReachesPastTheBattery: der Live-Fall des Konzepts
// §5 - eine Säule ÜBER dem Speicher zieht aus dem GANZEN gemessenen Überschuss,
// eine darunter aus dem, was der Speicher übrig lässt.
func TestAStationAboveTheStorageReachesPastTheBattery(t *testing.T) {
	oben := rankSess("oben#1", 22, 0, 1)
	oben.BeforeStorage = true
	unten := rankSess("unten#1", 22, time.Minute, 3)

	// Die Sonne gibt 20 kW her (TotalKw); der Speicher nimmt sich 14 davon, es
	// bleiben 6 für die Fahrzeuge - das ist die site-weite Lesart.
	p := Decide(Input{
		Settings:                   Settings{GridLimitKw: 100, MarginPct: 10, MinPowerKw: 4}.WithDefaults(),
		Sessions:                   []Session{oben, unten},
		SourceBudgetKw:             kwp(6),
		SourceBudgetAboveStorageKw: kwp(20),
		Policy:                     PolicySolarOnly,
		Now:                        base,
	})
	near(t, "die Säule über dem Speicher greift am Speicher vorbei", alloc(t, p, "oben#1").Kw, 20)
	if a := alloc(t, p, "unten#1"); !a.Paused || a.Reason != ReasonNoSurplus {
		t.Fatalf("die Säule unter dem Speicher bekommt nichts mehr: %+v", a)
	}
	// ⚠ Und zusammen nehmen sie nie mehr als den GANZEN Überschuss.
	if p.AllocatedKw > 20+1e-9 {
		t.Fatalf("die Fahrzeuge haben mehr als den ganzen Überschuss genommen: %v", p.AllocatedKw)
	}
}

// TestTheTwoLaneReadingsAreOneQuantity: was die untere Säule zuerst nimmt,
// fehlt der oberen - die zwei Zahlen sind EINE Menge, zweimal gelesen.
func TestTheTwoLaneReadingsAreOneQuantity(t *testing.T) {
	unten := rankSess("unten#1", 22, 0, 1) // frühere Ankunft, aber UNTER dem Speicher
	oben := rankSess("oben#1", 22, time.Minute, 3)
	oben.BeforeStorage = true
	p := Decide(Input{
		Settings:                   Settings{GridLimitKw: 100, MarginPct: 10, MinPowerKw: 4}.WithDefaults(),
		Sessions:                   []Session{unten, oben},
		SourceBudgetKw:             kwp(8),
		SourceBudgetAboveStorageKw: kwp(20),
		Policy:                     PolicySolarOnly,
		Now:                        base,
	})
	near(t, "die untere Säule zuerst (Rang 1)", alloc(t, p, "unten#1").Kw, 8)
	near(t, "der oberen bleibt der Rest des Überschusses", alloc(t, p, "oben#1").Kw, 12)
	near(t, "zusammen genau der ganze Überschuss", p.AllocatedKw, 20)
}

// TestWithoutTheAboveLaneABeforeStorageSessionFollowsTheSiteReading: eine
// ältere Cloud (oder ein Standort ohne Messung) nennt die zweite Zahl nicht -
// dann folgt auch die obere Säule der site-weiten Bahn.
func TestWithoutTheAboveLaneABeforeStorageSessionFollowsTheSiteReading(t *testing.T) {
	oben := sess("oben#1", 22, 0)
	oben.BeforeStorage = true
	p := Decide(Input{
		Settings:       Settings{GridLimitKw: 100, MarginPct: 10, MinPowerKw: 4}.WithDefaults(),
		Sessions:       []Session{oben},
		SourceBudgetKw: kwp(6),
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	near(t, "ohne zweite Zahl gilt die site-weite Bahn", alloc(t, p, "oben#1").Kw, 6)
}

// TestAnAboveLaneNarrowerThanTheSiteLaneIsClamped: dieselbe Menge kann nicht
// VOR dem Speicher kleiner sein als danach - ein Dokument, das das behauptet,
// wird geklemmt statt geglaubt.
func TestAnAboveLaneNarrowerThanTheSiteLaneIsClamped(t *testing.T) {
	oben := sess("oben#1", 22, 0)
	oben.BeforeStorage = true
	p := Decide(Input{
		Settings:                   Settings{GridLimitKw: 100, MarginPct: 10, MinPowerKw: 4}.WithDefaults(),
		Sessions:                   []Session{oben},
		SourceBudgetKw:             kwp(12),
		SourceBudgetAboveStorageKw: kwp(3),
		Policy:                     PolicySolarOnly,
		Now:                        base,
	})
	near(t, "die obere Bahn ist nie enger als die site-weite", alloc(t, p, "oben#1").Kw, 12)
}

// TestAWallboxKeyNeverCollidesWithAStation: der Präfix kann von keiner
// ChargePointId erzeugt werden (die Box lässt „/" in einer Kennung nicht zu).
func TestAWallboxKeyNeverCollidesWithAStation(t *testing.T) {
	key := WallboxKey("11111111-2222-3333-4444-555555555555")
	id, ok := WallboxEntityID(key)
	if !ok || id != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("Rundlauf gebrochen: %q -> %q, %v", key, id, ok)
	}
	if _, ok := WallboxEntityID("saeule-hof-nord#1"); ok {
		t.Fatal("eine OCPP-Kennung darf nie als Wallbox gelesen werden")
	}
	if _, ok := WallboxEntityID(WallboxKeyPrefix); ok {
		t.Fatal("der nackte Präfix ist keine Wallbox")
	}
}
