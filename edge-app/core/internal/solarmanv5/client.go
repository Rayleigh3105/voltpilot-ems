package solarmanv5

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

// Defaults of the Node-RED reader ("Solarman-V5 lesen" / test-read.js).
const (
	DefaultPort           = 8899
	DefaultConnectTimeout = 8 * time.Second
	DefaultReadTimeout    = 8 * time.Second
	maxFrameBytes         = 4096 // a fn-0x03 reply of 125 regs is ~290 bytes
)

// ErrDial means the logger was not reachable (connect failed) - the
// "unreachable" class of the connection test.
var ErrDial = errors.New("Datenlogger nicht erreichbar")

// ErrNoAnswer means the connection stood but no complete frame arrived in
// time - the "no_answer" class.
var ErrNoAnswer = errors.New("Datenlogger antwortet nicht")

// ReadSpec is one block of a read plan (deyedecode.PlanReads produces them).
type ReadSpec struct {
	Start    uint16
	Count    uint16
	Optional bool
}

// Block is the result of one ReadSpec. An OPTIONAL block that failed carries
// empty Regs and its Err; a mandatory failure aborts the whole read instead.
type Block struct {
	Start uint16
	Regs  []uint16
	Err   error
}

// Session is ONE TCP connection to a Solarman logger. The loggers serve a
// single client, so a session is opened per poll and closed right after - the
// Node-RED reader's "eine Verbindung pro Poll, sequenzielle Bloecke".
//
// A Session is not safe for concurrent use; the caller serializes access to
// one logger (layer1's per-target lane).
type Session struct {
	conn        net.Conn
	serial      uint32
	slave       byte
	seq         uint16
	readTimeout time.Duration
}

// Dialer is the injection point for tests (net.Dialer by default).
type Dialer interface {
	DialContext(ctx context.Context, network, addr string) (net.Conn, error)
}

// Dial opens a session. A failure wraps ErrDial.
func Dial(ctx context.Context, d Dialer, addr string, serial uint32, slave byte, connectTimeout, readTimeout time.Duration) (*Session, error) {
	if d == nil {
		d = &net.Dialer{}
	}
	if connectTimeout <= 0 {
		connectTimeout = DefaultConnectTimeout
	}
	if readTimeout <= 0 {
		readTimeout = DefaultReadTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	c, err := d.DialContext(cctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrDial, err)
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	return &Session{conn: c, serial: serial, slave: slave, readTimeout: readTimeout}, nil
}

// Close ends the session.
func (s *Session) Close() error { return s.conn.Close() }

// SetSequence seeds the V5 sequence counter (the poll carries it across
// sessions like the flow's context.seq).
func (s *Session) SetSequence(seq uint16) { s.seq = seq }

// Sequence is the last sequence number used.
func (s *Session) Sequence() uint16 { return s.seq }

// exchange sends one request frame and returns the complete response frame,
// reassembled across TCP segments by the length field.
func (s *Session) exchange(ctx context.Context, frame []byte) ([]byte, error) {
	deadline := time.Now().Add(s.readTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = s.conn.SetDeadline(deadline)
	if _, err := s.conn.Write(frame); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNoAnswer, err)
	}
	acc := make([]byte, 0, 512)
	buf := make([]byte, 1024)
	for {
		n, ok, err := ExpectedFrameLength(acc)
		if err != nil {
			return nil, err
		}
		if ok {
			if n > maxFrameBytes {
				return nil, protoErr("Solarman-V5-Frame unplausibel lang (%d Byte)", n)
			}
			if len(acc) >= n {
				return acc[:n], nil
			}
		}
		m, rerr := s.conn.Read(buf)
		if m > 0 {
			acc = append(acc, buf[:m]...)
			continue
		}
		if rerr != nil {
			var ne net.Error
			if errors.As(rerr, &ne) && ne.Timeout() {
				return nil, fmt.Errorf("%w: keine vollstaendige Antwort in %s", ErrNoAnswer, s.readTimeout)
			}
			return nil, fmt.Errorf("%w: %v", ErrNoAnswer, rerr)
		}
	}
}

// ReadHolding reads count holding registers starting at start (fn 0x03).
func (s *Session) ReadHolding(ctx context.Context, start, count uint16) ([]uint16, error) {
	if count == 0 || count > MaxReadCount {
		return nil, fmt.Errorf("Leseblock mit %d Registern ausserhalb 1..%d", count, MaxReadCount)
	}
	s.seq++
	seq := s.seq
	resp, err := s.exchange(ctx, BuildReadRequest(s.serial, seq, s.slave, start, count))
	if err != nil {
		return nil, err
	}
	serial := s.serial
	regs, err := ReadRegistersFromResponse(resp, ParseOpts{ExpectSerial: &serial})
	if err != nil {
		return nil, err
	}
	if len(regs) < int(count) {
		return nil, protoErr("Leseantwort mit %d statt %d Registern", len(regs), count)
	}
	return regs[:count], nil
}

// ReadPlan reads every block of plan in order over this one session. A
// mandatory block's failure aborts and is returned; an optional block's
// failure is recorded as an empty Block with its Err (a firmware refusing the
// optional BMS block must never cost the plant every other channel).
func (s *Session) ReadPlan(ctx context.Context, plan []ReadSpec) ([]Block, error) {
	out := make([]Block, 0, len(plan))
	for i, r := range plan {
		regs, err := s.ReadHolding(ctx, r.Start, r.Count)
		if err != nil {
			if !r.Optional {
				return nil, err
			}
			out = append(out, Block{Start: r.Start, Regs: []uint16{}, Err: err})
			// A timeout leaves the session in an unknown state: a late reply
			// would be read as the NEXT block's answer. The remaining OPTIONAL
			// blocks are recorded as missing; a remaining MANDATORY block makes
			// the whole read fail rather than decode a stranger's answer.
			if errors.Is(err, ErrNoAnswer) {
				for _, rest := range plan[i+1:] {
					if !rest.Optional {
						return nil, err
					}
					out = append(out, Block{Start: rest.Start, Regs: []uint16{}, Err: err})
				}
				return out, nil
			}
			continue
		}
		out = append(out, Block{Start: r.Start, Regs: regs})
	}
	return out, nil
}
