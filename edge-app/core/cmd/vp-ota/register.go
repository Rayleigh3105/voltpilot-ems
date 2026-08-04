package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const defaultPortal = "https://portal.voltpilot.de"

// registerBody ist der Rumpf fuer POST /api/v1/admin/edge-releases.
//
// Er traegt das Manifest als ROHE ZEICHENKETTE und die Signaturdatei daneben -
// exakt so, wie sie signiert wurden. Die api legt beides unveraendert ab
// (TEXT, nie jsonb: jsonb normalisiert Schluesselreihenfolge und Leerraum und
// wuerde die Signatur damit unpruefbar machen), damit Stufe 2 spaeter genau
// diese Bytes an das Geraet weiterreichen kann.
type registerBody struct {
	Version      string `json:"version"`
	ReleaseSeq   int64  `json:"releaseSeq"`
	TargetCommit string `json:"targetCommit"`
	Notes        string `json:"notes,omitempty"`
	Manifest     string `json:"manifest"`
	Signature    string `json:"signature"`
	SigningKeyID string `json:"signingKeyId"`
}

func cmdRegister(args []string) error {
	fs := flag.NewFlagSet("register", flag.ExitOnError)
	manifest := fs.String("manifest", "release.json", "das signierte Release-Manifest")
	sig := fs.String("sig", "", "die Signaturdatei (Vorgabe: <manifest>.sig)")
	portal := fs.String("portal", defaultPortal, "Portal-Basis-URL")
	out := fs.String("out", "", "Zieldatei fuer den Rumpf (Vorgabe: <manifest-verzeichnis>/register.json)")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota register - Register-Eintrag fuer das Portal vorbereiten

Schreibt den fertigen JSON-Rumpf und druckt den curl-Befehl. Abgeschickt wird
er vom OWNER mit seinem eigenen Portal-Admin-Token.

Das ist der HANDPFAD. Seit dem 04.08.2026 traegt ihn im Normalfall der
Tag-Lauf (docs/ota-signing.md §4) - mit einem Dienstkonto, das AUSSCHLIESSLICH
registrieren darf, nie mit einem Portal-Admin-Token. Der Handpfad bleibt
vollstaendig gueltig: der Forgejo-Runner schlaeft nachweislich ein, also darf
kein Wirkpfad auf ihn warten.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	sigPath := *sig
	if sigPath == "" {
		sigPath = *manifest + ".sig"
	}
	doc, err := os.ReadFile(*manifest)
	if err != nil {
		return err
	}
	sigRaw, err := os.ReadFile(sigPath)
	if err != nil {
		return err
	}
	m, err := otaverify.ParseManifest(doc)
	if err != nil {
		return fmt.Errorf("%s ist kein gueltiges Release-Manifest: %w", *manifest, err)
	}
	outPath := *out
	if outPath == "" {
		outPath = filepath.Join(filepath.Dir(*manifest), "register.json")
	}
	return writeRegister(m, doc, sigRaw, outPath, *portal)
}

// emitRegister ist der Anschluss aus `vp-ota sign`: unmittelbar nach dem
// Signieren liegt der Register-Eintrag bereit.
func emitRegister(m *otaverify.Manifest, doc, sigRaw []byte, manifestPath, portal string) error {
	return writeRegister(m, doc, sigRaw, filepath.Join(filepath.Dir(manifestPath), "register.json"), portal)
}

func writeRegister(m *otaverify.Manifest, doc, sigRaw []byte, outPath, portal string) error {
	if len(doc) == 0 || len(sigRaw) == 0 {
		return errors.New("Manifest oder Signatur ist leer")
	}
	// Die Signaturdatei muss zum Manifest passen - ein Eintrag mit fremder
	// Signatur waere im Register eine Luege, die niemand mehr bemerkt.
	s, err := otaverify.ParseSignature(sigRaw, otaverify.DomainRelease)
	if err != nil {
		return fmt.Errorf("Signaturdatei unbrauchbar: %w", err)
	}
	if s.KeyID != m.SigningKeyID {
		return fmt.Errorf("Signatur stammt von %q, das Manifest nennt aber %q", s.KeyID, m.SigningKeyID)
	}

	body := registerBody{
		Version:      m.Release,
		ReleaseSeq:   m.ReleaseSeq,
		TargetCommit: m.TargetCommit,
		Notes:        m.Notes,
		Manifest:     string(doc),
		Signature:    string(sigRaw),
		SigningKeyID: m.SigningKeyID,
	}
	raw, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, append(raw, '\n'), 0o644); err != nil {
		return err
	}

	fmt.Printf("Register-Eintrag vorbereitet: %s\n", outPath)
	fmt.Println()
	fmt.Println("1) Signiertes Manifest als Forgejo-Release-Asset anhaengen (Tag muss existieren):")
	fmt.Printf("   export FORGEJO_TOKEN=…\n")
	fmt.Printf("   REL=$(curl -sS -X POST %s/api/v1/repos/mamotec/voltpilot-ems/releases \\\n", forgejoBase)
	fmt.Printf("     -H \"Authorization: token $FORGEJO_TOKEN\" -H 'Content-Type: application/json' \\\n")
	fmt.Printf("     -d '{\"tag_name\":\"%s\",\"name\":\"%s\"}' | sed -E 's/.*\"id\":([0-9]+).*/\\1/')\n", m.Release, m.Release)
	fmt.Printf("   for f in release.json release.json.sig trust-set.json trust-set.json.sig; do \\\n")
	fmt.Printf("     curl -sS -X POST \"%s/api/v1/repos/mamotec/voltpilot-ems/releases/$REL/assets?name=$f\" \\\n", forgejoBase)
	fmt.Printf("       -H \"Authorization: token $FORGEJO_TOKEN\" -F \"attachment=@$f\"; done\n")
	fmt.Println()
	fmt.Println("2) Ins Release-Register des Portals eintragen (mit dem eigenen Portal-Admin-Token):")
	fmt.Printf("   curl -sS -X POST %s/api/v1/admin/edge-releases \\\n", portal)
	fmt.Printf("     -H \"Authorization: Bearer $VP_ADMIN_TOKEN\" -H 'Content-Type: application/json' \\\n")
	fmt.Printf("     --data-binary @%s\n", outPath)
	return nil
}

const forgejoBase = "https://git.tecmaxx.de"
