package agent

// AP-15 Folge (the finding of PR 1061): PV counted twice on the import side.
// The solar-only clamp of the battery ("nicht aus dem Netz": charge <= own
// measured PV) does not see the charge park - but the park's loop already
// counted a PV surplus at the meter as headroom (rest = meter − charging
// shrinks by it). When the battery then takes "its" PV, the import rises by
// exactly that PV. Played on the plant of bezug_doppelfreigabe_test.go
// (dbLauf: the real ocppBudget and netzladenDeckel, every phase of the two
// ticks), now WITH PV and from the cold start on.

import (
	"math/rand"
	"testing"
	"time"
)

// Box Verwaltung co-controls (PR 1059): share 57 kW, 20 kW of building load
// behind its feeder (declared as ungeregelt_hinter_abgang), 30 kW of PV, six
// vehicles wanting 80 kW, a plan asking 60 kW of the battery. Measured from
// the COLD START on - both loops at 0, the first sample shows the PV surplus
// of 10 kW at the feeder - through a gap of 60/120/300 s, for every phase of
// the two ticks and both meter cadences: the feeder stays at or below the
// share in every second, and the battery never charges from the grid.
func TestBezugPvDoppeltKaltstartAmEigenenZaehler(t *testing.T) {
	schlimmste, faelle := dbErgebnis{}, 0
	for _, luecke := range []time.Duration{60 * time.Second, 120 * time.Second, 300 * time.Second} {
		for _, takt := range []int{5, 10} {
			for pp := 0; pp < 20; pp++ {
				for sp := 0; sp < 10; sp++ {
					e := dbLauf(t, dbFall{rolle: "steuert_mit", anteilKw: 57, grenzeKw: 100, hausKw: 20, pvKw: 30,
						parkWunschKw: 80, speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp,
						messtakt: takt})
					faelle++
					if e.sekunden > schlimmste.sekunden || e.groessteKw > schlimmste.groessteKw {
						schlimmste = e
					}
					if e.sekunden > 0 {
						t.Errorf("blind %v, meter every %d s, pass :%02d, tick :%02d: %d s above the share, largest +%.3f kW",
							luecke, takt, pp, sp, e.sekunden, e.groessteKw)
					}
					if e.speicherKw > 1e-9 {
						t.Errorf("blind %v, meter every %d s: the co-controlling battery charged %.3f kW from the grid",
							luecke, takt, e.speicherKw)
					}
				}
			}
		}
	}
	t.Logf("%d cases, worst: %d s, +%.3f kW", faelle, schlimmste.sekunden, schlimmste.groessteKw)
}

// The battery still gets the rest at its own meter: the vehicles want 45 kW,
// 20 kW of building load draw behind the feeder, so of the 57 kW share the
// battery may take 57 − 20 − 45 = −8 kW plus the 30 kW of PV it offsets:
// 22 kW. Without a gap the park goes first and the battery reaches exactly
// that rest, at every phase of the two ticks. Through a gap it may reach its
// whole PV: blind, the park falls to its blind figure of 57 − 20 = 37 kW, and
// with the park there the battery's PV is what that figure was proven for -
// never less than the rest, never more than its PV, never above the share.
// The healing holds back nothing the park did not take.
func TestBezugPvSpeicherBekommtDenRestAmEigenenZaehler(t *testing.T) {
	for _, luecke := range []time.Duration{0, 60 * time.Second, 300 * time.Second} {
		for i := 0; i < 400; i++ {
			pp, sp, takt := i%20, (i/20)%10, []int{5, 10}[i/200]
			e := dbLauf(t, dbFall{rolle: "steuert_mit", anteilKw: 57, grenzeKw: 100, hausKw: 20, pvKw: 30,
				parkWunschKw: 45, speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp, messtakt: takt})
			if e.sekunden > 0 {
				t.Errorf("blind %v, pass :%02d, tick :%02d: %d s above the share, +%.3f kW", luecke, pp, sp, e.sekunden, e.groessteKw)
			}
			if e.ladungKw < 22-1e-9 || e.ladungKw > 30+1e-9 || (luecke == 0 && e.ladungKw > 22+1e-9) {
				t.Errorf("blind %v, pass :%02d, tick :%02d: the battery reached %.3f kW, want the rest of 22 kW of its PV",
					luecke, pp, sp, e.ladungKw)
			}
		}
	}
}

// The leading box at the edge of the blind state: Halle 1 behind 100 kW,
// 30 kW of building load, 10 kW of PV, the vehicles want 80 kW, the plan 60 kW
// of the battery; share 20 kW. Fresh, the park takes 90 − 30 + 10 = 70 kW -
// it counted the PV surplus - and the battery's loop leaves nothing. Gaps of
// 35 to 85 s: the box turns blind (older than 30 s) before the meter is back,
// and the seconds between the end of the gap and the first new sample are
// measured - there the park still stands on its fresh figure (or on its
// ramp), while the battery fell back to "at most its own PV". The meter stays
// at or below the planable power in every measured second.
func TestBezugPvDoppeltAmRandDesBlindFuehrend(t *testing.T) {
	schlimmste, faelle := dbErgebnis{}, 0
	for _, luecke := range []time.Duration{35 * time.Second, 45 * time.Second, 65 * time.Second, 85 * time.Second} {
		for _, takt := range []int{5, 10} {
			for pp := 0; pp < 20; pp++ {
				for sp := 0; sp < 10; sp++ {
					e := dbLauf(t, dbFall{rolle: "fuehrt", anteilKw: 20, grenzeKw: 100, hausKw: 30, pvKw: 10,
						parkWunschKw: 80, speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp,
						messtakt: takt})
					faelle++
					if e.sekunden > schlimmste.sekunden || e.groessteKw > schlimmste.groessteKw {
						schlimmste = e
					}
					if e.sekunden > 0 {
						t.Errorf("blind %v, meter every %d s, pass :%02d, tick :%02d: %d s above the headroom, largest +%.3f kW",
							luecke, takt, pp, sp, e.sekunden, e.groessteKw)
					}
				}
			}
		}
	}
	t.Logf("%d cases, worst: %d s, +%.3f kW", faelle, schlimmste.sekunden, schlimmste.groessteKw)
}

// "Ein Spielraum wird einmal vergeben" WITH PV, random: the property of
// bezug_doppelfreigabe_test.go (both roles, random limits, shares, building
// loads, vehicle demand, the battery's wish, gaps, phases, cadences) with the
// box's own PV at 0-100 % of its share, measured from the cold start on at
// both roles. At every second the box measures, its meter stays at or below
// the headroom - exactly, without tolerance beyond the kW resolution.
func TestEigenschaftBezugEinSpielraumMitPv(t *testing.T) {
	rng := rand.New(rand.NewSource(1061))
	mitPv, netz := 0, 0
	for run := 0; run < 300; run++ {
		f, spielraum := dbZufall(rng)
		f.pvKw = rng.Float64() * f.anteilKw
		if f.hausKw > spielraum-1e-9 {
			continue // the load the box does not control leaves nothing to hold
		}
		e := dbLauf(t, f)
		if e.sekunden > 0 {
			t.Fatalf("run %d %+v: %d s above the headroom %.3f, largest +%.3f kW", run, f, e.sekunden, spielraum, e.groessteKw)
		}
		if f.rolle != "fuehrt" && e.speicherKw > dbAufloesungKw { // the PV reading rounded to the watt
			t.Fatalf("run %d %+v: the co-controlling battery charged %.3f kW from the grid", run, f, e.speicherKw)
		}
		if f.pvKw > 1 && e.ladungKw > 1e-9 {
			mitPv++
		}
		if e.speicherKw > dbAufloesungKw {
			netz++
		}
	}
	if mitPv < 50 || netz < 30 {
		t.Fatalf("the battery charged from PV in only %d runs, from the grid in %d - the source does not reach the loop", mitPv, netz)
	}
	t.Logf("%d runs charging PV, %d charging from the grid", mitPv, netz)
}
