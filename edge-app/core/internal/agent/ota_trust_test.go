package agent

// OTA Stufe 4 „Politur" auf dem GERAET: der Herzschlag traegt die
// VERTRAUENS-IDENTITAET dieser Box.
//
// Sie beantwortet die zwei Fragen, die bis dahin nur eine handgefuehrte Liste
// beantwortete: traegt diese Box ueberhaupt ein schluesseltragendes Image
// (TOFU-Abschluss), und hat sie das neue root-signierte Trust-Set schon gesehen
// (Rotations-Drill). Sie meldet AUSSCHLIESSLICH Geprueftes und ist an keiner
// Stelle ein Schreibpfad.

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func TestHeartbeatCarriesTheVerifiedTrustIdentity(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	u := b.check()

	if u.Trust == nil {
		t.Fatal("der update-Block muss die Vertrauens-Identitaet tragen")
	}
	if len(u.Trust.RootKeyIDs) != 1 || u.Trust.RootKeyIDs[0] != "root-2026-a" {
		t.Fatalf("root_key_ids = %v", u.Trust.RootKeyIDs)
	}
	if len(u.Trust.TrustSetKeyIDs) != 1 || u.Trust.TrustSetKeyIDs[0] != "rel-2026-a" {
		t.Fatalf("trust_set_key_ids = %v", u.Trust.TrustSetKeyIDs)
	}
	if u.Trust.TrustSetSignedBy != "root-2026-a" || u.Trust.TrustSetError != "" {
		t.Fatalf("gesunde Kette meldet einen Fehler: %+v", u.Trust)
	}
}

// Die Identitaet gilt UNABHAENGIG von einem Release: genau die Box ohne
// Zuweisung ist die, deren Crossover-Stand der Betreiber wissen muss.
func TestTrustIdentityIsReportedWithoutAnyReleaseOnTheBox(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(data, otaDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	root := otaNewKey(t, "root-2026-a")
	rel := otaNewKey(t, "rel-2026-a")
	ts := otaWrite(t, filepath.Join(dir, otaTrustSetFile), otaverify.KeySet{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		GeneratedAt:   "2026-08-01T10:00:00Z",
		Keys: []otaverify.PublicKey{{KeyID: rel.id, Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(rel.pub)}},
	})
	otaSign(t, filepath.Join(dir, otaTrustSetFile), root, otaverify.DomainTrustSet, ts)

	a := &Agent{Cfg: config.Config{DataDir: data}, State: state.New("edge-test", Version)}
	a.otaRoots = &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: root.id, Alg: otaverify.AlgEd25519,
			PublicKey: base64.StdEncoding.EncodeToString(root.pub)}}}
	a.otaCheckOnce()
	u := a.updateSummary()

	if u.Trust == nil || len(u.Trust.RootKeyIDs) != 1 {
		t.Fatalf("ohne Release fehlt die Identitaet: %+v", u.Trust)
	}
	if u.Trust.TrustSetGeneratedAt != "2026-08-01T10:00:00Z" {
		t.Fatalf("der Rotations-Stempel muss mitreisen: %q", u.Trust.TrustSetGeneratedAt)
	}
	// Und es wird trotzdem kein Release behauptet.
	if u.Target != "" || u.TargetVerdict != "" {
		t.Fatalf("ohne Zuweisung darf kein Ziel gemeldet werden: %+v", u)
	}
}

// Der dokumentierte VOR-Crossover-Zustand: das Image traegt keine Wurzel. Das
// ist eine EHRLICHE Aussage - ein LEERES Feld, nicht ein fehlender Block -,
// damit die Cloud „noch nicht gekreuzt" von „aelterer Stand" unterscheiden kann.
func TestAKeylessImageReportsAnEmptyRootListNotAMissingBlock(t *testing.T) {
	data := t.TempDir()
	a := &Agent{Cfg: config.Config{DataDir: data}, State: state.New("edge-test", Version)}
	a.otaRoots = &otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion}
	a.otaCheckOnce()
	u := a.updateSummary()

	if u.Trust == nil {
		t.Fatal("der Block MUSS gesendet werden - sonst liest die Cloud „aelterer Stand\"")
	}
	if u.Trust.RootKeyIDs == nil {
		t.Fatal("die Liste muss leer, nicht null sein (JSON `[]` statt `null`)")
	}
	if len(u.Trust.RootKeyIDs) != 0 {
		t.Fatalf("ein schluessel-loses Image nennt keine Wurzel: %v", u.Trust.RootKeyIDs)
	}
	if !strings.Contains(u.Trust.TrustSetError, "Vertrauensanker") {
		t.Fatalf("der Grund muss den fehlenden Anker benennen: %q", u.Trust.TrustSetError)
	}
}

// Ein untergeschobenes Trust-Set wird NICHT berichtet - sonst koennte jeder,
// der /data beschreibt, der Flotte eine Schluesselmenge vorspielen.
func TestATrustSetTheBakedRootDidNotSignIsNeverReported(t *testing.T) {
	b := newOtaBox(t, otaManifest("edge-2026.08.0", 12, 9))
	fremd := otaNewKey(t, "root-fremd")
	raw, err := os.ReadFile(filepath.Join(b.dir, otaTrustSetFile))
	if err != nil {
		t.Fatal(err)
	}
	otaSign(t, filepath.Join(b.dir, otaTrustSetFile), fremd, otaverify.DomainTrustSet, raw)

	// Stempel aendern, damit wirklich neu geprueft wird.
	b.a.ota.trustStamp = ""
	u := b.check()

	if u.Trust == nil {
		t.Fatal("der Block bleibt - nur sein Inhalt wird ehrlich")
	}
	if len(u.Trust.TrustSetKeyIDs) != 0 {
		t.Fatalf("fremd signiertes Set darf nie gemeldet werden: %v", u.Trust.TrustSetKeyIDs)
	}
	if u.Trust.TrustSetError == "" {
		t.Fatal("eine Ablehnung traegt ihren Grund")
	}
	if len(u.Trust.RootKeyIDs) != 1 {
		t.Fatal("die eingebackene Wurzel ist eine Eigenschaft des IMAGES, nicht der Datei")
	}
}
