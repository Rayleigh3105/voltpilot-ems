package layer1_test

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kacoserial"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5/v5sim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
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

// startLightBox starts what vp-edge-light starts: the UNCHANGED agent and the
// Go Layer 1 on its local bus. Everything stops with the test.
func startLightBox(t *testing.T, opts layer1.Options) *agent.Agent {
	t.Helper()
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
	t.Cleanup(cancel)
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)

	bus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, "vp-edge-light-itest")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bus.Close() })
	rt := layer1.New(bus, opts)
	go func() { _ = rt.Run(ctx) }()
	<-rt.Ready()
	return a
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

	a := startLightBox(t, layer1.Options{FirstPoll: 50 * time.Millisecond, Poll: 200 * time.Millisecond})

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

// TestEdgeLightReadsAGoeSourceIntoTheCore: a go-e added as a Verbraucher on
// :8484 (the core persists it and publishes edge/sources/config) is read by the
// Go Layer 1 and lands in the core's per-source reading - the path the Node-RED
// tab "Energiequellen (automatisch)" serves on the Docker box. "Verbindung
// testen" for the go-e is answered through the same bus.
func TestEdgeLightReadsAGoeSourceIntoTheCore(t *testing.T) {
	goe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"car":2,"alw":true,"amp":16,"wh":5321.4,"nrg":[232.1,231.8,232.5,0,16,16.1,15.9,3680,3700,3660,0,11040,99.9,99.8,99.7,0]}`))
	}))
	defer goe.Close()
	port := goe.Listener.Addr().(*net.TCPAddr).Port

	a := startLightBox(t, layer1.Options{FirstPoll: time.Hour, Poll: time.Hour,
		SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 200 * time.Millisecond})
	src, err := a.AddSource(sources.Request{
		Role: sources.RoleConsumer, Brand: inverter.BrandGoe, Model: inverter.FamGoeHTTP,
		Connection: inverter.Connection{IP: "127.0.0.1", Port: port},
	})
	if err != nil {
		t.Fatalf("go-e als Verbraucher abgelehnt: %v", err)
	}

	waitFor(t, 10*time.Second, "go-e-Messwert im Kern", func() bool {
		r, ok := a.SourceLastReadings()[src.ID]
		return ok && r.LoadKw != nil && *r.LoadKw == 11.04
	})
	if st := a.SourceStatuses()[src.ID]; st != "ok" {
		t.Errorf("Quellen-Status: %q", st)
	}

	res := a.TestConnection(testconn.Request{
		Role: sources.RoleConsumer, Brand: inverter.BrandGoe, Model: inverter.FamGoeHTTP,
		Connection: testconn.Connection{"ip": "127.0.0.1", "port": port},
	})
	if !res.OK || res.Reading == nil || res.Reading.LoadKw == nil || *res.Reading.LoadKw != 11.04 {
		t.Fatalf("Verbindungstest der go-e ueber den Kern: %+v", res)
	}
}

// huaweiStandIn is a SUN2000-3KTL-M1 + LUNA2000 behind a Smart Dongle, the
// image of the customer plant's stand-in (scout vp-kundenanlage-drei-geraete
// huawei_sim.py): Modbus TCP FC3 only, Huawei signs on the wire.
func huaweiStandIn(t *testing.T) (host string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	regs := map[uint16]uint16{37760: 686, 37762: 2}
	put := func(a uint16, v int32) { regs[a], regs[a+1] = uint16(uint32(v)>>16), uint16(uint32(v)&0xffff) }
	put(32064, 2692)
	put(32080, 1792)
	put(37113, -9908) // Huawei: < 0 = obtaining power from the grid
	put(37765, 900)   // + charging
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				for {
					hdr := make([]byte, 7)
					if _, err := io.ReadFull(c, hdr); err != nil {
						return
					}
					body := make([]byte, int(binary.BigEndian.Uint16(hdr[4:]))-1)
					if _, err := io.ReadFull(c, body); err != nil {
						return
					}
					addr, count := binary.BigEndian.Uint16(body[1:]), binary.BigEndian.Uint16(body[3:])
					resp := []byte{3, byte(count * 2)}
					for i := uint16(0); i < count; i++ {
						resp = binary.BigEndian.AppendUint16(resp, regs[addr+i])
					}
					out := append([]byte{}, hdr[:4]...)
					out = binary.BigEndian.AppendUint16(out, uint16(len(resp)+1))
					out = append(out, hdr[6])
					_, _ = c.Write(append(out, resp...))
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return "127.0.0.1", ln.Addr().(*net.TCPAddr).Port
}

// powadorStandIn is a Waveshare RS485-to-ETH converter (transparent TCP server)
// with a Powador 3200 at bus address 1 behind it (the scout's kaco_sim.py).
func powadorStandIn(t *testing.T) (host string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	body := "*010 " + fmt.Sprintf("%3d %5s %5s %5d %5s %5s %5d %3d %6d ", 4, "412.5", "3.07", 1264, "230.4", "5.37", 1216, 38, 6567)
	frame := append([]byte{0x0a}, []byte(body)...)
	frame = append(frame, kacoserial.Checksum([]byte(body)))
	frame = append(frame, []byte(" 3200I\r")...)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				buf := make([]byte, 16)
				n, err := c.Read(buf)
				if err != nil || string(buf[:n]) != "#010\r" {
					time.Sleep(2 * time.Second)
					return
				}
				time.Sleep(30 * time.Millisecond)
				_, _ = c.Write(frame)
				time.Sleep(300 * time.Millisecond)
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return "127.0.0.1", ln.Addr().(*net.TCPAddr).Port
}

// TestEdgeLightReadsTheCustomerPlantHuaweiAndPowador is the customer plant of
// 04.11.2026 (scout vp-kundenanlage-drei-geraete) on Edge Light: the UNCHANGED
// agent persists a Huawei SUN2000-M1 as the primary inverter (with the grid
// sign hatch, as the on-site checklist says) and a Powador 3200 as a second
// Erzeuger source; the Go Layer 1 reads both into the core's live reading -
// PV summed over both devices, grid and SoC from the Huawei - and "Verbindung
// testen" answers for both over the same local bus.
func TestEdgeLightReadsTheCustomerPlantHuaweiAndPowador(t *testing.T) {
	hwHost, hwPort := huaweiStandIn(t)
	kHost, kPort := powadorStandIn(t)

	a := startLightBox(t, layer1.Options{FirstPoll: 50 * time.Millisecond, Poll: 200 * time.Millisecond,
		SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 200 * time.Millisecond})

	// H4 of the checklist: SUN2000-M1, unit 1 (behind the dongle), grid sign inverted.
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: inverter.BrandHuawei, Model: "sun2000-m1",
		Connection: inverter.Connection{IP: hwHost, Port: hwPort, UnitID: 1, InvertGridSign: true},
	}); err != nil {
		t.Fatalf("Huawei-Auswahl abgelehnt: %v", err)
	}
	// K6: the Powador as "Weiterer Erzeuger" behind the converter, address 1, 3,2 kWp.
	src, err := a.AddSource(sources.Request{
		Role: sources.RoleErzeuger, Brand: inverter.BrandKaco, Model: "powador-3200-int",
		Connection: inverter.Connection{IP: kHost, Port: kPort, Address: 1}, CapacityKwp: 3.2,
	})
	if err != nil {
		t.Fatalf("Powador als Erzeuger abgelehnt: %v", err)
	}

	waitFor(t, 10*time.Second, "Huawei-Messwert im Kern", func() bool {
		s := a.State.Get()
		return s.InverterLink == "up" && s.LastReading["soc_pct"] == 68.6
	})
	waitFor(t, 10*time.Second, "Powador-Messwert im Kern", func() bool {
		r, ok := a.SourceLastReadings()[src.ID]
		return ok && r.PvKw != nil && *r.PvKw == 1.216
	})
	if st := a.SourceStatuses()[src.ID]; st != "ok" {
		t.Errorf("Quellen-Status Powador: %q", st)
	}
	// The composite site reading (State.PvKw, what dashboard and cloud see):
	// PV over both devices - the core adds the floats as they are, 3,908 kW up
	// to a rounding ulp. LastReading stays the PRIMARY's own values by design
	// ("Zuletzt gelesen" must not attribute the Powador's share to the Huawei).
	waitFor(t, 10*time.Second, "PV-Summe beider Geraete", func() bool {
		return math.Abs(a.State.Get().PvKw-3.908) < 1e-9
	})
	s := a.State.Get()
	for k, want := range map[string]float64{"pv_power_kw": 2.692, "power_kw": 9.908, "soc_pct": 68.6} {
		if got := s.LastReading[k]; got != want {
			t.Errorf("Huawei-Messwert %s = %v, want %v (%v)", k, got, want, s.LastReading)
		}
	}

	// "Verbindung testen" for both, end to end through the core.
	hw := a.TestConnection(testconn.Request{
		Brand: inverter.BrandHuawei, Model: "sun2000-m1",
		Connection: testconn.Connection{"ip": hwHost, "port": hwPort, "unit_id": 1, "invert_grid_sign": true},
	})
	if !hw.OK || hw.Reading == nil || hw.Reading.PvKw == nil || *hw.Reading.PvKw != 2.692 || hw.Reading.GridKw == nil || *hw.Reading.GridKw != 9.908 {
		t.Fatalf("Verbindungstest Huawei ueber den Kern: %+v", hw)
	}
	k := a.TestConnection(testconn.Request{
		Role: sources.RoleErzeuger, Brand: inverter.BrandKaco, Model: "powador-3200-int",
		Connection: testconn.Connection{"ip": kHost, "port": kPort, "address": 1},
	})
	if !k.OK || k.Reading == nil || k.Reading.PvKw == nil || *k.Reading.PvKw != 1.216 {
		t.Fatalf("Verbindungstest Powador ueber den Kern: %+v", k)
	}
}
