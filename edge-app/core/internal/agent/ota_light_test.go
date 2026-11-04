package agent

// Edge Light K3: das Programm wendet eine geprueft zugewiesene Fassung an -
// laden, pruefen, Kandidat ablegen, applying, beenden - und urteilt in der
// Probe ueber sich. Alle Schluessel sind Wegwerf-Schluessel (otaNewKey).

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otalight"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// lightBox ist eine Edge-Light-Box mit neuem Loader (VP_OTA_RAM_DIR gesetzt),
// Trust-Set im Flash und einem Portal, das die gepackte Fassung ausliefert.
type lightBox struct {
	*otaTargetBox
	ram      string
	gz       []byte
	gzSHA    string
	beendet  atomic.Int32
	abrufe   atomic.Int32
	liefere  func(w http.ResponseWriter)
	portal   *httptest.Server
	manifest otaverify.Manifest
}

const lightRelease = "edge-light-2026.11.2"

func newLightBox(t *testing.T) *lightBox {
	t.Helper()
	b := &lightBox{otaTargetBox: newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))}
	programm := bytes.Repeat([]byte("vp-edge-light "), 1000)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(programm)
	_ = zw.Close()
	b.gz = gz.Bytes()
	sum := sha256.Sum256(b.gz)
	b.gzSHA = hex.EncodeToString(sum[:])
	rawSum := sha256.Sum256(programm)
	b.manifest = otaverify.Manifest{
		SchemaVersion: otaverify.ManifestSchemaVersion,
		Release:       lightRelease,
		ReleaseSeq:    42,
		TargetCommit:  "5b28311b4c0d",
		Artifacts: []otaverify.Artifact{
			{Type: otaverify.ArtifactBinary, Name: "vp-edge-light", Arch: runtime.GOOS + "/" + runtime.GOARCH,
				SHA256: hex.EncodeToString(rawSum[:]), Size: int64(len(programm)),
				GzSHA256: b.gzSHA, GzSize: int64(len(b.gz))},
		},
		StateSchema:  1,
		Compat:       otaverify.Compat{Backends: []string{otaverify.BackendLight}},
		SigningKeyID: "rel-2026-a",
	}
	b.liefere = func(w http.ResponseWriter) { _, _ = w.Write(b.gz) }
	b.portal = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/edge/light-programm/"+b.gzSHA {
			http.NotFound(w, r)
			return
		}
		b.abrufe.Add(1)
		b.liefere(w)
	}))
	t.Cleanup(b.portal.Close)

	b.ram = t.TempDir()
	b.a.Cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	b.a.Cfg.OtaRAMDir = b.ram
	b.a.Cfg.PortalBaseURL = b.portal.URL
	b.a.otaLight.beenden = func() { b.beendet.Add(1) }
	b.a.otaLight.memAvail = func() (int64, bool) { return 64 << 20, true }
	return b
}

// zuweisen legt eine Zuweisung mit assigned_at ab (wie die Cloud sie schickt).
func (b *lightBox) zuweisen(t *testing.T, assignedAt string) {
	t.Helper()
	raw := b.envelope(t, b.manifest, nil)
	var env map[string]any
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	env["assigned_at"] = assignedAt
	raw, _ = json.Marshal(env)
	b.a.onUpdateTarget(raw)
}

func (b *lightBox) warte(t *testing.T, was string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("Zeitueberschreitung: %s (Zustand %+v)", was, b.a.updateSummary())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEdgeLightLaedtPrueftLegtDenKandidatenAbUndBeendetSich(t *testing.T) {
	b := newLightBox(t)
	b.zuweisen(t, "2026-11-04T13:00:00Z")

	b.warte(t, "Programm beendet sich", func() bool { return b.beendet.Load() == 1 })
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateApplying || u.Target != lightRelease {
		t.Fatalf("erwartet applying fuer %s, ist %+v", lightRelease, u)
	}
	gz, err := os.ReadFile(filepath.Join(b.ram, otalight.FileKandidatGz))
	if err != nil || !bytes.Equal(gz, b.gz) {
		t.Fatalf("kandidat.gz fehlt oder falsch: %v", err)
	}
	k := otaLightRead[otalight.Kandidat](b.ram, otalight.FileKandidat)
	p := b.manifest.Artifacts[0]
	if k == nil || k.Release != lightRelease || k.ReleaseSeq != 42 || k.SHA256 != p.SHA256 ||
		k.GzSHA256 != b.gzSHA || k.GzSize != int64(len(b.gz)) || k.Zuweisung != "2026-11-04T13:00:00Z" ||
		k.StateSchema != 1 || k.Arch != p.Arch {
		t.Fatalf("kandidat.json: %+v", k)
	}
	// Die Zuweisung liegt im RAM, nie im Flash.
	if _, err := os.Stat(filepath.Join(b.ram, "target.json")); err != nil {
		t.Fatalf("Zuweisung nicht im RAM: %v", err)
	}
	if _, err := os.Stat(filepath.Join(b.dir, "target.json")); err == nil {
		t.Fatal("die Zuweisung liegt im Flash")
	}
	// Weitere Takte laden nicht erneut und beenden nicht erneut.
	b.a.otaCheckOnce()
	b.a.otaForceRecheck()
	if b.abrufe.Load() != 1 || b.beendet.Load() != 1 {
		t.Fatalf("erneut geladen/beendet: %d/%d", b.abrufe.Load(), b.beendet.Load())
	}
}

func TestEdgeLightEineFalscheLieferungWirdNieGestartetUndNichtWiederholt(t *testing.T) {
	b := newLightBox(t)
	b.liefere = func(w http.ResponseWriter) {
		falsch := append([]byte{}, b.gz...)
		falsch[len(falsch)-1] ^= 1
		_, _ = w.Write(falsch)
	}
	b.zuweisen(t, "z-1")
	b.warte(t, "failed", func() bool { return b.a.updateSummary().State == cloud.UpdateStateFailed })
	if r := b.a.updateSummary().Reason; !strings.Contains(r, "Pruefsumme") || !strings.Contains(r, "neue Zuweisung") {
		t.Fatalf("Grund: %q", r)
	}
	for _, f := range []string{otalight.FileKandidat, otalight.FileKandidatGz, otalight.FileKandidatGz + ".part"} {
		if _, err := os.Stat(filepath.Join(b.ram, f)); err == nil {
			t.Fatalf("%s liegt nach einer falschen Lieferung im RAM", f)
		}
	}
	b.a.otaForceRecheck()
	if b.abrufe.Load() != 1 || b.beendet.Load() != 0 {
		t.Fatalf("ohne neue Zuweisung erneut versucht: %d Abrufe, %d beendet", b.abrufe.Load(), b.beendet.Load())
	}
	// Eine NEUE Zuweisung desselben Release versucht es wieder.
	b.liefere = func(w http.ResponseWriter) { _, _ = w.Write(b.gz) }
	b.zuweisen(t, "z-2")
	b.warte(t, "neuer Versuch", func() bool { return b.beendet.Load() == 1 })
}

func TestEdgeLightEinNetzfehlerWirdNachZehnMinutenWiederholt(t *testing.T) {
	b := newLightBox(t)
	jetzt := time.Now()
	b.a.otaLight.now = func() time.Time { return jetzt }
	b.liefere = func(w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) }
	b.zuweisen(t, "z-1")
	b.warte(t, "Laden fehlgeschlagen", func() bool {
		return strings.Contains(b.a.updateSummary().Reason, "neuer Versuch in 10 min")
	})
	if s := b.a.updateSummary().State; s != cloud.UpdateStateDownloading {
		t.Fatalf("ein Netzfehler ist kein failed: %q", s)
	}
	b.a.otaForceRecheck()
	if b.abrufe.Load() != 1 {
		t.Fatalf("vor Ablauf der Wartezeit erneut geladen: %d", b.abrufe.Load())
	}
	b.liefere = func(w http.ResponseWriter) { _, _ = w.Write(b.gz) }
	jetzt = jetzt.Add(11 * time.Minute)
	b.a.otaForceRecheck()
	b.warte(t, "zweiter Versuch", func() bool { return b.beendet.Load() == 1 })
}

func TestEdgeLightZuWenigArbeitsspeicherLaedtNicht(t *testing.T) {
	b := newLightBox(t)
	b.a.otaLight.memAvail = func() (int64, bool) { return 4 << 20, true }
	b.zuweisen(t, "z-1")
	b.warte(t, "Speicher-Grund", func() bool {
		return strings.Contains(b.a.updateSummary().Reason, "zu wenig freier Arbeitsspeicher")
	})
	if b.abrufe.Load() != 0 {
		t.Fatal("trotz Speichermangel geladen")
	}
}

func TestEdgeLightMitAltemLoaderWirdNichtAngewandt(t *testing.T) {
	b := newLightBox(t)
	b.a.Cfg.OtaRAMDir = ""
	b.zuweisen(t, "z-1")
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateDeferred || !strings.Contains(u.Reason, "Loader") ||
		u.TargetVerdict != string(otaverify.OutcomeOK) {
		t.Fatalf("%+v", u)
	}
	time.Sleep(50 * time.Millisecond)
	if b.abrufe.Load() != 0 {
		t.Fatal("ein alter Loader tauscht nie - trotzdem geladen")
	}
}

func TestEdgeLightZurueckgenommenHeisstKeinNeuerVersuch(t *testing.T) {
	b := newLightBox(t)
	if err := os.WriteFile(filepath.Join(b.dir, otalight.FileVersuche),
		[]byte("start 42 z-1\nzurueck 42 z-1 keine Cloud-Verbindung in der Probezeit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b.zuweisen(t, "z-1")
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateRolledBack || !strings.Contains(u.Reason, "keine Cloud-Verbindung") {
		t.Fatalf("%+v", u)
	}
	time.Sleep(50 * time.Millisecond)
	if b.abrufe.Load() != 0 {
		t.Fatal("zurueckgenommen und trotzdem erneut geladen")
	}
}

func TestEdgeLightBestaetigteFassungSchreibtCurrentJson(t *testing.T) {
	b := newLightBox(t)
	old := Version
	Version = lightRelease
	defer func() { Version = old }()
	b.zuweisen(t, "z-1")
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateSucceeded {
		t.Fatalf("%+v", u)
	}
	cur := b.a.otaReadCurrent(b.dir)
	if cur == nil || cur.Release != lightRelease || cur.ReleaseSeq != 42 {
		t.Fatalf("current.json: %+v", cur)
	}
	if c := otaapply.ReadCurrent(b.a.Cfg.DataDir); c == nil || c.StateSchema != 1 {
		t.Fatalf("Datenformat nicht aufgezeichnet: %+v", c)
	}
	if u.CurrentSeq == nil || *u.CurrentSeq != 42 {
		t.Fatalf("current_seq: %v", u.CurrentSeq)
	}
}

func TestEdgeLightInDerProbeWirdNichtsBestaetigt(t *testing.T) {
	b := newLightBox(t)
	old := Version
	Version = lightRelease
	defer func() { Version = old }()
	if err := otaLightWrite(b.ram, otalight.FileProbe, otalight.Probe{Release: lightRelease, ReleaseSeq: 42,
		Zuweisung: "z-1"}); err != nil {
		t.Fatal(err)
	}
	b.zuweisen(t, "z-1")
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateSelfTest || !strings.Contains(u.Reason, "zur Probe") {
		t.Fatalf("%+v", u)
	}
	if cur := b.a.otaReadCurrent(b.dir); cur != nil {
		t.Fatalf("in der Probe darf current.json nicht steigen: %+v", cur)
	}
}

// Der Selbsttest in der Probe: ohne Cloud bleibt das Urteil OFFEN (die Frist des
// Loaders entscheidet), ein kaputter Steuerpfad oder eine stumme Web-App
// beendet die Probe sofort.
func TestEdgeLightProbeUrteil(t *testing.T) {
	b := newLightBox(t)
	b.a.Cfg.MaxChargeKw, b.a.Cfg.MaxDischargeKw, b.a.Cfg.SocMinPct, b.a.Cfg.SocMaxPct = 30, 30, 5, 95
	old := Version
	Version = lightRelease
	defer func() { Version = old }()
	if err := otaLightWrite(b.ram, otalight.FileProbe, otalight.Probe{Release: lightRelease, ReleaseSeq: 42,
		Zuweisung: "z-1"}); err != nil {
		t.Fatal(err)
	}

	// Web-App ohne Antwort: endgueltig durchgefallen.
	b.a.Cfg.HTTPAddr = ""
	ctx, cancel := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() { b.a.otaLightProbeLoop(ctx, 10*time.Millisecond, 0); close(fertig) }()
	b.warte(t, "Urteil", func() bool { return otaLightRead[otalight.Urteil](b.ram, otalight.FileUrteil) != nil })
	cancel()
	<-fertig
	u := otaLightRead[otalight.Urteil](b.ram, otalight.FileUrteil)
	if u.Bestanden || u.Offen || !strings.Contains(u.Grund, "Weboberflaeche") || u.Zuweisung != "z-1" {
		t.Fatalf("%+v", u)
	}

	// Web-App antwortet, aber keine Cloud: offen, mit dem Grund fuer die Frist.
	_ = os.Remove(filepath.Join(b.ram, otalight.FileUrteil))
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer web.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(web.URL, "http://"))
	b.a.Cfg.HTTPAddr = ":" + port
	ctx, cancel = context.WithCancel(context.Background())
	fertig = make(chan struct{})
	go func() { b.a.otaLightProbeLoop(ctx, 10*time.Millisecond, 0); close(fertig) }()
	defer func() { cancel(); <-fertig }()
	b.warte(t, "offenes Urteil", func() bool { return otaLightRead[otalight.Urteil](b.ram, otalight.FileUrteil) != nil })
	u = otaLightRead[otalight.Urteil](b.ram, otalight.FileUrteil)
	if u.Bestanden || !u.Offen || u.Grund != "keine Cloud-Verbindung in der Probezeit" {
		t.Fatalf("%+v", u)
	}
}

// Edge Light schreibt kein Signal fuer einen Sidecar - sein DataDir/ota liegt
// im Flash.
func TestEdgeLightSchreibtKeinSignalInDenFlash(t *testing.T) {
	b := newLightBox(t)
	b.a.otaSignalOnce()
	if _, err := os.Stat(filepath.Join(b.dir, otaapply.FileCoreSignal)); err == nil {
		t.Fatal("core-signal.json im Flash")
	}
}
