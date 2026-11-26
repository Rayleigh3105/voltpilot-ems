package layer1_test

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// huaweiFeldgeraet is the field SUN2000-3KTL-M1 + LUNA2000 behind its dongle
// for the core end to end: FC3/FC6/FC16 on a register image with the window
// 47086 = 2, 47075 = 7000 W, 47077 = 3300 W.
type huaweiFeldgeraet struct {
	mu     sync.Mutex
	regs   map[uint16]uint16
	writes []uint16
}

func (g *huaweiFeldgeraet) u32(a uint16) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return int(uint32(g.regs[a])<<16 | uint32(g.regs[a+1]))
}

func startHuaweiFeldgeraet(t *testing.T) (*huaweiFeldgeraet, string, int) {
	t.Helper()
	g := &huaweiFeldgeraet{regs: map[uint16]uint16{37760: 450, 37762: 2, 47086: 2, 47076: 7000, 47078: 3300}}
	put := func(a uint16, v int32) { g.regs[a], g.regs[a+1] = uint16(uint32(v)>>16), uint16(uint32(v)) }
	put(32064, 0)
	put(32080, 3215)
	put(37113, -8000)
	put(37765, -3215)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
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
					addr := binary.BigEndian.Uint16(body[1:])
					var resp []byte
					g.mu.Lock()
					switch body[0] {
					case 3:
						n := binary.BigEndian.Uint16(body[3:])
						resp = []byte{3, byte(2 * n)}
						for i := uint16(0); i < n; i++ {
							resp = binary.BigEndian.AppendUint16(resp, g.regs[addr+i])
						}
					case 6:
						g.regs[addr] = binary.BigEndian.Uint16(body[3:])
						g.writes = append(g.writes, addr)
						resp = append([]byte(nil), body[:5]...)
					case 16:
						n := binary.BigEndian.Uint16(body[3:])
						for i := uint16(0); i < n; i++ {
							g.regs[addr+i] = binary.BigEndian.Uint16(body[6+2*i:])
						}
						g.writes = append(g.writes, addr)
						resp = append([]byte(nil), body[:5]...)
					default:
						resp = []byte{body[0] | 0x80, 1}
					}
					g.mu.Unlock()
					out := make([]byte, 7, 7+len(resp))
					copy(out, hdr[:4])
					binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
					out[6] = hdr[6]
					if _, err := c.Write(append(out, resp...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	p := 0
	for _, ch := range port {
		p = p*10 + int(ch-'0')
	}
	return g, host, p
}

// Both box programs (vp-edge-light on the Mango, vp-edge-industrie on the WAGO
// PFC200) run the core and this Layer 1 through internal/kernmain. The core
// selects the Huawei, its selection carries the model the release names, and
// Layer 1's Huawei path answers on edge/control/readback: with control on and
// the family certified it reads the mode, stores the device's own discharge
// limit and holds the core's own evening setpoint (discharge -> E_decken:
// 47077 stays the device's own value) read back held; under Not-Aus it writes
// nothing and says why. The handback paths are proven in
// steuern_huawei_test.go.
func TestHuaweiSteuerwegUeberDenKernJeBoxArt(t *testing.T) {
	for _, boxArt := range []string{geraetesuche.BoxArtEdgeLight, geraetesuche.BoxArtEdgeIndustrie} {
		for _, an := range []bool{true, false} {
			name := boxArt + "/steuerung_an"
			if !an {
				name = boxArt + "/not_aus"
			}
			t.Run(name, func(t *testing.T) {
				g, host, port := startHuaweiFeldgeraet(t)
				a := startLightBox(t, layer1.Options{FirstPoll: 50 * time.Millisecond, Poll: 300 * time.Millisecond,
					HuaweiConnectPause: 20 * time.Millisecond}, func(c *config.Config) {
					c.BoxArt = boxArt
					c.ControlEnabled = an
					c.ControlCertifiedFamilies = []string{inverter.FamHuaweiSun2000Luna}
					c.SetpointIntervalSeconds = 1
				})
				bus, err := layer1.DialMQTT(a.Cfg.LocalMQTTAddr, "huawei-zuschauer")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(bus.Close)
				var mu sync.Mutex
				var rueck []map[string]any
				_ = bus.Subscribe(localbus.TopicControlReadback, func(_ string, p []byte) {
					var m map[string]any
					_ = json.Unmarshal(p, &m)
					mu.Lock()
					rueck = append(rueck, m)
					mu.Unlock()
				})
				if _, err := a.SetInverter(inverter.SelectionRequest{Brand: inverter.BrandHuawei, Model: "sun2000-m1",
					Connection: inverter.Connection{IP: host, Port: port, UnitID: 1}}); err != nil {
					t.Fatalf("Huawei-Auswahl: %v", err)
				}
				var treffer map[string]any
				waitFor(t, 20*time.Second, "Rückmeldung des Huawei-Steuerwegs", func() bool {
					mu.Lock()
					defer mu.Unlock()
					for _, m := range rueck {
						if m["control_path"] != "huawei_fenster" {
							continue
						}
						if an && m["verify"] == "held" && m["mode"] == "normal" {
							treffer = m
							return true
						}
						if !an && m["blocked"] == true {
							treffer = m
							return true
						}
					}
					return false
				})
				g.mu.Lock()
				writes := append([]uint16(nil), g.writes...)
				g.mu.Unlock()
				if !an {
					if !strings.Contains(treffer["reason"].(string), "Not-Aus") || len(writes) != 0 {
						t.Fatalf("Not-Aus: %v, geschrieben %v", treffer, writes)
					}
					return
				}
				if treffer["certified"] != true {
					t.Fatalf("Steuerung an: %v", treffer)
				}
				for _, w := range writes {
					if w != 47077 {
						t.Fatalf("nur die Entladegrenze (Option C): %v", writes)
					}
				}
				if g.u32(47075) != 7000 || g.u32(47077) != 3300 {
					t.Fatalf("E_decken: 47075=%d 47077=%d", g.u32(47075), g.u32(47077))
				}
			})
		}
	}
}
