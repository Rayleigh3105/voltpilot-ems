// Package enroll implements first-boot device enrollment over HTTPS against
// the portal api (openapi.yaml tag "enrollment", built by services/api):
//
//	POST /api/v1/enrollment/{ref}/csr        upload the device-generated CSR
//	GET  /api/v1/enrollment/{ref}/certificate poll until the ref is claimed
//
// The device generates an EC P-256 keypair LOCALLY (the private key never
// leaves the device), uploads a CSR proving key possession, and polls with
// backoff (~10 s at first, backing off to >= 60 s per docs/connect-a-device.md;
// claiming may happen days later). Once claimed, the response carries the
// CA-signed client certificate, the CA PEM to verify the broker, the broker
// host/port and the topic identity - everything is persisted to the data dir
// and enrollment never runs again (idempotent on restart).
package enroll

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Identity is the persisted result of a successful enrollment.
type Identity struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	DeviceID string `json:"device_id"`
	MqttHost string `json:"mqtt_host"`
	MqttPort int    `json:"mqtt_port"`
}

// State is the pairing state shown in the local web app.
type State string

const (
	// StateWaitingForClaim: CSR uploaded, polling until the customer claims
	// the reference in the portal.
	StateWaitingForClaim State = "warte_auf_beanspruchung"
	// StateCertificateReceived: certificate persisted, cloud link starting.
	StateCertificateReceived State = "zertifikat_erhalten"
	// StateKeyConflict: the portal already issued a certificate for this
	// reference against a DIFFERENT key. Needs operator action (revoke +
	// unclaim/re-claim) - the device cannot resolve this itself.
	StateKeyConflict State = "schluessel_konflikt"
	// StateRefUnknown: a VP- sticker reference the registry does not know
	// (HTTP 422). Retried slowly; usually a typo in VP_REF or a missing
	// registry entry.
	StateRefUnknown State = "referenz_unbekannt"
	// StatePortalUnreachable: the device cannot reach the portal at all - a
	// dial error, a timeout, or a 5xx on the CSR upload / certificate poll (a
	// 404 stays "pending", not this). Distinct from "waiting for claim" so the
	// customer sees an actionable "check the internet connection" hint instead
	// of a cheerful "waiting" that never resolves. Retried; clears itself the
	// moment the portal answers again.
	StatePortalUnreachable State = "portal_nicht_erreichbar"
	// StateDeviceError: a LOCAL first-boot failure before the device could even
	// talk to the portal - e.g. the data dir is read-only, the key cannot be
	// written, or the CSR cannot be built. Retried with backoff; surfaced so a
	// permanently broken device is visible instead of silently stuck at "start".
	StateDeviceError State = "geraet_fehler"
	// StateConnected: the cloud mTLS link is up (set by the agent once the
	// broker accepts the device). The final pairing step.
	StateConnected State = "verbunden"
	// StateCloudError: enrollment succeeded (certificate on disk) but the cloud
	// link could not be established - e.g. a corrupt certificate bundle or a
	// missing broker endpoint. Retried with backoff; distinct from a normal
	// disconnect so the customer isn't told a transient blip is a setup failure.
	StateCloudError State = "cloud_fehler"
	// StateCloudDisconnected: the cloud link was up and dropped (network blip).
	// Keeps the pairing checklist honest - it must not stay green "Verbunden"
	// while the Cloud stat shows "getrennt". Reconnect is automatic.
	StateCloudDisconnected State = "cloud_getrennt"
)

// Enroller drives the enrollment state machine for one device.
type Enroller struct {
	PortalBaseURL string
	Ref           string
	Dir           string // identity dir (device.key / device.crt / ca.crt / identity.json)
	HTTP          *http.Client
	DeviceInfo    string
	// OnState is called on every pairing-state change (for the web UI).
	OnState func(State)
	// Backoff bounds; overridable in tests.
	PollMin time.Duration
	PollMax time.Duration
}

func (e *Enroller) client() *http.Client {
	if e.HTTP != nil {
		return e.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (e *Enroller) setState(s State) {
	if e.OnState != nil {
		e.OnState(s)
	}
}

// Paths of the persisted material.
func (e *Enroller) keyPath() string      { return filepath.Join(e.Dir, "device.key") }
func (e *Enroller) certPath() string     { return filepath.Join(e.Dir, "device.crt") }
func (e *Enroller) caPath() string       { return filepath.Join(e.Dir, "ca.crt") }
func (e *Enroller) identityPath() string { return filepath.Join(e.Dir, "identity.json") }

// Enrolled reports whether a complete enrollment is already on disk.
func (e *Enroller) Enrolled() bool {
	for _, p := range []string{e.keyPath(), e.certPath(), e.caPath(), e.identityPath()} {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	return true
}

// LoadIdentity returns the persisted identity (call after Enrolled() == true
// or a successful Run).
func (e *Enroller) LoadIdentity() (Identity, error) {
	var id Identity
	raw, err := os.ReadFile(e.identityPath())
	if err != nil {
		return id, err
	}
	err = json.Unmarshal(raw, &id)
	return id, err
}

// CertFiles returns the paths of the client key/cert and CA for the mTLS
// cloud link.
func (e *Enroller) CertFiles() (keyPath, certPath, caPath string) {
	return e.keyPath(), e.certPath(), e.caPath()
}

// Run executes the state machine until enrolled or ctx is done. It is
// idempotent: an existing enrollment returns immediately; an existing key is
// reused (never regenerated).
func (e *Enroller) Run(ctx context.Context) (Identity, error) {
	if e.Enrolled() {
		id, err := e.LoadIdentity()
		if err == nil {
			e.setState(StateCertificateReceived)
		}
		return id, err
	}
	// Local first-boot setup: the data dir, the device key and the CSR. A
	// failure here is a device-local problem (read-only volume, disk full) the
	// device cannot fix by talking to the portal - surface it as geraet_fehler
	// so it is visible in the web app instead of a silent stall at "start".
	if err := os.MkdirAll(e.Dir, 0o700); err != nil {
		e.setState(StateDeviceError)
		return Identity{}, fmt.Errorf("enrollment: create identity dir: %w", err)
	}
	key, err := e.loadOrCreateKey()
	if err != nil {
		e.setState(StateDeviceError)
		return Identity{}, fmt.Errorf("enrollment: device key: %w", err)
	}
	csrPem, err := buildCSR(key, e.Ref)
	if err != nil {
		e.setState(StateDeviceError)
		return Identity{}, fmt.Errorf("enrollment: build CSR: %w", err)
	}

	pollMin, pollMax := e.PollMin, e.PollMax
	if pollMin <= 0 {
		pollMin = 10 * time.Second
	}
	if pollMax <= 0 {
		pollMax = 60 * time.Second
	}

	// 1) Upload the CSR. 202 = stored; 409 = a certificate exists already
	// (retrievable - poll straight away); 422 = unknown sticker ref (retry
	// slowly, the registry entry may land later); anything else retries.
	e.setState(StateWaitingForClaim)
	delay := pollMin
	for {
		status, body, err := e.postCSR(ctx, csrPem)
		if err == nil {
			if status == http.StatusAccepted || status == http.StatusConflict {
				if status == http.StatusConflict {
					slog.Info("enrollment: certificate already issued for this reference, fetching it", "ref", e.Ref)
				}
				break
			}
			if status == http.StatusUnprocessableEntity {
				e.setState(StateRefUnknown)
				slog.Warn("enrollment: reference unknown to the provisioned-device registry (422); retrying",
					"ref", e.Ref, "body", string(body))
			} else if status >= 500 {
				// The portal is up but erroring - treat like unreachable.
				e.setState(StatePortalUnreachable)
				slog.Warn("enrollment: portal error on CSR upload; retrying", "status", status, "body", string(body))
			} else {
				slog.Warn("enrollment: CSR upload refused; retrying", "status", status, "body", string(body))
			}
		} else {
			// Dial error / timeout: the portal cannot be reached at all.
			e.setState(StatePortalUnreachable)
			slog.Warn("enrollment: cannot reach the portal for CSR upload; retrying", "err", err)
		}
		select {
		case <-ctx.Done():
			return Identity{}, ctx.Err()
		case <-time.After(delay):
		}
		if delay < pollMax {
			delay *= 2
			if delay > pollMax {
				delay = pollMax
			}
		}
	}

	// 2) Poll for the certificate until the customer claims the reference.
	e.setState(StateWaitingForClaim)
	delay = pollMin
	for {
		cert, err := e.getCertificate(ctx)
		if err == nil && cert != nil {
			var id Identity
			id, err = e.persist(key, cert)
			if err == nil {
				e.setState(StateCertificateReceived)
				slog.Info("enrollment complete", "ref", e.Ref, "device_id", id.DeviceID, "mqtt", fmt.Sprintf("%s:%d", id.MqttHost, id.MqttPort))
				return id, nil
			}
		}
		if errors.Is(err, errKeyMismatch) {
			e.setState(StateKeyConflict)
			slog.Error("enrollment: issued certificate does not match this device's key; operator must revoke + re-claim", "ref", e.Ref)
			// Keep polling slowly - a revoke + re-claim re-issues against
			// a fresh CSR (which we re-POST first).
			if _, _, perr := e.postCSR(ctx, csrPem); perr != nil {
				slog.Warn("enrollment: CSR re-upload failed", "err", perr)
			}
			delay = pollMax
		} else if errors.Is(err, errPortalUnreachable) {
			e.setState(StatePortalUnreachable)
			slog.Warn("enrollment: cannot reach the portal for the certificate poll; retrying", "err", err)
		} else if errors.Is(err, errPending) {
			// 404 = still unclaimed (or the portal just recovered): back to a
			// plain "waiting for claim" (clears a prior portal-unreachable).
			e.setState(StateWaitingForClaim)
		} else if err != nil {
			slog.Warn("enrollment: certificate poll failed; retrying", "err", err)
		}
		select {
		case <-ctx.Done():
			return Identity{}, ctx.Err()
		case <-time.After(delay):
		}
		if delay < pollMax {
			delay *= 2
			if delay > pollMax {
				delay = pollMax
			}
		}
	}
}

var (
	errPending     = errors.New("enrollment pending")
	errKeyMismatch = errors.New("issued certificate does not match the device key")
	// errPortalUnreachable classifies a dial error / timeout / 5xx on the
	// certificate poll (a 404 is errPending, not this).
	errPortalUnreachable = errors.New("portal unreachable")
)

// ReconcileResult is the outcome of a while-connected identity re-check.
type ReconcileResult struct {
	// Changed is true only when the portal now reports a DIFFERENT device_id
	// for this reference and the new certificate/identity was adopted on disk.
	Changed bool
	// Identity is the freshly adopted identity (valid only when Changed).
	Identity Identity
}

// Reconcile re-polls the certificate endpoint for an ALREADY-enrolled device
// and adopts a changed identity in place, closing the device-identity-drift
// gap: a re-claim (or a DB reset + re-claim) mints a new device row id and the
// api re-issues a certificate for it against the stored CSR, but a device that
// only enrolls once at first boot would keep publishing under its stale,
// persisted device_id forever (orphan telemetry; the portal's Geräte tab reads
// "wartet auf erste Daten" permanently). Calling this periodically while
// connected keeps telemetry.device_id in lockstep with the current device row.
//
// It is a deliberate no-op (Changed=false, nil error) when:
//   - the portal still reports the same device_id (the common case), or
//   - the reference is (temporarily) unclaimed/unknown -> HTTP 404 pending.
//
// The device key is REUSED (never regenerated): the re-issue is bound to the
// original CSR, so the returned certificate matches the on-disk key. A cert
// that does not match is surfaced as an error (errKeyMismatch) and nothing on
// disk is touched, so the existing identity keeps working until an operator
// resolves it (revoke + re-claim).
func (e *Enroller) Reconcile(ctx context.Context, current Identity) (ReconcileResult, error) {
	cert, err := e.getCertificate(ctx)
	if err != nil {
		if errors.Is(err, errPending) {
			// Unclaimed/unknown: keep the current identity, retry later.
			return ReconcileResult{}, nil
		}
		return ReconcileResult{}, err
	}
	if cert.DeviceID == "" || cert.DeviceID == current.DeviceID {
		return ReconcileResult{}, nil // unchanged - no thrash
	}
	// Identity drift: the reference now maps to a new device row. Adopt it,
	// reusing the persisted key (persist re-verifies the key match first and
	// only overwrites the cert/identity on success).
	key, err := e.loadKey()
	if err != nil {
		return ReconcileResult{}, fmt.Errorf("reconcile: load device key: %w", err)
	}
	id, err := e.persist(key, cert)
	if err != nil {
		return ReconcileResult{}, err
	}
	slog.Info("enrollment: adopted new device identity after re-claim",
		"ref", e.Ref, "old_device_id", current.DeviceID, "new_device_id", id.DeviceID)
	return ReconcileResult{Changed: true, Identity: id}, nil
}

// loadKey reads the persisted device key, erroring (incl. os.ErrNotExist) when
// it is absent. Used by reconcile, which must NEVER regenerate: a re-issue is
// bound to the original CSR/key, so a fresh key would only ever mismatch.
func (e *Enroller) loadKey() (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(e.keyPath())
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("device.key: not PEM")
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("device.key: %w", err)
	}
	return key, nil
}

func (e *Enroller) loadOrCreateKey() (*ecdsa.PrivateKey, error) {
	key, err := e.loadKey()
	if err == nil {
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(e.keyPath(), pemBytes, 0o600); err != nil {
		return nil, err
	}
	slog.Info("enrollment: generated device keypair (EC P-256); the key never leaves this device")
	return key, nil
}

func buildCSR(key *ecdsa.PrivateKey, ref string) (string, error) {
	// The requested subject is irrelevant - issuance overrides it with the
	// claim-derived identity. The CSR only proves key possession.
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: ref},
	}, key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}

func (e *Enroller) postCSR(ctx context.Context, csrPem string) (int, []byte, error) {
	payload, _ := json.Marshal(map[string]string{
		"csrPem":     csrPem,
		"deviceInfo": e.DeviceInfo,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		e.PortalBaseURL+"/api/v1/enrollment/"+e.Ref+"/csr", bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, body, nil
}

type certificateResponse struct {
	DeviceCertPem string `json:"deviceCertPem"`
	CaPem         string `json:"caPem"`
	MqttHost      string `json:"mqttHost"`
	MqttPort      int    `json:"mqttPort"`
	TenantID      string `json:"tenantId"`
	SiteID        string `json:"siteId"`
	DeviceID      string `json:"deviceId"`
}

func (e *Enroller) getCertificate(ctx context.Context) (*certificateResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		e.PortalBaseURL+"/api/v1/enrollment/"+e.Ref+"/certificate", nil)
	if err != nil {
		return nil, err
	}
	resp, err := e.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errPortalUnreachable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errPending // pending (unclaimed / unknown - indistinguishable by design)
	}
	if resp.StatusCode >= 500 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("%w: HTTP %d: %s", errPortalUnreachable, resp.StatusCode, body)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("certificate poll: HTTP %d: %s", resp.StatusCode, body)
	}
	var cr certificateResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return nil, err
	}
	if cr.DeviceCertPem == "" || cr.CaPem == "" {
		return nil, errors.New("certificate response incomplete")
	}
	// A certificate with no broker endpoint cannot start the cloud link;
	// validate it here so a malformed claim response is rejected (and retried)
	// rather than silently persisted and then failing cloud setup.
	if cr.MqttHost == "" || cr.MqttPort <= 0 {
		return nil, fmt.Errorf("certificate response missing broker endpoint (host=%q port=%d)", cr.MqttHost, cr.MqttPort)
	}
	return &cr, nil
}

// persist verifies the issued certificate matches our key, then writes the
// bundle + identity atomically enough for a restart to be consistent (the
// identity file is written LAST; Enrolled() requires all four files).
func (e *Enroller) persist(key *ecdsa.PrivateKey, cr *certificateResponse) (Identity, error) {
	block, _ := pem.Decode([]byte(cr.DeviceCertPem))
	if block == nil {
		return Identity{}, errors.New("issued certificate: not PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return Identity{}, fmt.Errorf("issued certificate: %w", err)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return Identity{}, errKeyMismatch
	}

	if err := os.WriteFile(e.certPath(), []byte(cr.DeviceCertPem), 0o644); err != nil {
		return Identity{}, err
	}
	if err := os.WriteFile(e.caPath(), []byte(cr.CaPem), 0o644); err != nil {
		return Identity{}, err
	}
	id := Identity{
		TenantID: cr.TenantID,
		SiteID:   cr.SiteID,
		DeviceID: cr.DeviceID,
		MqttHost: cr.MqttHost,
		MqttPort: cr.MqttPort,
	}
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return Identity{}, err
	}
	if err := os.WriteFile(e.identityPath(), raw, 0o644); err != nil {
		return Identity{}, err
	}
	return id, nil
}
