package main

// Der Rundlauf des Operator-Werkzeugs: erzeugen -> signieren -> verifizieren,
// gegen die ECHTEN Unterbefehle und den ECHTEN Verifizierer des Geraets.
//
// Alle Schluessel dieser Suite sind WEGWERF-Schluessel, erzeugt in einem
// temporaeren Verzeichnis. In diesem Repo liegt kein geheimer Schluessel; die
// echte Zeremonie laeuft offline beim Owner (docs/ota-signing.md).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const (
	coreRef    = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	noderedRef = "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:2222222222222222222222222222222222222222222222222222222222222222"
)

// ceremony fuehrt die vollstaendige Zeremonie aus docs/ota-signing.md aus und
// gibt das Arbeitsverzeichnis zurueck.
func ceremony(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := func(n string) string { return filepath.Join(dir, n) }

	must(t, cmdKeygen([]string{"--id", "root-2026-a", "--role", "root", "--out", dir}))
	must(t, cmdKeygen([]string{"--id", "rel-2026-a", "--role", "release", "--out", dir}))
	must(t, cmdTrustSet([]string{"--key", p("rel-2026-a.pub"), "--out", p("trust-set.json")}))
	must(t, cmdSign([]string{"--key", p("root-2026-a.key"), "--domain", "trust-set", "--in", p("trust-set.json")}))
	must(t, cmdManifest([]string{
		"--release", "edge-2026.08.0", "--seq", "12", "--commit", "3bf8c038a1b2",
		"--artifact", "core=" + coreRef, "--artifact", "nodered=" + noderedRef,
		"--min-from-seq", "9", "--state-schema", "3", "--key-id", "rel-2026-a",
		"--out", p("release.json"),
	}))
	must(t, cmdSign([]string{"--key", p("rel-2026-a.key"), "--domain", "release", "--in", p("release.json")}))
	return dir
}

func TestCeremonyRoundTripVerifies(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }

	// Gegen die konkrete Wurzel …
	must(t, cmdVerify([]string{
		"--root", p("root-2026-a.pub"), "--trust-set", p("trust-set.json"), "--manifest", p("release.json"),
		"--running-version", "edge-2026.07.2-665d59b8c0d1", "--current-seq", "11",
	}))
	// … und gegen ein rootkeys.json-foermiges Set (die Form, die eingebacken wird).
	rootSet := p("rootkeys.json")
	writeRootSet(t, rootSet, p("root-2026-a.pub"))
	must(t, cmdVerify([]string{
		"--root", rootSet, "--trust-set", p("trust-set.json"), "--manifest", p("release.json"),
	}))

	// Die geheime Schluesseldatei muss 0600 sein - sie ist das ganze Geheimnis.
	fi, err := os.Stat(p("root-2026-a.key"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("root-2026-a.key hat Modus %v, erwartet 0600", fi.Mode().Perm())
	}
	// Und sie darf niemals stillschweigend ueberschrieben werden.
	if err := cmdKeygen([]string{"--id", "root-2026-a", "--role", "root", "--out", dir}); err == nil {
		t.Error("ein vorhandener geheimer Schluessel wurde ueberschrieben")
	}
}

func TestVerifyFailsOnTamperedBytes(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }

	raw, err := os.ReadFile(p("release.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Nur das Artefakt austauschen - die Stelle, an der ein Angreifer ein
	// fremdes Image unterschieben wuerde.
	tampered := strings.Replace(string(raw), coreRef,
		strings.Replace(coreRef, "sha256:1111", "sha256:9999", 1), 1)
	if tampered == string(raw) {
		t.Fatal("Testaufbau: nichts ersetzt")
	}
	if err := os.WriteFile(p("release.json"), []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cmdVerify([]string{
		"--root", p("root-2026-a.pub"), "--trust-set", p("trust-set.json"), "--manifest", p("release.json"),
	}); err == nil {
		t.Fatal("manipulierte Bytes wurden akzeptiert")
	}
}

func TestVerifyFailsAgainstTheWrongRoot(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	must(t, cmdKeygen([]string{"--id", "root-fremd", "--role", "root", "--out", dir}))
	if err := cmdVerify([]string{
		"--root", p("root-fremd.pub"), "--trust-set", p("trust-set.json"), "--manifest", p("release.json"),
	}); err == nil {
		t.Fatal("eine fremde Wurzel wurde akzeptiert")
	}
}

func TestVerifyEnforcesTheFloorAndTheDowngradeFlag(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	root, ts, rel := p("root-2026-a.pub"), p("trust-set.json"), p("release.json")

	// min_from_seq = 9: darunter fehlt eine Zwischenstufe.
	if err := cmdVerify([]string{"--root", root, "--trust-set", ts, "--manifest", rel, "--current-seq", "8"}); err == nil {
		t.Error("Boden unterschritten und trotzdem akzeptiert")
	}
	if err := cmdVerify([]string{"--root", root, "--trust-set", ts, "--manifest", rel, "--current-seq", "9"}); err != nil {
		t.Errorf("genau auf dem Boden muss es gehen: %v", err)
	}
	// Rueckschritt ohne Freigabe (Replay eines echt signierten Altmanifests).
	if err := cmdVerify([]string{"--root", root, "--trust-set", ts, "--manifest", rel, "--current-seq", "20"}); err == nil {
		t.Error("Rueckschritt ohne Freigabe wurde akzeptiert")
	}
	// Mit ausdruecklicher Freigabe geht derselbe Sprung.
	down := p("downgrade.json")
	must(t, cmdManifest([]string{
		"--release", "edge-2026.07.2", "--seq", "11", "--commit", "665d59b8c0d1",
		"--artifact", "core=" + coreRef, "--min-from-seq", "9", "--state-schema", "3",
		"--key-id", "rel-2026-a", "--allow-downgrade", "--out", down,
	}))
	must(t, cmdSign([]string{"--key", p("rel-2026-a.key"), "--domain", "release", "--in", down}))
	if err := cmdVerify([]string{"--root", root, "--trust-set", ts, "--manifest", down, "--current-seq", "20"}); err != nil {
		t.Errorf("freigegebener Rueckschritt muss gehen: %v", err)
	}
}

func TestVerifyRefusesAReleaseForAnotherBackend(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	other := p("mender.json")
	must(t, cmdManifest([]string{
		"--release", "edge-2026.09.0", "--seq", "13", "--commit", "aabbccdd1122",
		"--artifact", "core=" + coreRef, "--state-schema", "3", "--key-id", "rel-2026-a",
		"--backend", "mender", "--out", other,
	}))
	must(t, cmdSign([]string{"--key", p("rel-2026-a.key"), "--domain", "release", "--in", other}))
	if err := cmdVerify([]string{
		"--root", p("root-2026-a.pub"), "--trust-set", p("trust-set.json"), "--manifest", other,
		"--backend", "compose",
	}); err == nil {
		t.Fatal("ein Release fuer ein fremdes Backend wurde akzeptiert")
	}
}

func TestSignEnforcesTheKeyRoles(t *testing.T) {
	// Die kalt/heiss-Trennung wird vom Werkzeug ERZWUNGEN, nicht nur beschrieben:
	// die Wurzel signiert nur Trust-Sets, der Release-Schluessel nur Manifeste.
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	if err := cmdSign([]string{"--key", p("root-2026-a.key"), "--domain", "release",
		"--in", p("release.json"), "--out", p("boese.sig")}); err == nil {
		t.Error("die Wurzel durfte ein Release signieren")
	}
	if err := cmdSign([]string{"--key", p("rel-2026-a.key"), "--domain", "trust-set",
		"--in", p("trust-set.json"), "--out", p("boese2.sig")}); err == nil {
		t.Error("ein Release-Schluessel durfte ein Trust-Set signieren")
	}
	// Und ein Root-Schluessel darf gar nicht erst ins Trust-Set wandern - sonst
	// koennte ein Trust-Set die Wurzel erweitern.
	if err := cmdTrustSet([]string{"--key", p("root-2026-a.pub"), "--out", p("boese-ts.json")}); err == nil {
		t.Error("ein Root-Schluessel wurde ins Trust-Set aufgenommen")
	}
}

func TestSignRefusesAManifestNamingAnotherKey(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	must(t, cmdKeygen([]string{"--id", "rel-2026-b", "--role", "release", "--out", dir}))
	if err := cmdSign([]string{"--key", p("rel-2026-b.key"), "--domain", "release",
		"--in", p("release.json"), "--out", p("falsch.sig")}); err == nil {
		t.Fatal("signiert, obwohl das Manifest einen anderen Schluessel nennt")
	}
}

func TestManifestRefusesATagInsteadOfADigest(t *testing.T) {
	dir := t.TempDir()
	err := cmdManifest([]string{
		"--release", "edge-2026.08.0", "--seq", "12", "--commit", "3bf8c038a1b2",
		"--artifact", "core=git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest",
		"--state-schema", "3", "--key-id", "rel-2026-a",
		"--out", filepath.Join(dir, "release.json"),
	})
	if err == nil {
		t.Fatal("ein Tag statt eines Digests wurde akzeptiert")
	}
}

func TestRegisterBodyCarriesTheExactSignedBytes(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	// `sign` legt den Register-Eintrag bereits ab; `register` erzeugt ihn erneut.
	must(t, cmdRegister([]string{"--manifest", p("release.json"), "--out", p("register.json")}))

	var body registerBody
	raw, err := os.ReadFile(p("register.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	manifestBytes, _ := os.ReadFile(p("release.json"))
	sigBytes, _ := os.ReadFile(p("release.json.sig"))
	// DAS ist der Punkt: die Bytes muessen den Weg durch das Register
	// unveraendert ueberstehen, sonst ist die Signatur dahinter wertlos.
	if body.Manifest != string(manifestBytes) {
		t.Error("der Register-Rumpf traegt nicht die exakten Manifest-Bytes")
	}
	if body.Signature != string(sigBytes) {
		t.Error("der Register-Rumpf traegt nicht die exakte Signatur")
	}
	if body.Version != "edge-2026.08.0" || body.ReleaseSeq != 12 || body.SigningKeyID != "rel-2026-a" {
		t.Errorf("Register-Rumpf falsch: %+v", body)
	}
	// Und die so transportierten Bytes verifizieren weiterhin.
	roots, err := loadRoots(p("root-2026-a.pub"))
	if err != nil {
		t.Fatal(err)
	}
	tsRaw, tsSig, err := readWithSig(p("trust-set.json"))
	if err != nil {
		t.Fatal(err)
	}
	v := otaverify.Verify(otaverify.Input{
		Roots: roots, TrustSet: tsRaw, TrustSetSig: tsSig,
		Manifest: []byte(body.Manifest), ManifestSig: []byte(body.Signature),
		Backend: otaverify.BackendCompose,
	})
	if !v.OK() {
		t.Fatalf("die durch das Register gereichten Bytes verifizieren nicht: %s / %s", v.Outcome, v.Reason)
	}
}

func TestRegisterRefusesAMismatchedSignature(t *testing.T) {
	dir := ceremony(t)
	p := func(n string) string { return filepath.Join(dir, n) }
	must(t, cmdKeygen([]string{"--id", "rel-2026-b", "--role", "release", "--out", dir}))
	other := p("other.json")
	must(t, cmdManifest([]string{
		"--release", "edge-2026.09.0", "--seq", "13", "--commit", "aabbccdd1122",
		"--artifact", "core=" + coreRef, "--state-schema", "3", "--key-id", "rel-2026-b", "--out", other,
	}))
	must(t, cmdSign([]string{"--key", p("rel-2026-b.key"), "--domain", "release", "--in", other}))
	// Fremde Signatur an ein Manifest heften: der Eintrag waere eine Luege,
	// die im Register niemand mehr bemerkt.
	if err := cmdRegister([]string{"--manifest", p("release.json"), "--sig", other + ".sig",
		"--out", p("luege.json")}); err == nil {
		t.Fatal("Register-Eintrag mit fremder Signatur wurde erzeugt")
	}
}

func writeRootSet(t *testing.T, path, pubPath string) {
	t.Helper()
	var pf PublicKeyFile
	if err := readJSONFile(pubPath, &pf); err != nil {
		t.Fatal(err)
	}
	ks := otaverify.KeySet{SchemaVersion: otaverify.SignatureSchemaVersion,
		Keys: []otaverify.PublicKey{{KeyID: pf.KeyID, Alg: pf.Alg, PublicKey: pf.PublicKey}}}
	if err := writeJSONFile(path, ks, 0o644); err != nil {
		t.Fatal(err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unerwarteter Fehler: %v", err)
	}
}
