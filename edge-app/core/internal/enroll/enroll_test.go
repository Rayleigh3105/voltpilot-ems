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
	"strings"
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

	mu          sync.Mutex
	claimed     bool
	refKnown    bool
	csrPem      string           // last stored CSR
	issuedPem   string           // set once issued (409 on further CSR posts)
	forceKey    *ecdsa.PublicKey // when set, issue against THIS key (mismatch case)
	device      string           // issued/returned device_id ("" => the deviceID const)
	emptyBroker bool             // when set, the cert response omits the broker endpoint
	host        string           // served mqttHost ("" => "mqtt.example.com")
	port        int              // served mqttPort (0 => 8883)

	csrPosts  int
	certPolls int
}

// deviceOrDefault is the device_id the stub currently issues/serves.
func (s *apiStub) deviceOrDefault() string {
	if s.device != "" {
		return s.device
	}
	return deviceID
}

// reclaim simulates an unclaim+re-claim in the portal: the ref now maps to a
// NEW device row id, so the next certificate poll re-issues against the stored
// CSR (mirrors EnrollmentService.certificateFor / storeCertificate).
func (s *apiStub) reclaim(newDevice string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.device = newDevice
	s.issuedPem = "" // force a re-issue for the new device on the next poll
}

// rehost simulates the portal handing the SAME device a new broker endpoint
// (a late-provisioned / moved MQTT host). The device_id and certificate are
// unchanged; only the certificate response's mqttHost/mqttPort differ.
func (s *apiStub) rehost(host string, port int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.host, s.port = host, port
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
			s.issuedPem = s.ca.issue(s.t, pub, tenantID, siteID, s.deviceOrDefault())
		}
		host, port := "mqtt.example.com", 8883
		if s.host != "" {
			host = s.host
		}
		if s.port != 0 {
			port = s.port
		}
		if s.emptyBroker {
			host, port = "", 0
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deviceCertPem": s.issuedPem,
			"caPem":         s.ca.caPem,
			"mqttHost":      host,
			"mqttPort":      port,
			"tenantId":      tenantID,
			"siteId":        siteID,
			"deviceId":      s.deviceOrDefault(),
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

// enrollOnce runs a full enrollment against an already-claimed stub and returns
// the enroller + the resulting identity, ready for Reconcile calls.
func enrollOnce(t *testing.T, srvURL, dir string) (*Enroller, Identity) {
	t.Helper()
	var states []State
	e := newEnroller(t, srvURL, dir, &states)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id, err := e.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return e, id
}

func TestReconcileNoOpWhenIdentityUnchanged(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	e, id := enrollOnce(t, srv.URL, dir)

	// Snapshot the on-disk cert so we can prove it was NOT rewritten.
	certBefore, err := os.ReadFile(filepath.Join(dir, "device.crt"))
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := e.Reconcile(ctx, id)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if res.Changed {
		t.Fatalf("identity unchanged, but reconcile reported a change: %+v", res.Identity)
	}
	certAfter, _ := os.ReadFile(filepath.Join(dir, "device.crt"))
	if string(certAfter) != string(certBefore) {
		t.Error("reconcile rewrote the certificate despite an unchanged identity")
	}
}

func TestReconcileAdoptsChangedDeviceID(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	e, id := enrollOnce(t, srv.URL, dir)
	if id.DeviceID != deviceID {
		t.Fatalf("initial device id: %s", id.DeviceID)
	}
	keyBefore, err := os.ReadFile(filepath.Join(dir, "device.key"))
	if err != nil {
		t.Fatal(err)
	}

	// The customer unclaims + re-claims: the ref now maps to a NEW device row.
	const newDevice = "44444444-4444-4444-4444-444444444444"
	stub.reclaim(newDevice)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := e.Reconcile(ctx, id)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !res.Changed {
		t.Fatal("device id changed, but reconcile reported no change")
	}
	if res.Identity.DeviceID != newDevice {
		t.Fatalf("adopted device id = %s, want %s", res.Identity.DeviceID, newDevice)
	}
	// The new identity is persisted (survives a restart)...
	persisted, err := e.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.DeviceID != newDevice {
		t.Fatalf("persisted device id = %s, want %s", persisted.DeviceID, newDevice)
	}
	// ...the certificate now certifies the new id...
	certPem, _ := os.ReadFile(filepath.Join(dir, "device.crt"))
	block, _ := pem.Decode(certPem)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Subject.CommonName != newDevice {
		t.Fatalf("adopted cert CN = %s, want %s", cert.Subject.CommonName, newDevice)
	}
	// ...and the private key was REUSED, never regenerated.
	keyAfter, _ := os.ReadFile(filepath.Join(dir, "device.key"))
	if string(keyAfter) != string(keyBefore) {
		t.Error("reconcile regenerated the device key; a re-issue must reuse it")
	}

	// A second reconcile against the now-current identity is a no-op.
	res2, err := e.Reconcile(ctx, res.Identity)
	if err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if res2.Changed {
		t.Error("second reconcile reported a spurious change")
	}
}

// TestReconcileAdoptsChangedBrokerHost proves the reconnect path re-reads the
// CURRENTLY configured broker endpoint instead of reusing the host cached at
// first connect: when the portal serves the SAME device_id but a DIFFERENT
// mqtt host/port, Reconcile reports Changed and persists the new endpoint, so
// the agent rebuilds the cloud link on the fresh host (a paho auto-reconnect
// would otherwise keep dialing the stale cached one).
func TestReconcileAdoptsChangedBrokerHost(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	e, id := enrollOnce(t, srv.URL, dir)
	if id.MqttHost != "mqtt.example.com" || id.MqttPort != 8883 {
		t.Fatalf("initial broker endpoint: %s:%d", id.MqttHost, id.MqttPort)
	}
	certBefore, err := os.ReadFile(filepath.Join(dir, "device.crt"))
	if err != nil {
		t.Fatal(err)
	}

	// The portal now hands the SAME device a new broker endpoint.
	const newHost, newPort = "mqtt.new.example.com", 9883
	stub.rehost(newHost, newPort)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := e.Reconcile(ctx, id)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !res.Changed {
		t.Fatal("broker endpoint changed, but reconcile reported no change")
	}
	if res.Identity.DeviceID != id.DeviceID {
		t.Fatalf("device id must be unchanged: got %s want %s", res.Identity.DeviceID, id.DeviceID)
	}
	if res.Identity.MqttHost != newHost || res.Identity.MqttPort != newPort {
		t.Fatalf("adopted endpoint = %s:%d, want %s:%d",
			res.Identity.MqttHost, res.Identity.MqttPort, newHost, newPort)
	}
	// The new endpoint is persisted (survives a restart).
	persisted, err := e.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.MqttHost != newHost || persisted.MqttPort != newPort {
		t.Fatalf("persisted endpoint = %s:%d, want %s:%d",
			persisted.MqttHost, persisted.MqttPort, newHost, newPort)
	}
	// The certificate is unchanged (same device_id => the same still-valid cert).
	certAfter, _ := os.ReadFile(filepath.Join(dir, "device.crt"))
	if string(certAfter) != string(certBefore) {
		t.Error("a broker-host change must not alter the device certificate")
	}

	// A second reconcile against the now-current endpoint is a no-op.
	res2, err := e.Reconcile(ctx, res.Identity)
	if err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if res2.Changed {
		t.Error("second reconcile reported a spurious change")
	}
}

func TestReconcilePendingIsNoOp(t *testing.T) {
	ca := newTestCA(t)
	// Ref known but NOT claimed -> the certificate poll returns 404 pending.
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	e, id := enrollOnce(t, srv.URL, dir)

	// Simulate an unclaim: the portal now answers the poll with 404 pending.
	stub.mu.Lock()
	stub.claimed = false
	stub.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := e.Reconcile(ctx, id)
	if err != nil {
		t.Fatalf("reconcile on a pending/unclaimed ref must not error: %v", err)
	}
	if res.Changed {
		t.Error("pending poll must not change the identity")
	}
	// The clean 404 IS surfaced as a definitive Pending signal, so a caller can
	// escalate a SUSTAINED run of them (UnclaimDetector) - the single-pending
	// no-op contract above stays.
	if !res.Pending {
		t.Error("a clean 404 'not claimed' answer must be reported as Pending")
	}

	// A real certificate answer is NOT pending.
	stub.mu.Lock()
	stub.claimed = true
	stub.mu.Unlock()
	res, err = e.Reconcile(ctx, id)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if res.Pending {
		t.Error("a served certificate must not be reported as Pending")
	}
}

// The UnclaimDetector confirms a removal ONLY on a sustained, uninterrupted run
// of definitive clean-404 answers: both the consecutive-poll count AND the
// elapsed wall-clock window must be satisfied, and ANY interruption (a real
// answer, an unreachable portal, any error - all mapped to Reset by the caller)
// starts the run over. This is the guard that keeps a transient portal blip
// from ever reading as "device removed".
func TestUnclaimDetectorConfirmsOnlySustainedCleanPending(t *testing.T) {
	base := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)

	// (a) Many rapid polls inside a too-short window: poll count satisfied,
	// window NOT -> never confirmed.
	d := &UnclaimDetector{Window: 15 * time.Minute, MinPolls: 3}
	for i := 0; i < 10; i++ {
		if d.ObservePending(base.Add(time.Duration(i) * time.Second)) {
			t.Fatalf("confirmed after %d rapid polls well inside the window", i+1)
		}
	}

	// (b) A long window but too few polls: window satisfied, count NOT.
	d = &UnclaimDetector{Window: 15 * time.Minute, MinPolls: 3}
	if d.ObservePending(base) {
		t.Fatal("confirmed on the first pending")
	}
	if d.ObservePending(base.Add(time.Hour)) {
		t.Fatal("confirmed on the second pending despite MinPolls=3")
	}

	// (c) Both satisfied -> confirmed (and stays confirmed on further polls).
	if !d.ObservePending(base.Add(time.Hour + time.Minute)) {
		t.Fatal("not confirmed although both the window and the poll count are satisfied")
	}
	if !d.ObservePending(base.Add(time.Hour + 2*time.Minute)) {
		t.Fatal("must stay confirmed on further pendings")
	}

	// (d) An interruption (outage error / real answer) resets the run: the
	// polls before it never count again.
	d = &UnclaimDetector{Window: 10 * time.Minute, MinPolls: 2}
	d.ObservePending(base)
	d.ObservePending(base.Add(5 * time.Minute))
	d.Reset() // e.g. a dial error mid-run, or the portal answered the cert again
	if d.ObservePending(base.Add(20 * time.Minute)) {
		t.Fatal("confirmed on the FIRST pending after a reset - the run must start over")
	}
	if d.ObservePending(base.Add(25 * time.Minute)) {
		t.Fatal("confirmed before the post-reset window elapsed")
	}
	if !d.ObservePending(base.Add(31 * time.Minute)) {
		t.Fatal("not confirmed although the post-reset run satisfies both bounds")
	}

	// (e) Zero values fall back to the generous defaults (20 min / 4 polls).
	d = &UnclaimDetector{}
	for i := 0; i < 3; i++ {
		if d.ObservePending(base.Add(time.Duration(i) * 10 * time.Minute)) {
			t.Fatalf("default detector confirmed after only %d polls", i+1)
		}
	}
	if !d.ObservePending(base.Add(30 * time.Minute)) {
		t.Fatal("default detector must confirm on the 4th poll after 30 min")
	}
}

// A portal outage during reconcile (5xx / dial error) is an ERROR, never the
// definitive Pending signal - so it can never count toward a removal verdict.
func TestReconcileOutageIsErrorNotPending(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	e, id := enrollOnce(t, srv.URL, dir)

	// 5xx: the portal is up but erroring.
	err503 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer err503.Close()
	e.PortalBaseURL = err503.URL
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := e.Reconcile(ctx, id)
	if err == nil || res.Pending || res.Changed {
		t.Fatalf("5xx must be an error, never Pending/Changed: res=%+v err=%v", res, err)
	}

	// Dial error: no portal reachable at all.
	e.PortalBaseURL = "http://127.0.0.1:1"
	res, err = e.Reconcile(ctx, id)
	if err == nil || res.Pending || res.Changed {
		t.Fatalf("dial error must be an error, never Pending/Changed: res=%+v err=%v", res, err)
	}
}

func containsState(states []State, want State) bool {
	for _, s := range states {
		if s == want {
			return true
		}
	}
	return false
}

// A dial error / timeout reaching the portal must surface as
// portal_nicht_erreichbar, not the cheerful "waiting for claim".
func TestPortalUnreachableSurfacesOnDialError(t *testing.T) {
	dir := t.TempDir()
	var states []State
	// 127.0.0.1:1 refuses immediately - a stand-in for "no portal reachable".
	e := newEnroller(t, "http://127.0.0.1:1", dir, &states)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := e.Run(ctx); err == nil {
		t.Fatal("expected the cancelled run to return an error")
	}
	if !containsState(states, StatePortalUnreachable) {
		t.Errorf("expected portal_nicht_erreichbar to surface, got %v", states)
	}
	// It must NOT be mistaken for a device-local failure.
	if containsState(states, StateDeviceError) {
		t.Errorf("a transport failure must not surface as geraet_fehler: %v", states)
	}
}

// A 5xx on the CSR upload (portal up but erroring) also maps to unreachable.
func TestPortalErrorOnCSRSurfacesUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, _ = e.Run(ctx)
	if !containsState(states, StatePortalUnreachable) {
		t.Errorf("a 5xx on CSR upload must surface portal_nicht_erreichbar, got %v", states)
	}
}

// A local first-boot failure (unwritable data dir) is a terminal device error,
// distinct from any portal/transport problem.
func TestLocalInitFailureSurfacesDeviceError(t *testing.T) {
	base := t.TempDir()
	// A regular file where the identity dir's PARENT should be -> MkdirAll fails.
	blocker := filepath.Join(base, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var states []State
	e := newEnroller(t, "http://127.0.0.1:1", filepath.Join(blocker, "identity"), &states)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := e.Run(ctx); err == nil {
		t.Fatal("expected a local-init error")
	}
	if !containsState(states, StateDeviceError) {
		t.Errorf("expected geraet_fehler, got %v", states)
	}
}

// getCertificate must reject a claim response that carries no broker endpoint
// (which would otherwise be persisted and then fail cloud setup silently).
func TestMissingBrokerEndpointRejectsCertificate(t *testing.T) {
	ca := newTestCA(t)
	stub := &apiStub{t: t, ca: ca, refKnown: true, claimed: true, emptyBroker: true}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	dir := t.TempDir()
	var states []State
	e := newEnroller(t, srv.URL, dir, &states)

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrPem, err := buildCSR(key, e.Ref)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Store the CSR so the stub is willing to "issue" (with an empty broker).
	if _, _, err := e.postCSR(ctx, csrPem); err != nil {
		t.Fatal(err)
	}
	_, err = e.getCertificate(ctx)
	if err == nil {
		t.Fatal("expected a certificate with no broker endpoint to be rejected")
	}
	if !strings.Contains(err.Error(), "broker endpoint") {
		t.Errorf("unexpected error: %v", err)
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
