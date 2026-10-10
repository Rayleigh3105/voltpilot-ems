package guards

// AP-15 Folge of PR 1072 (vp-uems-v15-folge-anteilsweg-uhrensprung): the
// healed share path after the clock of the leading box jumped back (row A8r).
// The plan the box executes is anchored on the clock before the jump, so it
// "comes back" minutes later: the battery goes from the charge of the
// self-consumption fallback to the plan's discharge. The PV law read the
// measurement with the battery still charging - einAnstieg spends the
// measurement's headroom on that rise first, and ladungVorDemSprung lets no
// charge prove headroom while the clock runs behind the old newest sample.
// ohneAnstieg is the mutation probe: the watchdog as on uems.

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"
)

// The A8r picture at the guard: PV 8 kW and 60 kW discharge on the loop, the
// clock jumps 840 s back, no plan slot covers the clock - the battery charges
// what the PV gives (self-consumption) - and 240 s later the plan's discharge
// comes back. With the charge proving nothing the producers stay where they
// would hold the limit without it, and the evaluation of the return cuts the
// producers AND the discharge at once. As on uems the producers ride on the
// charge and the return leaves them open.
func TestA8rPlanRueckkehrSenktImSelbenTakt(t *testing.T) {
	fahre := func() (vorher, rueckkehr ExportCap, pvVorher float64) {
		l := NewExportLimiter()
		partner, pv, batt := 30.0, 8.0, -60.0
		takt := func(box time.Time, soll float64) ExportCap {
			b := batt
			l.ObserveMitSpeicher(box, batt-pv-partner, pv, &b)
			an := halle1
			an.LadenKw = math.Max(soll, 0)
			c := l.CapAnteil(box, &grenze100, an, math.Max(-soll, 0))
			pv = math.Min(100, c.CapKw)
			batt = soll
			if c.DischargeCapKw != nil && -soll > *c.DischargeCapKw {
				batt = -*c.DischargeCapKw
			}
			return c
		}
		takt(r9t0, -60)
		partner = 58.8
		box := r9t0.Add(-840 * time.Second)
		for s := 0; s < 240; s += 10 {
			vorher = takt(box.Add(time.Duration(s)*time.Second), pv) // self-consumption: charge = PV
		}
		pvVorher = pv
		rueckkehr = takt(box.Add(240*time.Second), -60)
		return vorher, rueckkehr, pvVorher
	}
	_, alt, altPv := func() (a, b ExportCap, p float64) {
		ohneAnstieg = true
		defer func() { ohneAnstieg = false }()
		return fahre()
	}()
	_, neu, neuPv := fahre()
	t.Logf("uems: PV vor der Rückkehr %.1f kW, Rückkehr Kappe %.1f kW Entladung %.1f kW; geheilt: PV %.1f kW, Kappe %.1f kW Entladung %.1f kW",
		altPv, alt.CapKw, dischargeAllowed(alt, 60), neuPv, neu.CapKw, dischargeAllowed(neu, 60))
	if altPv < 99 || alt.CapKw+dischargeAllowed(alt, 60) < 100 {
		t.Fatalf("uems must ride on the charge and leave the producers open at the return: PV %.3f, cap %.3f + discharge %.3f",
			altPv, alt.CapKw, dischargeAllowed(alt, 60))
	}
	// before the return: PV 39.2 = the limit's headroom with the charge gone
	if math.Abs(neuPv-39.2) > 1e-9 {
		t.Fatalf("a charge before the jump point proves no headroom: PV %.3f, want 39.2", neuPv)
	}
	// the return: charge 39.2 -> discharge 60 is a rise of 99.2 against 39.2 headroom
	if neu.CapKw != 0 || neu.DischargeCapKw == nil || *neu.DischargeCapKw != 39.2 || neu.Blind {
		t.Fatalf("the return lowers producers and discharge in the same evaluation: %+v", neu)
	}
}

// The charge proves nothing only while the clock runs behind the newest sample
// before the jump: a sample after it ends that, and the loop rides on the
// charge again as on uems.
func TestA8rLadungNachDemSprungZeitpunktWieder(t *testing.T) {
	l := NewExportLimiter()
	l.ObserveMitSpeicher(r9t0, -98, 8, ptr(-60))
	l.CapAnteil(r9t0, &grenze100, halle1, 60)
	an := halle1
	an.LadenKw = 100
	box := r9t0.Add(-20 * time.Second)
	l.ObserveMitSpeicher(box, -58.8, 100, ptr(100))
	if c := l.CapAnteil(box, &grenze100, an, 0); c.CapKw > 39.2+1e-9 {
		t.Fatalf("behind the jump point: cap %.3f, want <= 39.2", c.CapKw)
	}
	nach := r9t0.Add(10 * time.Second)
	l.ObserveMitSpeicher(nach, -58.8, 100, ptr(100))
	if c := l.CapAnteil(nach, &grenze100, an, 0); c.Blind || c.CapKw <= 39.2+1e-9 {
		t.Fatalf("after the jump point the charge counts again, released braked: %+v", c)
	}
}

// asLauf is one random run: Box Halle 1 (or a co-controlling box) in the loop
// with a plant that follows the published cap and discharge at once, a clock
// that jumps BACK at a random moment, and a plan that comes back at random -
// charge <-> discharge, and the self-consumption charge of the PV.
type asLauf struct {
	seed int64
	// rampe adds the blind path with the ramp (rampe_anstieg_test.go): the
	// own measuring point goes away for 4-13 evaluations at random, so the
	// share path runs its 60 s ramp while the plan comes back.
	rampe bool
}

type asErgebnis struct {
	auswertungen, rueckkehr, spruenge, blind int
	// rampe: evaluations on the ramp checked against its line, and plan
	// returns that raised the push during it
	rampe, rampeAnstieg int
	verletzt            string
}

// fahre plays the run and checks V6 in EVERY evaluation, without tolerance:
// fresh, what the evaluation lets through - the published cap and the battery
// push under its ceiling - never pushes the box's own measuring point above
// its loop limit on the measurement it read (signed: an import there is room
// the laws do not even count); blind, generation plus discharge never above
// the share (plus the rounding of the two published numbers); and never above
// the box without a share (V5).
func (f asLauf) fahre() asErgebnis {
	rng := rand.New(rand.NewSource(f.seed))
	var e asErgebnis
	limit := 20 + rng.Float64()*200
	an := ExportAnteil{AnteilKw: rng.Float64() * limit, Fuehrt: rng.Intn(2) == 0}
	l, heute := NewExportLimiter(), NewExportLimiter()
	sonne := rng.Float64() * 1.5 * limit
	partner, last := rng.Float64()*limit, rng.Float64()*limit*0.3
	soll := -rng.Float64() * limit // + charge / - discharge, before the guard
	pv, batt := math.Min(sonne, limit), soll
	sprungBei := 5 + rng.Intn(60)
	uhr := time.Duration(0)
	now := r9t0
	// the ramp (only with f.rampe): the meter is gone until ausfallBis; the
	// line runs from the operating point before the ramp (published cap plus
	// the push the measurement held) to the budget within 60 s
	ausfallBis := -1
	var prev ExportCap
	prevPush, pushGemessen := 0.0, 0.0
	prevValid, aufRampe, rampeOk := false, false, false
	rampeT0, rampeVor := 0.0, 0.0
	for step := 0; step < 90; step++ {
		now = now.Add(10 * time.Second)
		if f.rampe && step > 0 && step > ausfallBis && rng.Intn(12) == 0 {
			ausfallBis = step + 3 + rng.Intn(10)
		}
		if rng.Intn(10) == 0 {
			sonne = rng.Float64() * 1.5 * limit
		}
		if rng.Intn(10) == 0 {
			partner = rng.Float64() * limit
		}
		if rng.Intn(10) == 0 {
			last = rng.Float64() * limit * 0.3
		}
		// step 0 only warms up: the plant starts anywhere, and the first
		// evaluation knows no push before it (einAnstieg counts from push 0)
		if step > 0 && rng.Intn(6) == 0 { // the plan comes back / goes: charge <-> discharge
			switch rng.Intn(3) {
			case 0:
				soll = rng.Float64() * limit
			case 1:
				soll = -rng.Float64() * limit
			default:
				soll = math.Max(pv-last, 0) // self-consumption
			}
			e.rueckkehr++
		}
		sprung := step == sprungBei
		if sprung {
			uhr -= time.Duration(30+rng.Intn(1800)) * time.Second
			e.spruenge++
		}
		box := now.Add(uhr)
		// own measuring point: the connection point at the leading box
		punkt := last + batt - pv
		if an.Fuehrt {
			punkt -= partner
		}
		pvMess, pushMess, exportMess := pv, -batt, -punkt
		// after a jump the box sometimes evaluates before its next sample
		gemessen := !(sprung && rng.Intn(2) == 0) && step > ausfallBis
		if gemessen {
			pushGemessen = pushMess
			b := batt
			l.ObserveMitSpeicher(box, punkt, pv, &b)
			heute.Observe(box, punkt, pv)
		}
		a := an
		a.LadenKw = math.Max(soll, 0)
		d := math.Max(-soll, 0)
		c := l.CapAnteil(box, &limit, a, d)
		h := heute.Cap(box, &limit, exportSafeStatic(&limit, d))
		e.auswertungen++
		push := -a.LadenKw
		if d > 0 {
			push = dischargeAllowed(c, d)
		}
		loop := an.AnteilKw
		if an.Fuehrt {
			loop = limit
		}
		budget := math.Min(an.AnteilKw, loop)
		age := c.MeasurementAge
		rampeJetzt := f.rampe && c.Blind && !c.Uhrsprung && age > ExportFreshWindow && age <= ExportFreshWindow+ExportAnteilWindow
		if rampeJetzt && !aufRampe {
			// the onset: the share path pulls from its own cap - checkable
			// when that is what was published (the shadow did not bind)
			rampeVor = math.Max(prevPush, pushGemessen)
			rampeT0 = prev.CapKw + rampeVor
			rampeOk = prevValid && !prev.Blind && (prev.HeuteCapKw == nil || *prev.HeuteCapKw > prev.CapKw)
		}
		aufRampe = rampeJetzt
		linie := math.Inf(1)
		if rampeJetzt && rampeOk {
			frac := math.Min(math.Max((age-ExportFreshWindow).Seconds()/ExportAnteilWindow.Seconds(), 0), 1)
			linie = budget + math.Max(rampeT0-budget, 0)*(1-frac)
			e.rampe++
			if push > rampeVor+1e-9 {
				e.rampeAnstieg++
			}
		}
		switch {
		case step == 0:
		case h.Active && c.CapKw > h.CapKw:
			e.verletzt = "V5: with share above without"
		case !c.Blind && gemessen && exportMess+(c.CapKw-pvMess)+(push-pushMess) > loop &&
			!(c.CapKw == 0 && push <= 0):
			// (the guard never charges: with the producers at 0 and a charge
			// commanded there is nothing left it may lower)
			e.verletzt = fmt.Sprintf("V6 fresh step %d: export %.3f pv %.3f push %.3f -> cap %.3f push %.3f (soll %.3f) loop %.3f fuehrt %v %s",
				step, exportMess, pvMess, pushMess, c.CapKw, push, soll, loop, an.Fuehrt, c.State)
		case c.Blind && (c.State == ExportSafeCap || c.State == ExportHolding) && c.CapKw+math.Max(push, 0) > budget+0.001:
			// (plus half a unit of each published number's three decimals,
			// round3 - the plant follows the published cap and ceiling)
			e.verletzt = fmt.Sprintf("V6 blind step %d: cap %.3f push %.3f (soll %.3f) budget %.3f %s uhr=%v %s", step, c.CapKw, push, soll, budget, c.State, c.Uhrsprung, c.Reason)
		case c.CapKw+push > linie+0.002:
			// on the ramp: generation plus the signed push never above the
			// line from the operating point (V2), whatever the plan does (V6)
			// (plus half a unit of the three decimals of the four published
			// numbers in it - cap and ceiling now and at the onset, round3)
			e.verletzt = fmt.Sprintf("V6 ramp step %d age %v: cap %.3f push %.3f (soll %.3f) line %.3f (T0 %.3f, push before %.3f) budget %.3f %s",
				step, age, c.CapKw, push, soll, linie, rampeT0, rampeVor, budget, c.State)
		}
		if e.verletzt != "" {
			return e
		}
		if c.Blind {
			e.blind++
		}
		pv, batt = math.Min(sonne, c.CapKw), push*-1
		prev, prevPush, prevValid = c, push, true
	}
	return e
}

// Property, ohne Toleranz: a backward clock jump at a random moment with the
// plan coming back (charge <-> discharge) as a random source - generation plus
// discharge never above what the box may push (V6) in any evaluation, never
// above the box without a share (V5). The mutation probe must break it.
func TestA8rUhrZurueckPlanRueckkehrV6(t *testing.T) {
	var summe asErgebnis
	for seed := int64(0); seed < 400; seed++ {
		e := asLauf{seed: seed}.fahre()
		if e.verletzt != "" {
			t.Fatalf("seed %d: %s", seed, e.verletzt)
		}
		summe.auswertungen += e.auswertungen
		summe.rueckkehr += e.rueckkehr
		summe.spruenge += e.spruenge
		summe.blind += e.blind
	}
	if summe.rueckkehr < 1000 || summe.spruenge < 400 || summe.blind < 50 {
		t.Fatalf("the random sources do not reach the paths: %+v", summe)
	}
	ohneAnstieg = true
	defer func() { ohneAnstieg = false }()
	rot := 0
	for seed := int64(0); seed < 400; seed++ {
		if (asLauf{seed: seed}).fahre().verletzt != "" {
			rot++
		}
	}
	if rot == 0 {
		t.Fatal("the mutation probe (as on uems) must break V6 in some run")
	}
	t.Logf("%d evaluations, %d plan returns, %d backward jumps, %d blind; as on uems %d of 400 runs break V6",
		summe.auswertungen, summe.rueckkehr, summe.spruenge, summe.blind, rot)
}
