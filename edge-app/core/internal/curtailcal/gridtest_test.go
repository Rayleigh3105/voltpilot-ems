package curtailcal

import (
	"strings"
	"testing"
	"time"
)

// Der Netz-Sollwert-Test (Konzept `vp-deye-netzseitig-drossel-k2` P1) ist die
// REINE Haelfte des Testpfads: Zustandsautomat, Zulassung, Abbruch-Huelle und
// Urteil - ohne Bus, ohne Uhr, ohne Register. Deshalb ist hier jede tragende
// Regel ohne einen einzigen Container pruefbar.

func f(v float64) *float64 { return &v }

// okCond ist die Lage, in der ein Lauf zulaessig ist: alle drei Tore offen,
// Nennleistung bekannt, frische Messung, satte Einspeisung, ruhige Erzeugung.
func okCond() GridConditions {
	return GridConditions{
		Mode:           GridModeGrid,
		ControlEnabled: true,
		Certified:      true,
		RemotePath:     true,
		RatedKw:        30,
		MeasurementAge: 2 * time.Second,
		GridKw:         f(-24.9),
		SitePvKw:       f(45),
		DeyePvKw:       f(21),
		FroniusPvKw:    f(24),
		BatteryKw:      f(0),
		SocPct:         f(52),
		PvStableFor:    2 * time.Minute,
		PlanBatteryOk:  true,
		FroniusHealthy: true,
	}
}

func TestGridStartRefusesEveryOpenGate(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		mut   func(*GridConditions)
		needle string
	}{
		{"Not-Aus", func(c *GridConditions) { c.ControlEnabled = false }, "Not-Aus"},
		{"nicht freigegeben", func(c *GridConditions) { c.Certified = false }, "freigegeben"},
		{"kein Fernsteuerpfad", func(c *GridConditions) { c.RemotePath = false }, "1100-1121"},
		{"Nennleistung unbekannt", func(c *GridConditions) { c.RatedKw = 0 }, "Nennleistung"},
		{"Messwerte alt", func(c *GridConditions) { c.MeasurementAge = time.Minute }, "älter"},
		{"Selbstregel-Slot", func(c *GridConditions) { c.PlanNative = true }, "Automatik"},
		{"Entlade-Slot", func(c *GridConditions) { c.PlanBatteryOk = false }, "entladen"},
		{"Fronius unbestaetigt", func(c *GridConditions) { c.FroniusHealthy = false }, "Fronius"},
		{"zu wenig Einspeisung", func(c *GridConditions) { c.GridKw = f(-1) }, "speist gerade nur"},
		{"zu wenig Anlagen-PV", func(c *GridConditions) { c.SitePvKw = f(5) }, "mindestens 25"},
		{"zu wenig Deye-Anteil", func(c *GridConditions) { c.DeyePvKw = f(1) }, "Deye"},
		{"Erzeugung unruhig", func(c *GridConditions) { c.PvStableFor = 5 * time.Second }, "ruhig"},
		{"Ladestand zu hoch", func(c *GridConditions) { c.SocPct = f(95) }, "Ladestand"},
		{"Ladestand zu niedrig", func(c *GridConditions) { c.SocPct = f(10) }, "Ladestand"},
		{"unbekannte Testart", func(c *GridConditions) { c.Mode = "quatsch" }, "Testart"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := NewGrid()
			c := okCond()
			tc.mut(&c)
			run, err := s.Start(c, t0)
			if err == nil {
				t.Fatalf("%s: der Lauf wurde zugelassen, obwohl er es nicht darf", tc.name)
			}
			if run != nil {
				t.Fatalf("%s: ein abgelehnter Start darf keinen Lauf zurueckgeben", tc.name)
			}
			if !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("%s: der Grund nennt %q nicht: %s", tc.name, tc.needle, err.Error())
			}
			// Eine Ablehnung armiert NICHTS - der Sollwert-Pfad bleibt unberuehrt.
			if s.Engaged(t0) {
				t.Fatalf("%s: eine Ablehnung darf den Sollwert nie beanspruchen", tc.name)
			}
			if _, own := s.Publish(t0); own {
				t.Fatalf("%s: eine Ablehnung darf nichts veroeffentlichen", tc.name)
			}
		})
	}
}

// Die Schrittfolge IST die Sicherheit (Konzept §3.2 + Captain-Entscheid E2/E5):
// Neutralschritt -> Halten (20 s Beobachtung mit 1115 = 1000) -> PV-Kappe 999
// -> kleiner Schritt -> Null-Export. Und der Neutralschritt wird nur beim
// SEITENWECHSEL emittiert, nie in jedem Takt.
func TestGridStepSequenceAndNeutralOnlyOnSideChange(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Das Halte-Ziel latcht am Ende des Neutralschrittes.
	s.Observe(GridObservation{GridKw: f(-24.9), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52), BatteryKw: f(0)}, t0.Add(5*time.Second))

	// ⚠ `Neutralize` markiert den TAKT, der die Regelseite WECHSELT (dann muss
	// 1109 VOR 1104 auf 0) - nicht den Neutralschritt selbst. Der ist bereits
	// die batterieseitige Ruhe; ihn zusaetzlich zu markieren hiesse, den
	// Vorgaenger-Zustand fuer einen Wechsel zu halten, den es nicht gab.
	type want struct {
		at        time.Duration
		step      string
		side      string
		neutral   bool
		target    *float64
		pvCap     bool
	}
	wants := []want{
		{0, GridStepNeutral, GridSideBattery, false, f(0), false},
		{5 * time.Second, GridStepNeutral, GridSideBattery, false, f(0), false},
		{gridDurNeutral, GridStepHalten, GridSideGrid, true, f(-24.9), false},
		{gridDurNeutral + 5*time.Second, GridStepHalten, GridSideGrid, false, f(-24.9), false},
		{gridDurNeutral + gridDurHalten, GridStepPvKappe, GridSideGrid, false, f(-24.9), true},
		{gridDurNeutral + gridDurHalten + gridDurPvKappe, GridStepSchritt, GridSideGrid, false, f(-22.9), true},
		{gridDurNeutral + gridDurHalten + gridDurPvKappe + gridDurSchritt, GridStepNullExport, GridSideGrid, false, f(0), true},
	}
	for _, w := range wants {
		cmd, own := s.Publish(t0.Add(w.at))
		if !own {
			t.Fatalf("+%s: der Testpfad muss den Sollwert besitzen", w.at)
		}
		if cmd.Step != w.step || cmd.Side != w.side {
			t.Fatalf("+%s: Schritt/Seite = %s/%s, erwartet %s/%s", w.at, cmd.Step, cmd.Side, w.step, w.side)
		}
		if cmd.Neutralize != w.neutral {
			t.Fatalf("+%s: Neutralschritt = %v, erwartet %v", w.at, cmd.Neutralize, w.neutral)
		}
		if (cmd.PvCapPermille != nil) != w.pvCap {
			t.Fatalf("+%s: PV-Kappe geschrieben = %v, erwartet %v", w.at, cmd.PvCapPermille != nil, w.pvCap)
		}
		if w.pvCap && *cmd.PvCapPermille != GridPvCapPermille {
			t.Fatalf("+%s: PV-Kappe = %d, erwartet %d", w.at, *cmd.PvCapPermille, GridPvCapPermille)
		}
		if w.target == nil {
			if cmd.TargetKw != nil {
				t.Fatalf("+%s: es darf kein Ziel behauptet werden", w.at)
			}
		} else if cmd.TargetKw == nil {
			t.Fatalf("+%s: kein Ziel, erwartet %.2f", w.at, *w.target)
		} else if *cmd.TargetKw != *w.target {
			t.Fatalf("+%s: Ziel = %.3f, erwartet %.2f", w.at, *cmd.TargetKw, *w.target)
		}
	}
	// Die Summe der Schritte IST die TTL - kein Schritt faellt hinten herunter.
	if got := gridDurNeutral + gridDurHalten + gridDurPvKappe + gridDurSchritt + gridDurNullExport; got != GridDefaultTTL {
		t.Fatalf("die Schrittdauern summieren auf %s, die TTL ist %s", got, GridDefaultTTL)
	}
}

// ⚠ Der kleine Schritt geht NIE ueber 0 hinaus: ein positives Ziel waere ein
// BEZUGS-Ziel, und der Deye luede die Batterie aus dem Netz (EEG).
func TestGridStepNeverCommandsImport(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	c := okCond()
	c.GridKw = f(-4.5) // knapp ueber der Mindest-Einspeisung
	if _, err := s.Start(c, t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	s.Observe(GridObservation{GridKw: f(-1.0), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, t0.Add(5*time.Second))
	cmd, own := s.Publish(t0.Add(gridDurNeutral + gridDurHalten + gridDurPvKappe))
	if !own || cmd.Step != GridStepSchritt {
		t.Fatalf("erwartet den Schritt-Takt, bekam %s (own=%v)", cmd.Step, own)
	}
	if cmd.TargetKw == nil || *cmd.TargetKw > 0 {
		t.Fatalf("das Ziel des kleinen Schrittes darf nie positiv sein: %v", cmd.TargetKw)
	}
}

// Die TTL ist die Sicherheit, nicht die Oberflaeche: nach der Frist faehrt der
// Lauf die Rueckkehr und gibt den Sollwert danach frei - auch wenn niemand
// mehr zusieht.
func TestGridTTLReturnsToBatterySideOnItsOwn(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !s.Active(t0.Add(GridDefaultTTL - time.Second)) {
		t.Fatal("kurz vor der Frist muss der Lauf noch aktiv sein")
	}
	// Ein netzseitiger Takt, damit die Rueckkehr wirklich ein SEITENWECHSEL ist.
	s.Observe(GridObservation{GridKw: f(-24.9), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, t0.Add(5*time.Second))
	if cmd, _ := s.Publish(t0.Add(gridDurNeutral + time.Second)); cmd.Side != GridSideGrid {
		t.Fatalf("Vorbedingung: der Lauf muss netzseitig gewesen sein, war %s", cmd.Side)
	}
	after := t0.Add(GridDefaultTTL + time.Second)
	if s.Active(after) {
		t.Fatal("nach der Frist darf kein Schritt mehr laufen")
	}
	cmd, own := s.Publish(after)
	if !own {
		t.Fatal("die Rueckkehr gehoert zum Test - der Sollwert bleibt so lange beansprucht")
	}
	if cmd.Step != GridStepRueckkehr || cmd.Side != GridSideBattery {
		t.Fatalf("die Rueckkehr muss batterieseitig sein, bekam %s/%s", cmd.Step, cmd.Side)
	}
	if cmd.TargetKw == nil || *cmd.TargetKw != 0 {
		t.Fatalf("die Rueckkehr kommandiert 0, bekam %v", cmd.TargetKw)
	}
	if !cmd.Neutralize {
		t.Fatal("der Seitenwechsel zurueck braucht den Neutralschritt")
	}
	// Und danach ist der Pfad wirklich los.
	if _, own := s.Publish(after.Add(GridReturnGrace + time.Second)); own {
		t.Fatal("nach der Rueckkehr darf der Testpfad den Sollwert nicht mehr besitzen")
	}
}

func TestGridAbortStillReturns(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	at := t0.Add(30 * time.Second)
	s.Abort("Abbruch durch den Betreiber", at)
	if s.Active(at) {
		t.Fatal("ein abgebrochener Lauf faehrt keine Testschritte mehr")
	}
	cmd, own := s.Publish(at)
	if !own || cmd.Step != GridStepRueckkehr {
		t.Fatalf("abbrechen heisst ZURUECKNEHMEN, nicht aufhoeren zu schreiben: %s (own=%v)", cmd.Step, own)
	}
	if _, own := s.Publish(at.Add(GridReturnGrace + time.Second)); own {
		t.Fatal("nach der Rueckkehr ist der Pfad los")
	}
	ev := s.Evidence(at.Add(time.Second))
	if ev == nil || ev.Verdict != GridVerdictAborted {
		t.Fatalf("das Urteil eines Abbruchs ist %q, bekam %+v", GridVerdictAborted, ev)
	}
}

// ⚠ Ein zweimal NICHT bestaetigtes Register bricht ab - ein Testpfad, der
// gegen ein stummes Register weiterkommandiert, waere blind.
func TestGridUnconfirmedRegisterAborts(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	for i := 0; i < GridBadCyclesAbort; i++ {
		s.NoteRegister(false, t0.Add(time.Duration(10+i*10)*time.Second))
	}
	if s.Active(t0.Add(40 * time.Second)) {
		t.Fatal("nach zwei unbestaetigten Takten muss der Lauf abgebrochen sein")
	}
}

// Die Abbruch-Huelle aus §3.5: zu viel Export/Bezug, das nicht binnen der
// Kulanz zurueckkommt, beendet den Lauf. Ein kurzer Ausreisser NICHT.
func TestGridOutOfBandAbortsOnlyWhenItPersists(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	base := GridObservation{DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}

	// Kurzer Ausreisser: kein Abbruch.
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	o := base
	o.GridKw = f(-(GridMaxExportKw + 5))
	s.Observe(o, t0.Add(30*time.Second))
	o.GridKw = f(-20)
	s.Observe(o, t0.Add(33*time.Second))
	if !s.Active(t0.Add(40 * time.Second)) {
		t.Fatal("ein kurzer Ausreisser darf den Lauf nicht abbrechen")
	}

	// Anhaltend: Abbruch.
	s2 := NewGrid()
	if _, err := s2.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	o2 := base
	o2.GridKw = f(-(GridMaxExportKw + 5))
	s2.Observe(o2, t0.Add(30*time.Second))
	s2.Observe(o2, t0.Add(30*time.Second+GridOutOfBandGrace+time.Second))
	if s2.Active(t0.Add(60 * time.Second)) {
		t.Fatal("ein anhaltend zu grosser Export muss den Lauf beenden")
	}
}

func TestGridSocAndBatteryEnvelopeAbort(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		o    GridObservation
	}{
		{"Ladestand zu hoch", GridObservation{GridKw: f(-20), SocPct: f(GridAbortSocMaxPct + 1)}},
		{"Ladestand zu niedrig", GridObservation{GridKw: f(-20), SocPct: f(GridAbortSocMinPct - 1)}},
		{"Batterie zu stark", GridObservation{GridKw: f(-20), SocPct: f(52), BatteryKw: f(GridMaxBatteryKw + 1)}},
		{"Messwerte veraltet", GridObservation{GridKw: f(-20), SocPct: f(52), Age: 2 * GridMeasurementMaxAge}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewGrid()
			if _, err := s.Start(okCond(), t0); err != nil {
				t.Fatalf("Start: %v", err)
			}
			s.Observe(tc.o, t0.Add(20*time.Second))
			if s.Active(t0.Add(25 * time.Second)) {
				t.Fatalf("%s muss den Lauf beenden", tc.name)
			}
		})
	}
}

// ⚠ DER BEWEIS IST EIN PLATEAU AM ZIEL, nie ein einzelner Treffer - und er
// braucht ein GEHALTENES Register. Ein Register allein beweist nichts (die
// Fronius-Lehre), und ein einzelner Messwert im Band ist eine Wolke.
func TestGridProofNeedsPlateauAndHeldRegister(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	// (a) Register gehalten, aber der Netzpunkt folgt nicht -> kein Nachweis.
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	at := t0.Add(gridDurNeutral + gridDurHalten + gridDurPvKappe + gridDurSchritt + 5*time.Second)
	s.NoteRegister(true, at)
	for i := 0; i < GridPlateauSamples+2; i++ {
		s.Observe(GridObservation{GridKw: f(-18), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, at.Add(time.Duration(i)*time.Second))
	}
	ev := s.Evidence(t0.Add(GridDefaultTTL + time.Second))
	if ev == nil || ev.FollowObserved {
		t.Fatalf("ohne Plateau am Ziel darf keine Wirkung behauptet werden: %+v", ev)
	}
	if ev.Verdict != GridVerdictNoProof {
		t.Fatalf("Urteil = %q, erwartet %q", ev.Verdict, GridVerdictNoProof)
	}

	// (b) EIN einzelner Treffer am Ziel ist eine Wolkenluecke, kein Beweis.
	sOne := NewGrid()
	if _, err := sOne.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	// ⚠ GENAU EIN Messwert, bewusst als Literal: ein Plateau von 1 waere gar
	// kein Plateau, und der Fall soll umfallen, wenn jemand die Zahl senkt.
	if GridPlateauSamples < 2 {
		t.Fatalf("ein Plateau von %d ist kein Plateau", GridPlateauSamples)
	}
	sOne.NoteRegister(true, at)
	sOne.Observe(GridObservation{GridKw: f(0), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, at)
	evOne := sOne.Evidence(t0.Add(GridDefaultTTL + time.Second))
	if evOne == nil || evOne.FollowObserved {
		t.Fatalf("ein EINZELNER Treffer am Ziel ist kein Beweis: %+v", evOne)
	}

	// (c) Dieselben Messwerte AM ZIEL ueber das ganze Plateau -> bestanden.
	s2 := NewGrid()
	if _, err := s2.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	for i := 0; i < GridPlateauSamples+2; i++ {
		ts := at.Add(time.Duration(i) * time.Second)
		s2.NoteRegister(true, ts)
		s2.Observe(GridObservation{GridKw: f(0), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, ts)
	}
	ev2 := s2.Evidence(t0.Add(GridDefaultTTL + time.Second))
	if ev2 == nil || !ev2.FollowObserved {
		t.Fatalf("ein Plateau am Ziel IST die Wirkung: %+v", ev2)
	}
	if ev2.Verdict != GridVerdictPassed {
		t.Fatalf("Urteil = %q (%s), erwartet %q", ev2.Verdict, ev2.Reason, GridVerdictPassed)
	}
}

// Eine durchziehende Wolke ist eine Aussage ueber das WETTER, nie ueber den
// Wechselrichter: das Urteil heisst „nicht beweisbar" und nie „kein Nachweis".
func TestGridAmbientCollapseIsUnprovableNotAFailure(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	at := t0.Add(30 * time.Second)
	s.NoteRegister(true, at)
	s.Observe(GridObservation{GridKw: f(-20), DeyePvKw: f(21), FroniusPvKw: f(4), SocPct: f(52)}, at)
	ev := s.Evidence(t0.Add(GridDefaultTTL + time.Second))
	if ev == nil || ev.Verdict != GridVerdictUnprovable {
		t.Fatalf("eine eingebrochene Umgebung ergibt %q, bekam %+v", GridVerdictUnprovable, ev)
	}
	if ev.Reason == "" {
		t.Fatal("jedes Nicht-OK-Urteil traegt seinen Grund")
	}
}

// Der AC-Modus ist ein EIGENER, kuerzerer Lauf (E1): 60 s, eigene Schrittfolge,
// und sein Ziel liegt NIE ueber der gemessenen Deye-PV (sonst entlaedt der
// Wechselrichter die Batterie, um die AC-Leistung zu erreichen).
func TestGridAcProbeIsItsOwnShortRunAndNeverExceedsMeasuredPv(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	c := okCond()
	c.Mode = GridModeAc
	run, err := s.Start(c, t0)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if run.Deadline.Sub(t0) != GridAcTTL {
		t.Fatalf("die AC-Probe laeuft %s, erwartet %s", run.Deadline.Sub(t0), GridAcTTL)
	}
	s.Observe(GridObservation{GridKw: f(-24.9), DeyePvKw: f(21), FroniusPvKw: f(24), SocPct: f(52)}, t0.Add(5*time.Second))
	cmd, own := s.Publish(t0.Add(gridDurAcNeutral + time.Second))
	if !own || cmd.Step != GridStepAcProbe || cmd.Side != GridSideAc {
		t.Fatalf("erwartet die AC-Probe, bekam %s/%s (own=%v)", cmd.Step, cmd.Side, own)
	}
	if cmd.TargetKw == nil || *cmd.TargetKw > 21 {
		t.Fatalf("das AC-Ziel darf die gemessene Deye-PV nie ueberschreiten: %v", cmd.TargetKw)
	}
	if gridDurAcNeutral+gridDurAcProbe != GridAcTTL {
		t.Fatalf("die AC-Schrittdauern summieren nicht auf die AC-TTL")
	}
}

func TestGridSecondRunIsRefusedWhileOneIsEngaged(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := s.Start(okCond(), t0.Add(10*time.Second)); err == nil {
		t.Fatal("zwei gleichzeitige Laeufe darf es nie geben")
	}
	// Auch WAEHREND der Rueckkehr - der Sollwert gehoert noch dem Test.
	if _, err := s.Start(okCond(), t0.Add(GridDefaultTTL+time.Second)); err == nil {
		t.Fatal("waehrend der Rueckkehr ist der Sollwert noch belegt")
	}
	// Danach wieder.
	if _, err := s.Start(okCond(), t0.Add(GridDefaultTTL+GridReturnGrace+time.Second)); err != nil {
		t.Fatalf("nach der Rueckkehr muss ein neuer Lauf moeglich sein: %v", err)
	}
}

// Die Voraussetzungen werden EINZELN beurteilt - dieselbe Regel, mit der Start
// ablehnt, nur aufgeschluesselt, damit die Karte den fehlenden Punkt benennt.
func TestGridPreconditionsNameTheMissingPointAndAgreeWithStart(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	c := okCond()
	if failed := GridPreconditionsFailed(GridPreconditions(c)); len(failed) != 0 {
		t.Fatalf("die gute Lage darf keine offene Bedingung haben: %v", failed)
	}
	c.SocPct = f(96)
	pre := GridPreconditions(c)
	failed := GridPreconditionsFailed(pre)
	if len(failed) != 1 || !strings.Contains(failed[0], "Ladestand") {
		t.Fatalf("erwartet genau die Ladestand-Bedingung, bekam %v", failed)
	}
	// Und Start lehnt aus demselben Grund ab.
	if _, err := NewGrid().Start(c, t0); err == nil {
		t.Fatal("Start muss dieselbe Bedingung ablehnen")
	}
	// Jede Bedingung traegt einen Schluessel und ein Label.
	for _, p := range pre {
		if p.Key == "" || p.Label == "" {
			t.Fatalf("eine Bedingung ohne Schluessel/Label: %+v", p)
		}
	}
	// Der AC-Modus prueft die Einspeisung NICHT (er misst die AC-Leistung).
	c2 := okCond()
	c2.Mode = GridModeAc
	for _, p := range GridPreconditions(c2) {
		if p.Key == "export" {
			t.Fatal("die AC-Probe hat keine Einspeise-Bedingung")
		}
	}
}

// Der PV-Ruhe-Tracker: ein Sprung setzt die Ruhe zurueck, eine Luecke ebenso -
// eine Ruhe, die niemand gemessen hat, wird nie behauptet.
func TestGridPvTrackerResetsOnJumpAndGap(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	var tr GridPvTracker
	tr.Observe(40, t0)
	tr.Observe(40.5, t0.Add(30*time.Second))
	if got := tr.StableFor(t0.Add(60 * time.Second)); got < 60*time.Second {
		t.Fatalf("ruhige Erzeugung: StableFor = %s", got)
	}
	tr.Observe(40.5+GridPvJumpKw+1, t0.Add(70*time.Second))
	if got := tr.StableFor(t0.Add(75 * time.Second)); got > 10*time.Second {
		t.Fatalf("ein Sprung setzt die Ruhe zurueck, StableFor = %s", got)
	}
	var tr2 GridPvTracker
	tr2.Observe(40, t0)
	tr2.Observe(40, t0.Add(5*time.Minute)) // Luecke
	if got := tr2.StableFor(t0.Add(5*time.Minute + time.Second)); got > 10*time.Second {
		t.Fatalf("eine Messluecke setzt die Ruhe zurueck, StableFor = %s", got)
	}
}

// Die Sicht der Karte behauptet nie mehr, als der Lauf weiss.
func TestGridRunViewIsHonest(t *testing.T) {
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	s := NewGrid()
	if v := s.RunView(t0); v != nil {
		t.Fatal("ohne Lauf gibt es keine Sicht")
	}
	if _, err := s.Start(okCond(), t0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	v := s.RunView(t0.Add(5 * time.Second))
	if v == nil {
		t.Fatal("ein laufender Test hat eine Sicht")
	}
	if v.RegisterOk {
		t.Fatal("ohne Rueckmeldung darf kein bestaetigtes Register behauptet werden")
	}
	if v.PlateauRequired != GridPlateauSamples {
		t.Fatalf("PlateauRequired = %d, erwartet %d", v.PlateauRequired, GridPlateauSamples)
	}
	if v.SecondsRemaining <= 0 || v.SecondsRemaining > int(GridDefaultTTL/time.Second) {
		t.Fatalf("die Restzeit ist unplausibel: %d", v.SecondsRemaining)
	}
	if v.GridKw != nil || v.DeyePvKw != nil {
		t.Fatal("ohne Messtakt werden keine Messwerte behauptet")
	}
}
