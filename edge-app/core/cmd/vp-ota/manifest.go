package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

func cmdManifest(args []string) error {
	fs := flag.NewFlagSet("manifest", flag.ExitOnError)
	release := fs.String("release", "", "Release-Tag edge-JJJJ.MM.N (Pflicht)")
	seq := fs.Int64("seq", 0, "release_seq - die monotone Ordnung aus dem Register (Pflicht)")
	commit := fs.String("commit", "", "target_commit im voltpilot-ems-Repo (Pflicht)")
	minFrom := fs.Int64("min-from-seq", 0, "Anti-Rollback-Boden: darunter fehlt eine Zwischenstufe")
	stateSchema := fs.Int("state-schema", 1, "/data-Zustandsversion, die dieses Release unterstuetzt")
	keyID := fs.String("key-id", "", "signing_key_id des Release-Schluessels (Pflicht)")
	validUntil := fs.String("valid-until", "", "advisory (RFC 3339), nie ein Ablehnungsgrund")
	allowDowngrade := fs.Bool("allow-downgrade", false, "bewusster Tief-Rollback freigeben")
	notes := fs.String("notes", "", "Release-Notiz fuer Register und Oberflaeche")
	urgent := fs.Bool("urgent", false,
		"Eil-Release: der autonome Tausch verschiebt nicht, sondern stellt die Anlage zuerst bewusst neutral")
	out := fs.String("out", "release.json", "Zieldatei")
	var artifacts stringList
	fs.Var(&artifacts, "artifact", "name=ref@sha256:… (mehrfach angebbar, Pflicht)")
	var backends stringList
	fs.Var(&backends, "backend", "Apply-Backend, fuer das dieses Release gilt (Vorgabe: compose)")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota manifest - unsigniertes release.json erzeugen

Die Referenzen MUESSEN voll digest-gepinnt sein (…@sha256:…). Ein Tag waere
kein Pin: die Integritaet des Releases haengt genau daran, dass die Bytes
festgenagelt sind.

Beispiel:

  vp-ota manifest \
    --release edge-2026.08.0 --seq 12 --commit 3bf8c03 \
    --artifact core=git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:… \
    --artifact nodered=git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:… \
    --min-from-seq 9 --state-schema 3 --key-id rel-2026-a \
    --out release.json

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *release == "" || *seq == 0 || *commit == "" || *keyID == "" || len(artifacts) == 0 {
		fs.Usage()
		return errors.New("--release, --seq, --commit, --key-id und mindestens ein --artifact sind Pflicht")
	}
	if len(backends) == 0 {
		backends = stringList{otaverify.BackendCompose}
	}
	if *validUntil != "" {
		if _, err := time.Parse(time.RFC3339, *validUntil); err != nil {
			return fmt.Errorf("--valid-until ist kein RFC-3339-Zeitpunkt: %w", err)
		}
	}

	m := otaverify.Manifest{
		SchemaVersion:  otaverify.ManifestSchemaVersion,
		Release:        *release,
		ReleaseSeq:     *seq,
		TargetCommit:   strings.ToLower(strings.TrimSpace(*commit)),
		MinFromSeq:     *minFrom,
		AllowDowngrade: *allowDowngrade,
		ValidUntil:     *validUntil,
		StateSchema:    *stateSchema,
		Compat:         otaverify.Compat{Backends: backends},
		SigningKeyID:   *keyID,
		Notes:          *notes,
		Urgent:         *urgent,
	}
	for _, a := range artifacts {
		name, ref, ok := strings.Cut(a, "=")
		if !ok {
			return fmt.Errorf("--artifact %q: erwartet wird name=ref", a)
		}
		m.Artifacts = append(m.Artifacts, otaverify.Artifact{
			Type: otaverify.ArtifactOCIImage,
			Name: strings.TrimSpace(name),
			Ref:  strings.TrimSpace(ref),
		})
	}

	raw, err := marshalDoc(m)
	if err != nil {
		return err
	}
	// Gegenprobe mit dem echten Parser des Geraets - was hier rausgeht, muss
	// dort einlesbar sein.
	if _, err := otaverify.ParseManifest(raw); err != nil {
		return fmt.Errorf("erzeugtes Manifest ist ungueltig: %w", err)
	}
	if err := os.WriteFile(*out, raw, 0o644); err != nil {
		return err
	}
	fmt.Printf("Unsigniertes Manifest geschrieben: %s\n", *out)
	fmt.Printf("Jetzt out-of-band signieren:\n")
	fmt.Printf("  vp-ota sign --key <release>.key --domain %s --in %s\n", otaverify.DomainRelease, *out)
	return nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	root := fs.String("root", "baked", "Wurzel: 'baked' (die eingebackene aus rootkeys.json) oder ein Pfad zu rootkeys.json / <root>.pub")
	trustSet := fs.String("trust-set", "trust-set.json", "Trust-Set (die .sig daneben wird automatisch gesucht)")
	manifest := fs.String("manifest", "release.json", "Release-Manifest (die .sig daneben wird automatisch gesucht)")
	backend := fs.String("backend", otaverify.BackendCompose, "Apply-Backend, gegen das geprueft wird")
	running := fs.String("running-version", "", "die auf dem Zielgeraet eingestempelte Build-Version")
	currentSeq := fs.Int64("current-seq", -1, "release_seq des laufenden Stands (-1 = unbekannt)")
	noClock := fs.Bool("no-clock", false, "so pruefen, als haette das Geraet keine vertrauenswuerdige Uhr")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota verify - die vollstaendige Kette pruefen

  gebackene Wurzel -> root-signiertes Trust-Set -> Release-Manifest

Genau diese Pruefung laeuft auch auf dem Geraet (internal/otaverify) - hier
ist sie vorgezogen, damit ein Fehler VOR der Auslieferung auffaellt.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	roots, err := loadRoots(*root)
	if err != nil {
		return err
	}
	tsRaw, tsSig, err := readWithSig(*trustSet)
	if err != nil {
		return err
	}
	mRaw, mSig, err := readWithSig(*manifest)
	if err != nil {
		return err
	}

	in := otaverify.Input{
		Roots:          roots,
		TrustSet:       tsRaw,
		TrustSetSig:    tsSig,
		Manifest:       mRaw,
		ManifestSig:    mSig,
		Backend:        *backend,
		RunningVersion: *running,
	}
	if !*noClock {
		in.Now = time.Now()
	}
	if *currentSeq >= 0 {
		in.CurrentSeq = currentSeq
	}

	v := otaverify.Verify(in)
	fmt.Printf("Urteil:  %s\n", v.Outcome)
	fmt.Printf("Grund:   %s\n", v.Reason)
	if v.Manifest != nil {
		fmt.Printf("Release: %s (Stand %d), Commit %s\n", v.Manifest.Release, v.Manifest.ReleaseSeq, v.Manifest.TargetCommit)
		fmt.Printf("Signiert von: %s\n", v.SignedBy)
		for _, a := range v.Manifest.Artifacts {
			fmt.Printf("  %-8s %s\n", a.Name, a.Ref)
		}
	}
	for _, n := range v.Notes {
		fmt.Printf("Hinweis: %s\n", n)
	}
	if !v.OK() {
		return fmt.Errorf("Pruefung nicht bestanden (%s)", v.Outcome)
	}
	return nil
}

// loadRoots akzeptiert die eingebackene Wurzel, eine rootkeys.json oder eine
// einzelne .pub-Datei - damit laesst sich sowohl „traut das Image dem?" als
// auch „traut DIESE Wurzel dem?" pruefen.
func loadRoots(spec string) (*otaverify.KeySet, error) {
	if spec == "baked" {
		ks, err := otaverify.BakedRoots()
		if err != nil {
			return nil, err
		}
		if len(ks.Keys) == 0 {
			return nil, errors.New("in dieses Repo ist noch keine Wurzel eingebacken " +
				"(otaverify/rootkeys.json ist leer) - mit --root <root>.pub gegen eine konkrete Wurzel pruefen")
		}
		return ks, nil
	}
	raw, err := os.ReadFile(spec)
	if err != nil {
		return nil, err
	}
	if ks, err := otaverify.ParseKeySet(raw); err == nil && len(ks.Keys) > 0 {
		return ks, nil
	}
	var pf PublicKeyFile
	if err := readJSONFile(spec, &pf); err != nil {
		return nil, fmt.Errorf("%s ist weder ein Schluessel-Set noch ein Oeffentlicherschluessel: %w", spec, err)
	}
	return otaverify.ParseKeySet([]byte(fmt.Sprintf(
		`{"schema_version":%q,"keys":[{"key_id":%q,"alg":%q,"public_key":%q}]}`,
		otaverify.SignatureSchemaVersion, pf.KeyID, pf.Alg, pf.PublicKey)))
}

func readWithSig(path string) (doc, sig []byte, err error) {
	if doc, err = os.ReadFile(path); err != nil {
		return nil, nil, err
	}
	if sig, err = os.ReadFile(path + ".sig"); err != nil {
		return nil, nil, fmt.Errorf("Signaturdatei %s.sig: %w", path, err)
	}
	return doc, sig, nil
}
