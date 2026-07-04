package agent

// Integration test: the WHOLE core against a real (in-process) mTLS cloud
// broker and a real enrollment API stub.
//
//	Layer-1 stand-in (paho)  ->  embedded local bus  ->  agent
//	agent -> enrollment stub (httptest, real CA, real CSR signing)
//	agent -> cloud broker (mochi, TLS listener, client-cert REQUIRED)
//
// Proves: enrollment pending->issued with a device-generated key; contract
// telemetry arrives cloud-side with ORIGINAL timestamps; a retained schedule
// drives a guard-clamped setpoint on the local bus; a cloud outage grows the
// buffer and a reconnect replays it in order.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	tTenant = "00000000-0000-0000-0000-000000000001"
	tSite   = "00000000-0000-0000-0000-000000000002"
	tDevice = "00000000-0000-0000-0000-000000000003"
)

// --- test PKI ---

type pki struct {
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate
	caPem  string
	server tls.Certificate
	pool   *x509.CertPool
}

func newPKI(t *testing.T) *pki {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "VoltPilot Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	caDer, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDer)
	caPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDer})

	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	srvTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	srvDer, err := x509.CreateCertificate(rand.Reader, srvTmpl, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	srvKeyDer, _ := x509.MarshalECPrivateKey(srvKey)
	serverCert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srvDer}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: srvKeyDer}))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPem)
	return &pki{caKey: caKey, caCert: caCert, caPem: string(caPem), server: serverCert, pool: pool}
}

func (p *pki) issueClient(t *testing.T, csrPem string) string {
	return p.issueClientAs(t, csrPem, tDevice)
}

// issueClientAs signs a client cert whose CN is the claim-derived device id
// (the api ignores the CSR subject). A re-claim issues under a NEW device id.
func (p *pki) issueClientAs(t *testing.T, csrPem, device string) string {
	t.Helper()
	block, _ := pem.Decode([]byte(csrPem))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatalf("CSR proof of possession: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName:         device,
			Organization:       []string{tTenant},
			OrganizationalUnit: []string{tSite},
		},
		NotBefore:   time.Now().Add(-time.Minute),
		NotAfter:    time.Now().Add(24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, csr.PublicKey, p.caKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// --- cloud broker (mochi + TLS, client cert required) ---

type cloudBroker struct {
	t      *testing.T
	pki    *pki
	addr   string
	server *mochi.Server

	mu       sync.Mutex
	received []map[string]any // telemetry payloads in arrival order
}

func startCloudBroker(t *testing.T, p *pki, addr string) *cloudBroker {
	t.Helper()
	cb := &cloudBroker{t: t, pki: p, addr: addr}
	cb.start()
	return cb
}

func (cb *cloudBroker) start() {
	server := mochi.New(&mochi.Options{InlineClient: true})
	_ = server.AddHook(new(auth.AllowHook), nil)
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cb.pki.server},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    cb.pki.pool,
		MinVersion:   tls.VersionTLS12,
	}
	l := listeners.NewTCP(listeners.Config{ID: "mtls", Address: cb.addr, TLSConfig: tlsCfg})
	if err := server.AddListener(l); err != nil {
		cb.t.Fatal(err)
	}
	if err := server.Subscribe("ems/+/+/+/telemetry", 99, func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
		var m map[string]any
		if json.Unmarshal(pk.Payload, &m) == nil {
			cb.mu.Lock()
			cb.received = append(cb.received, m)
			cb.mu.Unlock()
		}
	}); err != nil {
		cb.t.Fatal(err)
	}
	go func() { _ = server.Serve() }()
	cb.server = server
}

func (cb *cloudBroker) stop() { _ = cb.server.Close() }

func (cb *cloudBroker) telemetryCount() int {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return len(cb.received)
}

func (cb *cloudBroker) telemetry() []map[string]any {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	out := make([]map[string]any, len(cb.received))
	copy(out, cb.received)
	return out
}

// telemetryCountForDevice counts arrived telemetry stamped with a device_id.
func (cb *cloudBroker) telemetryCountForDevice(device string) int {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	n := 0
	for _, m := range cb.received {
		if m["device_id"] == device {
			n++
		}
	}
	return n
}

func (cb *cloudBroker) publishRetainedSchedule(t *testing.T, payload []byte) {
	t.Helper()
	topic := fmt.Sprintf("ems/%s/%s/%s/schedule", tTenant, tSite, tDevice)
	if err := cb.server.Publish(topic, payload, true, 1); err != nil {
		t.Fatal(err)
	}
}

// --- enrollment stub over the real CA ---

func startEnrollmentStub(t *testing.T, p *pki, mqttPort int) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	var issued string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/enrollment/{ref}/csr", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CsrPem string `json:"csrPem"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.CsrPem == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		issued = p.issueClient(t, body.CsrPem) // ref claimed immediately
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("GET /api/v1/enrollment/{ref}/certificate", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cert := issued
		mu.Unlock()
		if cert == "" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"status":"pending"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deviceCertPem": cert,
			"caPem":         p.caPem,
			"mqttHost":      "localhost",
			"mqttPort":      mqttPort,
			"tenantId":      tTenant,
			"siteId":        tSite,
			"deviceId":      tDevice,
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// reclaimEnrollStub is an enrollment API stub whose issued device_id can be
// changed at runtime to model an unclaim+re-claim (the api re-issues the cert
// against the stored CSR for the new device row - EnrollmentService).
type reclaimEnrollStub struct {
	t        *testing.T
	pki      *pki
	mqttPort int
	srv      *httptest.Server

	mu     sync.Mutex
	csrPem string
	device string // current issued device_id
	issued string // cached cert for the current device
}

func startReclaimEnrollStub(t *testing.T, p *pki, mqttPort int) *reclaimEnrollStub {
	t.Helper()
	s := &reclaimEnrollStub{t: t, pki: p, mqttPort: mqttPort, device: tDevice}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/enrollment/{ref}/csr", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CsrPem string `json:"csrPem"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.CsrPem == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		s.csrPem = body.CsrPem
		s.mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("GET /api/v1/enrollment/{ref}/certificate", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.csrPem == "" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"status":"pending"}`))
			return
		}
		if s.issued == "" {
			s.issued = s.pki.issueClientAs(t, s.csrPem, s.device)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deviceCertPem": s.issued,
			"caPem":         s.pki.caPem,
			"mqttHost":      "localhost",
			"mqttPort":      s.mqttPort,
			"tenantId":      tTenant,
			"siteId":        tSite,
			"deviceId":      s.device,
		})
	})
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)
	return s
}

// reclaim points the ref at a new device row id, forcing a re-issue.
func (s *reclaimEnrollStub) reclaim(newDevice string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.device = newDevice
	s.issued = ""
}

// --- Layer-1 stand-in on the local bus ---

type layer1 struct {
	client pahomqtt.Client

	mu        sync.Mutex
	setpoints []map[string]any
}

func startLayer1(t *testing.T, busAddr string) *layer1 {
	t.Helper()
	l1 := &layer1{}
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-layer1").
		SetConnectTimeout(5 * time.Second)
	l1.client = pahomqtt.NewClient(opts)
	if tok := l1.client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("layer1 connect: %v", tok.Error())
	}
	if tok := l1.client.Subscribe("edge/setpoint", 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		var m map[string]any
		if json.Unmarshal(msg.Payload(), &m) == nil {
			l1.mu.Lock()
			l1.setpoints = append(l1.setpoints, m)
			l1.mu.Unlock()
		}
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("layer1 subscribe: %v", tok.Error())
	}
	t.Cleanup(func() { l1.client.Disconnect(100) })
	return l1
}

func (l *layer1) publishTelemetry(t *testing.T, ts time.Time, pv, load, soc, gridLimit float64) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"ts":            ts.UTC().Format(time.RFC3339Nano),
		"power_kw":      load - pv,
		"soc_pct":       soc,
		"pv_power_kw":   pv,
		"load_kw":       load,
		"grid_limit_kw": gridLimit,
	})
	if tok := l.client.Publish("edge/telemetry", 1, false, payload); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("layer1 telemetry publish: %v", tok.Error())
	}
}

func (l *layer1) lastSetpoint() (map[string]any, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.setpoints) == 0 {
		return nil, false
	}
	return l.setpoints[len(l.setpoints)-1], true
}

// --- helpers ---

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// --- the test ---

func TestFullLoopEnrollExecuteBufferReplay(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	p := newPKI(t)

	cloudPort := freePort(t)
	cloudAddr := fmt.Sprintf("127.0.0.1:%d", cloudPort)
	cb := startCloudBroker(t, p, cloudAddr)
	defer cb.stop()

	stub := startEnrollmentStub(t, p, cloudPort)

	busPort := freePort(t)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.URL
	cfg.Ref = "VP-ITEST-0001"
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", busPort)
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.SetpointIntervalSeconds = 1
	cfg.SetpointInterval = time.Second

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	// 1) Enrollment completes against the stub (pending->issued) and the
	// mTLS cloud link comes up with the device-generated key.
	waitFor(t, 30*time.Second, "cloud link up", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.PairingState == "verbunden"
	})
	if s := a.State.Get(); s.DeviceID != tDevice || s.TenantID != tTenant {
		t.Fatalf("enrolled identity: %+v", s)
	}

	// 2) Layer 1 publishes telemetry on the local bus -> it arrives
	// cloud-side as a contract payload with the ORIGINAL timestamp.
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	ts0 := time.Now().UTC().Add(-2 * time.Second).Truncate(time.Millisecond)
	l1.publishTelemetry(t, ts0, 12, 8, 50, 100)
	waitFor(t, 15*time.Second, "first telemetry cloud-side", func() bool { return cb.telemetryCount() >= 1 })

	first := cb.telemetry()[0]
	if first["schema_version"] != "1.0" || first["tenant_id"] != tTenant ||
		first["site_id"] != tSite || first["device_id"] != tDevice {
		t.Fatalf("telemetry not contract-shaped: %v", first)
	}
	gotTs, err := time.Parse(time.RFC3339Nano, first["ts"].(string))
	if err != nil || !gotTs.Equal(ts0) {
		t.Fatalf("original timestamp lost: %v (want %v)", first["ts"], ts0)
	}
	meas := first["measurements"].(map[string]any)
	if meas["pv_power_kw"].(float64) != 12 || meas["load_kw"].(float64) != 8 {
		t.Fatalf("measurements: %v", meas)
	}

	// 3) No schedule yet -> self-consumption fallback: pv 12 - load 8 = +4.
	waitFor(t, 10*time.Second, "self-consumption setpoint", func() bool {
		sp, ok := l1.lastSetpoint()
		return ok && sp["source"] == "default" && sp["battery_setpoint_kw"].(float64) == 4
	})
	if a.State.Get().Mode != state.ModeSelfConsume {
		t.Fatalf("mode: %v", a.State.Get().Mode)
	}

	// 4) A retained schedule commanding +999 kW arrives -> executed but
	// guard-clamped to the rated 50 kW, source=schedule.
	slotStart := time.Now().UTC().Truncate(15 * time.Minute)
	schedule, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"plan_id":        "99999999-9999-9999-9999-999999999999",
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"horizon_slots":  2,
		"slot_minutes":   15,
		"slots": []map[string]any{
			{"start": slotStart.Format(time.RFC3339), "battery_setpoint_kw": 999.0},
			{"start": slotStart.Add(15 * time.Minute).Format(time.RFC3339), "battery_setpoint_kw": 999.0},
		},
	})
	cb.publishRetainedSchedule(t, schedule)
	waitFor(t, 15*time.Second, "guarded schedule setpoint", func() bool {
		sp, ok := l1.lastSetpoint()
		return ok && sp["source"] == "schedule" && sp["battery_setpoint_kw"].(float64) == 50
	})
	if a.State.Get().Mode != state.ModeSchedule {
		t.Fatalf("mode: %v", a.State.Get().Mode)
	}

	// 5) Cloud outage: the broker goes away; telemetry keeps flowing on the
	// local bus and BUFFERS. (Setpoints keep working - offline autonomy.)
	cb.stop()
	waitFor(t, 15*time.Second, "link notices outage", func() bool { return !a.State.Get().CloudConnected })

	countBefore := cb.telemetryCount()
	var offlineTs []time.Time
	for i := 0; i < 5; i++ {
		ts := time.Now().UTC().Truncate(time.Millisecond)
		offlineTs = append(offlineTs, ts)
		l1.publishTelemetry(t, ts, 10, 6, 55, 100)
		time.Sleep(30 * time.Millisecond)
	}
	waitFor(t, 10*time.Second, "buffer growth during outage", func() bool {
		return a.State.Get().BufferPending >= 5
	})

	// 6) Reconnect: the SAME address comes back; the backlog replays
	// oldest-first with the original timestamps.
	cb.start()
	waitFor(t, 60*time.Second, "replay after reconnect", func() bool {
		return cb.telemetryCount() >= countBefore+5
	})
	replayed := cb.telemetry()[countBefore:]
	var prevSeq float64 = -1
	matched := 0
	for _, m := range replayed {
		seq := m["seq"].(float64)
		if seq <= prevSeq {
			t.Fatalf("replay out of order: seq %v after %v", seq, prevSeq)
		}
		prevSeq = seq
		ts, _ := time.Parse(time.RFC3339Nano, m["ts"].(string))
		for _, want := range offlineTs {
			if ts.Equal(want) {
				matched++
				break
			}
		}
	}
	if matched < 5 {
		t.Fatalf("replayed entries lost their original timestamps (%d/5 matched)", matched)
	}
	waitFor(t, 10*time.Second, "buffer drained", func() bool {
		return a.State.Get().BufferPending == 0
	})
}

// TestReconcileSwitchesIdentityWhileConnected proves the device-identity-drift
// fix: a connected edge whose device row id changes (unclaim + re-claim, or a
// DB reset + re-claim) re-reconciles its identity and resumes publishing under
// the CURRENT device_id - so the portal's Geräte tab reads online again instead
// of "wartet auf erste Daten" forever.
func TestReconcileSwitchesIdentityWhileConnected(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	const newDevice = "44444444-4444-4444-4444-444444444444"
	p := newPKI(t)

	cloudPort := freePort(t)
	cb := startCloudBroker(t, p, fmt.Sprintf("127.0.0.1:%d", cloudPort))
	defer cb.stop()

	stub := startReclaimEnrollStub(t, p, cloudPort)

	busPort := freePort(t)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.srv.URL
	cfg.Ref = "VP-ITEST-DRIFT-01"
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", busPort)
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.SetpointIntervalSeconds = 1
	cfg.SetpointInterval = time.Second
	// Re-check the identity aggressively so the test does not wait minutes.
	cfg.ReconcileInterval = 300 * time.Millisecond

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	// 1) Enroll + connect under the ORIGINAL identity.
	waitFor(t, 30*time.Second, "cloud link up", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.DeviceID == tDevice
	})

	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now().UTC(), 12, 8, 50, 100)
	waitFor(t, 15*time.Second, "telemetry under original device_id", func() bool {
		return cb.telemetryCountForDevice(tDevice) >= 1
	})

	// 2) The customer unclaims + re-claims -> the ref now maps to a new device
	// row id; the api re-issues the certificate for it.
	stub.reclaim(newDevice)

	// 3) The connected edge re-reconciles: it adopts the new identity, switches
	// the cloud link, and its persisted/live identity now reads the new id.
	waitFor(t, 30*time.Second, "identity switched to the re-claimed device", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.DeviceID == newDevice
	})

	// G2 regression: adopting the new identity must stop the OLD link's heartbeat
	// goroutine (per-link context cancel), not leak one per re-claim. Exactly one
	// heartbeat goroutine (the current link's) should remain.
	waitFor(t, 10*time.Second, "old heartbeat goroutine stopped after adoption", func() bool {
		return heartbeatGoroutines() == 1
	})

	// 4) Fresh telemetry now arrives under the CURRENT device_id - which is what
	// the portal's per-device liveness query keys on.
	countBefore := cb.telemetryCountForDevice(newDevice)
	l1.publishTelemetry(t, time.Now().UTC(), 10, 6, 55, 100)
	waitFor(t, 15*time.Second, "telemetry under re-claimed device_id", func() bool {
		return cb.telemetryCountForDevice(newDevice) > countBefore
	})

	// The adopted identity is persisted (survives a restart).
	e := &enroll.Enroller{Dir: filepath.Join(cfg.DataDir, "identity")}
	persisted, err := e.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.DeviceID != newDevice {
		t.Fatalf("persisted device id = %s, want %s", persisted.DeviceID, newDevice)
	}
}

// heartbeatGoroutines counts the live status-heartbeat goroutines spawned in
// startCloud, by scanning the full goroutine dump for their "created by ...
// startCloud" frame. Each cloud link has exactly one; a leak (G2) shows as >1.
func heartbeatGoroutines() int {
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	dump := string(buf[:n])
	count := 0
	for _, block := range strings.Split(dump, "\n\n") {
		if strings.Contains(block, "startCloud") {
			count++
		}
	}
	return count
}
