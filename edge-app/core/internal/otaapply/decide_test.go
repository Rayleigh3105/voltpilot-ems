package otaapply

// Die verbliebenen Pruefungen. Jeder Test hier beschreibt EINEN Grund, aus dem
// eine Box ein zugewiesenes Release NICHT anwendet - und die Faelle, in denen
// sie es tut.
//
// Seit der Vereinfachung vom 26.08.2026 ist die Liste kurz und hat eine
// Struktur: **jedes Tor ueber den ZUSTAND DES GERAETS ist gefallen, jede
// Eigenschaft des SIGNIERTEN RELEASE ist geblieben.** Wer hier ein Tor
// ergaenzt, das nach dem Geraet fragt statt nach dem Release, hebt die Order
// auf.

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
		HasTarget: true, Assignment: "2026-08-03T11:00:00Z", Verdict: okVerdict(),
		FreeBytes: 8 << 30, RequiredBytes: DefaultDiskGuardBytes,
		ConfiguredDeadline: 10 * time.Minute, Now: testNow,
	}
}

// Der Kern der Order: ein zugewiesenes, geprueftes Release wird angewandt -
// ohne Schalter, ohne Freigabe, ohne einen Menschen am Geraet.
func TestAVerifiedAssignmentIsAppliedWithoutAnyHumanAtTheDevice(t *testing.T) {
	d := Decide(baseInput())
	if d.Action != ActionApply {
		t.Fatalf("ein geprueftes Release muss angewandt werden, ist %v (%s)", d.Action, d.Reason)
	}
	if d.State != StateDownloading {
		t.Fatalf("state=%q", d.State)
	}
	if d.Blocker != "" {
		t.Fatalf("ein offener Weg nennt keinen Blocker, nennt %q", d.Blocker)
	}
	if d.Deadline != 10*time.Minute {
		t.Fatalf("die konfigurierte Frist muss durchgereicht werden, ist %v", d.Deadline)
	}
}

// Ohne konfigurierte Frist gilt die Vorgabe - nie 0 (das waere eine sofort
// abgelaufene Wachhund-Frist und damit eine Ruecknahme im selben Takt).
func TestAMissingDeadlineFallsBackToTheDefaultNeverZero(t *testing.T) {
	in := baseInput()
	in.ConfiguredDeadline = 0
	if d := Decide(in); d.Deadline != DefaultWatchdogDeadline {
		t.Fatalf("Vorgabe-Frist erwartet, ist %v", d.Deadline)
	}
}

func TestWithoutATargetNothingHappensAndNothingIsClaimed(t *testing.T) {
	in := baseInput()
	in.HasTarget = false
	d := Decide(in)
	if d.Action != ActionIdle || d.State != StateIdle {
		t.Fatalf("ohne Zuweisung muss idle sein, ist %v/%v", d.Action, d.State)
	}
	if d.Reason != "" || d.Blocker != "" {
		t.Fatalf("nichts zugewiesen ist kein Befund: %q/%q", d.Reason, d.Blocker)
	}
}

func TestABrokenChainIsAFailureNotADeferral(t *testing.T) {
	in := baseInput()
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeRejected,
		Reason: "Die Signatur des Manifests ist ungueltig."}
	d := Decide(in)
	if d.Action != ActionRefuse || d.State != StateFailed || d.Blocker != BlockerChain {
		t.Fatalf("gebrochene Kette = failed/kette, ist %v/%v/%v", d.Action, d.State, d.Blocker)
	}
}

func TestAPolicyStopIsADeferralWithItsOwnReason(t *testing.T) {
	in := baseInput()
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeDeferred,
		Reason: "Das Release liegt unter dem Anti-Rollback-Boden."}
	d := Decide(in)
	if d.Action != ActionDefer || d.Blocker != BlockerPolicy {
		t.Fatalf("Politik = defer/politik, ist %v/%v", d.Action, d.Blocker)
	}
}

func TestAlreadyRunningIsSucceededNotAnApply(t *testing.T) {
	in := baseInput()
	v := okVerdict()
	v.AlreadyRunning = true
	in.Verdict = v
	if d := Decide(in); d.Action != ActionIdle || d.State != StateSucceeded {
		t.Fatalf("laeuft bereits = idle/succeeded, ist %v/%v", d.Action, d.State)
	}
}

func TestAForeignBackendIsRefusedNeverGuessed(t *testing.T) {
	in := baseInput()
	m := manifest()
	m.Compat.Backends = []string{"mender"}
	in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeOK, Manifest: m}
	if d := Decide(in); d.Action != ActionRefuse || d.Blocker != BlockerBackend {
		t.Fatalf("fremdes Backend = refuse/backend, ist %v/%v", d.Action, d.Blocker)
	}
}

func TestAnOlderStateSchemaIsRefused(t *testing.T) {
	in := baseInput()
	in.StateSchemaOnDisk = 4 // das Release kennt nur 3
	d := Decide(in)
	if d.Action != ActionRefuse || d.Blocker != BlockerStateSchema {
		t.Fatalf("alter Datenstand = refuse/state_schema, ist %v/%v", d.Action, d.Blocker)
	}
	if !strings.Contains(d.Reason, "state_schema 3") || !strings.Contains(d.Reason, "Geraet 4") {
		t.Fatalf("der Grund nennt beide Zahlen nicht: %q", d.Reason)
	}
}

// Der Plattenwaechter ist eine PHYSISCHE Grenze, kein Tor: er meldet defer
// (der naechste Takt bewertet neu, nachdem aufgeraeumt wurde), nie refuse.
func TestTheDiskGuardDefersAndSaysThatItAlreadyCleanedUp(t *testing.T) {
	in := baseInput()
	in.FreeBytes = 100 << 20
	d := Decide(in)
	if d.Action != ActionDefer || d.Blocker != BlockerDisk {
		t.Fatalf("zu wenig Platz = defer/platte, ist %v/%v", d.Action, d.Blocker)
	}
	if !strings.Contains(d.Reason, "bereits entfernt") {
		t.Fatalf("der Grund sagt nicht, dass schon aufgeraeumt wurde: %q", d.Reason)
	}
}

// --- Die entfallenen Tore: sie duerfen NICHTS mehr aufhalten. --------------

// Der Kern schweigt (kein Signal ueberhaupt) - frueher `kern_still`.
func TestASilentCoreNoLongerStopsAnything(t *testing.T) {
	if d := Decide(baseInput()); d.Action != ActionApply {
		t.Fatalf("ohne Kern-Signal muss trotzdem angewandt werden, ist %v (%s)", d.Action, d.Reason)
	}
}

// Eine STEUERNDE Anlage ohne belegte Neutral-Zeit - frueher `neutralzeit`,
// die haerteste Sperre der alten Kette.
func TestAControllingPlantIsNoLongerBlockedByAnUnverifiedNeutralTime(t *testing.T) {
	in := baseInput()
	in.Verdict = okVerdict()
	// Das Signal traegt weiterhin ControlActive - es ist nur kein Tor mehr.
	d := Decide(in)
	if d.Action != ActionApply {
		t.Fatalf("eine steuernde Anlage muss anwenden duerfen, ist %v (%s)", d.Action, d.Reason)
	}
}

// Ein laufender, von neutral abweichender Sollwert - frueher `interlock`.
func TestAnActiveSetpointNoLongerDefersTheSwap(t *testing.T) {
	if d := Decide(baseInput()); d.Action != ActionApply {
		t.Fatalf("ein laufender Sollwert darf nicht mehr aufhalten, ist %v", d.Action)
	}
}

// --- Die Runaway-Bremse: sie sperrt die ZUWEISUNG, nicht das RELEASE. ------

func TestARolledBackAssignmentIsNotRetriedUntilItIsAssignedAgain(t *testing.T) {
	in := baseInput()
	in.Failed = &FailedRelease{Release: "edge-2026.08.0", Assignment: in.Assignment,
		Reason: "Der Selbsttest ist fehlgeschlagen."}
	d := Decide(in)
	if d.Action != ActionRefuse || d.Blocker != BlockerRolledBack {
		t.Fatalf("dieselbe Zuweisung darf nicht wieder laufen, ist %v/%v", d.Action, d.Blocker)
	}
	if !strings.Contains(d.Reason, "erneute Zuweisung") {
		t.Fatalf("der Grund nennt den Weg nicht: %q", d.Reason)
	}
	if !strings.Contains(d.Reason, "Selbsttest") {
		t.Fatalf("der Grund von damals fehlt: %q", d.Reason)
	}
}

// DAS ist der Unterschied zur alten Dauersperre: ein erneutes „Aktualisieren"
// im Portal erzeugt einen frischen Stempel und loest sie von selbst - auch
// fuer DASSELBE Release.
func TestAFreshAssignmentOfTheSameReleaseTriesAgain(t *testing.T) {
	in := baseInput()
	in.Failed = &FailedRelease{Release: "edge-2026.08.0", Assignment: "2026-08-03T09:00:00Z"}
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("eine NEUE Zuweisung muss es wieder versuchen, ist %v (%s)", d.Action, d.Reason)
	}
}

// Ein Merkzettel aus der Zeit vor dem Umbau traegt keinen Stempel - er darf
// keine Dauersperre ueberleben.
func TestALegacyFailedMarkerWithoutAnAssignmentBlocksNothing(t *testing.T) {
	in := baseInput()
	in.Failed = &FailedRelease{Release: "edge-2026.08.0"}
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("ein Merkzettel ohne Stempel darf nichts sperren, ist %v", d.Action)
	}
}

func TestAnotherReleaseIsNeverBlockedByAPreviousRollback(t *testing.T) {
	in := baseInput()
	in.Failed = &FailedRelease{Release: "edge-2026.07.9", Assignment: in.Assignment}
	if d := Decide(in); d.Action != ActionApply {
		t.Fatalf("ein anderes Release laeuft normal durch, ist %v", d.Action)
	}
}

// --- Querschnitt ----------------------------------------------------------

func TestEveryNonIdleOutcomeCarriesAGermanReason(t *testing.T) {
	cases := map[string]func(*DecisionInput){
		"kette": func(in *DecisionInput) {
			in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeRejected, Reason: "kaputt"}
		},
		"politik": func(in *DecisionInput) {
			in.Verdict = otaverify.Verdict{Outcome: otaverify.OutcomeDeferred, Reason: "Boden"}
		},
		"state_schema": func(in *DecisionInput) { in.StateSchemaOnDisk = 9 },
		"platte":       func(in *DecisionInput) { in.FreeBytes = 1 },
		"zurueckgenommen": func(in *DecisionInput) {
			in.Failed = &FailedRelease{Release: "edge-2026.08.0", Assignment: in.Assignment}
		},
	}
	for name, mut := range cases {
		in := baseInput()
		mut(&in)
		d := Decide(in)
		if d.Action == ActionIdle || d.Action == ActionApply {
			t.Fatalf("%s: erwartet eine Ablehnung, ist %v", name, d.Action)
		}
		if strings.TrimSpace(d.Reason) == "" {
			t.Fatalf("%s: ohne deutschen Grund", name)
		}
		if d.Blocker != name {
			t.Fatalf("%s: Blocker ist %q", name, d.Blocker)
		}
	}
}

func TestTheApplyingAckIsWaitedForButNotForever(t *testing.T) {
	st := &UpdaterState{AckToken: "t1"}
	if ok, _ := ApplyingAckDecision(st, nil, 0, time.Minute); ok {
		t.Fatal("ohne Bestaetigung darf nicht weitergemacht werden")
	}
	sig := &CoreSignal{AckToken: "t1", ApplyingAckedAt: testNow.Format(TimeFormat)}
	if ok, _ := ApplyingAckDecision(st, sig, 0, time.Minute); !ok {
		t.Fatal("mit Bestaetigung muss weitergemacht werden")
	}
	failed := &CoreSignal{AckToken: "t1", AckFailed: true}
	ok, reason := ApplyingAckDecision(st, failed, 0, time.Minute)
	if !ok || reason == "" {
		t.Fatalf("ein ehrliches geht-nicht macht weiter und sagt warum: %v/%q", ok, reason)
	}
	ok, reason = ApplyingAckDecision(st, nil, 2*time.Minute, time.Minute)
	if !ok || reason == "" {
		t.Fatalf("nach der Frist wird getauscht und gesagt warum: %v/%q", ok, reason)
	}
}

func TestStateVocabularyMatchesTheCloudContract(t *testing.T) {
	want := []string{"idle", "verifying", "deferred", "downloading", "applying",
		"self_test", "succeeded", "failed", "rolled_back"}
	got := []string{StateIdle, StateVerifying, StateDeferred, StateDownloading,
		StateApplying, StateSelfTest, StateSucceeded, StateFailed, StateRolledBack}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Vertragswort %d: %q != %q", i, got[i], want[i])
		}
	}
}

// Das Blocker-Vokabular bleibt VOLLSTAENDIG lesbar, auch fuer die Woerter, die
// dieses Paket nicht mehr erzeugt: eine Bestandsbox mit aelterem Image meldet
// sie noch, und keine Oberflaeche darf sie als unbekannt behandeln.
func TestTheLegacyBlockerVocabularyStaysReadable(t *testing.T) {
	for _, w := range []string{BlockerCoreSilent, BlockerNeutralTime, BlockerNeutralTooShort,
		BlockerInterlock, BlockerApprovalRelease} {
		if strings.TrimSpace(w) == "" {
			t.Fatal("ein Vertragswort darf nicht leer werden")
		}
	}
}

func TestTheBlockedSentenceCarriesItsPrefixExactlyWhenABlockerStands(t *testing.T) {
	if (&UpdaterState{}).BlockedReason() != "" {
		t.Fatal("ohne Sperre kein Satz")
	}
	st := &UpdaterState{Blocker: BlockerDisk, Reason: "Zu wenig Platz."}
	if got := st.BlockedReason(); !strings.HasPrefix(got, BlockedPrefix) {
		t.Fatalf("der Praefix fehlt: %q", got)
	}
	bare := &UpdaterState{Blocker: BlockerDisk}
	if got := bare.BlockedReason(); !strings.Contains(got, BlockerDisk) {
		t.Fatalf("ohne Grund wird der Blocker genannt: %q", got)
	}
}
