package agent

// OTA Stufe 2 auf dem GERAET: eine zugewiesene Aktualisierung wird empfangen,
// verifiziert, abgelegt und gemeldet - und weiterhin NICHTS angewandt.
//
// Die Wegwerf-Wurzel entsteht wie in der Stufe-1-Suite zur Laufzeit
// (otaBox/newOtaBox in ota_verify_test.go); im Repo liegt kein geheimer
// Schluessel.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const (
	otaTestTenant = "00000000-0000-0000-0000-000000000001"
	otaTestSite   = "00000000-0000-0000-0000-000000000002"
	otaTestDevice = "00000000-0000-0000-0000-000000000003"
)

// otaTargetBox stages a box that has a TOFU-placed trust set (as after the
// crossover) but NO manually placed release - the Stufe-2 shape.
type otaTargetBox struct {
	*otaBox
}

func newOtaTargetBox(t *testing.T, m otaverify.Manifest) *otaTargetBox {
	t.Helper()
	b := newOtaBox(t, m)
	// Der beaufsichtigte Dateipfad der Stufe 1 wird ENTFERNT: was hier
	// geprueft wird, muss ueber den Downlink kommen.
	if err := os.Remove(filepath.Join(b.dir, otaManifestFile)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(b.dir, otaManifestFile+otaSigSuffix)); err != nil {
		t.Fatal(err)
	}
	b.a.setEntityIdentity(otaTestTenant, otaTestSite, otaTestDevice)
	return &otaTargetBox{otaBox: b}
}

// envelope builds a contract-shaped assignment for a manifest, signed with the
// box's release key (or a foreign key when `signer` is given).
func (b *otaTargetBox) envelope(t *testing.T, m otaverify.Manifest, signer *otaKey) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	k := b.rel
	if signer != nil {
		k = *signer
	}
	sigPath := filepath.Join(t.TempDir(), "release.json")
	otaSign(t, sigPath, k, otaverify.DomainRelease, raw)
	sig, err := os.ReadFile(sigPath + ".sig")
	if err != nil {
		t.Fatal(err)
	}
	return otaEnvelopeBytes(t, m.Release, m.ReleaseSeq, raw, sig, otaTestDevice)
}

func otaEnvelopeBytes(t *testing.T, release string, seq int64, manifest, sig []byte,
	deviceID string) []byte {
	t.Helper()
	env := map[string]any{
		"schema_version": otatarget.SchemaVersion,
		"type":           otatarget.EnvelopeType,
		"tenant_id":      otaTestTenant,
		"site_id":        otaTestSite,
		"device_id":      deviceID,
		"release":        release,
		"release_seq":    seq,
		"manifest_b64":   base64.StdEncoding.EncodeToString(manifest),
		"signature_b64":  base64.StdEncoding.EncodeToString(sig),
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAssignedReleaseIsVerifiedPersistedAndReportedWithoutApplying(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), nil))

	u := b.a.updateSummary()
	// Der EINE ehrliche Zustand dieser Stufe: geprueft, wartet auf den Menschen.
	if u.State != cloud.UpdateStateDeferred {
		t.Fatalf("state = %q, want %q", u.State, cloud.UpdateStateDeferred)
	}
	if u.TargetVerdict != string(otaverify.OutcomeOK) {
		t.Fatalf("target_verdict = %q - eine bestandene Kette ist 'ok', auch wenn "+
			"noch niemand angewandt hat", u.TargetVerdict)
	}
	if u.Target != "edge-2026.08.0" || u.TargetSeq == nil || *u.TargetSeq != 12 {
		t.Fatalf("Ziel wird nicht gemeldet: target=%q seq=%v", u.Target, u.TargetSeq)
	}
	if !strings.Contains(u.Reason, "beaufsichtigt") {
		t.Errorf("der Grund muss sagen, dass beaufsichtigt angewandt wird: %q", u.Reason)
	}
	// Nichts wird erfunden: ohne angewandtes Update gibt es weder einen eigenen
	// Stand noch ein Rueckfallziel.
	if u.CurrentSeq != nil || u.LastKnownGood != "" {
		t.Errorf("weder current_seq noch last_known_good duerfen behauptet werden: %+v", u)
	}

	// Durabel abgelegt - und zwar BYTEGLEICH, damit die Signatur pruefbar bleibt.
	store := otatarget.NewStore(b.a.Cfg.DataDir)
	raw, err := store.Load()
	if err != nil {
		t.Fatalf("Zuweisung wurde nicht abgelegt: %v", err)
	}
	env, err := otatarget.ParseEnvelope(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Die Artefakt-Digests sind sichtbar - aber NUR weil die Kette haelt.
	view := b.a.OtaTarget()
	if !view.HasTarget || view.Verdict != string(otaverify.OutcomeOK) {
		t.Fatalf("view = %+v", view)
	}
	if got := view.Images["core"]; !strings.Contains(got, "@sha256:") {
		t.Fatalf("update.sh braucht den digest-gepinnten Ref, bekam %q", got)
	}
	if view.Running {
		t.Error("dieses Geraet faehrt den Stand noch nicht")
	}
	_ = env
}

func TestAssignedReleaseIsIdempotentOnRetainedRedelivery(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	payload := b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), nil)

	b.a.onUpdateTarget(payload)
	first, err := otatarget.NewStore(b.a.Cfg.DataDir).Load()
	if err != nil {
		t.Fatal(err)
	}
	// Der Broker liefert die retained Nachricht bei JEDEM Verbindungsaufbau
	// erneut - das darf nichts veraendern und nichts doppelt tun.
	b.a.onUpdateTarget(payload)
	b.a.onUpdateTarget(payload)
	second, err := otatarget.NewStore(b.a.Cfg.DataDir).Load()
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("die abgelegte Zuweisung hat sich bei erneuter Zustellung veraendert")
	}
	if u := b.a.updateSummary(); u.TargetVerdict != string(otaverify.OutcomeOK) {
		t.Fatalf("verdict = %q", u.TargetVerdict)
	}
}

func TestAssignedReleaseWithABrokenChainIsRejectedAndReportedAsFailed(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	foreign := otaNewKey(t, "rel-2026-a") // gleiche key_id, ANDERER Schluessel
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), &foreign))

	u := b.a.updateSummary()
	// Eine gebrochene Kette ist ein SICHERHEITS-Ereignis. `failed` ist genau
	// das Signal, auf das der Rollout im Portal automatisch anhaelt - es darf
	// nie wie „passt gerade nicht" aussehen.
	if u.State != cloud.UpdateStateFailed {
		t.Fatalf("state = %q, want %q", u.State, cloud.UpdateStateFailed)
	}
	if u.TargetVerdict != string(otaverify.OutcomeRejected) {
		t.Fatalf("target_verdict = %q", u.TargetVerdict)
	}
	if u.Reason == "" {
		t.Fatal("eine rote Zeile ohne Grund ist nur ein Alarm")
	}
	// Und der Digest bleibt UNSICHTBAR: der beaufsichtigte Lauf darf nie etwas
	// anwenden, das dieses Geraet nicht selbst verifiziert hat.
	if view := b.a.OtaTarget(); len(view.Images) != 0 {
		t.Fatalf("ein ungeprueftes Manifest darf keine Artefakte herausgeben: %+v", view.Images)
	}
}

func TestAssignedReleaseBelowTheAntiRollbackFloorIsDeferredNotFailed(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.09.0", 20, 15))
	// Der eigene Stand liegt UNTER dem geforderten Boden - eine Zwischenstufe
	// fehlt. Signatur ist einwandfrei, also ist das eine Politik-Entscheidung.
	if err := b.a.otaWriteCurrent(b.dir, otaCurrent{Release: "edge-2026.07.2", ReleaseSeq: 11}); err != nil {
		t.Fatal(err)
	}
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.09.0", 20, 15), nil))

	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateDeferred {
		t.Fatalf("state = %q, want %q", u.State, cloud.UpdateStateDeferred)
	}
	if u.TargetVerdict != string(otaverify.OutcomeDeferred) {
		t.Fatalf("target_verdict = %q - ein Boden-Halt ist KEIN Vorfall", u.TargetVerdict)
	}
	if !strings.Contains(u.Reason, "15") {
		t.Errorf("der Grund muss den geforderten Stand nennen: %q", u.Reason)
	}
	// current_seq darf hier NICHT gemeldet werden: die hingelegte current.json
	// benennt nicht den laufenden Build.
	if u.CurrentSeq != nil {
		t.Errorf("current_seq wird nur gemeldet, wenn der aufgezeichnete Stand "+
			"WIRKLICH laeuft, bekam %v", *u.CurrentSeq)
	}
	if len(b.a.OtaTarget().Images) != 0 {
		t.Error("ein zurueckgestelltes Release darf nicht angewandt werden duerfen")
	}
}

func TestAssignedReleaseForAnotherDeviceIsIgnored(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	m := otaManifest("edge-2026.08.0", 12, 9)
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	sigPath := filepath.Join(t.TempDir(), "release.json")
	otaSign(t, sigPath, b.rel, otaverify.DomainRelease, raw)
	sig, _ := os.ReadFile(sigPath + ".sig")

	b.a.onUpdateTarget(otaEnvelopeBytes(t, m.Release, m.ReleaseSeq, raw, sig,
		"99999999-9999-4999-8999-999999999999"))

	if _, err := otatarget.NewStore(b.a.Cfg.DataDir).Load(); !os.IsNotExist(err) {
		t.Fatal("eine Zuweisung, die ein anderes Geraet meint, darf nicht abgelegt werden")
	}
	if u := b.a.updateSummary(); u.Target != "" {
		t.Fatalf("und nichts davon darf gemeldet werden: %+v", u)
	}
}

func TestAssignedReleaseWithdrawnByEmptyRetainedMessage(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	b.a.onUpdateTarget(b.envelope(t, otaManifest("edge-2026.08.0", 12, 9), nil))
	if u := b.a.updateSummary(); u.Target == "" {
		t.Fatal("Vorbedingung: eine Zuweisung liegt vor")
	}

	b.a.onUpdateTarget(nil) // retained-clear, z. B. beim Unclaim

	if _, err := otatarget.NewStore(b.a.Cfg.DataDir).Load(); !os.IsNotExist(err) {
		t.Fatal("die Zuweisung muss von Platte verschwinden - nie ein verwaistes Ziel")
	}
	u := b.a.updateSummary()
	if u.Target != "" || u.TargetVerdict != "" {
		t.Fatalf("nach der Ruecknahme darf kein Ziel mehr gemeldet werden: %+v", u)
	}
	if u.State != cloud.UpdateStateIdle || u.Reason != "" {
		t.Fatalf("und der Zustand faellt still auf idle zurueck: %q/%q", u.State, u.Reason)
	}
}

func TestAssignedReleaseThatIsAlreadyRunningReportsSucceeded(t *testing.T) {
	// Version ist die Build-Stempelung dieses Testbinaers; ein Manifest, dessen
	// Release genau so heisst, LAEUFT hier per Definition.
	m := otaManifest(Version, 12, 9)
	if !strings.HasPrefix(Version, "edge-") {
		// Der Testbau traegt "dev" - dann wird das Release passend benannt und
		// die Stempelung fuer diesen Test ueberschrieben.
		m = otaManifest("edge-2026.08.0", 12, 9)
	}
	b := newOtaTargetBox(t, m)
	old := Version
	Version = m.Release
	defer func() { Version = old }()

	b.a.onUpdateTarget(b.envelope(t, m, nil))
	u := b.a.updateSummary()
	if u.State != cloud.UpdateStateSucceeded {
		t.Fatalf("state = %q - Ist == Soll ist der Endzustand eines Rollouts", u.State)
	}
	if !b.a.OtaTarget().Running {
		t.Error("die Ansicht muss sagen, dass dieser Stand hier laeuft")
	}
}

func TestSupervisedApplyIsRecordedOnlyWhenItIsDemonstrablyTrue(t *testing.T) {
	b := newOtaTargetBox(t, otaManifest("edge-2026.08.0", 12, 9))
	old := Version
	Version = "edge-2026.08.0-3bf8c038"
	defer func() { Version = old }()

	// 1. Ein FREMDER Stand kann nicht aufgezeichnet werden - der Aufruf kann
	//    nur bestaetigen, was ohnehin schon laeuft.
	if _, err := b.a.OtaRecordApplied("edge-2026.09.9", 20); err == nil {
		t.Fatal("ein nicht laufender Release darf nicht aufgezeichnet werden")
	} else if !b.a.IsOtaRejection(err) {
		t.Fatalf("das ist eine Ablehnung (400), kein Fehler: %v", err)
	}
	if b.a.otaReadCurrent(b.dir) != nil {
		t.Fatal("und es darf dabei nichts geschrieben worden sein")
	}

	// 2. Der laufende Stand wird aufgezeichnet.
	if _, err := b.a.OtaRecordApplied("edge-2026.08.0", 12); err != nil {
		t.Fatal(err)
	}
	cur := b.a.otaReadCurrent(b.dir)
	if cur == nil || cur.ReleaseSeq != 12 {
		t.Fatalf("current.json = %+v", cur)
	}
	// Jetzt IST er belegt und darf im Herzschlag stehen.
	if u := b.a.updateSummary(); u.CurrentSeq == nil || *u.CurrentSeq != 12 {
		t.Fatalf("current_seq = %v", u.CurrentSeq)
	}

	// 3. Der Boden wird NIE abgesenkt.
	if _, err := b.a.OtaRecordApplied("edge-2026.08.0", 3); err == nil {
		t.Fatal("ein niedrigerer Stand muss abgelehnt werden - der Boden ist monoton")
	}
	if cur := b.a.otaReadCurrent(b.dir); cur.ReleaseSeq != 12 {
		t.Fatalf("der Boden wurde abgesenkt: %+v", cur)
	}
}

// TestContractExampleEnvelopeIsParsedAsSpecified liest die eingecheckten
// Kontrakt-Beispiele PER PFAD: das Verschieben eines Fixtures bricht diesen
// Test absichtlich, weil der Pfad Teil der Kontrakt-Pruefung ist.
func TestContractExampleEnvelopeIsParsedAsSpecified(t *testing.T) {
	base := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	for _, name := range []string{
		"mqtt-ota-target.valid.two-devices.json",
		"mqtt-ota-target.valid.single-device.json",
	} {
		raw, err := os.ReadFile(filepath.Join(base, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		env, err := otatarget.ParseEnvelope(raw)
		if err != nil {
			t.Fatalf("%s ist gueltig, wurde aber abgelehnt: %v", name, err)
		}
		// Die eingebetteten Manifest-Bytes muessen der ECHTE Parser lesen
		// koennen - sonst ist der Umschlag ein hohler Transport.
		if _, err := otaverify.ParseManifest(env.Manifest); err != nil {
			t.Fatalf("%s: das eingebettete Manifest ist nicht lesbar: %v", name, err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(base,
		"mqtt-ota-target.invalid.manifest-without-signature.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := otatarget.ParseEnvelope(raw); err == nil {
		t.Fatal("Bytes ohne Signatur waeren ein Release, das sich signiert NENNT - " +
			"das muss abgelehnt werden")
	}
}

// TestIdentityIsReValidatedEvenThoughTheBrokerAlreadyFences pins the belt-and-
// suspenders rule the other listeners share.
func TestIdentityIsReValidatedEvenThoughTheBrokerAlreadyFences(t *testing.T) {
	env := &otatarget.Envelope{TenantID: otaTestTenant, SiteID: otaTestSite,
		DeviceID: otaTestDevice}
	if !env.MatchesIdentity(otaTestTenant, otaTestSite, otaTestDevice) {
		t.Fatal("die eigene Identitaet muss passen")
	}
	if env.MatchesIdentity(otaTestTenant, otaTestSite, "99999999-9999-4999-8999-999999999999") {
		t.Fatal("eine fremde Geraete-Id darf nicht passen")
	}
	var _ entities.Identity // die Identitaet stammt aus derselben Quelle wie beim Entity-Push
}
