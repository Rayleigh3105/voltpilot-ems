package agent

// OTA Stufe 1 auf dem GERAET: ein abgelegtes Release wird verifiziert und das
// Urteil berichtet - und NICHTS wird angewandt.
//
// Die Wegwerf-Wurzel dieser Suite entsteht zur Laufzeit; im Repo liegt kein
// geheimer Schluessel (die echte Zeremonie laeuft offline, docs/ota-signing.md).
// Deshalb wird der Agent hier ueber eine INJIZIERTE Wurzel geprueft, waehrend
// der Produktionspfad die eingebackene rootkeys.json liest.

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

type otaKey struct {
	id   string
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func otaNewKey(t *testing.T, id string) otaKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return otaKey{id: id, pub: pub, priv: priv}
}

func otaWrite(t *testing.T, path string, v any) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return raw
}

func otaSign(t *testing.T, path string, k otaKey, domain string, doc []byte) {
	t.Helper()
	in, err := otaverify.SigningInput(domain, doc)
	if err != nil {
		t.Fatal(err)
	}
	otaWrite(t, path+".sig", otaverify.Signature{
		SchemaVersion: otaverify.SignatureSchemaVersion, Alg: otaverify.AlgEd25519,
		KeyID: k.id, Domain: domain,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, in)),
	})
}

// otaBox stages a data dir with a full, valid release drop.
type otaBox struct {
	dir  string
	root otaKey
	rel  otaKey
	a    *Agent
}

func otaManifest(release string, seq, minFrom int64) otaverify.Manifest {
	return otaverify.Manifest{
		SchemaVersion: otaverify.ManifestSchemaVersion,
		Release:       release,
		ReleaseSeq:    seq,
		TargetCommit:  "3bf8c038a1b2",
		Artifacts: []otaverify.Artifact{{Type: otaverify.ArtifactOCIImage, Name: "core",
			Ref: "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:" + strings.Repeat("a", 64)}},
		MinFromSeq:   minFrom,
		StateSchema:  3,
		Compat:       otaverify.Compat{Backends: []string{otaverify.BackendCompose}},
		SigningKeyID: "rel-2026-a",
	}
}

func newOtaBox(t *testing.T, m otaverify.Manifest) *otaBox {
	t.Helper()
	data := t.TempDir()
	dir := filepath.Join(data, otaDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	b := &otaBox{dir: dir, root: otaNewKey(t, "root-2026-a"), rel: otaNewKey(t, "rel-2026-a")}

	ts := otaWrite(t, filepath.Join(dir, otaTrustSetFile), otaverify.KeySet{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: b.rel.id, Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(b.rel.pub)}},
	})
	otaSign(t, filepath.Join(dir, otaTrustSetFile), b.root, otaverify.DomainTrustSet, ts)

	raw := otaWrite(t, filepath.Join(dir, otaManifestFile), m)
	otaSign(t, filepath.Join(dir, otaManifestFile), b.rel, otaverify.DomainRelease, raw)

	b.a = &Agent{Cfg: config.Config{DataDir: data}, State: state.New("edge-test", Version)}
	b.a.otaRoots = &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: b.root.id, Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(b.root.pub)}}}
	return b
}

func (b *otaBox) check() *cloud.UpdateSummary {
	b.a.otaCheckOnce()
	return b.a.updateSummary()
}

// touch makes the next check re-verify (the stamp is mtime+size).
func (b *otaBox) touch(t *testing.T) {
	t.Helper()
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(filepath.Join(b.dir, otaManifestFile), future, future); err != nil {
		t.Fatal(err)
	}
}

func TestOtaVerifiesAPlacedReleaseAndReportsItWithoutApplying(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	u := b.check()

	if u.State != cloud.UpdateStateIdle {
		t.Fatalf("state = %q - Stufe 1 wendet nichts an, der Zustand kehrt nach der "+
			"Pruefung nach idle zurueck", u.State)
	}
	if !strings.Contains(u.Reason, "edge-2026.08.0") || !strings.Contains(u.Reason, "verifiziert") {
		t.Fatalf("Grund nennt das gepruefte Release nicht: %q", u.Reason)
	}
	// DIE Aussage der Stufe: geprueft, NICHT angewandt.
	if !strings.Contains(u.Reason, "Stufe 2/3") {
		t.Errorf("der Grund muss sagen, dass NICHT angewandt wird: %q", u.Reason)
	}
	// Der Herzschlag darf weiterhin nichts erfinden, was das Geraet nicht weiss.
	if u.CurrentSeq != nil || u.TargetSeq != nil || u.Target != "" || u.LastKnownGood != "" {
		t.Errorf("das Geraet hat weder Register noch Ziel noch Update-Historie: %+v", u)
	}
	if u.Current != Version {
		t.Errorf("current = %q, want the stamped version verbatim", u.Current)
	}
	// Und lokal ablesbar, ohne Cloud-Verbindung (der beaufsichtigte Test).
	snap := b.a.State.Get()
	if snap.OtaReason != u.Reason || snap.OtaState != u.State {
		t.Errorf("/health und Herzschlag muessen dasselbe sagen: %q/%q vs %q/%q",
			snap.OtaState, snap.OtaReason, u.State, u.Reason)
	}
}

func TestOtaWithoutAPlacedReleaseStaysSilentlyIdle(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	if err := os.Remove(filepath.Join(b.dir, otaManifestFile)); err != nil {
		t.Fatal(err)
	}
	u := b.check()
	if u.State != cloud.UpdateStateIdle {
		t.Fatalf("state = %q", u.State)
	}
	// Kein abgelegtes Release ist der Normalfall - ein Grund waere eine
	// Beschwerde ueber Nichts (und im Puls eine rote Zeile ohne Anlass).
	if u.Reason != "" {
		t.Fatalf("ohne abgelegtes Release darf kein Grund berichtet werden: %q", u.Reason)
	}
}

func TestOtaRejectsTamperedBytesLoudly(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	p := filepath.Join(b.dir, otaManifestFile)
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// Syntaktisch einwandfrei, ein Byte veraendert.
	tampered := strings.Replace(string(raw), `"release_seq": 12`, `"release_seq": 13`, 1)
	if err := os.WriteFile(p, []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}
	b.touch(t)
	u := b.check()
	if u.State != cloud.UpdateStateIdle {
		t.Fatalf("state = %q", u.State)
	}
	if u.Reason == "" || strings.Contains(u.Reason, "verifiziert") {
		t.Fatalf("eine gebrochene Kette darf nie wie ein Erfolg klingen: %q", u.Reason)
	}
}

func TestOtaFailsClosedWithoutABakedRoot(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	b.a.otaRoots = nil // Produktionspfad: die eingebackene (heute leere) Wurzel
	u := b.check()
	if u.State != cloud.UpdateStateIdle {
		t.Fatalf("state = %q", u.State)
	}
	if !strings.Contains(u.Reason, "Vertrauensanker") {
		t.Fatalf("ohne eingebackene Wurzel muss fail-closed berichtet werden: %q", u.Reason)
	}
}

func TestOtaEnforcesTheAntiRollbackFloorFromTheLocalCurrentState(t *testing.T) {
	// min_from_seq = 9, lokaler Stand 8 -> eine Zwischenstufe fehlt.
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	otaWrite(t, filepath.Join(b.dir, otaCurrentFile), otaCurrent{Release: "edge-2026.06.0", ReleaseSeq: 8})
	b.touch(t)
	u := b.check()
	if !strings.Contains(u.Reason, "Zwischenstufe") {
		t.Fatalf("der Boden wurde nicht durchgesetzt: %q", u.Reason)
	}

	// Ein unsinniger eigener Stand wird VERWORFEN statt geraten: der Boden ist
	// dann nicht bewertbar, und das Release verifiziert wieder sauber.
	otaWrite(t, filepath.Join(b.dir, otaCurrentFile), otaCurrent{Release: "x", ReleaseSeq: 0})
	b.touch(t)
	if u := b.check(); !strings.Contains(u.Reason, "verifiziert") {
		t.Fatalf("ein unlesbarer eigener Stand darf nicht als Boden gelten: %q", u.Reason)
	}
}

func TestOtaReportsAlreadyRunningWithoutClaimingAnUpdate(t *testing.T) {
	// edge-images stempelt bei Tag-Builds `<tag>-<kurzsha>` - genau daran
	// erkennt der Verifizierer, dass das gepruefte Release schon laeuft.
	prev := Version
	Version = "edge-2026.08.0-3bf8c038a1b2"
	t.Cleanup(func() { Version = prev })

	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	u := b.check()
	if !strings.Contains(u.Reason, "laeuft hier bereits") {
		t.Fatalf("ein bereits laufendes Release muss als solches berichtet werden: %q", u.Reason)
	}
	// Auch dann bleibt es eine BEOBACHTUNG - kein Update wird behauptet.
	if u.State != cloud.UpdateStateIdle || u.Target != "" {
		t.Errorf("kein Ziel, kein Update: %+v", u)
	}
}
