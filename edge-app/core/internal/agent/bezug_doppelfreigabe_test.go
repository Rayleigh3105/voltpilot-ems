package agent

// AP-15 Folge (reported by the healing of the feed-in double release, PR
// 1055): the charge park's budget (lastmgmt.BudgetAnteil, the OCPP pass every
// 20 s and on an urgent drop) and the battery's grid-charge ceiling
// (guards.NetzladenDeckelFuer, the setpoint tick every 10 s) are two loops
// against ONE connection limit, reading the same sample. After a blind state
// in which both were lowered (the park to its share, the battery to "nicht
// aus dem Netz"), the first fresh sample shows one headroom. The suspicion:
// if the battery evaluates before the park re-allocates, ReservedKw is still
// 0 and both take the headroom. Played here WITHOUT an assumption about the
// answer: the real agent functions (ocppBudget, netzladenDeckel), every phase
// of the two ticks, and the plant measured at its point.

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// dbDok is a share document for box id with an import share of bezugKw; a
// co-controlling box declares the uncontrolled maximum behind its feeder
// (ungeregelt_hinter_abgang, B3) honestly.
func dbDok(id, rolle string, bezugKw, ungeregeltKw float64) []byte {
	anderer := vaE4
	if id == vaE4 {
		anderer = vaE1
	}
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":1,"schritt":"ziel","verteilbar":{"einspeisung":100.0,"bezug":77.0},`+
		`"anteile":{"einspeisung":{%q:40.0,%q:60.0},"bezug":{%q:%.1f,%q:%.1f}},"published_at":"2027-06-13T09:00:00Z","rolle":%q,`+
		`"ungeregelt_hinter_abgang":{"bezug":%.3f}}`,
		vaTenant, vaSite, id, id, anderer, id, bezugKw, anderer, 77-bezugKw, rolle, ungeregeltKw))
}

// dbAufloesungKw is the resolution of every kW figure on the box (round3):
// a ceiling rounded half a watt up is no second release.
const dbAufloesungKw = 0.0005

// dbFall is one operating point of the two loops.
type dbFall struct {
	rolle          string           // fuehrt: the meter is the connection point; steuert_mit: the own feeder
	anteilKw       float64          // the box's import share
	grenzeKw       float64          // the connection limit maintained at the park (fuehrt)
	hausKw         float64          // everything behind the meter that is neither park nor battery
	pvKw           float64          // the box's own PV (a real, measured reading)
	parkWunschKw   float64          // what the vehicles would draw
	speicherWunsch float64          // the charge the plan asks of the battery (from the grid)
	luecke         time.Duration    // one gap from :00
	blind          func(s int) bool // instead of luecke: blind in second s
	abLuecke       bool             // measure only from the (first) gap on, not the cold start
	parkPhase      int              // second of the 20 s OCPP pass (0..19)
	speicherPhase  int              // second of the 10 s setpoint tick (0..9)
	messtakt       int              // seconds between two meter samples
}

// dbErgebnis is what the plant measured after the measurement was back.
type dbErgebnis struct {
	groessteKw float64 // largest excess of the meter over the headroom
	sekunden   int     // seconds above it
	speicherKw float64 // largest grid charge of the battery while it measures
}

// dbLauf plays one case: 5 min fresh from a cold start, the gap, 10 min
// fresh, measured at every second the box is not blind (the cold start is
// the same question: both loops at 0, the first sample shows the whole
// headroom). The plant follows every command at once. The headroom is what the loop may
// spend at its meter: the planable connection power at a leading box, the
// share at a co-controlling one.
func dbLauf(t *testing.T, f dbFall) dbErgebnis {
	t.Helper()
	id := vaE1
	if f.rolle != "fuehrt" {
		id = vaE4
	}
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 100, 100
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, id
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, id })
	t0 := time.Date(2027, 6, 14, 22, 0, 0, 0, time.UTC)
	if r := a.nimmAnteile(dbDok(id, f.rolle, f.anteilKw, f.hausKw), t0.Add(-time.Hour)); r == nil || !r.Angenommen {
		t.Fatalf("document not accepted: %+v", r)
	}
	set := lastmgmt.Settings{GridLimitKw: f.grenzeKw}.WithDefaults()
	a.ocpp = &ocppRuntime{budget: lastmgmt.NewBudgetTracker(), settings: set}
	spielraum := f.anteilKw
	if f.rolle == "fuehrt" {
		spielraum = math.Round(f.grenzeKw*(1-set.MarginPct/100)*1000) / 1000
	}

	park, batt := 0.0, 0.0
	zaehler := func() float64 { return f.hausKw + park + batt - f.pvKw }
	parkPass := func(now time.Time) {
		// the order of ocppStep: the sample, the budget, the plan
		stichprobe := a.ocpp.budget.Stichprobe()
		v, reserved := a.ocppBudget(now, set, csms.Snapshot{}, lastmgmt.SafeDefault{})
		alloc := math.Min(f.parkWunschKw, math.Max(v.Kw-reserved, 0))
		a.ocpp.setPlanAuf(&lastmgmt.Plan{BudgetKw: v.Kw, AllocatedKw: alloc}, stichprobe)
		park = alloc
	}
	speicherTick := func(now time.Time) {
		kw := f.speicherWunsch
		if d := a.netzladenDeckel(now, guards.Reading{PvKw: f.pvKw}); d != nil {
			kw = guards.LowerCharge(kw, &d.DeckelKw)
		}
		batt = kw
	}
	var e dbErgebnis
	gemessen := !f.abLuecke
	luecke := int(f.luecke.Seconds())
	blind := f.blind
	if blind == nil {
		blind = func(s int) bool { return s >= 0 && s < luecke }
	}
	for s := -300; s <= 600; s++ {
		now := t0.Add(time.Duration(s) * time.Second)
		dringend := false
		if !blind(s) && ((s%f.messtakt)+f.messtakt)%f.messtakt == 0 {
			b := batt
			m := lastmgmt.Measurement{GridKw: zaehler(), ChargingKw: park, Complete: true,
				HaveBattery: true, BatteryChargeKw: b}
			dringend = a.ocpp.budget.ObserveM(now, m)
		}
		if dringend || ((s%20)+20)%20 == f.parkPhase {
			parkPass(now)
		}
		if ((s%10)+10)%10 == f.speicherPhase {
			speicherTick(now)
		}
		if blind(s) {
			gemessen = true
			continue
		}
		if !gemessen {
			continue
		}
		if netzladen := batt - f.pvKw; netzladen > e.speicherKw {
			e.speicherKw = netzladen
		}
		if ueber := zaehler() - spielraum; ueber > dbAufloesungKw {
			e.groessteKw = math.Max(e.groessteKw, ueber)
			e.sekunden++
		}
	}
	return e
}

// The operating point of the suspicion: Box Halle 1 leads behind 100 kW,
// 30 kW of building load, night (no PV), six vehicles wanting 80 kW and a
// plan charging the battery with 60 kW from the grid - the headroom of
// 90 − 30 = 60 kW binds. Blind 60/120/300 s (park on its share, battery on
// its own PV = 0), then fresh: for every phase of the two ticks, both
// meter cadences, the sum of park and grid charge stays within the headroom.
func TestBezugDoppelfreigabeNachBlindFuehrend(t *testing.T) {
	schlimmste := dbErgebnis{}
	faelle := 0
	for _, luecke := range []time.Duration{60 * time.Second, 120 * time.Second, 300 * time.Second} {
		for _, takt := range []int{5, 10} {
			for pp := 0; pp < 20; pp++ {
				for sp := 0; sp < 10; sp++ {
					f := dbFall{rolle: "fuehrt", anteilKw: 20, grenzeKw: 100, hausKw: 30, parkWunschKw: 80,
						speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp, messtakt: takt}
					e := dbLauf(t, f)
					faelle++
					if e.sekunden > schlimmste.sekunden {
						schlimmste = e
					}
					if e.sekunden > 0 {
						t.Errorf("blind %v, meter every %d s, park pass at :%02d, battery tick at :%02d: %d s above the headroom, largest +%.3f kW",
							luecke, takt, pp, sp, e.sekunden, e.groessteKw)
					}
				}
			}
		}
	}
	t.Logf("%d cases, worst: %d s, +%.3f kW", faelle, schlimmste.sekunden, schlimmste.groessteKw)
}

// The battery gets what is left: the vehicles want only 25 of the 60 kW, and
// once the park has decided the battery charges the other 35 kW from the
// grid - the healing holds nothing back the park did not take, at every
// phase of the two ticks and both meter cadences (no tick order starves it).
func TestBezugDoppelfreigabeSpeicherBekommtDenRest(t *testing.T) {
	for _, luecke := range []time.Duration{60 * time.Second, 300 * time.Second} {
		for i := 0; i < 400; i++ {
			pp, sp, takt := i%20, (i/20)%10, []int{5, 10}[i/200]
			{
				e := dbLauf(t, dbFall{rolle: "fuehrt", anteilKw: 20, grenzeKw: 100, hausKw: 30, parkWunschKw: 25,
					speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp, messtakt: takt})
				if e.sekunden > 0 {
					t.Errorf("blind %v, pass :%02d, tick :%02d: %d s above the headroom, +%.3f kW", luecke, pp, sp, e.sekunden, e.groessteKw)
				}
				if math.Abs(e.speicherKw-35) > 1e-9 {
					t.Errorf("blind %v, pass :%02d, tick :%02d: the battery reached %.3f kW from the grid, want the rest of 35 kW", luecke, pp, sp, e.speicherKw)
				}
			}
		}
	}
}

// The co-controlling box (PR 1059) holds its share at its own feeder, and
// its battery charges from its own PV only - it never takes the import the
// park's loop hands out. Box Verwaltung: share 57 kW, 20 kW of building load
// behind the feeder (declared as ungeregelt_hinter_abgang), 30 kW of PV, the
// plan asks 60 kW of the battery. Blind, the battery already charges its PV,
// so the first fresh sample holds no headroom the two could both take.
//
// Measured from the gap on, not from the cold start: there the battery
// starts from 0 and takes its PV while the park's loop has already counted
// that PV surplus as headroom at the feeder - a DIFFERENT mechanism (PV
// counted twice, the solar-only clamp does not see the park), reported in
// the PR of this test as a finding and not healed here.
func TestBezugDoppelfreigabeNachBlindAmEigenenZaehler(t *testing.T) {
	for _, luecke := range []time.Duration{60 * time.Second, 120 * time.Second, 300 * time.Second} {
		for pp := 0; pp < 20; pp++ {
			for sp := 0; sp < 10; sp++ {
				e := dbLauf(t, dbFall{rolle: "steuert_mit", anteilKw: 57, grenzeKw: 100, hausKw: 20, pvKw: 30,
					parkWunschKw: 80, speicherWunsch: 60, luecke: luecke, parkPhase: pp, speicherPhase: sp, messtakt: 5,
					abLuecke: true})
				if e.sekunden > 0 {
					t.Errorf("blind %v, pass :%02d, tick :%02d: %d s above the share, +%.3f kW", luecke, pp, sp, e.sekunden, e.groessteKw)
				}
				if e.speicherKw > 1e-9 {
					t.Errorf("blind %v: the co-controlling battery charged %.3f kW from the grid", luecke, e.speicherKw)
				}
			}
		}
	}
}

// "Ein Spielraum wird einmal vergeben", random: both roles, random limits,
// shares, building loads, vehicle demand, and the battery's grid charge as a
// random source (the plan's wish), random gaps, both meter cadences and every
// phase of the two ticks. Without PV: with PV the solar-only clamp (blind, and
// at the co-controlling box always) can take PV the park's loop already
// counted at the meter - a second mechanism, reported in the PR, not this
// one. At every second the box measures, its meter
// stays at or below the headroom - exactly, without tolerance - wherever the
// load it does not control leaves that headroom at all.
func TestEigenschaftBezugEinSpielraumMitSpeicherNetzladen(t *testing.T) {
	rng := rand.New(rand.NewSource(1055))
	gebunden := 0
	for run := 0; run < 300; run++ {
		f := dbFall{rolle: []string{"fuehrt", "steuert_mit"}[rng.Intn(2)], grenzeKw: float64(40 + rng.Intn(500)),
			parkPhase: rng.Intn(20), speicherPhase: rng.Intn(10), messtakt: []int{5, 10}[rng.Intn(2)]}
		f.anteilKw = float64(rng.Intn(78))
		f.hausKw = rng.Float64() * f.grenzeKw * 0.6
		f.parkWunschKw = rng.Float64() * f.grenzeKw
		f.speicherWunsch = rng.Float64() * f.grenzeKw
		// one to three gaps of 10 s to 6 min
		type luecke struct{ von, bis int }
		var ls []luecke
		for von := rng.Intn(60); von < 540 && len(ls) < 3; {
			bis := von + 10 + rng.Intn(360)
			ls = append(ls, luecke{von, bis})
			von = bis + 30 + rng.Intn(120)
		}
		f.blind = func(s int) bool {
			for _, l := range ls {
				if s >= l.von && s < l.bis {
					return true
				}
			}
			return false
		}
		spielraum := f.anteilKw
		if f.rolle == "fuehrt" {
			spielraum = f.grenzeKw * 0.9
		} else {
			f.abLuecke = true // the cold start at the feeder: see above
		}
		if f.hausKw > spielraum-1e-9 {
			continue // the load the box does not control leaves nothing to hold
		}
		e := dbLauf(t, f)
		if e.sekunden > 0 {
			t.Fatalf("run %d %+v: %d s above the headroom %.3f, largest +%.3f kW", run, f, e.sekunden, spielraum, e.groessteKw)
		}
		if e.speicherKw > 1e-9 {
			gebunden++
		}
	}
	if gebunden < 50 {
		t.Fatalf("the battery charged from the grid in only %d runs - the source does not reach the loop", gebunden)
	}
	t.Logf("%d runs with a grid charge of the battery", gebunden)
}
