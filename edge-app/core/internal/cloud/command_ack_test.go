package cloud

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

type commandAckMessage struct {
	payload []byte
	acks    int
}

func (m *commandAckMessage) Duplicate() bool { return true }
func (m *commandAckMessage) Qos() byte       { return 1 }
func (m *commandAckMessage) Retained() bool  { return false }
func (m *commandAckMessage) Topic() string   { return "ems/t/s/d/command" }
func (m *commandAckMessage) MessageID() uint16 {
	return 7
}
func (m *commandAckMessage) Payload() []byte { return m.payload }
func (m *commandAckMessage) Ack()            { m.acks++ }

func TestCommandMessageAcknowledgesOnlyDurablyDecidedOutcome(t *testing.T) {
	retryable := &commandAckMessage{payload: []byte(`{"type":"ocpp_command"}`)}
	handleCommandMessage(func([]byte) bool { return false }, retryable)
	if retryable.acks != 0 {
		t.Fatalf("retryable storage failure ACK count = %d, want 0", retryable.acks)
	}

	terminal := &commandAckMessage{payload: []byte(`{"type":"ocpp_command"}`)}
	handleCommandMessage(func([]byte) bool { return true }, terminal)
	if terminal.acks != 1 {
		t.Fatalf("durably decided command ACK count = %d, want 1", terminal.acks)
	}

	empty := &commandAckMessage{}
	handleCommandMessage(func([]byte) bool { t.Fatal("empty command must not be dispatched"); return false }, empty)
	if empty.acks != 1 {
		t.Fatalf("empty command ACK count = %d, want 1", empty.acks)
	}
}

func TestMeasurementConfigAcknowledgesOnlyDurableAdoption(t *testing.T) {
	retryable := &commandAckMessage{payload: []byte(`{"revision":2}`)}
	handleMeasurementConfigMessage(func([]byte) bool { return false }, retryable)
	if retryable.acks != 0 {
		t.Fatalf("failed measurement-config adoption ACK count = %d, want 0", retryable.acks)
	}

	adopted := &commandAckMessage{payload: []byte(`{"revision":2}`)}
	handleMeasurementConfigMessage(func([]byte) bool { return true }, adopted)
	if adopted.acks != 1 {
		t.Fatalf("durably adopted measurement-config ACK count = %d, want 1", adopted.acks)
	}

	empty := &commandAckMessage{}
	handleMeasurementConfigMessage(func([]byte) bool {
		t.Fatal("empty retained clear must not be dispatched")
		return false
	}, empty)
	if empty.acks != 1 {
		t.Fatalf("empty retained clear ACK count = %d, want 1", empty.acks)
	}
}

func TestNewRegistersEveryLocalDownlinkRouteBeforeConnect(t *testing.T) {
	handler := func([]byte) {}
	link, err := New(Options{
		Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
		DevURL:   "tcp://127.0.0.1:1", OnSchedule: handler,
		OnCommand: func([]byte) bool { return true }, OnEntities: handler, OnPlanV2: handler,
		OnFlows: handler, OnUpdateTarget: handler,
		OnProbeRequest: handler, OnRegisterWrite: handler, OnDesiredDownlink: handler,
		OnControlCert: handler, OnChargingConfig: handler, OnChargingBoost: handler,
		OnMeasurementConfig: func([]byte) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	if link.client.IsConnected() {
		t.Fatal("New must not start the network connection")
	}
	if !link.routesReady {
		t.Fatal("all local routes must be ready before Connect can resume a persistent session")
	}
	want := map[string]bool{}
	for _, leaf := range []string{"schedule", "command", "v2/entities", "v2/plan", "v2/flows",
		"v2/update", "v2/control-certification", "v2/charging-config",
		"v2/charging-boost", "v2/probe", "v2/register-write", "v2/desired",
		"v2/measurement-config"} {
		want[link.topic(leaf)] = true
	}
	if len(link.downlinks) != len(want) {
		t.Fatalf("pre-registered routes = %d, want %d", len(link.downlinks), len(want))
	}
	for _, route := range link.downlinks {
		if !want[route.topic] || route.handler == nil {
			t.Fatalf("unexpected or handlerless pre-connect route %q", route.topic)
		}
		delete(want, route.topic)
	}
	if len(want) != 0 {
		t.Fatalf("routes missing before Connect: %v", want)
	}
}

func TestNonCommandDownlinksKeepTheirExplicitAckAndEmptyPayloadSemantics(t *testing.T) {
	var calls int
	nonEmpty := &commandAckMessage{payload: []byte(`{"value":1}`)}
	ackingDownlink(func([]byte) { calls++ }, false)(nil, nonEmpty)
	if calls != 1 || nonEmpty.acks != 1 {
		t.Fatalf("non-empty downlink calls=%d ACKs=%d, want 1/1", calls, nonEmpty.acks)
	}

	ignoredEmpty := &commandAckMessage{}
	ackingDownlink(func([]byte) { calls++ }, false)(nil, ignoredEmpty)
	if calls != 1 || ignoredEmpty.acks != 1 {
		t.Fatalf("ignored empty downlink calls=%d ACKs=%d, want 1/1", calls, ignoredEmpty.acks)
	}

	deliveredEmpty := &commandAckMessage{}
	ackingDownlink(func([]byte) { calls++ }, true)(nil, deliveredEmpty)
	if calls != 2 || deliveredEmpty.acks != 1 {
		t.Fatalf("retained-clear downlink calls=%d ACKs=%d, want 2/1", calls, deliveredEmpty.acks)
	}
}

func TestRetryableCommandRemainsUnacknowledgedInRealBroker(t *testing.T) {
	sink := startStatusSink(t)
	clientID := "vp-command-manual-ack"
	topic := fmt.Sprintf("ems/%s/%s/%s/command", testTenant, testSite, testDevice)
	var deliveries atomic.Int32
	newCommandLink := func(decide func([]byte) bool) *Link {
		link, err := New(Options{Identity: enroll.Identity{TenantID: testTenant, SiteID: testSite, DeviceID: testDevice},
			DevURL: "tcp://" + sink.addr, DevClientID: clientID,
			OnCommand: func(payload []byte) bool {
				deliveries.Add(1)
				return decide(payload)
			}})
		if err != nil {
			t.Fatal(err)
		}
		link.Connect()
		deadline := time.Now().Add(5 * time.Second)
		for !link.Connected() && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if !link.Connected() {
			t.Fatal("command link did not connect")
		}
		// Connected becomes true just before OnConnect finishes subscriptions.
		time.Sleep(100 * time.Millisecond)
		return link
	}

	first := newCommandLink(func([]byte) bool { return false })
	t.Cleanup(first.Close)
	publisher := pahomqtt.NewClient(pahomqtt.NewClientOptions().AddBroker("tcp://" + sink.addr).
		SetClientID("vp-command-publisher"))
	if token := publisher.Connect(); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publisher connect: %v", token.Error())
	}
	t.Cleanup(func() { publisher.Disconnect(100) })
	if token := publisher.Publish(topic, 1, false, []byte(`{"type":"ocpp_command"}`)); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publish: %v", token.Error())
	}
	waitDeliveries := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for deliveries.Load() < want && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if deliveries.Load() != want {
			t.Fatalf("command deliveries = %d, want %d", deliveries.Load(), want)
		}
	}
	waitDeliveries(1)
	if brokerClient, ok := sink.server.Clients.Get(clientID); !ok || brokerClient.State.Inflight.Len() != 1 {
		t.Fatalf("retryable command was ACKed: client=%v inflight=%d", ok, func() int {
			if !ok {
				return -1
			}
			return brokerClient.State.Inflight.Len()
		}())
	}
}
