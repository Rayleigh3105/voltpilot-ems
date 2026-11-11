package csms

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

// syncBuffer is a log sink the handler goroutine and the test share.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (w *syncBuffer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *syncBuffer) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}

// reconnectRig is a station with phase limits (start only after its profiles
// are confirmed for its current boot) that was set up, charged once, and has
// just reconnected with a BootNotification - the go-e does that on every
// reconnect. Its set-up for the new boot has not finished.
type reconnectRig struct {
	*clockRig
	log *syncBuffer
	tx1 int
}

func newReconnectRig(t *testing.T) *reconnectRig {
	t.Helper()
	now := time.Date(2026, 11, 7, 8, 47, 0, 0, time.UTC)
	r := &reconnectRig{clockRig: &clockRig{now: now, dir: t.TempDir()}, log: &syncBuffer{}}
	s, err := New(Options{Enabled: true, DataDir: r.dir, Now: r.clock,
		Log: slog.New(slog.NewTextHandler(r.log, nil))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(AddRequest{ID: "CP"}); err != nil {
		t.Fatal(err)
	}
	r.s, r.h = s, &coreHandler{srv: s}

	s.onConnect("CP")
	s.onStatus("CP", 1, StatusAvailable, "NoError", r.clock())
	p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "free"}, PhaseLimitsA: []float64{16, 16, 16},
		Electrical: []ocppcontrol.Electrical{{ChargePointID: "CP", ConnectorID: 1, VoltageV: 230, Phases: []int{1, 2, 3}, MaxCurrentA: 16, PhaseSwitching: true}}}
	if err := s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	r.commission(nil)
	r.tx1 = r.start(t, r.clock(), 1000)
	if r.tx1 < 1 {
		t.Fatalf("first start on a set-up station refused: %d", r.tx1)
	}
	r.advance(time.Minute)
	s.onDisconnect("CP")
	r.advance(5 * time.Second)
	s.onConnect("CP")
	s.onBoot("CP", bootInfo{Vendor: "go-e", Model: "go-eCharger_V4", Firmware: "59.4"}, r.clock())
	r.stop(t, r.tx1, r.clock())
	r.advance(time.Second)
	if s.startReady("CP") {
		t.Fatal("start ready before the set-up of the new boot")
	}
	return r
}

func (r *reconnectRig) commission(err error) {
	max, fallback := 11.04, 11.04
	if err != nil {
		r.s.recordCommission("CP", nil, nil, err)
		return
	}
	r.s.recordCommission("CP", &max, &fallback, nil)
}

// startAsync sends the StartTransaction the way ocpp-go does: in its own
// goroutine, while the set-up keeps running.
func (r *reconnectRig) startAsync(at time.Time) <-chan *core.StartTransactionConfirmation {
	out := make(chan *core.StartTransactionConfirmation, 1)
	go func() {
		conf, err := r.h.OnStartTransaction("CP", &core.StartTransactionRequest{
			ConnectorId: 1, IdTag: "card", MeterStart: 2000, Timestamp: types.NewDateTime(at)})
		if err != nil {
			conf = nil
		}
		out <- conf
	}()
	return out
}

func waitLog(t *testing.T, log *syncBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(log.String(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("log line %q missing:\n%s", want, log.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestStartDuringSetUpAfterReconnectWaitsAndIsAccepted is the regression of
// the pilot finding: the station reconnected (BootNotification) exactly when
// the car began to charge, its StartTransaction arrived before the set-up was
// through and got Invalid / id 0 - the station then ended the charge and never
// tried again while the car stayed plugged in. Now the start waits for the
// set-up and is accepted with a real id.
func TestStartDuringSetUpAfterReconnectWaitsAndIsAccepted(t *testing.T) {
	r := newReconnectRig(t)
	got := r.startAsync(r.clock())
	waitLog(t, r.log, "Ladevorgang wartet auf die Einrichtung")
	select {
	case conf := <-got:
		t.Fatalf("start answered before the set-up finished: %+v", conf)
	case <-time.After(50 * time.Millisecond):
	}

	// The agent's Commission: "being set up" first, then confirmed.
	r.advance(time.Second)
	r.commission(errors.New(commissionRunning))
	select {
	case conf := <-got:
		t.Fatalf("start answered while the set-up was still running: %+v", conf)
	case <-time.After(50 * time.Millisecond):
	}
	r.advance(2 * time.Second)
	r.commission(nil)

	var conf *core.StartTransactionConfirmation
	select {
	case conf = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("start still waiting after the set-up was confirmed")
	}
	if conf == nil || conf.IdTagInfo.Status != types.AuthorizationStatusAccepted || conf.TransactionId <= r.tx1 {
		t.Fatalf("start after set-up = %+v, want Accepted with a new id", conf)
	}
	c, _ := r.s.Snapshot().ChargerByID("CP")
	if sess := c.ConnectorByID(1).Session; sess == nil || sess.TransactionID != conf.TransactionId {
		t.Fatalf("no session for the accepted start: %+v", c.ConnectorByID(1))
	}
	if strings.Contains(r.log.String(), "Ladevorgang abgelehnt") {
		t.Fatalf("accepted start logged a refusal:\n%s", r.log.String())
	}
}

// TestStartDuringFailedSetUpStaysInvalidAndSaysWhy: a set-up that fails ends
// the wait at once and the start is refused as before - a start only counts
// once the profiles are in force. The refusal names its reason.
func TestStartDuringFailedSetUpStaysInvalidAndSaysWhy(t *testing.T) {
	r := newReconnectRig(t)
	got := r.startAsync(r.clock())
	waitLog(t, r.log, "Ladevorgang wartet auf die Einrichtung")
	r.commission(errors.New(commissionRunning))
	r.commission(errors.New("die Ladesäule hat ihre Fähigkeiten nicht gemeldet: timeout"))

	var conf *core.StartTransactionConfirmation
	select {
	case conf = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("start still waiting after the set-up failed")
	}
	if conf == nil || conf.IdTagInfo.Status != types.AuthorizationStatusInvalid || conf.TransactionId != 0 {
		t.Fatalf("start after failed set-up = %+v, want Invalid / 0", conf)
	}
	c, _ := r.s.Snapshot().ChargerByID("CP")
	if c.ConnectorByID(1).Session != nil {
		t.Fatal("refused start opened a session")
	}
	log := r.log.String()
	if !strings.Contains(log, "Ladevorgang abgelehnt") || !strings.Contains(log, "Fähigkeiten nicht gemeldet") {
		t.Fatalf("refusal without its reason in the log:\n%s", log)
	}
}

// TestStartWaitForSetUpIsBounded: a set-up that never finishes does not hold
// the station's request forever; the start is refused and logged.
func TestStartWaitForSetUpIsBounded(t *testing.T) {
	old := startCommissionWait
	startCommissionWait = 100 * time.Millisecond
	t.Cleanup(func() { startCommissionWait = old })
	r := newReconnectRig(t)
	got := r.startAsync(r.clock())

	var conf *core.StartTransactionConfirmation
	select {
	case conf = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("wait for the set-up is not bounded")
	}
	if conf == nil || conf.IdTagInfo.Status != types.AuthorizationStatusInvalid || conf.TransactionId != 0 {
		t.Fatalf("start after timeout = %+v, want Invalid / 0", conf)
	}
	if log := r.log.String(); !strings.Contains(log, "Ladevorgang abgelehnt") || !strings.Contains(log, "seit ihrem Neustart noch nicht eingerichtet") {
		t.Fatalf("timeout refusal without its reason in the log:\n%s", log)
	}
}

// TestStartRefusedForUnknownCardIsLoggedWithoutWaiting: a card the policy
// does not allow is refused at once - the set-up is not waited for - and the
// refusal is logged with its reason.
func TestStartRefusedForUnknownCardIsLoggedWithoutWaiting(t *testing.T) {
	r := newReconnectRig(t)
	p := r.s.ControlPolicy()
	p.Revision++
	p.Authorization = ocppcontrol.Authorization{Mode: "allowlist"}
	if err := r.s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	conf := <-r.startAsync(r.clock())
	if time.Since(began) > time.Second {
		t.Fatal("refused card waited for the set-up")
	}
	if conf == nil || conf.IdTagInfo.Status != types.AuthorizationStatusInvalid {
		t.Fatalf("unknown card = %+v, want Invalid", conf)
	}
	if log := r.log.String(); !strings.Contains(log, "Karte nicht freigegeben") {
		t.Fatalf("card refusal not logged:\n%s", log)
	}
}
