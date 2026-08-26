package cloud

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

func TestMeasurementConfigQoS1IsAckedAfterDurableAdoptionAndOnlyAdoptedOnceAcrossRestart(t *testing.T) {
	sink := startStatusSink(t)
	topic := fmt.Sprintf("ems/%s/%s/%s/v2/measurement-config", testTenant, testSite, testDevice)
	payload := []byte(`{"schema_version":"2.0","revision":7}`)
	publisher := measurementConfigPublisher(t, sink, "vp-measurement-config-publisher")
	if token := publisher.Publish(topic, 1, true, payload); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publish retained measurement config: %v", token.Error())
	}

	path := filepath.Join(t.TempDir(), "measurement-config.json")
	var deliveries atomic.Int32
	var adoptions atomic.Int32
	adopt := func(raw []byte) bool {
		deliveries.Add(1)
		stored, err := os.ReadFile(path)
		if err == nil && bytes.Equal(stored, raw) {
			return true
		}
		if err != nil && !os.IsNotExist(err) {
			return false
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return false
		}
		adoptions.Add(1)
		return true
	}

	const clientID = "vp-measurement-config-manual-ack"
	first := connectedMeasurementConfigLink(t, sink, clientID, adopt)
	waitAtomic(t, &deliveries, 1, "first measurement-config delivery")
	waitBrokerInflight(t, sink, clientID, 0)
	if got := adoptions.Load(); got != 1 {
		t.Fatalf("durable adoptions after first delivery = %d, want 1", got)
	}
	first.Close()

	// A process-new Paho client resumes the same persistent session. OnConnect
	// resubscribes the retained desired document, but the durable receiver sees
	// the exact bytes and treats them as the already adopted outcome.
	second := connectedMeasurementConfigLink(t, sink, clientID, adopt)
	t.Cleanup(second.Close)
	waitAtomic(t, &deliveries, 2, "restart retained redelivery")
	waitBrokerInflight(t, sink, clientID, 0)
	if got := adoptions.Load(); got != 1 {
		t.Fatalf("durable adoptions across reconnect/restart = %d, want exactly 1", got)
	}
	stored, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(stored, payload) {
		t.Fatalf("durable desired document = %q, err=%v", stored, err)
	}
}

func TestMeasurementConfigFailureRemainsUnacknowledgedInRealBroker(t *testing.T) {
	sink := startStatusSink(t)
	topic := fmt.Sprintf("ems/%s/%s/%s/v2/measurement-config", testTenant, testSite, testDevice)
	publisher := measurementConfigPublisher(t, sink, "vp-measurement-config-failure-publisher")
	if token := publisher.Publish(topic, 1, true, []byte(`{"schema_version":"2.0","revision":8}`)); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publish retained measurement config: %v", token.Error())
	}

	var deliveries atomic.Int32
	const clientID = "vp-measurement-config-failure"
	link := connectedMeasurementConfigLink(t, sink, clientID, func([]byte) bool {
		deliveries.Add(1)
		return false
	})
	t.Cleanup(link.Close)
	waitAtomic(t, &deliveries, 1, "failed measurement-config delivery")
	waitBrokerInflight(t, sink, clientID, 1)
}

func measurementConfigPublisher(t *testing.T, sink *statusSink, clientID string) pahomqtt.Client {
	t.Helper()
	publisher := pahomqtt.NewClient(pahomqtt.NewClientOptions().AddBroker("tcp://" + sink.addr).
		SetClientID(clientID))
	if token := publisher.Connect(); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publisher connect: %v", token.Error())
	}
	t.Cleanup(func() { publisher.Disconnect(100) })
	return publisher
}

func connectedMeasurementConfigLink(t *testing.T, sink *statusSink, clientID string, adopt func([]byte) bool) *Link {
	t.Helper()
	link, err := New(Options{
		Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL:   "tcp://" + sink.addr, DevClientID: clientID, OnMeasurementConfig: adopt,
	})
	if err != nil {
		t.Fatal(err)
	}
	link.Connect()
	deadline := time.Now().Add(5 * time.Second)
	for !link.Connected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !link.Connected() {
		t.Fatal("measurement-config link did not connect")
	}
	return link
}

func waitAtomic(t *testing.T, value *atomic.Int32, want int32, label string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for value.Load() < want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := value.Load(); got != want {
		t.Fatalf("%s count = %d, want %d", label, got, want)
	}
}

func waitBrokerInflight(t *testing.T, sink *statusSink, clientID string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if client, ok := sink.server.Clients.Get(clientID); ok && client.State.Inflight.Len() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	client, ok := sink.server.Clients.Get(clientID)
	got := -1
	if ok {
		got = client.State.Inflight.Len()
	}
	t.Fatalf("broker client %q present=%v inflight=%d, want %d", clientID, ok, got, want)
}
