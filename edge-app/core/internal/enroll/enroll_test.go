package enroll

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// --- minimal test CA (mirrors what the api's DeviceCertificateAuthority does) ---

type testCA struct {
	key   *ecdsa.PrivateKey
	cert  *x509.Certificate
	caPem string
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "VoltPilot Test Device CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &testCA{
		key:   key,
		cert:  cert,
		caPem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
	}
}

// issue signs a client cert for the given public key with the claim-derived
// identity subject (whatever the CSR requested is ignored - like the api).
func (ca *testCA) issue(t *testing.T, pub any, tenant, site, device string) string {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName:         device,
			Organization:       []string{tenant},
			OrganizationalUnit: []string{site},
		},
		NotBefore:   time.Now().Add(-time.Minute),
		NotAfter:    time.Now().Add(24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// --- enrollment API stub (contract: openapi.yaml tag "enrollment") ---

type apiStub struct {
	t  *testing.T
	ca *testCA

	mu        sync.Mutex
	claimed   bool
	refKnown  bool
	csrPem    string     // last stored CSR
	issuedPem string     // set once issued (409 on further CSR posts)
	forceKey  *ecdsa.PublicKey // when set, issue against THIS key (mismatch case)

	csrPosts  int
	certPolls int
}

const (
	tenantID = "00000000-0000-0000-0000-000000000001"
	siteID   = "00000000-0000-0000-0000-000000000002"
	deviceID = "00000000-0000-0000-0000-000000000003"
)

func (s *apiStub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/enrollment/{ref}/csr", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.csrPosts++
		if !s.refKnown {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Diese Geräte-ID ist uns nicht bekannt."}`))
			return
		}
		if s.issuedPem != "" {
			w.WriteHeader(http.StatusConflict)
			return
		}
		var body struct {
			CsrPem string `json:"csrPem"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.CsrPem == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		s.csrPem = body.CsrPem
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"pending","ref":"` + r.PathValue("ref") + `"}`))
	})
	mux.HandleFunc("GET /api/v1/enrollment/{ref}/certificate", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.certPolls++
		if !s.claimed || (s.csrPem == "" && s.issuedPem == "") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"status":"pending"}`))
			return
		}
		if s.issuedPem == "" {
			var pub any
			if s.forceKey != nil {
				pub = s.forceKey
			} else {
				block, _ := pem.Decode([]byte(s.csrPem))
				csr, err := x509.ParseCertificateRequest(block.Bytes)
				if err != nil {
					s.t.Errorf("stub: bad CSR: %v", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if err := csr.CheckSignature(); err != nil {
					s.t.Errorf("stub: CSR proof-of-possession failed: %v", err)
				}
				pub = csr.PublicKey
			}
			s.issuedPem = s.ca.issue(s.t, pub, tenantID, siteID, deviceID)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deviceCertPem": s.issuedPem,
			"caPem":         s.ca.caPem,
			"mqttHost":      "mqtt.example.com",
			"mqttPort":      8883,
			"tenantId":      tenantID,
			"siteId":        siteID,
			"deviceId":      deviceID,
		})
	})
	return mux
}

func newEnroller(t *testing.T, baseURL, dir string, states *[]State) *Enroller {
	var mu sync.Mutex
	return &Enroller{
		PortalBaseURL: baseURL,
		Ref:           "VP-TEST-0001",
		Dir:           dir,
		DeviceInfo:    "test",
		PollMin:       5 * time.Millisecond,
		PollMax:       20 * time.Millisecond,
		OnState: func(s State) {
			mu.Lock()
			defer mu.Unlock()
			*states = append(*states, s)
		},
	}
}

func TestPendingThenIssued(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)

	// Claim the ref "in the portal" after a few pending polls.
	go func() {
		for {
			stub.mu.Lock()
			polled := stub.certPolls >= 2
			stub.mu.Unlock()
			if polled {
				stub.mu.Lock()
				stub.claimed = true
				stub.mu.Unlock()
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id, err := e.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if id.TenantID != tenantID || id.SiteID != siteID || id.DeviceID != deviceID {
		t.Errorf("identity: %+v", id)
	}
	if id.MqttHost != "mqtt.example.com" || id.MqttPort != 8883 {
		t.Errorf("broker endpoint: %+v", id)
	}
	// State machine went waiting -> received.
	if states[0] != StateWaitingForClaim || states[len(states)-1] != StateCertificateReceived {
		t.Errorf("state transitions: %v", states)
	}
	// All four artifacts persisted; the key is private (0600).
	for _, f := range []string{"device.key", "device.crt", "ca.crt", "identity.json"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if info, _ := os.Stat(filepath.Join(dir, "device.key")); info.Mode().Perm() != 0o600 {
		t.Errorf("device.key permissions: %v", info.Mode().Perm())
	}
	if !e.Enrolled() {
		t.Error("Enrolled() must be true after Run")
	}
}

func TestRestartIsIdempotent(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err := e.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}

	stub.mu.Lock()
	postsBefore, pollsBefore := stub.csrPosts, stub.certPolls
	stub.mu.Unlock()

	// "Reboot": fresh Enroller over the same dir - no HTTP traffic at all.
	var states2 []State
	e2 := newEnroller(t, srv.URL, dir, &states2)
	second, err := e2.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Errorf("identity changed across restart: %+v vs %+v", second, first)
	}
	stub.mu.Lock()
	if stub.csrPosts != postsBefore || stub.certPolls != pollsBefore {
		t.Errorf("restart must not re-enroll (posts %d->%d, polls %d->%d)",
			postsBefore, stub.csrPosts, pollsBefore, stub.certPolls)
	}
	stub.mu.Unlock()
}

func TestAlreadyIssued409ProceedsToFetch(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	// First device enrolls normally (issues the cert).
	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := e.Run(ctx); err != nil {
		t.Fatal(err)
	}

	// Same device lost its local state EXCEPT the key (device.crt wiped):
	// the CSR POST now gets 409, the poll re-fetches the SAME cert.
	_ = os.Remove(filepath.Join(dir, "device.crt"))
	_ = os.Remove(filepath.Join(dir, "identity.json"))
	var states2 []State
	e2 := newEnroller(t, srv.URL, dir, &states2)
	id, err := e2.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if id.DeviceID != deviceID {
		t.Errorf("re-fetched identity: %+v", id)
	}
}

func TestKeyMismatchIsSurfacedThenRecovers(t *testing.T) {
	ca := newTestCA(t)
	wrongKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true, forceKey: &wrongKey.PublicKey}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	var mu sync.Mutex
	e := newEnroller(t, srv.URL, dir, &states)
	orig := e.OnState
	e.OnState = func(s State) {
		orig(s)
		mu.Lock()
		defer mu.Unlock()
		if s == StateKeyConflict {
			// Operator resolves: revoke + re-claim = the stub re-issues
			// against the device's real (re-posted) CSR.
			stub.mu.Lock()
			stub.forceKey = nil
			stub.issuedPem = ""
			stub.mu.Unlock()
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id, err := e.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if id.DeviceID != deviceID {
		t.Errorf("identity after recovery: %+v", id)
	}
	sawConflict := false
	for _, s := range states {
		if s == StateKeyConflict {
			sawConflict = true
		}
	}
	if !sawConflict {
		t.Error("key conflict state never surfaced")
	}
}

func TestUnknownStickerRefRetriesUntilRegistered(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: false, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)

	go func() {
		for {
			stub.mu.Lock()
			tried := stub.csrPosts >= 2
			stub.mu.Unlock()
			if tried {
				stub.mu.Lock()
				stub.refKnown = true // operator registers the sticker ID
				stub.mu.Unlock()
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := e.Run(ctx); err != nil {
		t.Fatal(err)
	}
	sawUnknown := false
	for _, s := range states {
		if s == StateRefUnknown {
			sawUnknown = true
		}
	}
	if !sawUnknown {
		t.Error("422 must surface as referenz_unbekannt")
	}
}

func TestContextCancelStopsRun(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true} // never claimed
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	var states []State
	e := newEnroller(t, srv.URL, t.TempDir(), &states)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := e.Run(ctx); err == nil {
		t.Error("cancelled run must return an error")
	}
}
