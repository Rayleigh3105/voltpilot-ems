package otaupdater

// Package otaupdater ist der Motor des `vp-edge-updater`-Sidecars (OTA Stufe 3
// „Autonom").
//
// Er besitzt `/var/run/docker.sock` und ist der EINZIGE, der `docker compose
// up` fuer core/nodered faehrt (Einzelschreiber-Semantik). Er hat KEIN Netz,
// KEINEN Host-Port, KEINE MQTT-Verbindung und KEINE Identitaet - er sieht nur
// den Docker-Socket, das Deploy-Verzeichnis und `/data`.
//
// **Ehrlich zur Privilegien-Lage** (Vorentwurf §3, Befund A2): `docker.sock`
// ist Host-root. Ein uebernommener Sidecar KANN einen privilegierten Container
// starten. Der Schutz ist deshalb ausdruecklich NICHT die Netz-Grenze, sondern
//
//   - dass er ausschliesslich auf Eingaben handelt, die er SELBST gegen seine
//     eigene eingebackene Wurzel signaturgeprueft hat (er glaubt dem Kern
//     nichts), und
//   - dass seine Angriffsflaeche minimal ist: keine Zuhoerer, keine Parser
//     ausser dem des Protokolls, kein Netz-Stack.
//
// Alle Entscheidungen liegen im reinen [otaapply]; hier steht nur, WIE sie
// ausgefuehrt werden.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Options konfiguriert den Motor.
type Options struct {
	// DataDir ist das gemeinsame /data (Protokoll + Zustand).
	DataDir string
	// DeployDir ist das Verzeichnis mit docker-compose.yml und .env.
	DeployDir string
	// ComposeFiles sind die Compose-Dateien (relativ zu DeployDir).
	ComposeFiles []string
	// Runner fuehrt die Kommandos aus (in Tests ein Stellvertreter).
	Runner Runner
	// Roots ist die Vertrauenswurzel. nil = die EINGEBACKENE wird geladen
	// (der Produktionspfad); ein gesetzter Wert ist ausschliesslich die
	// TEST-Naht - es gibt bewusst KEINEN Umgebungs- oder Pfad-Schalter dafuer,
	// denn genau das waere die Vertrauensuebernahme, gegen die die
	// kalt/heiss-Trennung gebaut ist.
	Roots *otaverify.KeySet
	// Neutral ist die Tabelle der belegten Inverter-Neutral-Zeiten.
	Neutral *otaapply.NeutralTable
	// Deadline ist die konfigurierte Wachhund-Frist (wird durch T gedeckelt).
	Deadline time.Duration
	// DiskGuard ist der geforderte freie Platz.
	DiskGuard uint64
	// ForceAutonomous ist der Not-Ein aus der Umgebung (Laborstand). Der
	// eigentliche Schalter ist die Datei.
	ForceAutonomous bool
	// AckWait ist die Frist fuer den durablen `applying`-Bericht des Kerns.
	AckWait time.Duration
	// HealthWait ist die Frist, in der ein getauschter Container laufen muss.
	HealthWait time.Duration
	// Now/FreeBytes/Rand sind Nahtstellen fuer Tests.
	Now       func() time.Time
	FreeBytes func(path string) (uint64, error)
	Token     func() string
	Log       *slog.Logger
}

// Engine ist der Motor.
type Engine struct {
	o Options
	d *docker
	// applyStart merkt sich, seit wann auf den durablen Bericht gewartet wird.
	ackSince time.Time
}

// New baut den Motor mit vernuenftigen Vorgaben.
func New(o Options) *Engine {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.FreeBytes == nil {
		o.FreeBytes = FreeBytes
	}
	if o.Token == nil {
		o.Token = randomToken
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Deadline <= 0 {
		o.Deadline = 10 * time.Minute
	}
	if o.DiskGuard == 0 {
		o.DiskGuard = otaapply.DefaultDiskGuardBytes
	}
	if o.AckWait <= 0 {
		o.AckWait = 45 * time.Second
	}
	if o.HealthWait <= 0 {
		o.HealthWait = 120 * time.Second
	}
	if len(o.ComposeFiles) == 0 {
		o.ComposeFiles = []string{"docker-compose.yml"}
	}
	if o.Roots == nil {
		// Ohne diesen Rueckgriff bekaeme der Verifizierer `nil` und lehnte
		// JEDES Release mit „kein Vertrauensanker eingebacken" ab - fail-closed
		// ist die richtige Richtung, aber es waere die falsche Begruendung.
		// Ein unlesbares Set bleibt nil und damit fail-closed.
		if roots, err := otaverify.BakedRoots(); err == nil {
			o.Roots = roots
		} else {
			o.Log.Error("OTA: der eingebackene Vertrauensanker ist unlesbar - "+
				"es kann kein Release geprueft werden", "err", err)
		}
	}
	return &Engine{o: o, d: newDocker(o.Runner, o.DeployDir, o.ComposeFiles)}
}

// Tick ist EIN Durchlauf. Er ist so geschnitten, dass ein Abbruch an jeder
// Stelle einen wieder aufnehmbaren Zustand hinterlaesst.
func (e *Engine) Tick(ctx context.Context) error {
	now := e.o.Now()

	// 1. Ein angefangener Tausch gewinnt IMMER. Das ist die
	//    Einzelschreiber-Semantik: nur dieser Prozess faehrt einen Tausch, und
	//    er faehrt ihn zu Ende, bevor er ueber irgendetwas Neues nachdenkt.
	if pending, err := otaapply.ReadJSON[otaapply.PendingConfirm](
		e.o.DataDir, otaapply.FilePendingConfirm); err == nil && pending != nil {
		return e.resume(ctx, pending, now)
	} else if err != nil && !errors.Is(err, otaapply.ErrAbsent) {
		// Eine unlesbare Brotkrume ist der gefaehrlichste Zustand ueberhaupt:
		// wir wissen, dass etwas lief, aber nicht was. Es wird nichts Neues
		// begonnen, und ein Mensch muss hinsehen.
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateFailed,
			Reason: "Die Brotkrume eines laufenden Vorgangs ist unlesbar - es wird " +
				"nichts weiter unternommen, bis das geklaert ist.",
		})
	}

	autonomous := e.o.ForceAutonomous || otaapply.ReadAutonomy(e.o.DataDir).Enabled
	sig, _ := otaapply.ReadJSON[otaapply.CoreSignal](e.o.DataDir, otaapply.FileCoreSignal)

	env, err := otaapply.LoadTarget(e.o.DataDir)
	hasTarget := err == nil
	var verdict otaverify.Verdict
	switch {
	case err == nil:
		verdict = e.verify(env.Manifest, env.Signature, sig, now)
	case errors.Is(err, otaapply.ErrAbsent):
		// Normalfall.
	default:
		return e.report(otaapply.UpdaterState{
			State:      otaapply.StateFailed,
			Autonomous: autonomous,
			Reason:     "Die abgelegte Zuweisung ist unlesbar: " + err.Error(),
		})
	}

	free, ferr := e.o.FreeBytes(e.o.DataDir)
	if ferr != nil {
		// Ohne belastbare Platzangabe wird nicht getauscht: der Plattenwaechter
		// ist genau die Zusage, dass das Rueckfallziel Platz hat.
		free = 0
	}

	family := ""
	if sig != nil {
		family = sig.InverterFamily
	}
	dec := otaapply.Decide(otaapply.DecisionInput{
		Autonomous:         autonomous,
		HasTarget:          hasTarget,
		Verdict:            verdict,
		StateSchemaOnDisk:  e.stateSchemaOnDisk(),
		FreeBytes:          free,
		RequiredBytes:      e.o.DiskGuard,
		Signal:             sig,
		Failed:             e.failedRelease(),
		Neutral:            e.o.Neutral.For(family),
		ConfiguredDeadline: e.o.Deadline,
		Now:                now,
	})

	st := otaapply.UpdaterState{
		State:         dec.State,
		Reason:        dec.Reason,
		Autonomous:    autonomous,
		LastKnownGood: e.lastKnownGood(),
	}
	if verdict.Manifest != nil {
		st.Release = verdict.Manifest.Release
		st.ReleaseSeq = verdict.Manifest.ReleaseSeq
	} else if env != nil {
		st.Release = env.Release
		st.ReleaseSeq = env.ReleaseSeq
	}

	switch dec.Action {
	case otaapply.ActionApply:
		return e.apply(ctx, verdict.Manifest, dec, st, now)
	case otaapply.ActionNeutral:
		st.NeedNeutral = true
		st.Phase = "neutral"
		return e.report(st)
	default:
		return e.report(st)
	}
}

// verify ist die EIGENE Pruefung des Sidecars.
//
// Er liest die Manifest-Bytes selbst, nimmt seine eigene eingebackene Wurzel
// und seinen eigenen Boden von der Platte. Der Kern hat dasselbe getan; keiner
// von beiden verlaesst sich auf das Ergebnis des anderen. Die laufende
// Version stammt aus dem Signal des Kerns - der Sidecar kennt seine eigene
// Stempelung, aber die Frage lautet „laeuft dieses Release HIER", und das
// bezeugt ausschliesslich der Kern.
func (e *Engine) verify(manifest, sig []byte, signal *otaapply.CoreSignal, now time.Time) otaverify.Verdict {
	running := ""
	if signal != nil {
		running = signal.Version
	}
	return otaapply.VerifyManifest(e.o.DataDir, e.o.Roots, manifest, sig, running,
		otaapply.CurrentSeq(e.o.DataDir), now)
}

// apply beginnt einen Tausch: holen, pruefen, sichern, Brotkrume, tauschen.
func (e *Engine) apply(ctx context.Context, m *otaverify.Manifest, dec otaapply.Decision,
	st otaapply.UpdaterState, now time.Time) error {
	target := otaapply.TargetRefs(m)
	if otaapply.ReleaseNamesUpdater(m) {
		// Laut, nie stillschweigend: der Sidecar tauscht sich nicht selbst.
		e.o.Log.Warn("OTA: das Release nennt auch den Updater selbst - dieser Teil wird " +
			"NICHT autonom getauscht (beaufsichtigt ueber update.sh)")
	}

	// --- 1. Holen, BEVOR irgendetwas stoppt. ------------------------------
	st.State = otaapply.StateDownloading
	st.Phase = "pull"
	st.Reason = dec.Reason
	_ = e.report(st)
	for name, ref := range target {
		if !otaapply.ValidDigestRef(ref) {
			return e.fail(st, fmt.Sprintf("Die Referenz von '%s' ist kein Digest-Pin (%s).", name, ref))
		}
		if err := e.d.pull(ctx, ref); err != nil {
			// Ein gescheiterter Pull ist harmlos: es wurde noch nichts
			// gestoppt. Beim naechsten Takt wird es erneut versucht.
			return e.report(otaapply.UpdaterState{
				State: otaapply.StateDeferred, Autonomous: st.Autonomous,
				Release: st.Release, ReleaseSeq: st.ReleaseSeq,
				LastKnownGood: st.LastKnownGood,
				Reason:        "Das Image '" + name + "' konnte nicht geladen werden: " + err.Error(),
			})
		}
		if err := e.d.verifyPulled(ctx, ref); err != nil {
			// Ein Digest, der nicht stimmt, ist ein SICHERHEITS-Ereignis.
			return e.fail(st, err.Error())
		}
	}

	// --- 2. Das Rueckfallziel sichern. ------------------------------------
	previous, err := e.captureLKG(ctx, m, target)
	if err != nil {
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateDeferred, Autonomous: st.Autonomous,
			Release: st.Release, ReleaseSeq: st.ReleaseSeq,
			Reason: "Das Rueckfallziel konnte nicht gesichert werden (" + err.Error() +
				") - ohne Rueckfallziel wird nicht getauscht.",
		})
	}
	if err := otaapply.Snapshot(e.o.DataDir); err != nil {
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateDeferred, Autonomous: st.Autonomous,
			Release: st.Release, ReleaseSeq: st.ReleaseSeq,
			Reason: "Der Zustand unter /data konnte nicht gesichert werden (" + err.Error() +
				") - ohne Sicherung wird nicht getauscht.",
		})
	}

	// --- 3. Die Brotkrume - VOR dem ersten Tausch. -------------------------
	controlWas := false
	if sig := e.coreSignal(); sig != nil {
		controlWas = sig.ControlActive
	}
	pending := otaapply.NewPending(otaapply.PendingSpec{
		Token: e.o.Token(), Release: m.Release, ReleaseSeq: m.ReleaseSeq,
		Target: target, Previous: previous, Deadline: dec.Deadline,
		Urgent: m.Urgent, ControlWas: controlWas, StateSchema: m.StateSchema,
	}, now)
	if err := otaapply.WriteJSON(e.o.DataDir, otaapply.FilePendingConfirm, pending); err != nil {
		return e.fail(st, "Die Brotkrume konnte nicht geschrieben werden: "+err.Error())
	}
	// Ein altes Urteil darf den neuen Vorgang nicht beantworten.
	_ = otaapply.Remove(e.o.DataDir, otaapply.FileSelfTest)

	e.o.Log.Info("OTA: Tausch beginnt", "release", m.Release, "release_seq", m.ReleaseSeq,
		"frist", dec.Deadline.String(), "eilig", m.Urgent)
	e.ackSince = now
	return e.resume(ctx, &pending, now)
}

// resume faehrt einen angefangenen Tausch weiter - egal ob er in diesem
// Prozess begonnen hat oder vor einem Neustart.
func (e *Engine) resume(ctx context.Context, p *otaapply.PendingConfirm, now time.Time) error {
	if e.ackSince.IsZero() {
		// Nach einem Neustart mitten im Vorgang ist die Wartezeit unbekannt.
		// Sie beginnt neu, statt sie als „schon abgelaufen" zu behandeln: der
		// Kern meldet `applying` dann eben noch einmal - der Bericht ist
		// idempotent, das Verstummen-Signal waere es nicht.
		e.ackSince = now
	}
	selfTest, _ := otaapply.ReadJSON[otaapply.SelfTest](e.o.DataDir, otaapply.FileSelfTest)
	health := e.health(ctx, p)

	action, reason := otaapply.Resume(otaapply.ResumeInput{
		Pending: p, SelfTest: selfTest, Health: health, Now: now,
	})
	switch action {
	case otaapply.ResumeCommit:
		return e.commit(ctx, p, reason)
	case otaapply.ResumeRevert:
		return e.revert(ctx, p, reason)
	}

	if p.Phase == otaapply.PhaseSelfTest {
		// Getauscht ist getauscht - jetzt urteilt der neue Stand ueber sich.
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateSelfTest, Autonomous: true,
			Release: p.Release, ReleaseSeq: p.ReleaseSeq,
			LastKnownGood: e.lastKnownGood(), Phase: otaapply.PhaseSelfTest,
			DeadlineAt: p.DeadlineAt,
			Reason:     "Der neue Stand prueft sich selbst.",
		})
	}
	return e.driveSwap(ctx, p, now)
}

// driveSwap tauscht die veraenderten Komponenten - EINE nach der anderen.
//
// Idempotent: er vergleicht je Komponente den LAUFENDEN Digest mit dem Ziel.
// Ein Neustart mitten im Tausch fuehrt deshalb nicht zu einem halben Zustand,
// sondern schlicht dazu, dass der naechste Durchlauf dort weitermacht, wo es
// noch etwas zu tun gibt.
func (e *Engine) driveSwap(ctx context.Context, p *otaapply.PendingConfirm, now time.Time) error {
	if proceed, note := otaapply.ApplyingAckDecision(
		e.pendingAckState(p), e.coreSignal(), now.Sub(e.ackSince), e.o.AckWait); !proceed {
		// Der durable `applying`-Bericht ist die einzige Art, „im Update
		// verstummt" von „die Box ist weg" zu unterscheiden. Auf ihn wird
		// gewartet - aber nicht ewig, sonst waere eine Box ohne Broker nie
		// aktualisierbar.
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateApplying, Autonomous: true,
			Release: p.Release, ReleaseSeq: p.ReleaseSeq, Phase: "await_ack",
			DeadlineAt: p.DeadlineAt, NeedApplyingAck: true, AckToken: p.Token,
			Reason: "Der Tausch wartet auf den durablen Zustandsbericht des Kerns.",
		})
	} else if note != "" {
		e.o.Log.Warn("OTA: durabler Bericht nicht bestaetigt", "grund", note)
	}

	current, err := e.runningRefs(ctx, p.Target)
	if err != nil {
		return e.revert(ctx, p, "Der laufende Stand ist nicht feststellbar: "+err.Error())
	}
	changed := otaapply.ChangedComponents(current, p.Target)
	if len(changed) == 0 {
		p.Phase = otaapply.PhaseSelfTest
		if err := otaapply.WriteJSON(e.o.DataDir, otaapply.FilePendingConfirm, p); err != nil {
			return e.revert(ctx, p, "Die Brotkrume konnte nicht fortgeschrieben werden: "+err.Error())
		}
		return e.report(otaapply.UpdaterState{
			State: otaapply.StateSelfTest, Autonomous: true,
			Release: p.Release, ReleaseSeq: p.ReleaseSeq, Phase: otaapply.PhaseSelfTest,
			DeadlineAt: p.DeadlineAt, LastKnownGood: e.lastKnownGood(),
			Reason: "Der neue Stand prueft sich selbst.",
		})
	}

	// Genau EINE Komponente je Durchlauf. Waehrend der Kern getauscht wird,
	// lebt die Staleness-Failsafe von Node-RED - und danach umgekehrt. Beide
	// Failsafe-Kopien sind NIE gleichzeitig weg.
	name := changed[0]
	p.Phase = otaapply.PhaseForComponent(name)
	_ = otaapply.WriteJSON(e.o.DataDir, otaapply.FilePendingConfirm, p)
	_ = e.report(otaapply.UpdaterState{
		State: otaapply.StateApplying, Autonomous: true,
		Release: p.Release, ReleaseSeq: p.ReleaseSeq, Phase: p.Phase,
		DeadlineAt: p.DeadlineAt,
		Reason:     "Die Komponente '" + name + "' wird getauscht.",
	})

	key, err := otaapply.EnvKeyForComponent(name)
	if err != nil {
		return e.revert(ctx, p, err.Error())
	}
	if err := otaapply.SetEnv(e.envPath(), map[string]string{key: p.Target[name]}); err != nil {
		return e.revert(ctx, p, "Der Image-Pin konnte nicht geschrieben werden: "+err.Error())
	}
	if err := e.d.composeUp(ctx, name); err != nil {
		return e.revert(ctx, p, "'"+name+"' konnte nicht gestartet werden: "+err.Error())
	}
	if err := e.waitRunning(ctx, name); err != nil {
		return e.revert(ctx, p, err.Error())
	}
	e.o.Log.Info("OTA: Komponente getauscht", "komponente", name, "ref", p.Target[name])
	return nil
}

// waitRunning wartet gebunden darauf, dass ein getauschter Container laeuft.
func (e *Engine) waitRunning(ctx context.Context, service string) error {
	deadline := e.o.Now().Add(e.o.HealthWait)
	for {
		cid, err := e.d.containerID(ctx, service)
		if err == nil && cid != "" {
			if st, err := e.d.inspect(ctx, cid); err == nil && st.Running {
				// Ein Healthcheck, der noch `starting` sagt, ist KEIN Befund -
				// nur noch keine Aussage. Nur ein ausdrueckliches `unhealthy`
				// ist einer, und darauf wartet niemand ab.
				if st.Health != "unhealthy" {
					return nil
				}
				return fmt.Errorf("'%s' meldet sich unmittelbar nach dem Tausch als nicht gesund", service)
			}
		}
		if !e.o.Now().Before(deadline) {
			return fmt.Errorf("'%s' laeuft %s nach dem Tausch nicht", service,
				e.o.HealthWait.Round(time.Second))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// commit bestaetigt: das Rueckfallziel wird auf den NEUEN, bewiesenen Stand
// gehoben, die Brotkrume verschwindet.
//
// Was hier NICHT passiert: `current.json` schreiben. Den Anti-Rollback-Boden
// setzt ausschliesslich der KERN, und nur gegen seine eigene
// Build-Stempelung - der Sidecar hat Container getauscht, aber ob der richtige
// Stand LAEUFT, kann er nicht bezeugen.
func (e *Engine) commit(ctx context.Context, p *otaapply.PendingConfirm, reason string) error {
	lkg := otaapply.LKG{
		Release: p.Release, ReleaseSeq: p.ReleaseSeq,
		SavedAt: e.o.Now().UTC().Format(otaapply.TimeFormat),
		Images:  map[string]otaapply.LKGImage{},
	}
	for name, ref := range p.Target {
		img := otaapply.LKGImage{Ref: ref, Digest: ref, Tag: lkgTag(name),
			Holder: lkgHolder(name), Tar: e.lkgTar(name)}
		if err := e.hardenLKG(ctx, ref, img); err != nil {
			// Ein nicht gehaertetes Rueckfallziel ist ein Mangel fuer das
			// NAECHSTE Update, kein Grund, dieses zurueckzunehmen: der neue
			// Stand hat seinen Selbsttest bestanden.
			e.o.Log.Warn("OTA: Rueckfallziel konnte nicht vollstaendig gehaertet werden",
				"komponente", name, "err", err)
		}
		lkg.Images[name] = img
	}
	if err := otaapply.WriteJSON(e.o.DataDir, otaapply.FileLKG, lkg); err != nil {
		e.o.Log.Warn("OTA: Rueckfallziel konnte nicht notiert werden", "err", err)
	}
	_ = otaapply.Remove(e.o.DataDir, otaapply.FilePendingConfirm)
	_ = otaapply.Remove(e.o.DataDir, otaapply.FileSelfTest)
	_ = otaapply.Remove(e.o.DataDir, otaapply.FileFailed)
	e.o.Log.Info("OTA: Tausch bestaetigt", "release", p.Release, "grund", reason)
	return e.report(otaapply.UpdaterState{
		State: otaapply.StateSucceeded, Autonomous: true,
		Release: p.Release, ReleaseSeq: p.ReleaseSeq,
		LastKnownGood: p.Release, Reason: reason,
	})
}

// revert nimmt zurueck - offline-faehig, ohne Registry, ohne Neubau.
func (e *Engine) revert(ctx context.Context, p *otaapply.PendingConfirm, reason string) error {
	e.o.Log.Error("OTA: Tausch wird zurueckgenommen", "release", p.Release, "grund", reason)
	_ = e.report(otaapply.UpdaterState{
		State: otaapply.StateApplying, Autonomous: true,
		Release: p.Release, ReleaseSeq: p.ReleaseSeq, Phase: "revert",
		Reason: "Der Tausch wird zurueckgenommen: " + reason,
	})

	var problems []string
	var fromArchive []string
	for _, name := range []string{"core", "nodered"} {
		img, ok := p.Previous.Images[name]
		if !ok {
			continue
		}
		ref := img.Digest
		if ref == "" {
			ref = img.Ref
		}
		if ref == "" {
			continue
		}
		// Ist das Rueckfall-Image ueberhaupt noch da? `docker system prune -a`
		// zwischen Tausch und Ruecknahme ist ein realer Fall - dafuer liegt
		// das Archiv.
		if _, err := e.d.imageID(ctx, ref); err != nil {
			if img.Tar == "" {
				problems = append(problems, name+": kein Rueckfall-Image und kein Archiv")
				continue
			}
			if lerr := e.d.load(ctx, img.Tar); lerr != nil {
				problems = append(problems, name+": "+lerr.Error())
				continue
			}
			// **Ein Archiv kann keinen Registry-Digest zurueckbringen** (live
			// nachgemessen: `docker load` legt das Image ohne RepoDigest ab).
			// Wiederherstellbar ist genau der lokale `:lkg`-Tag, unter dem
			// gesichert wurde - also wird auf ihn gepinnt. Das ist der
			// Unterschied zwischen einer Box, die nach einem `prune -a` wieder
			// laeuft, und einer, die auf einen nicht mehr aufloesbaren Digest
			// zeigt.
			if _, err := e.d.imageID(ctx, ref); err != nil {
				if img.Tag == "" {
					problems = append(problems, name+": das Archiv traegt keinen brauchbaren Tag")
					continue
				}
				if _, terr := e.d.imageID(ctx, img.Tag); terr != nil {
					problems = append(problems, name+": "+terr.Error())
					continue
				}
				ref = img.Tag
				fromArchive = append(fromArchive, name)
			}
		}
		key, err := otaapply.EnvKeyForComponent(name)
		if err != nil {
			continue
		}
		if err := otaapply.SetEnv(e.envPath(), map[string]string{key: ref}); err != nil {
			problems = append(problems, name+": "+err.Error())
			continue
		}
		if err := e.d.composeUp(ctx, name); err != nil {
			problems = append(problems, name+": "+err.Error())
		}
	}

	if restored, err := otaapply.RestoreSnapshot(e.o.DataDir); err != nil {
		problems = append(problems, "Zustand: "+err.Error())
	} else if len(restored) > 0 {
		e.o.Log.Warn("OTA: Zustand aus der Sicherung zurueckgesetzt",
			"dateien", strings.Join(restored, ", "))
	}

	// Merken, dass GENAU DIESES Release hier nicht laeuft - sonst begaenne der
	// naechste Takt denselben Tausch von vorn (siehe otaapply.FailedRelease).
	failed := otaapply.FailedRelease{Release: p.Release, ReleaseSeq: p.ReleaseSeq,
		Reason: reason, At: e.o.Now().UTC().Format(otaapply.TimeFormat), Attempts: 1}
	if prev := e.failedRelease(); prev != nil && prev.Release == p.Release {
		failed.Attempts = prev.Attempts + 1
	}
	if err := otaapply.WriteJSON(e.o.DataDir, otaapply.FileFailed, failed); err != nil {
		e.o.Log.Error("OTA: der Fehlschlag konnte nicht vermerkt werden - "+
			"ohne den Vermerk wuerde derselbe Tausch erneut beginnen", "err", err)
	}
	_ = otaapply.Remove(e.o.DataDir, otaapply.FilePendingConfirm)
	_ = otaapply.Remove(e.o.DataDir, otaapply.FileSelfTest)

	full := reason
	if len(fromArchive) > 0 {
		// Ehrlich benennen: die Box laeuft jetzt aus dem lokalen Archiv, nicht
		// von einem Registry-Digest. Ein spaeteres blankes `docker compose up
		// -d` (pull_policy: always) wuerde versuchen, diesen lokalen Tag zu
		// ziehen - der naechste `update.sh`-Lauf pinnt wieder sauber.
		full += " Das Rueckfall-Image kam aus dem lokalen Archiv (" +
			strings.Join(fromArchive, ", ") + "), die Box laeuft jetzt auf dem " +
			"lokalen Rueckfall-Tag statt auf einem Registry-Digest."
		e.o.Log.Warn("OTA: Rueckfall aus dem lokalen Archiv - der naechste " +
			"update.sh-Lauf sollte wieder auf einen Digest pinnen")
	}
	if len(problems) > 0 {
		// Eine halb gelungene Ruecknahme wird BENANNT, nie geschoent.
		full += " Achtung: die Ruecknahme war nicht vollstaendig (" +
			strings.Join(problems, "; ") + ")."
	}
	return e.report(otaapply.UpdaterState{
		State: otaapply.StateRolledBack, Autonomous: true,
		Release: p.Release, ReleaseSeq: p.ReleaseSeq,
		LastKnownGood: p.Previous.Release, Reason: full,
	})
}

// captureLKG sichert, was JETZT laeuft - dreifach: Tag, gestoppter Container,
// Archiv.
func (e *Engine) captureLKG(ctx context.Context, m *otaverify.Manifest,
	target map[string]string) (otaapply.LKG, error) {
	lkg := otaapply.LKG{
		SavedAt: e.o.Now().UTC().Format(otaapply.TimeFormat),
		Images:  map[string]otaapply.LKGImage{},
	}
	if cur := otaapply.ReadCurrent(e.o.DataDir); cur != nil {
		lkg.Release, lkg.ReleaseSeq = cur.Release, cur.ReleaseSeq
	}
	running, err := e.runningRefs(ctx, target)
	if err != nil {
		return lkg, err
	}
	for name := range target {
		ref := running[name]
		if ref == "" {
			// Ohne aufloesbaren Digest gibt es fuer diese Komponente kein
			// belastbares Rueckfallziel. Das ist ein Grund, NICHT zu tauschen -
			// nicht einer, es trotzdem zu tun.
			return lkg, fmt.Errorf("fuer '%s' ist der laufende Digest nicht feststellbar", name)
		}
		img := otaapply.LKGImage{Ref: ref, Digest: ref, Tag: lkgTag(name),
			Holder: lkgHolder(name), Tar: e.lkgTar(name)}
		if err := e.hardenLKG(ctx, ref, img); err != nil {
			return lkg, err
		}
		lkg.Images[name] = img
	}
	return lkg, nil
}

// hardenLKG macht EIN Rueckfall-Image ueberlebensfaehig.
func (e *Engine) hardenLKG(ctx context.Context, ref string, img otaapply.LKGImage) error {
	if err := e.d.tag(ctx, ref, img.Tag); err != nil {
		return err
	}
	// Der gestoppte Container ist der Teil, der `docker system prune -a`
	// ueberlebt - ein blosser Tag nicht.
	if err := e.d.holdImage(ctx, img.Holder, img.Tag); err != nil {
		return err
	}
	if img.Tar == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(img.Tar), 0o755); err != nil {
		return err
	}
	// Das Archiv ist die dritte Kopie - fuer den Fall, dass jemand auch die
	// Container weggeraeumt hat, und fuer eine Box ohne Registry-Zugang.
	return e.d.save(ctx, img.Tag, img.Tar)
}

// runningRefs loest je Komponente den Registry-Digest des LAUFENDEN Images auf.
func (e *Engine) runningRefs(ctx context.Context, target map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for name := range target {
		cid, err := e.d.containerID(ctx, name)
		if err != nil {
			return nil, err
		}
		if cid == "" {
			continue
		}
		st, err := e.d.inspect(ctx, cid)
		if err != nil || st.ImageID == "" {
			continue
		}
		digests, err := e.d.repoDigests(ctx, st.ImageID)
		if err != nil {
			continue
		}
		out[name] = pickDigest(digests, target[name])
	}
	return out, nil
}

// pickDigest waehlt den Digest aus DEMSELBEN Repository wie das Ziel.
//
// Ein Image kann mehrere Repo-Digests tragen (dasselbe Image unter zwei
// Registries). Der Vergleich „laeuft schon das Ziel?" ist nur dann eine
// Aussage, wenn beide Seiten aus demselben Repository stammen.
func pickDigest(digests []string, targetRef string) string {
	repo, _, _ := strings.Cut(targetRef, "@")
	for _, d := range digests {
		if r, _, ok := strings.Cut(d, "@"); ok && r == repo {
			return d
		}
	}
	if len(digests) > 0 {
		return digests[0]
	}
	return ""
}

// health beobachtet die Container des laufenden Vorgangs.
func (e *Engine) health(ctx context.Context, p *otaapply.PendingConfirm) []otaapply.ComponentHealth {
	var out []otaapply.ComponentHealth
	for _, name := range []string{"core", "nodered"} {
		if _, ok := p.Target[name]; !ok {
			continue
		}
		cid, err := e.d.containerID(ctx, name)
		if err != nil || cid == "" {
			continue
		}
		st, err := e.d.inspect(ctx, cid)
		if err != nil {
			continue
		}
		h := otaapply.ComponentHealth{Component: name, Running: st.Running, Restarts: st.Restarts}
		switch st.Health {
		case "healthy":
			ok := true
			h.Healthy = &ok
		case "unhealthy":
			no := false
			h.Healthy = &no
		}
		out = append(out, h)
	}
	return out
}

func (e *Engine) coreSignal() *otaapply.CoreSignal {
	sig, _ := otaapply.ReadJSON[otaapply.CoreSignal](e.o.DataDir, otaapply.FileCoreSignal)
	return sig
}

func (e *Engine) pendingAckState(p *otaapply.PendingConfirm) *otaapply.UpdaterState {
	return &otaapply.UpdaterState{AckToken: p.Token}
}

// stateSchemaOnDisk ist die /data-Zustandsversion, die das zuletzt AUTONOM
// angewandte Release mitbrachte. 0 = keine Aussage (jeder beaufsichtigt
// angewandte Stand) - und Decide behandelt 0 ausdruecklich als „nicht
// bewertbar" statt als „Version 0".
func (e *Engine) stateSchemaOnDisk() int {
	if cur := otaapply.ReadCurrent(e.o.DataDir); cur != nil {
		return cur.StateSchema
	}
	return 0
}

// failedRelease liest den Merkzettel ueber ein hier zurueckgenommenes Release.
func (e *Engine) failedRelease() *otaapply.FailedRelease {
	f, err := otaapply.ReadJSON[otaapply.FailedRelease](e.o.DataDir, otaapply.FileFailed)
	if err != nil {
		return nil
	}
	return f
}

func (e *Engine) lastKnownGood() string {
	lkg, err := otaapply.ReadJSON[otaapply.LKG](e.o.DataDir, otaapply.FileLKG)
	if err != nil || lkg == nil {
		return ""
	}
	return lkg.Release
}

func (e *Engine) envPath() string { return filepath.Join(e.o.DeployDir, ".env") }

func (e *Engine) lkgTar(name string) string {
	return filepath.Join(otaapply.Dir(e.o.DataDir), otaapply.SubdirLKG, name+".tar")
}

func lkgTag(name string) string    { return "vp-edge-lkg-" + name + ":lkg" }
func lkgHolder(name string) string { return "vp-edge-lkg-" + name }

func (e *Engine) fail(st otaapply.UpdaterState, reason string) error {
	st.State = otaapply.StateFailed
	st.Reason = reason
	st.Phase = ""
	e.o.Log.Error("OTA: Tausch abgelehnt", "grund", reason)
	return e.report(st)
}

// report schreibt den Zustand fuer den Kern (und damit fuer Herzschlag und
// `:8484`).
func (e *Engine) report(st otaapply.UpdaterState) error {
	st.UpdatedAt = e.o.Now().UTC().Format(otaapply.TimeFormat)
	if st.State == "" {
		st.State = otaapply.StateIdle
	}
	return otaapply.WriteJSON(e.o.DataDir, otaapply.FileUpdaterState, st)
}

func randomToken() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
