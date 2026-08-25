package agent

// Integration test for the data purge ("Datenaufzeichnungen löschen"), device
// side, against the same in-process mTLS cloud broker + enrollment stub as the
// full-loop test (see agent_integration_test.go for the harness).
//
// Proves the OFFLINE-first round trip: the customer purges while the cloud is
// away -> local buffer + history wiped immediately, the request is queued;
// samples recorded AFTER the purge buffer normally; on reconnect the queued
// purge_request goes out on the device's own status topic; the cloud's
// retained purge_data command confirms it; and only post-purge samples ever
// reach the cloud - the purged history is gone on both sides.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
)

func TestFailedLocalPurgeKeepsRestartSafeIntentAndRetriesCleanup(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = "127.0.0.1:0"
	cfg.HTTPAddr = "127.0.0.1:0"
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.purgeOcpp = func(time.Time) error { return errors.New("injected OCPP remove failure") }
	if _, err := a.PurgeRecordedData(); err == nil {
		t.Fatal("local OCPP failure was reported as a successful purge")
	}
	pending, ok := a.loadPendingPurge()
	if !ok || !pending.LocalCleanupPending {
		t.Fatalf("cloud intent was not persisted before cleanup failure: %+v / %v", pending, ok)
	}
	if got := a.State.Get().DataPurge; got == nil || got.LocalState != "fehler" {
		t.Fatalf("local retry state not visible: %+v", got)
	}
	a.Stop()

	// A new process restores the intent. Once the injected storage failure is
	// gone, startup cleanup is idempotently retried and marked complete while
	// the cloud request itself remains queued until confirmation.
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Stop()
	if got := restarted.State.Get().DataPurge; got == nil || got.LocalState != "ausstehend" {
		t.Fatalf("restart did not surface pending local cleanup: %+v", got)
	}
	restarted.retryPendingLocalPurge()
	pending, ok = restarted.loadPendingPurge()
	if !ok || pending.LocalCleanupPending {
		t.Fatalf("recovered cleanup did not retain/advance cloud intent: %+v / %v", pending, ok)
	}
	if got := restarted.State.Get().DataPurge; got == nil || got.LocalState != "bereinigt" {
		t.Fatalf("recovered local cleanup not visible: %+v", got)
	}
}

func TestPurgeDoesNotTouchLocalRecordingsUntilCloudIntentIsDurable(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = "127.0.0.1:0"
	cfg.HTTPAddr = "127.0.0.1:0"
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	old := time.Now().UTC().Add(-time.Hour)
	if _, err := a.buf.Append(old, map[string]float64{"power_kw": 1}); err != nil {
		t.Fatal(err)
	}
	a.hist.Add(history.Sample{Ts: old})
	cleanupCalled := false
	a.purgeOcpp = func(time.Time) error {
		cleanupCalled = true
		return nil
	}
	// savePendingPurge writes this exact temporary path before its atomic
	// rename. A directory there is a deterministic, cross-platform write fault.
	if err := os.Mkdir(a.purgeRequestPath()+".tmp", 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := a.PurgeRecordedData(); err == nil {
		t.Fatal("intent persistence failure was reported as a successful purge")
	}
	if cleanupCalled {
		t.Fatal("local cleanup ran before cloud intent became restart-safe")
	}
	if got := a.buf.Pending(); got != 1 {
		t.Fatalf("buffer changed before durable intent: pending=%d", got)
	}
	if got := a.hist.Len(); got != 1 {
		t.Fatalf("history changed before durable intent: len=%d", got)
	}
	if _, err := os.Stat(a.purgeRequestPath()); !os.IsNotExist(err) {
		t.Fatalf("failed intent unexpectedly produced final request: %v", err)
	}
}

func TestDataPurgeOfflineRoundTrip(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	p := newPKI(t)

	cloudPort := freePort(t)
	cloudAddr := fmt.Sprintf("127.0.0.1:%d", cloudPort)
	cb := startCloudBroker(t, p, cloudAddr)
	defer cb.stop()

	// Capture purge_requests arriving on the status topic (heartbeats carry no
	// `type` field and are filtered out).
	var reqMu sync.Mutex
	var purgeRequests []map[string]any
	subscribePurgeRequests := func() {
		if err := cb.server.Subscribe("ems/+/+/+/status", 98, func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
			var m map[string]any
			if json.Unmarshal(pk.Payload, &m) == nil && m["type"] == "purge_request" {
				reqMu.Lock()
				purgeRequests = append(purgeRequests, m)
				reqMu.Unlock()
			}
		}); err != nil {
			t.Fatal(err)
		}
	}
	subscribePurgeRequests()
	purgeRequestCount := func() int {
		reqMu.Lock()
		defer reqMu.Unlock()
		return len(purgeRequests)
	}

	stub := startEnrollmentStub(t, p, cloudPort)

	busPort := freePort(t)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.URL
	cfg.Ref = "VP-ITEST-PURGE-01"
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

	waitFor(t, 30*time.Second, "cloud link up", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.PairingState == "verbunden"
	})

	// 1) Normal operation, then a cloud outage with buffered history.
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now().UTC(), 12, 8, 50, 100)
	waitFor(t, 15*time.Second, "telemetry cloud-side", func() bool { return cb.telemetryCount() >= 1 })

	cb.stop()
	waitFor(t, 15*time.Second, "link notices outage", func() bool { return !a.State.Get().CloudConnected })

	var preTs []time.Time
	for i := 0; i < 5; i++ {
		ts := time.Now().UTC().Truncate(time.Millisecond)
		preTs = append(preTs, ts)
		l1.publishTelemetry(t, ts, 10, 6, 55, 100)
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, 10*time.Second, "outage backlog buffered", func() bool {
		return a.State.Get().BufferPending >= 5
	})
	waitFor(t, 10*time.Second, "outage samples in local history", func() bool {
		return a.History().Len() >= 5
	})

	// 2) The customer purges WHILE OFFLINE: local recordings are wiped at once,
	// the cloud request is queued explicitly.
	info, err := a.PurgeRecordedData()
	if err != nil {
		t.Fatal(err)
	}
	if info.CloudState != "ausstehend" {
		t.Fatalf("cloud state while offline = %q, want ausstehend", info.CloudState)
	}
	if got := a.State.Get().BufferPending; got != 0 {
		t.Fatalf("buffer pending after purge = %d, want 0", got)
	}
	if got := a.History().Len(); got != 0 {
		t.Fatalf("history length after purge = %d, want 0", got)
	}
	if _, err := os.Stat(a.purgeRequestPath()); err != nil {
		t.Fatalf("pending purge request not persisted: %v", err)
	}

	// 3) Samples recorded AFTER the purge buffer normally (they are new data,
	// not purged history).
	time.Sleep(10 * time.Millisecond) // strictly after the purge instant
	var postTs []time.Time
	for i := 0; i < 2; i++ {
		ts := time.Now().UTC().Truncate(time.Millisecond)
		postTs = append(postTs, ts)
		l1.publishTelemetry(t, ts, 9, 5, 60, 100)
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, 10*time.Second, "post-purge samples buffered", func() bool {
		return a.State.Get().BufferPending == 2
	})

	// 4) Reconnect: the queued purge_request goes out on the device's own
	// status topic with the device's identity.
	countBefore := cb.telemetryCount()
	cb.start()
	subscribePurgeRequests() // fresh broker instance -> re-subscribe
	waitFor(t, 60*time.Second, "queued purge request sent on reconnect", func() bool {
		return purgeRequestCount() >= 1
	})
	reqMu.Lock()
	req := purgeRequests[0]
	reqMu.Unlock()
	if req["tenant_id"] != tTenant || req["site_id"] != tSite || req["device_id"] != tDevice {
		t.Fatalf("purge request identity: %v", req)
	}
	requestedAt, err := time.Parse(time.RFC3339Nano, req["ts"].(string))
	if err != nil {
		t.Fatalf("purge request ts: %v", err)
	}
	waitFor(t, 10*time.Second, "state moves to angefordert", func() bool {
		dp := a.State.Get().DataPurge
		return dp != nil && dp.CloudState == "angefordert"
	})

	// 5) The cloud purges and answers with the RETAINED purge_data command
	// (watermark = the request instant): the device treats it as confirmation.
	command, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"type":           "purge_data",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"purged_before":  requestedAt.Format(time.RFC3339Nano),
	})
	topic := fmt.Sprintf("ems/%s/%s/%s/command", tTenant, tSite, tDevice)
	if err := cb.server.Publish(topic, command, true, 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, "purge confirmed", func() bool {
		dp := a.State.Get().DataPurge
		return dp != nil && dp.CloudState == "bestaetigt"
	})
	if _, err := os.Stat(a.purgeRequestPath()); !os.IsNotExist(err) {
		t.Fatalf("pending purge request should be cleared, stat err = %v", err)
	}

	// 6) Only the POST-purge samples reach the cloud; the purged outage backlog
	// never does.
	waitFor(t, 30*time.Second, "post-purge samples uploaded", func() bool {
		return cb.telemetryCount() >= countBefore+2
	})
	waitFor(t, 10*time.Second, "buffer drained", func() bool {
		return a.State.Get().BufferPending == 0
	})
	for _, m := range cb.telemetry()[countBefore:] {
		ts, err := time.Parse(time.RFC3339Nano, m["ts"].(string))
		if err != nil {
			t.Fatal(err)
		}
		for _, purged := range preTs {
			if ts.Equal(purged) {
				t.Fatalf("purged sample resurfaced cloud-side: %v", ts)
			}
		}
	}
	matched := 0
	for _, m := range cb.telemetry()[countBefore:] {
		ts, _ := time.Parse(time.RFC3339Nano, m["ts"].(string))
		for _, want := range postTs {
			if ts.Equal(want) {
				matched++
			}
		}
	}
	if matched < 2 {
		t.Fatalf("post-purge samples lost (%d/2 uploaded)", matched)
	}
}

func TestFailedLocalPurgeRequestIsRepublishedAfterProcessRestartAndReconnect(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	p := newPKI(t)
	cloudPort := freePort(t)
	cb := startCloudBroker(t, p, fmt.Sprintf("127.0.0.1:%d", cloudPort))
	defer cb.stop()
	stub := startEnrollmentStub(t, p, cloudPort)

	var reqMu sync.Mutex
	var requests []map[string]any
	subscribe := func() {
		if err := cb.server.Subscribe("ems/+/+/+/status", 97,
			func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
				var m map[string]any
				if json.Unmarshal(pk.Payload, &m) == nil && m["type"] == "purge_request" {
					reqMu.Lock()
					requests = append(requests, m)
					reqMu.Unlock()
				}
			}); err != nil {
			t.Fatal(err)
		}
	}
	subscribe()

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.URL
	cfg.Ref = "VP-ITEST-PURGE-RESTART-01"
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.SetpointIntervalSeconds = 1
	cfg.SetpointInterval = time.Second

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 30*time.Second, "first process connected", func() bool {
		return a.State.Get().CloudConnected
	})
	cb.stop()
	waitFor(t, 15*time.Second, "first process notices outage", func() bool {
		return !a.State.Get().CloudConnected
	})
	a.purgeOcpp = func(time.Time) error { return errors.New("injected local journal I/O failure") }
	if _, err := a.PurgeRecordedData(); err == nil {
		t.Fatal("injected local purge failure was not surfaced")
	}
	want, ok := a.loadPendingPurge()
	if !ok || !want.LocalCleanupPending {
		t.Fatalf("failed local purge lost cloud intent: %+v / %v", want, ok)
	}
	cancel()
	a.Stop()

	// Simulate a new process with recovered local storage but no cloud. Start
	// retries local cleanup before the broker reconnect path can publish.
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	if err := restarted.Start(ctx2); err != nil {
		t.Fatal(err)
	}
	defer restarted.Stop()
	if pending, ok := restarted.loadPendingPurge(); !ok || pending.LocalCleanupPending {
		t.Fatalf("startup did not retry local cleanup: %+v / %v", pending, ok)
	}

	cb.start()
	subscribe()
	waitFor(t, 60*time.Second, "restart-safe purge request sent after reconnect", func() bool {
		reqMu.Lock()
		defer reqMu.Unlock()
		return len(requests) > 0
	})
	reqMu.Lock()
	got := requests[len(requests)-1]
	reqMu.Unlock()
	gotAt, err := time.Parse(time.RFC3339Nano, got["ts"].(string))
	if err != nil || !gotAt.Equal(want.RequestedAt) {
		t.Fatalf("reconnect changed/lost original purge intent: %v / %v", got, err)
	}
}

// TestPortalPurgeCommandWipesLocalBuffers models the PORTAL-initiated purge on
// a connected device: the retained purge_data command alone (no local trigger)
// wipes the buffered backlog and the live history up to the watermark.
func TestPortalPurgeCommandWipesLocalBuffers(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	p := newPKI(t)

	cloudPort := freePort(t)
	cb := startCloudBroker(t, p, fmt.Sprintf("127.0.0.1:%d", cloudPort))
	defer cb.stop()
	stub := startEnrollmentStub(t, p, cloudPort)

	busPort := freePort(t)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.URL
	cfg.Ref = "VP-ITEST-PURGE-02"
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

	waitFor(t, 30*time.Second, "cloud link up", func() bool {
		return a.State.Get().CloudConnected
	})

	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now().UTC(), 12, 8, 50, 100)
	waitFor(t, 15*time.Second, "history filled", func() bool { return a.History().Len() >= 1 })

	command, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"type":           "purge_data",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"purged_before":  time.Now().UTC().Format(time.RFC3339Nano),
	})
	topic := fmt.Sprintf("ems/%s/%s/%s/command", tTenant, tSite, tDevice)
	if err := cb.server.Publish(topic, command, true, 1); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, "local history wiped by the portal purge", func() bool {
		return a.History().Len() == 0 && a.State.Get().BufferPending == 0
	})

	// A command addressed to ANOTHER device must be ignored.
	before := a.History().Len()
	l1.publishTelemetry(t, time.Now().UTC(), 9, 4, 61, 100)
	waitFor(t, 10*time.Second, "fresh sample recorded", func() bool { return a.History().Len() > before })
	foreign, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"type":           "purge_data",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      "99999999-9999-9999-9999-999999999999",
		"purged_before":  time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := cb.server.Publish(topic, foreign, true, 1); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	if a.History().Len() == 0 {
		t.Fatal("a purge command for another device must be ignored")
	}
}
