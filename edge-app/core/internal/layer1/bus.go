// Package layer1 is the Go implementation of the box's Layer 1 - the device
// I/O that Node-RED performs on the full Docker box. It is the heart of Edge
// Light (edge-light/): one binary, no Node-RED.
//
// THE RULE THIS PACKAGE IS BUILT ON: Layer 1 is a client of the LOCAL BUS,
// exactly like Node-RED is. It subscribes the same retained topics
// (edge/inverter/config ...), answers the same request topics
// (edge/test-read/request ...) and publishes the same payloads
// (edge/telemetry, edge/status ...). The core does not know which Layer 1 is
// talking to it, so every core rule, guard and contract stays untouched - and
// a function can move from Node-RED to Go one at a time (the parity matrix in
// edge-light/docs/paritaet.md), on Edge Light first and on the full box later.
//
// It connects to the bus over plain MQTT on loopback (MQTTBus) rather than
// through the in-process broker: retained messages are then delivered exactly
// as to Node-RED, and the package could equally run as its own process.
package layer1

import (
	"fmt"
	"strings"
	"sync"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
)

// Bus is the local-bus contract Layer 1 relies on.
type Bus interface {
	// Subscribe registers fn for topic; retained messages are delivered.
	// Handlers must not block (spawn work instead).
	Subscribe(topic string, fn func(topic string, payload []byte)) error
	// Publish sends a QoS1 message.
	Publish(topic string, payload []byte, retain bool) error
}

// MQTTBus is Bus over the core's embedded broker (VP_LOCAL_MQTT_ADDR).
type MQTTBus struct {
	c pahomqtt.Client

	mu   sync.Mutex
	subs map[string]func(topic string, payload []byte)
}

// DialMQTT connects to the local bus. addr is host:port (":1883" means the
// loopback interface). The connection retries until the broker is up, so the
// light binary may start Layer 1 right after the core without a race.
func DialMQTT(addr, clientID string) (*MQTTBus, error) {
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	b := &MQTTBus{subs: map[string]func(string, []byte){}}
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + addr).
		SetClientID(clientID).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(time.Second).
		SetMaxReconnectInterval(10 * time.Second).
		SetCleanSession(true).
		SetOrderMatters(false).
		SetKeepAlive(30 * time.Second)
	// Re-subscribe on EVERY (re)connect: a clean session forgets subscriptions,
	// and the retained config must reach us again after a broker restart.
	opts.SetOnConnectHandler(func(c pahomqtt.Client) {
		b.mu.Lock()
		subs := make(map[string]func(string, []byte), len(b.subs))
		for t, fn := range b.subs {
			subs[t] = fn
		}
		b.mu.Unlock()
		for t, fn := range subs {
			go func(t string, fn func(string, []byte)) {
				// Inside the connect handler a blocking wait would stall
				// paho's own goroutine; resubscribe asynchronously.
				_ = b.subscribeNow(c, t, fn)
			}(t, fn)
		}
	})
	b.c = pahomqtt.NewClient(opts)
	tok := b.c.Connect()
	if tok.WaitTimeout(30*time.Second) && tok.Error() != nil {
		return nil, fmt.Errorf("lokaler Bus %s: %w", addr, tok.Error())
	}
	return b, nil
}

func (b *MQTTBus) subscribeNow(c pahomqtt.Client, topic string, fn func(string, []byte)) error {
	tok := c.Subscribe(topic, 1, func(_ pahomqtt.Client, m pahomqtt.Message) {
		fn(m.Topic(), m.Payload())
	})
	if !tok.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("lokaler Bus: Abonnement %s unbestaetigt", topic)
	}
	return tok.Error()
}

// Subscribe implements Bus. It returns once the broker CONFIRMED the
// subscription, so a request published afterwards is never lost.
func (b *MQTTBus) Subscribe(topic string, fn func(topic string, payload []byte)) error {
	b.mu.Lock()
	b.subs[topic] = fn
	b.mu.Unlock()
	if b.c.IsConnected() {
		return b.subscribeNow(b.c, topic, fn)
	}
	return nil
}

// Publish implements Bus.
func (b *MQTTBus) Publish(topic string, payload []byte, retain bool) error {
	tok := b.c.Publish(topic, 1, retain, payload)
	if !tok.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("lokaler Bus: Zeitueberschreitung beim Senden auf %s", topic)
	}
	return tok.Error()
}

// Close disconnects.
func (b *MQTTBus) Close() { b.c.Disconnect(250) }
