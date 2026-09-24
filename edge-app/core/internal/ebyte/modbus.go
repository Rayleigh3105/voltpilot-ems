package ebyte

// A minimal Modbus TCP client for the M31 I/O host: exactly the function codes
// the module documents (FC1/2/3/5/6/15/16), nothing generic. The CORE owns the
// whole M31 socket (the Shelly discipline) - source poll, connection test and
// executor all run here, and Node-RED never opens a second path to the same
// device. Every exchange for one target runs under that target's lock, so a
// poll and a write can never interleave on the wire.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Modbus function codes used by the M31.
const (
	fcReadCoils          = 0x01
	fcReadDiscreteInputs = 0x02
	fcReadHolding        = 0x03
	fcWriteSingleCoil    = 0x05
	fcWriteSingleReg     = 0x06
	fcWriteMultipleCoils = 0x0F
	fcWriteMultipleRegs  = 0x10
)

// ioTimeout bounds one request/response exchange.
const ioTimeout = 3 * time.Second

// ExceptionError is a Modbus exception response (function code | 0x80).
type ExceptionError struct {
	Function byte
	Code     byte
}

func (e *ExceptionError) Error() string {
	return fmt.Sprintf("modbus exception fc=0x%02x code=%d", e.Function, e.Code)
}

// IllegalAddress reports the exception the M31 answers for every I/O address
// beyond its negotiated channels (and for ALL I/O while negotiation is pending).
func IllegalAddress(err error) bool {
	var ex *ExceptionError
	return errors.As(err, &ex) && ex.Code == 2
}

// Dialer opens the TCP connection (injected in tests).
type Dialer func(ctx context.Context, address string) (net.Conn, error)

func defaultDialer(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", address)
}

// targetLocks serializes every session per host:port (one socket per device).
var targetLocks sync.Map // address -> *sync.Mutex

func lockFor(address string) *sync.Mutex {
	m, _ := targetLocks.LoadOrStore(address, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// conn is one open Modbus TCP session.
type conn struct {
	c    net.Conn
	unit byte
	tid  uint16
}

// withSession dials the target, runs fn under the target lock and closes the
// connection again. The M31 accepts at most five clients; a short session per
// pass keeps a slot free for the operator's own tools.
func withSession(ctx context.Context, dial Dialer, address string, unit byte, fn func(*conn) error) error {
	if dial == nil {
		dial = defaultDialer
	}
	mu := lockFor(address)
	mu.Lock()
	defer mu.Unlock()
	dctx, cancel := context.WithTimeout(ctx, ioTimeout)
	defer cancel()
	nc, err := dial(dctx, address)
	if err != nil {
		return err
	}
	defer nc.Close()
	return fn(&conn{c: nc, unit: unit})
}

// exchange sends one PDU and returns the response PDU (function code first).
func (c *conn) exchange(pdu []byte) ([]byte, error) {
	c.tid++
	adu := make([]byte, 7+len(pdu))
	binary.BigEndian.PutUint16(adu[0:], c.tid)
	binary.BigEndian.PutUint16(adu[2:], 0)
	binary.BigEndian.PutUint16(adu[4:], uint16(len(pdu)+1))
	adu[6] = c.unit
	copy(adu[7:], pdu)
	_ = c.c.SetDeadline(time.Now().Add(ioTimeout))
	if _, err := c.c.Write(adu); err != nil {
		return nil, err
	}
	hdr := make([]byte, 7)
	if _, err := io.ReadFull(c.c, hdr); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint16(hdr[0:]) != c.tid || binary.BigEndian.Uint16(hdr[2:]) != 0 {
		return nil, fmt.Errorf("modbus: foreign transaction in response")
	}
	n := int(binary.BigEndian.Uint16(hdr[4:]))
	if n < 2 || n > 260 {
		return nil, fmt.Errorf("modbus: invalid response length %d", n)
	}
	body := make([]byte, n-1)
	if _, err := io.ReadFull(c.c, body); err != nil {
		return nil, err
	}
	if body[0] == pdu[0]|0x80 {
		if len(body) < 2 {
			return nil, fmt.Errorf("modbus: truncated exception")
		}
		return nil, &ExceptionError{Function: pdu[0], Code: body[1]}
	}
	if body[0] != pdu[0] {
		return nil, fmt.Errorf("modbus: function 0x%02x answered as 0x%02x", pdu[0], body[0])
	}
	return body, nil
}

func (c *conn) readBits(fc byte, addr, count uint16) ([]bool, error) {
	body, err := c.exchange([]byte{fc, byte(addr >> 8), byte(addr), byte(count >> 8), byte(count)})
	if err != nil {
		return nil, err
	}
	want := int(count+7) / 8
	if len(body) < 2 || int(body[1]) != want || len(body) < 2+want {
		return nil, fmt.Errorf("modbus: bit response size mismatch")
	}
	out := make([]bool, count)
	for i := range out {
		out[i] = body[2+i/8]&(1<<(uint(i)%8)) != 0
	}
	return out, nil
}

func (c *conn) readCoils(addr, count uint16) ([]bool, error) {
	return c.readBits(fcReadCoils, addr, count)
}

func (c *conn) readDiscreteInputs(addr, count uint16) ([]bool, error) {
	return c.readBits(fcReadDiscreteInputs, addr, count)
}

func (c *conn) readHolding(addr, count uint16) ([]uint16, error) {
	body, err := c.exchange([]byte{fcReadHolding, byte(addr >> 8), byte(addr), byte(count >> 8), byte(count)})
	if err != nil {
		return nil, err
	}
	if len(body) < 2 || int(body[1]) != int(count)*2 || len(body) < 2+int(count)*2 {
		return nil, fmt.Errorf("modbus: register response size mismatch")
	}
	out := make([]uint16, count)
	for i := range out {
		out[i] = binary.BigEndian.Uint16(body[2+2*i:])
	}
	return out, nil
}

func (c *conn) writeSingleCoil(addr uint16, on bool) error {
	v := uint16(0x0000)
	if on {
		v = 0xFF00 // the wire form of ON; a coil value is never the number 1
	}
	req := []byte{fcWriteSingleCoil, byte(addr >> 8), byte(addr), byte(v >> 8), byte(v)}
	body, err := c.exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req) {
		return fmt.Errorf("modbus: coil write echo mismatch")
	}
	return nil
}

func (c *conn) writeMultipleCoils(addr uint16, values []bool) error {
	n := len(values)
	nb := (n + 7) / 8
	req := []byte{fcWriteMultipleCoils, byte(addr >> 8), byte(addr), byte(n >> 8), byte(n), byte(nb)}
	data := make([]byte, nb)
	for i, v := range values {
		if v {
			data[i/8] |= 1 << (uint(i) % 8)
		}
	}
	body, err := c.exchange(append(req, data...))
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req[:5]) {
		return fmt.Errorf("modbus: multiple-coil write echo mismatch")
	}
	return nil
}

func (c *conn) writeSingleRegister(addr, value uint16) error {
	req := []byte{fcWriteSingleReg, byte(addr >> 8), byte(addr), byte(value >> 8), byte(value)}
	body, err := c.exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req) {
		return fmt.Errorf("modbus: register write echo mismatch")
	}
	return nil
}

func (c *conn) writeRegisters(addr uint16, values []uint16) error {
	n := len(values)
	req := []byte{fcWriteMultipleRegs, byte(addr >> 8), byte(addr), byte(n >> 8), byte(n), byte(2 * n)}
	for _, v := range values {
		req = append(req, byte(v>>8), byte(v))
	}
	body, err := c.exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req[:5]) {
		return fmt.Errorf("modbus: register write echo mismatch")
	}
	return nil
}
