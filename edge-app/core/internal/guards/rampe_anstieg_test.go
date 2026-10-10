package guards

// AP-15 Folge of PR 1075 (vp-uems-v15-folge-blinde-rampe-planrueckkehr): V6
// in EVERY evaluation also on the blind ramp, and from the very first
// evaluation on. The ramp (V2) began with the battery charging - no
// discharge to ramp - and the plan comes back during it: the charge drops
// (the watchdog never charges), the discharge ceiling holds the discharge,
// and the producers only ramp linearly. rampAnstieg lowers the producers by
// the rise of the push against the ramp's start in the same evaluation.
// ohneRampenAnstieg and ohneAnlauf are the mutation probes: the watchdog as
// on uems.

import (
	"math"
	"testing"
	"time"
)

// rampeBild plays Box Halle 1 with its battery charging the whole PV: 100 kW
// sun, 100 kW charge, the partner exporting 30 kW at the connection point.
// The meter goes away after the sample at 50 s; the evaluation at 90 s
// starts the ramp (age 40 s), the plan comes back at 100 s with 60 kW
// discharge. It returns the evaluation of the return and the ramp's line
// there: from the operating point at the onset (the published cap plus the
// charge) linearly to the share.
func rampeBild() (rueckkehr ExportCap, linie float64) {
	l := NewExportLimiter()
	an := halle1
	var vorher ExportCap
	for s := 0; s <= 100; s += 10 {
		now := r9t0.Add(time.Duration(s) * time.Second)
		if s <= 50 {
			l.ObserveMitSpeicher(now, 100-100-30, 100, ptr(100))
		}
		dis := 0.0
		an.LadenKw = 100
		if s == 100 {
			an.LadenKw, dis = 0, 60
		}
		c := l.CapAnteil(now, &grenze100, an, dis)
		if s == 80 {
			vorher = c
		}
		if s == 100 {
			frac := (c.MeasurementAge - ExportFreshWindow).Seconds() / ExportAnteilWindow.Seconds()
			t0 := vorher.CapKw - 100
			return c, halle1.AnteilKw + math.Max(t0-halle1.AnteilKw, 0)*(1-frac)
		}
	}
	return ExportCap{}, 0
}

// The picture at the guard: the return lowers the producers by the whole
// rise (charge 100 -> discharge held at 0) in the same evaluation, so
// generation plus push stay on the ramp's line. As on uems the producers
// keep the ramp's 112 kW - the plant's 100 kW sun then pushes 100 kW against
// a share of 40.
func TestRampePlanRueckkehrSenktImSelbenTakt(t *testing.T) {
	alt, altLinie := func() (ExportCap, float64) {
		ohneRampenAnstieg = true
		defer func() { ohneRampenAnstieg = false }()
		return rampeBild()
	}()
	neu, linie := rampeBild()
	t.Logf("uems: Kappe %.1f kW + Entladung %.1f kW gegen die Linie %.1f kW; geheilt: Kappe %.1f kW + Entladung %.1f kW gegen %.1f kW (%s)",
		alt.CapKw, dischargeAllowed(alt, 60), altLinie, neu.CapKw, dischargeAllowed(neu, 60), linie, neu.State)
	if !alt.Blind || alt.CapKw+dischargeAllowed(alt, 60) <= altLinie+1 {
		t.Fatalf("uems must leave the producers on the ramp while the charge drops: %+v, line %.3f", alt, altLinie)
	}
	if !neu.Blind || neu.CapKw+dischargeAllowed(neu, 60) > linie+0.001 {
		t.Fatalf("the return must lower the producers in the same evaluation: %+v, line %.3f", neu, linie)
	}
	// 112 kW ramp minus the rise of 100 kW (charge -100 -> discharge held at 0)
	if math.Abs(neu.CapKw-12) > 1e-9 || dischargeAllowed(neu, 60) != 0 {
		t.Fatalf("cap %.3f discharge %.3f, want 12 and 0", neu.CapKw, dischargeAllowed(neu, 60))
	}
}

// Anlauf: the first evaluation knows no push before it - push 0, so a
// commanded discharge is a rise at once. The two-agent warm-up showed 158 kW
// at the connection point without it (PV law 68 kW + 60 kW discharge on 30
// kW of the partner), with it 98 kW.
func TestAnlaufErsteAuswertungZaehltEntladung(t *testing.T) {
	fahre := func() ExportCap {
		l := NewExportLimiter()
		l.ObserveMitSpeicher(r9t0, -130, 100, ptr(0))
		return l.CapAnteil(r9t0, &grenze100, halle1, 60)
	}
	alt := func() ExportCap {
		ohneAnlauf = true
		defer func() { ohneAnlauf = false }()
		return fahre()
	}()
	neu := fahre()
	punkt := func(c ExportCap) float64 { return 30 + math.Min(100, c.CapKw) + dischargeAllowed(c, 60) }
	t.Logf("uems: Kappe %.1f kW + Entladung %.1f kW = Netzpunkt %.1f kW; geheilt: Kappe %.1f kW + Entladung %.1f kW = %.1f kW",
		alt.CapKw, dischargeAllowed(alt, 60), punkt(alt), neu.CapKw, dischargeAllowed(neu, 60), punkt(neu))
	if punkt(alt) < 150 {
		t.Fatalf("uems must let the first discharge through on the PV law: %.3f", punkt(alt))
	}
	if p := punkt(neu); p > grenze100-exportMargin(grenze100)+1e-9 {
		t.Fatalf("the first evaluation must count the discharge as a rise: connection point %.3f", p)
	}
}

// Property, ohne Toleranz: asLauf with the blind path - the own meter goes
// away at random for 4-13 evaluations, the plan comes back at random (charge
// <-> discharge, self-consumption) and the clock still jumps back once. On
// the ramp generation plus push never leave its line (V2 and V6 in every
// evaluation), blind past it never above the share, fresh never above the
// loop limit on the measurement read, never above the box without a share
// (V5). The mutation probe must break it.
func TestRampePlanRueckkehrV6(t *testing.T) {
	var summe asErgebnis
	for seed := int64(0); seed < 400; seed++ {
		e := asLauf{seed: seed, rampe: true}.fahre()
		if e.verletzt != "" {
			t.Fatalf("seed %d: %s", seed, e.verletzt)
		}
		summe.auswertungen += e.auswertungen
		summe.rueckkehr += e.rueckkehr
		summe.blind += e.blind
		summe.rampe += e.rampe
		summe.rampeAnstieg += e.rampeAnstieg
	}
	if summe.rampe < 2000 || summe.rampeAnstieg < 200 {
		t.Fatalf("the random sources do not reach the ramp: %+v", summe)
	}
	ohneRampenAnstieg = true
	defer func() { ohneRampenAnstieg = false }()
	rot := 0
	for seed := int64(0); seed < 400; seed++ {
		if (asLauf{seed: seed, rampe: true}).fahre().verletzt != "" {
			rot++
		}
	}
	if rot == 0 {
		t.Fatal("the mutation probe (as on uems) must break V6 on the ramp in some run")
	}
	t.Logf("%d evaluations, %d plan returns, %d blind, %d on the ramp checked against its line (%d with the push above its start); as on uems %d of 400 runs break V6",
		summe.auswertungen, summe.rueckkehr, summe.blind, summe.rampe, summe.rampeAnstieg, rot)
}
