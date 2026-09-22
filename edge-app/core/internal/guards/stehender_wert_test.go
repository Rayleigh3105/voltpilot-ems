package guards

// AP-15 Folge of IP-28 finding 1: a standing value proves no headroom
// (exportanteil.go). A loop model of Box Halle 1 at the M-3 point of the
// Mittag - the partner's feeder -30 kW, no load, the battery discharging for
// the market, K-1 and K-2 following their ceilings at once - wired to the
// Einfrierprobe the way the agent wires them (agent/eingefroren.go): the
// meter value and every effective adjustment reach the probe, the probe's
// request reaches the watchdog, the watchdog's probing adjustment reaches the
// probe. The meter freezes at a random moment relative to a probing
// adjustment. ohneStehSperre is the mutation probe: the watchdog as on uems.

import (
	"math"
	"math/rand"
	"reflect"
	"testing"
	"time"
)

type swLauf struct {
	takt       int     // a meter sample every takt seconds
	auswertung int     // an evaluation every auswertung seconds (0: every second)
	sonne      float64 // available PV at K-1 (kW)
	entladung  float64 // the discharge the plan commands (kW)
	friertAb   int     // freeze: seconds relative to the first probing adjustment (math.MinInt: never)
	rauschen   bool    // a meter whose value moves with every sample
	seed       int64
}

type swSekunde struct {
	s                  int
	exportKw, schubKw  float64 // real export at the connection point; what Halle 1 is commanded to push
	capKw, entladungKw float64 // commanded PV cap, allowed discharge
	frisch, steht      bool    // fresh evaluation; its newest sample repeats the value before
	c                  ExportCap
}

type swErgebnis struct {
	sek        []swSekunde
	pruefAb    int // second of the first probing adjustment (-1: none)
	friertAb   int // second the meter froze (-1: never)
	letzterAb  int // second of the last change of the meter value
	freigaben  int // PV cap raised on a standing sample above what the last moved one proved
	entladeAuf int // the same for the discharge
}

const swPartnerKw = 30.0

func (f swLauf) fahre(t *testing.T) swErgebnis {
	t.Helper()
	rng := rand.New(rand.NewSource(f.seed))
	l, p := NewExportLimiter(), &Einfrierprobe{}
	cap, dcap := math.Inf(1), math.Inf(1)
	r := swErgebnis{pruefAb: -1, friertAb: -1}
	var frozen *float64
	var letzterWert, ankerGrid, ankerPv, ankerDis float64
	letzterSeen, steht := false, false
	var c ExportCap
	neuDis := f.entladung
	for s := 0; s <= 600; s++ {
		now := r9t0.Add(time.Duration(s) * time.Second)
		pv := math.Min(f.sonne, cap)
		dis := math.Min(f.entladung, dcap)
		grid := -(pv + dis + swPartnerKw)
		if f.rauschen {
			grid += float64(s%97)*1e-4 + rng.Float64()*1e-5
		}
		if r.pruefAb >= 0 && frozen == nil && f.friertAb != math.MinInt && s >= r.pruefAb+f.friertAb {
			v := grid
			frozen, r.friertAb = &v, s
		}
		if s%f.takt == 0 {
			wert := grid
			if frozen != nil {
				wert = *frozen
			}
			steht = letzterSeen && wert == letzterWert
			if !steht {
				r.letzterAb, ankerGrid, ankerPv, ankerDis = s, wert, pv, dis
			}
			letzterWert, letzterSeen = wert, true
			batt := -dis
			p.Wert(now, wert)
			l.ObserveMitSpeicher(now, wert, pv, &batt)
		}
		if f.auswertung <= 1 || s%f.auswertung == 0 {
			an := halle1
			if seit, ok := p.Eingefroren(now); ok {
				an.EingefrorenSeit = seit
			}
			if richtung, neu := p.Pruefung(now); richtung < 0 {
				an.Pruefen, an.PruefenNeu = true, neu
			}
			vorCap, vorDis := cap, neuDis
			c = l.CapAnteil(now, &grenze100, an, f.entladung)
			if c.Pruefung {
				p.Geprueft(now)
				if r.pruefAb < 0 {
					r.pruefAb = s
				}
			}
			neuDis = f.entladung
			if c.DischargeCapKw != nil {
				neuDis = math.Min(neuDis, *c.DischargeCapKw)
			}
			// what the published setpoint MUST change at the meter
			// (agent.einfrierSollwert): the PV cap below the measured PV, the
			// battery towards 0 from its measured power
			p.Verstellt(now, WirksamGesenkt(cap, c.CapKw, pv)+WirksamSpeicher(-dis, -neuDis))
			if frozen != nil && steht && !c.Blind {
				spiel := grenze100 - math.Max(-ankerGrid, 0) - exportMargin(grenze100)
				if c.CapKw > math.Max(vorCap, ankerPv+spiel)+1e-9 {
					r.freigaben++
				}
				if neuDis > math.Max(vorDis, ankerPv+ankerDis+spiel)+1e-9 {
					r.entladeAuf++
				}
			}
			cap, dcap = c.CapKw, neuDis
		}
		r.sek = append(r.sek, swSekunde{s: s, exportKw: -grid, schubKw: math.Min(f.sonne, c.CapKw) + neuDis, capKw: c.CapKw,
			entladungKw: neuDis, frisch: !c.Blind, steht: steht, c: c})
	}
	return r
}

// withOhneSperre runs fn as the watchdog of uems (the mutation probe).
func withOhneSperre(t *testing.T, fn func()) {
	t.Helper()
	ohneStehSperre = true
	defer func() { ohneStehSperre = false }()
	fn()
}

// The finding as the container measured it, and its healing: the meter
// freezes in the dip of the probing adjustment (K-1 8.0 -> 5.9 kW, the value
// -95.9 kW). On uems the loop reads the frozen -95.9 against the PV that
// followed each release and releases the same 2.1 kW again and again - the
// connection point goes above its limit although the partner does not move.
// Healed, the dip value releases ONCE, back to 8.0 kW - the laws read the dip
// sample while the value stands - and the box is on its share 90 s after the
// last value.
func TestStehenderWertDelleGibtEinmalFrei(t *testing.T) {
	for _, takt := range []int{2, 10} {
		f := swLauf{takt: takt, sonne: 100, entladung: 60, friertAb: takt}
		var alt swErgebnis
		withOhneSperre(t, func() { alt = f.fahre(t) })
		neu := f.fahre(t)
		if alt.friertAb < 0 || neu.friertAb < 0 || alt.pruefAb != neu.pruefAb {
			t.Fatalf("takt %d s: probe %d/%d, freeze %d/%d", takt, alt.pruefAb, neu.pruefAb, alt.friertAb, neu.friertAb)
		}
		maxAlt, maxNeu := 0.0, 0.0
		for i := neu.friertAb; i < len(neu.sek); i++ {
			maxAlt = math.Max(maxAlt, alt.sek[i].exportKw)
			maxNeu = math.Max(maxNeu, neu.sek[i].exportKw)
		}
		t.Logf("takt %d s: uems %d Freigaben auf dem stehenden Wert, höchste Einspeisung %.3f kW; geheilt %d, %.3f kW",
			takt, alt.freigaben, maxAlt, neu.freigaben, maxNeu)
		if alt.freigaben < 2 || maxAlt <= grenze100 {
			t.Errorf("takt %d s: uems must show the finding (>= 2 releases, above 100 kW): %d, %.3f kW", takt, alt.freigaben, maxAlt)
		}
		maxCap := 0.0
		for _, x := range neu.sek[neu.friertAb:] {
			maxCap = math.Max(maxCap, x.capKw)
		}
		if neu.freigaben != 0 || neu.entladeAuf != 0 || maxNeu > grenze100-exportMargin(grenze100)+1e-6 || maxCap > 8+1e-9 {
			t.Errorf("takt %d s: a standing value released %d / %d times, export up to %.3f kW, K-1 up to %.3f kW",
				takt, neu.freigaben, neu.entladeAuf, maxNeu, maxCap)
		}
		zaAnteil(t, f, neu, 40)
	}
}

// zaAnteil: the box pushes at most its share 90 s after the last change of
// its meter value (matrix row A7) - from the first evaluation at or after it.
func zaAnteil(t *testing.T, f swLauf, r swErgebnis, anteil float64) {
	t.Helper()
	ab := r.letzterAb + 90
	if f.auswertung > 1 {
		ab = (ab + f.auswertung - 1) / f.auswertung * f.auswertung
	}
	for _, x := range r.sek {
		if x.s >= ab && x.schubKw > anteil+1e-6 {
			t.Fatalf("%+v: second %d (last change %d): Halle 1 pushes %.3f kW, above its share %.0f kW", f, x.s, r.letzterAb, x.schubKw, anteil)
		}
	}
}

// Property: the meter freezes at a RANDOM moment relative to the probing
// adjustment - before it, in its dip, in the middle of the release that
// follows - for the producers (sun at K-1) AND the discharge (V6: no sun,
// the probe lowers the battery), with the samples of the container (2 s)
// and of the harness (10 s). Always: no release on a standing sample, the
// share 90 s after the last value, never above the watchdog of uems (V5),
// and the connection point at most ONE headroom above the regulated point:
// a meter that freezes in the middle of a release still sends one value
// that moved (it cannot be told from a live one) - it releases what it shows,
// at most the probe's 2.1 kW; with the discharge two evaluations of one
// moved sample may give that out twice until the next sample (einSpielraum
// counts one evaluation), which stehBeleg takes back. uems ratchets on.
func TestStehenderWertEinfrierenZuZufaelligemZeitpunkt(t *testing.T) {
	rng := rand.New(rand.NewSource(20260922))
	regelpunkt := grenze100 - exportMargin(grenze100)
	hoechst := map[string][2]float64{}
	for i := 0; i < 300; i++ {
		f := swLauf{takt: []int{2, 5, 10}[rng.Intn(3)], auswertung: []int{1, 1, 5, 10}[rng.Intn(4)], entladung: 60,
			friertAb: rng.Intn(81) - 30, seed: rng.Int63()}
		art, bis := "Erzeuger", regelpunkt+PruefSenkKw
		if i%2 == 1 {
			f.sonne, f.entladung = 1.5, 97.9 // the probe lowers the discharge
			art, bis = "Entladung", regelpunkt+2*PruefSenkKw
		} else {
			f.sonne = 100
		}
		var alt swErgebnis
		withOhneSperre(t, func() { alt = f.fahre(t) })
		neu := f.fahre(t)
		if neu.pruefAb < 0 || neu.friertAb < 0 {
			t.Fatalf("%+v: no probe (%d) or no freeze (%d)", f, neu.pruefAb, neu.friertAb)
		}
		if neu.freigaben != 0 || neu.entladeAuf != 0 {
			t.Fatalf("%+v: released on a standing value beyond its proof: PV %d, discharge %d", f, neu.freigaben, neu.entladeAuf)
		}
		h := hoechst[art]
		stehtAb := -1 // the first standing fresh evaluation after the freeze
		for j, x := range neu.sek {
			if x.s < neu.pruefAb {
				continue
			}
			if stehtAb >= 0 && x.s > stehtAb {
				bis = regelpunkt + PruefSenkKw // stehBeleg took the double back
			}
			if x.exportKw > bis+1e-6 {
				t.Fatalf("%+v: second %d exports %.3f kW (at most %.1f)", f, x.s, x.exportKw, bis)
			}
			if stehtAb < 0 && x.s > neu.friertAb && x.steht && x.frisch && (f.auswertung <= 1 || x.s%f.auswertung == 0) {
				stehtAb = x.s
			}
			if c := alt.sek[j].c; c.HeuteCapKw != nil && x.capKw > *c.HeuteCapKw+1e-9 {
				t.Fatalf("%+v: second %d above the watchdog without a share: %.3f > %.3f", f, x.s, x.capKw, *c.HeuteCapKw)
			}
			h[0], h[1] = math.Max(h[0], x.exportKw), math.Max(h[1], alt.sek[j].exportKw)
		}
		hoechst[art] = h
		zaAnteil(t, f, neu, 40)
	}
	for art, h := range hoechst {
		t.Logf("%s: höchste Einspeisung nach der ersten Prüf-Verstellung %.3f kW geheilt, %.3f kW auf uems", art, h[0], h[1])
	}
}

// Property, no starvation: a meter whose value moves with every sample is
// never held - the watchdog releases exactly as on uems, number for number,
// before and after a probing adjustment, for both actuators and every sample
// rate.
func TestStehenderWertBewegterWertWieHeute(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 60; i++ {
		f := swLauf{takt: []int{1, 2, 5, 10}[rng.Intn(4)], auswertung: []int{1, 5, 10}[rng.Intn(3)], sonne: []float64{100, 1.5, 30}[rng.Intn(3)],
			entladung: 40 + 60*rng.Float64(), friertAb: math.MinInt, rauschen: true, seed: rng.Int63()}
		var alt swErgebnis
		withOhneSperre(t, func() { alt = f.fahre(t) })
		neu := f.fahre(t)
		for j := range neu.sek {
			if neu.sek[j].steht {
				t.Fatalf("%+v: second %d - the moving meter repeated a value", f, j)
			}
			if !reflect.DeepEqual(neu.sek[j].c, alt.sek[j].c) {
				t.Fatalf("%+v: second %d differs from uems:\n%+v\n%+v", f, j, neu.sek[j].c, alt.sek[j].c)
			}
		}
	}
}

// No starvation where the box really regulates: a sample every 2 s, a tick
// every 10 s, a healthy meter WITHOUT noise (the model of IP-28). The value
// stands between the ticks, so the sample on which it moved is mostly not the
// one a tick reads - the box must still release after every probing
// adjustment, never go blind, and regulate exactly as on uems, for the
// producers and the discharge.
func TestStehenderWertRauschfreiGesundWieHeute(t *testing.T) {
	for _, f := range []swLauf{
		{takt: 2, auswertung: 10, sonne: 100, entladung: 60, friertAb: math.MinInt},
		{takt: 2, auswertung: 10, sonne: 1.5, entladung: 97.9, friertAb: math.MinInt},
		{takt: 5, auswertung: 10, sonne: 100, entladung: 60, friertAb: math.MinInt},
		{takt: 1, auswertung: 10, sonne: 30, entladung: 60, friertAb: math.MinInt},
	} {
		var alt swErgebnis
		withOhneSperre(t, func() { alt = f.fahre(t) })
		neu := f.fahre(t)
		proben := 0
		for j, x := range neu.sek {
			if x.c.Blind || x.c.Eingefroren {
				t.Fatalf("%+v: second %d - a healthy meter went blind (%s)", f, x.s, x.c.State)
			}
			if !reflect.DeepEqual(x.c, alt.sek[j].c) {
				t.Fatalf("%+v: second %d differs from uems:\n%+v\n%+v", f, x.s, x.c, alt.sek[j].c)
			}
			if x.c.Pruefung {
				proben++
			}
		}
		if f.sonne != 30 && (proben < 5 || neu.sek[len(neu.sek)-1].exportKw < grenze100-exportMargin(grenze100)-PruefSenkKw-1e-6) {
			t.Fatalf("%+v: %d probing adjustments, export at the end %.3f kW", f, proben, neu.sek[len(neu.sek)-1].exportKw)
		}
	}
}
