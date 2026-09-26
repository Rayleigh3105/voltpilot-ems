// Package ebytesim is an in-process Modbus TCP simulator of the Ebyte M31-U
// I/O host with its expansion stack, built from the bench recording of a real
// M31-AXAX8080G-U (firmware 9232-0-13): the identity strings, the "NONE"-ended
// slave table, the contiguous DI/DO addressing, exception 2 beyond the last
// channel and for ALL I/O while negotiation is pending, and the watchdog
// registers. Tests and local end-to-end runs use it; it is never a hardware
// proof.
package ebytesim

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
)

// Sim is one simulated M31 host.
type Sim struct {
	mu       sync.Mutex
	ln       net.Listener
	Model    string
	Firmware string
	MAC      [6]byte
	// Slots are the slave table entries (slot 0 = the host board, e.g.
	// "GAXAX8080-U"; expansion modules follow).
	Slots []string
	DI    []bool
	DO    []bool
	// Pending simulates a stack that still needs negotiation.
	Pending bool
	hold    map[uint16]uint16
	// Writes counts coil writes (tests assert "nothing was written").
	Writes   int
	Restarts int
}

// New builds a simulator with the given slot models and DI/DO counts.
func New(slots []string, di, do int) *Sim {
	s := &Sim{
		Model: "M31-AXAX8080G-U", Firmware: "9232-0-13",
		MAC:   [6]byte{0x00, 0x54, 0x2c, 0x84, 0x9b, 0x90},
		Slots: slots, DI: make([]bool, di), DO: make([]bool, do),
		hold: map[uint16]uint16{0x0C35: 300},
	}
	for i := 0; i < do; i++ {
		s.hold[uint16(0x30D4+i)] = 1000 // pulse width default
	}
	return s
}

// Start listens on 127.0.0.1 and returns the address.
func (s *Sim) Start() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	s.ln = ln
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return ln.Addr().String(), nil
}

// Close stops the listener.
func (s *Sim) Close() {
	if s.ln != nil {
		_ = s.ln.Close()
	}
}

// Hold returns a holding register value.
func (s *Sim) Hold(addr uint16) uint16 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.holding(addr)
}

// SetHold sets a holding register value.
func (s *Sim) SetHold(addr, v uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hold[addr] = v
}

// Outputs returns a copy of the coil states.
func (s *Sim) Outputs() []bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]bool(nil), s.DO...)
}

// SetInput sets one 0-based digital input.
func (s *Sim) SetInput(i int, v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.DI[i] = v
}

// SetOutput sets one 0-based coil directly (a manual switch at the device).
func (s *Sim) SetOutput(i int, v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.DO[i] = v
}

func putString(regs map[uint16]uint16, base uint16, n int, v string) {
	b := make([]byte, 2*n)
	copy(b, v)
	for i := 0; i < n; i++ {
		regs[base+uint16(i)] = binary.BigEndian.Uint16(b[2*i:])
	}
}

func (s *Sim) holding(addr uint16) uint16 {
	id := map[uint16]uint16{}
	putString(id, 0x0C20, 12, s.Model)
	putString(id, 0x0C2C, 8, s.Firmware)
	for slot := 0; slot < 16; slot++ {
		name := "NONE"
		if slot < len(s.Slots) {
			name = s.Slots[slot]
		}
		if s.Pending && slot == 0 {
			name = ""
		}
		putString(id, uint16(0x0C80+8*slot), 8, name)
	}
	for i := 0; i < 3; i++ {
		id[uint16(0x7534+i)] = uint16(s.MAC[2*i])<<8 | uint16(s.MAC[2*i+1])
	}
	if s.Pending {
		id[0x7587], id[0x758A] = 2, 1
	}
	if v, ok := id[addr]; ok {
		return v
	}
	return s.hold[addr]
}

func (s *Sim) serve(c net.Conn) {
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
		resp := s.handle(body)
		out := make([]byte, 7+len(resp))
		copy(out, hdr[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(resp)+1))
		out[6] = hdr[6]
		copy(out[7:], resp)
		if _, err := c.Write(out); err != nil {
			return
		}
	}
}

func exc(fc, code byte) []byte { return []byte{fc | 0x80, code} }

func (s *Sim) handle(p []byte) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	fc := p[0]
	if len(p) < 5 {
		return exc(fc, 3)
	}
	addr := binary.BigEndian.Uint16(p[1:])
	qty := binary.BigEndian.Uint16(p[3:])
	bits := func(src []bool) []byte {
		if s.Pending || int(addr)+int(qty) > len(src) || qty == 0 {
			return exc(fc, 2)
		}
		nb := (int(qty) + 7) / 8
		out := make([]byte, 2+nb)
		out[0], out[1] = fc, byte(nb)
		for i := 0; i < int(qty); i++ {
			if src[int(addr)+i] {
				out[2+i/8] |= 1 << (uint(i) % 8)
			}
		}
		return out
	}
	switch fc {
	case 0x01:
		return bits(s.DO)
	case 0x02:
		return bits(s.DI)
	case 0x03:
		out := []byte{fc, byte(2 * qty)}
		for i := uint16(0); i < qty; i++ {
			out = binary.BigEndian.AppendUint16(out, s.holding(addr+i))
		}
		return out
	case 0x05:
		if s.Pending || int(addr) >= len(s.DO) {
			return exc(fc, 2)
		}
		s.DO[addr] = qty == 0xFF00
		s.Writes++
		return append([]byte(nil), p[:5]...)
	case 0x0F:
		if s.Pending || int(addr)+int(qty) > len(s.DO) {
			return exc(fc, 2)
		}
		for i := 0; i < int(qty); i++ {
			s.DO[int(addr)+i] = p[6+i/8]&(1<<(uint(i)%8)) != 0
		}
		s.Writes++
		return append([]byte(nil), p[:5]...)
	case 0x06:
		s.writeHold(addr, qty)
		return append([]byte(nil), p[:5]...)
	case 0x10:
		for i := uint16(0); i < qty; i++ {
			s.writeHold(addr+i, binary.BigEndian.Uint16(p[6+2*i:]))
		}
		return append([]byte(nil), p[:5]...)
	}
	return exc(fc, 1)
}

func (s *Sim) writeHold(addr, v uint16) {
	if addr == 0x0C1D && v == 0x5BB5 {
		// A restart drops every relay (power-on state default off).
		s.Restarts++
		for i := range s.DO {
			s.DO[i] = false
		}
		return
	}
	s.hold[addr] = v
}

// HostSlot is the slave-table name of the host's own 8DI/8DO board as the
// bench device reports it.
const HostSlot = "GAXAX8080-U"
