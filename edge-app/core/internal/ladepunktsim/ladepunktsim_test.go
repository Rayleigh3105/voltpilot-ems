package ladepunktsim

import (
	"math"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 1, 18, 0, 0, 0, time.UTC)

func bidi(v2g bool) Faehigkeit {
	return Faehigkeit{Nutzbarkeit: Bidirektional, V2H: true, V2G: v2g, LadeleistungKw: 11, RueckspeiseleistungKw: 10}
}

func auto(soc float64) Fahrzeug {
	return Fahrzeug{KapazitaetKwh: 60, SocPct: soc, MindestSocPct: 40, AbfahrtSocPct: 80, MaxLadeKw: 11, MaxEntladeKw: 11}
}

func neu(t *testing.T, f Faehigkeit) *Ladepunkt {
	t.Helper()
	lp, err := New(f, t0)
	if err != nil {
		t.Fatal(err)
	}
	return lp
}

func nah(t *testing.T, was string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %.9f, erwartet %.9f", was, got, want)
	}
}

func TestFaehigkeitPruefenWieDasDatenmodell(t *testing.T) {
	for _, c := range []struct {
		name string
		f    Faehigkeit
		ok   bool
	}{
		{"unidirektional", Faehigkeit{Nutzbarkeit: Unidirektional, LadeleistungKw: 11}, true},
		{"unidirektional mit V2H", Faehigkeit{Nutzbarkeit: Unidirektional, V2H: true, LadeleistungKw: 11}, false},
		{"unidirektional mit Rückspeiseleistung", Faehigkeit{Nutzbarkeit: Unidirektional, LadeleistungKw: 11, RueckspeiseleistungKw: 5}, false},
		{"bidirektional ohne V2H/V2G", Faehigkeit{Nutzbarkeit: Bidirektional, LadeleistungKw: 11, RueckspeiseleistungKw: 5}, false},
		{"bidirektional ohne Rückspeiseleistung", Faehigkeit{Nutzbarkeit: Bidirektional, V2H: true, LadeleistungKw: 11}, false},
		{"ohne Ladeleistung", Faehigkeit{Nutzbarkeit: Unidirektional}, false},
		{"Nutzbarkeit unbekannt", Faehigkeit{Nutzbarkeit: "beides", LadeleistungKw: 11}, false},
		{"V2H", bidi(false), true},
		{"V2G", bidi(true), true},
	} {
		if err := c.f.Pruefen(); (err == nil) != c.ok {
			t.Errorf("%s: err=%v, ok erwartet=%v", c.name, err, c.ok)
		}
	}
}

func TestFahrzeugUndBefehlUngueltig(t *testing.T) {
	lp := neu(t, bidi(false))
	for _, v := range []Fahrzeug{
		{SocPct: 50, MaxLadeKw: 11, MaxEntladeKw: 11},
		{KapazitaetKwh: 60, SocPct: 101, MaxLadeKw: 11, MaxEntladeKw: 11},
		{KapazitaetKwh: 60, SocPct: 50, MindestSocPct: 40, AbfahrtSocPct: 30, MaxLadeKw: 11, MaxEntladeKw: 11},
		{KapazitaetKwh: 60, SocPct: 50, MaxLadeKw: 11},
		{KapazitaetKwh: 60, SocPct: 50, MaxLadeKw: 11, MaxEntladeKw: 11, WirkungsgradLaden: 1.2},
	} {
		if err := lp.Anstecken(v); err == nil {
			t.Fatalf("Fahrzeug %+v angenommen", v)
		}
	}
	for _, b := range []Befehl{{Richtung: "rueckwaerts"}, {Richtung: Laden, LeistungKw: -1}, {Richtung: Laden, LeistungKw: 1, BisSocPct: 120}} {
		if err := lp.Befehlen(b); err == nil {
			t.Fatalf("Befehl %+v angenommen", b)
		}
	}
	if err := lp.Anstecken(auto(50)); err != nil {
		t.Fatal(err)
	}
	if err := lp.Anstecken(auto(50)); err == nil {
		t.Fatal("zweites Fahrzeug am selben Stecker angenommen")
	}
	if _, err := lp.Abstecken(); err != nil {
		t.Fatal(err)
	}
	if _, err := lp.Abstecken(); err == nil {
		t.Fatal("Abstecken ohne Fahrzeug angenommen")
	}
}

// A wallbox without feed-back (the whole existing fleet) never produces
// „Erzeugung im Ladepunkt“: the export register stays at 0, a discharge
// command is an honest deviation.
func TestUnidirektionalSpeistNieZurueck(t *testing.T) {
	lp := neu(t, Faehigkeit{Nutzbarkeit: Unidirektional, LadeleistungKw: 11})
	if err := lp.Anstecken(auto(60)); err != nil {
		t.Fatal(err)
	}
	_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10})
	s := lp.Schritt(time.Hour, Umgebung{HauslastKw: 5})
	if s.ErzeugungKwh != 0 || !s.Abweichung || s.Grund != GrundUnidirektional {
		t.Fatalf("Schritt = %+v", s)
	}
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 7})
	s = lp.Schritt(time.Hour, Umgebung{})
	nah(t, "Verbrauch im Ladepunkt", s.VerbrauchKwh, 7)
	m := lp.Messung()
	if m.ZaehlerErzeugungKwh != 0 || m.LeistungRueckspeisungKw != 0 {
		t.Fatalf("Messung = %+v", m)
	}
	nah(t, "SoC", *m.SocPct, 60+7*WirkungsgradJeWeg/60*100)
}

// Unknown is not zero: unplugged, the SoC is absent and a command does
// nothing, saying why.
func TestAbgestecktUnbekanntKeineNull(t *testing.T) {
	lp := neu(t, bidi(false))
	m := lp.Messung()
	if m.Angesteckt || m.SocPct != nil {
		t.Fatalf("ohne Fahrzeug: %+v", m)
	}
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 11})
	s := lp.Schritt(15*time.Minute, Umgebung{})
	if s.VerbrauchKwh != 0 || !s.Abweichung || s.Grund != GrundAbgesteckt {
		t.Fatalf("Schritt = %+v", s)
	}
}

func TestLeistungsgrenzenVonWallboxUndFahrzeug(t *testing.T) {
	lp := neu(t, bidi(true))
	v := auto(60)
	v.MaxLadeKw, v.MaxEntladeKw = 7.4, 22
	_ = lp.Anstecken(v)
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 22})
	s := lp.Schritt(time.Hour, Umgebung{})
	nah(t, "Laden (Fahrzeug 7,4 kW)", s.VerbrauchKwh, 7.4)
	if s.Grund != GrundLeistungsgrenze {
		t.Fatalf("Grund %q", s.Grund)
	}
	_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 22})
	s = lp.Schritt(30*time.Minute, Umgebung{HauslastKw: 1})
	nah(t, "Rückspeisen (Wallbox 10 kW)", s.ErzeugungKwh, 5)
	nah(t, "Power.Active.Export", lp.Messung().LeistungRueckspeisungKw, 10)
	if s.Grund != GrundLeistungsgrenze || lp.Messung().LeistungBezugKw != 0 {
		t.Fatalf("Schritt %+v", s)
	}
}

// The reserve ends the discharge exactly - inside the interval, not at its
// end - and the meter carries only what came out above the reserve.
func TestMindestSocEndetGenau(t *testing.T) {
	lp := neu(t, bidi(true))
	_ = lp.Anstecken(auto(45)) // 5 % über der Reserve = 3 kWh im Akku
	_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10})
	s := lp.Schritt(time.Hour, Umgebung{})
	nah(t, "Erzeugung im Ladepunkt", s.ErzeugungKwh, 3*WirkungsgradJeWeg)
	if s.Grund != GrundMindestSoc || *lp.Messung().SocPct != 40 {
		t.Fatalf("Schritt %+v, SoC %v", s, *lp.Messung().SocPct)
	}
	s = lp.Schritt(time.Hour, Umgebung{})
	if s.ErzeugungKwh != 0 || s.Grund != GrundMindestSoc {
		t.Fatalf("unter der Reserve weiter entladen: %+v", s)
	}
	// BisSocPct above the reserve ends earlier; below it the reserve wins.
	lp2 := neu(t, bidi(true))
	_ = lp2.Anstecken(auto(60))
	_ = lp2.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10, BisSocPct: 50})
	lp2.Schritt(time.Hour, Umgebung{})
	if soc := *lp2.Messung().SocPct; soc != 50 {
		t.Fatalf("bis 50 %%: SoC %v", soc)
	}
	_ = lp2.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10, BisSocPct: 10})
	lp2.Schritt(time.Hour, Umgebung{})
	if soc := *lp2.Messung().SocPct; soc != 40 {
		t.Fatalf("bis 10 %% unter der Reserve 40 %%: SoC %v", soc)
	}
}

func TestLadenEndetAmZielUndBeiVoll(t *testing.T) {
	lp := neu(t, bidi(false))
	_ = lp.Anstecken(auto(70))
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 11, BisSocPct: 80})
	s := lp.Schritt(time.Hour, Umgebung{})
	nah(t, "Verbrauch im Ladepunkt", s.VerbrauchKwh, 6/WirkungsgradJeWeg)
	if s.Grund != GrundZielErreicht || *lp.Messung().SocPct != 80 {
		t.Fatalf("Schritt %+v, SoC %v", s, *lp.Messung().SocPct)
	}
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 11})
	lp.Schritt(3*time.Hour, Umgebung{})
	if soc := *lp.Messung().SocPct; soc != 100 {
		t.Fatalf("voll: SoC %v", soc)
	}
	s = lp.Schritt(time.Hour, Umgebung{})
	if s.VerbrauchKwh != 0 || s.Grund != GrundVoll {
		t.Fatalf("über 100 %% geladen: %+v", s)
	}
	// A target below the current SoC never discharges.
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 11, BisSocPct: 80})
	lp.Schritt(time.Hour, Umgebung{})
	if soc := *lp.Messung().SocPct; soc != 100 {
		t.Fatalf("Ladeziel unter dem Stand hat entladen: SoC %v", soc)
	}
}

// V2H only: the vehicle covers the house's deficit and nothing more - so
// there is never feed-back while the site feeds into the grid (the property
// A1 S. 27 Fn. 22 asks of the „Alternative zur Ausschließlichkeit“). V2G lifts
// the cap.
func TestV2HNurInsHausV2GAuchInsNetz(t *testing.T) {
	for _, c := range []struct {
		u        Umgebung
		v2g      bool
		wantKwh  float64
		wantGrnd string
	}{
		{Umgebung{HauslastKw: 3}, false, 3, GrundNurHaus},
		{Umgebung{HauslastKw: 3, ErzeugungKw: 1}, false, 2, GrundNurHaus},
		{Umgebung{HauslastKw: 1, ErzeugungKw: 4}, false, 0, GrundNurHaus},
		{Umgebung{HauslastKw: 12}, false, 10, ""},
		{Umgebung{HauslastKw: 3}, true, 10, ""},
		{Umgebung{HauslastKw: 1, ErzeugungKw: 4}, true, 10, ""},
	} {
		lp := neu(t, bidi(c.v2g))
		_ = lp.Anstecken(auto(90))
		_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10})
		s := lp.Schritt(time.Hour, c.u)
		nah(t, "Erzeugung im Ladepunkt", s.ErzeugungKwh, c.wantKwh)
		if s.Grund != c.wantGrnd || s.Abweichung != (c.wantGrnd != "") {
			t.Errorf("%+v v2g=%v: Grund %q, erwartet %q", c.u, c.v2g, s.Grund, c.wantGrnd)
		}
	}
}

// Unplugging stops at once and forgets the command: a re-plugged vehicle
// does not resume discharging (MP-39 builds the box side of this).
func TestAbsteckenBrichtAbUndVergisstDenBefehl(t *testing.T) {
	lp := neu(t, bidi(false))
	_ = lp.Anstecken(auto(75))
	_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10})
	lp.Schritt(10*time.Minute, Umgebung{HauslastKw: 6})
	if lp.Messung().LeistungRueckspeisungKw != 6 {
		t.Fatalf("vor dem Abstecken: %+v", lp.Messung())
	}
	weg, err := lp.Abstecken()
	if err != nil {
		t.Fatal(err)
	}
	m := lp.Messung()
	if m.Angesteckt || m.SocPct != nil || m.LeistungRueckspeisungKw != 0 {
		t.Fatalf("nach dem Abstecken: %+v", m)
	}
	nah(t, "SoC bei Abfahrt", weg.SocPct, 75-1/WirkungsgradJeWeg/60*100)
	ab := lp.Abfahrten()
	if len(ab) != 1 || ab[0].Erreicht || ab[0].ZielPct != 80 || !ab[0].Zeit.Equal(t0.Add(10*time.Minute)) {
		t.Fatalf("Abfahrt %+v", ab)
	}
	_ = lp.Anstecken(weg)
	s := lp.Schritt(10*time.Minute, Umgebung{HauslastKw: 6})
	if s.ErzeugungKwh != 0 || s.Befehl.Richtung != Halt {
		t.Fatalf("nach Wiederanstecken weiter entladen: %+v", s)
	}
}

// A full round trip back to the starting SoC reproduces the Festlegung's
// flat efficiency: Z2E / Z2V = (14)A2,A3,A4 = 0,85 (A1 S. 35).
func TestRundlaufErgibtFormel14(t *testing.T) {
	lp := neu(t, bidi(true))
	_ = lp.Anstecken(auto(60))
	_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: 10})
	lp.Schritt(5*time.Hour, Umgebung{})
	_ = lp.Befehlen(Befehl{Richtung: Laden, LeistungKw: 11, BisSocPct: 60})
	lp.Schritt(5*time.Hour, Umgebung{})
	m := lp.Messung()
	if *m.SocPct != 60 {
		t.Fatalf("SoC %v", *m.SocPct)
	}
	nah(t, "Z2E/Z2V", m.ZaehlerErzeugungKwh/m.ZaehlerVerbrauchKwh, 0.85)
	nah(t, "Z2E", m.ZaehlerErzeugungKwh, 12*WirkungsgradJeWeg)
}

// The point is shared between a stepping loop and readers (a later bus
// binding); -race proves the lock.
func TestNebenlaeufigLesenUndSchreiten(t *testing.T) {
	lp := neu(t, bidi(false))
	_ = lp.Anstecken(auto(60))
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			lp.Schritt(time.Minute, Umgebung{HauslastKw: 2})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			_ = lp.Befehlen(Befehl{Richtung: Entladen, LeistungKw: float64(i % 10)})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			_ = lp.Messung()
			_ = lp.Abfahrten()
		}
	}()
	wg.Wait()
}
