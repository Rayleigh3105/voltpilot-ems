package lastmgmt

import (
	"math/rand"
	"testing"
	"time"
)

func TestBezugsrampePlanRueckkehrSenktImSelbenTakt(t *testing.T) {
	tr := NewBudgetTracker()
	now := time.Date(2027, 6, 14, 22, 0, 0, 0, time.UTC)
	batt := -100.0
	set := Settings{GridLimitKw: 550}.WithDefaults()
	an := BezugAnteil{Fuehrt: true, AnteilKw: 77}
	tr.ObserveM(now, Measurement{GridKw: 495, ChargingKw: 122, Complete: true, BatteryPowerKw: &batt})
	tr.BezugSpeicherSoll(batt)
	tr.BudgetAnteil(now, set, an)
	tr.BudgetAnteil(now.Add(40*time.Second), set, an)
	if !tr.BezugSpeicherSoll(0) {
		t.Fatal("the lost discharge must wake the park")
	}
	v := tr.BudgetAnteil(now.Add(50*time.Second), set, an)
	if v.Kw != 7 {
		t.Fatalf("ramp 107 minus lost discharge 100: want 7, got %+v", v)
	}
	if v.Kw > tr.Budget(now.Add(50*time.Second), set).Kw {
		t.Fatal("V5 widened")
	}
	// A falling command never adds headroom to the unchanged ramp.
	tr.BezugSpeicherSoll(-120)
	if got := tr.BudgetAnteil(now.Add(50*time.Second), set, an).Kw; got != 107 {
		t.Fatalf("ramp changed: %.3f", got)
	}
}

// Random source extends the import properties with meter loss and repeated
// plan returns (+charge / -discharge / idle) during every second of the ramp.
// All values and the line slope are integers (60 kW steps / 60 s),
// so the command-side line and V5 need no floating-point tolerance.
func TestEigenschaftBezugEinSpielraumRampePlanRueckkehr(t *testing.T) {
	rng := rand.New(rand.NewSource(1078))
	now := time.Date(2027, 6, 14, 22, 0, 0, 0, time.UTC)
	auswertungen, rueckkehr := 0, 0
	for run := 0; run < 500; run++ {
		share := float64(60 * (1 + rng.Intn(3)))
		pv := float64(60 * rng.Intn(3))
		discharge := float64(60 * (1 + rng.Intn(3)))
		start := share + pv + discharge + float64(60*rng.Intn(4))
		tr := NewBudgetTracker()
		set := Settings{GridLimitKw: start, MarginPct: 0.000001}
		// WithDefaults retains this positive margin; at these sizes round3
		// still publishes exactly the integer connection limit.
		batt := -discharge
		tr.ObserveM(now, Measurement{GridKw: start + batt - pv, ChargingKw: start, Complete: true, BatteryPowerKw: &batt})
		tr.BezugSpeicherSoll(batt)
		an := BezugAnteil{Fuehrt: true, AnteilKw: share}
		initial := tr.BudgetAnteil(now, set, an).Kw
		// measuredBudget caps at the connection limit, so initial=start.
		if initial != start {
			t.Fatalf("source initial %.3f, want %.3f", initial, start)
		}
		for age := 31; age <= 90; age++ {
			cmd := []float64{-discharge, 0, pv}[rng.Intn(3)] // blind: charge <= own PV
			if cmd > batt {
				rueckkehr++
			}
			tr.BezugSpeicherSoll(cmd)
			n := now.Add(time.Duration(age) * time.Second)
			v := tr.BudgetAnteil(n, set, an)
			line := initial + batt - pv - ((initial+batt-pv-share)/60)*float64(age-30)
			net := v.Kw + cmd - pv
			if net > line || v.Kw > tr.Budget(n, set).Kw || v.Kw < 0 {
				t.Fatalf("run %d age %d: park %.3f, battery %.3f, PV %.3f, net %.3f kW > line %.3f kW", run, age, v.Kw, cmd, pv, net, line)
			}
			auswertungen++
		}
	}
	t.Logf("%d ramp evaluations, %d returns above the measured discharge; V5 and line held", auswertungen, rueckkehr)
}

// The co-controlling blind path has no ramp and never spends a measured
// discharge: park <= share - uncontrolled - reserve, battery <= own PV.
func TestBezugPlanRueckkehrBlindAmEigenenZaehler(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	now := time.Date(2027, 6, 14, 22, 0, 0, 0, time.UTC)
	for run := 0; run < 1000; run++ {
		share := float64(100 + rng.Intn(300))
		haus, reserve, pv := float64(rng.Intn(50)), float64(rng.Intn(50)), float64(rng.Intn(100))
		batt := -float64(rng.Intn(100))
		tr := NewBudgetTracker()
		tr.ObserveM(now, Measurement{GridKw: haus + reserve + share + batt - pv, ChargingKw: share, Complete: true, BatteryPowerKw: &batt})
		an := BezugAnteil{AnteilKw: share, ReserveKw: reserve, UngeregeltKw: haus}
		set := Settings{GridLimitKw: 600}.WithDefaults()
		tr.BezugSpeicherSoll(batt)
		tr.BudgetAnteil(now, set, an)
		for age := 31; age <= 120; age++ {
			cmd := pv // maximal blind charge, after discharge disappears
			tr.BezugSpeicherSoll(cmd)
			n := now.Add(time.Duration(age) * time.Second)
			v := tr.BudgetAnteil(n, set, an)
			if haus+reserve+v.Kw+cmd-pv > share || v.Kw > tr.Budget(n, set).Kw {
				t.Fatalf("run %d age %d: own feeder exceeds share: %+v", run, age, v)
			}
		}
	}
}
