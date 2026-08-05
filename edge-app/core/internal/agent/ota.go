package agent

// OTA Stufe 0 „Sehen" + Stufe 1 „Vertrauen" (scout vp-ota-rollout-h4 §9): the
// device's own report of what it is running, and - since Stufe 1 - its VERDICT
// on a release manifest that was placed on it.
//
// **There is still NO write path and NO apply path here.** Stufe 1 makes every
// future apply cryptographically covered; it applies nothing. The strongest
// statement this file can produce is „verifiziert, Anwendung erst in Stufe 2/3".
//
// Stufe 0 closed the first of the three documented holes in the fleet's version
// view: the core version used to travel ONLY inside the `flows` ack block, and
// the edge does not build that block until it has seen its first flow
// deployment - so a box on which no automation was ever rolled out reported no
// version at all. The top-level `version` field now rides every heartbeat
// (see cloud.Link.version), and the `update` block below rides next to it.

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Der Ablageort, an dem ein Release auf dem Geraet liegt.
//
// In Stufe 1 gibt es noch KEINEN MQTT-Downlink (der ist Stufe 2), also ist die
// Quelle eine Datei - genau so, wie der Sidecar der Stufe 3 sie spaeter erneut
// verifizieren wird, und genau so, wie ein beaufsichtigter Test auf einer Box
// laeuft: die vier Dateien in `<data_dir>/ota/` ablegen und den Herzschlag bzw.
// `/health` beobachten.
const (
	otaDir           = "ota"
	otaManifestFile  = "release.json"
	otaTrustSetFile  = "trust-set.json"
	otaSigSuffix     = ".sig"
	otaCurrentFile   = "current.json"
	otaCheckInterval = 30 * time.Second
)

// otaVerdict ist das zwischengespeicherte Urteil des letzten Pruefdurchlaufs.
type otaVerdict struct {
	// state/reason sind das, was der Herzschlag traegt.
	state  string
	reason string
	// release/seq sind nur bei bestandener Signaturpruefung gesetzt.
	release string
	seq     int64
	// target/targetSeq/channel beschreiben die CLOUD-Zuweisung (Stufe 2) und
	// sind leer, solange keine vorliegt. Sobald ein Manifest geprueft ist,
	// stammen sie aus DIESEM, nicht aus dem unsignierten Umschlag.
	target    string
	targetSeq int64
	channel   string
	// targetVerdict ist das Urteil des Verifizierers ueber die Zuweisung
	// (ok | deferred | rejected), leer ohne Zuweisung. Es steht NEBEN state,
	// weil beide verschiedene Fragen beantworten: state ist der Zustand der
	// Anwendung, targetVerdict der der PRUEFUNG. In dieser Stufe ist
	// „verifiziert, wartet auf den Menschen" und „gilt hier nicht" beides
	// state=deferred - nur targetVerdict trennt sie maschinenlesbar, damit
	// keine Oberflaeche den deutschen Grund nach Stichworten durchsuchen muss.
	targetVerdict string
	// stamp ist der ModTime+Groessen-Stempel der geprueften Quelle - eine
	// unveraenderte Datei wird nicht bei jedem Tick neu verifiziert.
	stamp string
}

// otaCurrent ist der lokal bekannte eigene Release-Stand.
//
// Stufe 1 LIEST diese Datei nur; geschrieben wird sie erst, wenn ein Update
// tatsaechlich angewandt und bestaetigt wurde (Stufe 3). Fehlt sie, ist der
// Anti-Rollback-Boden schlicht nicht bewertbar - der Verifizierer sagt das,
// statt eine Sequenznummer zu erfinden (die Cloud ordnet Releases genau danach).
//
// Ehrliche Grenze: diese Datei ist integritaetsrelevanter LOKALER Zustand, kein
// Vertrauensanker. Wer `/data` beschreiben kann, kann den Boden absenken - dort
// liegt aber ohnehin die Geraeteidentitaet (device.key). Der uhrunabhaengige
// Widerruf bleibt das root-signierte Trust-Set, und Stufe 3 darf diesen Stand
// nur je ERHOEHEN.
type otaCurrent struct {
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
}

// otaState haelt das Urteil zwischen den Herzschlaegen.
type otaState struct {
	mu sync.Mutex
	v  otaVerdict
	// trust ist die zwischengespeicherte Vertrauens-Identitaet (Stufe 4). Sie
	// haengt bewusst NICHT an otaVerdict: das Urteil wird in mehreren Pfaden
	// vollstaendig ersetzt (Ziel, Datei, „nichts abgelegt"), die Identitaet
	// aber gilt unabhaengig davon - eine Box ohne Release hat trotzdem eine.
	trust *cloud.TrustSummary
	// trustStamp ist der ModTime+Groessen-Stempel des Trust-Sets, damit die
	// Ed25519-Pruefung nicht bei jedem 30-s-Takt erneut laeuft.
	trustStamp string
}

// otaCheckLoop prueft periodisch, ob ein Release abgelegt wurde, und haelt das
// Urteil fuer den Herzschlag bereit. Er WENDET NICHTS AN.
func (a *Agent) otaCheckLoop(ctx context.Context) {
	defer a.done.Done()
	// Das Ablage-Verzeichnis EINMAL anlegen, und zwar HIER - damit es dem
	// Nutzer gehoert, unter dem der Core laeuft (das Image faehrt als
	// `voltpilot`, nicht als root).
	//
	// ⚠ Der Grund ist ein gemessener Fallstrick des Installers: `docker cp`
	// eines VERZEICHNISSES setzt den Besitzer des ZIELVERZEICHNISSES auf die
	// uid des Hosts (gemessen: 501:root bzw. root:root). `/data/ota` gehoerte
	// danach nicht mehr dem Core - er koennte `target.json`/`current.json`
	// nicht mehr schreiben, also weder eine Zuweisung ablegen noch bezeugen,
	// was laeuft. Existiert das Verzeichnis dagegen schon, kopiert der
	// Installer nur noch DATEIEN hinein, und der Besitz des Verzeichnisses
	// bleibt unberuehrt (bewiesen in edge-app/test/install-selfcheck.sh).
	//
	// Ein Fehlschlag ist bewusst nicht fatal: das Verzeichnis ist ein
	// Bequemlichkeits-Vorgriff, jeder Schreibpfad legt es ohnehin selbst an,
	// und ein unbeschreibbares /data hat laengst der Enroll-Pfad gemeldet.
	if err := os.MkdirAll(a.otaDir(), 0o755); err != nil {
		slog.Warn("OTA: Ablage-Verzeichnis konnte nicht angelegt werden", "err", err)
	}
	a.otaCheckOnce()
	t := time.NewTicker(otaCheckInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.otaCheckOnce()
		}
	}
}

// otaCheckOnce liest die abgelegten Dateien und verifiziert sie EINMAL.
//
// PRAEZEDENZ (Stufe 2): eine CLOUD-Zuweisung gewinnt vor dem beaufsichtigten
// Dateipfad der Stufe 1. Beide koennen gleichzeitig existieren - der Dateipfad
// bleibt der Weg fuer den TOFU-Test und fuer eine Box ohne Cloud-Link -, aber
// es darf nur EIN Urteil im Herzschlag stehen, und das der Zuweisung ist das,
// gegen das der Rollout im Portal misst.
func (a *Agent) otaCheckOnce() {
	// Die Vertrauens-Identitaet zuerst und UNABHAENGIG von allem Weiteren: sie
	// ist die Aussage „gegen welche Wurzel prueft diese Box, und welche
	// Release-Schluessel gelten hier" - sie gilt auch ohne jede Zuweisung und
	// ohne jedes abgelegte Release, und genau dann braucht der Betreiber sie
	// (offener TOFU-Crossover, laufende Schluessel-Rotation).
	a.otaRefreshTrust()
	if v, ok := a.otaCheckTarget(); ok {
		a.setOtaVerdict(v)
		return
	}
	dir := a.otaDir()
	fi, err := os.Stat(filepath.Join(dir, otaManifestFile))
	if err != nil {
		// Kein abgelegtes Release ist der NORMALFALL, kein Fehler: idle, ohne
		// Grund. Ein „Grund" waere hier eine Beschwerde ueber Nichts.
		a.setOtaVerdict(otaVerdict{state: cloud.UpdateStateIdle})
		return
	}
	stamp := fi.ModTime().UTC().Format(time.RFC3339Nano) + ":" + strconv.FormatInt(fi.Size(), 10)
	a.ota.mu.Lock()
	unchanged := a.ota.v.stamp == stamp
	a.ota.mu.Unlock()
	if unchanged {
		return
	}

	// `verifying` ist der TRANSIENTE Zustand waehrend der Pruefung. Er wird
	// gesetzt, obwohl die Pruefung meist schneller ist als ein Herzschlag: der
	// Zustandsautomat des Kontrakts (§5) soll echt sein und nicht erst in
	// Stufe 2 nachgeruestet werden, und auf einer langsamen Box ist er
	// beobachtbar.
	a.setOtaVerdict(otaVerdict{state: cloud.UpdateStateVerifying, stamp: stamp})

	v := a.otaVerify(dir)
	v.stamp = stamp
	a.setOtaVerdict(v)
}

// otaVerify fuehrt die eigentliche Pruefung durch und uebersetzt das Urteil in
// den Zustand + den deutschen Grund des Herzschlags.
func (a *Agent) otaVerify(dir string) otaVerdict {
	read := func(name string) []byte {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil
		}
		return raw
	}

	roots := a.otaRoots
	if roots == nil {
		var err error
		if roots, err = otaverify.BakedRoots(); err != nil {
			return otaVerdict{state: cloud.UpdateStateIdle,
				reason: "Der eingebackene Vertrauensanker ist unlesbar - es kann kein Release geprueft werden."}
		}
	}

	in := otaverify.Input{
		Roots:       roots,
		TrustSet:    read(otaTrustSetFile),
		TrustSetSig: read(otaTrustSetFile + otaSigSuffix),
		Manifest:    read(otaManifestFile),
		ManifestSig: read(otaManifestFile + otaSigSuffix),
		Backend:     cloud.UpdateBackendCompose,
		// Der Build-Stempel: daraus erkennt der Verifizierer, ob das gepruefte
		// Release genau das ist, was hier laeuft.
		RunningVersion: Version,
		// Die Geraetezeit wird BEWUSST uebergeben, obwohl sie nicht
		// vertrauenswuerdig ist: sie wirkt nur beim Schluessel-Ablauf, wo ein
		// Irrtum ins Ablehnen faellt (die sichere Richtung), und bei
		// valid_until, das ohnehin nur berichtet wird.
		Now: time.Now(),
	}
	if cur := a.otaReadCurrent(dir); cur != nil {
		seq := cur.ReleaseSeq
		in.CurrentSeq = &seq
	}

	res := otaverify.Verify(in)
	out := otaVerdict{state: cloud.UpdateStateIdle, reason: res.Reason}
	if res.Manifest != nil {
		out.release = res.Manifest.Release
		out.seq = res.Manifest.ReleaseSeq
	}

	switch res.Outcome {
	case otaverify.OutcomeOK:
		// DIE Aussage der Stufe 1: geprueft - und ausdruecklich NICHT angewandt.
		// Wer „verifiziert" liest, darf daraus nie schliessen, dass die Box
		// gleich neu startet.
		out.reason = res.Reason + " Anwendung erst in Stufe 2/3."
		if res.AlreadyRunning {
			out.reason = "Release " + res.Manifest.Release + " ist verifiziert und laeuft hier bereits."
		}
		slog.Info("OTA: Release verifiziert (in dieser Stufe wird nichts angewandt)",
			"release", res.Manifest.Release, "release_seq", res.Manifest.ReleaseSeq,
			"signiert_von", res.SignedBy, "laeuft_bereits", res.AlreadyRunning)
	case otaverify.OutcomeDeferred:
		slog.Warn("OTA: Release ist gueltig signiert, gilt aber nicht fuer dieses Geraet",
			"grund", res.Reason)
	case otaverify.OutcomeRejected:
		// Eine gebrochene Kette ist ein SICHERHEITS-Ereignis und darf nie wie
		// ein „passt gerade nicht" aussehen.
		slog.Error("OTA: Release ABGELEHNT - Vertrauenskette oder Form fehlerhaft",
			"grund", res.Reason)
	}
	for _, n := range res.Notes {
		slog.Info("OTA: Hinweis", "hinweis", n)
	}
	return out
}

// otaDir ist das Ablageverzeichnis (<data_dir>/ota).
func (a *Agent) otaDir() string {
	return filepath.Join(a.Cfg.DataDir, otaDir)
}

// otaRefreshTrust ermittelt die Vertrauens-Identitaet und legt sie ab.
//
// Sie wird bei JEDEM Takt gebildet, aber nur dann wirklich neu VERIFIZIERT,
// wenn sich das abgelegte Trust-Set geaendert hat (Stempel aus ModTime+Groesse
// wie beim Release) - die gebackene Wurzel selbst kann sich zur Laufzeit nicht
// aendern, sie ist ins Binaer eingebacken.
func (a *Agent) otaRefreshTrust() {
	dir := a.otaDir()
	stamp := "none"
	if fi, err := os.Stat(filepath.Join(dir, otaTrustSetFile)); err == nil {
		stamp = fi.ModTime().UTC().Format(time.RFC3339Nano) + ":" +
			strconv.FormatInt(fi.Size(), 10)
	}
	a.ota.mu.Lock()
	unchanged := a.ota.trust != nil && a.ota.trustStamp == stamp
	a.ota.mu.Unlock()
	if unchanged {
		return
	}

	roots := a.otaRoots
	if roots == nil {
		// Ein unlesbares gebackenes Set ist NICHT dasselbe wie ein leeres: das
		// eine ist ein kaputtes Image, das andere der dokumentierte
		// Vor-Zeremonie-Zustand. Ein Fehler hier faellt deshalb auf „keine
		// Wurzel" zurueck und InspectTrust nennt den Grund.
		roots, _ = otaverify.BakedRoots()
	}
	read := func(name string) []byte {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil
		}
		return raw
	}
	info := otaverify.InspectTrust(roots, read(otaTrustSetFile),
		read(otaTrustSetFile+otaSigSuffix), time.Now())
	sum := &cloud.TrustSummary{
		// Nie nil: eine leere LISTE heisst „Image ohne Wurzel", ein fehlender
		// Block heisst „aelterer Stand". Die Cloud muss beides unterscheiden
		// koennen, also darf das JSON hier nie `null` werden.
		RootKeyIDs:          append([]string{}, info.RootKeyIDs...),
		TrustSetKeyIDs:      info.TrustSetKeyIDs,
		TrustSetGeneratedAt: info.TrustSetGeneratedAt,
		TrustSetSignedBy:    info.TrustSetSignedBy,
		TrustSetError:       info.TrustSetError,
	}
	a.ota.mu.Lock()
	a.ota.trust = sum
	a.ota.trustStamp = stamp
	a.ota.mu.Unlock()
}

// otaTrust liefert die zwischengespeicherte Vertrauens-Identitaet.
func (a *Agent) otaTrust() *cloud.TrustSummary {
	a.ota.mu.Lock()
	defer a.ota.mu.Unlock()
	return a.ota.trust
}

// otaForceRecheck verwirft den Stempel, sodass der naechste Durchlauf wirklich
// neu verifiziert (nach einem aufgezeichneten Anwenden hat sich der
// Anti-Rollback-Boden geaendert, die Datei aber nicht).
func (a *Agent) otaForceRecheck() {
	a.ota.mu.Lock()
	a.ota.v.stamp = ""
	a.ota.mu.Unlock()
	a.otaCheckOnce()
}

// otaWriteCurrent schreibt den eigenen Stand atomar (tmp + rename).
//
// Bis Stufe 2 schrieb ihn NICHTS - erst ein beaufsichtigt angewandtes Update
// darf ihn setzen, und nur je nach OBEN (siehe Agent.OtaRecordApplied).
func (a *Agent) otaWriteCurrent(dir string, c otaCurrent) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, otaCurrentFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *Agent) otaReadCurrent(dir string) *otaCurrent {
	raw, err := os.ReadFile(filepath.Join(dir, otaCurrentFile))
	if err != nil {
		return nil
	}
	var c otaCurrent
	if err := json.Unmarshal(raw, &c); err != nil || c.ReleaseSeq < 1 {
		// Ein unlesbarer oder unsinniger eigener Stand wird VERWORFEN, nicht
		// geraten: „unbekannt" ist eine ehrliche Antwort, eine erfundene
		// Sequenznummer waere eine, die den Boden aushebelt.
		return nil
	}
	return &c
}

func (a *Agent) setOtaVerdict(v otaVerdict) {
	a.ota.mu.Lock()
	if v.stamp == "" {
		v.stamp = a.ota.v.stamp
	}
	a.ota.v = v
	a.ota.mu.Unlock()
	// Auch lokal sichtbar machen: /health ist der Endpunkt, den ein
	// beaufsichtigter Test auf der Box ohne Cloud-Verbindung abfragt.
	if a.State != nil {
		a.State.Update(func(s *state.Snapshot) {
			s.OtaState = v.state
			s.OtaReason = v.reason
		})
	}
}

// OtaVerdict liefert Zustand + Grund fuer die lokalen Oberflaechen (/health).
func (a *Agent) OtaVerdict() (state, reason string) {
	v := a.otaSnapshot()
	return v.state, v.reason
}

// otaSnapshot liefert das aktuelle Urteil mit aufgefuelltem Vorgabe-Zustand.
func (a *Agent) otaSnapshot() otaVerdict {
	a.ota.mu.Lock()
	defer a.ota.mu.Unlock()
	v := a.ota.v
	if v.state == "" {
		v.state = cloud.UpdateStateIdle
	}
	return v
}

// updateSummary builds the additive `update` heartbeat block.
//
// **Honesty over completeness.** It fills only what the box can actually know:
// the backend, the version it is running (verbatim as stamped), the state and -
// since Stufe 1 - the German reason of the last verification. Everything else
// stays ABSENT rather than invented:
//
//   - CurrentSeq/TargetSeq/Target/Channel need the cloud's release register and
//     a target assignment - neither exists on the device before Stufe 2. (The
//     locally readable current.json is deliberately NOT reported as
//     current_seq: it is a local floor input, not the register's ordering.)
//   - LastKnownGood needs an update to have been applied and committed once;
//     a box that never updated has no last-known-good, and claiming the
//     current version as one would fabricate a rollback target.
//
// `current` is the stamped version VERBATIM: an existing build is stamped with
// a bare 12-char commit SHA, and splitting or reformatting it would invent a
// release tag the box was never built with.
//
// The state stays `idle` even after a successful verification: `verifying` is
// TRANSIENT (it describes the check while it runs), and reporting it afterwards
// would claim an ongoing activity that does not exist - the same discipline
// that keeps the block free of a fabricated target.
// Seit Stufe 2 ist ein Teil davon FUELLBAR - aber jedes Feld nur aus einer
// Quelle, die es wirklich belegt:
//
//   - Target/TargetSeq/Channel stehen NUR, wenn eine Cloud-Zuweisung vorliegt,
//     und stammen dann aus dem VERIFIZIERTEN Manifest (der Umschlag ist
//     unsigniert; wo die Pruefung scheiterte, bleibt sein Wert stehen, aber
//     TargetVerdict sagt „rejected" dazu).
//   - CurrentSeq kommt aus dem aufgezeichneten eigenen Stand - und AUCH dann
//     nur, wenn dieser Stand die Build-Stempelung DIESES Prozesses benennt.
//     Damit ist er kein geglaubter Eintrag mehr, sondern eine Aussage ueber
//     das, was nachweislich laeuft: eine von Hand hingelegte current.json
//     eines fremden Standes faerbt die Flottensicht nicht ein.
//   - LastKnownGood bleibt weiterhin LEER: es gibt in dieser Stufe keinen
//     Rollback-Mechanismus, und die laufende Version als „last known good"
//     auszugeben, erfaende ein Rueckfallziel.
func (a *Agent) updateSummary() *cloud.UpdateSummary {
	v := a.otaSnapshot()
	sum := &cloud.UpdateSummary{
		Backend:       cloud.UpdateBackendCompose,
		Current:       Version,
		State:         v.state,
		Reason:        v.reason,
		Target:        v.target,
		Channel:       v.channel,
		TargetVerdict: v.targetVerdict,
		Trust:         a.otaTrust(),
	}
	if v.targetSeq > 0 {
		seq := v.targetSeq
		sum.TargetSeq = &seq
	}
	if cur := a.otaReadCurrent(a.otaDir()); cur != nil &&
		otaverify.ReleaseIsRunning(cur.Release, Version) {
		seq := cur.ReleaseSeq
		sum.CurrentSeq = &seq
	}
	// Seit Stufe 3 kann ein SIDECAR gerade wirklich anwenden. Dann ist SEIN
	// Zustand die Wahrheit ueber die Anwendung (das Urteil des Kerns bleibt
	// die Wahrheit ueber die PRUEFUNG, target_verdict). Ohne Sidecar bzw. bei
	// `idle` ist der Block zeichengleich der der Stufe 2.
	a.otaUpdaterOverlay(sum)
	// Ob eine Portal-Freigabe ueberhaupt aufgegriffen wuerde, weiss NUR die
	// Box (laeuft hier ein Sidecar? ist die Zuweisung geprueft?). Sie sagt es,
	// damit das Portal keinen Knopf anbietet, der nichts bewirken kann - es
	// ist eine FAEHIGKEIT, keine Erlaubnis (`UpdateSummary.CanApply`).
	sum.CanApply = a.OtaApplyState().CanApply
	return sum
}
