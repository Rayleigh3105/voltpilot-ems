package direktvermarkter

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// The delivery between cloud and box (vp-direktvermarktung-konzept d2 §5.7
// "Zustellung", contract docs/contracts/v2/direktvermarktung-zustellung.md):
//
//   - the partner PROFILE goes retained to the leading box on
//     .../v2/direktvermarktung (pattern v2/price); an EMPTY payload withdraws
//     everything - the box deletes its access and acknowledges;
//   - the ACCESS (key material) is never retained: the box asks with the
//     fingerprint it does not have yet on .../v2/direktvermarktung-anfrage,
//     the cloud answers once on .../v2/direktvermarktung-zugang over the
//     existing mTLS link, the box stores it in the tunnel manager's file
//     contract (internal/vermarktertunnel/zugang.go) and acknowledges on
//     .../v2/direktvermarktung-quittung.
//
// Topic identity and payload identity must match, the rule of every v2
// contract: a document addressed to someone else is dropped without a reply.
const (
	// TopicProfil is the retained profile document (cloud -> leading box).
	TopicProfil = "direktvermarktung"
	// TopicAnfrage is the box's access request (box -> cloud, not retained).
	TopicAnfrage = "direktvermarktung-anfrage"
	// TopicZugang is the one-time access answer (cloud -> box, not retained).
	TopicZugang = "direktvermarktung-zugang"
	// TopicQuittung is the box's acknowledgement (box -> cloud, not retained).
	TopicQuittung = "direktvermarktung-quittung"
)

// SchemaVersion of every Zustellung document.
const SchemaVersion = "1.0"

// Quittung events.
const (
	QuittungZugestellt = "zugestellt" // the access is stored on the box
	QuittungGeloescht  = "geloescht"  // the access was deleted from the box
)

// ProfilDokument is the retained profile the cloud publishes to the leading
// box. It PICKS which EMBEDDED partner profile runs (the register map, word
// order and rules come from this package's packaged catalog, never from a
// delivered file - the vermarktertunnel security rule) and carries what only
// the cloud knows: the plant's reference power (F6, in watts) and which
// access the box must hold. A box that holds a different access (or none)
// asks for it.
type ProfilDokument struct {
	SchemaVersion       string  `json:"schema_version"`
	TenantID            string  `json:"tenant_id"`
	SiteID              string  `json:"site_id"`
	DeviceID            string  `json:"device_id"`
	GeneratedAt         string  `json:"generated_at"`
	Partner             string  `json:"partner"`
	Revision            int     `json:"revision"`
	ReferenzWp          float64 `json:"referenz_wp"`
	ZugangFingerabdruck string  `json:"zugang_fingerabdruck"`
}

// BelongsTo reports whether the document is addressed to this identity.
func (d *ProfilDokument) BelongsTo(tenant, site, device string) bool {
	return d.TenantID == tenant && d.SiteID == site && d.DeviceID == device
}

// ParseProfilDokument reads the retained profile document. An empty payload
// is the retained-clear and returns (nil, nil): the profile is withdrawn.
// Everything else is validated strictly - a document the box cannot serve
// safely is rejected as a whole, never half-applied.
func ParseProfilDokument(raw []byte) (*ProfilDokument, error) {
	if len(raw) == 0 || len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	var d ProfilDokument
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("direktvermarktung: profil unlesbar: %w", err)
	}
	if d.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("direktvermarktung: schema_version %q", d.SchemaVersion)
	}
	if strings.TrimSpace(d.Partner) == "" {
		return nil, fmt.Errorf("direktvermarktung: partner fehlt")
	}
	if strings.TrimSpace(d.ZugangFingerabdruck) == "" {
		return nil, fmt.Errorf("direktvermarktung: zugang_fingerabdruck fehlt")
	}
	if !(d.ReferenzWp > 0) {
		// Without a reference the percent set-point has no meaning in kW
		// (the same refusal as vermarktertunnel.LadeAnschluss).
		return nil, fmt.Errorf("direktvermarktung: referenz_wp fehlt oder ist nicht positiv")
	}
	return &d, nil
}

// Anfrage is the box's access request: the fingerprint names WHICH access it
// asks for (the one the retained profile announced and the box does not hold
// yet) - never a credential itself.
type Anfrage struct {
	SchemaVersion       string `json:"schema_version"`
	TenantID            string `json:"tenant_id"`
	SiteID              string `json:"site_id"`
	DeviceID            string `json:"device_id"`
	ZugangFingerabdruck string `json:"zugang_fingerabdruck"`
	AngefragtAm         string `json:"angefragt_am"`
}

// Gegenstelle is the partner's VPN endpoint from the access file.
type Gegenstelle struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Protokoll string `json:"protokoll"` // "udp" or "tcp" - the intake reads it from the partner's configuration (F1)
}

// Dateien is the key material from the access file, PEM-encoded. Never log
// any of it; the only loggable identifier is the fingerprint.
type Dateien struct {
	ZertifikatPEM    string `json:"zertifikat_pem"`
	SchluesselPEM    string `json:"schluessel_pem"`
	CAPEM            string `json:"ca_pem"`
	TLSSchluesselPEM string `json:"tls_schluessel_pem,omitempty"`
}

// ZugangAntwort is the cloud's one-time answer to an Anfrage. It is the
// DECRYPTED content of the stored access (concept §5.7 "Die Zugangsdatei":
// only certificate, key, CA, optional TLS key and the endpoint - never the
// upload password, never the raw ZIP).
type ZugangAntwort struct {
	SchemaVersion       string `json:"schema_version"`
	TenantID            string `json:"tenant_id"`
	SiteID              string `json:"site_id"`
	DeviceID            string `json:"device_id"`
	Partner             string `json:"partner"`
	ZugangFingerabdruck string `json:"zugang_fingerabdruck"`
	GueltigBis          string `json:"gueltig_bis,omitempty"`
	// TLSSchluessel says how the shared TLS key is used: "tls_crypt",
	// "tls_auth" or "keine" (absent = "keine") - the vermarktertunnel
	// configuration needs the mode, not just the key.
	TLSSchluessel string      `json:"tls_schluessel,omitempty"`
	Gegenstelle   Gegenstelle `json:"gegenstelle"`
	Dateien       Dateien     `json:"dateien"`
}

// BelongsTo reports whether the answer is addressed to this identity.
func (z *ZugangAntwort) BelongsTo(tenant, site, device string) bool {
	return z.TenantID == tenant && z.SiteID == site && z.DeviceID == device
}

// ParseZugangAntwort reads the one-time access answer. Strict: an answer that
// lacks any of the three mandatory PEM parts or the endpoint is rejected
// whole - a half access could bring up a half tunnel.
func ParseZugangAntwort(raw []byte) (*ZugangAntwort, error) {
	var z ZugangAntwort
	if err := json.Unmarshal(raw, &z); err != nil {
		return nil, fmt.Errorf("direktvermarktung: zugang unlesbar")
	}
	if z.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("direktvermarktung: zugang schema_version %q", z.SchemaVersion)
	}
	if strings.TrimSpace(z.ZugangFingerabdruck) == "" {
		return nil, fmt.Errorf("direktvermarktung: zugang ohne fingerabdruck")
	}
	if strings.TrimSpace(z.Dateien.ZertifikatPEM) == "" || strings.TrimSpace(z.Dateien.SchluesselPEM) == "" ||
		strings.TrimSpace(z.Dateien.CAPEM) == "" {
		return nil, fmt.Errorf("direktvermarktung: zugang unvollstaendig")
	}
	if strings.TrimSpace(z.Gegenstelle.Host) == "" || z.Gegenstelle.Port < 1 || z.Gegenstelle.Port > 65535 {
		return nil, fmt.Errorf("direktvermarktung: gegenstelle unvollstaendig")
	}
	if z.Gegenstelle.Protokoll != "udp" && z.Gegenstelle.Protokoll != "tcp" {
		return nil, fmt.Errorf("direktvermarktung: gegenstelle.protokoll %q (udp oder tcp)", z.Gegenstelle.Protokoll)
	}
	switch z.TLSSchluessel {
	case "":
		z.TLSSchluessel = "keine"
	case "tls_crypt", "tls_auth", "keine":
	default:
		return nil, fmt.Errorf("direktvermarktung: tls_schluessel %q (tls_crypt, tls_auth oder keine)", z.TLSSchluessel)
	}
	if z.TLSSchluessel != "keine" && strings.TrimSpace(z.Dateien.TLSSchluesselPEM) == "" {
		return nil, fmt.Errorf("direktvermarktung: tls_schluessel %q ohne tls_schluessel_pem", z.TLSSchluessel)
	}
	return &z, nil
}

// Quittung is the box's acknowledgement: the access named by the fingerprint
// is now stored (zugestellt) or deleted (geloescht). The cloud's bookkeeping
// (zugestellt_am / zurueckgezogen_am, and the box-swap order "the old box
// deletes BEFORE the new one receives") hangs off these two words.
type Quittung struct {
	SchemaVersion       string `json:"schema_version"`
	TenantID            string `json:"tenant_id"`
	SiteID              string `json:"site_id"`
	DeviceID            string `json:"device_id"`
	ZugangFingerabdruck string `json:"zugang_fingerabdruck"`
	Ereignis            string `json:"ereignis"`
	Am                  string `json:"am"`
}

// NeueAnfrage builds the box's request for now.
func NeueAnfrage(fingerabdruck string, now time.Time) Anfrage {
	return Anfrage{SchemaVersion: SchemaVersion, ZugangFingerabdruck: fingerabdruck,
		AngefragtAm: now.UTC().Format(time.RFC3339)}
}

// NeueQuittung builds the box's acknowledgement for now.
func NeueQuittung(fingerabdruck, ereignis string, now time.Time) Quittung {
	return Quittung{SchemaVersion: SchemaVersion, ZugangFingerabdruck: fingerabdruck, Ereignis: ereignis,
		Am: now.UTC().Format(time.RFC3339)}
}
