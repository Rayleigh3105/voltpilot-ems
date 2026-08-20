package agent

// Modbus-Datenspiegel integration: a real local bus feeds the mirror
// (retained edge/registers/raw + edge/telemetry + edge/control/readback), a
// real TCP Modbus client reads it back byte-identically, staleness answers
// 0x0B, auto-learned wants surface retained on edge/registers/want AND in
// mirror.json (restart-safe), and the /api/mirror toggle closes the listener.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/web"
)

// startMirrorAgent brings up the local-bus + mirror surface of an agent the
// way Start wires it (no enrollment/cloud), with the mirror pre-enabled on a
// free port.
func startMirrorAgent(t *testing.T, dir string) (*Agent, string) {
	t.Helper()
	mirrorPort := freePort(t)
	raw, _ := json.Marshal(mirror.Settings{Enabled: true, Port: mirrorPort, StaleAfterS: 90})
	if err := os.WriteFile(filepath.Join(dir, "mirror.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := config.Defaults()
	cfg.DataDir = dir
	busAddr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.LocalMQTTAddr = busAddr
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	bus, err := localbus.Start(busAddr, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.Bus = bus
	t.Cleanup(func() { _ = bus.Close(); a.mir.Stop() })
	// The Start subscriptions this surface needs.
	if err := bus.Subscribe(localbus.TopicTelemetry, 1, a.onLocalTelemetry); err != nil {
		t.Fatal(err)
	}
	if err := bus.Subscribe(localbus.TopicControlReadback, 3, a.onControlReadback); err != nil {
		t.Fatal(err)
	}
	if err := a.startMirror(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, "mirror listener up", func() bool { return a.mir.Running() })
	return a, busAddr
}

func busClient(t *testing.T, busAddr, id string) pahomqtt.Client {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID(id).
		SetConnectTimeout(5 * time.Second)
	c := pahomqtt.NewClient(opts)
	if tok := c.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("bus connect: %v", tok.Error())
	}
	t.Cleanup(func() { c.Disconnect(100) })
	return c
}

func pub(t *testing.T, c pahomqtt.Client, topic string, retain bool, payload any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if tok := c.Publish(topic, 1, retain, raw); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("publish %s: %v", topic, tok.Error())
	}
}

// mbRead performs one FC3 read against the mirror and returns regs or the
// exception code.
func mbRead(t *testing.T, addr string, unit byte, start, count int) ([]uint16, byte) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial mirror: %v", err)
	}
	defer conn.Close()
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:2], 1)
	binary.BigEndian.PutUint16(req[4:6], 6)
	req[6] = unit
	req[7] = 3
	binary.BigEndian.PutUint16(req[8:10], uint16(start))
	binary.BigEndian.PutUint16(req[10:12], uint16(count))
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	resp := make([]byte, 300)
	n := 0
	for n < 9 {
		m, err := conn.Read(resp[n:])
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		n += m
	}
	if resp[7] == 0x83 {
		return nil, resp[8]
	}
	total := 9 + int(resp[8])
	for n < total {
		m, err := conn.Read(resp[n:])
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		n += m
	}
	regs := make([]uint16, int(resp[8])/2)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(resp[9+2*i:])
	}
	return regs, 0
}

func TestMirrorServesBusFedDataAndTogglesViaAPI(t *testing.T) {
	dir := t.TempDir()
	a, busAddr := startMirrorAgent(t, dir)
	mirrorAddr := a.mir.Addr()
	c := busClient(t, busAddr, "test-mirror-pub")

	// --- native area: raw blocks published by "Node-RED" serve byte-identically.
	regs := []int{0x0006, 0x0007}
	pub(t, c, localbus.TopicRegistersRaw, true, map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "unit": 1,
		"blocks": []map[string]any{{"start": 0x024C, "regs": []int{500, 501, 502, 503}}, {"start": 0x0000, "regs": regs[:1]}},
	})
	waitFor(t, 5*time.Second, "raw block served", func() bool {
		got, exc := mbRead(t, mirrorAddr, 1, 0x024C, 4)
		return exc == 0 && len(got) == 4 && got[0] == 500 && got[3] == 503
	})

	// --- VP map (unit 100): the gated composite telemetry.
	pub(t, c, localbus.TopicTelemetry, false, map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339),
		"pv_power_kw": 5.5, "load_kw": 1.2, "power_kw": -3.1, "soc_pct": 87.0, "battery_power_kw": 1.2,
	})
	waitFor(t, 5*time.Second, "vp map served", func() bool {
		got, exc := mbRead(t, mirrorAddr, mirror.VPUnit, 0, 15)
		if exc != 0 || got[0] != 0x5650 || got[3] != 0 {
			return false
		}
		pv := int32(uint32(got[4])<<16 | uint32(got[5]))
		soc := got[12]
		return pv == 5500 && soc == 870
	})

	// --- control window from a readback (never learned, readable).
	pub(t, c, localbus.TopicControlReadback, false, map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "family": "hybrid_3p", "source": "schedule",
		"control_enabled": true, "certified": true, "all_match": true, "control_path": "remote",
		"remote_status_raw": 3,
		"registers": []map[string]any{
			{"role": "enable", "fc": 16, "addr": 1100, "commanded_raw": 1, "actual_raw": 1, "match": true},
			{"role": "setpoint", "fc": 16, "addr": 1109, "commanded_raw": 65486, "actual_raw": 65486, "match": true},
		},
	})
	waitFor(t, 5*time.Second, "control regs served", func() bool {
		got, exc := mbRead(t, mirrorAddr, 1, 1109, 1)
		return exc == 0 && got[0] == 65486
	})
	if got, exc := mbRead(t, mirrorAddr, 1, 1121, 1); exc != 0 || got[0] != 3 {
		t.Fatalf("remote status register: exc 0x%02x regs %v", exc, got)
	}

	// --- auto-learn: an uncovered read records a want, published retained +
	// persisted; first miss answers 0x0B.
	if _, exc := mbRead(t, mirrorAddr, 1, 0x0060, 4); exc != 0x0B {
		t.Fatalf("first miss: exception 0x%02x, want 0x0B", exc)
	}
	wantSeen := make(chan []byte, 4)
	if tok := c.Subscribe(localbus.TopicRegistersWant, 1, func(_ pahomqtt.Client, msg pahomqtt.Message) {
		wantSeen <- msg.Payload()
	}); !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("want subscribe: %v", tok.Error())
	}
	waitFor(t, 5*time.Second, "want retained on the bus", func() bool {
		select {
		case raw := <-wantSeen:
			return strings.Contains(string(raw), "\"start\":96")
		default:
			return false
		}
	})
	waitFor(t, 5*time.Second, "want persisted in mirror.json", func() bool {
		raw, err := os.ReadFile(filepath.Join(dir, "mirror.json"))
		return err == nil && strings.Contains(string(raw), "\"start\": 96")
	})
	// The poll answers the learned block (as Node-RED would) -> served.
	pub(t, c, localbus.TopicRegistersRaw, true, map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339), "unit": 1,
		"blocks": []map[string]any{{"start": 0x0060, "regs": []int{7, 8, 9, 10}, "learned": true}},
	})
	waitFor(t, 5*time.Second, "learned block served", func() bool {
		got, exc := mbRead(t, mirrorAddr, 1, 0x0060, 4)
		return exc == 0 && got[0] == 7 && got[3] == 10
	})

	// --- staleness: a raw message whose PAYLOAD ts is old serves 0x0B (the
	// retained-message-after-restart guarantee: publish stop == old ts).
	pub(t, c, localbus.TopicRegistersRaw, true, map[string]any{
		"ts": time.Now().UTC().Add(-10 * time.Minute).Format(time.RFC3339), "unit": 1,
		"blocks": []map[string]any{{"start": 0x024C, "regs": []int{500, 501, 502, 503}}},
	})
	waitFor(t, 5*time.Second, "stale raw answers 0x0B", func() bool {
		_, exc := mbRead(t, mirrorAddr, 1, 0x024C, 4)
		return exc == 0x0B
	})

	// --- toggle off via the REAL /api/mirror endpoint: listener closes; the
	// retained want set clears (the poll drops learned blocks).
	srv := httptest.NewServer(web.Handler(a.State, a, a, a, a.History(), a, a, a, a, a, a, a, a, a))
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/api/mirror", "application/json", strings.NewReader(`{"enabled":false}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("POST /api/mirror: %d", resp.StatusCode)
	}
	var got struct {
		Mirror mirror.Status `json:"mirror"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Mirror.Enabled || got.Mirror.Running {
		t.Fatalf("mirror still on after disable: %+v", got.Mirror)
	}
	waitFor(t, 5*time.Second, "listener closed", func() bool {
		conn, err := net.DialTimeout("tcp", mirrorAddr, 300*time.Millisecond)
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	})
	waitFor(t, 5*time.Second, "want cleared while disabled", func() bool {
		for {
			select {
			case raw := <-wantSeen:
				if string(raw) == `{"blocks":[]}` {
					return true
				}
			default:
				return false
			}
		}
	})
}

func TestMirrorLearnedBlocksSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	a, _ := startMirrorAgent(t, dir)
	mirrorAddr := a.mir.Addr()
	// Learn a block, then "restart" the agent on the same data dir.
	if _, exc := mbRead(t, mirrorAddr, 1, 0x0100, 2); exc != 0x0B {
		t.Fatalf("miss: 0x%02x", exc)
	}
	waitFor(t, 5*time.Second, "want persisted", func() bool {
		raw, err := os.ReadFile(filepath.Join(dir, "mirror.json"))
		return err == nil && strings.Contains(string(raw), "\"start\": 256")
	})
	a.mir.Stop() // free the port; the cleanup closes the bus

	cfg := config.Defaults()
	cfg.DataDir = dir
	a2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	wants := a2.mir.Wants()
	if len(wants) != 1 || wants[0].Start != 0x0100 {
		t.Fatalf("learned blocks not restored after restart: %+v", wants)
	}
}
