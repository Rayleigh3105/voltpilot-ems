package agent

// OTA Stufe 3, die KERN-Haelfte: der Zustandskanal, der Interlock-Eingang, der
// synthetische Steuer-Trockenlauf und das Urteil des neuen Standes.
//
// Der Kern tauscht nichts - jeder Test hier prueft eine AUSSAGE, keine Aktion.

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func autonomyAgent(t *testing.T) *Agent {
	t.Helper()
	return &Agent{
		Cfg: config.Config{
			DataDir:        t.TempDir(),
			MaxChargeKw:    30,
			MaxDischargeKw: 30,
			SocMinPct:      5,
			SocMaxPct:      95,
		},
		State: state.New("edge-test", Version),
	}
}

func TestTheCoreSignalIsWrittenAndCarriesTheInterlockInput(t *testing.T) {
	a := autonomyAgent(t)
	a.otaSignalOnce()

	sig, err := otaapply.ReadJSON[otaapply.CoreSignal](a.Cfg.DataDir, otaapply.FileCoreSignal)
	if err != nil {
		t.Fatalf("der Zustand muss hinterlegt werden: %v", err)
	}
	if sig.Version != Version {
		t.Fatalf("die Build-Stempelung muss mitreisen: %q", sig.Version)
	}
	if sig.ControlActive || sig.Dispatching {
		t.Fatalf("ohne Freigabe steuert nichts: %+v", sig)
	}
	if sig.Age(time.Now()) > time.Minute {
		t.Fatalf("der Stempel muss frisch sein, ist %s alt", sig.Age(time.Now()))
	}
}

// Der Interlock haengt an ZWEI Bedingungen: es wird wirklich gesteuert UND der
// Sollwert weicht von neutral ab.
func TestDispatchingNeedsBothARealControlPathAndANonNeutralSetpoint(t *testing.T) {
	a := autonomyAgent(t)
	a.invMu.Lock()
	a.inv = &inverter.Selection{Family: "hybrid_3p"}
	a.invMu.Unlock()

	cases := []struct {
		name    string
		snap    state.Snapshot
		control bool
		want    bool
	}{
		{"nur lesend - die heutige Flotte", state.Snapshot{
			Mode: state.ModeSchedule, SetpointKw: -7.1}, false, false},
		{"freigegeben, aber neutral", state.Snapshot{
			ControlEnabled: true, ControlCertified: true,
			Mode: state.ModeSchedule, SetpointKw: 0}, true, false},
		{"freigegeben und entlaedt", state.Snapshot{
			ControlEnabled: true, ControlCertified: true,
			Mode: state.ModeSchedule, SetpointKw: -7.1}, true, true},
		{"Not-Aus gezogen", state.Snapshot{
			ControlEnabled: false, ControlCertified: true,
			Mode: state.ModeSchedule, SetpointKw: -7.1}, false, false},
		{"ohne Messwerte", state.Snapshot{
			ControlEnabled: true, ControlCertified: true,
			Mode: state.ModeNoReading}, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := a.otaControlActive(c.snap); got != c.control {
				t.Fatalf("ControlActive: erwartet %v, ist %v", c.control, got)
			}
			if got := a.otaDispatching(c.snap); got != c.want {
				t.Fatalf("Dispatching: erwartet %v, ist %v", c.want, got)
			}
		})
	}

	// Ohne gewaehlten Wechselrichter steuert nichts - auch mit Freigabe nicht.
	a.invMu.Lock()
	a.inv = nil
	a.invMu.Unlock()
	if a.otaControlActive(state.Snapshot{ControlEnabled: true, ControlCertified: true}) {
		t.Fatal("ohne Geraetewahl gibt es keinen Steuerpfad")
	}
}

// DER Test, der „nie vakuum" traegt: der Trockenlauf laeuft ohne Anlage,
// ohne Messwerte, nachts - und er prueft die Guard-Kette wirklich.
func TestTheSyntheticControlDryRunProvesTheGuardChainWithoutWritingAnything(t *testing.T) {
	a := autonomyAgent(t)
	ok, detail := a.otaSyntheticControlDryRun()
	if !ok {
		t.Fatalf("die echte Guard-Kette muss bestehen: %s", detail)
	}
	if !strings.Contains(detail, "Solar-Klemme") {
		t.Fatalf("der Befund muss benennen, was geprueft wurde: %q", detail)
	}

	// Unsinnige Grenzen sind ein Befund, kein „geht schon".
	for _, bad := range []config.Config{
		{DataDir: a.Cfg.DataDir, MaxChargeKw: 0, MaxDischargeKw: 30, SocMinPct: 5, SocMaxPct: 95},
		{DataDir: a.Cfg.DataDir, MaxChargeKw: 30, MaxDischargeKw: 0, SocMinPct: 5, SocMaxPct: 95},
		{DataDir: a.Cfg.DataDir, MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 95, SocMaxPct: 5},
	} {
		b := &Agent{Cfg: bad, State: state.New("edge-test", Version)}
		if ok, _ := b.otaSyntheticControlDryRun(); ok {
			t.Fatalf("unsinnige Grenzen muessen auffallen: %+v", bad)
		}
	}
}

func TestTheSelfTestRefusesAStandThatIsNotTheOneThatShouldRun(t *testing.T) {
	a := autonomyAgent(t)
	p := &otaapply.PendingConfirm{Token: "tok", Release: "edge-2099.12.9", ReleaseSeq: 99}

	res := a.otaRunSelfTest(p, time.Now())
	if res.Passed {
		t.Fatal("es laeuft nicht das Release, das angewandt werden sollte - das muss auffallen")
	}
	if !strings.Contains(res.Reason, "nicht das Release") {
		t.Fatalf("der Grund muss das benennen: %q", res.Reason)
	}
	if res.Token != p.Token {
		t.Fatalf("das Urteil muss zu SEINEM Vorgang gehoeren: %q", res.Token)
	}
	// Jede Pruefung traegt ihren Befund - auch die bestandenen.
	var names []string
	for _, c := range res.Checks {
		names = append(names, c.Name)
	}
	for _, want := range []string{"version", "web", "cloud", "steuerpfad"} {
		found := false
		for _, n := range names {
			if n == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("die Pruefung %q fehlt (vorhanden: %v)", want, names)
		}
	}
}

// Ein Update, das die First-Light-Freigabe verliert, macht die Anlage
// stillschweigend nur noch lesend - genau deshalb ist das ein Fehlschlag.
func TestASelfTestFailsWhenAControllingPlantLostItsGrant(t *testing.T) {
	a := autonomyAgent(t)
	p := &otaapply.PendingConfirm{Token: "tok", Release: "edge-2099.12.9",
		ControlActiveBefore: true}

	res := a.otaRunSelfTest(p, time.Now())
	if res.Passed {
		t.Fatal("ohne Freigabe darf der Stand nicht als gesund gelten")
	}
	if !strings.Contains(res.Reason, "Freigabe") && !strings.Contains(res.Reason, "Geraetewahl") {
		t.Fatalf("der Grund muss die verlorene Freigabe benennen: %q", res.Reason)
	}
}

// Ohne Sidecar (und bei `idle`) ist der Herzschlag ZEICHENGLEICH der der
// Stufe 2 - das ist die Zusage „eine Box ohne Sidecar verhaelt sich wie heute".
func TestTheHeartbeatIsUnchangedWithoutTheSidecar(t *testing.T) {
	a := autonomyAgent(t)
	before := *a.updateSummary()

	// Ein Sidecar, der nichts tut, aendert nichts.
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State: otaapply.StateIdle, Autonomous: false}); err != nil {
		t.Fatal(err)
	}
	if got := *a.updateSummary(); got != before {
		t.Fatalf("idle darf nichts aendern:\nvorher %+v\nnachher %+v", before, got)
	}
}

func TestAWorkingSidecarOwnsTheApplicationStateWhileTheCoreKeepsTheVerdict(t *testing.T) {
	a := autonomyAgent(t)
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{
			UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateApplying, Reason: "Die Komponente 'core' wird getauscht.",
			Release: "edge-2026.08.0", ReleaseSeq: 12, LastKnownGood: "edge-2026.07.2",
			Autonomous: true,
		}); err != nil {
		t.Fatal(err)
	}
	sum := a.updateSummary()
	if sum.State != cloud.UpdateStateApplying {
		t.Fatalf("der Sidecar besitzt den Anwendungs-Zustand: %+v", sum)
	}
	if sum.Target != "edge-2026.08.0" || sum.TargetSeq == nil || *sum.TargetSeq != 12 {
		t.Fatalf("Ziel: %+v", sum)
	}
	if sum.LastKnownGood != "edge-2026.07.2" {
		t.Fatalf("das Rueckfallziel muss mitreisen: %q", sum.LastKnownGood)
	}
	if sum.Backend != cloud.UpdateBackendCompose {
		t.Fatalf("Backend: %q", sum.Backend)
	}
}

// Der Soak-Fall vom 04.08.2026: der Sidecar VERWEIGERT, und bis dahin trug der
// Herzschlag trotzdem den freundlichen Satz des Verifizierers weiter.
func TestABlockedSidecarOwnsTheReasonInsteadOfTheVerifiersFriendlySentence(t *testing.T) {
	a := autonomyAgent(t)
	// Der Ausgangszustand: der Kern hat nichts zu melden, also steht dort sein
	// eigener Satz (bzw. gar keiner).
	stale := a.updateSummary().Reason

	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{
			UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateDeferred,
			Blocker:   otaapply.BlockerNeutralTime,
			Reason: "Diese Anlage steuert. Fuer die Familie 'hybrid_3p' ist die Neutral-Zeit " +
				"des Wechselrichters NICHT verifiziert. Es wird deshalb nicht autonom " +
				"angewandt (am Pruefstand belegen und in VP_OTA_NEUTRAL_VERIFIED eintragen).",
			Release: "edge-2026.08.2", ReleaseSeq: 14, Autonomous: true,
		}); err != nil {
		t.Fatal(err)
	}

	sum := a.updateSummary()
	if sum.Reason == stale {
		t.Fatalf("der stehen gebliebene Satz darf eine Sperre nicht ueberleben: %q", sum.Reason)
	}
	if !strings.HasPrefix(sum.Reason, otaapply.BlockedPrefix) {
		t.Fatalf("eine Sperre muss als solche erkennbar sein: %q", sum.Reason)
	}
	for _, want := range []string{"steuert", "hybrid_3p", "VP_OTA_NEUTRAL_VERIFIED"} {
		if !strings.Contains(sum.Reason, want) {
			t.Fatalf("der Grund nennt %q nicht: %q", want, sum.Reason)
		}
	}
	// `deferred` bleibt richtig - es ist keine Stoerung, sondern eine bewusst
	// nicht getroffene Entscheidung; nur der GRUND muss stimmen.
	if sum.State != cloud.UpdateStateDeferred {
		t.Fatalf("Zustand: %q", sum.State)
	}
	if sum.Target != "edge-2026.08.2" || sum.TargetSeq == nil || *sum.TargetSeq != 14 {
		t.Fatalf("das Ziel muss mitreisen: %+v", sum)
	}
	// Der NAME der Sperre reist seit dem Admin-UX-Umbau mit: der Satz bleibt
	// die Aussage, aber die Cloud darf ihn nicht nach Stichworten durchsuchen
	// muessen, um „blockiert" von „unterwegs" zu unterscheiden.
	if sum.Blocker != otaapply.BlockerNeutralTime {
		t.Fatalf("der maschinenlesbare Sperr-Name fehlt: %q", sum.Blocker)
	}
}

// Ohne Sperre wird auch KEIN Name gemeldet - ein leeres Feld ist die ehrliche
// Aussage „keine stehende Sperre", und `omitempty` haelt den Herzschlag eines
// gesunden Geraets byte-gleich zu dem vor dieser Aenderung.
func TestNoBlockerNameIsReportedWithoutABlock(t *testing.T) {
	a := autonomyAgent(t)
	if got := a.updateSummary().Blocker; got != "" {
		t.Fatalf("ohne Sperre darf kein Name stehen: %q", got)
	}
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{
			UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateApplying, Reason: "Die Komponente 'core' wird getauscht.",
			Release: "edge-2026.08.0", ReleaseSeq: 12, Autonomous: true,
		}); err != nil {
		t.Fatal(err)
	}
	if got := a.updateSummary().Blocker; got != "" {
		t.Fatalf("ein arbeitender Sidecar ist nicht blockiert: %q", got)
	}
}

// Die Sperre gewinnt auch dann, wenn daneben ein harmloses Zustandswort steht -
// sonst haette die „idle"-Abkuerzung genau den Fall verschluckt, fuer den es
// dieses Feld gibt.
func TestABlockerIsCarriedEvenNextToAnIdleState(t *testing.T) {
	a := autonomyAgent(t)
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{
			UpdatedAt:  time.Now().UTC().Format(otaapply.TimeFormat),
			State:      otaapply.StateIdle,
			Blocker:    otaapply.BlockerApprovalRelease,
			Reason:     "Die Freigabe galt fuer Release edge-2026.08.1.",
			Autonomous: false,
		}); err != nil {
		t.Fatal(err)
	}
	sum := a.updateSummary()
	if !strings.Contains(sum.Reason, "Die Freigabe galt") {
		t.Fatalf("der Grund der Sperre fehlt: %q", sum.Reason)
	}
	if sum.Blocker != otaapply.BlockerApprovalRelease {
		t.Fatalf("auch neben `idle` reist der Sperr-Name: %q", sum.Blocker)
	}
}

// Ein gestoppter Sidecar darf den Herzschlag nicht auf „wendet an" einfrieren.
func TestAStaleSidecarStateIsIgnored(t *testing.T) {
	a := autonomyAgent(t)
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileUpdaterState,
		otaapply.UpdaterState{
			UpdatedAt: time.Now().Add(-30 * time.Minute).UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateApplying, Reason: "laeuft angeblich noch",
			Release: "edge-2026.08.0",
		}); err != nil {
		t.Fatal(err)
	}
	if sum := a.updateSummary(); sum.State == cloud.UpdateStateApplying {
		t.Fatalf("ein alter Zustand beschreibt nichts Laufendes mehr: %+v", sum)
	}
}

// Der Selbsttest laeuft erst am ENDE eines Tausches - ueber einen halb
// getauschten Stand darf niemand urteilen.
func TestTheSelfTestWaitsUntilBothComponentsAreSwapped(t *testing.T) {
	a := autonomyAgent(t)
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FilePendingConfirm,
		otaapply.PendingConfirm{Token: "tok", Release: "edge-2026.08.0",
			Phase: otaapply.PhaseSwapCore}); err != nil {
		t.Fatal(err)
	}
	a.done.Add(1)
	a.otaSelfTestOnBoot(t.Context())
	if _, err := otaapply.ReadJSON[otaapply.SelfTest](a.Cfg.DataDir, otaapply.FileSelfTest); err == nil {
		t.Fatal("waehrend des Tausches darf kein Urteil entstehen")
	}
}
