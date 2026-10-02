package ladepunktsim

import (
	"math"
	"reflect"
	"testing"
	"time"
)

// TestV2HAbend is the MP-34 evidence (Bauplan § 8 Prüfnachweis „Simulator-
// Szenario V2H-Abend“) with its numbers. Every expected value is recomputed
// from the scenario's stated inputs, not copied from a run:
//
//	evening: 12 kWh above the reserve (60 → 40 % of 60 kWh) leave the battery,
//	         12·√0,85 = 11.063 kWh reach the house as Erzeugung im Ladepunkt;
//	         the house draws 2.5 + 2·3.5 = 9.5 kWh until 21:00, the remaining
//	         1.563 kWh at 2.0 kW last 46.9 min → reserve at 21:46:54;
//	night:   24 kWh into the battery (40 → 80 %) are 24/√0,85 = 26.032 kWh
//	         Verbrauch im Ladepunkt, at 11 kW 2 h 22 min from 01:00;
//	grid:    house 17.625 kWh (18:00–07:15) − 11.063 + 26.032 = 32.593 kWh
//	         Netzbezug, no Netzeinspeisung at all (V2H).
func TestV2HAbend(t *testing.T) {
	lauf := V2HAbend()
	erg, err := lauf.Fahren()
	if err != nil {
		t.Fatal(err)
	}
	eta := math.Sqrt(0.85)
	wantZ2E := 12 * eta
	wantZ2V := 24 / eta
	z2v, z2e, z1nb, z1ne := erg.Summe()
	nah(t, "Σ Z2E (Erzeugung im Ladepunkt)", z2e, wantZ2E)
	nah(t, "Σ Z2V (Verbrauch im Ladepunkt)", z2v, wantZ2V)
	nah(t, "Σ Z1NB (Netzbezug)", z1nb, 17.625-wantZ2E+wantZ2V)
	nah(t, "Σ Z1NE (Netzeinspeisung)", z1ne, 0)
	t.Logf("V2H-Abend: Z2E %.3f kWh, Z2V %.3f kWh, Z1NB %.3f kWh, Z1NE %.3f kWh", z2e, z2v, z1nb, z1ne)

	// 13 h 15 min in quarter-hours; the registers agree with the sums.
	if n := len(erg.Viertelstunden); n != 53 {
		t.Fatalf("%d Viertelstunden, erwartet 53", n)
	}
	nah(t, "Register Z2E", erg.Ende.ZaehlerErzeugungKwh, wantZ2E)
	nah(t, "Register Z2V", erg.Ende.ZaehlerVerbrauchKwh, wantZ2V)

	ort := lauf.Start.Location()
	at := func(d, h, m int) time.Time { return time.Date(2026, 10, d, h, m, 0, 0, ort) }
	viertel := map[time.Time]Viertelstunde{}
	for _, q := range erg.Viertelstunden {
		viertel[q.Von] = q
	}
	// The house is covered entirely by the car until the reserve.
	for _, c := range []struct {
		von            time.Time
		z2e, z2v, z1nb float64
		soc            float64
	}{
		{at(1, 18, 0), 0.625, 0, 0, 60 - 0.625/eta/60*100},
		{at(1, 19, 30), 0.875, 0, 0, math.NaN()},
		{at(1, 21, 30), 0.5, 0, 0, math.NaN()},
		// 21:45–22:00: 1.563 − 0.5·3 … the car still delivers until 21:46:54.
		{at(1, 21, 45), wantZ2E - 9.5 - 1.5, 0, 0.5 - (wantZ2E - 11), 40},
		{at(1, 22, 0), 0, 0, 0.5, 40},
		{at(2, 0, 45), 0, 0, 0.125, 40},
		{at(2, 1, 0), 0, 2.75, 2.875, 40 + 2.75*eta/60*100},
		{at(2, 6, 45), 0, 0, 0.125, 80},
	} {
		q, ok := viertel[c.von]
		if !ok {
			t.Fatalf("Viertelstunde %s fehlt", c.von)
		}
		nah(t, "Z2E¼ "+c.von.Format("15:04"), q.Z2E, c.z2e)
		nah(t, "Z2V¼ "+c.von.Format("15:04"), q.Z2V, c.z2v)
		nah(t, "Z1NB¼ "+c.von.Format("15:04"), q.Z1NB, c.z1nb)
		if q.Z1NE != 0 {
			t.Fatalf("Z1NE¼ %s = %v", c.von.Format("15:04"), q.Z1NE)
		}
		if !math.IsNaN(c.soc) {
			nah(t, "SoC "+c.von.Format("15:04"), *q.SocPct, c.soc)
		}
	}
	// Feed-back exactly in 16 quarters (18:00 … 21:45), charging in 10
	// (01:00 … 03:15, the last one partial).
	var mitE, mitV int
	for _, q := range erg.Viertelstunden {
		if q.Z2E > 0 {
			mitE++
		}
		if q.Z2V > 0 {
			mitV++
		}
	}
	if mitE != 16 || mitV != 10 {
		t.Fatalf("Viertelstunden mit Erzeugung %d (16), mit Verbrauch %d (10)", mitE, mitV)
	}
	// The reserve is reached in the minute 21:46–21:47, the target in 03:21–03:22.
	var reserve, ziel time.Time
	for _, s := range erg.Schritte {
		if s.Grund == GrundMindestSoc && reserve.IsZero() {
			reserve = s.Von
		}
		if s.Grund == GrundZielErreicht && ziel.IsZero() {
			ziel = s.Von
		}
	}
	if !reserve.Equal(at(1, 21, 46)) || !ziel.Equal(at(2, 3, 21)) {
		t.Fatalf("Reserve erreicht %s (21:46), Ziel erreicht %s (03:21)", reserve.Format("15:04"), ziel.Format("15:04"))
	}
	// Departure at 07:00 on target; the last quarter has no vehicle and
	// therefore no SoC (unknown, not 0).
	if len(erg.Abfahrten) != 1 {
		t.Fatalf("Abfahrten %+v", erg.Abfahrten)
	}
	ab := erg.Abfahrten[0]
	if !ab.Zeit.Equal(at(2, 7, 0)) || !ab.Erreicht || ab.ZielPct != 80 {
		t.Fatalf("Abfahrt %+v", ab)
	}
	nah(t, "SoC bei Abfahrt", ab.SocPct, 80)
	if last := erg.Viertelstunden[52]; last.SocPct != nil || last.Z2V != 0 || last.Z2E != 0 {
		t.Fatalf("07:00–07:15 ohne Fahrzeug: %+v", last)
	}
}

// Same inputs, same result - to the bit.
func TestV2HAbendWiederholbar(t *testing.T) {
	a, err := V2HAbend().Fahren()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := V2HAbend().Fahren()
	if !reflect.DeepEqual(a, b) {
		t.Fatal("zwei Läufe weichen ab")
	}
}

// The same evening with a V2G box: the car pushes its 10 kW regardless of the
// house, the surplus is Netzeinspeisung; it reaches the reserve sooner. The
// V2H box never feeds back in a minute in which the site feeds the grid
// (A1 S. 27 Fn. 22).
func TestV2GSpeistInsNetzV2HNie(t *testing.T) {
	v2h, err := V2HAbend().Fahren()
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range v2h.Viertelstunden {
		if q.Z2E > 0 && q.Z1NE > 0 {
			t.Fatalf("V2H: Erzeugung im Ladepunkt bei Netzeinspeisung: %+v", q)
		}
	}
	lauf := V2HAbend()
	lauf.Faehigkeit.V2G = true
	v2g, err := lauf.Fahren()
	if err != nil {
		t.Fatal(err)
	}
	_, z2e, _, z1ne := v2g.Summe()
	nah(t, "Σ Z2E V2G", z2e, 12*math.Sqrt(0.85))
	// 10 kW for 66.4 min minus the house (2.5, after 19:00 3.5 kW) → 8.155 kWh.
	if z1ne < 8 || z1ne > 8.5 {
		t.Fatalf("Σ Z1NE V2G = %.3f, erwartet ≈ 8,155", z1ne)
	}
	if q := v2g.Viertelstunden[0]; math.Abs(q.Z1NE-1.875) > 1e-6 || q.Z1NB != 0 {
		t.Fatalf("18:00¼ V2G: %+v", q)
	}
}

// A car that charged elsewhere brings energy along: feeding back without
// charging here makes Erzeugung > Verbrauch at Z2 - the „Fremdtankstrom“ of
// A1 S. 16, Abschn. 2.1.6, (12) = MAX[(6) − (5) ; 0] (A1 S. 35). The
// simulator only produces the registers; the formula is MP-32's.
func TestFremdtankstromWirdSichtbar(t *testing.T) {
	lauf := V2HAbend()
	a := lauf.Anwesenheiten[0]
	a.Fahrzeug.SocPct = 80
	a.Abfahrt = time.Date(2026, 10, 1, 23, 0, 0, 0, lauf.Start.Location())
	lauf.Anwesenheiten = []Anwesenheit{a}
	erg, err := lauf.Fahren()
	if err != nil {
		t.Fatal(err)
	}
	z2v, z2e, _, _ := erg.Summe()
	if z2v != 0 {
		t.Fatalf("Z2V = %v", z2v)
	}
	// The house takes 13.5 kWh until 23:00; the car has 24 kWh above the reserve.
	nah(t, "Σ Z2E", z2e, 13.5)
	if f12 := math.Max(z2e-z2v, 0); f12 <= 0 {
		t.Fatal("(12) wäre 0")
	}
	if ab := erg.Abfahrten[0]; ab.Erreicht {
		t.Fatalf("Abfahrt %+v: Ziel 80 %% verfehlt, aber erreicht gemeldet", ab)
	}
}

func TestLaufPrueftSeineForm(t *testing.T) {
	kaputt := []func(*Lauf){
		func(l *Lauf) { l.Takt = 7 * time.Minute },
		func(l *Lauf) { l.Start = l.Start.Add(time.Minute) },
		func(l *Lauf) { l.Ende = l.Start },
		func(l *Lauf) { l.Regler = nil },
		func(l *Lauf) { l.Anwesenheiten[0].Abfahrt = l.Anwesenheiten[0].Ankunft },
		func(l *Lauf) { l.Anwesenheiten = append(l.Anwesenheiten, l.Anwesenheiten[0]) },
		func(l *Lauf) { l.Faehigkeit.RueckspeiseleistungKw = 0 },
	}
	for i, f := range kaputt {
		l := V2HAbend()
		l.Anwesenheiten = append([]Anwesenheit(nil), l.Anwesenheiten...)
		f(&l)
		if _, err := l.Fahren(); err == nil {
			t.Errorf("Fall %d angenommen", i)
		}
	}
}
