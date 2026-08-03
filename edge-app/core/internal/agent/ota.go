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
	// stamp ist der ModTime+Groessen-Stempel der Manifestdatei - eine
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
}

// otaCheckLoop prueft periodisch, ob ein Release abgelegt wurde, und haelt das
// Urteil fuer den Herzschlag bereit. Er WENDET NICHTS AN.
func (a *Agent) otaCheckLoop(ctx context.Context) {
	defer a.done.Done()
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
func (a *Agent) otaCheckOnce() {
	dir := filepath.Join(a.Cfg.DataDir, otaDir)
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
	a.ota.mu.Lock()
	defer a.ota.mu.Unlock()
	st := a.ota.v.state
	if st == "" {
		st = cloud.UpdateStateIdle
	}
	return st, a.ota.v.reason
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
func (a *Agent) updateSummary() *cloud.UpdateSummary {
	st, reason := a.OtaVerdict()
	return &cloud.UpdateSummary{
		Backend: cloud.UpdateBackendCompose,
		Current: Version,
		State:   st,
		Reason:  reason,
	}
}
