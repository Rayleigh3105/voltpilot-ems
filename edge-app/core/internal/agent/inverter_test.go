package agent

// Inverter-selection tests for the core: the choice persists across a restart,
// and it is published RETAINED on the local bus both at boot and on every
// change (so a late-joining Node-RED self-wires the right adapter immediately).

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// invSubscriber connects to the local bus and records edge/inverter/config.
type invSubscriber struct {
	client pahomqtt.Client
	mu     sync.Mutex
	last   map[string]any
}

func subscribeInverter(t *testing.T, busAddr string) *invSubscriber {
	t.Helper()
	s := &invSubscriber{}
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-inv-sub").
		SetConnectTimeout(5 * time.Second)
	s.client = pahomqtt.NewClient(opts)
	if tok := s.client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("inv subscriber connect: %v", tok.Error())
	}
	if tok := s.client.Subscribe(localbus.TopicInverterConfig, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		var m map[string]any
		if json.Unmarshal(msg.Payload(), &m) == nil {
			s.mu.Lock()
			s.last = m
			s.mu.Unlock()
		}
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("inv subscribe: %v", tok.Error())
	}
	t.Cleanup(func() { s.client.Disconnect(100) })
	return s
}

func (s *invSubscriber) latest() (map[string]any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil {
		return nil, false
	}
	return s.last, true
}

// startBusOnlyAgent brings up just the local bus + inverter surface of an agent
// (no enrollment / cloud), which is all these tests exercise.
func startBusOnlyAgent(t *testing.T, cfg config.Config) (*Agent, string) {
	t.Helper()
	busPort := freePort(t)
	addr := fmt.Sprintf("127.0.0.1:%d", busPort)
	cfg.LocalMQTTAddr = addr

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.Bus = bus
	// Mirror Start's boot behavior for the inverter surface.
	a.publishInverterConfig()
	t.Cleanup(func() { _ = bus.Close() })
	return a, addr
}

func TestInverterPublishedRetainedOnChange(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)

	sub := subscribeInverter(t, addr)

	// No selection yet -> nothing retained.
	if _, ok := a.GetInverter(); ok {
		t.Fatalf("expected no selection initially")
	}

	sel, err := a.SetInverter(inverter.SelectionRequest{
		Brand:  inverter.BrandDeye,
		Family: "hybrid_3p",
		Connection: inverter.Connection{
			IP: "192.168.0.28", Serial: "2985159064", PowerScale: 10,
		},
	})
	if err != nil {
		t.Fatalf("SetInverter: %v", err)
	}
	if sel.Communication != inverter.CommSolarmanV5 {
		t.Fatalf("communication: %q", sel.Communication)
	}

	waitFor(t, 5*time.Second, "retained inverter config on change", func() bool {
		m, ok := sub.latest()
		return ok && m["brand"] == "deye" && m["family"] == "hybrid_3p"
	})
	m, _ := sub.latest()
	conn := m["connection"].(map[string]any)
	if conn["serial"] != "2985159064" || conn["power_scale"].(float64) != 10 || conn["port"].(float64) != 8899 {
		t.Fatalf("published connection: %v", conn)
	}
}

func TestInverterRetainedRepublishedAtBoot(t *testing.T) {
	dir := t.TempDir()

	// First run: choose an inverter, which persists it to disk.
	cfg := config.Defaults()
	cfg.DataDir = dir
	a1, _ := startBusOnlyAgent(t, cfg)
	if _, err := a1.SetInverter(inverter.SelectionRequest{
		Brand:      inverter.BrandGenericModbus,
		Family:     "sunspec",
		Connection: inverter.Connection{IP: "192.168.0.50", UnitID: 2},
	}); err != nil {
		t.Fatalf("SetInverter: %v", err)
	}

	// Second run against the SAME data dir: the selection is restored and
	// re-published retained at boot. A subscriber that connects AFTER boot must
	// still receive it (proving the retain flag).
	cfg2 := config.Defaults()
	cfg2.DataDir = dir
	a2, addr2 := startBusOnlyAgent(t, cfg2)

	got, ok := a2.GetInverter()
	if !ok || got.Brand != inverter.BrandGenericModbus || got.Family != "sunspec" {
		t.Fatalf("selection not restored across restart: ok=%v sel=%+v", ok, got)
	}

	sub := subscribeInverter(t, addr2)
	waitFor(t, 5*time.Second, "retained inverter config at boot", func() bool {
		m, ok := sub.latest()
		return ok && m["brand"] == "generic_modbus" && m["communication"] == "modbus_tcp"
	})
	m, _ := sub.latest()
	conn := m["connection"].(map[string]any)
	if conn["unit_id"].(float64) != 2 || conn["profile"] != "sunspec" || conn["port"].(float64) != 502 {
		t.Fatalf("published modbus connection: %v", conn)
	}
}
