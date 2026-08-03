package otaverify

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- Wegwerf-Schluessel + Fixtures ------------------------------------------
//
// Alle Schluessel dieser Suite entstehen ZUR LAUFZEIT. In diesem Repo liegt
// bewusst kein einziger geheimer Schluessel; die echte Zeremonie laeuft
// offline beim Owner (docs/ota-signing.md).

type pair struct {
	id   string
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newPair(t *testing.T, id string) pair {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	return pair{id: id, pub: pub, priv: priv}
}

func (p pair) keySetEntry(notAfter string) PublicKey {
	return PublicKey{KeyID: p.id, Alg: AlgEd25519,
		PublicKey: base64.StdEncoding.EncodeToString(p.pub), NotAfter: notAfter}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return append(raw, '\n')
}

// signDoc ist die Signierseite - sie ruft bewusst DIESELBE SigningInput auf
// wie der Verifizierer, damit die beiden Seiten nicht auseinanderlaufen koennen.
func signDoc(t *testing.T, p pair, domain string, doc []byte) []byte {
	t.Helper()
	in, err := SigningInput(domain, doc)
	if err != nil {
		t.Fatalf("SigningInput: %v", err)
	}
	return mustJSON(t, Signature{
		SchemaVersion: SignatureSchemaVersion, Alg: AlgEd25519, KeyID: p.id, Domain: domain,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(p.priv, in)),
	})
}

func validManifest() Manifest {
	return Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Release:       "edge-2026.08.0",
		ReleaseSeq:    12,
		TargetCommit:  "3bf8c038a1b2",
		Artifacts: []Artifact{
			{Type: ArtifactOCIImage, Name: "core",
				Ref: "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:" + strings.Repeat("a", 64)},
			{Type: ArtifactOCIImage, Name: "nodered",
				Ref: "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:" + strings.Repeat("b", 64)},
		},
		MinFromSeq:   9,
		StateSchema:  3,
		Compat:       Compat{Backends: []string{BackendCompose}},
		SigningKeyID: "rel-2026-a",
	}
}

// world ist eine vollstaendige, gueltige Kette (Wurzel -> Trust-Set -> Manifest).
type world struct {
	root, rel pair
	in        Input
}

func newWorld(t *testing.T) *world {
	t.Helper()
	root := newPair(t, "root-2026-a")
	rel := newPair(t, "rel-2026-a")
	ts := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{rel.keySetEntry("")}})
	m := mustJSON(t, validManifest())
	return &world{root: root, rel: rel, in: Input{
		Roots:       &KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{root.keySetEntry("")}},
		TrustSet:    ts,
		TrustSetSig: signDoc(t, root, DomainTrustSet, ts),
		Manifest:    m,
		ManifestSig: signDoc(t, rel, DomainRelease, m),
		Backend:     BackendCompose,
		Now:         time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
	}}
}

// withManifest ersetzt das Manifest und signiert es frisch.
func (w *world) withManifest(t *testing.T, m Manifest) *world {
	t.Helper()
	raw := mustJSON(t, m)
	w.in.Manifest = raw
	w.in.ManifestSig = signDoc(t, w.rel, DomainRelease, raw)
	return w
}

func seq(n int64) *int64 { return &n }

// --- Der glueckliche Pfad ----------------------------------------------------

func TestVerifyAcceptsAGenuineRelease(t *testing.T) {
	w := newWorld(t)
	v := Verify(w.in)
	if !v.OK() {
		t.Fatalf("erwartet ok, bekam %s: %s", v.Outcome, v.Reason)
	}
	if v.SignedBy != "rel-2026-a" {
		t.Errorf("SignedBy = %q", v.SignedBy)
	}
	if v.Manifest == nil || v.Manifest.ReleaseSeq != 12 {
		t.Fatalf("Manifest fehlt oder falsch: %+v", v.Manifest)
	}
	if v.Reason == "" {
		t.Error("auch ein gutes Urteil sagt, was es geprueft hat")
	}
	// Ohne bekannten eigenen Stand MUSS der nicht bewertete Boden benannt sein
	// - sonst laese sich „ok" als „Anti-Rollback geprueft".
	if !hasNote(v, "Anti-Rollback-Boden") {
		t.Errorf("unbewerteter Boden nicht berichtet: %v", v.Notes)
	}
}

func TestVerifyReportsTheRunningReleaseFromTheStampedStyleVersion(t *testing.T) {
	// edge-images stempelt bei Tag-Builds `<tag>-<kurzsha>`.
	for _, tc := range []struct {
		stamped string
		want    bool
	}{
		{"edge-2026.08.0-3bf8c038a1b2", true},
		{"edge-2026.08.0", true},
		{"edge-2026.07.2-665d59b8c0d1", false},
		{"3bf8c038a1b2", false}, // Bestandsbau: gehoert zu keinem Release
		{"", false},
	} {
		w := newWorld(t)
		w.in.RunningVersion = tc.stamped
		if got := Verify(w.in).AlreadyRunning; got != tc.want {
			t.Errorf("AlreadyRunning(%q) = %v, erwartet %v", tc.stamped, got, tc.want)
		}
	}
}

// --- Die Kette bricht --------------------------------------------------------

func TestVerifyRefusesTamperedManifestBytes(t *testing.T) {
	w := newWorld(t)
	// EIN Byte im signierten Dokument: aus Stand 12 wird 13. Das Dokument
	// bleibt syntaktisch einwandfrei - genau darum geht es.
	w.in.Manifest = []byte(strings.Replace(string(w.in.Manifest), `"release_seq": 12`, `"release_seq": 13`, 1))
	v := Verify(w.in)
	if v.Outcome != OutcomeRejected {
		t.Fatalf("manipulierte Bytes muessen abgelehnt werden, bekam %s", v.Outcome)
	}
	if v.Manifest != nil {
		t.Error("ungeprueftes Manifest darf nicht weitergereicht werden")
	}
}

func TestVerifyRefusesWhitespaceOnlyChanges(t *testing.T) {
	// Die Signatur geht ueber die Bytes, nicht ueber den geparsten Inhalt:
	// eine reine Umformatierung ist semantisch identisch und trotzdem ungueltig.
	w := newWorld(t)
	var m map[string]any
	if err := json.Unmarshal(w.in.Manifest, &m); err != nil {
		t.Fatal(err)
	}
	compact, _ := json.Marshal(m)
	w.in.Manifest = compact
	if v := Verify(w.in); v.Outcome != OutcomeRejected {
		t.Fatalf("umformatiertes Manifest muss abgelehnt werden, bekam %s: %s", v.Outcome, v.Reason)
	}
}

func TestVerifyRefusesAForeignSigningKey(t *testing.T) {
	w := newWorld(t)
	evil := newPair(t, "rel-2026-a") // gleiche key_id, anderer Schluessel
	w.in.ManifestSig = signDoc(t, evil, DomainRelease, w.in.Manifest)
	if v := Verify(w.in); v.Outcome != OutcomeRejected {
		t.Fatalf("fremder Schluessel muss abgelehnt werden, bekam %s", v.Outcome)
	}
}

func TestVerifyRefusesAKeyThatIsNotInTheTrustSet(t *testing.T) {
	w := newWorld(t)
	other := newPair(t, "rel-2027-x")
	m := validManifest()
	m.SigningKeyID = other.id
	raw := mustJSON(t, m)
	w.in.Manifest = raw
	w.in.ManifestSig = signDoc(t, other, DomainRelease, raw)
	v := Verify(w.in)
	if v.Outcome != OutcomeRejected || !strings.Contains(v.Reason, "Vertrauens-Set") {
		t.Fatalf("unbekannter Schluessel: %s / %s", v.Outcome, v.Reason)
	}
}

func TestVerifyRefusesATrustSetThatIsNotRootSigned(t *testing.T) {
	// Der Kern der kalt/heiss-Trennung: wer NUR /data schreiben kann, kann
	// zwar ein Trust-Set hinlegen, aber keines root-signieren.
	w := newWorld(t)
	attacker := newPair(t, "rel-evil")
	ts := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion, Keys: []PublicKey{attacker.keySetEntry("")}})
	w.in.TrustSet = ts
	w.in.TrustSetSig = signDoc(t, attacker, DomainTrustSet, ts) // selbst signiert
	v := Verify(w.in)
	if v.Outcome != OutcomeRejected {
		t.Fatalf("nicht root-signiertes Trust-Set muss abgelehnt werden, bekam %s", v.Outcome)
	}
}

func TestVerifyRefusesACrossDomainReplay(t *testing.T) {
	// Ohne Domain-Trennung waeren beide Dokumente „irgendein JSON mit Ed25519".
	// Ein root-signiertes Trust-Set darf nie als Manifest durchgehen.
	w := newWorld(t)
	sameKeyEverywhere := w.root
	m := w.in.Manifest
	crossSig := signDoc(t, sameKeyEverywhere, DomainTrustSet, m) // richtige Bytes, falsche Domain
	w.in.ManifestSig = crossSig
	if v := Verify(w.in); v.Outcome != OutcomeRejected {
		t.Fatalf("Domain-Verwechslung muss abgelehnt werden, bekam %s", v.Outcome)
	}
	// Und der Kontext geht wirklich in die Bytes ein:
	a, _ := SigningInput(DomainRelease, m)
	b, _ := SigningInput(DomainTrustSet, m)
	if string(a) == string(b) {
		t.Fatal("die Domain-Kontexte unterscheiden die zu signierenden Bytes nicht")
	}
}

func TestVerifyRefusesAnyAlgorithmOtherThanEd25519(t *testing.T) {
	// Die JWT-alg-Luecke: ein Verifizierer, der den Algorithmus aus dem
	// Dokument uebernimmt, laesst sich herunterhandeln.
	for _, alg := range []string{"none", "hs256", "ed448", ""} {
		w := newWorld(t)
		w.in.ManifestSig = []byte(strings.Replace(string(w.in.ManifestSig),
			`"alg": "ed25519"`, `"alg": "`+alg+`"`, 1))
		if v := Verify(w.in); v.Outcome != OutcomeRejected {
			t.Errorf("alg=%q wurde nicht abgelehnt: %s", alg, v.Outcome)
		}
	}
}

func TestVerifyRefusesWhenTheManifestNamesADifferentKeyThanTheSignature(t *testing.T) {
	// Beide Angaben sind signaturgeschuetzt bzw. steuern die Auswahl - sie
	// duerfen nicht auseinanderlaufen.
	w := newWorld(t)
	second := newPair(t, "rel-2026-b")
	ts := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion,
		Keys: []PublicKey{w.rel.keySetEntry(""), second.keySetEntry("")}})
	w.in.TrustSet = ts
	w.in.TrustSetSig = signDoc(t, w.root, DomainTrustSet, ts)
	w.in.ManifestSig = signDoc(t, second, DomainRelease, w.in.Manifest) // gueltig, aber rel-2026-b
	v := Verify(w.in)
	if v.Outcome != OutcomeRejected || !strings.Contains(v.Reason, "rel-2026-b") {
		t.Fatalf("key_id-Widerspruch: %s / %s", v.Outcome, v.Reason)
	}
}

func TestVerifyFailsClosedWithoutABakedRoot(t *testing.T) {
	w := newWorld(t)
	for _, roots := range []*KeySet{nil, {SchemaVersion: SignatureSchemaVersion}} {
		w.in.Roots = roots
		v := Verify(w.in)
		if v.Outcome != OutcomeRejected || !strings.Contains(v.Reason, "Vertrauensanker") {
			t.Fatalf("ohne Wurzel muss fail-closed gelten: %s / %s", v.Outcome, v.Reason)
		}
	}
}

func TestBakedRootsAreEmptyUntilTheCeremonyRan(t *testing.T) {
	ks, err := BakedRoots()
	if err != nil {
		t.Fatalf("rootkeys.json ist nicht lesbar: %v", err)
	}
	// Dieser Test ist ABSICHTLICH so formuliert: er faellt in dem Moment auf,
	// in dem der Owner eine echte Wurzel eintraegt - dann gehoert er auf
	// „genau eine Wurzel, und zwar diese" umgestellt (docs/ota-signing.md).
	if len(ks.Keys) != 0 {
		t.Fatalf("es sind %d Wurzeln eingebacken - Test auf die erwartete Wurzel festnageln", len(ks.Keys))
	}
}

func TestVerifyRefusesAnExpiredReleaseKeyButRevocationIsTheClockIndependentLever(t *testing.T) {
	w := newWorld(t)
	ts := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion,
		Keys: []PublicKey{w.rel.keySetEntry("2026-01-01T00:00:00Z")}})
	w.in.TrustSet = ts
	w.in.TrustSetSig = signDoc(t, w.root, DomainTrustSet, ts)
	if v := Verify(w.in); v.Outcome != OutcomeRejected || !strings.Contains(v.Reason, "abgelaufen") {
		t.Fatalf("abgelaufener Schluessel: %s / %s", v.Outcome, v.Reason)
	}
	// Ohne vertrauenswuerdige Uhr wird Ablauf NICHT geprueft (ein Pi ohne RTC
	// wuerde sich sonst selbst aussperren) - der belastbare Widerruf ist ein
	// neues, root-signiertes Set ohne den Schluessel.
	w.in.Now = time.Time{}
	if v := Verify(w.in); !v.OK() {
		t.Fatalf("ohne Uhr darf Ablauf nicht greifen: %s / %s", v.Outcome, v.Reason)
	}
	revoked := mustJSON(t, KeySet{SchemaVersion: SignatureSchemaVersion,
		Keys: []PublicKey{newPair(t, "rel-2027-a").keySetEntry("")}})
	w.in.TrustSet = revoked
	w.in.TrustSetSig = signDoc(t, w.root, DomainTrustSet, revoked)
	if v := Verify(w.in); v.Outcome != OutcomeRejected {
		t.Fatalf("Widerruf muss auch ohne Uhr greifen, bekam %s", v.Outcome)
	}
}

// --- Politik: Boden, Rueckschritt, Backend ----------------------------------

func TestVerifyDefersBelowTheAntiRollbackFloor(t *testing.T) {
	w := newWorld(t) // min_from_seq = 9
	w.in.CurrentSeq = seq(8)
	v := Verify(w.in)
	if v.Outcome != OutcomeDeferred {
		t.Fatalf("Boden unterschritten -> deferred, bekam %s", v.Outcome)
	}
	if !strings.Contains(v.Reason, "Zwischenstufe") {
		t.Errorf("Grund benennt die fehlende Zwischenstufe nicht: %s", v.Reason)
	}
	// deferred ist KEIN Sicherheitsvorfall: die Signatur war einwandfrei, also
	// darf ueber den Inhalt geredet werden.
	if v.Manifest == nil {
		t.Error("bei deferred bleibt das verifizierte Manifest erhalten")
	}
	w.in.CurrentSeq = seq(9) // genau auf dem Boden = erlaubt
	if v := Verify(w.in); !v.OK() {
		t.Fatalf("auf dem Boden muss es gehen: %s / %s", v.Outcome, v.Reason)
	}
}

func TestVerifyDefersADowngradeUnlessExplicitlyAllowed(t *testing.T) {
	w := newWorld(t)
	w.in.CurrentSeq = seq(12) // gleicher Stand
	if v := Verify(w.in); v.Outcome != OutcomeDeferred {
		t.Fatalf("gleicher Stand ohne Freigabe -> deferred, bekam %s", v.Outcome)
	}
	w.in.CurrentSeq = seq(15) // Replay eines aelteren, echt signierten Manifests
	v := Verify(w.in)
	if v.Outcome != OutcomeDeferred || !strings.Contains(v.Reason, "Rueckschritt") {
		t.Fatalf("Replay muss abgelehnt werden: %s / %s", v.Outcome, v.Reason)
	}
	// Der bewusst signierte Tief-Rollback geht durch - und wird benannt.
	m := validManifest()
	m.AllowDowngrade = true
	w.withManifest(t, m)
	v = Verify(w.in)
	if !v.OK() {
		t.Fatalf("freigegebener Rueckschritt: %s / %s", v.Outcome, v.Reason)
	}
	if !hasNote(v, "Rueckschritt") {
		t.Errorf("ein Rueckschritt muss benannt werden: %v", v.Notes)
	}
}

func TestVerifyDefersAReleaseForAnotherBackend(t *testing.T) {
	w := newWorld(t)
	m := validManifest()
	m.Compat.Backends = []string{BackendMender, BackendQuadlet}
	w.withManifest(t, m)
	v := Verify(w.in)
	if v.Outcome != OutcomeDeferred {
		t.Fatalf("fremdes Backend -> deferred, bekam %s", v.Outcome)
	}
	if !strings.Contains(v.Reason, "compose") || !strings.Contains(v.Reason, "mender") {
		t.Errorf("Grund nennt weder eigenes noch zulaessiges Backend: %s", v.Reason)
	}
}

func TestValidUntilIsAdvisoryAndNeverRefuses(t *testing.T) {
	w := newWorld(t)
	m := validManifest()
	m.ValidUntil = "2026-01-01T00:00:00Z" // laengst vorbei
	w.withManifest(t, m)
	v := Verify(w.in)
	if !v.OK() {
		t.Fatalf("valid_until darf nie ablehnen: %s / %s", v.Outcome, v.Reason)
	}
	if !hasNote(v, "nur ein Hinweis") {
		t.Errorf("abgelaufenes valid_until nicht berichtet: %v", v.Notes)
	}
	w.in.Now = time.Time{}
	if v := Verify(w.in); !hasNote(v, "keine vertrauenswuerdige Uhr") {
		t.Errorf("ohne Uhr muss die Nichtpruefung benannt werden: %v", v.Notes)
	}
}

// --- Struktur ----------------------------------------------------------------

func TestParseManifestRejectsStructuralLies(t *testing.T) {
	for name, mutate := range map[string]func(m *Manifest){
		"tag statt digest": func(m *Manifest) {
			m.Artifacts[0].Ref = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest"
		},
		"kurzer digest": func(m *Manifest) {
			m.Artifacts[0].Ref = "git.tecmaxx.de/x/y@sha256:abc"
		},
		"leere artefakte":      func(m *Manifest) { m.Artifacts = nil },
		"doppeltes artefakt":   func(m *Manifest) { m.Artifacts[1].Name = m.Artifacts[0].Name },
		"unbekannter typ":      func(m *Manifest) { m.Artifacts[0].Type = "os-image" },
		"leere backends":       func(m *Manifest) { m.Compat.Backends = nil },
		"unbekanntes backend":  func(m *Manifest) { m.Compat.Backends = []string{"balena"} },
		"seq null":             func(m *Manifest) { m.ReleaseSeq = 0 },
		"boden ueber seq":      func(m *Manifest) { m.MinFromSeq = 99 },
		"falsches releasetag":  func(m *Manifest) { m.Release = "edge-2026.8" },
		"nackte sha als tag":   func(m *Manifest) { m.Release = "3bf8c038a1b2" },
		"kein commit":          func(m *Manifest) { m.TargetCommit = "ZZZ" },
		"state_schema null":    func(m *Manifest) { m.StateSchema = 0 },
		"leere key_id":         func(m *Manifest) { m.SigningKeyID = "" },
		"fremde schema major":  func(m *Manifest) { m.SchemaVersion = "2.0" },
		"kaputtes valid_until": func(m *Manifest) { m.ValidUntil = "morgen" },
	} {
		m := validManifest()
		mutate(&m)
		if _, err := ParseManifest(mustJSON(t, m)); err == nil {
			t.Errorf("%s: haette abgelehnt werden muessen", name)
		}
	}
}

func TestParseManifestAcceptsUnknownFieldsWithinTheSameMajor(t *testing.T) {
	// Vorwaertskompatibilitaet innerhalb 1.x: ein neues Feld traegt unsere
	// Signatur, stammt also per Konstruktion von uns. Eine fremde MAJOR wird
	// dagegen abgelehnt (siehe oben) statt geraten.
	raw := mustJSON(t, validManifest())
	withExtra := strings.Replace(string(raw), `"schema_version": "1.0"`,
		`"schema_version": "1.7",`+"\n  "+`"rollout_hint": {"wave": 2}`, 1)
	if _, err := ParseManifest([]byte(withExtra)); err != nil {
		t.Fatalf("unbekanntes Feld in 1.x muss durchgehen: %v", err)
	}
}

// --- Der Kontrakt als ausfuehrbare Pruefung ---------------------------------

// TestContractExamplesParseAsSpecified liest die Beispieldateien BY PATH -
// wer eine verschiebt, bricht diesen Test absichtlich (die Hausdisziplin aus
// docs/contracts/examples/README.md).
func TestContractExamplesParseAsSpecified(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	for _, tc := range []struct {
		file  string
		valid bool
	}{
		{"ota-release-manifest.valid.compose.json", true},
		{"ota-release-manifest.valid.downgrade.json", true},
		{"ota-release-manifest.invalid.tag-not-digest.json", false},
	} {
		raw, err := os.ReadFile(filepath.Join(dir, tc.file))
		if err != nil {
			t.Fatalf("%s: %v", tc.file, err)
		}
		_, err = ParseManifest(raw)
		if tc.valid && err != nil {
			t.Errorf("%s sollte gueltig sein: %v", tc.file, err)
		}
		if !tc.valid && err == nil {
			t.Errorf("%s sollte abgelehnt werden", tc.file)
		}
	}
}

// Das ADDITIVE Eil-Feld der Stufe 3 (schema_version bleibt 1.0): es reist
// innerhalb der signierten Bytes, weil nur der Owner ein Release fuer eilig
// erklaeren darf - der unsignierte Umschlag koennte es sonst behaupten.
func TestTheUrgentFlagRidesInsideTheSignedManifestAndDefaultsToFalse(t *testing.T) {
	m := validManifest()
	if m.Urgent {
		t.Fatal("ohne Angabe ist ein Release NICHT eilig - der geduldige Weg ist die Vorgabe")
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	// omitempty: ein gewoehnliches Release traegt das Feld gar nicht, also
	// bleiben die Bytes eines Stufe-1/2-Manifests zeichengleich.
	if strings.Contains(string(raw), "urgent") {
		t.Fatalf("ein nicht eiliges Release darf das Feld nicht tragen: %s", raw)
	}

	m.Urgent = true
	raw, _ = json.Marshal(m)
	back, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("ein eiliges Manifest muss lesbar sein: %v", err)
	}
	if !back.Urgent {
		t.Fatal("das Eil-Feld ist auf dem Weg verloren gegangen")
	}
}

func hasNote(v Verdict, substr string) bool {
	for _, n := range v.Notes {
		if strings.Contains(n, substr) {
			return true
		}
	}
	return false
}
