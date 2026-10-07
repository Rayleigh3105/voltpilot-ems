// Package v5sim is a Solarman V5 datalogger simulator: it answers fn-0x03
// reads from a register map, exactly as a Deye LSW stick frames them. Dev and
// test tool only (the ebytesim precedent) - it never ships in a customer
// binary's code path.
//
// Like the real loggers it serves ONE client at a time: a second connection
// while one is open is accepted and closed immediately (the documented
// single-client behaviour that forces every reader through one lane).
package v5sim

import (
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// Sim is a running simulator.
type Sim struct {
	ln     net.Listener
	serial uint32

	mu        sync.Mutex
	regs      map[uint16]uint16
	silent    bool            // swallow requests (no reply) - the no_answer case
	refuse    map[uint16]byte // start register -> Modbus exception code
	busy      bool            // a client is connected
	requests  int             // fn-0x03 requests answered or swallowed
	extraConn int             // connections refused because one was open
}

// Start listens on addr ("127.0.0.1:0" picks a free port).
func Start(addr string, serial uint32) (*Sim, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Sim{ln: ln, serial: serial, regs: map[uint16]uint16{}, refuse: map[uint16]byte{}}
	go s.serve()
	return s, nil
}

// Addr is the listening address.
func (s *Sim) Addr() string { return s.ln.Addr().String() }

// Close stops the simulator.
func (s *Sim) Close() error { return s.ln.Close() }

// Set writes register values (absolute address -> word).
func (s *Sim) Set(values map[uint16]uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for a, v := range values {
		s.regs[a] = v
	}
}

// SetSilent makes the simulator swallow requests without answering.
func (s *Sim) SetSilent(on bool) {
	s.mu.Lock()
	s.silent = on
	s.mu.Unlock()
}

// Refuse answers reads STARTING at start with a Modbus exception.
func (s *Sim) Refuse(start uint16, code byte) {
	s.mu.Lock()
	s.refuse[start] = code
	s.mu.Unlock()
}

// Requests is the number of read requests seen.
func (s *Sim) Requests() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

// RefusedConnections counts connections turned away because one was open.
func (s *Sim) RefusedConnections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.extraConn
}

func (s *Sim) serve() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.busy {
			s.extraConn++
			s.mu.Unlock()
			_ = c.Close()
			continue
		}
		s.busy = true
		s.mu.Unlock()
		go func() {
			defer func() {
				_ = c.Close()
				s.mu.Lock()
				s.busy = false
				s.mu.Unlock()
			}()
			s.handle(c)
		}()
	}
}

func (s *Sim) handle(c net.Conn) {
	acc := make([]byte, 0, 256)
	buf := make([]byte, 512)
	for {
		n, err := c.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
		}
		for {
			need, ok, ferr := solarmanv5.ExpectedFrameLength(acc)
			if ferr != nil {
				return
			}
			if !ok || len(acc) < need {
				break
			}
			frame := acc[:need]
			acc = append([]byte(nil), acc[need:]...)
			reply, rerr := s.answer(frame)
			if rerr != nil {
				slog.Debug("v5sim: request ignored", "err", rerr)
				continue
			}
			if reply != nil {
				if _, werr := c.Write(reply); werr != nil {
					return
				}
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				slog.Debug("v5sim: read", "err", err)
			}
			return
		}
	}
}

// answer builds the response frame for one request frame (nil = stay silent).
func (s *Sim) answer(req []byte) ([]byte, error) {
	if len(req) < 11+15+8+2 {
		return nil, errors.New("request too short")
	}
	seq := binary.LittleEndian.Uint16(req[5:])
	mb := req[11+15 : len(req)-2]
	if len(mb) < 8 || mb[1] != 0x03 {
		return nil, errors.New("only fn 0x03 is simulated")
	}
	slave := mb[0]
	start := binary.BigEndian.Uint16(mb[2:])
	count := binary.BigEndian.Uint16(mb[4:])

	s.mu.Lock()
	s.requests++
	silent := s.silent
	code, refused := s.refuse[start]
	regs := make([]uint16, count)
	for i := range regs {
		regs[i] = s.regs[start+uint16(i)]
	}
	serial := s.serial
	s.mu.Unlock()

	if silent {
		return nil, nil
	}
	var reply []byte
	if refused {
		reply = withCRC([]byte{slave, 0x83, code})
	} else {
		body := make([]byte, 3+2*len(regs))
		body[0] = slave
		body[1] = 0x03
		body[2] = byte(2 * len(regs))
		for i, r := range regs {
			binary.BigEndian.PutUint16(body[3+2*i:], r)
		}
		reply = withCRC(body)
	}
	return ResponseFrame(serial, seq, solarmanv5.FrameTypeSolar, 0x01, reply), nil
}

func withCRC(body []byte) []byte {
	c := solarmanv5.CRC16(body)
	return append(body, byte(c&0xff), byte(c>>8))
}

// ResponseFrame builds a V5 response frame around a Modbus reply.
func ResponseFrame(serial uint32, seq uint16, frameType, status byte, modbus []byte) []byte {
	payload := make([]byte, 14)
	payload[0] = frameType
	payload[1] = status
	binary.LittleEndian.PutUint32(payload[2:], 123456)
	binary.LittleEndian.PutUint32(payload[6:], 7890)
	f := make([]byte, 11, 11+len(payload)+len(modbus)+2)
	f[0] = solarmanv5.Start
	binary.LittleEndian.PutUint16(f[1:], uint16(len(payload)+len(modbus)))
	binary.LittleEndian.PutUint16(f[3:], solarmanv5.ControlResponse)
	binary.LittleEndian.PutUint16(f[5:], seq)
	binary.LittleEndian.PutUint32(f[7:], serial)
	f = append(f, payload...)
	f = append(f, modbus...)
	f = append(f, 0, solarmanv5.End)
	f[len(f)-2] = solarmanv5.Checksum(f)
	return f
}
