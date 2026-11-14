// Package geraetsim is a stand-in for a self-built Modbus device with values
// to read and write (Steuerlogik K3): a Modbus TCP server with holding and
// input registers, coils and discrete inputs that ANSWERS writes (FC5, FC6,
// FC16) and logs every one. Tests and cmd/vp-modbus-geraet-sim use it as an
// air conditioner or a cold-room controller; Spiegel copies a written register
// into its read-back register the way such a controller confirms a setpoint.
//
// Simulator evidence is no hardware acceptance: what only a real device shows
// (a refused write that answers OK, a watchdog, its own clamp) belongs in the
// PR's hardware tests.
package geraetsim

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
)

// Schreiben is one write the device received.
type Schreiben struct {
	FC      byte
	Address uint16
	Wert    uint16
}

// Geraet is the stand-in device (one unit; every unit id is answered).
type Geraet struct {
	ln net.Listener

	mu        sync.Mutex
	holding   map[uint16]uint16
	input     map[uint16]uint16
	coils     map[uint16]bool
	discrete  map[uint16]bool
	spiegel   map[uint16]uint16 // written register -> read-back register
	schreiben []Schreiben
	lesen     int
	conns     int
}

// Start listens on addr ("127.0.0.1:0" for a free port).
func Start(addr string) (*Geraet, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	g := &Geraet{ln: ln, holding: map[uint16]uint16{}, input: map[uint16]uint16{},
		coils: map[uint16]bool{}, discrete: map[uint16]bool{}, spiegel: map[uint16]uint16{}}
	go g.serve()
	return g, nil
}

// Addr is the listen address.
func (g *Geraet) Addr() string { return g.ln.Addr().String() }

// Close stops the server.
func (g *Geraet) Close() error { return g.ln.Close() }

// Holding, Input, Coil and Discrete set values.
func (g *Geraet) Holding(addr, v uint16) { g.mu.Lock(); g.holding[addr] = v; g.mu.Unlock() }

// Input sets an input register.
func (g *Geraet) Input(addr, v uint16) { g.mu.Lock(); g.input[addr] = v; g.mu.Unlock() }

// Coil sets a coil.
func (g *Geraet) Coil(addr uint16, v bool) { g.mu.Lock(); g.coils[addr] = v; g.mu.Unlock() }

// Discrete sets a discrete input.
func (g *Geraet) Discrete(addr uint16, v bool) { g.mu.Lock(); g.discrete[addr] = v; g.mu.Unlock() }

// Spiegel makes a write to register von appear in register nach as well.
func (g *Geraet) Spiegel(von, nach uint16) { g.mu.Lock(); g.spiegel[von] = nach; g.mu.Unlock() }

// HoldingWert reads a holding register.
func (g *Geraet) HoldingWert(addr uint16) uint16 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.holding[addr]
}

// CoilWert reads a coil.
func (g *Geraet) CoilWert(addr uint16) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.coils[addr]
}

// Geschrieben lists every write in order.
func (g *Geraet) Geschrieben() []Schreiben {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]Schreiben(nil), g.schreiben...)
}

// Verbindungen counts accepted connections (the one-socket rule).
func (g *Geraet) Verbindungen() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.conns
}

func (g *Geraet) serve() {
	for {
		c, err := g.ln.Accept()
		if err != nil {
			return
		}
		g.mu.Lock()
		g.conns++
		g.mu.Unlock()
		go g.handle(c)
	}
}

func (g *Geraet) handle(c net.Conn) {
	defer c.Close()
	for {
		kopf := make([]byte, 7)
		if _, err := io.ReadFull(c, kopf); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(kopf[4:]))
		if n < 2 || n > 254 {
			return
		}
		pdu := make([]byte, n-1)
		if _, err := io.ReadFull(c, pdu); err != nil {
			return
		}
		antwort := g.antwort(pdu)
		out := make([]byte, 7+len(antwort))
		copy(out, kopf[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(antwort)+1))
		out[6] = kopf[6]
		copy(out[7:], antwort)
		if _, err := c.Write(out); err != nil {
			return
		}
	}
}

func ausnahme(fc, code byte) []byte { return []byte{fc | 0x80, code} }

func (g *Geraet) antwort(pdu []byte) []byte {
	g.mu.Lock()
	defer g.mu.Unlock()
	fc := pdu[0]
	if len(pdu) < 5 {
		return ausnahme(fc, 3)
	}
	addr := binary.BigEndian.Uint16(pdu[1:])
	switch fc {
	case 1, 2:
		count := binary.BigEndian.Uint16(pdu[3:])
		g.lesen++
		quelle := g.coils
		if fc == 2 {
			quelle = g.discrete
		}
		bytes := (int(count) + 7) / 8
		out := []byte{fc, byte(bytes)}
		daten := make([]byte, bytes)
		for i := 0; i < int(count); i++ {
			if quelle[addr+uint16(i)] {
				daten[i/8] |= 1 << uint(i%8)
			}
		}
		return append(out, daten...)
	case 3, 4:
		count := binary.BigEndian.Uint16(pdu[3:])
		g.lesen++
		quelle := g.holding
		if fc == 4 {
			quelle = g.input
		}
		out := []byte{fc, byte(2 * count)}
		for i := uint16(0); i < count; i++ {
			out = binary.BigEndian.AppendUint16(out, quelle[addr+i])
		}
		return out
	case 5:
		v := binary.BigEndian.Uint16(pdu[3:])
		g.coils[addr] = v == 0xFF00
		g.schreiben = append(g.schreiben, Schreiben{FC: 5, Address: addr, Wert: map[bool]uint16{true: 1, false: 0}[v == 0xFF00]})
		return append([]byte(nil), pdu[:5]...)
	case 6:
		v := binary.BigEndian.Uint16(pdu[3:])
		g.setze(6, addr, v)
		return append([]byte(nil), pdu[:5]...)
	case 16:
		count := binary.BigEndian.Uint16(pdu[3:])
		if len(pdu) < 6+2*int(count) {
			return ausnahme(fc, 3)
		}
		for i := uint16(0); i < count; i++ {
			g.setze(16, addr+i, binary.BigEndian.Uint16(pdu[6+2*i:]))
		}
		return append([]byte(nil), pdu[:5]...)
	}
	return ausnahme(fc, 1)
}

func (g *Geraet) setze(fc byte, addr, v uint16) {
	g.holding[addr] = v
	if nach, ok := g.spiegel[addr]; ok {
		g.holding[nach] = v
	}
	g.schreiben = append(g.schreiben, Schreiben{FC: fc, Address: addr, Wert: v})
}
