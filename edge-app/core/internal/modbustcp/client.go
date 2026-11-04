// Package modbustcp is the box's ONE Modbus TCP client: the MBAP framing and
// the handful of function codes the core's readers and drivers use (FC1/2/3,
// FC5/6/15/16). It was lifted out of internal/ebyte (the M31 I/O module driver)
// when the Go Layer 1 of Edge Light needed FC3 for the Huawei SUN2000 - the
// third Modbus TCP client in the tree would have been one too many
// (internal/mirror is the SERVER side of the box's own data mirror and shares
// nothing with a client).
//
// Deliberately small: no connection pool, no retries, no register semantics.
// One Client is one open TCP session to one unit; every exchange carries its
// own transaction id and deadline, and the caller decides when to close. The
// device disciplines (one client per Solarman logger, one Modbus client at a
// time on a Huawei dongle, the M31's five-client limit) live with the callers:
// layer1's lanes and ebyte's per-target lock.
package modbustcp

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// Modbus function codes.
const (
	FcReadCoils          = 0x01
	FcReadDiscreteInputs = 0x02
	FcReadHolding        = 0x03
	FcWriteSingleCoil    = 0x05
	FcWriteSingleReg     = 0x06
	FcWriteMultipleCoils = 0x0F
	FcWriteMultipleRegs  = 0x10
)

// MaxRegisters is the FC3 ceiling of one request (the protocol's 125).
const MaxRegisters = 125

// ExceptionError is a Modbus exception response (function code | 0x80).
type ExceptionError struct {
	Function byte
	Code     byte
}

func (e *ExceptionError) Error() string {
	return fmt.Sprintf("modbus exception fc=0x%02x code=%d", e.Function, e.Code)
}

// IsException reports whether err is a Modbus exception (any code).
func IsException(err error) bool {
	var ex *ExceptionError
	return errors.As(err, &ex)
}

// IllegalAddress reports exception code 2 (ILLEGAL DATA ADDRESS): the device
// answered, but has no register there. The M31 says it for every I/O address
// beyond its negotiated channels; a Huawei without a Smart Power Sensor may say
// it for the meter block.
func IllegalAddress(err error) bool {
	var ex *ExceptionError
	return errors.As(err, &ex) && ex.Code == 2
}

// Dialer opens the TCP connection (injected in tests).
type Dialer func(ctx context.Context, address string) (net.Conn, error)

// DefaultDialer is net.Dialer.DialContext over "tcp".
func DefaultDialer(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", address)
}

// Client is one open Modbus TCP session to one unit.
type Client struct {
	c       net.Conn
	unit    byte
	tid     uint16
	timeout time.Duration
}

// Dial opens a session to address (host:port) for unit. connectTimeout bounds
// the dial, ioTimeout every later request/response exchange. A nil dial uses
// DefaultDialer.
func Dial(ctx context.Context, dial Dialer, address string, unit byte, connectTimeout, ioTimeout time.Duration) (*Client, error) {
	if dial == nil {
		dial = DefaultDialer
	}
	dctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	nc, err := dial(dctx, address)
	if err != nil {
		return nil, err
	}
	return &Client{c: nc, unit: unit, timeout: ioTimeout}, nil
}

// Close ends the session.
func (c *Client) Close() error { return c.c.Close() }

// Exchange sends one PDU (function code first) and returns the response PDU.
// A Modbus exception comes back as *ExceptionError; a response for a foreign
// transaction, a wrong function code or a malformed length as a plain error.
func (c *Client) Exchange(pdu []byte) ([]byte, error) {
	c.tid++
	adu := make([]byte, 7+len(pdu))
	binary.BigEndian.PutUint16(adu[0:], c.tid)
	binary.BigEndian.PutUint16(adu[2:], 0)
	binary.BigEndian.PutUint16(adu[4:], uint16(len(pdu)+1))
	adu[6] = c.unit
	copy(adu[7:], pdu)
	_ = c.c.SetDeadline(time.Now().Add(c.timeout))
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

func (c *Client) readBits(fc byte, addr, count uint16) ([]bool, error) {
	body, err := c.Exchange([]byte{fc, byte(addr >> 8), byte(addr), byte(count >> 8), byte(count)})
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

// ReadCoils is FC1.
func (c *Client) ReadCoils(addr, count uint16) ([]bool, error) {
	return c.readBits(FcReadCoils, addr, count)
}

// ReadDiscreteInputs is FC2.
func (c *Client) ReadDiscreteInputs(addr, count uint16) ([]bool, error) {
	return c.readBits(FcReadDiscreteInputs, addr, count)
}

// ReadHolding is FC3: count registers from addr, big-endian words.
func (c *Client) ReadHolding(addr, count uint16) ([]uint16, error) {
	body, err := c.Exchange([]byte{FcReadHolding, byte(addr >> 8), byte(addr), byte(count >> 8), byte(count)})
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

// WriteSingleCoil is FC5.
func (c *Client) WriteSingleCoil(addr uint16, on bool) error {
	v := uint16(0x0000)
	if on {
		v = 0xFF00 // the wire form of ON; a coil value is never the number 1
	}
	req := []byte{FcWriteSingleCoil, byte(addr >> 8), byte(addr), byte(v >> 8), byte(v)}
	body, err := c.Exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req) {
		return fmt.Errorf("modbus: coil write echo mismatch")
	}
	return nil
}

// WriteMultipleCoils is FC15.
func (c *Client) WriteMultipleCoils(addr uint16, values []bool) error {
	n := len(values)
	nb := (n + 7) / 8
	req := []byte{FcWriteMultipleCoils, byte(addr >> 8), byte(addr), byte(n >> 8), byte(n), byte(nb)}
	data := make([]byte, nb)
	for i, v := range values {
		if v {
			data[i/8] |= 1 << (uint(i) % 8)
		}
	}
	body, err := c.Exchange(append(req, data...))
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req[:5]) {
		return fmt.Errorf("modbus: multiple-coil write echo mismatch")
	}
	return nil
}

// WriteSingleRegister is FC6.
func (c *Client) WriteSingleRegister(addr, value uint16) error {
	req := []byte{FcWriteSingleReg, byte(addr >> 8), byte(addr), byte(value >> 8), byte(value)}
	body, err := c.Exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req) {
		return fmt.Errorf("modbus: register write echo mismatch")
	}
	return nil
}

// WriteRegisters is FC16.
func (c *Client) WriteRegisters(addr uint16, values []uint16) error {
	n := len(values)
	req := []byte{FcWriteMultipleRegs, byte(addr >> 8), byte(addr), byte(n >> 8), byte(n), byte(2 * n)}
	for _, v := range values {
		req = append(req, byte(v>>8), byte(v))
	}
	body, err := c.Exchange(req)
	if err != nil {
		return err
	}
	if len(body) != 5 || string(body) != string(req[:5]) {
		return fmt.Errorf("modbus: register write echo mismatch")
	}
	return nil
}
