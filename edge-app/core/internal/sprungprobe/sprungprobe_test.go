package sprungprobe

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"
)

var (
	ich  = Identitaet{Mandant: "t-1", Anlage: "an-1", Box: "e-4"}
	t0   = time.Date(2027, 6, 13, 11, 0, 0, 0, time.UTC)
	takt = 10 * time.Second
)

func auftrag(art Art, kw float64) Auftrag {
	return Auftrag{SchemaVersion: "1.0", TenantID: "t-1", SiteID: "an-1", DeviceID: "e-4", ProbeID: "p-21", Art: art,
		SprungKw: kw, DauerS: 60, Wiederholungen: 2, PauseS: 60, GueltigBis: t0.Add(2 * time.Minute), Ts: t0}
}

func dok(tenant, site, device, art string, kw float64, dauer, wdh int, extra string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,"probe_id":"p-21",`+
		`"art":%q,"sprung_kw":%v,"dauer_s":%d,"wiederholungen":%d,"pause_s":60,"gueltig_bis":"2027-06-13T11:02:00Z",`+
		`"ts":"2027-06-13T11:00:00Z"%s}`, tenant, site, device, art, kw, dauer, wdh, extra))
}

// Identity first (T4), then every bound: an order outside them is not run.
func TestLesenPrueftIdentitaetUndGrenzen(t *testing.T) {
	a, err := Lesen(ich, dok("t-1", "an-1", "e-4", "erzeugung_senken", 30, 60, 2, ""))
	if err != nil || a.SprungKw != 30 || a.Art != ErzeugungSenken || a.GueltigBis != t0.Add(2*time.Minute) {
		t.Fatalf("valid order: %+v %v", a, err)
	}
	for name, raw := range map[string][]byte{
		"fremder mandant": dok("t-2", "an-1", "e-4", "erzeugung_senken", 30, 60, 2, ""),
		"fremde anlage":   dok("t-1", "an-2", "e-4", "erzeugung_senken", 30, 60, 2, ""),
		"fremde box":      dok("t-1", "an-1", "e-1", "erzeugung_senken", 30, 60, 2, ""),
	} {
		if _, err := Lesen(ich, raw); !errors.Is(err, ErrNichtIhres) {
			t.Errorf("%s: %v, want ErrNichtIhres", name, err)
		}
	}
	for name, raw := range map[string][]byte{
		"51 kW":            dok("t-1", "an-1", "e-4", "erzeugung_senken", 51, 60, 2, ""),
		"0 kW":             dok("t-1", "an-1", "e-4", "erzeugung_senken", 0, 60, 2, ""),
		"61 s":             dok("t-1", "an-1", "e-4", "erzeugung_senken", 30, 61, 2, ""),
		"einmal":           dok("t-1", "an-1", "e-4", "erzeugung_senken", 30, 60, 1, ""),
		"anheben":          dok("t-1", "an-1", "e-4", "erzeugung_anheben", 30, 60, 2, ""),
		"unbekanntes feld": dok("t-1", "an-1", "e-4", "erzeugung_senken", 30, 60, 2, `,"leistung_kw":80`),
		"kein json":        []byte("{"),
	} {
		if _, err := Lesen(ich, raw); err == nil || errors.Is(err, ErrNichtIhres) {
			t.Errorf("%s: %v, want a bound error", name, err)
		}
	}
}

// fahre runs the probe tick by tick; ist gives the own measurement for a
// ceiling (nil = unlowered value). It returns the ceilings per tick.
func fahre(p *Probe, von time.Time, ticks int, ohne float64, waechter func(i int) string) []*float64 {
	var out []*float64
	var deckel *float64
	for i := 0; i < ticks; i++ {
		ist := ohne
		if deckel != nil {
			ist = math.Min(ohne, *deckel) // the plant follows its cap
		}
		w := p.Schritt(von.Add(time.Duration(i)*takt), Lage{IstKw: ist, RegelungAn: true, Waechter: waechter(i)})
		deckel = w.DeckelKw
		out = append(out, deckel)
	}
	return out
}

func keinWaechter(int) string { return "" }

// R19 on the box: PV 55 -> 25 kW for 60 s, twice, 60 s apart, back after each
// jump, report after the run-out with the own measurement before and during.
func TestZweimalBegrenztUndZurueckgestellt(t *testing.T) {
	p := Neu(auftrag(ErzeugungSenken, 30), t0)
	deckel := fahre(p, t0, 30, 55, keinWaechter)
	for i, d := range deckel {
		sprung := i < 6 || (i >= 12 && i < 18) // 0..50 s and 120..170 s
		if sprung && (d == nil || *d != 25) || !sprung && d != nil {
			t.Fatalf("tick %d (%v s): ceiling %v", i, i*10, d)
		}
	}
	if !p.Fertig() {
		t.Fatal("not finished after jump, pause, jump and run-out")
	}
	b, ok := p.Bericht()
	if !ok || b.Abgebrochen || len(b.Spruenge) != 2 || b.Stellgroesse != "pv_kappe" {
		t.Fatalf("report: %+v", b)
	}
	for i, s := range b.Spruenge {
		if s.Bis.Sub(s.Von) != 60*time.Second || *s.VorherKw != 55 || *s.WaehrendKw != 25 {
			t.Fatalf("jump %d: %v..%v vorher %v waehrend %v", i, s.Von, s.Bis, *s.VorherKw, *s.WaehrendKw)
		}
	}
	if b.Spruenge[1].Von.Sub(b.Spruenge[0].Von) != 120*time.Second {
		t.Fatalf("second jump starts %v after the first", b.Spruenge[1].Von.Sub(b.Spruenge[0].Von))
	}
	if w := p.Schritt(t0.Add(time.Hour), Lage{IstKw: 55, RegelungAn: true}); w.DeckelKw != nil {
		t.Fatal("a finished probe asks nothing")
	}
}

// A jump never goes below 0 and is anchored at its start: 20 kW of PV and a
// 30 kW order hold 0, not a ceiling that follows the falling value.
func TestSprungNieUnterNullUndFestVerankert(t *testing.T) {
	p := Neu(auftrag(ErzeugungSenken, 30), t0)
	for i, d := range fahre(p, t0, 6, 20, keinWaechter) {
		if d == nil || *d != 0 {
			t.Fatalf("tick %d: ceiling %v, want 0", i, d)
		}
	}
}

// Every own watchdog stands above the probe: the tick it intervenes, the
// ceiling is gone and the report says why - in the jump and in the pause.
func TestAbbruchJeWaechter(t *testing.T) {
	for _, grund := range []string{Einspeisewaechter, Bezugswaechter, Eingefroren, Geraeteschutz} {
		for _, bei := range []int{3, 8} { // in the first jump, in the pause
			p := Neu(auftrag(VerbrauchSenken, 20), t0)
			deckel := fahre(p, t0, 10, 40, func(i int) string {
				if i == bei {
					return grund
				}
				return ""
			})
			if deckel[bei] != nil {
				t.Fatalf("%s at tick %d: ceiling %v on the aborting tick", grund, bei, *deckel[bei])
			}
			for _, d := range deckel[bei:] {
				if d != nil {
					t.Fatalf("%s: a ceiling after the abort", grund)
				}
			}
			b, ok := p.Bericht()
			if !ok || !b.Abgebrochen || b.Grund != grund || b.Stellgroesse != "batterie_laden" {
				t.Fatalf("%s at %d: report %+v", grund, bei, b)
			}
			if bei == 8 && len(b.Spruenge) != 1 || bei == 3 && len(b.Spruenge) != 0 {
				t.Fatalf("%s at %d: only finished jumps are reported, got %d", grund, bei, len(b.Spruenge))
			}
		}
	}
}

// Control off, an expired order, nothing to lower: never a jump.
func TestKeinSprungOhneRegelungAbgelaufenOderOhneStellgroesse(t *testing.T) {
	p := Neu(auftrag(ErzeugungSenken, 30), t0)
	if w := p.Schritt(t0, Lage{IstKw: 55}); w.DeckelKw != nil {
		t.Fatal("control off: a ceiling")
	}
	if b, _ := p.Bericht(); b.Grund != RegelungAus {
		t.Fatalf("control off: %+v", b)
	}
	spaet := Neu(auftrag(ErzeugungSenken, 30), t0.Add(3*time.Minute))
	if b, ok := spaet.Bericht(); !ok || b.Grund != Abgelaufen {
		t.Fatalf("expired order: %+v", b)
	}
	erst := Neu(auftrag(ErzeugungSenken, 30), t0)
	if w := erst.Schritt(t0.Add(3*time.Minute), Lage{IstKw: 55, RegelungAn: true}); w.DeckelKw != nil {
		t.Fatal("first tick after gueltig_bis: a ceiling")
	}
	if b, _ := erst.Bericht(); b.Grund != Abgelaufen {
		t.Fatalf("started too late: %+v", b)
	}
	for _, ist := range []float64{math.NaN(), 0.5} {
		p := Neu(auftrag(VerbrauchSenken, 20), t0)
		if w := p.Schritt(t0, Lage{IstKw: ist, RegelungAn: true}); w.DeckelKw != nil {
			t.Fatalf("ist %v: a ceiling", ist)
		}
		if b, _ := p.Bericht(); b.Grund != KeineStellgroesse {
			t.Fatalf("ist %v: %+v", ist, b)
		}
	}
	p = Neu(auftrag(ErzeugungSenken, 30), t0)
	p.Schritt(t0, Lage{IstKw: 55, RegelungAn: true})
	p.Abbrechen(t0.Add(takt), Einspeisewaechter)
	if b, _ := p.Bericht(); b.Grund != Einspeisewaechter || !p.Fertig() {
		t.Fatalf("aborted from outside: %+v", b)
	}
}

// The property of the whole package: with a probe, no set value is ever
// WIDER than without - the PV cap is at most what it was (a missing cap may
// become one, never the other way), a charge only falls and never below 0, a
// discharge or idle battery is untouched. 20 000 random ticks over random
// probes, set values and plan caps.
func TestMitProbeIstKeineStellgroesseWeiterAlsOhne(t *testing.T) {
	rng := rand.New(rand.NewSource(21))
	for n := 0; n < 200; n++ {
		art := ErzeugungSenken
		if rng.Intn(2) == 0 {
			art = VerbrauchSenken
		}
		p := Neu(auftrag(art, 0.5+rng.Float64()*49.5), t0)
		now := t0
		for i := 0; i < 100; i++ {
			now = now.Add(time.Duration(1+rng.Intn(15)) * time.Second)
			l := Lage{IstKw: rng.Float64() * 120, RegelungAn: rng.Intn(20) != 0}
			if rng.Intn(30) == 0 {
				l.Waechter = Einspeisewaechter
			}
			if rng.Intn(25) == 0 {
				l.IstKw = math.NaN()
			}
			w := p.Schritt(now, l)
			kw := rng.Float64()*200 - 100
			var pvLimit *float64
			if rng.Intn(3) != 0 {
				v := rng.Float64() * 150
				pvLimit = &v
			}
			mitKw, mitPv := Laden(kw, w), Kappe(pvLimit, w)
			if mitKw > kw || (kw <= 0 && mitKw != kw) || (kw > 0 && mitKw < 0) {
				t.Fatalf("probe %d tick %d: charge %v -> %v (%+v)", n, i, kw, mitKw, w)
			}
			if pvLimit != nil && (mitPv == nil || *mitPv > *pvLimit) {
				t.Fatalf("probe %d tick %d: pv cap %v -> %v", n, i, *pvLimit, mitPv)
			}
			if w.DeckelKw != nil && *w.DeckelKw < 0 {
				t.Fatalf("negative ceiling %v", *w.DeckelKw)
			}
		}
	}
	// the empty Wunsch (no order) changes nothing - the same cap, the same charge
	v := 40.0
	if Kappe(&v, Wunsch{}) != &v || Kappe(nil, Wunsch{}) != nil || Laden(33, Wunsch{}) != 33 {
		t.Fatal("without an order the set values must be untouched")
	}
}
