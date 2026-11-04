package agent

// Edge Light: das Update im PROGRAMM (Konzept vp-edge-light-update, K3; U-3 A).
//
// Die Docker-Box tauscht mit einem eigenen Updater-Container. Edge Light ist
// ein einziges Programm, und sein Loader boot.sh tauscht beim Start. Das
// laufende Programm tut drei Dinge, die der Loader nicht kann:
//
//  1. Es PRUEFT die Zuweisung (Kette gegen die eingebackene Wurzel, Box-Art,
//     Rueckschritt - wie heute) und entscheidet, ob angewandt wird
//     (otalight.Entscheide: eigene Plattform, Datenformat, kein neuer Versuch
//     ohne neue Zuweisung).
//  2. Es LAEDT die gepackte Fassung aus dem Portal in den RAM, prueft sie gegen
//     gz_sha256/gz_size aus dem gepruften Manifest, legt kandidat.json daneben,
//     meldet `applying` durabel und beendet sich. procd startet den Loader.
//  3. Laeuft es selbst zur Probe, macht es den Selbsttest der Docker-Box -
//     mit einer Pflicht mehr: die Cloud muss erreicht sein, denn das Programm
//     ist der einzige Weg fuer das naechste Update.
//
// Was in den Flash kommt, entscheidet der Loader; current.json schreibt das
// Programm erst, wenn es AUSSERHALB der Probe laeuft - dann ist es die
// bestaetigte Fassung aus dem Flash.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otalight"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const (
	// otaLightRetry: so lange wartet ein gescheiterter Download (Netz,
	// Portal), bevor er erneut versucht wird. Die Zuweisung bleibt liegen.
	otaLightRetry = 10 * time.Minute
	// otaLightDownloadTimeout begrenzt einen Download (~5 MB) insgesamt.
	otaLightDownloadTimeout = 10 * time.Minute
	// otaLightProbeTakt: so oft prueft das Programm in der Probe erneut,
	// bis der Selbsttest mit Cloud gruen ist.
	otaLightProbeTakt = 5 * time.Second
	// otaLightRAMReserve: so viel Arbeitsspeicher muss NACH dem Download
	// noch verfuegbar sein (Speicher, Schicht 7).
	otaLightRAMReserve = 8 << 20
)

// otaLightState haelt den Stand eines Edge-Light-Updates zwischen den Takten.
type otaLightState struct {
	mu sync.Mutex
	// zuw ist die Zuweisung, fuer die state/reason gelten.
	zuw     string
	state   string
	reason  string
	busy    bool
	retryAt time.Time
	// gescheitert: Zuweisungen, deren Lieferung nicht zum Manifest passte -
	// kein neuer Versuch ohne neue Zuweisung.
	gescheitert map[string]string

	// Testnaehte (nil = echt).
	beenden  func()
	client   *http.Client
	memAvail func() (int64, bool)
	now      func() time.Time
}

// isLight sagt, ob dieses Programm Edge Light ist.
func (a *Agent) isLight() bool { return a.boxArt() == geraetesuche.BoxArtEdgeLight }

// otaRAMDir ist das Verzeichnis der fluechtigen Update-Dateien: auf Edge Light
// mit neuem Loader der RAM (Config.OtaRAMDir), sonst DataDir/ota.
func (a *Agent) otaRAMDir() string {
	if a.isLight() && a.Cfg.OtaRAMDir != "" {
		return a.Cfg.OtaRAMDir
	}
	return a.otaDir()
}

// otaTargetStore ist die Ablage der retained Zuweisung. Edge Light haelt sie im
// RAM: sie kommt nach jedem Verbinden ohnehin wieder.
func (a *Agent) otaTargetStore() *otatarget.Store {
	if a.isLight() && a.Cfg.OtaRAMDir != "" {
		return otatarget.NewStoreAt(a.Cfg.OtaRAMDir)
	}
	return otatarget.NewStore(a.Cfg.DataDir)
}

// otaLightLoaderBereit: nur ein Loader, der das Protokoll kennt, setzt
// VP_OTA_RAM_DIR. Ein alter Loader (Stufe 1) wuerde den Kandidaten nie
// tauschen - das Programm luede dann nach jedem Neustart erneut.
func (a *Agent) otaLightLoaderBereit() bool { return a.Cfg.OtaRAMDir != "" }

func (a *Agent) otaLightNow() time.Time {
	if a.otaLight.now != nil {
		return a.otaLight.now()
	}
	return time.Now()
}

// otaLightSchritt verfeinert das Urteil ueber die Zuweisung zu dem, was auf
// Edge Light gerade geschieht - und stoesst das Laden an. Er laeuft bei jedem
// Pruef-Takt (30 s) und bei jeder neuen Zuweisung; er ist idempotent.
func (a *Agent) otaLightSchritt(v otaVerdict) otaVerdict {
	if v.targetVerdict != string(otaverify.OutcomeOK) || v.release == "" {
		return v
	}
	ram := a.otaRAMDir()
	probe := otaLightRead[otalight.Probe](ram, otalight.FileProbe)

	if otaverify.ReleaseIsRunning(v.release, Version) {
		if probe != nil && otaverify.ReleaseIsRunning(probe.Release, Version) {
			v.state = cloud.UpdateStateSelfTest
			v.reason = "Release " + v.release + " laeuft zur Probe - der Selbsttest (Steuerpfad, Web-App, " +
				"Cloud) entscheidet binnen 10 min, ob es bleibt."
			if u := otaLightRead[otalight.Urteil](ram, otalight.FileUrteil); u != nil &&
				u.Zuweisung == probe.Zuweisung && u.Bestanden {
				v.reason = "Release " + v.release + " hat den Selbsttest bestanden - die Fassung wird in " +
					"den Flash gelegt."
			}
			return v
		}
		// Ausserhalb der Probe laeuft die bestaetigte Fassung aus dem Flash.
		a.otaLightBestaetigt(v)
		v.state = cloud.UpdateStateSucceeded
		v.reason = "Release " + v.release + " ist verifiziert, bestaetigt und laeuft hier."
		return v
	}

	raw, err := a.otaTargetStore().Load()
	if err != nil {
		return v
	}
	env, err := otatarget.ParseEnvelope(raw)
	if err != nil {
		return v
	}
	m, err := otaverify.ParseManifest(env.Manifest)
	if err != nil {
		return v
	}
	zuw := otalight.Zuweisung(env.AssignedAt, env.RolloutID)
	e := otalight.Entscheide(otalight.Eingang{
		Manifest:         m,
		Arch:             runtime.GOOS + "/" + runtime.GOARCH,
		Zuweisung:        zuw,
		StateSchemaLokal: a.otaLightStateSchema(),
		Versuche:         otalight.ParseVersuche(readFileOrNil(a.otaDir(), otalight.FileVersuche)),
	})
	if !e.Anwenden {
		v.state = e.Zustand
		v.reason = e.Grund
		return v
	}
	if !a.otaLightLoaderBereit() {
		v.state = cloud.UpdateStateDeferred
		v.reason = "Release " + m.Release + " ist verifiziert, aber der Loader dieser Box kennt noch keine " +
			"Updates (Stufe 1) - einmal durch den Wartungstunnel nachruesten (edge-light/openwrt/install.sh)."
		return v
	}
	if probe != nil {
		// Eine andere Fassung laeuft gerade zur Probe: erst ihr Ende abwarten.
		v.state = cloud.UpdateStateDeferred
		v.reason = "Release " + m.Release + " wartet - gerade laeuft eine andere Fassung zur Probe."
		return v
	}

	l := &a.otaLight
	l.mu.Lock()
	defer l.mu.Unlock()
	if grund, ok := l.gescheitert[zuw]; ok {
		v.state = cloud.UpdateStateFailed
		v.reason = grund
		return v
	}
	if l.zuw == zuw && (l.busy || l.state == cloud.UpdateStateApplying ||
		a.otaLightNow().Before(l.retryAt)) {
		v.state = l.state
		v.reason = l.reason
		return v
	}
	l.zuw = zuw
	l.busy = true
	l.state = cloud.UpdateStateDownloading
	l.reason = fmt.Sprintf("Release %s wird geladen (%.1f MB) und geprueft.", m.Release,
		float64(e.Programm.GzSize)/1e6)
	go a.otaLightLaden(m, e.Programm, zuw)
	v.state = l.state
	v.reason = l.reason
	return v
}

// otaLightPruefFehler: die Lieferung passt nicht zum gepruften Manifest. Das ist
// kein Netzfehler - ohne neue Zuweisung wird es nicht erneut versucht.
type otaLightPruefFehler struct{ msg string }

func (e *otaLightPruefFehler) Error() string { return e.msg }

// otaLightLaden laedt, prueft, legt den Kandidaten ab und beendet das Programm.
func (a *Agent) otaLightLaden(m *otaverify.Manifest, p otaverify.Artifact, zuw string) {
	err := a.otaLightLadenEinmal(m, p, zuw)
	l := &a.otaLight
	l.mu.Lock()
	l.busy = false
	var pf *otaLightPruefFehler
	switch {
	case err == nil:
		l.state = cloud.UpdateStateApplying
		l.reason = "Release " + m.Release + " ist geladen und geprueft - die Box startet die neue Fassung " +
			"zur Probe (rund 30 s Unterbrechung)."
	case errors.As(err, &pf):
		if l.gescheitert == nil {
			l.gescheitert = map[string]string{}
		}
		l.gescheitert[zuw] = "Release " + m.Release + ": " + pf.msg + " - nichts getauscht. Ein neuer " +
			"Versuch braucht eine neue Zuweisung im Portal."
		l.state = cloud.UpdateStateFailed
		l.reason = l.gescheitert[zuw]
	default:
		l.retryAt = a.otaLightNow().Add(otaLightRetry)
		l.state = cloud.UpdateStateDownloading
		l.reason = "Release " + m.Release + ": Laden fehlgeschlagen (" + err.Error() + ") - neuer Versuch in " +
			"10 min."
	}
	state, reason := l.state, l.reason
	l.mu.Unlock()

	if err != nil {
		slog.Warn("OTA (Edge Light): Fassung nicht geladen", "release", m.Release, "err", err)
		a.otaForceRecheck()
		return
	}
	slog.Info("OTA (Edge Light): Fassung geladen und geprueft - Neustart zur Probe",
		"release", m.Release, "release_seq", m.ReleaseSeq)
	a.otaLightMeldeApplying(m, state, reason)
	a.otaForceRecheck()
	if l.beenden != nil {
		l.beenden()
		return
	}
	// procd startet den Loader neu; er findet kandidat.json und tauscht.
	_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
}

func (a *Agent) otaLightLadenEinmal(m *otaverify.Manifest, p otaverify.Artifact, zuw string) error {
	ram := a.otaRAMDir()
	if err := os.MkdirAll(ram, 0o755); err != nil {
		return err
	}
	for _, f := range []string{otalight.FileKandidat, otalight.FileKandidatGz, otalight.FileKandidatGz + ".part",
		otalight.FileUrteil} {
		_ = os.Remove(filepath.Join(ram, f))
	}
	if avail, ok := a.otaLightMemAvail(); ok && avail < p.GzSize+otaLightRAMReserve {
		return fmt.Errorf("zu wenig freier Arbeitsspeicher (%d kB verfuegbar, %d kB noetig)",
			avail/1024, (p.GzSize+otaLightRAMReserve)/1024)
	}

	ctx, cancel := context.WithTimeout(context.Background(), otaLightDownloadTimeout)
	defer cancel()
	url := strings.TrimRight(a.Cfg.PortalBaseURL, "/") + "/api/v1/edge/light-programm/" + p.GzSHA256
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := a.otaLight.client
	if client == nil {
		client = &http.Client{}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Portal antwortet HTTP %d", resp.StatusCode)
	}
	part := filepath.Join(ram, otalight.FileKandidatGz+".part")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, p.GzSize+1))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(part)
		return errors.Join(copyErr, closeErr)
	}
	switch {
	case n > p.GzSize:
		_ = os.Remove(part)
		return &otaLightPruefFehler{msg: "die Lieferung ist groesser als im signierten Manifest"}
	case n < p.GzSize:
		_ = os.Remove(part)
		return fmt.Errorf("Lieferung unvollstaendig (%d von %d Bytes)", n, p.GzSize)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != p.GzSHA256 {
		_ = os.Remove(part)
		return &otaLightPruefFehler{msg: "die Pruefsumme der Lieferung passt nicht zum signierten Manifest"}
	}
	if err := os.Rename(part, filepath.Join(ram, otalight.FileKandidatGz)); err != nil {
		return err
	}
	k := otalight.Kandidat{
		Release:        m.Release,
		ReleaseSeq:     m.ReleaseSeq,
		Arch:           p.Arch,
		SHA256:         p.SHA256,
		Size:           p.Size,
		GzSHA256:       p.GzSHA256,
		GzSize:         p.GzSize,
		Zuweisung:      zuw,
		StateSchema:    m.StateSchema,
		SteuerteVorher: a.otaControlActive(a.State.Get()),
		ErstelltAm:     time.Now().UTC().Format(otaapply.TimeFormat),
	}
	// kandidat.json ZULETZT: erst mit ihr gilt der Kandidat fuer den Loader.
	return otaLightWrite(ram, otalight.FileKandidat, k)
}

// otaLightMeldeApplying meldet `applying` DURABEL, bevor sich das Programm
// beendet - sonst saehe das Portal nur eine verstummte Box.
func (a *Agent) otaLightMeldeApplying(m *otaverify.Manifest, state, reason string) {
	a.mu.Lock()
	link := a.link
	a.mu.Unlock()
	if link == nil || !link.Connected() {
		slog.Warn("OTA (Edge Light): applying nicht gemeldet - keine Cloud-Verbindung")
		return
	}
	seq := m.ReleaseSeq
	if err := link.PublishUpdateState(cloud.UpdateSummary{
		Backend:   cloud.UpdateBackend(a.boxArt()),
		Current:   Version,
		State:     state,
		Reason:    reason,
		Target:    m.Release,
		TargetSeq: &seq,
	}); err != nil {
		slog.Warn("OTA (Edge Light): durabler applying-Bericht fehlgeschlagen", "err", err)
	}
}

// otaLightBestaetigt zeichnet die bestaetigte Fassung auf (current.json im
// Flash, nur je hoeher) samt ihrem Datenformat.
func (a *Agent) otaLightBestaetigt(v otaVerdict) {
	dir := a.otaDir()
	if cur := a.otaReadCurrent(dir); cur != nil && cur.ReleaseSeq >= v.seq {
		return
	}
	if err := a.otaWriteCurrent(dir, otaCurrent{Release: v.release, ReleaseSeq: v.seq}); err != nil {
		slog.Warn("OTA (Edge Light): bestaetigte Fassung nicht aufgezeichnet", "err", err)
		return
	}
	if raw, err := a.otaTargetStore().Load(); err == nil {
		if env, err := otatarget.ParseEnvelope(raw); err == nil {
			if m, err := otaverify.ParseManifest(env.Manifest); err == nil && m.StateSchema > 0 {
				a.otaRecordStateSchema(m.StateSchema)
			}
		}
	}
	slog.Info("OTA (Edge Light): bestaetigte Fassung aufgezeichnet", "release", v.release, "release_seq", v.seq)
}

// otaLightStateSchema ist das Datenformat der bestaetigten Fassung (0 = unbekannt).
func (a *Agent) otaLightStateSchema() int {
	if cur := otaapply.ReadCurrent(a.Cfg.DataDir); cur != nil {
		return cur.StateSchema
	}
	return 0
}

func (a *Agent) otaLightMemAvail() (int64, bool) {
	if a.otaLight.memAvail != nil {
		return a.otaLight.memAvail()
	}
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "MemAvailable:" {
			kb, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil {
				return 0, false
			}
			return kb * 1024, true
		}
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// Die Probe: Selbsttest der neuen Fassung
// ---------------------------------------------------------------------------

// otaLightProbeLoop beobachtet probe.json. Laeuft DIESES Programm zur Probe,
// urteilt es ueber sich - wie die Docker-Box (otaRunSelfTest), dazu muss die
// Cloud erreicht sein. Endgueltig wird das Urteil erst, wenn es gruen ist oder
// eine Pruefung ausser der Cloud scheitert; bis dahin schreibt es "offen" mit
// Grund, und die Frist des Loaders entscheidet.
func (a *Agent) otaLightProbeLoop(ctx context.Context, poll, settle time.Duration) {
	if poll <= 0 {
		poll = otaLightProbeTakt
	}
	erledigt := ""
	beruhigt := ""
	for {
		ram := a.otaRAMDir()
		p := otaLightRead[otalight.Probe](ram, otalight.FileProbe)
		if p != nil && p.Zuweisung != erledigt && otaverify.ReleaseIsRunning(p.Release, Version) {
			if beruhigt != p.Zuweisung {
				slog.Info("OTA (Edge Light): neue Fassung laeuft zur Probe - Selbsttest", "release", p.Release)
				if !otaWait(ctx, settle) {
					return
				}
				beruhigt = p.Zuweisung
			}
			k := otaLightRead[otalight.Kandidat](ram, otalight.FileKandidat)
			pc := &otaapply.PendingConfirm{Token: p.Zuweisung, Release: p.Release, ReleaseSeq: p.ReleaseSeq}
			if k != nil && k.Zuweisung == p.Zuweisung {
				pc.ControlActiveBefore = k.SteuerteVorher
			}
			res := a.otaRunSelfTest(pc, time.Now())
			a.mu.Lock()
			link := a.link
			a.mu.Unlock()
			cloudOK := link != nil && link.Connected()
			u := otalight.Urteil{Release: p.Release, Zuweisung: p.Zuweisung,
				Am: time.Now().UTC().Format(otaapply.TimeFormat)}
			switch {
			case !res.Passed:
				u.Grund = "Selbsttest nicht bestanden: " + res.Reason
				erledigt = p.Zuweisung
				slog.Error("OTA (Edge Light): Selbsttest NICHT bestanden", "grund", res.Reason)
			case !cloudOK:
				u.Offen = true
				u.Grund = "keine Cloud-Verbindung in der Probezeit"
			default:
				u.Bestanden = true
				erledigt = p.Zuweisung
				slog.Info("OTA (Edge Light): Selbsttest bestanden", "release", p.Release)
			}
			if err := otaLightWrite(ram, otalight.FileUrteil, u); err != nil {
				slog.Error("OTA (Edge Light): Urteil nicht abgelegt", "err", err)
			}
			if !u.Offen {
				a.otaForceRecheck()
			}
		}
		if !otaWait(ctx, poll) {
			return
		}
	}
}

// ---------------------------------------------------------------------------

func otaLightRead[T any](dir, name string) *T {
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil
	}
	var v T
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return &v
}

// otaLightWrite schreibt atomar (tmp + rename) - der Loader liest nie eine
// halbe Datei.
func otaLightWrite(dir, name string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
