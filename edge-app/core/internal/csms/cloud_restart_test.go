package csms

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync/atomic"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

const restartTestClientID = "vp-ocpp-command-restart"

type restartTestBroker struct {
	server *mochi.Server
	addr   string
}

func newRestartTestBroker(t *testing.T) *restartTestBroker {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	b := &restartTestBroker{server: mochi.New(&mochi.Options{InlineClient: true}), addr: addr}
	if err := b.server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	if err := b.server.AddListener(listeners.NewTCP(listeners.Config{ID: "restart", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = b.server.Serve() }()
	t.Cleanup(func() { _ = b.server.Close() })
	return b
}

func (b *restartTestBroker) waitInflight(t *testing.T, clientID string, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if client, ok := b.server.Clients.Get(clientID); ok && client.State.Inflight.Len() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	client, ok := b.server.Clients.Get(clientID)
	got := -1
	if ok {
		got = client.State.Inflight.Len()
	}
	t.Fatalf("broker inflight for %q = %d (client=%v), want %d", clientID, got, ok, want)
}

func (b *restartTestBroker) dropAndWaitForReconnect(t *testing.T, clientID string) {
	t.Helper()
	old, ok := b.server.Clients.Get(clientID)
	if !ok {
		t.Fatalf("broker client %q not connected", clientID)
	}
	old.Stop(errors.New("forced abrupt socket loss"))
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if current, exists := b.server.Clients.Get(clientID); exists && current != old && current.StopTime() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("broker client %q did not reconnect after abrupt socket loss", clientID)
}

func newRestartTestServer(t *testing.T, dir string, clock *time.Time, failSave bool) (*Server, *writeCountingWsServer) {
	t.Helper()
	s, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return *clock },
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	if failSave {
		s.commands.beforeSave = func() error { return errors.New("forced watermark fsync failure") }
	}
	socket := &writeCountingWsServer{}
	s.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	s.transport = &transport{srv: s, wsrv: socket}
	return s, socket
}

func seedRestartTestLedger(t *testing.T, dir string, now, d1 time.Time) {
	t.Helper()
	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	ledger.entries["terminal-capacity-slot"] = commandLedgerEntry{ActionID: "terminal-capacity-slot",
		Fingerprint: "terminal", State: "responded", DeadlineAt: d1, UpdatedAt: now}
	for i := 0; len(ledger.entries) < commandLedgerLimit; i++ {
		id := fmt.Sprintf("restart-protected-%d", i)
		ledger.entries[id] = commandLedgerEntry{ActionID: id, Fingerprint: id, State: "sent",
			DeadlineAt: now.Add(time.Hour), UpdatedAt: now}
	}
	ledger.capacityBlockUntil = d1
	if err := ledger.save(); err != nil {
		t.Fatal(err)
	}
}

func newRestartCommandLink(t *testing.T, broker *restartTestBroker, clientID string, deliveries *atomic.Int32, results chan<- error, server *Server) *cloud.Link {
	t.Helper()
	link, err := cloud.New(cloud.Options{
		Identity: enroll.Identity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"},
		DevURL:   "tcp://" + broker.addr, DevClientID: clientID,
		OnCommand: func(payload []byte) bool {
			deliveries.Add(1)
			err := server.ExecuteCloudCommand(context.Background(), payload,
				CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"})
			results <- err
			return !errors.Is(err, ErrCommandStorage)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	link.Connect()
	deadline := time.Now().Add(10 * time.Second)
	for !link.Connected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !link.Connected() {
		t.Fatal("command link did not connect")
	}
	return link
}

func waitRestartResult(t *testing.T, results <-chan error) error {
	t.Helper()
	select {
	case err := <-results:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("command handler did not finish")
		return nil
	}
}

func publishRestartCommand(t *testing.T, broker *restartTestBroker, topic string, payload []byte) pahomqtt.Client {
	t.Helper()
	publisher := pahomqtt.NewClient(pahomqtt.NewClientOptions().AddBroker("tcp://" + broker.addr).
		SetClientID("vp-ocpp-command-publisher"))
	if token := publisher.Connect(); !token.WaitTimeout(10*time.Second) || token.Error() != nil {
		t.Fatalf("publisher connect: %v", token.Error())
	}
	if token := publisher.Publish(topic, 1, false, payload); !token.WaitTimeout(10*time.Second) || token.Error() != nil {
		t.Fatalf("command publish: %v", token.Error())
	}
	return publisher
}

func waitRestartDeliveries(t *testing.T, deliveries *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for deliveries.Load() < want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := deliveries.Load(); got != want {
		t.Fatalf("command deliveries = %d, want %d", got, want)
	}
}

func TestStorageFailureRedeliversExactlyOnceAcrossCleanAndAbruptRestart(t *testing.T) {
	for _, tc := range []struct {
		name  string
		clean bool
	}{{"clean_process_restart", true}, {"abrupt_socket_loss", false}} {
		t.Run(tc.name, func(t *testing.T) {
			broker := newRestartTestBroker(t)
			dir := t.TempDir()
			now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
			d1 := now.Add(20 * time.Second)
			seedRestartTestLedger(t, dir, now, d1)
			clock := now
			deliveries := &atomic.Int32{}
			results := make(chan error, 4)
			firstServer, firstSocket := newRestartTestServer(t, dir, &clock, true)
			clientID := restartTestClientID + "-" + tc.name
			firstLink := newRestartCommandLink(t, broker, clientID, deliveries, results, firstServer)
			topic := "ems/tenant-a/site-a/device-a/command"
			raw := cloudCommand(now, func(c *CloudCommand) {
				c.ActionID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
				c.CorrelationID = "ocpp-" + c.ActionID
				c.DeadlineAt = now.Add(50 * time.Second).Format(time.RFC3339Nano)
			})
			publisher := publishRestartCommand(t, broker, topic, raw)
			defer publisher.Disconnect(100)
			waitRestartDeliveries(t, deliveries, 1)
			if err := waitRestartResult(t, results); !errors.Is(err, ErrCommandStorage) {
				t.Fatalf("first command result = %v, want retryable storage failure", err)
			}
			broker.waitInflight(t, clientID, 1)
			if firstSocket.writes != 0 {
				t.Fatalf("storage failure wrote %d station frames", firstSocket.writes)
			}
			if _, _, ok := firstServer.NextProtocolEvent(); ok {
				t.Fatal("storage failure emitted terminal cloud evidence")
			}

			clock = d1
			if tc.clean {
				firstLink.Close()
				firstServer.transport = nil
				firstServer.Stop()
				secondServer, secondSocket := newRestartTestServer(t, dir, &clock, false)
				defer func() { secondServer.transport = nil; secondServer.Stop() }()
				secondLink := newRestartCommandLink(t, broker, clientID, deliveries, results, secondServer)
				waitRestartDeliveries(t, deliveries, 2)
				if err := waitRestartResult(t, results); err != nil {
					t.Fatalf("clean restart replay result = %v, want durable success", err)
				}
				broker.waitInflight(t, clientID, 0)
				if secondSocket.writes != 1 {
					t.Fatalf("clean restart station writes = %d, want 1", secondSocket.writes)
				}
				secondLink.Close()
				thirdLink := newRestartCommandLink(t, broker, clientID, deliveries, results, secondServer)
				defer thirdLink.Close()
				time.Sleep(300 * time.Millisecond)
				waitRestartDeliveries(t, deliveries, 2)
				broker.waitInflight(t, clientID, 0)
				return
			}

			firstServer.commands.beforeSave = nil
			broker.dropAndWaitForReconnect(t, clientID)
			waitRestartDeliveries(t, deliveries, 2)
			if err := waitRestartResult(t, results); err != nil {
				t.Fatalf("abrupt reconnect replay result = %v, want durable success", err)
			}
			broker.waitInflight(t, clientID, 0)
			if firstSocket.writes != 1 {
				t.Fatalf("abrupt reconnect station writes = %d, want 1", firstSocket.writes)
			}
			broker.dropAndWaitForReconnect(t, clientID)
			time.Sleep(300 * time.Millisecond)
			waitRestartDeliveries(t, deliveries, 2)
			broker.waitInflight(t, clientID, 0)
			firstLink.Close()
			firstServer.transport = nil
			firstServer.Stop()
		})
	}
}
