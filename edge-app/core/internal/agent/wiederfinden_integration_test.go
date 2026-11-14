package agent

// S6, second half: after Wiederfinden adopts a moved device's new address,
// the box's OWN reading must resume there without a restart - the exact gap
// PR #1866's first round left open (the search's report changed, but the
// connection Layer 1 actually reads from did not). This is the end-to-end
// proof: the UNCHANGED agent plus the REAL Go Layer 1 (no mocks on the
// reading path), a staged address move behind a fake customer network, and a
// second stand-in with a DELIBERATELY different reading, so a passing
// assertion cannot be explained by stale, cached data from the first.
//
// in package agent (not layer1_test, where light_integration_test.go's
// startLightBox lives) so this can drive wiederfindenTick and the network
// seams directly, the same unexported access wiederfinden_test.go already
// uses - layer1 does not import agent, so there is no cycle either way.

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	// Aliased: agent_integration_test.go already declares a package-level
	// type named layer1 (its own MQTT stand-in), so the REAL package needs a
	// different local name in this file.
	golayer1 "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
)

// wfRedirectDialer stands in for the customer router's own routing: the
// fictional customer-network address a test configures (and the one
// Wiederfinden adopts) is never really dialable, exactly like a box's own
// config never names a loopback port - both the search's own probing
// (geraetesucheDialer) and Layer 1's regular poll (layer1.Options.Dialer) go
// through the SAME redirection, the way the kernel's real routing would
// carry both to the same physical device.
type wfRedirectDialer struct{ ziele map[string]string }

func (d wfRedirectDialer) DialContext(ctx context.Context, _ string, addr string) (net.Conn, error) {
	ziel, ok := d.ziele[addr]
	if !ok {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	var nd net.Dialer
	return nd.DialContext(ctx, "tcp", ziel)
}

func (d wfRedirectDialer) dial(ctx context.Context, addr string) (net.Conn, error) {
	return d.DialContext(ctx, "tcp", addr)
}

// wfHuaweiStandIn is a minimal SUN2000 Modbus stand-in (FC3 only) with a
// caller-chosen soc_pct (register 37760, /10) so two instances read as
// visibly different devices - the layer1 package's own huaweiStandIn always
// answers 68.6%, which would not tell "still the old instance" apart from
// "already the new one" (image: scout vp-kundenanlage-drei-geraete).
func wfHuaweiStandIn(t *testing.T, socTimesTen int32) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	regs := map[uint16]uint16{37760: uint16(socTimesTen), 37762: 2}
	put := func(a uint16, v int32) { regs[a], regs[a+1] = uint16(uint32(v)>>16), uint16(uint32(v)&0xffff) }
	put(32064, 2692)  // pv_power
	put(32080, 1792)  // battery power
	put(37113, -9908) // grid: < 0 = obtaining power
	put(37765, 900)   // + charging
	// Wiederfinden's own confirmation runs the FULL device search
	// (geraetesuche/suche erkenneHuawei), not just the reading path the other
	// Huawei stand-in (light_integration_test.go) needs: model at 30000 (15
	// regs) and serial at 30015 (10 regs), the two registers that search
	// actually reads to identify a SUN2000.
	putText := func(a uint16, n int, s string) {
		b := make([]byte, 2*n)
		copy(b, s)
		for i := 0; i < n; i++ {
			regs[a+uint16(i)] = binary.BigEndian.Uint16(b[2*i:])
		}
	}
	putText(30000, 15, "SUN2000-M1")
	putText(30015, 10, "210235"+strconv.Itoa(int(socTimesTen)))
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
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	return port
}

func wfFreeMQTTAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

// startEdgeLightBoxWithLayer1 is startLightBox (layer1 package's own
// light_integration_test.go), copied rather than reused across packages: the
// REAL agent, started, plus the REAL Go Layer 1 on a real local MQTT bus.
func startEdgeLightBoxWithLayer1(t *testing.T, dialer golayer1.Options) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	cfg.PortalBaseURL = "http://127.0.0.1:9"
	cfg.Ref = "VP-LIGHT-WF01"
	cfg.LocalMQTTAddr = wfFreeMQTTAddr(t)
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.OcppEnabled = false
	cfg.SetpointInterval = time.Duration(cfg.SetpointIntervalSeconds) * time.Second
	cfg.ReconcileInterval = time.Duration(cfg.ReconcileIntervalSeconds) * time.Second
	cfg.UnclaimConfirm = time.Duration(cfg.UnclaimConfirmMinutes) * time.Minute
	cfg.CalibrationTTL = time.Duration(cfg.CalibrationTTLSeconds) * time.Second

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Stop)

	bus, err := golayer1.DialMQTT(cfg.LocalMQTTAddr, "vp-edge-light-wf-itest")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bus.Close() })
	rt := golayer1.New(bus, dialer)
	go func() { _ = rt.Run(ctx) }()
	<-rt.Ready()
	return a
}

// TestWiederfindenHaeltDasLesenAmLaufen is the reviewer's exact ask on PR
// #1866: after the staged address change, values are ACTUALLY read again
// from the new address - not merely reported by the search.
func TestWiederfindenHaeltDasLesenAmLaufen(t *testing.T) {
	altPort := wfHuaweiStandIn(t, 686) // 68.6 %
	neuPort := wfHuaweiStandIn(t, 700) // 70.0 % - deliberately different

	dialer := wfRedirectDialer{ziele: map[string]string{
		"192.168.178.40:502": "127.0.0.1:" + strconv.Itoa(altPort),
		"192.168.178.41:502": "127.0.0.1:" + strconv.Itoa(neuPort),
	}}
	a := startEdgeLightBoxWithLayer1(t, golayer1.Options{FirstPoll: 20 * time.Millisecond, Poll: 50 * time.Millisecond,
		Dialer: dialer})
	wiederfindenEinzelsondeWartezeit = 5 * time.Millisecond
	t.Cleanup(func() { wiederfindenEinzelsondeWartezeit = 300 * time.Millisecond })
	a.geraetesucheDialer = dialer.dial
	a.netzTakt = suche.Takt{JeSekunde: 100000, Zeitlimit: time.Second, Nachlauf: 10 * time.Millisecond}
	a.netzSchnittstellen = func() ([]suche.Schnittstelle, error) {
		return []suche.Schnittstelle{
			{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}},
		}, nil
	}
	a.netzRouten = func() ([]suche.Route, error) {
		return []suche.Route{{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"),
			Gateway: netip.MustParseAddr("192.168.178.1")}}, nil
	}
	a.netzNachbarn = func() ([]suche.Nachbar, error) {
		// .40 (configured) is silent now; the same pinned mac answers at .41.
		return []suche.Nachbar{
			{IP: netip.MustParseAddr("192.168.178.41"), MAC: wfIntegrationMAC(), Schnittstelle: "eth0"},
		}, nil
	}
	a.netzAnstoss = func(_ context.Context, _ netip.Addr) error { return nil }

	if _, err := a.SetInverter(inverter.SelectionRequest{Brand: inverter.BrandHuawei, Model: "sun2000-m1",
		Connection: inverter.Connection{IP: "192.168.178.40", Port: 502, MAC: wfIntegrationMAC().String()}}); err != nil {
		t.Fatalf("Huawei-Auswahl abgelehnt: %v", err)
	}

	waitFor(t, 10*time.Second, "Erstablesung an der alten Adresse", func() bool {
		s := a.State.Get()
		return s.InverterLink == "up" && s.LastReading["soc_pct"] == 68.6
	})

	// The address changes - staged exactly like geraetesuche/suche's own
	// Wiederfinden tests, just driven through the agent's real watchdog tick.
	a.wiederfindenTick(context.Background())

	sel, ok, err := a.invStore.Load()
	if err != nil || !ok || sel.Connection.IP != "192.168.178.41" {
		t.Fatalf("Adresse nicht uebernommen: ok=%v err=%v sel=%+v", ok, err, sel.Connection)
	}

	waitFor(t, 10*time.Second, "Lesen laeuft unter der neuen Adresse weiter", func() bool {
		s := a.State.Get()
		return s.InverterLink == "up" && s.LastReading["soc_pct"] == 70
	})
}

func wfIntegrationMAC() net.HardwareAddr {
	m, _ := net.ParseMAC("00:11:22:aa:bb:40")
	return m
}
