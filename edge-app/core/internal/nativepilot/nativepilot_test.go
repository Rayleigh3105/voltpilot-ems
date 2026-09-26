package nativepilot

import (
	"math"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

func f(v float64) *float64 { return &v }

func okCond() Conditions {
	return Conditions{ControlEnabled: true, Certified: true, RemotePath: true, RatedKw: 30,
		MeasurementAge: 3 * time.Second, SocPct: f(50), FloorPct: f(20), SocMaxPct: 95}
}

func started(t *testing.T, req Request) *Session {
	t.Helper()
	s := New()
	if _, err := s.Start(req, okCond(), t0); err != nil {
		t.Fatal(err)
	}
	return s
}

func obs(grid, batt, soc float64) Observation {
	return Observation{GridKw: f(grid), BatteryKw: f(batt), SocPct: f(soc)}
}

func proof(s *Session, at time.Time, intent string) {
	s.NoteReadback(Readback{Native: true, Intent: intent, Candidate: s.run.Req.Candidate,
		GridChargeBlocked: f2b(true), Wrote: true}, at)
}

func f2b(b bool) *bool { return &b }

func TestStartRefusesWithAGermanReason(t *testing.T) {
	cases := []struct {
		name string
		req  Request
		mut  func(*Conditions)
		want string
	}{
		{"unknown candidate", Request{Candidate: "grid_one"}, nil, "Kandidat"},
		{"unknown intent", Request{Candidate: CandidateGridZero, Intent: "cover_load"}, nil, "Absicht"},
		{"unknown case", Request{Candidate: CandidateGridZero, Case: "F7"}, nil, "Prüffall"},
		{"over 15 minutes", Request{Candidate: CandidateGridZero, Minutes: 16}, nil, "1 bis 15"},
		{"kill switch", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.ControlEnabled = false }, "Not-Aus"},
		{"not certified", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.Certified = false }, "First-Light"},
		{"ToU path", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.RemotePath = false }, "1100-1121"},
		{"other test", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.OtherTest = true }, "anderer Test"},
		{"stale", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.MeasurementAge = 20 * time.Second }, "älter"},
		{"no floor", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.FloorPct = nil }, "Reserve-Untergrenze"},
		{"at floor", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.SocPct = f(22) }, "Reserve"},
		{"full", Request{Candidate: CandidateGridZero}, func(c *Conditions) { c.SocPct = f(96) }, "95 %"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cond := okCond()
			if c.mut != nil {
				c.mut(&cond)
			}
			_, err := New().Start(c.req, cond, t0)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want refusal containing %q, got %v", c.want, err)
			}
		})
	}
	s := started(t, Request{Candidate: CandidateGridZero})
	if _, err := s.Start(Request{Candidate: CandidateOwnConfig}, okCond(), t0.Add(time.Second)); err == nil {
		t.Fatal("one run at a time")
	}
}

// ⚠ The 15-minute cap is structural: no request can outlive it, and the run
// ends by itself without any observation or operator action.
func TestAtMostFifteenMinutesAndItEndsByItself(t *testing.T) {
	s := started(t, Request{Candidate: CandidateGridZero, Minutes: 15})
	if got := s.run.Deadline.Sub(t0); got != MaxDuration {
		t.Fatalf("deadline %v", got)
	}
	at := t0
	for at.Before(t0.Add(MaxDuration)) {
		at = at.Add(5 * time.Second)
		s.Observe(obs(0, 3, 50), at)
		if at.Sub(t0) == 10*time.Second {
			proof(s, at, IntentSelfConsume)
		}
		if _, ok := s.Publish(at, true); !ok {
			break
		}
	}
	if s.Active() || s.run.end.Code != EndDeadline || at.Sub(t0) != MaxDuration {
		t.Fatalf("must end exactly at 15 min: %v %+v", at.Sub(t0), s.run.end)
	}
	if _, ok := s.Publish(at.Add(time.Second), true); ok {
		t.Fatal("an ended run publishes nothing")
	}
	// The default is 10 minutes.
	if d := started(t, Request{Candidate: CandidateGridZero}).run.Deadline.Sub(t0); d != DefaultDuration {
		t.Fatalf("default %v", d)
	}
}

func TestF5EndsAtTheSlotBoundary(t *testing.T) {
	s := New()
	c := okCond()
	c.SlotEnd = t0.Add(7 * time.Minute)
	if _, err := s.Start(Request{Candidate: CandidateGridZero, Case: "f5"}, c, t0); err != nil {
		t.Fatal(err)
	}
	proof(s, t0.Add(10*time.Second), IntentSelfConsume)
	for at := t0.Add(5 * time.Second); !at.After(t0.Add(7 * time.Minute)); at = at.Add(5 * time.Second) {
		s.Observe(obs(0, 3, 50), at)
		s.Publish(at, true)
	}
	if s.run.end == nil || s.run.end.Code != EndSlot || !s.run.endedAt.Equal(t0.Add(7*time.Minute)) {
		t.Fatalf("F5 ends at the slot boundary: %+v", s.run.end)
	}
	// Aftercare: the plan's transition is recorded for a minute.
	sp := -30.0
	for i, b := range []float64{-5, -20, -29, -31, -30, -29.8, -30, -30} {
		o := obs(0, b, 50)
		o.SetpointKw = &sp
		s.Observe(o, t0.Add(7*time.Minute).Add(time.Duration(i+1)*5*time.Second))
	}
	v := s.Snapshot(t0.Add(9 * time.Minute))
	if len(v.Aftercare) != 8 || v.AftercareSummary == nil || v.AftercareSummary.OvershootKw == nil ||
		math.Abs(*v.AftercareSummary.OvershootKw-1) > 1e-9 || *v.AftercareSummary.ErrorAt30sKw != 0.2 {
		t.Fatalf("aftercare: %+v %+v", v.Aftercare, v.AftercareSummary)
	}
}

func TestAbortEnvelope(t *testing.T) {
	type step struct {
		dt         time.Duration
		grid, batt float64
		soc        float64
	}
	cases := []struct {
		name  string
		steps []step
		want  string
	}{
		{"export above 33 kW is immediate", []step{{5 * time.Second, -33.5, 0, 50}}, AbortExport},
		{"import above 5 kW for more than 10 s", []step{{5 * time.Second, 6, 0, 50}, {5 * time.Second, 6, 0, 50}, {5 * time.Second, 6, 0, 50}, {5 * time.Second, 6, 0, 50}}, AbortImport},
		{"reserve floor", []step{{5 * time.Second, 0, -3, 23}}, AbortFloor},
		{"charging from the grid for over a minute", func() []step {
			var out []step
			for i := 0; i < 14; i++ {
				out = append(out, step{5 * time.Second, 1, 2, 50})
			}
			return out
		}(), TakeBackGridLoad},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := started(t, Request{Candidate: CandidateGridZero})
			proof(s, t0.Add(time.Second), IntentSelfConsume)
			at := t0
			for _, st := range c.steps {
				at = at.Add(st.dt)
				s.Observe(obs(st.grid, st.batt, st.soc), at)
			}
			if s.Active() || s.run.end.Code != c.want || s.run.end.Text == "" {
				t.Fatalf("want %s, got %+v", c.want, s.run.end)
			}
		})
	}
	// Import above 5 kW that breaks before 10 s restarts its clock.
	s := started(t, Request{Candidate: CandidateGridZero})
	for i, g := range []float64{6, 6, 1, 6, 6, 1, 6, 6} {
		s.Observe(obs(g, 0, 50), t0.Add(time.Duration(i+1)*5*time.Second))
	}
	if !s.Active() {
		t.Fatalf("a broken import must not abort: %+v", s.run.end)
	}
}

func TestStaleTelemetryAndMissingProofAbort(t *testing.T) {
	s := started(t, Request{Candidate: CandidateGridZero})
	proof(s, t0.Add(5*time.Second), IntentSelfConsume)
	s.Observe(obs(0, 2, 50), t0.Add(5*time.Second))
	if _, ok := s.Publish(t0.Add(20*time.Second), true); !ok {
		t.Fatal("15 s is still fresh")
	}
	if _, ok := s.Publish(t0.Add(21*time.Second), true); ok || s.run.end.Code != AbortStale {
		t.Fatalf("older than 15 s aborts: %+v", s.run.end)
	}
	// No proof within the grace -> ends with Layer 1's own reason.
	s = started(t, Request{Candidate: CandidateOwnConfig})
	s.NoteReadback(Readback{Refusal: "Arbeitsmodus „Selling First“ …"}, t0.Add(10*time.Second))
	for at := t0.Add(5 * time.Second); at.Before(t0.Add(70 * time.Second)); at = at.Add(5 * time.Second) {
		s.Observe(obs(0, 0, 50), at)
		s.Publish(at, true)
	}
	if s.Active() || s.run.end.Code != AbortUnproven || !strings.Contains(s.run.end.Text, "Selling First") {
		t.Fatalf("unproven: %+v", s.run.end)
	}
	// Kill switch.
	s = started(t, Request{Candidate: CandidateGridZero})
	if _, ok := s.Publish(t0.Add(time.Second), false); ok || s.run.end.Code != AbortControlOff {
		t.Fatalf("kill switch: %+v", s.run.end)
	}
}

func TestTwoReadbackFailuresAndTheEEGProof(t *testing.T) {
	s := started(t, Request{Candidate: CandidateGridZero})
	s.NoteReadback(Readback{Native: false}, t0.Add(5*time.Second)) // the reading tick: expected
	proof(s, t0.Add(15*time.Second), IntentSelfConsume)
	s.NoteReadback(Readback{Native: false, Mismatch: true}, t0.Add(25*time.Second))
	if !s.Active() {
		t.Fatal("one failure is not two")
	}
	proof(s, t0.Add(35*time.Second), IntentSelfConsume)
	s.NoteReadback(Readback{Native: false, Mismatch: true}, t0.Add(45*time.Second))
	s.NoteReadback(Readback{Native: true, Intent: IntentSurplus, GridChargeBlocked: f2b(true)}, t0.Add(55*time.Second))
	if s.Active() || s.run.end.Code != AbortReadback {
		t.Fatalf("two in a row (a foreign intent is no proof): %+v", s.run.end)
	}
	s = started(t, Request{Candidate: CandidateGridZero})
	s.NoteReadback(Readback{GridChargeBlocked: f2b(false)}, t0.Add(5*time.Second))
	if s.Active() || s.run.end.Code != AbortGridCharge {
		t.Fatalf("the device said it may grid-charge: %+v", s.run.end)
	}
	s = started(t, Request{Candidate: CandidateGridZero})
	s.NoteReadback(Readback{Native: true, Intent: IntentSelfConsume}, t0.Add(5*time.Second))
	if s.Active() || s.run.end.Code != AbortGridCharge {
		t.Fatalf("proven without the grid-charge answer is no proof: %+v", s.run.end)
	}
}

func TestGridZeroTakesBackWhereItWouldThrottleItsOwnPv(t *testing.T) {
	s := started(t, Request{Candidate: CandidateGridZero})
	proof(s, t0.Add(time.Second), IntentSelfConsume)
	s.Observe(obs(0, 5, 92.5), t0.Add(5*time.Second))
	if s.Active() || s.run.end.Code != TakeBackPvCurt {
		t.Fatalf("SoC at ceiling-3: %+v", s.run.end)
	}
	s = started(t, Request{Candidate: CandidateGridZero})
	proof(s, t0.Add(time.Second), IntentSelfConsume)
	for i := 1; i <= 14; i++ {
		s.Observe(obs(-2, 29.8, 60), t0.Add(time.Duration(i)*5*time.Second))
	}
	if s.Active() || s.run.end.Code != TakeBackPvCurt || s.run.end.Kind != "ruecknahme" {
		t.Fatalf("at the charge limit while exporting > 60 s: %+v", s.run.end)
	}
	// own_config has no such side effect: it runs on to 95 % (F11 end).
	s = started(t, Request{Candidate: CandidateOwnConfig})
	proof(s, t0.Add(time.Second), IntentSelfConsume)
	s.Observe(obs(0, 5, 93), t0.Add(5*time.Second))
	if !s.Active() {
		t.Fatalf("own_config: %+v", s.run.end)
	}
	s.Observe(obs(0, 5, 95), t0.Add(10*time.Second))
	if s.Active() || s.run.end.Code != EndCeiling || s.run.end.Kind != "ende" {
		t.Fatalf("95 %% ends F11: %+v", s.run.end)
	}
}

func TestMetrics(t *testing.T) {
	s := started(t, Request{Candidate: CandidateGridZero, Intent: IntentSurplus})
	proof(s, t0.Add(time.Second), IntentSurplus)
	// 10 s of 2 kW import while charging 3 kW -> 2 kW "Netz in den Speicher".
	// Then an excursion to -6 kW export (headroom) that settles; then a swing.
	seq := []struct{ grid, batt float64 }{
		{0, 3}, {2, 3}, {2, 3}, {-6, 3}, {-3, 3}, {-0.4, 3}, {0.8, 3}, {-0.8, 3}, {0, 3},
	}
	for i, x := range seq {
		s.Observe(obs(x.grid, x.batt, 50), t0.Add(time.Duration(i+1)*5*time.Second))
	}
	v := s.Snapshot(t0.Add(time.Minute)).Metrics
	// 2 kW for 10 s, and the 0.8-kW swing sample for 5 s (rounded to Wh).
	if math.Abs(v.GridToStorageKwh-(2*10.0+0.8*5)/3600) > 1e-3 {
		t.Fatalf("grid->storage %v", v.GridToStorageKwh)
	}
	if math.Abs(v.ExportHeadroomKwh-(6+3+0.4+0.8)*5/3600) > 1e-3 {
		t.Fatalf("export with headroom %v", v.ExportHeadroomKwh)
	}
	// One excursion: it starts at +2 kW (10 s), peaks at -6 kW and is back
	// within 10 % of that peak at -0.4 kW (30 s).
	if v.Jumps != 1 || v.T90MaxS != 20 {
		t.Fatalf("jumps %d, T90 max %v", v.Jumps, v.T90MaxS)
	}
	if v.SwingCycles != 3 {
		t.Fatalf("swing cycles %d", v.SwingCycles)
	}
	if v.WriteCycles != 1 || v.ProvenAfterS == nil || *v.ProvenAfterS != 1 {
		t.Fatalf("writes/proof %+v", v)
	}
	if v.MaxExportKw != 6 || v.MaxImportKw != 2 {
		t.Fatalf("extremes %+v", v)
	}
}

// Both candidates against a Deye model with the MEASURED timings (K1/K4b):
// the register block refreshes every 5-25 s (Solarman), a box command is
// followed after 15-20 s - but in its own regulation the device acts on its
// own meter within a second. Herzogau: 2 x Fronius Eco (AC-coupled, the Deye
// CT sees them) plus the Deye's own PV. F11 asks: does the storage take the
// Fronius surplus (export <= 0.5 kW until the charge limit or 95 %)?
//
// grid_zero regulates the grid meter - it sees the Fronius. own_config in the
// model does NOT (the open question D of the concept: "Selling First" charges
// from its own DC surplus): its export shows up as "Einspeisung trotz freier
// Ladeleistung", which is exactly the number the pilot has to deliver.
func runF11Model(t *testing.T, candidate string, seesForeign bool) Metrics {
	t.Helper()
	s := started(t, Request{Candidate: candidate, Intent: IntentSurplus, Case: "F11", Minutes: 15})
	refresh := []float64{5, 25, 12, 8, 20, 15, 6, 25, 10} // s, the Solarman cadence
	batt, soc := 0.0, 50.0
	nextReg, ri := 0.0, 0
	regGrid, regBatt := 0.0, 0.0
	for step := 0; step <= 600; step++ {
		tt := float64(step)
		now := t0.Add(time.Duration(step) * time.Second)
		load := 6.0
		deyePv := 4.0
		fronius := 18.0 + 4*math.Sin(tt/40) // a hazy afternoon
		var target float64
		if tt < 40 {
			target = 0 // still the box follower holding the battery
		} else if seesForeign {
			target = fronius + deyePv - load
		} else {
			target = deyePv - load
		}
		target = math.Max(0, math.Min(30, target)) // E-up: never discharge
		batt += (target - batt) * (1 - math.Exp(-1/0.8))
		soc += batt / 3600 / 100 * 100
		grid := load + batt - deyePv - fronius
		// The logger refreshes its registers every 5-25 s; Node-RED polls every
		// 5 s and the core sees whatever the logger holds (a repeated value is
		// still a fresh TELEMETRY message).
		if tt >= nextReg {
			regGrid, regBatt = grid, batt
			nextReg = tt + refresh[ri%len(refresh)]
			ri++
		}
		if step%5 == 0 {
			s.Observe(Observation{GridKw: f(regGrid), BatteryKw: f(regBatt), SocPct: f(soc)}, now)
		}
		if step%10 == 0 {
			if tt >= 40 {
				proof(s, now, IntentSurplus)
			}
			if _, ok := s.Publish(now, true); !ok {
				break
			}
		}
	}
	return s.Snapshot(t0.Add(11 * time.Minute)).Metrics
}

func TestF11BothCandidatesAgainstTheDeyeModel(t *testing.T) {
	gz := runF11Model(t, CandidateGridZero, true)
	oc := runF11Model(t, CandidateOwnConfig, false)
	// A device that follows the Fronius with a lag imports for moments while it
	// charges - a few Wh, far below the F11 concern.
	if gz.GridToStorageKwh > 0.01 || oc.GridToStorageKwh > 0.01 {
		t.Fatalf("E-up must not charge from the grid: %v %v", gz.GridToStorageKwh, oc.GridToStorageKwh)
	}
	// The first 40 s (box follower, battery held) export in both runs; after the
	// hand-over only the candidate that sees the Fronius keeps the grid at ~0.
	if !(oc.ExportHeadroomKwh > 5*gz.ExportHeadroomKwh) {
		t.Fatalf("the model must separate the candidates: grid_zero %.3f kWh vs own_config %.3f kWh",
			gz.ExportHeadroomKwh, oc.ExportHeadroomKwh)
	}
	if gz.MeanAbsGridKw > 2 || oc.MeanAbsGridKw < 10 {
		t.Fatalf("mean |grid|: grid_zero %.2f, own_config %.2f", gz.MeanAbsGridKw, oc.MeanAbsGridKw)
	}
	t.Logf("F11 model: grid_zero export-with-headroom %.3f kWh, mean|grid| %.2f kW, T90 max %.0f s; own_config %.3f kWh, %.2f kW",
		gz.ExportHeadroomKwh, gz.MeanAbsGridKw, gz.T90MaxS, oc.ExportHeadroomKwh, oc.MeanAbsGridKw)
}
