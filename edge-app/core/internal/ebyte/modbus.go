package ebyte

// The M31's Modbus TCP session: the wire layer is the box's shared client
// (internal/modbustcp - FC1/2/3/5/6/15/16, nothing generic); what stays HERE
// is the M31 discipline. The CORE owns the whole M31 socket (the Shelly rule) -
// source poll, connection test and executor all run here, and Node-RED never
// opens a second path to the same device. Every exchange for one target runs
// under that target's lock, so a poll and a write can never interleave on the
// wire.

import (
	"context"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

// ioTimeout bounds the dial and one request/response exchange.
const ioTimeout = 3 * time.Second

// ExceptionError is a Modbus exception response (function code | 0x80).
type ExceptionError = modbustcp.ExceptionError

// IllegalAddress reports the exception the M31 answers for every I/O address
// beyond its negotiated channels (and for ALL I/O while negotiation is pending).
func IllegalAddress(err error) bool { return modbustcp.IllegalAddress(err) }

// Dialer opens the TCP connection (injected in tests).
type Dialer = modbustcp.Dialer

// targetLocks serializes every session per host:port (one socket per device).
var targetLocks sync.Map // address -> *sync.Mutex

func lockFor(address string) *sync.Mutex {
	m, _ := targetLocks.LoadOrStore(address, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// conn is one open Modbus TCP session.
type conn = modbustcp.Client

// withSession dials the target, runs fn under the target lock and closes the
// connection again. The M31 accepts at most five clients; a short session per
// pass keeps a slot free for the operator's own tools.
func withSession(ctx context.Context, dial Dialer, address string, unit byte, fn func(*conn) error) error {
	mu := lockFor(address)
	mu.Lock()
	defer mu.Unlock()
	c, err := modbustcp.Dial(ctx, dial, address, unit, ioTimeout, ioTimeout)
	if err != nil {
		return err
	}
	defer c.Close()
	return fn(c)
}
