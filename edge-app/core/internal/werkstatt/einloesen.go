// Package werkstatt ist die Seite der Box beim Einlösen des Werkstatt-Codes
// (docs/contracts/werkstatt-einloesen-v1.md): der Befehl werkstatt-anmelden.
// Die Box schickt ihre Kennung, den Code, ihre Fassung, ihren Geräteschlüssel
// mit ihrer Zertifikatsanfrage, ihren Tunnel- und ihren Host-Schlüssel, alles
// signiert mit dem Geräteschlüssel. Zwilling in der API:
// services/api …/werkstatt/EinloesenVertrag.java; beide lesen
// docs/contracts/werkstatt-einloesen-vectors.json.
package werkstatt

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
)

// Schema ist die erste Zeile des signierten Textes.
const Schema = "vp-werkstatt-einloesen.v1"

// AntwortSchema steht in der Antwort der API.
const AntwortSchema = "vp-werkstatt-einloesung.v1"

// MaxCSR begrenzt die Zertifikatsanfrage wie die API.
const MaxCSR = 20480

var (
	codeMuster    = regexp.MustCompile(`^wk-[a-z2-7]{26}$`)
	hostMuster    = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
	fassungMuster = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]{0,63}$`)
	wgMuster      = regexp.MustCompile(`^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`)
)

// Anfrage ist der Rumpf von POST /api/v1/werkstatt/einloesen.
type Anfrage struct {
	EdgeRef             string `json:"edgeRef"`
	Code                string `json:"code"`
	Fassung             string `json:"fassung"`
	GeraeteSchluessel   string `json:"geraeteSchluessel"`
	WireguardSchluessel string `json:"wireguardSchluessel"`
	HostSchluessel      string `json:"hostSchluessel"`
	CsrPem              string `json:"csrPem"`
	Signatur            string `json:"signatur"`
}

// Kanonisch ist der signierte Text: Zeilen name=wert, jede mit \n, in fester
// Reihenfolge; die Zertifikatsanfrage als sha256 ihrer Bytes.
func Kanonisch(a Anfrage) string {
	csr := sha256.Sum256([]byte(a.CsrPem))
	return Schema + "\n" +
		"edge_ref=" + a.EdgeRef + "\n" +
		"code=" + a.Code + "\n" +
		"fassung=" + a.Fassung + "\n" +
		"geraete_schluessel=" + a.GeraeteSchluessel + "\n" +
		"wireguard_schluessel=" + a.WireguardSchluessel + "\n" +
		"host_schluessel=" + a.HostSchluessel + "\n" +
		"csr_sha256=" + hex.EncodeToString(csr[:]) + "\n"
}

// Formfehler nennt jedes Feld, das seine Form nicht hat (wie die API, die
// Kennung ohne die Signatur). Leer heißt: in Ordnung.
func Formfehler(a Anfrage) []string {
	var f []string
	if !agent.GueltigeKennung(a.EdgeRef) {
		f = append(f, "edgeRef: eine Kennung der Box mit gültigem Prüfzeichen (edge-…)")
	}
	if !codeMuster.MatchString(a.Code) {
		f = append(f, "code: Form wk- und 26 Zeichen")
	}
	if !fassungMuster.MatchString(a.Fassung) {
		f = append(f, "fassung: die Fassung des Programms auf der Box")
	}
	if _, err := Geraeteschluessel(a.GeraeteSchluessel); err != nil {
		f = append(f, "geraeteSchluessel: ein öffentlicher EC-P-256-Schlüssel (SubjectPublicKeyInfo, Base64)")
	}
	if !wgMuster.MatchString(a.WireguardSchluessel) {
		f = append(f, "wireguardSchluessel: ein öffentlicher WireGuard-Schlüssel (44 Zeichen Base64)")
	}
	if !hostMuster.MatchString(a.HostSchluessel) {
		f = append(f, "hostSchluessel: Form SHA256: und 43 Zeichen")
	}
	if strings.TrimSpace(a.CsrPem) == "" || len(a.CsrPem) > MaxCSR {
		f = append(f, fmt.Sprintf("csrPem: die Zertifikatsanfrage der Box (PEM, höchstens %d Zeichen)", MaxCSR))
	}
	if sig, err := base64.StdEncoding.DecodeString(a.Signatur); err != nil || len(sig) == 0 || len(a.Signatur) > 200 {
		f = append(f, "signatur: ECDSA-Signatur (DER, Base64)")
	}
	return f
}

// SPKI ist der öffentliche Schlüssel als SubjectPublicKeyInfo (DER), Base64.
func SPKI(pub *ecdsa.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

// Geraeteschluessel liest einen öffentlichen EC-P-256-Schlüssel aus SPKI/Base64.
func Geraeteschluessel(spki string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(spki)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	ec, ok := k.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return nil, errors.New("kein EC-P-256-Schlüssel")
	}
	return ec, nil
}

// Signiere setzt Geräteschlüssel und Signatur (ECDSA P-256, SHA-256, DER).
func Signiere(key *ecdsa.PrivateKey, a *Anfrage) error {
	spki, err := SPKI(&key.PublicKey)
	if err != nil {
		return err
	}
	a.GeraeteSchluessel = spki
	a.Signatur = ""
	h := sha256.Sum256([]byte(Kanonisch(*a)))
	sig, err := ecdsa.SignASN1(rand.Reader, key, h[:])
	if err != nil {
		return err
	}
	a.Signatur = base64.StdEncoding.EncodeToString(sig)
	return nil
}

// SignaturGueltig prüft die Signatur über den kanonischen Text.
func SignaturGueltig(a Anfrage) bool {
	pub, err := Geraeteschluessel(a.GeraeteSchluessel)
	if err != nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(a.Signatur)
	if err != nil {
		return false
	}
	h := sha256.Sum256([]byte(Kanonisch(a)))
	return ecdsa.VerifyASN1(pub, h[:], sig)
}

// Antwort ist, was die API nach dem Einlösen zurückgibt; nichts davon geheim.
type Antwort struct {
	Schema         string `json:"schema"`
	EdgeRef        string `json:"edgeRef"`
	Freigabe       string `json:"freigabe"`
	TunnelErgebnis string `json:"tunnelErgebnis"`
	Tunnel         struct {
		Adresse         string `json:"adresse"`
		BoxNetz         string `json:"boxNetz"`
		TechnikerNetz   string `json:"technikerNetz"`
		ServerEndpunkt  string `json:"serverEndpunkt"`
		ServerPort      int    `json:"serverPort"`
		ServerPublicKey string `json:"serverPublicKey"`
		ServerAdresse   string `json:"serverAdresse"`
	} `json:"tunnel"`
	Probe struct {
		FensterID     string    `json:"fensterId"`
		TechnikerID   string    `json:"technikerId"`
		TechnikerName string    `json:"technikerName"`
		Beginn        time.Time `json:"beginn"`
		Ende          time.Time `json:"ende"`
	} `json:"probe"`
	GeraeteSchluessel struct {
		Sha256         string    `json:"sha256"`
		FestgehaltenAm time.Time `json:"festgehaltenAm"`
	} `json:"geraeteSchluessel"`
}

// Abgelehnt ist eine Antwort der API außer 200: Status, Kennwort (etwa
// schluessel_festgehalten) und Satz.
type Abgelehnt struct {
	Status  int
	Code    string
	Message string
}

func (a Abgelehnt) Error() string {
	if a.Code != "" {
		return fmt.Sprintf("Einlösen abgelehnt (HTTP %d, %s): %s", a.Status, a.Code, a.Message)
	}
	return fmt.Sprintf("Einlösen abgelehnt (HTTP %d): %s", a.Status, a.Message)
}

// Einloesen schickt die signierte Anfrage an das Portal.
func Einloesen(ctx context.Context, client *http.Client, portal string, a Anfrage) (Antwort, error) {
	if f := Formfehler(a); len(f) > 0 {
		return Antwort{}, fmt.Errorf("Anfrage ungültig: %s", strings.Join(f, "; "))
	}
	body, err := json.Marshal(a)
	if err != nil {
		return Antwort{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(portal, "/")+"/api/v1/werkstatt/einloesen", bytes.NewReader(body))
	if err != nil {
		return Antwort{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Antwort{}, fmt.Errorf("Portal nicht erreicht: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		var m struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &m)
		if m.Message == "" {
			m.Message = strings.TrimSpace(string(raw))
		}
		return Antwort{}, Abgelehnt{Status: resp.StatusCode, Code: m.Code, Message: m.Message}
	}
	var out Antwort
	if err := json.Unmarshal(raw, &out); err != nil {
		return Antwort{}, fmt.Errorf("Antwort des Portals kein JSON: %w", err)
	}
	if out.Schema != AntwortSchema || out.EdgeRef != a.EdgeRef {
		return Antwort{}, fmt.Errorf("Antwort des Portals passt nicht (Schema %q, Kennung %q)", out.Schema, out.EdgeRef)
	}
	return out, nil
}
