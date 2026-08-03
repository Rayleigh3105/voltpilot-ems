package agent

// Der Knopf „Jetzt anwenden" auf `:8484` (OTA Stufe 4), von der Kern-Seite.
//
// Der Kern SCHREIBT hier nur eine Freigabe-Datei - angewandt wird von einem
// anderen Prozess, der alles noch einmal selbst prueft (die Torkette liegt in
// `internal/otaapply` und ist dort getestet). Was diese Tests schuetzen, ist
// deshalb genau das: dass die Freigabe nur entsteht, wenn sie auch etwas
// bewirken KANN, und dass jedes „nein" seinen Grund nennt.

import (
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// applyBox stellt eine Box mit einem GEPRUEFTEN Ziel und wahlweise einem
// laufenden Aktualisierer bereit.
func applyBox(t *testing.T, updaterRunning bool) *otaTargetBox {
	t.Helper()
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), nil))
	if updaterRunning {
		writeUpdaterState(t, b, otaapply.UpdaterState{
			UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
			State:     otaapply.StateIdle,
		})
	}
	return b
}

func writeUpdaterState(t *testing.T, b *otaTargetBox, st otaapply.UpdaterState) {
	t.Helper()
	if err := otaapply.WriteJSON(b.a.Cfg.DataDir, otaapply.FileUpdaterState, st); err != nil {
		t.Fatal(err)
	}
}

func TestApplyIsOfferedOnlyWithAVerifiedTargetAndARunningUpdater(t *testing.T) {
	// (a) Ohne Zuweisung gibt es nichts anzuwenden - und keine Karte.
	leer := &Agent{Cfg: config.Config{DataDir: t.TempDir()},
		State: state.New("edge-test", Version)}
	if v := leer.OtaApplyState(); v.CanApply || v.Release != "" {
		t.Fatalf("ohne Zuweisung darf nichts angeboten werden: %+v", v)
	}

	// (b) Geprueftes Ziel, aber KEIN Aktualisierer: ehrlicher Grund statt eines
	//     Knopfes, der ins Leere schriebe.
	ohne := applyBox(t, false)
	v := ohne.a.OtaApplyState()
	if v.CanApply {
		t.Fatal("ohne laufenden Aktualisierer darf nicht angewandt werden")
	}
	if !strings.Contains(v.Reason, "update.sh --from-target") {
		t.Errorf("der Grund muss den verbleibenden Weg nennen: %q", v.Reason)
	}
	if _, err := ohne.a.OtaRequestApply("test"); err == nil {
		t.Fatal("die Freigabe haette abgelehnt werden muessen")
	} else if !ohne.a.IsOtaRejection(err) {
		t.Errorf("eine Ablehnung ist eine 400, kein Fehler: %v", err)
	}

	// (c) Mit Aktualisierer: anwendbar.
	mit := applyBox(t, true)
	if v := mit.a.OtaApplyState(); !v.CanApply || v.Release != "edge-2026.08.0" {
		t.Fatalf("mit geprueftem Ziel und Aktualisierer muss es gehen: %+v", v)
	}
}

func TestTheApprovalPinsTheReleaseTheOperatorSaw(t *testing.T) {
	b := applyBox(t, true)
	if _, err := b.a.OtaRequestApply("betreiber"); err != nil {
		t.Fatal(err)
	}
	req, err := otaapply.ReadJSON[otaapply.ApplyRequest](b.a.Cfg.DataDir,
		otaapply.FileApplyRequest)
	if err != nil || req == nil {
		t.Fatalf("die Freigabe wurde nicht abgelegt: %v", err)
	}
	// Das Release, das der Mensch GESEHEN hat - daran haengt die Zusage, dass
	// eine spaeter eingetroffene Zuweisung nicht mitfreigegeben ist.
	if req.Release != "edge-2026.08.0" {
		t.Errorf("die Freigabe nennt das falsche Release: %q", req.Release)
	}
	if req.Token == "" || req.RequestedBy != "betreiber" {
		t.Errorf("Token/Urheber fehlen: %+v", req)
	}
	if !req.Fresh(time.Now()) {
		t.Error("eine gerade erteilte Freigabe muss frisch sein")
	}

	// Die Ansicht sagt danach, dass sie liegt - und bietet nicht erneut an.
	v := b.a.OtaApplyState()
	if !v.Requested || v.CanApply {
		t.Fatalf("nach der Freigabe wartet die Box, sie fragt nicht erneut: %+v", v)
	}
}

// Eine QUITTIERTE Freigabe ist verbraucht: die Ansicht bietet danach wieder an,
// statt „liegt vor" einzufrieren.
func TestAnAcknowledgedApprovalIsSpentAndTheBoxOffersAgain(t *testing.T) {
	b := applyBox(t, true)
	if _, err := b.a.OtaRequestApply(""); err != nil {
		t.Fatal(err)
	}
	req, _ := otaapply.ReadJSON[otaapply.ApplyRequest](b.a.Cfg.DataDir, otaapply.FileApplyRequest)

	writeUpdaterState(t, b, otaapply.UpdaterState{
		UpdatedAt:           time.Now().UTC().Format(otaapply.TimeFormat),
		State:               otaapply.StateIdle,
		AppliedRequestToken: req.Token,
	})
	v := b.a.OtaApplyState()
	if v.Requested {
		t.Fatal("eine quittierte Freigabe darf nicht als wartend gelten")
	}
	if !v.CanApply {
		t.Fatalf("danach ist die Box wieder anwendbar: %+v", v)
	}
}

// Ein ALTER Zustand des Sidecars heisst „er laeuft nicht mehr" - ein
// gestoppter Aktualisierer darf nicht als laufend gelten.
func TestAStaleUpdaterStateCountsAsNoUpdater(t *testing.T) {
	b := applyBox(t, true)
	writeUpdaterState(t, b, otaapply.UpdaterState{
		UpdatedAt: time.Now().Add(-time.Hour).UTC().Format(otaapply.TimeFormat),
		State:     otaapply.StateIdle,
	})
	if v := b.a.OtaApplyState(); v.UpdaterPresent || v.CanApply {
		t.Fatalf("ein alter Zustand ist kein laufender Aktualisierer: %+v", v)
	}
}

// Ein Ziel, dessen Kette NICHT geprueft ist, wird nie angeboten - der Knopf
// darf nie etwas Ungeprueftes ausloesen.
func TestAnUnverifiedTargetIsNeverOffered(t *testing.T) {
	// Ein Ziel, das ein FREMDER Schluessel signiert hat - die Kette ist
	// gebrochen, das Urteil damit `rejected`.
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	fremd := otaNewKey(t, "rel-fremd")
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), &fremd))
	writeUpdaterState(t, b, otaapply.UpdaterState{
		UpdatedAt: time.Now().UTC().Format(otaapply.TimeFormat),
		State:     otaapply.StateIdle,
	})
	v := b.a.OtaApplyState()
	if v.CanApply {
		t.Fatal("ein ungeprueftes Ziel darf nie anwendbar sein")
	}
	if v.Reason == "" {
		t.Error("eine Ablehnung traegt ihren Grund")
	}
	if got := b.a.OtaTarget().Verdict; got == string(otaverify.OutcomeOK) {
		t.Fatalf("Vorbedingung des Tests verletzt: Urteil ist %q", got)
	}
}
