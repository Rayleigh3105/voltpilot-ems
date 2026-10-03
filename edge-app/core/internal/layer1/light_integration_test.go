package layer1_test

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func waitFor(t *testing.T, within time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("Zeitueberschreitung: %s", what)
}

// TestEdgeLightTheUnchangedCoreWithTheGoLayer1 is the Edge Light promise in
// one test: the UNCHANGED agent (as vp-edge-light starts it) plus the Go
// Layer 1 - no Node-RED - turns a Deye datalogger into the core's live
// reading, and the box's own "Verbindung testen" is answered through the same
// local bus contract Node-RED answers on the Docker box.
func TestEdgeLightTheUnchangedCoreWithTheGoLayer1(t *testing.T) {
	sim, err := v5sim.Start("127.0.0.1:0", 2985159064)
	if err != nil {
		t.Fatal(err)
	}
	defer sim.Close()
	sim.Set(map[uint16]uint16{
		0x0000: 0x0005,
		0x024b: 5230, 0x024c: 57, 0x024e: 0xfa24,
		0x026b: 0xf704, 0x02c4: 0xffff,
		0x028d: 1800, 0x02a0: 1000, 0x02a1: 1200,
	})
	_, simPortStr, _ := net.SplitHostPort(sim.Addr())
	simPort, _ := strconv.Atoi(simPortStr)

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = "http://127.0.0.1:9" // enrollment just retries
	cfg.Ref = "VP-LIGHT-0001"
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.OcppEnabled = false
	// The derived durations config.Load() computes (the agent integration
	// tests set them the same way).
	cfg.SetpointInterval = time.Duration(cfg.SetpointIntervalSeconds) * time.Second
	cfg.ReconcileInterval = time.Duration(cfg.ReconcileIntervalSeconds) * time.Second
	cfg.UnclaimConfirm = time.Duration(cfg.UnclaimConfirmMinutes) * time.Minute
	cfg.CalibrationTTL = time.Duration(cfg.CalibrationTTLSeconds) * time.Second

	a, err := agent.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	bus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, "vp-edge-light-itest")
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	rt := layer1.New(bus, layer1.Options{FirstPoll: 50 * time.Millisecond, Poll: 200 * time.Millisecond})
	go func() { _ = rt.Run(ctx) }()
	<-rt.Ready()

	// The customer picks the inverter on :8484 - the core persists it and
	// publishes the retained selection; Layer 1 self-wires from it.
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-12k-sg04lp3",
		Connection: inverter.Connection{IP: "127.0.0.1", Port: simPort, Serial: "2985159064"},
	}); err != nil {
		t.Fatalf("Auswahl abgelehnt: %v", err)
	}

	waitFor(t, 10*time.Second, "Messwert im Kern", func() bool {
		s := a.State.Get()
		return s.InverterLink == "up" && s.LastReading["pv_power_kw"] == 2.2
	})
	s := a.State.Get()
	for k, want := range map[string]float64{"soc_pct": 57, "power_kw": -2.3} {
		if got := s.LastReading[k]; got != want {
			t.Errorf("Kern-Messwert %s = %v, want %v (%v)", k, got, want, s.LastReading)
		}
	}

	// "Verbindung testen" with an UNSAVED form, end to end through the core.
	res := a.TestConnection(testconn.Request{
		Brand: "deye", Model: "sun-12k-sg04lp3",
		Connection: testconn.Connection{"ip": "127.0.0.1", "port": simPort, "serial": "2985159064"},
	})
	if !res.OK || res.Reading == nil || res.Reading.PvKw == nil || *res.Reading.PvKw != 2.2 {
		t.Fatalf("Verbindungstest ueber den Kern: %+v", res)
	}
	if n := sim.RefusedConnections(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen - Poll und Test kollidierten am Ein-Client-Logger", n)
	}
}
