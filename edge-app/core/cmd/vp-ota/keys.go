package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// PrivateKeyFile ist die Datei mit dem GEHEIMEN Schluessel.
//
// Gespeichert wird der 32-Byte-Ed25519-SEED, nicht der expandierte 64-Byte-
// Wert: der Seed ist die eigentliche Geheimnis-Menge, und ein zweites Format
// fuer dieselbe Sache waere nur eine Verwechslungsgelegenheit. Der oeffentliche
// Teil reist mit, damit ein Signierlauf nie den falschen .pub danebenlegt.
type PrivateKeyFile struct {
	SchemaVersion string `json:"schema_version"`
	KeyID         string `json:"key_id"`
	Alg           string `json:"alg"`
	Role          string `json:"role"`
	PrivateKey    string `json:"private_key"`
	PublicKey     string `json:"public_key"`
	CreatedAt     string `json:"created_at"`
}

// PublicKeyFile ist der veroeffentlichbare Teil - er DARF ueberall liegen.
type PublicKeyFile struct {
	SchemaVersion string `json:"schema_version"`
	KeyID         string `json:"key_id"`
	Alg           string `json:"alg"`
	Role          string `json:"role"`
	PublicKey     string `json:"public_key"`
	NotAfter      string `json:"not_after,omitempty"`
	Comment       string `json:"comment,omitempty"`
	CreatedAt     string `json:"created_at"`
}

const (
	roleRoot    = "root"
	roleRelease = "release"
)

func cmdKeygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	id := fs.String("id", "", "Schluessel-Kennung, z. B. root-2026-a oder rel-2026-a (Pflicht)")
	role := fs.String("role", "", "root | release (Pflicht)")
	out := fs.String("out", ".", "Zielverzeichnis")
	notAfter := fs.String("not-after", "", "optionales Ablaufdatum des Schluessels (RFC 3339), nur sinnvoll fuer Release-Schluessel")
	comment := fs.String("comment", "", "optionale Notiz, die im Trust-Set mitreist")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota keygen - Ed25519-Schluesselpaar erzeugen

Schreibt <id>.key (GEHEIM, 0600) und <id>.pub (veroeffentlichbar).
Ein bereits vorhandener .key wird NIE ueberschrieben.

  --role root     Die kalte Wurzel. Gehoert auf einen Offline-Datentraeger,
                  niemals auf CI und niemals in dieses Repo. Sie signiert
                  ausschliesslich Trust-Sets.
  --role release  Der Schluessel, der die taeglichen Releases signiert.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *id == "" || *role == "" {
		fs.Usage()
		return errors.New("--id und --role sind Pflicht")
	}
	if *role != roleRoot && *role != roleRelease {
		return fmt.Errorf("--role muss %s oder %s sein", roleRoot, roleRelease)
	}
	if *notAfter != "" {
		if _, err := time.Parse(time.RFC3339, *notAfter); err != nil {
			return fmt.Errorf("--not-after ist kein RFC-3339-Zeitpunkt: %w", err)
		}
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("Schluesselerzeugung fehlgeschlagen: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	keyPath := filepath.Join(*out, *id+".key")
	pubPath := filepath.Join(*out, *id+".pub")
	// Ein vorhandener geheimer Schluessel wird nie ueberschrieben: das waere
	// der eine Bedienfehler, der eine Wurzel unwiederbringlich vernichtet.
	if _, err := os.Stat(keyPath); err == nil {
		return fmt.Errorf("%s existiert bereits - es wird nichts ueberschrieben", keyPath)
	}
	if err := os.MkdirAll(*out, 0o700); err != nil {
		return err
	}

	privFile := PrivateKeyFile{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		KeyID:         *id,
		Alg:           otaverify.AlgEd25519,
		Role:          *role,
		PrivateKey:    base64.StdEncoding.EncodeToString(priv.Seed()),
		PublicKey:     pubB64,
		CreatedAt:     now,
	}
	if err := writeJSONFile(keyPath, privFile, 0o600); err != nil {
		return err
	}
	pubFile := PublicKeyFile{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		KeyID:         *id,
		Alg:           otaverify.AlgEd25519,
		Role:          *role,
		PublicKey:     pubB64,
		NotAfter:      *notAfter,
		Comment:       *comment,
		CreatedAt:     now,
	}
	if err := writeJSONFile(pubPath, pubFile, 0o644); err != nil {
		return err
	}

	fmt.Printf("Schluessel %s (%s) erzeugt:\n", *id, *role)
	fmt.Printf("  GEHEIM        %s   (0600 - niemals kopieren, niemals committen)\n", keyPath)
	fmt.Printf("  oeffentlich   %s\n", pubPath)
	fmt.Printf("  public_key    %s\n", pubB64)
	if *role == roleRoot {
		fmt.Println()
		fmt.Println("Naechster Schritt: den oeffentlichen Teil in")
		fmt.Println("  edge-app/core/internal/otaverify/rootkeys.json")
		fmt.Println("eintragen und committen - erst dadurch backt ein Image diese Wurzel ein.")
	}
	return nil
}

func cmdTrustSet(args []string) error {
	fs := flag.NewFlagSet("trust-set", flag.ExitOnError)
	var keys stringList
	fs.Var(&keys, "key", "Pfad zu einer .pub-Datei eines RELEASE-Schluessels (mehrfach angebbar)")
	out := fs.String("out", "trust-set.json", "Zieldatei")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota trust-set - die Menge gueltiger Release-Schluessel bauen

Das Ergebnis ist erst gueltig, wenn es MIT DER KALTEN WURZEL signiert wird:

  vp-ota sign --key root-2026-a.key --domain trust-set --in trust-set.json

WIDERRUF laeuft genau hier: ein neues Set OHNE den betroffenen Schluessel,
frisch root-signiert. Das wirkt unabhaengig von der Uhr des Geraets - anders
als ein Ablaufdatum, das nur so gut ist wie die Zeit auf der Box.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if len(keys) == 0 {
		fs.Usage()
		return errors.New("mindestens ein --key ist Pflicht")
	}

	ks := otaverify.KeySet{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	for _, p := range keys {
		var pf PublicKeyFile
		if err := readJSONFile(p, &pf); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		if pf.Role == roleRoot {
			// Die Wurzel gehoert NICHT ins Trust-Set: sie ist eingebacken und
			// unveraenderlich. Stuende sie hier, koennte ein Trust-Set die
			// Wurzel erweitern - genau die Vertrauensuebernahme, gegen die die
			// Trennung kalt/heiss gebaut ist.
			return fmt.Errorf("%s ist ein ROOT-Schluessel - er gehoert in rootkeys.json, nicht ins Trust-Set", p)
		}
		ks.Keys = append(ks.Keys, otaverify.PublicKey{
			KeyID:     pf.KeyID,
			Alg:       pf.Alg,
			PublicKey: pf.PublicKey,
			NotAfter:  pf.NotAfter,
			Comment:   pf.Comment,
		})
	}
	raw, err := marshalDoc(ks)
	if err != nil {
		return err
	}
	// Gegenprobe mit dem echten Parser des Geraets: was hier rausgeht, muss
	// dort einlesbar sein - sonst faellt es erst auf der Box auf.
	if _, err := otaverify.ParseKeySet(raw); err != nil {
		return fmt.Errorf("erzeugtes Trust-Set ist ungueltig: %w", err)
	}
	if err := os.WriteFile(*out, raw, 0o644); err != nil {
		return err
	}
	fmt.Printf("Trust-Set mit %d Schluessel(n) geschrieben: %s\n", len(ks.Keys), *out)
	fmt.Printf("Jetzt mit der kalten Wurzel signieren:\n")
	fmt.Printf("  vp-ota sign --key <root>.key --domain %s --in %s\n", otaverify.DomainTrustSet, *out)
	return nil
}

func cmdSign(args []string) error {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	keyPath := fs.String("key", "", "Pfad zur GEHEIMEN Schluesseldatei (.key) (Pflicht)")
	domain := fs.String("domain", "", "release | trust-set (Pflicht)")
	in := fs.String("in", "", "zu signierende Datei (Pflicht)")
	out := fs.String("out", "", "Zieldatei der Signatur (Vorgabe: <in>.sig)")
	portal := fs.String("portal", defaultPortal, "Portal-Basis-URL fuer den gedruckten Register-Eintrag")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota sign - abgetrennte Signatur erzeugen

Signiert werden die EXAKTEN BYTES der Eingabedatei, praefixiert mit dem
Domain-Kontext. Die Datei wird dabei NIE neu serialisiert - genau deshalb
liegt die Signatur daneben und nicht darin.

Nach dem Signieren eines Releases wird der fertige Register-Eintrag samt
curl-Befehl ausgegeben (die Registrierung macht der Owner, nicht CI).

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" || *domain == "" || *in == "" {
		fs.Usage()
		return errors.New("--key, --domain und --in sind Pflicht")
	}
	if *domain != otaverify.DomainRelease && *domain != otaverify.DomainTrustSet {
		return fmt.Errorf("--domain muss %s oder %s sein", otaverify.DomainRelease, otaverify.DomainTrustSet)
	}

	var pk PrivateKeyFile
	if err := readJSONFile(*keyPath, &pk); err != nil {
		return fmt.Errorf("%s: %w", *keyPath, err)
	}
	if pk.Alg != otaverify.AlgEd25519 {
		return fmt.Errorf("%s: nur %s wird unterstuetzt", *keyPath, otaverify.AlgEd25519)
	}
	// Rollen-Disziplin, im Werkzeug erzwungen statt nur dokumentiert: die
	// Wurzel signiert NUR Trust-Sets, der Release-Schluessel NUR Manifeste.
	switch {
	case *domain == otaverify.DomainTrustSet && pk.Role != roleRoot:
		return fmt.Errorf("ein Trust-Set wird mit der kalten WURZEL signiert, %s hat die Rolle %q", *keyPath, pk.Role)
	case *domain == otaverify.DomainRelease && pk.Role != roleRelease:
		return fmt.Errorf("ein Release wird mit einem RELEASE-Schluessel signiert, %s hat die Rolle %q", *keyPath, pk.Role)
	}
	seed, err := base64.StdEncoding.DecodeString(pk.PrivateKey)
	if err != nil || len(seed) != ed25519.SeedSize {
		return fmt.Errorf("%s: private_key ist kein %d-Byte-Seed", *keyPath, ed25519.SeedSize)
	}
	priv := ed25519.NewKeyFromSeed(seed)

	doc, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	// Vor dem Signieren pruefen, dass das Dokument die vertraglich vorgesehene
	// Form hat: eine Signatur ueber Unsinn ist gueltiger Unsinn.
	var manifest *otaverify.Manifest
	if *domain == otaverify.DomainRelease {
		manifest, err = otaverify.ParseManifest(doc)
		if err != nil {
			return fmt.Errorf("%s ist kein gueltiges Release-Manifest: %w", *in, err)
		}
		if manifest.SigningKeyID != pk.KeyID {
			return fmt.Errorf("das Manifest nennt signing_key_id %q, signiert wuerde aber mit %q",
				manifest.SigningKeyID, pk.KeyID)
		}
	} else if _, err := otaverify.ParseKeySet(doc); err != nil {
		return fmt.Errorf("%s ist kein gueltiges Trust-Set: %w", *in, err)
	}

	input, err := otaverify.SigningInput(*domain, doc)
	if err != nil {
		return err
	}
	sig := otaverify.Signature{
		SchemaVersion: otaverify.SignatureSchemaVersion,
		Alg:           otaverify.AlgEd25519,
		KeyID:         pk.KeyID,
		Domain:        *domain,
		Signature:     base64.StdEncoding.EncodeToString(ed25519.Sign(priv, input)),
		SignedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	sigPath := *out
	if sigPath == "" {
		sigPath = *in + ".sig"
	}
	raw, err := marshalDoc(sig)
	if err != nil {
		return err
	}
	if err := os.WriteFile(sigPath, raw, 0o644); err != nil {
		return err
	}
	fmt.Printf("Signiert (%s, Schluessel %s): %s\n", *domain, pk.KeyID, sigPath)

	if manifest != nil {
		fmt.Println()
		if err := emitRegister(manifest, doc, raw, *in, *portal); err != nil {
			return err
		}
	}
	return nil
}

// --- kleine Helfer -----------------------------------------------------------

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// marshalDoc erzeugt die kanonische Dateiform: eingerueckt, mit genau einem
// abschliessenden Zeilenumbruch. Die so entstehenden Bytes SIND das signierte
// Dokument - wer sie danach umformatiert, zerstoert die Signatur.
func marshalDoc(v any) ([]byte, error) {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func writeJSONFile(path string, v any, perm os.FileMode) error {
	raw, err := marshalDoc(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, perm)
}

func readJSONFile(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}
