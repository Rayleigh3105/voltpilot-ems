package otaapply

// Die Tore. Jeder Test hier beschreibt EINEN Grund, aus dem eine Box NICHT
// autonom aktualisiert - und die Faelle, in denen sie es darf.

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

func manifest() *otaverify.Manifest {
	return &otaverify.Manifest{
		SchemaVersion: otaverify.ManifestSchemaVersion,
		Release:       "edge-2026.08.0", ReleaseSeq: 12,
		TargetCommit: "3bf8c038a1b2", StateSchema: 3,
		Compat:       otaverify.Compat{Backends: []string{otaverify.BackendCompose}},
		SigningKeyID: "rel-2026-a",
		Artifacts: []otaverify.Artifact{
			{Type: otaverify.ArtifactOCIImage, Name: "core", Ref: "repo/core@sha256:" + strings.Repeat("a", 64)},
		},
	}
}

func okVerdict() otaverify.Verdict {
	return otaverify.Verdict{Outcome: otaverify.OutcomeOK, Manifest: manifest(),
		Reason: "Release edge-2026.08.0 ist verifiziert."}
}

var testNow = time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)

func freshSignal(mut func(*CoreSignal)) *CoreSignal {
	s := &CoreSignal{UpdatedAt: testNow.Format(TimeFormat), Version: "edge-2026.07.2-665d59b8",
		Healthy: true, CloudConnected: true, InverterFamily: "hybrid_3p"}
	if mut != nil {
		mut(s)
	}
	return s
}

func baseInput() DecisionInput {
	return DecisionInput{
		Autonomous: true, HasTarget: true, Verdict: okVerdict(),
		FreeBytes: 8 << 30, RequiredBytes: DefaultDiskGuardBytes,
		Signal: freshSignal(nil), Neutral: (*NeutralTable)(nil).For("hybrid_3p"),
		ConfiguredDeadline: 10 * time.Minute, Now: testNow,
	}
}

func TestSwitchOffIsTheDefaultAndNeedsNoComplaint(t *testing.T) {
	in := baseInput()
	in.Autonomous = false
	d := Decide(in)
	if d.Action != ActionIdle || d.State != StateIdle {
		t.Fatalf("ausgeschaltet muss idle sein, ist %v/%v", d.Action, d.State)
	}
	// „Ausgeschaltet" ist kein Befund ueber ein Release - ein Grund waere hier
	// eine Beschwerde ueber Nichts.
	if d.Reason != "" {
		t.Fatalf("ein ausgeschalteter Schalter braucht keinen Grund, hat aber: %q", d.Reason)
	}
}

func TestABrokenChainIsAFailureNotADeferral(t *testing.T) {
	in := baseInput()
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeRejected,
		Reason: "Die Signatur passt nicht zum Manifest."}
	d := Decide(in)
	if d.Action != ActionRefuse || d.State != StateFailed {
		t.Fatalf("gebrochene Kette muss failed sein, ist %v/%v", d.Action, d.State)
	}
	if !strings.Contains(d.Reason, "Signatur") {
		t.Fatalf("der Grund des Verifizierers muss durchgereicht werden: %q", d.Reason)
	}
}

func TestAPolicyStopIsADeferralWithItsOwnReason(t *testing.T) {
	in := baseInput()
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeDeferred,
		Reason: "Der Anti-Rollback-Boden ist nicht erfuellt."}
	d := Decide(in)
	if d.Action != ActionDefer || d.State != StateDeferred {
		t.Fatalf("Politik-Halt muss deferred sein, ist %v/%v", d.Action, d.State)
	}
	if !strings.Contains(d.Reason, "Boden") {
		t.Fatalf("Grund fehlt: %q", d.Reason)
	}
}

func TestAlreadyRunningIsSucceededNotAnApply(t *testing.T) {
	in := baseInput()
	v := okVerdict()
	v.AlreadyRunning = true
	in.Verdict = v
	if d := Decide(in); d.Action != ActionIdle || d.State != StateSucceeded {
		t.Fatalf("laufendes Release darf nicht erneut angewandt werden: %v/%v", d.Action, d.State)
	}
}

func TestAForeignBackendIsRefusedNeverGuessed(t *testing.T) {
	in := baseInput()
	m := manifest()
	m.Compat.Backends = []string{otaverify.BackendMender}
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeOK, Manifest: m}
	if d := Decide(in); d.Action != ActionRefuse {
		t.Fatalf("fremdes Backend muss abgelehnt werden, ist %v", d.Action)
	}
}

func TestAnOlderStateSchemaIsRefused(t *testing.T) {
	in := baseInput()
	in.StateSchemaOnDisk = 5 // das Release kann nur 3
	d := Decide(in)
	if d.Action != ActionRefuse {
		t.Fatalf("ein Release ohne unseren Datenstand muss abgelehnt werden, ist %v", d.Action)
	}
	if !strings.Contains(d.Reason, "state_schema") {
		t.Fatalf("der Grund muss das Gate benennen: %q", d.Reason)
	}
	// Gleich oder hoeher ist in Ordnung.
	in.StateSchemaOnDisk = 3
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("gleicher Datenstand muss anwenden duerfen, ist %v (%s)", d.Action, d.Reason)
	}
}

func TestASilentCoreStopsEverything(t *testing.T) {
	in := baseInput()
	in.Signal = &CoreSignal{UpdatedAt: testNow.Add(-5 * time.Minute).Format(TimeFormat)}
	d := Decide(in)
	if d.Action != ActionDefer {
		t.Fatalf("ohne Kern-Zustand darf nicht getauscht werden, ist %v", d.Action)
	}
	if !strings.Contains(d.Reason, "meldet seinen Zustand nicht") {
		t.Fatalf("Grund unklar: %q", d.Reason)
	}
	// Gar kein Signal ist derselbe Fall - und faellt NICHT in einen nil-Zugriff.
	in.Signal = nil
	if d := Decide(in); d.Action != ActionDefer {
		t.Fatalf("ohne Signal muss verschoben werden, ist %v", d.Action)
	}
}

func TestTheDiskGuardRefusesToSwapWithoutRoomForTheFallback(t *testing.T) {
	in := baseInput()
	in.FreeBytes = 100 << 20 // 100 MiB
	d := Decide(in)
	if d.Action != ActionDefer {
		t.Fatalf("zu wenig Platz muss verschieben, ist %v", d.Action)
	}
	if !strings.Contains(d.Reason, "Speicherplatz") || !strings.Contains(d.Reason, "MiB") {
		t.Fatalf("der Grund muss die Zahlen nennen: %q", d.Reason)
	}
}

// DIE Sicherheitsregel der Stufe: eine Familie ohne belegte Neutral-Zeit
// bekommt kein autonomes Anwenden, SOLANGE das Geraet wirklich steuert.
func TestAnUnverifiedNeutralTimeoutBlocksOnlyAControllingPlant(t *testing.T) {
	in := baseInput()
	in.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive = true })
	d := Decide(in)
	if d.Action != ActionRefuse {
		t.Fatalf("steuernde Anlage ohne belegtes T muss abgelehnt werden, ist %v", d.Action)
	}
	if !strings.Contains(d.Reason, "hybrid_3p") || !strings.Contains(d.Reason, "NICHT verifiziert") {
		t.Fatalf("der Grund muss die Familie benennen: %q", d.Reason)
	}

	// Die heutige Flotte LIEST nur: kein gehaltenes Kommando, also kein T-Risiko.
	in.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive = false })
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("eine nur lesende Anlage muss anwenden duerfen, ist %v (%s)", d.Action, d.Reason)
	}
}

func TestAVerifiedNeutralTimeoutCapsTheWatchdogUnderIt(t *testing.T) {
	tab, err := ParseNeutralTable("hybrid_3p:90")
	if err != nil {
		t.Fatal(err)
	}
	in := baseInput()
	in.Neutral = tab.For("hybrid_3p")
	in.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive = true })
	d := Decide(in)
	if d.Action != ActionApply {
		t.Fatalf("belegte Neutral-Zeit muss anwenden lassen, ist %v (%s)", d.Action, d.Reason)
	}
	// 90 s - Marge 18 s = 72 s, also strikt unter T.
	if d.Deadline != 72*time.Second {
		t.Fatalf("Frist %s, erwartet 72s", d.Deadline)
	}
	if d.Deadline >= in.Neutral.T {
		t.Fatalf("die Frist MUSS strikt unter T liegen (%s >= %s)", d.Deadline, in.Neutral.T)
	}
}

func TestATooShortNeutralTimeoutIsRefusedEvenWhenDeclaredVerified(t *testing.T) {
	tab, err := ParseNeutralTable("hybrid_3p:8")
	if err != nil {
		t.Fatal(err)
	}
	in := baseInput()
	in.Neutral = tab.For("hybrid_3p")
	in.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive = true })
	if d := Decide(in); d.Action != ActionRefuse {
		t.Fatalf("ein T ohne Platz fuer eine Frist muss abgelehnt werden, ist %v", d.Action)
	}
}

func TestTheMidWriteInterlockDefersAndTheUrgentPathParksNeutralFirst(t *testing.T) {
	tab, _ := ParseNeutralTable("hybrid_3p:120")
	in := baseInput()
	in.Neutral = tab.For("hybrid_3p")
	in.Signal = freshSignal(func(s *CoreSignal) {
		s.ControlActive = true
		s.Dispatching = true
		s.SetpointKw = -7.1
	})

	d := Decide(in)
	if d.Action != ActionDefer {
		t.Fatalf("mitten im Sollwert muss verschoben werden, ist %v", d.Action)
	}
	if !strings.Contains(d.Reason, "Zeitfensters") {
		t.Fatalf("Grund unklar: %q", d.Reason)
	}

	// Ein EILIGES Release verschiebt nicht - es laesst erst neutral stellen.
	m := manifest()
	m.Urgent = true
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeOK, Manifest: m}
	d = Decide(in)
	if d.Action != ActionNeutral {
		t.Fatalf("Eil-Release muss neutral stellen lassen, ist %v", d.Action)
	}

	// Steht die Anlage bestaetigt neutral, wird getauscht.
	in.Signal.NeutralHeldSince = testNow.Add(-30 * time.Second).Format(TimeFormat)
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("nach bestaetigter Neutralstellung muss getauscht werden, ist %v (%s)",
			d.Action, d.Reason)
	}
}

func TestEveryNonIdleOutcomeCarriesAGermanReason(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*DecisionInput)
	}{
		{"rejected", func(i *DecisionInput) {
			i.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeRejected, Reason: "kaputt"}
		}},
		{"deferred", func(i *DecisionInput) {
			i.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeDeferred, Reason: "Boden"}
		}},
		{"disk", func(i *DecisionInput) { i.FreeBytes = 1 }},
		{"stale-core", func(i *DecisionInput) { i.Signal = nil }},
		{"unverified-T", func(i *DecisionInput) {
			i.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive = true })
		}},
		{"interlock", func(i *DecisionInput) {
			tab, _ := ParseNeutralTable("hybrid_3p:120")
			i.Neutral = tab.For("hybrid_3p")
			i.Signal = freshSignal(func(s *CoreSignal) { s.ControlActive, s.Dispatching = true, true })
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := baseInput()
			c.mut(&in)
			d := Decide(in)
			if d.Action == ActionApply || d.Action == ActionIdle {
				t.Fatalf("erwartet wurde ein Halt, ist %v", d.Action)
			}
			if strings.TrimSpace(d.Reason) == "" {
				t.Fatal("jede rote Zeile traegt ihren Grund - dieser ist leer")
			}
		})
	}
}

func TestTheApplyingAckIsWaitedForButNotForever(t *testing.T) {
	st := &UpdaterState{AckToken: "abc"}

	// Noch keine Antwort, Frist laeuft: warten.
	if ok, _ := ApplyingAckDecision(st, nil, 5*time.Second, 45*time.Second); ok {
		t.Fatal("ohne Antwort und innerhalb der Frist muss gewartet werden")
	}
	// Bestaetigt: weiter, ohne Bemerkung.
	sig := &CoreSignal{AckToken: "abc", ApplyingAckedAt: testNow.Format(TimeFormat)}
	if ok, note := ApplyingAckDecision(st, sig, 5*time.Second, 45*time.Second); !ok || note != "" {
		t.Fatalf("bestaetigt muss ohne Bemerkung weitergehen (%v, %q)", ok, note)
	}
	// Der Kern SAGT, dass er nicht kann: sofort weiter, mit Bemerkung.
	sig = &CoreSignal{AckToken: "abc", AckFailed: true}
	ok, note := ApplyingAckDecision(st, sig, time.Second, 45*time.Second)
	if !ok || !strings.Contains(note, "keine Cloud-Verbindung") {
		t.Fatalf("ein gemeldeter Fehlschlag darf nicht ausgewartet werden (%v, %q)", ok, note)
	}
	// Frist abgelaufen: weiter, damit eine Box ohne Broker aktualisierbar bleibt.
	ok, note = ApplyingAckDecision(st, nil, time.Minute, 45*time.Second)
	if !ok || !strings.Contains(note, "nicht binnen") {
		t.Fatalf("nach der Frist muss weitergemacht werden (%v, %q)", ok, note)
	}
}

// Das Vokabular ist Vertrag seit Stufe 0 - die Konstanten dieses Pakets sind
// bewusst eine Kopie (der Sidecar soll keinen MQTT-Stack enthalten), also wird
// die Kopie festgenagelt.
func TestStateVocabularyMatchesTheCloudContract(t *testing.T) {
	want := map[string]string{
		"idle": StateIdle, "verifying": StateVerifying, "deferred": StateDeferred,
		"downloading": StateDownloading, "applying": StateApplying, "self_test": StateSelfTest,
		"succeeded": StateSucceeded, "failed": StateFailed, "rolled_back": StateRolledBack,
	}
	for k, v := range want {
		if k != v {
			t.Fatalf("Vertragswort %q ist hier %q", k, v)
		}
	}
}

// In der Fehlerinjektions-Matrix aufgefallen (Fall `selftest_fail`): ohne
// diesen Merkzettel begann der naechste Takt denselben Tausch von vorn - die
// Zuweisung liegt ja noch, und das Release laeuft nach der Ruecknahme immer
// noch nicht. Ein kaputtes Release haette die Box endlos durch Tausch und
// Ruecknahme geschickt, jedes Mal mit den Sekunden ohne Steuerung.
func TestARolledBackReleaseIsNeverAppliedAgainByItself(t *testing.T) {
	in := baseInput()
	in.Failed = &FailedRelease{Release: "edge-2026.08.0", ReleaseSeq: 12,
		Reason: "Der Selbsttest ist fehlgeschlagen"}

	d := Decide(in)
	if d.Action != ActionRefuse || d.State != StateRolledBack {
		t.Fatalf("ein hier zurueckgerolltes Release darf nicht erneut anlaufen: %v/%v",
			d.Action, d.State)
	}
	if !strings.Contains(d.Reason, "bereits") || !strings.Contains(d.Reason, "Selbsttest") {
		t.Fatalf("der Grund muss den frueheren Fehlschlag benennen: %q", d.Reason)
	}

	// Ein ANDERES Release laeuft normal - der Merkzettel sperrt genau eines.
	in.Failed = &FailedRelease{Release: "edge-2026.07.9", ReleaseSeq: 11}
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("ein anderes Release muss anwenden duerfen, ist %v (%s)", d.Action, d.Reason)
	}

	// Kein Merkzettel = kein Halt (und kein nil-Zugriff).
	in.Failed = nil
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("ohne Merkzettel muss angewandt werden, ist %v", d.Action)
	}
}
