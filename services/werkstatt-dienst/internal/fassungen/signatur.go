package fassungen

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Die Domain-Kontexte, mit denen jede Signatur praefixiert wird - identisch
// zu otaverify.DomainRelease/DomainTrustSet im Core (edge-app/core/internal/otaverify/trust.go),
// denn hier werden exakt dieselben Dateien mit demselben Schema geprueft.
// Eine Abweichung hier wuerde diese Pruefung leise von der der Box trennen,
// statt beide an denselben Bytes und Schluesseln zu messen.
const (
	DomainRelease  = "release"
	DomainTrustSet = "trust-set"

	kontextRelease  = "voltpilot-ota-release-v1\n"
	kontextTrustSet = "voltpilot-ota-trust-set-v1\n"
)

const algEd25519 = "ed25519"

// PublicKey ist ein Eintrag im Vertrauens-Set bzw. in der eingebackenen
// Wurzel - dieselbe Form wie otaverify.PublicKey im Core.
type PublicKey struct {
	KeyID     string `json:"key_id"`
	Alg       string `json:"alg"`
	PublicKey string `json:"public_key"`
	NotAfter  string `json:"not_after,omitempty"`
	Comment   string `json:"comment,omitempty"`
}

// KeySet ist ein Vertrauens-Set ODER die eingebackene Wurzel.
type KeySet struct {
	SchemaVersion string      `json:"schema_version"`
	Keys          []PublicKey `json:"keys"`
}

//go:embed rootkeys.json
var eingebackeneWurzel []byte

// GebackeneWurzel liefert die im Dienst eingebackene Vertrauenswurzel -
// dieselbe wie im Core (edge-app/core/internal/otaverify/rootkeys.json).
// TestRootkeysBleibenSynchronMitDemCore haelt beide Kopien synchron: eine
// Rotation, die hier vergessen wird, laesst den Test rot werden statt die
// Werkstatt leise mit der alten Wurzel weiterlaufen zu lassen.
func GebackeneWurzel() (*KeySet, error) {
	return parseKeySet(eingebackeneWurzel)
}

func parseKeySet(raw []byte) (*KeySet, error) {
	var ks KeySet
	if err := json.Unmarshal(raw, &ks); err != nil {
		return nil, fmt.Errorf("Schluessel-Set ist kein gueltiges JSON: %w", err)
	}
	if len(ks.Keys) == 0 {
		return nil, errors.New("Schluessel-Set hat keine Schluessel")
	}
	for i, k := range ks.Keys {
		if k.KeyID == "" {
			return nil, fmt.Errorf("keys[%d]: key_id fehlt", i)
		}
		if k.Alg != algEd25519 {
			return nil, fmt.Errorf("keys[%d] (%s): nur %s wird unterstuetzt, nicht %q", i, k.KeyID, algEd25519, k.Alg)
		}
		if _, err := dekodiereSchluessel(k.PublicKey); err != nil {
			return nil, fmt.Errorf("keys[%d] (%s): %w", i, k.KeyID, err)
		}
	}
	return &ks, nil
}

// finde sucht einen Schluessel und prueft sein Ablaufdatum gegen die
// tatsaechliche Uhr - der Dienst laeuft auf einem Server, nicht auf einer
// Box ohne RTC, eine vertrauenswuerdige Uhr ist also immer da.
func (ks *KeySet) finde(keyID string) (ed25519.PublicKey, error) {
	for _, k := range ks.Keys {
		if k.KeyID != keyID {
			continue
		}
		if k.NotAfter != "" {
			exp, err := time.Parse(time.RFC3339, k.NotAfter)
			if err != nil {
				return nil, fmt.Errorf("Schluessel %q hat ein unlesbares Ablaufdatum", keyID)
			}
			if time.Now().After(exp) {
				return nil, fmt.Errorf("Schluessel %q ist seit %s abgelaufen", keyID, k.NotAfter)
			}
		}
		return dekodiereSchluessel(k.PublicKey)
	}
	return nil, fmt.Errorf("Schluessel %q steht nicht im Vertrauens-Set", keyID)
}

func dekodiereSchluessel(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errors.New("public_key ist kein gueltiges Base64")
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public_key hat %d statt %d Bytes", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

// signaturDatei ist eine abgetrennte Signatur (release.json.sig / trust-set.json.sig).
type signaturDatei struct {
	Alg       string `json:"alg"`
	KeyID     string `json:"key_id"`
	Domain    string `json:"domain"`
	Signature string `json:"signature"`
}

func parseSignatur(raw []byte, erwarteteDomain string) (*signaturDatei, error) {
	var s signaturDatei
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("Signaturdatei ist kein gueltiges JSON: %w", err)
	}
	if s.Alg != algEd25519 {
		return nil, fmt.Errorf("Signaturalgorithmus %q wird nicht akzeptiert - nur %s", s.Alg, algEd25519)
	}
	if s.KeyID == "" {
		return nil, errors.New("Signaturdatei ohne key_id")
	}
	if s.Domain != erwarteteDomain {
		return nil, fmt.Errorf("Signatur ist fuer %q ausgestellt, geprueft wird aber %q", s.Domain, erwarteteDomain)
	}
	if _, err := dekodiereSignatur(s.Signature); err != nil {
		return nil, err
	}
	return &s, nil
}

func dekodiereSignatur(b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, errors.New("signature ist kein gueltiges Base64")
	}
	if len(raw) != ed25519.SignatureSize {
		return nil, fmt.Errorf("signature hat %d statt %d Bytes", len(raw), ed25519.SignatureSize)
	}
	return raw, nil
}

// SigningInput sind die Bytes, ueber die tatsaechlich gerechnet wird:
// `context || dokument_bytes`, mit dem Dokument byte fuer byte unveraendert -
// identisch zu otaverify.SigningInput im Core, damit eine mit vp-ota sign
// erzeugte Signatur hier wie dort prueft.
func SigningInput(domain string, doc []byte) ([]byte, error) {
	var ctx string
	switch domain {
	case DomainRelease:
		ctx = kontextRelease
	case DomainTrustSet:
		ctx = kontextTrustSet
	default:
		return nil, fmt.Errorf("unbekannte Signatur-Domain %q", domain)
	}
	out := make([]byte, 0, len(ctx)+len(doc))
	out = append(out, ctx...)
	out = append(out, doc...)
	return out, nil
}

func verifyBytes(pub ed25519.PublicKey, domain string, doc []byte, sig *signaturDatei) error {
	input, err := SigningInput(domain, doc)
	if err != nil {
		return err
	}
	raw, err := dekodiereSignatur(sig.Signature)
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, input, raw) {
		return fmt.Errorf("Signatur passt nicht zu den Bytes (Schluessel %q)", sig.KeyID)
	}
	return nil
}

// Wurzel gibt die Vertrauenswurzel dieser Ablage zurueck: die eingebackene
// Produktionswurzel, oder - nur in Tests - die ueber das Feld Wurzel
// gesetzte Wegwerf-Wurzel (attrappe.NeueSignierteWurzel), weil der echte
// private Schluessel von root-2026-a nirgendwo im Repo steht.
func (a *Ablage) wurzel() (*KeySet, error) {
	if a.Wurzel != nil {
		return a.Wurzel, nil
	}
	return GebackeneWurzel()
}

// PruefeSignatur prueft die Signaturkette eines Release-Manifests GENAUSO
// wie die Box bei einem Update (Paket otaverify im Core, docs/ota-signing.md):
// eingebackene Wurzel -> root-signiertes Vertrauens-Set -> Release-
// Schluessel -> Manifest-Signatur. Sie laeuft auf den ROHEN Bytes, vor jedem
// Parsen (PruefeManifest) - ein manipuliertes Manifest erreicht den Parser
// nie. Nur bei bestandener Pruefung liefert sie den Schluessel, mit dem
// signiert wurde; sonst einen Grund, warum die Mango unveraendert bleibt.
func (a *Ablage) PruefeSignatur(trustSet, trustSetSig, manifest, manifestSig []byte) (signiertVon string, err error) {
	wurzel, err := a.wurzel()
	if err != nil {
		return "", err
	}
	if len(trustSet) == 0 || len(trustSetSig) == 0 {
		return "", errors.New("das Vertrauens-Set oder seine Signatur fehlt")
	}
	tsSig, err := parseSignatur(trustSetSig, DomainTrustSet)
	if err != nil {
		return "", fmt.Errorf("Signatur des Vertrauens-Sets unbrauchbar: %w", err)
	}
	rootKey, err := wurzel.finde(tsSig.KeyID)
	if err != nil {
		return "", fmt.Errorf("Vertrauens-Set: %w", err)
	}
	if err := verifyBytes(rootKey, DomainTrustSet, trustSet, tsSig); err != nil {
		return "", fmt.Errorf("Vertrauens-Set ist nicht gueltig root-signiert: %w", err)
	}
	trust, err := parseKeySet(trustSet)
	if err != nil {
		return "", fmt.Errorf("Vertrauens-Set ist fehlerhaft: %w", err)
	}

	if len(manifest) == 0 || len(manifestSig) == 0 {
		return "", errors.New("das Release-Manifest oder seine Signatur fehlt")
	}
	mSig, err := parseSignatur(manifestSig, DomainRelease)
	if err != nil {
		return "", fmt.Errorf("Signatur des Release-Manifests unbrauchbar: %w", err)
	}
	relKey, err := trust.finde(mSig.KeyID)
	if err != nil {
		return "", fmt.Errorf("Release-Manifest: %w", err)
	}
	if err := verifyBytes(relKey, DomainRelease, manifest, mSig); err != nil {
		return "", fmt.Errorf("Release-Manifest ist nicht gueltig signiert: %w", err)
	}
	return mSig.KeyID, nil
}
