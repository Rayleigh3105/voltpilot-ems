package otaupdater

// Der geraete-lokal GEMESSENE Neutral-Zeit-Nachweis (ota/neutral-verified.json,
// geschrieben vom gefuehrten First-Light-Test auf `:8484`,
// internal/neutralcal) muss dieselbe Torkette oeffnen wie ein
// VP_OTA_NEUTRAL_VERIFIED-Eintrag - aber NUR in dessen Abwesenheit, und ein
// unlesbarer/zu kurzer Beleg sperrt weiterhin.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
)

// Ein am Geraet gemessener, gespeicherter Nachweis oeffnet das Tor genauso
// wie ein Pruefstands-Eintrag - die steuernde Anlage tauscht.
func TestAMeasuredNeutralEvidenceFileOpensTheGateWithoutAnEnvEntry(t *testing.T) {
	r := newRig(t) // leere Tabelle - kein VP_OTA_NEUTRAL_VERIFIED-Eintrag
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	if err := otaapply.SaveNeutralRecord(r.dataDir, otaapply.NeutralRecord{
		Family: "hybrid_3p", Seconds: 90, MeasuredAt: r.now.Format(otaapply.TimeFormat),
		TestKw: 0.5, SettleSamples: 3,
	}); err != nil {
		t.Fatal(err)
	}

	r.tick()

	if r.fd.ran("pull") == 0 {
		t.Fatalf("ein gemessener Nachweis muss die steuernde Anlage tauschen lassen: %v", r.fd.log)
	}
	st := r.state()
	if st.Blocker == otaapply.BlockerNeutralTime {
		t.Fatalf("mit einem gemessenen Nachweis darf die Neutral-Zeit-Sperre nicht mehr stehen: %+v", st)
	}
}

// Ein VP_OTA_NEUTRAL_VERIFIED-Eintrag gewinnt IMMER - auch ein KLEINERER als
// der gemessene Wert -, denn der Betreiber hat bereits die konservative,
// wiederholte Pruefstands-Messung gemacht.
func TestAnEnvEntryWinsOverAMeasuredEvidenceFileEvenWhenSmaller(t *testing.T) {
	r := newRig(t)
	r.e.o.Neutral = mustTable(t, "hybrid_3p:10") // zu kurz fuer eine brauchbare Frist
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	if err := otaapply.SaveNeutralRecord(r.dataDir, otaapply.NeutralRecord{
		Family: "hybrid_3p", Seconds: 999, MeasuredAt: r.now.Format(otaapply.TimeFormat),
	}); err != nil {
		t.Fatal(err)
	}

	r.tick()

	// Die 10s der Umgebungsvariable sind zu kurz fuer eine Wachhund-Frist
	// (< MinWatchdogDeadline unter der Marge) - der gemessene 999s-Nachweis
	// darf das NIE ueberstimmen.
	if len(r.fd.log) != 0 {
		t.Fatalf("die Umgebungsvariable muss gewinnen und die zu kurze Frist muss weiterhin sperren: %v", r.fd.log)
	}
	st := r.state()
	if st.Blocker != otaapply.BlockerNeutralTooShort {
		t.Fatalf("erwartet BlockerNeutralTooShort (die Env-Zahl gewinnt), ist %+v", st)
	}
}

// Ein zu kurz GEMESSENER Nachweis (unter der Wachhund-Mindestfrist) sperrt
// weiterhin - eine Messung macht eine physikalisch zu kurze Neutral-Zeit
// nicht nutzbar, egal wie sie zustande kam.
func TestATooShortMeasuredEvidenceStillBlocks(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	if err := otaapply.SaveNeutralRecord(r.dataDir, otaapply.NeutralRecord{
		Family: "hybrid_3p", Seconds: 5, MeasuredAt: r.now.Format(otaapply.TimeFormat),
	}); err != nil {
		t.Fatal(err)
	}

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("ein zu kurzer Nachweis darf nichts tauschen lassen: %v", r.fd.log)
	}
	st := r.state()
	if st.Blocker != otaapply.BlockerNeutralTooShort {
		t.Fatalf("erwartet BlockerNeutralTooShort, ist %+v", st)
	}
}

// Eine unlesbare/kaputte Nachweis-Datei sperrt weiterhin wie ein fehlender
// Nachweis - niemals als Verifikation missverstanden.
func TestAnUnreadableMeasuredEvidenceFileStillBlocks(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	dir := otaapply.Dir(r.dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, otaapply.FileNeutralEvidence), []byte("{ kaputt"), 0o644); err != nil {
		t.Fatal(err)
	}

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("eine unlesbare Datei darf niemals als Nachweis gelten: %v", r.fd.log)
	}
	st := r.state()
	if st.Blocker != otaapply.BlockerNeutralTime {
		t.Fatalf("erwartet BlockerNeutralTime (unverifiziert), ist %+v", st)
	}
}

// Eine Nachweis-Datei mit einer FREMDEN/veralteten Schema-Version wird
// verworfen wie eine unlesbare - sie sperrt weiterhin.
func TestAnOutdatedSchemaVersionEvidenceFileStillBlocks(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = true })

	r.writeOta(otaapply.FileNeutralEvidence, map[string]any{
		"version": 999,
		"records": map[string]any{
			"hybrid_3p": map[string]any{"family": "hybrid_3p", "seconds": 90},
		},
	})

	r.tick()

	if len(r.fd.log) != 0 {
		t.Fatalf("eine fremde Schema-Version darf niemals als Nachweis gelten: %v", r.fd.log)
	}
	st := r.state()
	if st.Blocker != otaapply.BlockerNeutralTime {
		t.Fatalf("erwartet BlockerNeutralTime (unverifiziert), ist %+v", st)
	}
}

// Eine Anlage, die NICHT steuert, braucht ohnehin keinen Nachweis - der
// gemessene Beleg ist dann irrelevant, exakt wie ein Env-Eintrag es waere.
func TestAMeasuredEvidenceFileIsIrrelevantWithoutControl(t *testing.T) {
	r := newRig(t)
	r.assign(nil)
	r.signalCore(func(s *otaapply.CoreSignal) { s.ControlActive = false })

	r.tick()

	if r.fd.ran("pull") == 0 {
		t.Fatalf("eine nur lesende Anlage darf ohne jeden Nachweis tauschen: %v", r.fd.log)
	}
	if strings.Contains(r.state().Reason, "Neutral-Zeit") {
		t.Fatalf("eine nicht steuernde Anlage darf die Neutral-Zeit gar nicht erst nennen: %+v", r.state())
	}
}
