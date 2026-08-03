package otaverify

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Die Domain-Kontexte, mit denen jede Signatur praefixiert wird.
//
// Gerechnet wird immer ueber `context || dokument_bytes`. Ohne diese Trennung
// waeren beide Dokumente nur „irgendein JSON, mit Ed25519 signiert" - ein
// root-signiertes Trust-Set liesse sich dann als Manifest wiedereinspielen
// (und umgekehrt), sobald je ein Schluessel fuer beides benutzt wuerde. Die
// Trennung kostet nichts und macht diesen Fehler unmoeglich, statt sich auf
// die Disziplin zu verlassen, Schluessel nie doppelt zu verwenden.
const (
	DomainRelease  = "release"
	DomainTrustSet = "trust-set"

	contextRelease  = "voltpilot-ota-release-v1\n"
	contextTrustSet = "voltpilot-ota-trust-set-v1\n"
)

// SignatureSchemaVersion ist die Formatversion der .sig-Dateien.
const SignatureSchemaVersion = "1.0"

// Signature ist eine abgetrennte Signatur (release.json.sig / trust-set.json.sig).
type Signature struct {
	SchemaVersion string `json:"schema_version"`
	Alg           string `json:"alg"`
	KeyID         string `json:"key_id"`
	Domain        string `json:"domain"`
	Signature     string `json:"signature"`
	SignedAt      string `json:"signed_at,omitempty"`
}

// PublicKey ist ein Eintrag im Trust-Set bzw. im gebackenen Root-Set.
type PublicKey struct {
	KeyID     string `json:"key_id"`
	Alg       string `json:"alg"`
	PublicKey string `json:"public_key"`
	NotAfter  string `json:"not_after,omitempty"`
	Comment   string `json:"comment,omitempty"`
}

// KeySet ist ein Trust-Set ODER das gebackene Root-Set - dieselbe Form, zwei
// Rollen: das Root-Set ist im Image eingebacken und unveraenderlich, das
// Trust-Set liegt auf dem Geraet und gilt NUR mit gueltiger Root-Signatur.
type KeySet struct {
	SchemaVersion string      `json:"schema_version"`
	GeneratedAt   string      `json:"generated_at,omitempty"`
	Keys          []PublicKey `json:"keys"`
}

//go:embed rootkeys.json
var bakedRootKeys []byte

// BakedRoots liefert die im Image eingebackene Vertrauenswurzel.
//
// Sie steht im Git und ist damit nachlesbar - ein oeffentlicher Schluessel
// DARF oeffentlich sein, und genau dadurch ist ueberpruefbar, welcher Wurzel
// ein Image traut. Ein LEERES Set ist der Auslieferungszustand, solange die
// Zeremonie (docs/ota-signing.md) nicht gelaufen ist; dann schlaegt jede
// Pruefung fehl - fail-closed, nie ein stilles „ohne Wurzel ist alles gut".
func BakedRoots() (*KeySet, error) {
	return ParseKeySet(bakedRootKeys)
}

// ParseKeySet liest ein Schluessel-Set und prueft seine Struktur.
func ParseKeySet(raw []byte) (*KeySet, error) {
	var ks KeySet
	if err := json.Unmarshal(raw, &ks); err != nil {
		return nil, fmt.Errorf("Schluessel-Set ist kein gueltiges JSON: %w", err)
	}
	if err := checkMajor(ks.SchemaVersion, SignatureSchemaVersion); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for i, k := range ks.Keys {
		if !keyIDRe.MatchString(k.KeyID) {
			return nil, fmt.Errorf("keys[%d]: ungueltige key_id '%s'", i, k.KeyID)
		}
		if seen[k.KeyID] {
			return nil, fmt.Errorf("keys: key_id '%s' kommt doppelt vor", k.KeyID)
		}
		seen[k.KeyID] = true
		if k.Alg != AlgEd25519 {
			return nil, fmt.Errorf("keys[%d] (%s): nur %s wird unterstuetzt, nicht '%s'", i, k.KeyID, AlgEd25519, k.Alg)
		}
		if _, err := decodeKey(k.PublicKey); err != nil {
			return nil, fmt.Errorf("keys[%d] (%s): %w", i, k.KeyID, err)
		}
		if k.NotAfter != "" {
			if _, err := parseTime(k.NotAfter); err != nil {
				return nil, fmt.Errorf("keys[%d] (%s): not_after '%s' ist kein RFC-3339-Zeitpunkt", i, k.KeyID, k.NotAfter)
			}
		}
	}
	return &ks, nil
}

// find sucht einen Schluessel und prueft sein Ablaufdatum.
//
// Ehrliche Grenze, im Kontrakt dokumentiert: mit einer nicht vertrauenswuerdigen
// Geraeteuhr (Pi ohne RTC) ist Ablauf best effort. Der belastbare Widerruf ist
// ein NEUES, root-signiertes Trust-Set ohne den Schluessel - das wirkt
// uhrunabhaengig. `now` als Nullwert schaltet die Ablaufpruefung aus.
func (ks *KeySet) find(keyID string, now time.Time) (ed25519.PublicKey, error) {
	for _, k := range ks.Keys {
		if k.KeyID != keyID {
			continue
		}
		if k.NotAfter != "" && !now.IsZero() {
			exp, err := parseTime(k.NotAfter)
			if err != nil {
				return nil, fmt.Errorf("Schluessel '%s' hat ein unlesbares Ablaufdatum", keyID)
			}
			if now.After(exp) {
				return nil, fmt.Errorf("Schluessel '%s' ist seit %s abgelaufen", keyID, k.NotAfter)
			}
		}
		return decodeKey(k.PublicKey)
	}
	return nil, fmt.Errorf("Schluessel '%s' steht nicht im Vertrauens-Set", keyID)
}

// ParseSignature liest eine abgetrennte Signatur und prueft ihre Struktur.
//
// `expectDomain` ist der Zweck, den der AUFRUFER gerade prueft - er wird nie
// aus der Datei uebernommen, sondern nur gegen sie gehalten. Anders herum
// duerfte ein Angreifer den Verwendungszweck selbst waehlen.
func ParseSignature(raw []byte, expectDomain string) (*Signature, error) {
	var s Signature
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("Signaturdatei ist kein gueltiges JSON: %w", err)
	}
	if err := checkMajor(s.SchemaVersion, SignatureSchemaVersion); err != nil {
		return nil, err
	}
	if s.Alg != AlgEd25519 {
		return nil, fmt.Errorf("Signaturalgorithmus '%s' wird nicht akzeptiert - nur %s", s.Alg, AlgEd25519)
	}
	if !keyIDRe.MatchString(s.KeyID) {
		return nil, fmt.Errorf("ungueltige key_id '%s' in der Signaturdatei", s.KeyID)
	}
	if s.Domain != expectDomain {
		return nil, fmt.Errorf("Signatur ist fuer '%s' ausgestellt, geprueft wird aber '%s'", s.Domain, expectDomain)
	}
	if _, err := decodeSig(s.Signature); err != nil {
		return nil, err
	}
	return &s, nil
}

// SigningInput sind die Bytes, ueber die tatsaechlich gerechnet wird:
// `context || dokument_bytes`, mit dem Dokument BYTE FUER BYTE unveraendert.
//
// Diese Funktion ist die EINE Stelle, an der die zu signierenden Bytes
// entstehen - Signierwerkzeug und Geraet rufen dieselbe Funktion auf, damit
// die beiden Seiten nicht auseinanderlaufen koennen.
func SigningInput(domain string, doc []byte) ([]byte, error) {
	var ctx string
	switch domain {
	case DomainRelease:
		ctx = contextRelease
	case DomainTrustSet:
		ctx = contextTrustSet
	default:
		return nil, fmt.Errorf("unbekannte Signatur-Domain '%s'", domain)
	}
	out := make([]byte, 0, len(ctx)+len(doc))
	out = append(out, ctx...)
	out = append(out, doc...)
	return out, nil
}

// VerifyBytes prueft EINE abgetrennte Signatur ueber die exakten Dokument-Bytes.
func VerifyBytes(pub ed25519.PublicKey, domain string, doc []byte, sig *Signature) error {
	input, err := SigningInput(domain, doc)
	if err != nil {
		return err
	}
	raw, err := decodeSig(sig.Signature)
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, input, raw) {
		return fmt.Errorf("Signatur passt nicht zu den Bytes (Schluessel '%s')", sig.KeyID)
	}
	return nil
}

func decodeKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errors.New("public_key ist kein gueltiges Base64")
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public_key hat %d statt %d Bytes", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

func decodeSig(b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errors.New("signature ist kein gueltiges Base64")
	}
	if len(raw) != ed25519.SignatureSize {
		return nil, fmt.Errorf("signature hat %d statt %d Bytes", len(raw), ed25519.SignatureSize)
	}
	return raw, nil
}

func parseTime(s string) (time.Time, error) {
	return time.Parse(time.RFC3339, s)
}
