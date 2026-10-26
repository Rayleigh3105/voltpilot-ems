package lastmgmt

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// W-11 (Audit vp-ocpp-haushalt-audit, Proben L1/L2): der Haushalt - eine
// 11-kW-Wallbox, dreiphasig, Anschluss 35 kW, „Nur Sonnenstrom", ab Werk KEINE
// Mindestleistung. Die Ladepark-Tests rechnen mit 30 kW Mindestleistung und
// decken diesen Fall nicht ab.

func household() Settings {
	return Settings{
		GridLimitKw: 35, HouseReserveKw: 5, MarginPct: 10,
		MaxHouseLoadKw: 8, RotationPeriod: 15 * time.Minute,
	}.WithDefaults()
}

func garage(floorKw float64) Session {
	return Session{Key: "WALLBOX-GARAGE#1", MaxKw: 11, FloorKw: floorKw, Since: base}
}

func sunOnly(s Session, surplusKw float64, now time.Time, prev *Plan) Plan {
	return Decide(Input{
		Settings: household(), Sessions: []Session{s},
		SourceBudgetKw: kwp(surplusKw), Policy: PolicySolarOnly,
		Previous: prev, Now: now,
	})
}

func TestChargeFloorIsSixAmpsOnEveryPhase(t *testing.T) {
	for _, tc := range []struct {
		phases int
		volts  float64
		want   float64
	}{{3, 0, 4.14}, {1, 0, 1.38}, {2, 230, 2.76}, {3, 240, 4.32}, {0, 230, 0}} {
		if got := ChargeFloorKw(tc.phases, tc.volts); got != tc.want {
			t.Fatalf("%d Phasen, %v V: %v kW, erwartet %v", tc.phases, tc.volts, got, tc.want)
		}
	}
}

// L1: 2 kW Sonnenüberschuss an einer dreiphasigen Wallbox. Vorher gab die Box
// „2 kW" vor und meldete „lädt" - die Wallbox lädt darunter aber nicht (oder
// nimmt 6 A und den Rest aus dem Netz). Jetzt wartet sie und sagt, was sie
// braucht.
func TestL1AHouseholdWallboxNeverGetsALimitBelowItsFloor(t *testing.T) {
	before := alloc(t, sunOnly(garage(0), 2, base, nil), "WALLBOX-GARAGE#1")
	t.Logf("L1 vorher  FloorKw=0    surplus=2.0 -> alloc=%.2f kW paused=%v reason=%s", before.Kw, before.Paused, before.Reason)
	if before.Paused || before.Kw != 2 {
		t.Fatalf("Gegenprobe: ohne Untergrenze teilt die Box 2 kW zu, war %+v", before)
	}

	a := alloc(t, sunOnly(garage(ChargeFloorKw(3, 0)), 2, base, nil), "WALLBOX-GARAGE#1")
	t.Logf("L1 nachher FloorKw=4.14 surplus=2.0 -> alloc=%.2f kW paused=%v reason=%s need=%.2f", a.Kw, a.Paused, a.Reason, a.NeedKw)
	if !a.Paused || a.Kw != 0 || a.Reason != ReasonNoSurplus {
		t.Fatalf("unter der Untergrenze wird pausiert, nie eine Grenze unter 6 A vorgegeben: %+v", a)
	}
	if a.NeedKw != 4.14 {
		t.Fatalf("der Grund nennt den Bedarf 4,14 kW, war %v", a.NeedKw)
	}
	want := "wartet — für die Wallbox reicht die Sonne gerade nicht (braucht 4,1 kW)"
	if got := AllocationText(a, PolicySolarOnly); got != want {
		t.Fatalf("Satz = %q, erwartet %q", got, want)
	}

	// Reicht die Sonne, lädt sie - einphasig schon ab 1,38 kW.
	if a := alloc(t, sunOnly(garage(ChargeFloorKw(3, 0)), 5, base, nil), "WALLBOX-GARAGE#1"); a.Paused || a.Kw != 5 {
		t.Fatalf("5 kW Sonne an 4,14 kW Untergrenze: %+v", a)
	}
	if a := alloc(t, sunOnly(garage(ChargeFloorKw(1, 0)), 2, base, nil), "WALLBOX-GARAGE#1"); a.Paused || a.Kw != 2 {
		t.Fatalf("einphasig lädt 2 kW Sonne: %+v", a)
	}
}

// Ohne jede Sonne bleibt der bisherige Satz: der Hebel ist die eigene Wahl.
func TestWithoutAnySunTheSentenceStaysKeinUeberschuss(t *testing.T) {
	a := alloc(t, sunOnly(garage(ChargeFloorKw(3, 0)), 0, base, nil), "WALLBOX-GARAGE#1")
	if !a.Paused || a.Reason != ReasonNoSurplus || a.NeedKw != 0 {
		t.Fatalf("%+v", a)
	}
	if got := AllocationText(a, PolicySolarOnly); got != "wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)" {
		t.Fatalf("Satz = %q", got)
	}
}

// „Sonne zuerst" hält das Fahrzeug am Leben - jetzt mit der Leistung, bei der
// es wirklich lädt, statt mit 2 kW, die die Wallbox nicht kann.
func TestSonneZuerstGrantsTheRealFloorFromTheGrid(t *testing.T) {
	p := Decide(Input{
		Settings: household(), Sessions: []Session{garage(ChargeFloorKw(3, 0))},
		SourceBudgetKw: kwp(2), Policy: PolicySolarFirst, SourceAllowsMinimum: true, Now: base,
	})
	if a := alloc(t, p, "WALLBOX-GARAGE#1"); a.Paused || a.Kw != 4.14 {
		t.Fatalf("„Sonne zuerst“ lädt mit der Untergrenze: %+v", a)
	}
}

// Eine Grenze unter der Untergrenze ist eine Pause - benannt nach dem, der die
// Grenze setzt, nie ein Wert, den die Säule ohnehin in eine Pause verwandelt.
func TestACapBelowTheFloorPausesUnderItsOwnName(t *testing.T) {
	s := garage(ChargeFloorKw(3, 0))
	s.CapKw, s.CapReason = kwp(2), ReasonPlan
	p := Decide(Input{Settings: household(), Sessions: []Session{s}, Now: base})
	if a := alloc(t, p, s.Key); !a.Paused || a.Reason != ReasonPlan {
		t.Fatalf("Plan-Deckel 2 kW an 4,14 kW Untergrenze: %+v", a)
	}
}

// L2: wechselnde Sonne um die Untergrenze herum, alle 20 Sekunden ein neuer
// Wert. Ohne Dämpfung (das Bild des Audits): an/aus im 20-s-Takt. Mit
// Mindestlauf 5 min und Mindestpause 2 min: jede Ladestrecke dauert mindestens
// 5 min, jede Pause mindestens 2 min.
func TestL2ACloudNoLongerSwitchesTheChargeEvery20Seconds(t *testing.T) {
	s := garage(ChargeFloorKw(3, 0))
	type strecke struct {
		paused   bool
		from, to time.Duration
	}
	run := func(pacing Pacing, log string) []strecke {
		var prev *Plan
		var out []strecke
		for i := 0; i < 45; i++ { // 15 Minuten
			at := time.Duration(i) * 20 * time.Second
			sun := []float64{5, 4, 4.5, 4}[i%4]
			p := Decide(Input{
				Settings: household(), Sessions: []Session{s},
				SourceBudgetKw: kwp(sun), Policy: PolicySolarOnly,
				Pacing: pacing, Previous: prev, Now: base.Add(at),
			})
			a := alloc(t, p, s.Key)
			if i < 4 {
				t.Logf("L2 %s t=%3.0fs surplus=%.1f -> alloc=%.2f paused=%v", log, at.Seconds(), sun, a.Kw, a.Paused)
			}
			if !a.Paused && a.Kw+1e-9 < 4.14 {
				t.Fatalf("t=%v: %v kW unter der Untergrenze", at, a.Kw)
			}
			if n := len(out); n == 0 || out[n-1].paused != a.Paused {
				out = append(out, strecke{paused: a.Paused, from: at})
			}
			out[len(out)-1].to = at + 20*time.Second
			prev = &p
		}
		return out
	}

	ohne := run(Pacing{MinRun: time.Nanosecond, MinPause: time.Nanosecond}, "ohne Dämpfung")
	if len(ohne) < 40 {
		t.Fatalf("Gegenprobe: ohne Dämpfung flattert die Ladung im 20-s-Takt, waren %d Strecken", len(ohne))
	}
	mit := run(Pacing{}, "mit Dämpfung ")
	t.Logf("L2: ohne Dämpfung %d Wechsel in 15 min, mit Mindestlauf/Mindestpause %d", len(ohne)-1, len(mit)-1)
	if len(mit) > 5 {
		t.Fatalf("%d Strecken in 15 Minuten - die Ladung flattert noch: %+v", len(mit), mit)
	}
	for i, st := range mit[:len(mit)-1] { // die letzte Strecke ist noch offen
		d, min := st.to-st.from, DefaultSourceMinRun
		if st.paused {
			min = DefaultSourceMinPause
		}
		if d < min {
			t.Fatalf("Strecke %d (pausiert=%v) dauerte nur %v, mindestens %v: %+v", i, st.paused, d, min, mit)
		}
	}
}

// Der Mindestlauf hält nur gegen die Ökonomie: ein Budget, das das Minimum
// nicht mehr trägt, und ein Handeingriff pausieren SOFORT.
func TestTheMinimumRunNeverHoldsAgainstPhysicsOrAHand(t *testing.T) {
	s := garage(ChargeFloorKw(3, 0))
	start := sunOnly(s, 5, base, nil)
	if a := alloc(t, start, s.Key); a.Paused {
		t.Fatalf("Start: %+v", a)
	}
	// 20 s später: die Sonne fällt UND die Anschlussgrenze trägt nur noch 3 kW.
	p := Decide(Input{
		Settings: household(), Sessions: []Session{s}, BudgetKw: kwp(3),
		SourceBudgetKw: kwp(2), Policy: PolicySolarOnly,
		Previous: &start, Now: base.Add(20 * time.Second),
	})
	if a := alloc(t, p, s.Key); !a.Paused || a.Reason != ReasonBelowMinimum {
		t.Fatalf("das Budget unter der Untergrenze pausiert sofort: %+v", a)
	}
	hand := s
	hand.PauseUntil = base.Add(time.Hour)
	p = Decide(Input{
		Settings: household(), Sessions: []Session{hand},
		SourceBudgetKw: kwp(2), Policy: PolicySolarOnly,
		Previous: &start, Now: base.Add(20 * time.Second),
	})
	if a := alloc(t, p, s.Key); !a.Paused || a.Reason != ReasonManual {
		t.Fatalf("der Handeingriff pausiert sofort: %+v", a)
	}
}

// Ladepark-Gegenprobe (L5/L7 im Rig): bei 30 kW Mindestleistung ändert die
// Untergrenze nichts - die Verteilung ist Zeichen für Zeichen dieselbe.
func TestTheLadeparkMinimumStaysWhatItWas(t *testing.T) {
	sessions := []Session{sess("a#1", 150, 0), sess("b#1", 150, time.Minute), sess("c#1", 150, 2*time.Minute)}
	withFloor := append([]Session(nil), sessions...)
	for i := range withFloor {
		withFloor[i].FloorKw = ChargeFloorKw(3, 0)
	}
	a := Decide(Input{Settings: site(167), Sessions: sessions, Now: base})
	b := Decide(Input{Settings: site(167), Sessions: withFloor, Now: base})
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("Ladepark verteilt anders:\n%+v\n%+v", a, b)
	}
}

// Die Dämpfung hält nur, was die BAHN geschaltet hat: nach einem Boost pausiert
// „Automatik fortsetzen" ohne Sonne sofort (kein Mindestlauf aus dem Netz), und
// ein Fahrzeug, das nie lief, startet, sobald die Sonne reicht (keine
// Mindestpause).
func TestOnlyTheLanesOwnSwitchingIsHeld(t *testing.T) {
	s := garage(ChargeFloorKw(3, 0))
	boosted := s
	boosted.BoostUntil = base.Add(time.Hour)
	p := sunOnly(boosted, 0, base, nil)
	if a := alloc(t, p, s.Key); a.Paused || !a.HoldUntil.IsZero() {
		t.Fatalf("der Boost lädt und hinterlässt keine Haltezeit: %+v", a)
	}
	after := sunOnly(s, 0, base.Add(20*time.Second), &p)
	if a := alloc(t, after, s.Key); !a.Paused || a.Reason != ReasonNoSurplus {
		t.Fatalf("nach dem Boost ohne Sonne: sofort Pause, war %+v", a)
	}

	blind := sunOnly(s, 0, base, nil) // eingesteckt, noch keine Sonne
	if a := alloc(t, blind, s.Key); !a.Paused || !a.HoldUntil.IsZero() {
		t.Fatalf("eine Pause ohne vorherigen Lauf hält nichts fest: %+v", a)
	}
	sun := sunOnly(s, 6, base.Add(20*time.Second), &blind)
	if a := alloc(t, sun, s.Key); a.Paused || a.Kw != 6 {
		t.Fatalf("die Sonne startet ein Fahrzeug, das nie lief, sofort: %+v", a)
	}
}

// Die geteilten Zustands-Vektoren (`docs/contracts/ocpp-ladezustand-vectors.json`)
// tragen den W-11-Satz, den das Portal 1:1 rendert - dieser Test bindet ihn an
// die Box, `ladepunkte.test.ts` an das Portal.
func TestTheVectorCarriesTheBoxSentence(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "ocpp-ladezustand-vectors.json"))
	if err != nil {
		t.Skipf("Vektoren nicht erreichbar: %v", err)
	}
	var v struct {
		Faelle []struct {
			Name string `json:"name"`
			Edge struct {
				AllocatedKw *float64 `json:"allocated_kw"`
				Reason      string   `json:"reason"`
				ReasonText  string   `json:"reason_text"`
			} `json:"edge"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	a := alloc(t, sunOnly(garage(ChargeFloorKw(3, 0)), 2, base, nil), "WALLBOX-GARAGE#1")
	for _, f := range v.Faelle {
		if f.Name != "wartet_sonne_reicht_nicht" {
			continue
		}
		if f.Edge.Reason != a.Reason || f.Edge.AllocatedKw == nil || *f.Edge.AllocatedKw != a.Kw {
			t.Fatalf("Vektor %+v, Box %+v", f.Edge, a)
		}
		if got := AllocationText(a, PolicySolarOnly); got != f.Edge.ReasonText {
			t.Fatalf("Box-Satz %q, Vektor %q", got, f.Edge.ReasonText)
		}
		return
	}
	t.Fatal("der Vektor-Fall wartet_sonne_reicht_nicht fehlt")
}

// Ohne Messung gibt es keine Sonne zu behaupten: eine blinde Bahn hält keinen
// Mindestlauf, und eine Säule mit Phasenumschaltung hat ihren eigenen
// Taktgeber (sie geht auf eine Phase, statt drei aus dem Netz zu halten).
func TestNoMinimumRunOnABlindLaneOrAPlugWithBands(t *testing.T) {
	s := garage(ChargeFloorKw(3, 0))
	start := sunOnly(s, 5, base, nil)
	blind := Decide(Input{
		Settings: household(), Sessions: []Session{s},
		SourceBudgetKw: kwp(0), Policy: PolicySolarOnly, SourceBlind: true,
		Previous: &start, Now: base.Add(20 * time.Second),
	})
	if a := alloc(t, blind, s.Key); !a.Paused {
		t.Fatalf("eine blinde Bahn hält keinen Mindestlauf: %+v", a)
	}

	banded := s
	banded.Ranges = BandsOf([]PowerRange{{Phases: 1, MinKw: 1.38, MaxKw: 3.68}, {Phases: 3, MinKw: 4.14, MaxKw: 11}})
	start = sunOnly(banded, 5, base, nil)
	if a := alloc(t, start, s.Key); a.Paused || !a.HoldUntil.IsZero() {
		t.Fatalf("eine Säule mit Bändern trägt keine Haltezeit: %+v", a)
	}
}
