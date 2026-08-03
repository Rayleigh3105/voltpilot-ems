package agent

// OTA Stufe 2 „Verteilen" - die GERÄTE-Hälfte: empfangen, verifizieren,
// persistieren, melden. **Weiterhin KEIN autonomes Anwenden.**
//
// Was diese Stufe ändert: das Ziel kommt nicht mehr von Hand auf die Box,
// sondern retained über den bestehenden mTLS-Link (Topic .../v2/update,
// docs/contracts/mqtt-ota-target.schema.json). Was sie NICHT ändert: die
// Vertrauensentscheidung. Sie fällt unverändert auf dem Gerät gegen die
// EINGEBACKENE Wurzel (internal/otaverify, Stufe 1) - der Downlink ist ein
// Transportweg, keine Autorität, und die Cloud prüft die Signatur bewusst nicht.
//
// Angewandt wird beaufsichtigt: ein Mensch am Gerät ruft
// `update.sh --from-target`, und der liest über GET /api/ota/target genau die
// Artefakt-Digests, die DIESES Gerät verifiziert hat. Das ist der Kern der
// Stufe: Entscheidung, Verteilung und Sichtbarkeit sind Portal, das Anwenden
// bleibt am Gerät.

import (
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// onUpdateTarget verarbeitet EINE retained Zuweisung vom Broker.
//
// Idempotent: der Broker liefert die retained Nachricht bei jedem Verbindungs-
// aufbau erneut, und identische Bytes führen zu identischen Bytes auf Platte.
// Eine LEERE Nutzlast nimmt die Zuweisung zurück (retained-clear, z. B. beim
// Unclaim) - dann verschwindet auch die Datei, nie ein verwaistes Ziel.
func (a *Agent) onUpdateTarget(payload []byte) {
	store := otatarget.NewStore(a.Cfg.DataDir)
	if len(payload) == 0 {
		if err := store.Clear(); err != nil {
			slog.Warn("OTA: Zuweisung konnte nicht entfernt werden", "err", err)
			return
		}
		slog.Info("OTA: Zuweisung zurueckgenommen (leere retained Nachricht)")
		a.otaCheckOnce()
		return
	}

	env, err := otatarget.ParseEnvelope(payload)
	if err != nil {
		// Eine unlesbare Zuweisung wird NICHT gespeichert: eine kaputte Datei
		// auf Platte würde bei jedem Neustart erneut denselben Fehler
		// produzieren, und der zuletzt GÜLTIGE Stand bliebe verdeckt.
		slog.Error("OTA: Zuweisung verworfen - Form fehlerhaft", "grund", err)
		a.setOtaVerdict(otaVerdict{
			state:         cloud.UpdateStateFailed,
			reason:        "Die zugewiesene Aktualisierung ist unlesbar: " + err.Error(),
			targetVerdict: string(otaverify.OutcomeRejected),
			stamp:         "invalid",
		})
		return
	}

	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		// Vor der Beanspruchung gibt es kein Ziel, das uns meinen könnte.
		slog.Warn("OTA: Zuweisung vor bekannter Cloud-Identitaet - ignoriert")
		return
	}
	if !env.MatchesIdentity(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("OTA: Zuweisung meint ein anderes Geraet - verworfen",
			"gemeldet", env.DeviceID, "eigen", id.DeviceID)
		return
	}

	if err := store.Save(payload); err != nil {
		slog.Error("OTA: Zuweisung konnte nicht abgelegt werden", "err", err)
		return
	}
	slog.Info("OTA: Zuweisung empfangen", "release", env.Release,
		"release_seq", env.ReleaseSeq, "kanal", env.Channel)
	// Sofort prüfen, damit der nächste Herzschlag (15 s) schon das Urteil trägt
	// statt bis zum 30-s-Takt des Prüfers zu warten.
	a.otaCheckOnce()
}

// otaCheckTarget prüft die abgelegte Zuweisung - oder meldet, dass es keine
// gibt (zweiter Rückgabewert false, dann greift der beaufsichtigte Dateipfad
// der Stufe 1).
func (a *Agent) otaCheckTarget() (otaVerdict, bool) {
	store := otatarget.NewStore(a.Cfg.DataDir)
	fi, err := os.Stat(store.Path())
	if err != nil {
		return otaVerdict{}, false
	}
	stamp := "target:" + fi.ModTime().UTC().Format(time.RFC3339Nano) + ":" +
		strconv.FormatInt(fi.Size(), 10)

	a.ota.mu.Lock()
	cached := a.ota.v
	a.ota.mu.Unlock()
	if cached.stamp == stamp {
		// Unverändert - das Urteil steht schon. Ein erneutes Verifizieren
		// alle 30 s wäre reine Arbeit ohne neue Aussage.
		return cached, true
	}

	raw, err := store.Load()
	if err != nil {
		return otaVerdict{}, false
	}
	v := a.otaVerifyTarget(raw)
	v.stamp = stamp
	return v, true
}

// otaVerifyTarget ist die Prüfung EINER abgelegten Zuweisung: Umschlag lesen,
// die Manifest-Bytes UNVERÄNDERT an den Verifizierer geben, das Urteil in
// Zustand + deutschen Grund übersetzen.
func (a *Agent) otaVerifyTarget(raw []byte) otaVerdict {
	env, err := otatarget.ParseEnvelope(raw)
	if err != nil {
		return otaVerdict{
			state:         cloud.UpdateStateFailed,
			reason:        "Die zugewiesene Aktualisierung ist unlesbar: " + err.Error(),
			targetVerdict: string(otaverify.OutcomeRejected),
		}
	}

	roots := a.otaRoots
	if roots == nil {
		var rErr error
		if roots, rErr = otaverify.BakedRoots(); rErr != nil {
			return otaVerdict{
				state:         cloud.UpdateStateFailed,
				target:        env.Release,
				targetSeq:     env.ReleaseSeq,
				channel:       env.Channel,
				targetVerdict: string(otaverify.OutcomeRejected),
				reason: "Der eingebackene Vertrauensanker ist unlesbar - die zugewiesene " +
					"Aktualisierung kann nicht geprueft werden.",
			}
		}
	}

	dir := a.otaDir()
	in := otaverify.Input{
		Roots: roots,
		// Das root-signierte Trust-Set reist BEWUSST nicht im Downlink mit: es
		// ist der Widerrufs-Anker und wird beim TOFU-Crossover je Box abgelegt
		// (docs/ota-signing.md §6). Fehlt es, lehnt der Verifizierer
		// fail-closed ab und sagt das.
		TrustSet:       readFileOrNil(dir, otaTrustSetFile),
		TrustSetSig:    readFileOrNil(dir, otaTrustSetFile+otaSigSuffix),
		Manifest:       env.Manifest,
		ManifestSig:    env.Signature,
		Backend:        cloud.UpdateBackendCompose,
		RunningVersion: Version,
		Now:            time.Now(),
	}
	if cur := a.otaReadCurrent(dir); cur != nil {
		seq := cur.ReleaseSeq
		in.CurrentSeq = &seq
	}

	res := otaverify.Verify(in)
	out := otaVerdict{
		target:        env.Release,
		targetSeq:     env.ReleaseSeq,
		channel:       env.Channel,
		reason:        res.Reason,
		targetVerdict: string(res.Outcome),
	}
	if res.Manifest != nil {
		// Ab hier gilt das MANIFEST, nicht der Umschlag: er ist unsigniert.
		out.release = res.Manifest.Release
		out.seq = res.Manifest.ReleaseSeq
		out.target = res.Manifest.Release
		out.targetSeq = res.Manifest.ReleaseSeq
	}

	switch res.Outcome {
	case otaverify.OutcomeOK:
		if res.AlreadyRunning {
			// Ist == Soll. Das ist der Endzustand eines gelungenen Rollouts,
			// und er wird aus dem laufenden Build-Stempel BELEGT, nicht aus
			// einer Buchführung geglaubt.
			out.state = cloud.UpdateStateSucceeded
			out.reason = "Release " + res.Manifest.Release + " ist verifiziert und laeuft hier."
		} else {
			// Verifiziert, aber es wendet niemand an: in dieser Stufe ist das
			// der NORMALFALL und kein Fehler. `deferred` ist der ehrliche
			// Zustand des Vertrags-Vokabulars („das Geraet geht bewusst nicht
			// weiter"); WARUM es nicht weitergeht, unterscheidet
			// targetVerdict - ok = wartet auf den Menschen, deferred = die
			// Politik laesst es hier nicht zu.
			out.state = cloud.UpdateStateDeferred
			out.reason = "Release " + res.Manifest.Release +
				" ist verifiziert - die Anwendung erfolgt beaufsichtigt am Geraet " +
				"(update.sh --from-target)."
		}
		slog.Info("OTA: zugewiesenes Release verifiziert",
			"release", res.Manifest.Release, "release_seq", res.Manifest.ReleaseSeq,
			"signiert_von", res.SignedBy, "laeuft_bereits", res.AlreadyRunning)
	case otaverify.OutcomeDeferred:
		out.state = cloud.UpdateStateDeferred
		slog.Warn("OTA: zugewiesenes Release gilt nicht fuer dieses Geraet", "grund", res.Reason)
	case otaverify.OutcomeRejected:
		// Eine gebrochene Kette ist ein SICHERHEITS-Ereignis. Anders als beim
		// beaufsichtigten Dateipfad der Stufe 1 hat hier die CLOUD dieses
		// Release zugewiesen - dass es nicht prüfbar ist, betrifft mit hoher
		// Wahrscheinlichkeit die ganze Welle. `failed` ist deshalb richtig:
		// es ist genau das Signal, auf das der Rollout automatisch anhält.
		out.state = cloud.UpdateStateFailed
		slog.Error("OTA: zugewiesenes Release ABGELEHNT - Vertrauenskette oder Form fehlerhaft",
			"grund", res.Reason)
	}
	for _, n := range res.Notes {
		slog.Info("OTA: Hinweis", "hinweis", n)
	}
	return out
}

// OtaTarget beschreibt die Zuweisung für die lokalen Oberflächen und für
// `update.sh --from-target`.
//
// **Die Artefakt-Digests werden NUR bei geprüfter Kette herausgegeben.** Das
// ist die eigentliche Sicherheits-Eigenschaft dieser Stufe: der beaufsichtigte
// Anwender wendet nie etwas an, das dieses Gerät nicht selbst verifiziert hat.
func (a *Agent) OtaTarget() otatarget.View {
	store := otatarget.NewStore(a.Cfg.DataDir)
	raw, err := store.Load()
	view := otatarget.View{}
	if cur := a.otaReadCurrent(a.otaDir()); cur != nil {
		view.AppliedRelease = cur.Release
		view.AppliedSeq = cur.ReleaseSeq
	}
	if err != nil {
		return view
	}
	view.HasTarget = true

	env, perr := otatarget.ParseEnvelope(raw)
	if perr != nil {
		view.Verdict = string(otaverify.OutcomeRejected)
		view.Reason = "Die abgelegte Zuweisung ist unlesbar: " + perr.Error()
		return view
	}
	view.Release = env.Release
	view.ReleaseSeq = env.ReleaseSeq
	view.Channel = env.Channel
	view.RolloutID = env.RolloutID
	view.AssignedAt = env.AssignedAt

	v := a.otaVerifyTarget(raw)
	view.Verdict = v.targetVerdict
	view.Reason = v.reason
	view.Running = v.state == cloud.UpdateStateSucceeded
	if v.release != "" {
		view.Release = v.release
		view.ReleaseSeq = v.seq
	}
	if v.targetVerdict != string(otaverify.OutcomeOK) {
		return view
	}

	// Erst hier - nach bestandener Kette - werden die Digests sichtbar.
	m, mErr := otaverify.ParseManifest(env.Manifest)
	if mErr != nil {
		view.Verdict = string(otaverify.OutcomeRejected)
		view.Reason = "Das geprüfte Manifest ist nicht lesbar: " + mErr.Error()
		return view
	}
	images := map[string]string{}
	for _, art := range m.Artifacts {
		images[art.Name] = art.Ref
	}
	view.Images = images
	return view
}

// OtaRecordApplied zeichnet einen BEAUFSICHTIGT angewandten Stand auf
// (<data>/ota/current.json) - der uhrunabhängige Anti-Rollback-Boden.
//
// Drei Regeln, die diesen Schreibpfad ungefährlich machen:
//
//  1. **Er kann nur aufzeichnen, was ohnehin schon wahr ist.** Der behauptete
//     Release muss zur Build-Stempelung DIESES Prozesses passen
//     (otaverify.ReleaseIsRunning). Ein Aufruf von der LAN-Seite kann damit
//     keinen fremden Stand eintragen - er kann nur bestätigen, was läuft.
//  2. **Er hebt nur an, nie ab.** Ein niedrigerer Stand wird abgelehnt; der
//     Boden ist monoton, das ist seine ganze Zusage.
//  3. **Er wendet nichts an.** Die Aufzeichnung folgt der Anwendung, sie löst
//     sie nicht aus.
func (a *Agent) OtaRecordApplied(release string, releaseSeq int64) (otatarget.View, error) {
	if !otaverify.ReleaseIsRunning(release, Version) {
		return a.OtaTarget(), &otaAppliedError{
			msg: "Release '" + release + "' laeuft hier nicht (dieser Stand ist '" + Version +
				"') - es wird nur aufgezeichnet, was nachweislich laeuft."}
	}
	if releaseSeq < 1 {
		return a.OtaTarget(), &otaAppliedError{msg: "release_seq muss >= 1 sein."}
	}
	dir := a.otaDir()
	if cur := a.otaReadCurrent(dir); cur != nil && cur.ReleaseSeq > releaseSeq {
		return a.OtaTarget(), &otaAppliedError{
			msg: "Der aufgezeichnete Stand (" + strconv.FormatInt(cur.ReleaseSeq, 10) +
				") ist bereits hoeher - der Anti-Rollback-Boden wird nie abgesenkt."}
	}
	if err := a.otaWriteCurrent(dir, otaCurrent{Release: release, ReleaseSeq: releaseSeq}); err != nil {
		return a.OtaTarget(), err
	}
	slog.Info("OTA: beaufsichtigt angewandter Stand aufgezeichnet",
		"release", release, "release_seq", releaseSeq)
	// Neu bewerten: mit dem angehobenen Boden ist aus „ausstehend" gerade
	// „laeuft hier" geworden - der nächste Herzschlag soll das schon tragen.
	a.otaForceRecheck()
	return a.OtaTarget(), nil
}

// otaAppliedError ist eine ABLEHNUNG mit deutschem Grund (400 auf :8484).
type otaAppliedError struct{ msg string }

func (e *otaAppliedError) Error() string { return e.msg }

// IsOtaRejection sagt der Web-Schicht, dass eine Ablehnung eine 400 ist und
// keine 500 (das ValidationError-Muster der Kalibrierung).
//
// Es gibt bewusst GENAU EINE solche Regel fuer den ganzen OTA-Pfad: das
// Aufzeichnen eines angewandten Standes (Stufe 2) und die Freigabe am Geraet
// (Stufe 4) sind fachlich dieselbe Sorte Antwort - „nein, und hier ist der
// deutsche Grund".
func (a *Agent) IsOtaRejection(err error) bool {
	var applied *otaAppliedError
	if errors.As(err, &applied) {
		return true
	}
	var rej *otaApplyRejection
	return errors.As(err, &rej)
}

func readFileOrNil(dir, name string) []byte {
	raw, err := os.ReadFile(dir + string(os.PathSeparator) + name)
	if err != nil {
		return nil
	}
	return raw
}
